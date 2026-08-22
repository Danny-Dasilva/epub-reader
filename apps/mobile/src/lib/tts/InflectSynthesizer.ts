import { Directory, File, Paths } from 'expo-file-system';
import type * as Ort from 'onnxruntime-react-native';

import type { SynthesizedAudio, WordTiming } from '@/types/reader';
import {
  applyEdgeFade,
  boundaryPauseSeconds,
  phonemesToTokenIds,
  phonemizeInflectText,
  splitInflectText,
  type InflectSymbolInventory,
} from './inflectFrontend';
import { ensureSkyModel, type ModelDownloadProgress } from './modelManager';

interface InflectConfig {
  data: { add_blank: boolean; hop_length: number; sampling_rate: number };
  deployment_frontend?: { language?: string };
}

const NOISE_SCALE = 0.667;
const SAMPLE_RATE = 24_000;
const WORD = /\S+/gu;
const SHORT_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'of', 'to', 'in', 'on',
  'at', 'by', 'or', 'and', 'but', 'if', 'as', 'for', 'he', 'she', 'it', 'we',
]);

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function seededRandom(seed: number): () => number {
  let state = seed || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function gaussianNoise(length: number, seed: number): Float32Array {
  const random = seededRandom(seed);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 2) {
    const first = Math.max(Number.EPSILON, random());
    const second = random();
    const magnitude = Math.sqrt(-2 * Math.log(first));
    output[index] = magnitude * Math.cos(2 * Math.PI * second);
    if (index + 1 < length) output[index + 1] = magnitude * Math.sin(2 * Math.PI * second);
  }
  return output;
}

function concatenate(parts: Float32Array[]): Float32Array {
  const output = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function float32ToWav(audio: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + audio.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + audio.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, audio.length * 2, true);

  const pcm = new Int16Array(buffer, 44);
  for (let index = 0; index < audio.length; index++) {
    pcm[index] = Math.round(Math.max(-1, Math.min(1, audio[index])) * 32767);
  }
  return new Uint8Array(buffer);
}

