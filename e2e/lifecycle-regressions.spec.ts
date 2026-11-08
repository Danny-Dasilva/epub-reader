import { test, expect } from '@playwright/test';
import { forceCachedAudioPath, openBook, playPauseButton, waitForPlayable } from './helpers/harness';
import { installTTSMock } from './helpers/ttsMock';

test('autoplay only starts once, so a later pause stays paused', async ({ page }) => {
  await forceCachedAudioPath(page);
  await installTTSMock(page, { durationSec: 5 });
  const bookId = await openBook(page);
  await page.goto(`/reader/${bookId}?autoplay=true`);
  await waitForPlayable(page);
  const button = playPauseButton(page);
  await expect(button).toHaveAttribute('title', 'Pause', { timeout: 10_000 });
  await button.click();
  await expect(button).toHaveAttribute('title', 'Play');
  await page.waitForTimeout(1200);
  await expect(button).toHaveAttribute('title', 'Play');
});

test('a failed upload can retry the same file', async ({ page }) => {
  await page.goto('/');
  const input = page.locator('input[type="file"]');
  const badFile = { name: 'broken.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('not an epub') };
  await input.setInputFiles(badFile);
  await expect(page.getByText('Failed to parse EPUB file')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await input.setInputFiles(badFile);
  await expect(page.getByText('Failed to parse EPUB file')).toBeVisible();
});
