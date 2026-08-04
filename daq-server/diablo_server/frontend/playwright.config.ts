import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests assume the GUI is already served on :3000 (static build via the
 * backend's GUI_PORT listener, or `vite dev`; see test/e2e_guitest_playwright.sh).
 * Browser tests are separate from test/test_integration.sh.
 *
 * PLAYWRIGHT_BASE_URL — browser navigates here (GUI origin).
 * API/WS URLs are derived from window.location at runtime — no env baking.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
