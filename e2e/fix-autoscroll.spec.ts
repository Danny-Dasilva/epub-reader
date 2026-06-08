import { test, expect } from '@playwright/test';
import {
  forceCachedAudioPath,
  instrumentAudio,
  openBook,
  waitForPlayable,
  clickPlay,
  activeSentenceIndex,
  sentenceCount,
} from './helpers/harness';
import { installTTSMock, waitForAudioPlaying } from './helpers/ttsMock';

/**
 * Issue #2 — Auto-scroll keeps the playing sentence in view (roughly centered)
 * and follows as sentences advance; a manual scroll-away re-engages on a later
 * advance (useAutoScroll.ts: scrollIntoView block:'center', userScrolled reset).
 *
 * Virtuoso uses WINDOW scroll, so we measure via the active element's
 * boundingBox vs the viewport. Deterministic ~0.5s sentences via the TTS mock.
 */
// 1.0s audio + a 200ms synth delay makes sentences advance cleanly one-by-one
// (without a delay the mock completes preloads instantly and short pre-metadata
// blobs cause a rapid multi-sentence advance cascade).
const SENT_SEC = 1.0;
const SYNTH_DELAY_MS = 200;

/** Vertical center of the active sentence, as a fraction of viewport height, or null. */
async function activeCenterFraction(page: import('@playwright/test').Page): Promise<number | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.sentence.active') as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    if (r.height === 0) return null;
    return (r.top + r.height / 2) / vh;
  });
}

/** True if the active sentence's box is at least partially within the viewport. */
async function activeInViewport(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('.sentence.active') as HTMLElement | null;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    return r.bottom > 0 && r.top < vh;
  });
}

test.describe('auto-scroll follows playback (Issue #2)', () => {
  test.beforeEach(async ({ page }) => {
    await forceCachedAudioPath(page);
    await instrumentAudio(page);
    await installTTSMock(page, { durationSec: SENT_SEC, synthDelayMs: SYNTH_DELAY_MS });
  });

  test('playing sentence stays in view, roughly centered, as it advances', async ({ page }) => {
    await openBook(page);
    await waitForPlayable(page);

    const total = await sentenceCount(page);
    test.skip(total < 6, `chapter too short to test scrolling (${total} sentences)`);

    await clickPlay(page);
    expect(await waitForAudioPlaying(page, 20_000), 'audio should start').toBe(true);

    // Let several sentences advance, sampling the active sentence position.
    // 1.2s sentences give time to catch each advance and let smooth-scroll settle.
    const samples: Array<{ idx: number; inView: boolean; center: number | null }> = [];
    let lastIdx = -1;
    const deadline = Date.now() + 30_000;
    while (samples.length < 5 && Date.now() < deadline) {
      const idx = await activeSentenceIndex(page);
      if (idx >= 0 && idx !== lastIdx) {
        // Sample just after the smooth-scroll settles for this new sentence.
        await page.waitForTimeout(500);
        samples.push({
          idx,
          inView: await activeInViewport(page),
          center: await activeCenterFraction(page),
        });
        lastIdx = idx;
      }
      await page.waitForTimeout(80);
    }

    expect(samples.length, `should observe several advancing sentences: ${JSON.stringify(samples)}`)
      .toBeGreaterThanOrEqual(4);

    // The view must follow: every sampled active sentence is at least partially
    // visible.
    for (const s of samples) {
      expect(s.inView, `sentence ${s.idx} must be in viewport (samples=${JSON.stringify(samples)})`)
        .toBe(true);
    }

    // And most should sit roughly centered (within 40% of viewport center, i.e.
    // center fraction in [0.1, 0.9]). Allow one outlier for smooth-scroll lag.
    const centered = samples.filter(
      (s) => s.center !== null && s.center >= 0.1 && s.center <= 0.9,
    );
    expect(
      centered.length,
      `most sentences should be roughly centered (samples=${JSON.stringify(samples)})`,
    ).toBeGreaterThanOrEqual(samples.length - 1);
  });

  test('manual scroll-away re-engages: view re-centers on later advances', async ({ page }) => {
    await openBook(page);
    await waitForPlayable(page);

    const total = await sentenceCount(page);
    test.skip(total < 8, `chapter too short to test scroll re-engage (${total} sentences)`);

    await clickPlay(page);
    expect(await waitForAudioPlaying(page, 20_000), 'audio should start').toBe(true);

    // Wait until following has clearly engaged (a sentence is centered).
    await expect
      .poll(() => activeInViewport(page), { timeout: 10_000 })
      .toBe(true);

    // User scrolls far away from the playhead.
    await page.evaluate(() => window.scrollBy(0, -window.innerHeight * 3));
    await page.waitForTimeout(100);

    // After a couple more sentence advances, auto-scroll should re-engage and
    // bring the active sentence back into view (userScrolled is reset on advance).
    const reengaged = await (async () => {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        // give a scroll a chance to settle
        if (await activeInViewport(page)) {
          await page.waitForTimeout(300);
          if (await activeInViewport(page)) return true;
        }
        await page.waitForTimeout(150);
      }
      return false;
    })();

    expect(reengaged, 'auto-scroll should re-center the active sentence after manual scroll-away')
      .toBe(true);
  });
});
