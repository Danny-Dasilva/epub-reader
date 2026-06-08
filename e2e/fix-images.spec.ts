import { test, expect } from '@playwright/test';
import { openBook, SAMPLE_EPUB, SAMPLE_IMAGE_EPUB } from './helpers/harness';

/**
 * E2E coverage for INLINE IMAGE rendering.
 *
 * Fixture `sample-image.epub` (built by create-image-epub.mjs) chapter 1, as
 * actually parsed:
 *   - <h1>          -> sentences 0, 1
 *   - Paragraph 1   -> sentences 2, 3, 4
 *   - inline <img alt="A red square"> anchored before paragraph 2
 *   - Paragraph 2   -> sentences 5, 6, 7
 *
 * The image is NOT a sentence: it carries no `sentence-N` id, is never sent to
 * TTS, and must render as `<figure class="block-image"><img .../></figure>`
 * between sentence-4 and sentence-5 in DOM order.
 */

const IMG = 'figure.block-image img';

test('inline image renders, decodes, and is visible', async ({ page }) => {
  await openBook(page, SAMPLE_IMAGE_EPUB);

  const img = page.locator(IMG).first();
  await img.waitFor({ state: 'visible', timeout: 20_000 });
  await expect(img).toBeVisible();

  // src is an inlined data: URL (or blob:) — not the raw archive path.
  const src = await img.getAttribute('src');
  expect(src, 'image src should be present').toBeTruthy();
  expect(src!).toMatch(/^(data:|blob:)/);

  // Correct alt text propagated from the EPUB.
  await expect(img).toHaveAttribute('alt', 'A red square');

  // Image actually decoded (bytes were valid, not a broken-image placeholder).
  const naturalWidth = await img.evaluate(
    (el) => (el as HTMLImageElement).naturalWidth
  );
  expect(naturalWidth, 'decoded image should have naturalWidth > 0').toBeGreaterThan(0);
});

test('image sits in DOM order between sentence 4 and sentence 5', async ({ page }) => {
  await openBook(page, SAMPLE_IMAGE_EPUB);

  await page.locator(IMG).first().waitFor({ state: 'visible', timeout: 20_000 });

  // Ensure both flanking sentences are rendered in the (virtualized) viewport.
  await page.locator('#sentence-4').waitFor({ state: 'attached', timeout: 20_000 });
  await page.locator('#sentence-5').waitFor({ state: 'attached', timeout: 20_000 });

  const order = await page.evaluate(() => {
    const figure = document.querySelector('figure.block-image');
    const before = document.getElementById('sentence-4');
    const after = document.getElementById('sentence-5');
    if (!figure || !before || !after) {
      return { ok: false, hasFigure: !!figure, hasBefore: !!before, hasAfter: !!after };
    }
    // Node.compareDocumentPosition: FOLLOWING (4) means arg comes after `this`.
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    const figAfterBefore = (before.compareDocumentPosition(figure) & FOLLOWING) !== 0;
    const afterAfterFig = (figure.compareDocumentPosition(after) & FOLLOWING) !== 0;
    return { ok: true, figAfterBefore, afterAfterFig };
  });

  expect(order.ok, `flanking nodes present: ${JSON.stringify(order)}`).toBe(true);
  expect(order.figAfterBefore, 'figure must come AFTER sentence-4').toBe(true);
  expect(order.afterAfterFig, 'figure must come BEFORE sentence-5').toBe(true);
});

test('image is not counted as a sentence; sentence indices stay contiguous', async ({ page }) => {
  await openBook(page, SAMPLE_IMAGE_EPUB);

  await page.locator(IMG).first().waitFor({ state: 'visible', timeout: 20_000 });
  // Make sure sentences on both sides of the image are realized in the DOM.
  await page.locator('#sentence-5').waitFor({ state: 'attached', timeout: 20_000 });

  const result = await page.evaluate(() => {
    // The image / its figure must NOT carry a sentence id.
    const figure = document.querySelector('figure.block-image');
    const img = figure?.querySelector('img') ?? null;
    const figureHasSentenceId = !!figure && /^sentence-/.test(figure.id);
    const imgHasSentenceId = !!img && /^sentence-/.test(img.id);
    const imgInsideSentence = !!img && !!img.closest('.sentence');

    // Collect realized sentence indices and confirm contiguity (no gap where
    // the image sits, i.e. the image did not consume an index).
    const idxs = Array.from(document.querySelectorAll('[id^="sentence-"]'))
      .map((el) => {
        const m = el.id.match(/^sentence-(\d+)$/);
        return m ? parseInt(m[1], 10) : NaN;
      })
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);

    let contiguous = true;
    for (let i = 1; i < idxs.length; i++) {
      if (idxs[i] !== idxs[i - 1] + 1) {
        contiguous = false;
        break;
      }
    }

    return {
      figureHasSentenceId,
      imgHasSentenceId,
      imgInsideSentence,
      idxs,
      contiguous,
      spansImage: idxs.includes(4) && idxs.includes(5),
    };
  });

  expect(result.figureHasSentenceId, 'figure must not have a sentence id').toBe(false);
  expect(result.imgHasSentenceId, 'img must not have a sentence id').toBe(false);
  expect(result.imgInsideSentence, 'img must not be nested inside a .sentence').toBe(false);
  // The sentences flanking the image (4 and 5) are both present...
  expect(result.spansImage, `indices around image present: ${JSON.stringify(result.idxs)}`).toBe(true);
  // ...and indices are contiguous, proving the image did not steal an index.
  expect(result.contiguous, `sentence indices contiguous: ${JSON.stringify(result.idxs)}`).toBe(true);
});

test('regression: a book without images renders zero figure.block-image', async ({ page }) => {
  await openBook(page, SAMPLE_EPUB);

  // Reader content is up (first sentence visible via openBook). Give the
  // render a beat, then assert no phantom image figures were injected.
  await page.locator('.sentence').first().waitFor({ state: 'visible', timeout: 20_000 });
  await expect(page.locator('figure.block-image')).toHaveCount(0);
});
