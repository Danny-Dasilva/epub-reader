import { defineConfig, devices } from '@playwright/test';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * This environment is Ubuntu 26.04, which Playwright 1.60's host-platform map
 * does not recognize — `playwright install` refuses before downloading even
 * though the generic linux64 Chromium build runs fine. We force the override
 * here so `npx playwright test` resolves/launches the browser without needing
 * the env vars set in the shell.
 */
process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE ||= 'ubuntu24.04-x64';
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS ||= '1';

/** Locate the force-installed headless-shell binary (version-agnostic). */
function findHeadlessShell(): string | undefined {
  const root = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-'));
  for (const d of dirs) {
    const exe = join(root, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const headlessShell = findHeadlessShell();

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 90_000,
  expect: {
    timeout: 12_000,
  },

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          ...(headlessShell ? { executablePath: headlessShell } : {}),
          args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
        },
      },
    },
  ],

  webServer: {
    command: 'npm run dev',
    port: 3000,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
