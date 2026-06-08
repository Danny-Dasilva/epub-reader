import { test, expect } from '@playwright/test';
import {
  forceCachedAudioPath,
  instrumentAudio,
  openBook,
  waitForPlayable,
  clickPlay,
  clickPause,
  isPlaying,
  anyAudioPlaying,
  activeSentenceIndex,
} from './helpers/harness';
import { installTTSMock, waitForAudioPlaying, waitForAudioNearEnd } from './helpers/ttsMock';

/**
 * Issue #3 — Pause must stay paused (no force-resume).
 *
 * Root cause: the near-end RAF hand-off (AudioPlayer.startNextPlayer) called
 * play() + emitted sentenceStart without a pause guard, which advanced the
 * sentence index and re-ran the play-effect into its resume branch — so pausing
 * in the ~last-word window silently resumed/advanced. The fix guards
 * startNextPlayer on session.isPaused/isPlaying (AudioPlayer.ts:325) and pauses
 * BOTH dual-players in pause() (AudioPlayer.ts:385-386).
 *
 * We force the cached HTMLAudioElement path (AudioWorklet disabled) — exactly
 * the path the user hits — and drive deterministic audio via the mocked TTS
 * worker (real synthesis hangs in headless Chromium). 1.5s sentences give a
 * comfortable mid-sentence and near-end pause window.
 */
const SENT_SEC = 1.5;

test.describe('pause stays paused (Issue #3)', () => {
  test.beforeEach(async ({ page }) => {
    await forceCachedAudioPath(page);
    await instrumentAudio(page);
    await installTTSMock(page, { durationSec: SENT_SEC });
  });

  test('pausing mid-sentence keeps it paused (no autoplay, no advance)', async ({ page }) => {
    await openBook(page);
    await waitForPlayable(page);

    await clickPlay(page);
    expect(await waitForAudioPlaying(page, 20_000), 'audio should start').toBe(true);

    // Pause mid-sentence (well before the near-end hand-off window).
    await clickPause(page);

    // Pause must take effect: no audio element playing.
    await expect
      .poll(() => anyAudioPlaying(page), { timeout: 5_000 })
      .toBe(false);
    expect(await isPlaying(page), 'button must read paused').toBe(false);

    // Snapshot the active sentence once paused, then ensure it does NOT keep
    // advancing while paused (the bug auto-advanced + resumed).
    const idxWhenPaused = await activeSentenceIndex(page);
    await page.waitForTimeout(1500);

    expect(await isPlaying(page), 'must remain paused').toBe(false);
    expect(await anyAudioPlaying(page), 'no audio may resume while paused').toBe(false);

    const after = await activeSentenceIndex(page);
    expect(
      after === idxWhenPaused,
      `sentence must not advance while paused (was ${idxWhenPaused}, now ${after})`,
    ).toBe(true);
  });

  test('pausing in the near-end hand-off window keeps it paused (the race)', async ({ page }) => {
    await openBook(page);
    await waitForPlayable(page);

    // Loop to beat the timing race: the bug only fired if pause landed while the
    // near-end RAF hand-off (startNextPlayer) was arming.
    for (let attempt = 0; attempt < 6; attempt++) {
      await clickPlay(page);
      expect(await waitForAudioPlaying(page, 20_000), `attempt ${attempt}: audio started`).toBe(true);

      // Wait until the playing element is in the last <0.2s (near-end window).
      const near = await waitForAudioNearEnd(page, 0.2, 20_000);
      expect(near, `attempt ${attempt}: reached near-end window`).not.toBeNull();

      const idxAtPause = await activeSentenceIndex(page);
      await clickPause(page);

      // Let the hand-off RAF + any resume effect run.
      await page.waitForTimeout(1200);

      expect(await isPlaying(page), `attempt ${attempt}: must stay paused`).toBe(false);
      expect(
        await anyAudioPlaying(page),
        `attempt ${attempt}: no audio may resume after pause`,
      ).toBe(false);

      const after = await activeSentenceIndex(page);
      // Must not have run away. A hand-off that already swapped just before our
      // pause could legitimately leave us one ahead, but the BUG advanced AND
      // kept playing (guarded above). Tolerate +1, forbid runaway.
      expect(
        after === -1 || after <= idxAtPause + 1,
        `attempt ${attempt}: must not run away (paused at ${idxAtPause}, now ${after})`,
      ).toBe(true);

      // Resume for next iteration (and prove resume still works).
      await clickPlay(page);
      expect(
        await waitForAudioPlaying(page, 15_000),
        `attempt ${attempt}: resume must restart audio`,
      ).toBe(true);
    }
  });

  test('resume after pause works (over-correction guard)', async ({ page }) => {
    await openBook(page);
    await waitForPlayable(page);

    await clickPlay(page);
    expect(await waitForAudioPlaying(page, 20_000), 'audio should start').toBe(true);

    await clickPause(page);
    await page.waitForTimeout(800);
    expect(await isPlaying(page)).toBe(false);
    expect(await anyAudioPlaying(page)).toBe(false);

    // Resume must actually resume.
    await clickPlay(page);
    expect(await isPlaying(page)).toBe(true);
    expect(await waitForAudioPlaying(page, 15_000), 'audio resumes after pause').toBe(true);

    // And it must keep advancing afterwards (playback genuinely continues).
    const idx0 = await activeSentenceIndex(page);
    await expect
      .poll(() => activeSentenceIndex(page), { timeout: 15_000 })
      .toBeGreaterThan(idx0);
  });
});
