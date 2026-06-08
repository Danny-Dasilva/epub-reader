import { Page } from '@playwright/test';
import { audioStates, AudioState } from './harness';

/**
 * Deterministic TTS Web Worker mock.
 *
 * REAL TTS synthesis HANGS in headless Chromium (the ONNX sessions never produce
 * a src — duration stays -1 forever). To get deterministic audio we replace
 * `window.Worker` with a fake worker that speaks the exact protocol the
 * TTSWorkerManager expects (see src/lib/tts/TTSWorkerManager.ts handleWorkerMessage
 * + src/lib/tts/tts.worker.ts message handler):
 *
 *  in  → out
 *  ----------------------------------------------------------------
 *  init                → loading* , ready{backend:'wasm'}
 *  synthesize{id,text} → complete{id, wav, wavBuffer, duration, sampleRate, wordTimestamps}
 *  predictDuration{id} → duration{id, duration, wordTimestamps}
 *  cancel{id}          → cancelled{id}
 *  cancelAll           → (nothing; manager rejects locally)
 *  setVoice            → (nothing)
 *  synthesizeStreaming → chunk{...isLast:true} (not used on cached path, but handled)
 *
 * Each synthesized WAV is `durationSec` of mono 16-bit 44100Hz silence with a
 * proper RIFF header, so a real HTMLAudioElement gets a blob src whose
 * `duration` is exactly `durationSec` and `currentTime` advances in real time.
 *
 * `synthDelayMs` adds an artificial per-synthesize latency so that, during
 * playback, sentences AHEAD of the playhead sit in 'queued'/'preloading' state
 * (orange) — needed to prove the look-ahead/preload visual (Issue #1).
 */
export interface TTSMockOptions {
  /** Audio duration per sentence, seconds. Keep short for fast tests. */
  durationSec?: number;
  /** Artificial delay before replying to a synthesize, ms. */
  synthDelayMs?: number;
}

