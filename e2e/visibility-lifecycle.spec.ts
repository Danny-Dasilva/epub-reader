import { test, expect } from '@playwright/test';
import { openBook, playPauseButton, waitForPlayable } from './helpers/harness';
import { installTTSMock } from './helpers/ttsMock';

test('changing playback while hidden cancels the automatic resume', async ({ page }) => {
  await installTTSMock(page, { durationSec: 10 });
  await openBook(page);
  await waitForPlayable(page);
  const button = playPauseButton(page);
  await button.click();
  await expect(button).toHaveAttribute('title', 'Pause');

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(button).toHaveAttribute('title', 'Play');
  // The user explicitly resumes and pauses while the tab is hidden.
  await button.click();
  await expect(button).toHaveAttribute('title', 'Pause');
  await button.click();
  await expect(button).toHaveAttribute('title', 'Play');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(button).toHaveAttribute('title', 'Play');
});