function wordTimings(text: string, duration: number): WordTiming[] {
  const words = [...text.matchAll(WORD)].map((match) => match[0]);
  if (words.length === 0) return [];
  const weights = words.map((word) => {
    const clean = word.replace(/[^a-z]/giu, '').toLowerCase();
    const syllables = Math.max(clean.match(/[aeiouy]+/giu)?.length ?? 0, 1);
    const base = syllables + clean.replace(/[aeiouy]/giu, '').length * 0.3;
    const pause = /[.!?]$/u.test(word) ? 0.2 : /[,;:]$/u.test(word) ? 0.1 : 0;
    return (SHORT_WORDS.has(clean) ? base * 0.7 : base) + pause;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;
  return words.map((word, index) => {
    const wordDuration = duration * weights[index] / total;
    const timing = { word, start: cursor, end: cursor + wordDuration };
    cursor += wordDuration;
    return timing;
  });
}

function cachedOutput(text: string, speed: number): File {
  const cacheDirectory = new Directory(Paths.cache, 'narrator-audio');
  cacheDirectory.create({ idempotent: true, intermediates: true });
  return new File(cacheDirectory, `${hashText(`${text}:${speed}:sky-v3`)}.wav`);
}

export function cachedWavDuration(fileSize: number, sampleRate = SAMPLE_RATE): number | null {
  const pcmBytes = fileSize - 44;
  if (pcmBytes <= 0 || pcmBytes % 2 !== 0) return null;
  return pcmBytes / 2 / sampleRate;
}

export interface SpeechSynthesizer {
  synthesize(text: string, speed: number): Promise<SynthesizedAudio>;
  release(): void;
}

export class InflectSynthesizer implements SpeechSynthesizer {
  private ort: typeof Ort | null = null;
  private durationSession: Ort.InferenceSession | null = null;
  private decodeSession: Ort.InferenceSession | null = null;
  private config: InflectConfig | null = null;
  private inventory: InflectSymbolInventory | null = null;
  private loading: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly onModelProgress?: (progress: ModelDownloadProgress) => void) {}

  private async initialize(): Promise<void> {
    if (this.durationSession && this.decodeSession) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const [ort, files] = await Promise.all([
        import('onnxruntime-react-native'),
        ensureSkyModel(this.onModelProgress),
      ]);
      const [config, inventory] = await Promise.all([
        files.config.text().then((value) => JSON.parse(value) as InflectConfig),
        files.symbols.text().then((value) => JSON.parse(value) as InflectSymbolInventory),
      ]);
      if (inventory.count !== inventory.symbols.length) throw new Error('Sky v3 symbols are invalid');
      const options: Ort.InferenceSession.SessionOptions = { graphOptimizationLevel: 'all' };
      const [durationSession, decodeSession] = await Promise.all([
        ort.InferenceSession.create(files.duration.uri, options),
        ort.InferenceSession.create(files.decode.uri, options),
      ]);
      this.ort = ort;
      this.config = config;
      this.inventory = inventory;
      this.durationSession = durationSession;
      this.decodeSession = decodeSession;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async synthesize(text: string, speed: number): Promise<SynthesizedAudio> {
    const task = this.queue.then(() => this.synthesizeExclusive(text, speed));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async synthesizeExclusive(text: string, speed: number): Promise<SynthesizedAudio> {
    const output = cachedOutput(text, speed);
    const cachedDuration = output.exists ? cachedWavDuration(output.size) : null;
    if (cachedDuration) {
      return {
        uri: output.uri,
        duration: cachedDuration,
        wordTimings: wordTimings(text, cachedDuration),
      };
    }

    await this.initialize();
    const config = this.config;
    if (!config) throw new Error('Sky v3 configuration failed to load');

    const chunks = splitInflectText(text);
    const parts: Float32Array[] = [];
    for (let index = 0; index < chunks.length; index++) {
      if (index > 0) {
        parts.push(new Float32Array(
          Math.round(config.data.sampling_rate * boundaryPauseSeconds(chunks[index - 1])),
        ));
      }
      parts.push(await this.inferChunk(chunks[index], speed, index));
    }
    const waveform = concatenate(parts);
    const duration = waveform.length / config.data.sampling_rate;
    if (output.exists) output.delete();
    output.create({ intermediates: true, overwrite: true });
    output.write(float32ToWav(waveform, config.data.sampling_rate));
    return { uri: output.uri, duration, wordTimings: wordTimings(text, duration) };
  }

  private async inferChunk(text: string, speed: number, seed: number): Promise<Float32Array> {
    const ort = this.ort;
    const config = this.config;
    const inventory = this.inventory;
    const durationSession = this.durationSession;
    const decodeSession = this.decodeSession;
    if (!ort || !config || !inventory || !durationSession || !decodeSession) {
      throw new Error('Sky v3 is not initialized');
    }

    const ipa = phonemizeInflectText(text, config.deployment_frontend?.language ?? 'en-US');
    const tokenData = phonemesToTokenIds(ipa, inventory, config.data.add_blank);
    const tokens = new ort.Tensor('int64', tokenData, [1, tokenData.length]);
    const lengths = new ort.Tensor('int64', BigInt64Array.of(BigInt(tokenData.length)), [1]);
    const lengthScale = new ort.Tensor(
      'float32',
      Float32Array.of(1 / Math.max(0.5, Math.min(2, speed))),
      [],
    );
    const durationOutputs = await durationSession.run({ tokens, lengths, length_scale: lengthScale });
    const noiseShape = durationOutputs.m_p_exp.dims;
    const noiseLength = noiseShape.reduce((product, value) => product * value, 1);
    const noise = new ort.Tensor('float32', gaussianNoise(noiseLength, seed), noiseShape);
    const noiseScale = new ort.Tensor('float32', Float32Array.of(NOISE_SCALE), []);

    try {
      const decoded = await decodeSession.run({
        m_p_exp: durationOutputs.m_p_exp,
        logs_p_exp: durationOutputs.logs_p_exp,
        y_mask: durationOutputs.y_mask,
        zp_noise: noise,
        noise_scale: noiseScale,
      });
      try {
        const waveform = new Float32Array(decoded.waveform.data as Float32Array);
        applyEdgeFade(waveform, config.data.sampling_rate);
        return waveform;
      } finally {
        Object.values(decoded).forEach((value) => value.dispose?.());
      }
    } finally {
      [tokens, lengths, lengthScale, noise, noiseScale].forEach((value) => value.dispose?.());
      Object.values(durationOutputs).forEach((value) => value.dispose?.());
    }
  }

  release(): void {
    this.durationSession?.release();
    this.decodeSession?.release();
    this.durationSession = null;
    this.decodeSession = null;
  }
}
