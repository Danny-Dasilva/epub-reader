import { Page, expect, Locator } from '@playwright/test';
import { join } from 'path';

export const FIXTURES = join(process.cwd(), 'e2e', 'fixtures');
export const SAMPLE_EPUB = join(FIXTURES, 'sample.epub');
export const SAMPLE_IMAGE_EPUB = join(FIXTURES, 'sample-image.epub');

/**
 * Force the app down the cached HTMLAudioElement playback path (the one the
 * user actually hits, where AudioWorklet is unsupported). The app's support
 * probe is `new AudioContext().audioWorklet !== undefined`
 * (src/lib/audio/StreamingAudioWorklet.ts), and it caches the result on first
 * call — so this must run BEFORE app code via addInitScript.
 *
 * Call this on the Page (or context) before the first navigation.
 */
export async function forceCachedAudioPath(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const kill = (Ctor: any) => {
      if (!Ctor) return;
      try {
        Object.defineProperty(Ctor.prototype, 'audioWorklet', {
          configurable: true,
          get() {
            return undefined;
          },
        });
      } catch {
        /* ignore */
      }
    };
    kill((window as any).AudioContext);
    kill((window as any).webkitAudioContext);
  });
}

/**
 * Capture every HTMLMediaElement the app creates (they're `new Audio()`, not in
 * the DOM, so otherwise unobservable). Test-only instrumentation via
 * addInitScript — no app change. Read back with `audioStates(page)`.
 * Must run BEFORE the first navigation.
 */
export async function instrumentAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const els: HTMLMediaElement[] = [];
    (window as any).__els = els;
    const track = (el: HTMLMediaElement) => {
      if (!els.includes(el)) els.push(el);
    };
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement, ...args: any[]) {
      track(this);
      return origPlay.apply(this, args as []);
    };
    const OrigAudio = window.Audio;
    if (OrigAudio) {
      // @ts-expect-error test shim
      window.Audio = function (...a: any[]) {
        const el = new (OrigAudio as any)(...a);
        track(el);
        return el;
      };
    }
  });
}

export interface AudioState {
  paused: boolean;
  ct: number;
  dur: number;
  ended: boolean;
}

/** Snapshot of every captured media element's playback state. */
export async function audioStates(page: Page): Promise<AudioState[]> {
  return page.evaluate(() => {
    const els: HTMLMediaElement[] = (window as any).__els || [];
    return els.map((a) => ({
      paused: a.paused,
      ct: Number(a.currentTime.toFixed(3)),
      dur: isFinite(a.duration) ? Number(a.duration.toFixed(3)) : -1,
      ended: a.ended,
    }));
  });
}

/** True if any captured media element is actively playing (not paused/ended). */
export async function anyAudioPlaying(page: Page): Promise<boolean> {
  return (await audioStates(page)).some((a) => !a.paused && !a.ended);
}

/**
 * Upload an EPUB from the library page and wait for the reader to render.
 * Returns the bookId parsed from the resulting /reader/<id> URL.
 */
export async function openBook(page: Page, epubPath: string = SAMPLE_EPUB): Promise<string> {
  await page.goto('/');
  const fileInput = page.locator('input[type="file"]');
  await fileInput.waitFor({ state: 'attached', timeout: 15_000 });
  await fileInput.setInputFiles(epubPath);
  await page.waitForURL(/\/reader\//, { timeout: 30_000 });
  // First sentence rendered = chapter content is in the DOM.
  await page.locator('.sentence').first().waitFor({ state: 'visible', timeout: 20_000 });
  const url = page.url();
  return url.split('/reader/')[1]?.split('?')[0] ?? '';
}

/** The play/pause primary control. Title flips between "Play" and "Pause". */
export function playPauseButton(page: Page): Locator {
  return page.locator('button.playback-btn.primary').first();
}

/**
 * Wait until the TTS service is ready (the play button becomes enabled).
 * Real TTS initializes via WASM in headless Chromium, which can take a while.
 */
export async function waitForPlayable(page: Page, timeout = 60_000): Promise<void> {
  await expect(playPauseButton(page)).toBeEnabled({ timeout });
}

export async function isPlaying(page: Page): Promise<boolean> {
  const title = await playPauseButton(page).getAttribute('title');
  return title === 'Pause';
}

export async function clickPlay(page: Page): Promise<void> {
  const btn = playPauseButton(page);
  await expect(btn).toBeEnabled();
  if ((await btn.getAttribute('title')) === 'Play') await btn.click();
}

export async function clickPause(page: Page): Promise<void> {
  const btn = playPauseButton(page);
  if ((await btn.getAttribute('title')) === 'Pause') await btn.click();
}

/** Index of the sentence currently marked playing (`.sentence-playing`), or -1. */
export async function playingSentenceIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector('.sentence-playing') as HTMLElement | null;
    if (!el?.id) return -1;
    const m = el.id.match(/sentence-(\d+)/);
    return m ? parseInt(m[1], 10) : -1;
  });
}

/** Index of the currently highlighted/active sentence (`.sentence.active`), or -1. */
export async function activeSentenceIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector('.sentence.active') as HTMLElement | null;
    if (!el?.id) return -1;
    const m = el.id.match(/sentence-(\d+)/);
    return m ? parseInt(m[1], 10) : -1;
  });
}

/**
 * Wait until playback reaches the "near end" of the current sentence — the
 * window (~last word) where the dual-player RAF hand-off (startNextPlayer)
 * arms. This is where the pause force-resume bug manifested. We detect it via
 * the last word of the playing sentence gaining `.speaking`/`.spoken`.
 * Returns the sentence index we are near the end of, or -1 on timeout.
 */
export async function waitForSentenceNearEnd(page: Page, timeout = 30_000): Promise<number> {
  try {
    await page.waitForFunction(
      () => {
        const s = document.querySelector('.sentence-playing') as HTMLElement | null;
        if (!s) return false;
        const words = s.querySelectorAll('.word');
        if (words.length === 0) return true; // no word spans → treat as ready
        const last = words[words.length - 1];
        return last.classList.contains('speaking') || last.classList.contains('spoken');
      },
      { timeout, polling: 50 },
    );
  } catch {
    return -1;
  }
  return playingSentenceIndex(page);
}

/** Number of sentence spans rendered in the current chapter view. */
export async function sentenceCount(page: Page): Promise<number> {
  return page.locator('.sentence').count();
}
