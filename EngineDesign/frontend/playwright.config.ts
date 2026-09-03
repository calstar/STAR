import { defineConfig, devices } from '@playwright/test';

/**
 * E2E for the engine-design GUI. Unlike daq-server (whose stack is booted by a
 * shell script), this config auto-boots the two servers it needs via `webServer`
 * so `npx playwright test` is self-contained:
 *   - FastAPI backend on :8000 (ED_USE_NATIVE=0 -> pure Python, no C build in CI)
 *   - Vite dev server on :5173, which proxies /api to the backend (vite.config.ts)
 *
 * PLAYWRIGHT_BASE_URL overrides the browser origin; with a stack already running
 * (e.g. ./dev.sh), reuseExistingServer skips the boot locally.
 */
const UI_PORT = 5173;
const API_PORT = 8000;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${UI_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // cwd '..' = the EngineDesign root, where backend/ lives.
      command: `python -m uvicorn backend.main:app --port ${API_PORT}`,
      cwd: '..',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env: { ED_USE_NATIVE: '0' },
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Bind IPv4 explicitly: vite defaults to "localhost", which on CI runners
      // can resolve to IPv6 ::1 while Playwright polls 127.0.0.1 -> the server
      // never looks ready and the run times out. stdout/stderr piped so vite's
      // output is visible (a silent webServer is undiagnosable on timeout).
      command: `npm run dev -- --host 127.0.0.1 --port ${UI_PORT}`,
      url: `http://127.0.0.1:${UI_PORT}`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
