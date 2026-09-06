import { test, expect } from '@playwright/test';

/**
 * The two halves of the checkout contract, end to end against a real backend.
 *
 * 1. A change made while you hold the design reaches the stored design and is
 *    still there after a reload. The signal is traffic -- a POST to
 *    .../autosave -- plus the value surviving the round trip.
 *
 *    Honest scope note: this passes against the code as it was before the
 *    autosave effect was rewritten to key on the design alone. That rewrite
 *    removes a real fragility (the 4s interval was re-armed on every render,
 *    because `useCheckout` returns a fresh object each time) but it is not what
 *    this test catches, and it should not be described as the fix for it. What
 *    this test does catch is the class of breakage where autosave stops firing
 *    or the working copy stops being written at all.
 *
 * 2. Only ConfigEditor consulted the read-only context, so with no checkout the
 *    rest of the UI was still typeable. The requirements form is the clearest
 *    case: 33 inputs writing config.design_requirements, none of them gated.
 *    This one does fail on the old code.
 *
 * Both drive the real app; neither can pass on a mocked backend.
 */

const AUTOSAVE = /\/api\/engine\/documents\/.*\/autosave/;

type Page = import('@playwright/test').Page;

/**
 * The checkout's own Release button.
 *
 * Not `getByRole('button', {name: 'Release'})`: the designs bar has a second
 * Release next to it that publishes a version, and matching both is a strict
 * mode violation. Only the version one carries a title.
 */
const releaseButton = (page: Page) =>
  page.locator('button:not([title])').filter({ hasText: /^Release/ });

/** The designs bar's own design picker: the last <select> in the header. */
const designPicker = (page: Page) => page.locator('header select').last();

/**
 * Wait until the bar has actually adopted a design.
 *
 * Waiting for the checkout chip is not enough: `CheckoutControl` renders in all
 * states, so the chip and its Take button appear before `activeRef` is set --
 * and `useCheckout.take()` returns silently when there is no ref, so a click in
 * that window does nothing at all. The picker's value is the design key, so an
 * empty value means "no design yet".
 */
async function waitForDesignBar(page: Page) {
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(designPicker(page)).not.toHaveValue('', { timeout: 20_000 });
}

/**
 * Drive the checkout to a known state, retrying until it sticks.
 *
 * A single click is not enough. Closing a page releases the checkout with
 * `navigator.sendBeacon` (useCheckout's unload handler), and a beacon from the
 * *previous* test's page can land after this one has already taken it -- so the
 * chip flips back to "Read only" a moment later through no fault of the app.
 * Converging on the end state is both robust and a fair description of what is
 * being asserted: that the design ends up held, not that one click did it.
 */
async function driveCheckout(page: Page, want: 'Editing' | 'Read only') {
  const button = want === 'Editing'
    ? page.getByRole('button', { name: 'Take', exact: true })
    : releaseButton(page);
  await expect
    .poll(
      async () => {
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 5_000 }).catch(() => {});
        }
        return page.getByText(want, { exact: true }).isVisible().catch(() => false);
      },
      { timeout: 30_000, message: `the design never reached "${want}"` },
    )
    .toBe(true);
}

const ensureCheckedOut = (page: Page) => driveCheckout(page, 'Editing');
const ensureReadOnly = (page: Page) => driveCheckout(page, 'Read only');

/** Whatever the session config currently says, straight from the backend. */
async function readFuelTemperature(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const r = await fetch('/api/config');
    const body = await r.json();
    return body.config?.fluids?.fuel?.temperature ?? null;
  });
}

test('a checked-out edit reaches the stored design and survives a reload', async ({ page }) => {
  const autosaves: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && AUTOSAVE.test(req.url())) autosaves.push(req.url());
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForDesignBar(page);

  await ensureCheckedOut(page);

  // Change the design the way every tab does: through the config API. A
  // distinctive value so the assertion after the reload cannot pass by accident.
  // Unique per run: asserting on a fixed value would pass vacuously if a
  // previous run had already stored it, and the "did it save?" check below
  // needs the config to genuinely differ from what the design already holds.
  const marker = 100 + Number((Date.now() % 10_000) / 100);
  const put = await page.evaluate(async (value) => {
    const r = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fluids: { fuel: { temperature: value } } }),
    });
    return r.status;
  }, marker);
  expect(put, 'the config write itself must succeed while checked out').toBe(200);
  expect(await readFuelTemperature(page)).toBeCloseTo(marker, 4);

  // The autosave poll runs every 4s; give it a couple of windows.
  await expect
    .poll(() => autosaves.length, {
      timeout: 20_000,
      message:
        'no POST to .../autosave after changing the config with the design checked out — ' +
        'the autosave interval is being re-armed faster than it can fire ' +
        '(see the `live` ref in DesignVersions.tsx).',
    })
    .toBeGreaterThan(0);

  // The real test: come back and the value is still there. This reads the
  // session, which the designs bar repopulates from the *stored* design on load.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDesignBar(page);
  await expect
    .poll(() => readFuelTemperature(page), {
      timeout: 20_000,
      message: 'the edit did not survive a reload — it never reached the stored design',
    })
    .toBeCloseTo(marker, 4);
});

test('the requirements form is editable only while checked out', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForDesignBar(page);

  await ensureReadOnly(page);

  await page.getByRole('button', { name: 'Optimizer', exact: true }).click();

  // The 33-field requirements form is gated by a disabled <fieldset>, so the
  // browser reports every descendant control as disabled. Asserting on the
  // control rather than the wrapper is what makes this a test of the *effect*.
  const thrust = page.locator('fieldset').first().locator('input[type="number"]').first();
  await expect(thrust).toBeDisabled();

  // The injector / propellant selectors live in the header, outside <main> --
  // which is why ReadOnlyProvider had to move up to wrap the whole app.
  // Scoped to those two: the designs bar's own design picker is also a header
  // <select>, and it must stay live -- switching designs is how you get out of
  // read-only in the first place.
  const configSelects = ['Propellant', 'Injector'].map((label) =>
    page.locator('header label').filter({ hasText: label }).locator('select'),
  );
  for (const sel of configSelects) await expect(sel).toBeDisabled();
  await expect(
    designPicker(page),
    'the design picker must stay usable while read only',
  ).toBeEnabled();

  // The other half of the claim: taking the design makes it editable again. A
  // test that only ever saw everything disabled would still pass if the app
  // were broken shut.
  await ensureCheckedOut(page);
  await expect(thrust).toBeEnabled();
  for (const sel of configSelects) await expect(sel).toBeEnabled();
});
