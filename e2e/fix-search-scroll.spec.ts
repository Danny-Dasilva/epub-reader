import { test, expect, Page } from '@playwright/test';
import { openBook } from './helpers/harness';

/**
 * Fix #4: clicking a search result must SCROLL the reader to the matched
 * sentence (it previously started playback but never scrolled).
 *
 * We do NOT need audio. `skipToSentence` kicks off playback (which hangs in
 * headless), but the scroll is driven by the rAF `scrollTo` (scrollIntoView
 * with block:'center') regardless — so the scroll is observable on its own.
 */

const SEARCH_OPEN = 'button[title="Search in book"]';
const SEARCH_INPUT = '.search-input';
const SEARCH_RESULT = 'button.search-result';

// How far the target's vertical center may be from the viewport center,
// expressed as a fraction of viewport height. scrollIntoView({block:'center'})
// centers the element, but smooth-scroll + virtualization leave some slack.
const CENTER_TOLERANCE = 0.4;

async function openSearch(page: Page) {
  await page.locator(SEARCH_OPEN).click();
  await expect(page.locator(SEARCH_INPUT)).toBeVisible();
}

async function search(page: Page, term: string) {
  await openSearch(page);
  await page.locator(SEARCH_INPUT).fill(term);
  await page.locator(SEARCH_RESULT).first().waitFor({ state: 'visible', timeout: 10_000 });
}

/** Vertical center of an element relative to the viewport, or null if not box-able. */
async function elementCenterY(page: Page, id: string): Promise<number | null> {
  const box = await page.locator(`#${id}`).boundingBox();
  if (!box) return null;
  return box.y + box.height / 2;
}

async function assertCentered(page: Page, idx: number) {
  const vh = page.viewportSize()!.height;
  const id = `sentence-${idx}`;
  await expect(page.locator(`#${id}`)).toBeVisible();
  // Wait for smooth scroll to settle near center.
  await expect
    .poll(
      async () => {
        const cy = await elementCenterY(page, id);
        if (cy === null) return Number.POSITIVE_INFINITY;
        return Math.abs(cy - vh / 2) / vh;
      },
      { timeout: 8_000, message: `sentence-${idx} should settle near viewport center` },
    )
    .toBeLessThan(CENTER_TOLERANCE);
}

test.describe('Fix #4: search result click scrolls reader', () => {
  test('same-chapter: clicking a result scrolls to a VIRTUALIZED-OUT sentence and centers it', async ({
    page,
  }) => {
    // Short viewport so only the first handful of sentences are mounted by
    // react-virtuoso. The target lives far down chapter 1 and is NOT in the DOM
    // at top-of-scroll — the old getElementById path returned null and never
    // scrolled. The fix routes through Virtuoso.scrollToIndex, which mounts the
    // row before scrolling, so the jump must now succeed.
    await page.setViewportSize({ width: 600, height: 400 });
    await openBook(page);

    // Make sure we start at the top.
    await page.evaluate(() => window.scrollTo(0, 0));
    const scrollBefore = await page.evaluate(() => window.scrollY);

    // "phonemes" is unique to the LAST sentence of chapter 1 — far below the
    // fold and virtualized out at top-of-scroll.
    await search(page, 'phonemes');

    const result = page.locator(SEARCH_RESULT).first();
    await expect(result.locator('.search-result-chapter')).toContainText(/chapter 1/i);

    // PROVE the target is NOT mounted before the click: only the top handful of
    // sentence ids (sentence-0..~7) should exist in the DOM, and no element
    // containing "phonemes" should be present.
    const phonemesMountedBefore = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('[id^="sentence-"]')) as HTMLElement[];
      return spans.some((s) => /phonemes/i.test(s.textContent ?? ''));
    });
    expect(phonemesMountedBefore).toBe(false); // virtualized out initially

    await result.click();

    // Panel closes.
    await expect(page.locator(SEARCH_INPUT)).toBeHidden({ timeout: 5_000 });

    // A scroll actually happened relative to the top.
    await expect
      .poll(async () => page.evaluate(() => window.scrollY), { timeout: 8_000 })
      .toBeGreaterThan(scrollBefore + 20);

    // The target is now mounted; resolve its index and assert it centered.
    const targetIdx = await page
      .locator('[id^="sentence-"]')
      .filter({ hasText: /phonemes/i })
      .first()
      .evaluate((el) => {
        const m = el.id.match(/sentence-(\d+)/);
        return m ? parseInt(m[1], 10) : -1;
      });
    expect(targetIdx).toBeGreaterThan(0);

    await assertCentered(page, targetIdx);
  });

  test('cross-chapter: clicking a chapter-2 result navigates and scrolls to the match', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await openBook(page);

    // Confirm we start in chapter 1.
    await expect(page.locator('main')).toContainText(/Chapter 1 of 3/i);

    // Unique phrase lives only in chapter 2.
    await search(page, 'elephants dancing in moonlight');

    const result = page.locator(SEARCH_RESULT).first();
    await expect(result.locator('.search-result-chapter')).toContainText(/chapter 2/i);
    await result.click();

    // Panel closes.
    await expect(page.locator(SEARCH_INPUT)).toBeHidden({ timeout: 5_000 });

    // Reader navigated to chapter 2 (header updates). Generous wait for load.
    await expect(page.locator('main')).toContainText(/Chapter 2 of 3/i, { timeout: 15_000 });
    await expect(page.locator('main')).toContainText(/The Middle/i, { timeout: 15_000 });

    // The matched sentence is now rendered; find its index and assert centered.
    const targetIdx = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('[id^="sentence-"]')) as HTMLElement[];
      const hit = spans.find((s) => /elephants dancing in moonlight/i.test(s.textContent ?? ''));
      if (!hit) return -1;
      const m = hit.id.match(/sentence-(\d+)/);
      return m ? parseInt(m[1], 10) : -1;
    });
    expect(targetIdx).toBeGreaterThanOrEqual(0);

    await assertCentered(page, targetIdx);
  });

  test('regression: opening/closing search without clicking a result does not jump the view', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await openBook(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    const before = await page.evaluate(() => window.scrollY);

    await openSearch(page);
    await page.locator(SEARCH_INPUT).fill('phonemes');
    await page.locator(SEARCH_RESULT).first().waitFor({ state: 'visible' });
    // Close without clicking a result.
    await page.locator('button[title="Close search"]').click();
    await expect(page.locator(SEARCH_INPUT)).toBeHidden();

    const after = await page.evaluate(() => window.scrollY);
    expect(Math.abs(after - before)).toBeLessThan(20);
  });
});
