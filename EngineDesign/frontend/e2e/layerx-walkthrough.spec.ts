import { test, expect, type Locator } from '@playwright/test';

/**
 * docs/layerx/WALKTHROUGH.md as a test: a first-time user opens Layer X, runs a burn, and answers
 * "which limit is closest, and when?" -- clicking only controls that are visible and labelled, the
 * way a person (or a screen reader) finds them. No test ids, no URL tricks, no local storage.
 *
 * It burns once, for real (about three minutes for the LE4 helium drawing with flight), through the
 * backend it is pointed at, and adds that one run to the user's run list. So it runs only when asked:
 *
 *   LAYERX_WALKTHROUGH=1 PLAYWRIGHT_BASE_URL=http://localhost:5173 npx playwright test e2e/layerx-walkthrough.spec.ts
 *
 * against servers that are already up (dev.sh). playwright.config.ts reuses a server it can reach at
 * 127.0.0.1:8000 and :5173 and boots one otherwise; when vite answers on localhost only, run it with
 * a config that has no `webServer` (docs/layerx/WALKTHROUGH.md, "Running the test"), so it never
 * starts a second stack.
 */

const BURN_TIMEOUT = 8 * 60_000;

test.skip(process.env.LAYERX_WALKTHROUGH !== '1', 'burns once for real: set LAYERX_WALKTHROUGH=1 (docs/layerx/WALKTHROUGH.md)');

/** A control the user can see and that says what it is. */
async function visibleAndNamed(control: Locator): Promise<string> {
  await expect(control).toBeVisible();
  const name = (await control.getAttribute('aria-label')) ?? (await control.innerText());
  expect(name.trim(), 'every control the walkthrough clicks has a name').not.toBe('');
  return name.trim();
}

test('a first-time user: load, run, and find the limit that is closest, and when', async ({ page }) => {
  test.setTimeout(BURN_TIMEOUT + 2 * 60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // ---- Load: the app, then the Layer X tab.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 });
  const tab = page.getByRole('button', { name: 'Layer X', exact: true });
  await visibleAndNamed(tab);
  await tab.click();

  // A first visit lands on the guided start: three steps, the drawing already picked (helium, the hot-fire pressurant).
  await expect(page.getByRole('heading', { name: 'Set up a burn' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Pick the drawing')).toBeVisible();
  await expect(page.getByText('copv_study_he').first()).toBeVisible();

  // ---- Run: the first "Run burn" the page shows, once the preflight has passed.
  const run = page.getByRole('button', { name: 'Run burn' }).first();
  await visibleAndNamed(run);
  await expect(run).toBeEnabled({ timeout: 90_000 });
  await run.click();
  await expect(page.getByRole('region', { name: 'The burn is running' })).toBeVisible({ timeout: 30_000 });

  // The burn is done when its pages appear; it opens on Overview, "Will it work?".
  const overview = page.getByRole('tab', { name: /Overview/ });
  await expect(overview).toBeVisible({ timeout: BURN_TIMEOUT });
  await expect(overview).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Will it work?')).toBeVisible();

  // ---- Which limit is closest? The Limits panel lists them worst first: the first bar.
  const limits = page.getByRole('region', { name: 'Limits' });
  await expect(limits.getByText('worst first')).toBeVisible();
  const closest = limits.locator('button, [role="group"]').first();
  const name = await visibleAndNamed(closest);
  // Its name says the limit, its value, its grade, when it was worst and the line it is graded against.
  expect(name).toMatch(/limit [≤≥]/);
  const when = /\bat (T[+−-][\d.]+\s?s)/.exec(name)?.[1];
  expect(when, `the closest limit says when it was worst: "${name}"`).toBeTruthy();
  expect(name).toMatch(/Jump to the worst moment/);

  // ---- And when? Clicking the bar puts the time cursor there.
  await closest.click();
  const cursor = page.getByRole('slider', { name: 'Time cursor' });
  await expect(cursor).toHaveAttribute('aria-valuetext', new RegExp(`^${when!.replace(/[+.]/g, '\\$&').replace(/\s/, '\\s')}`));

  expect(errors, 'no page errors on the way').toEqual([]);
  test.info().annotations.push({ type: 'answer', description: `${name.split(',')[0]} -- worst ${when}` });
});