export async function installTTSMock(page: Page, opts: TTSMockOptions = {}): Promise<void> {
  const durationSec = opts.durationSec ?? 0.5;
  const synthDelayMs = opts.synthDelayMs ?? 0;

  await page.addInitScript(
    ({ durationSec, synthDelayMs }) => {
      const SAMPLE_RATE = 44100;

      // Build a mono 16-bit PCM WAV ArrayBuffer of `seconds` of silence.
      function makeWav(seconds: number): ArrayBuffer {
        const numChannels = 1;
        const bitsPerSample = 16;
        const numSamples = Math.max(1, Math.floor(seconds * SAMPLE_RATE));
        const dataSize = numSamples * numChannels * (bitsPerSample / 8);
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);
        const byteRate = (SAMPLE_RATE * numChannels * bitsPerSample) / 8;
        const blockAlign = (numChannels * bitsPerSample) / 8;
        const writeString = (off: number, s: string) => {
          for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
        };
        writeString(0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, numChannels, true);
        view.setUint32(24, SAMPLE_RATE, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);
        writeString(36, 'data');
        view.setUint32(40, dataSize, true);
        // Samples already zero (silence).
        return buffer;
      }

      // Evenly spaced word timestamps across the synthetic duration.
      function makeWordTimestamps(text: string, total: number) {
        const words = (text || '').split(/\s+/).filter((w) => w.length > 0);
        if (words.length === 0) return [];
        const per = total / words.length;
        return words.map((w, i) => ({
          text: w,
          start: i * per,
          end: (i + 1) * per,
        }));
      }

      const NumSamples = Math.max(1, Math.floor(durationSec * SAMPLE_RATE));

      class FakeTTSWorker extends EventTarget {
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: ((ev: any) => void) | null = null;
        onmessageerror: ((ev: any) => void) | null = null;

        private emit(data: any) {
          const ev = new MessageEvent('message', { data });
          if (this.onmessage) {
            try {
              this.onmessage(ev);
            } catch (e) {
              /* ignore */
            }
          }
          this.dispatchEvent(ev);
        }

        postMessage(message: any) {
          if (!message || typeof message !== 'object') return;
          switch (message.type) {
            case 'init': {
              // Mark ready asynchronously so the manager's readyPromise resolves
              // and the Play button enables.
              setTimeout(() => {
                this.emit({ type: 'loading', modelName: 'Mock', current: 5, total: 5 });
                this.emit({ type: 'ready', backend: 'wasm' });
              }, 0);
              break;
            }
            case 'synthesize': {
              const id = message.id;
              const text = message.text ?? '';
              const reply = () => {
                const wav = new Float32Array(NumSamples); // silence
                const wavBuffer = makeWav(durationSec);
                this.emit({
                  type: 'complete',
                  id,
                  wav,
                  wavBuffer,
                  duration: durationSec,
                  sampleRate: SAMPLE_RATE,
                  wordTimestamps: makeWordTimestamps(text, durationSec),
                });
              };
              if (synthDelayMs > 0) setTimeout(reply, synthDelayMs);
              else setTimeout(reply, 0);
              break;
            }
            case 'synthesizeStreaming': {
              // Cached path does not use this, but support it for completeness:
              // emit a single final chunk.
              const id = message.id;
              const reply = () => {
                const wav = new Float32Array(NumSamples);
                this.emit({
                  type: 'chunk',
                  id,
                  audio: wav,
                  chunkIndex: 0,
                  isLast: true,
                });
              };
              if (synthDelayMs > 0) setTimeout(reply, synthDelayMs);
              else setTimeout(reply, 0);
              break;
            }
            case 'predictDuration': {
              const id = message.id;
              const text = message.text ?? '';
              setTimeout(() => {
                this.emit({
                  type: 'duration',
                  id,
                  duration: durationSec,
                  wordTimestamps: makeWordTimestamps(text, durationSec),
                });
              }, 0);
              break;
            }
            case 'cancel': {
              const id = message.id;
              setTimeout(() => this.emit({ type: 'cancelled', id }), 0);
              break;
            }
            case 'cancelAll':
            case 'setVoice':
            case 'setSpeed':
            default:
              // No reply needed; manager handles these locally.
              break;
          }
        }

        terminate() {
          /* no-op */
        }
        addEventListener(type: string, listener: any, opts?: any) {
          super.addEventListener(type, listener, opts);
        }
        removeEventListener(type: string, listener: any, opts?: any) {
          super.removeEventListener(type, listener, opts);
        }
      }

      const OrigWorker = window.Worker;
      // @ts-ignore test shim — replacing the Worker constructor with a fake
      window.Worker = function (scriptURL: string | URL, options?: WorkerOptions) {
        const url = String(scriptURL);
        // In the Next dev build the TTS worker is bundled and instantiated via a
        // blob: URL with no `type`, so we can't match on 'tts' in the URL. On the
        // MAIN THREAD the only Worker this app ever constructs is the TTS worker
        // (onnxruntime's internal proxy workers are spawned inside that worker,
        // which we replace — so they never reach the main thread). Therefore we
        // intercept ALL main-thread workers.
        // eslint-disable-next-line no-console
        console.log('[ttsMock] intercepted Worker url=', url, 'type=', options?.type);
        return new FakeTTSWorker() as unknown as Worker;
      } as any;
      (window.Worker as any).prototype = (OrigWorker as any).prototype;
    },
    { durationSec, synthDelayMs },
  );
}

/**
 * Poll until any captured audio element is in the near-end hand-off window
 * (dur > 0 && dur - ct < threshold). Returns the matching state, or null on
 * timeout. This is where the dual-player RAF hand-off (startNextPlayer) arms —
 * the window the Issue #3 pause bug lived in.
 *
 * Do NOT rely on word `.speaking` classes (timings may be absent on this path).
 */
export async function waitForAudioNearEnd(
  page: Page,
  threshold = 0.2,
  timeout = 20_000,
): Promise<AudioState | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const states = await audioStates(page);
    // Require a "substantial" element (dur > 0.25s) that has actually progressed
    // (ct > 0.05) to avoid matching the dual-player's transient short/idle blob.
    const hit = states.find(
      (s) => !s.paused && !s.ended && s.dur > 0.25 && s.ct > 0.05 && s.dur - s.ct < threshold,
    );
    if (hit) return hit;
    await page.waitForTimeout(30);
  }
  return null;
}

/** Wait until at least one captured audio element is actively playing with a real duration. */
export async function waitForAudioPlaying(page: Page, timeout = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const states = await audioStates(page);
    if (states.some((s) => !s.paused && !s.ended && s.dur > 0)) return true;
    await page.waitForTimeout(40);
  }
  return false;
}
