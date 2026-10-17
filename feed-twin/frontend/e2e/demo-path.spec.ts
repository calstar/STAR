import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs/promises';

import { API } from './stack';

/**
 * The demo path, end to end, on the stack playwright.config.ts boots: a first
 * run on an empty library, the sample stand, T-0, FIRE, a burn, and the run it
 * leaves on Runs. Along the way every view a person reads pressures on says
 * psia (ADR 0007), never psig, and nothing on screen is a raw object or a
 * console error.
 *
 * One test, in order: each step stands on the one before, as on the pad.
 */

/** The views that show pressures, by their nav label. */
const PRESSURE_VIEWS = ['Console', 'GSE Controls', 'Plots', 'Engine', 'Runs', 'Study'] as const;

/** What a person can read: the page's rendered text, hovers left out. A psig
 *  hover next to a psia figure is allowed (ADR 0007: it cross-checks the DAQ). */
async function visibleText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

async function open(page: Page, label: string) {
  await page.locator('nav').getByRole('link', { name: label, exact: true }).click();
}

/** FEEDTWIN_E2E_SHOTS=<dir> keeps a screenshot of each step, to look at. */
async function shot(page: Page, name: string) {
  const dir = process.env.FEEDTWIN_E2E_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/e2-${name}.png` });
}

test('empty library → sample stand → T-0 → FIRE → a run on Runs, all in psia', async ({ page, request }) => {
  // Problems the browser reports, kept to the end so one run lists them all.
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`page: ${e.message}`));

  // ── An empty library. The backend seeds the shipped drawings and the sample
  // into a fresh one at start; removing them is how a library gets empty, and
  // a removed sample stays out until somebody asks for it (D-78).
  const listed = await request.get(`${API}/api/library`);
  expect(listed.ok()).toBeTruthy();
  for (const a of (await listed.json()) as { id: string }[]) {
    expect((await request.delete(`${API}/api/library/${a.id}`)).ok()).toBeTruthy();
  }
  expect(await (await request.get(`${API}/api/library`)).json()).toEqual([]);

  // ── First run: the panel offers the sample, not a spinner.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No stand yet' })).toBeVisible();
  const loadSample = page.getByRole('button', { name: 'Load the sample stand' });
  await expect(loadSample).toBeVisible();
  await shot(page, 'first-run');

  // ── The sample stand opens on the console.
  await loadSample.click();
  await expect(page.locator('header')).toContainText('LE4', { timeout: 120_000 });
  const t0 = page.getByRole('button', { name: 'T-0', exact: true });
  await expect(t0).toBeEnabled({ timeout: 120_000 });

  // ── T-0, then FIRE. Runs already kept (a retry's first try) are counted, so
  // the one this burn leaves is the one more.
  const before = ((await (await request.get(`${API}/api/twin/runs`)).json()) as unknown[]).length;
  await t0.click();
  const fire = page.getByRole('button', { name: /^Fire\??/ });
  await expect(fire).toBeEnabled({ timeout: 60_000 });
  await fire.click();
  // FIRE asks once when a run tank sits far under lockup; T-0 primes them at
  // it, so it should not -- but if it does, the second press is the answer.
  if (await page.getByRole('button', { name: /^Fire\?/ }).isVisible()) await fire.click();

  // ── The burn: lit, then over.
  // The headline band and the pad guide both say so; either will do.
  await expect(page.getByText('Burning', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Last burn', { exact: true }).first()).toBeVisible({ timeout: 240_000 });
  const chamber = page.locator('[title="Mean chamber pressure of the last burn"]');
  await expect(chamber).toContainText('psia');
  await shot(page, 'console-last-burn');

  // ── The run it left.
  await open(page, 'Runs');
  await expect(page.getByRole('row').filter({ hasText: 'LE4 stand' })).toHaveCount(before + 1);

  // ── Every pressure view, read as a person reads it.
  for (const label of PRESSURE_VIEWS) {
    await open(page, label);
    if (label === 'Plots') {
      // The plots name their unit on the canvas, out of reach of the page's
      // text; the CSV beside them is written from the same unit, column by
      // column, so read that.
      await expect(page.getByText(/\d+ samples/)).toBeVisible();
      const [csv] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Download CSV' }).click(),
      ]);
      const header = (await fs.readFile(await csv.path(), 'utf8')).split('\n', 1)[0];
      expect(header, 'Plots CSV columns read psia').toMatch(/\[psia\]/);
      expect(header, 'Plots CSV columns read no psig').not.toMatch(/psig/i);
    } else {
      // Waits for the view's first pull to land and put a pressure on screen.
      await expect(page.locator('main'), `${label} shows a pressure in psia`).toContainText('psia');
    }
    await shot(page, label.toLowerCase().replace(/\W+/g, '-'));
    const text = await visibleText(page);
    expect(text, `${label} shows no psig`).not.toMatch(/psig/i);
    expect(text, `${label} shows no raw object`).not.toContain('[object Object]');
  }

  expect(errors, 'the browser reported no errors').toEqual([]);
});
