import { defineConfig, devices } from "@playwright/test";

// Browser tests: the real app, a real Postgres, the demo seed (see
// scripts/e2e-server.mjs). They pin the features people rely on so a merge
// that drops one fails CI instead of being noticed weeks later. Unit tests
// (vitest, src/**/*.test.ts) cover logic; these cover "is it still there".

const PORT = process.env.E2E_PORT ?? "3100";
export const E2E_EMAIL = process.env.E2E_EMAIL ?? "e2e@berkeley.edu";

export default defineConfig({
  testDir: "./e2e",
  // Tests share one seeded database; serial keeps them from racing each other.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Identity the way Caddy's forward_auth hands it to the app in production.
    extraHTTPHeaders: { "x-auth-email": E2E_EMAIL, "x-auth-user": "E2E Admin" },
    // A click on something a merge removed should fail in seconds, not at the
    // 60 s test timeout.
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    // A static file: Playwright's readiness probe can't send the auth header
    // above, and every page answers 500 without one.
    url: `http://localhost:${PORT}/star-icon.svg`,
    // Migrate + seed + (in dev) first compile.
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    env: { E2E_PORT: PORT, E2E_EMAIL },
  },
});
