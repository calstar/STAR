import { expect, test, type Page } from '@playwright/test';

/**
 * The cockpit on a 1280 x 720 projector, the smallest screen it is run from.
 *
 * What a full-HD run cannot see: the header's status row ran 55 px past the
 * window with the stand taken and cut ENG ABORT to "ENG"; the console's state
 * grid spilled past the end of its own scroll; an address that is no view
 * drew an empty page. Each test opens whatever stand the library offers --
 * the sample, loaded if the library is empty (demo-path.spec.ts empties it).
 */

test.use({ viewport: { width: 1280, height: 720 } });

async function openStand(page: Page, path = '/') {
  await page.goto(path);
  const t0 = page.getByRole('button', { name: 'T-0', exact: true });
  const sample = page.getByRole('button', { name: 'Load the sample stand' });
  await expect(t0.or(sample)).toBeVisible({ timeout: 120_000 });
  if (await sample.isVisible()) await sample.click();
  await expect(t0).toBeEnabled({ timeout: 120_000 });
}

test('an address that is no view goes to the Console', async ({ page }) => {
  const unmatched: string[] = [];
  page.on('console', (m) => {
    if (/No routes matched/.test(m.text())) unmatched.push(m.text());
  });
  await openStand(page, '/nonsense');
  await expect(page).toHaveURL(/\/$/);
  expect(unmatched).toEqual([]);
});

test('the header fits 1280 px with the stand taken, ENG ABORT whole on screen', async ({ page }) => {
  await openStand(page);
  // Save this set-up as a stand of one's own: it opens taken ("Editing").
  await page.locator('header').getByRole('button', { name: /^(LE4|Unsaved|No stand)/ }).first().click();
  await page.getByRole('button', { name: '+ New stand' }).click();
  await page.getByPlaceholder('Stand name').fill(`layout ${Date.now()}`);
  await page.getByPlaceholder('Stand name').press('Enter');
  await expect(page.locator('header').getByRole('button', { name: 'Stop editing' })).toBeVisible({ timeout: 30_000 });

  for (const view of ['Engine', 'Plots', 'Checks']) {
    await page.locator('nav').getByRole('link', { name: view, exact: false }).first().click();
    const abort = page.locator('header').getByRole('button', { name: 'Eng Abort' });
    await expect(abort).toBeVisible();
    const box = (await abort.boundingBox())!;
    const width = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, window: innerWidth }));
    expect(box.x + box.width, `${view}: ENG ABORT ends inside the window`).toBeLessThanOrEqual(width.window);
    expect(width.doc, `${view}: no sideways scroll`).toBeLessThanOrEqual(width.window);
  }
});

test("the console's state grid scrolls whole, its labels on one line", async ({ page }) => {
  await openStand(page);
  const ready = page.getByRole('button', { name: 'Ready', exact: true });
  await ready.scrollIntoViewIfNeeded();
  const fits = await ready.evaluate((el) => {
    let panel = el.parentElement;
    while (panel && getComputedStyle(panel).overflowY !== 'auto') panel = panel.parentElement;
    panel!.scrollTop = panel!.scrollHeight;
    const r = el.getBoundingClientRect();
    const p = panel!.getBoundingClientRect();
    return { readyBottom: r.bottom, panelBottom: p.bottom };
  });
  // Whole, with the panel's margin under it: the last row used to stop half a
  // pixel past the end of the scroll.
  expect(fits.readyBottom, 'READY scrolls into the panel whole').toBeLessThanOrEqual(fits.panelBottom - 8);
  const heading = page.getByRole('heading', { name: 'State Machine' });
  expect((await heading.boundingBox())!.height, 'one line').toBeLessThan(24);
  for (const name of ['GSE Abort', 'Emergency Abort']) {
    const wrapped = await page
      .getByRole('button', { name, exact: true })
      .evaluate((b) => b.scrollHeight > b.clientHeight + 1 || b.getBoundingClientRect().height > 30);
    expect(wrapped, `${name} on one line`).toBe(false);
  }
});
