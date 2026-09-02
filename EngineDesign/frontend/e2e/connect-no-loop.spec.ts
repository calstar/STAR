import { test, expect } from '@playwright/test';

/**
 * Regression guard for the "stuck on Connecting…" fetch loop.
 *
 * DesignVersions' bootstrap effect depends on `openDoc`, whose identity chains
 * back through `apply` -> `onRestore` (App.tsx). When `onRestore` was an inline
 * arrow it got a fresh identity every render, and the effect calls setConfig ->
 * re-render -> new onRestore -> new openDoc -> effect re-runs. That self-feeding
 * cycle hammered the backend ~7 requests/second forever (POST /api/config/load
 * chief among them) and never settled. Fix: onRestore is a stable useCallback.
 *
 * This is the frontend counterpart to tests/test_config_endpoints_offload.py.
 * The reliable signal is traffic, not the status text: idle config/load must
 * settle to ~0. (We also assert the app reaches "Connected" as a boot smoke
 * check — though in CI, with every CEA cache committed, the backend never does a
 * cold build, so that alone would not have exposed the hang.)
 */
test('app connects and config/load traffic settles instead of looping', async ({ page }) => {
  let configLoads = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/config/load')) configLoads++;
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Boot smoke check: it must leave the "Connecting…" state.
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 15_000 });

  // Let first-load settle, then measure a quiet observation window.
  await page.waitForTimeout(1_500);
  const baseline = configLoads;
  await page.waitForTimeout(5_000);
  const during = configLoads - baseline;

  console.log(`[loop-guard] POST /api/config/load in 5s idle window: ${during} (total ${configLoads})`);

  // Healthy: 0 in an idle window. The loop did ~35 in 5s. A small allowance
  // covers any legitimate late settle while staying far below the loop rate.
  expect(
    during,
    `POST /api/config/load fired ${during}× in a 5s idle window — the bootstrap ` +
      `fetch loop is back (see App.tsx onRestore / DesignVersions bootstrap effect).`,
  ).toBeLessThan(5);
});
