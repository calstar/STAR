import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests assume Next.js is already running (see test/e2e_sensor_info.sh or
 * test/e2e_guitest_playwright.sh). Browser tests are separate from test/test_integration.sh.
 *
 * PLAYWRIGHT_BASE_URL — browser navigates here (Next origin only).
 * NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL — set when starting `npm run dev` (baked at compile time).
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
