/**
 * The checkout countdown, against a real browser and a controllable clock.
 *
 * This exists because of a bug the unit tests could not have caught on their own: the hook
 * seeded its "last interaction" timestamp with the mount time, so merely opening the page
 * counted as working, the 15 s tick refreshed the hold forever, and a user returning to an
 * untouched tab saw a fresh 15:00 every time. It was found by a person watching a timer.
 *
 * `lib/stardesign-ui` now covers that with fake timers — but fake timers are precisely what
 * would hide a real-timer defect, so one end-to-end check earns its place: real React, real
 * intervals, a real network round trip to a real FastAPI backend.
 *
 * The helpers below are deliberately a small local copy of the ones in
 * design-persistence.spec.ts rather than an extraction: that suite is the only E2E
 * currently guarding shared checkout UI, and refactoring it to serve this file would put it
 * at risk for no benefit here.
 */

import { test, expect, type Page } from '@playwright/test';

/** The countdown span the chip renders beside "Editing" — e.g. "· 14:37". */
const COUNTDOWN = /^·\s*\d+:\d{2}$/;

const releaseButton = (page: Page) =>
  page.locator('button:not([title])').filter({ hasText: /^Release/ });

const designPicker = (page: Page) => page.locator('header select').last();

/**
 * The design bar has to be live before Take does anything: `CheckoutControl` renders in
 * every state, and `useCheckout.take()` no-ops while `ref` is null.
 */
async function waitForDesignBar(page: Page) {
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(designPicker(page)).not.toHaveValue('', { timeout: 30_000 });
}

/**
 * Converge on "checked out" rather than asserting one click did it: a `sendBeacon` release
 * from a previous test's page can land late and flip the chip back through no fault of the
 * app.
 */
async function ensureCheckedOut(page: Page) {
  await expect
    .poll(
      async () => {
        const take = page.getByRole('button', { name: 'Take', exact: true });
        if (await take.isVisible().catch(() => false)) {
          await take.click({ timeout: 5_000 }).catch(() => {});
        }
        return releaseButton(page).isVisible().catch(() => false);
      },
      { timeout: 30_000, message: 'the design never reached "Editing"' },
    )
    .toBe(true);
}

/** The countdown as whole seconds. */
async function readCountdown(page: Page): Promise<number> {
  const text = (await page.getByText(COUNTDOWN).first().innerText()).trim();
  const m = text.match(/(\d+):(\d{2})/);
  if (!m) throw new Error(`countdown not parseable from ${JSON.stringify(text)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

test('a tab that never took the design does not refresh its hold', async ({ context }) => {
  test.setTimeout(120_000); // the config default is 60 s and we fast-forward through minutes

  // The bug only shows where the hook mounts ALREADY holding the design with nobody having
  // interacted with that page. Reloading cannot produce it -- `pagehide` releases on the way
  // out, by design -- but a second tab can: the same user opens the design elsewhere, its
  // poll reports "you hold this", and it becomes held having been touched zero times.
  //
  // Seeding "last interaction" with the mount time made that look like work, so the hold was
  // refreshed on every tick and the countdown sat at a full 15:00. Do NOT fast-forward past
  // the idle cap first: that retires the bad mount stamp and the test passes either way.
  const owner = await context.newPage();
  await owner.goto('/');
  await waitForDesignBar(owner);
  await ensureCheckedOut(owner);

  const observer = await context.newPage();
  let beats = 0;
  await observer.route('**/checkout/beat', async (route) => {
    beats += 1;
    await route.continue();
  });
  await observer.clock.install();
  await observer.goto('/');
  await waitForDesignBar(observer);
  await expect(releaseButton(observer)).toBeVisible({ timeout: 30_000 });

  const started = await readCountdown(observer);
  expect(started).toBeGreaterThan(0);
  beats = 0;

  // Well inside the idle cap, so a mount-seeded stamp would still count as recent.
  await observer.clock.fastForward('05:00');
  await observer.waitForTimeout(1_000);

  expect(beats, 'a tab nobody has touched must not refresh the hold').toBe(0);

  // Deliberately NOT asserting the countdown fell: the owner tab is still legitimately
  // refreshing the hold, so this tab's countdown is expected to stay near full and any
  // assertion on it would be measuring the wrong page. The request count is the exact
  // statement of the regression; the countdown arithmetic is pinned in
  // lib/stardesign-ui/src/checkoutPolicy.test.ts, where nothing else can confound it.
  expect(await readCountdown(observer)).toBeLessThanOrEqual(started);
});

test('interacting with the page does refresh the hold', async ({ page }) => {
  test.setTimeout(120_000);

  let beats = 0;
  await page.route('**/checkout/beat', async (route) => {
    beats += 1;
    await route.continue();
  });

  await page.clock.install();
  await page.goto('/');
  await waitForDesignBar(page);
  await ensureCheckedOut(page);

  await page.clock.fastForward('16:00'); // age out the Take
  await page.waitForTimeout(1_000);
  const idle = beats;

  // A real input event, not a synthetic one -- that is the whole point of doing this in a
  // browser. A bare modifier press touches nothing on the page but still reaches the
  // window-level keydown listener the hook installs.
  await page.keyboard.press('Shift');
  await page.clock.fastForward('00:30');
  await page.waitForTimeout(1_000);

  expect(beats, 'real interaction must keep the design').toBeGreaterThan(idle);
});
