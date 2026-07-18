import { test, expect } from '@playwright/test';

/**
 * Load-time budget guard. The pre-Vite GUI took ~20s to cold-load; the static
 * build should be interactive in well under a second on real hardware. Budgets
 * are deliberately generous (CI runners are slow and noisy) — this is a
 * regression tripwire for "someone made the GUI take ages to load", not a
 * micro-benchmark. Measured numbers are logged on every run so CI history
 * shows the trend even while the assertion passes.
 *
 * Budgets (override via env):
 *   E2E_LOAD_BUDGET_MS  — navigation start → <main> visible   (default 2s)
 *   E2E_DATA_BUDGET_MS  — navigation start → first live data  (default 10s)
 *
 * Baseline for calibration (2026-07, WSL local run): interactive ~200-275ms,
 * first live data ~275ms — so 2s is ~8x headroom for CI-runner noise, and CI
 * retries once, so a transient spike must repeat to fail the job. Loosen via
 * env rather than editing if a runner class proves noisier.
 */

const LOAD_BUDGET_MS = Math.max(1, parseInt(process.env.E2E_LOAD_BUDGET_MS ?? '2000', 10) || 2000);
const DATA_BUDGET_MS = Math.max(1, parseInt(process.env.E2E_DATA_BUDGET_MS ?? '10000', 10) || 10000);

for (const path of ['/', '/sensor-info']) {
  test(`load budget: ${path} interactive within ${LOAD_BUDGET_MS}ms`, async ({ page }) => {
    const t0 = Date.now();
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.locator('main').first().waitFor({ state: 'visible' });
    const interactiveMs = Date.now() - t0;

    // Browser-side timings for the log (finer-grained than the wall clock).
    const nav = await page.evaluate(() => {
      const e = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const fcp = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
      return {
        domContentLoaded: e ? Math.round(e.domContentLoadedEventEnd) : null,
        loadEvent: e ? Math.round(e.loadEventEnd) : null,
        firstContentfulPaint: fcp ? Math.round(fcp.startTime) : null,
      };
    });
    console.log(
      `[load-benchmark] ${path}: interactive=${interactiveMs}ms ` +
        `dcl=${nav.domContentLoaded}ms load=${nav.loadEvent}ms fcp=${nav.firstContentfulPaint}ms ` +
        `(budget ${LOAD_BUDGET_MS}ms)`,
    );

    expect(
      interactiveMs,
      `${path} took ${interactiveMs}ms to become interactive (budget ${LOAD_BUDGET_MS}ms) — ` +
        `did the bundle or GUI server get slow?`,
    ).toBeLessThan(LOAD_BUDGET_MS);
  });
}

test(`live data budget: sensor-info shows real data within ${DATA_BUDGET_MS}ms`, async ({ page }) => {
  const t0 = Date.now();
  await page.goto('/sensor-info', { waitUntil: 'domcontentloaded' });

  // "Live data arrived" = the Packets card stops showing its "---" placeholder.
  // This covers static load + WS connect + first backend broadcast + render.
  const packets = page.getByTestId('sensor-info-packets-count');
  await expect(packets).toBeVisible({ timeout: DATA_BUDGET_MS });
  await expect(packets).not.toContainText('---', { timeout: DATA_BUDGET_MS });
  const dataMs = Date.now() - t0;

  console.log(`[load-benchmark] /sensor-info first live data: ${dataMs}ms (budget ${DATA_BUDGET_MS}ms)`);
  expect(
    dataMs,
    `sensor-info took ${dataMs}ms to show live data (budget ${DATA_BUDGET_MS}ms) — ` +
      `slow load, slow WS connect, or slow first broadcast?`,
  ).toBeLessThan(DATA_BUDGET_MS);
});
