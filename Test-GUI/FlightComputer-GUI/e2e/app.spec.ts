// The window, driven like a person would: real buttons by their names, against
// the real backend and simulated board (see playwright.config.ts). The rules
// themselves are tested in tests/backend.rs; these check the window shows the
// view and sends the right commands.

import { expect, test, type Page } from "@playwright/test";

async function connect(page: Page) {
  await page.goto("/?ws=5179");
  // Pick the simulated board by name: a CI machine has real serial ports too
  // (/dev/ttyS0), and the app lists those first.
  await page.getByLabel("Port").selectOption("sim://flight-computer");
  await expect(page.getByLabel("Port")).toHaveValue("sim://flight-computer");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("status")).toContainText("Connected");
  await expect(page.locator(".topbar .chip")).toHaveText("IDLE");
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name }).click();

test("status and live", async ({ page }) => {
  await connect(page);
  await expect(page.locator(".rows dt", { hasText: "Flight state" }).locator("+ dd")).toHaveText("IDLE");
  await expect(page.locator(".selftest li", { hasText: "IMU" })).toContainText("pass");

  await tab(page, "Live");
  const accel = page.getByTestId("readings").locator(".reading", { hasText: "Accel (IMU)" });
  await expect(accel).not.toHaveClass(/stale/);
  await expect(accel.locator("b").nth(2)).toHaveText(/^\+(0\.9|1\.0)/); // z, resting: ~1 g
  // The readings are a sidebar left of the charts, and every box shows all of
  // its values (a long one wraps inside its box), at a narrow window too.
  const side = await page.getByTestId("readings").boundingBox();
  const charts = await page.locator(".live-charts").boundingBox();
  expect(side!.x + side!.width).toBeLessThanOrEqual(charts!.x);
  const clipped = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".reading")].filter((r) => r.scrollWidth > r.clientWidth + 1).map((r) => r.textContent),
    );
  await expect.poll(clipped).toEqual([]);
  await page.setViewportSize({ width: 960, height: 800 });
  await expect.poll(clipped).toEqual([]);
  // The charts are drawn: uPlot canvases with data in them.
  await expect(page.locator(".live-charts canvas")).toHaveCount(5);
  await expect.poll(() => page.evaluate(() => document.querySelectorAll(".live-charts .u-over").length)).toBe(5);
  // Hovering a chart shows the values under the cursor.
  const over = page.locator(".live-charts .u-over").first();
  await over.hover({ position: { x: 30, y: 20 } });
  await page.waitForTimeout(1500); // let the line reach the cursor
  await over.hover({ position: { x: 40, y: 20 } });
  const box = page.locator(".live-charts .chart-hover.show").first();
  await expect(box).toBeVisible();
  await expect(box).toContainText(/z [+-]?\d+\.\d{3} g/);
  await expect(page.locator(".live-charts .chart-hover.show")).toHaveCount(1); // only the hovered chart

  // Stream off: the board says so in its STATUS.
  await page.getByLabel("Stream rate").selectOption({ label: "Off" });
  await tab(page, "Status");
  await expect(page.locator(".rows dt", { hasText: "Streaming" }).locator("+ dd")).toHaveText("off");
});

test("download a flight and plot it", async ({ page }) => {
  await connect(page);
  await tab(page, "Flights");
  const rows = page.locator("table.flights tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("#2"); // newest first
  await rows.first().click();
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(rows.first()).toContainText("downloaded", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Download again" })).toBeEnabled();
  await expect(page.getByTestId("flight-detail")).toContainText("Flight 2:");
  await expect(page.locator(".flight-charts canvas")).toHaveCount(3);
  await expect(page.locator("[data-flight-title='1']")).toContainText("Axial acceleration");
  // Only downloaded rows have a View button; it brings that flight back.
  await expect(page.getByRole("button", { name: "View #1" })).toHaveCount(0);
  await rows.nth(1).click();
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByTestId("flight-detail")).toContainText("Flight 1:", { timeout: 30_000 });
  await page.getByRole("button", { name: "View #2" }).click();
  await expect(page.getByTestId("flight-detail")).toContainText("Flight 2:");
});

test("config: save to flash", async ({ page }) => {
  await connect(page);
  await tab(page, "Config");
  const sf = page.getByLabel("Spreading factor", { exact: true });
  await expect(sf).toBeEnabled();
  await sf.selectOption({ label: "SF10" });
  const freq = page.getByLabel("Frequency", { exact: true });
  await freq.fill("903.5");
  await expect(page.locator("tr", { has: freq })).toHaveClass(/differs/);
  await page.getByRole("button", { name: "Save to flash" }).click();
  await expect(page.getByTestId("config-banner")).toHaveText(/^Saved\./);
  await expect(page.locator("tr", { has: freq }).locator(".board")).toHaveText("903.500 MHz");
  await expect(page.locator("tr.differs")).toHaveCount(0);
});

test("config: a bad value disables Apply, and typing is not overwritten", async ({ page }) => {
  await connect(page);
  await tab(page, "Config");
  const apply = page.getByRole("button", { name: "Apply to board" });
  await expect(apply).toBeEnabled();
  const hb = page.getByLabel("Heartbeat armed / in flight", { exact: true });
  await hb.pressSequentially("x", { delay: 30 }); // "100x" style garbage, typed key by key
  await expect(apply).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save to flash" })).toBeDisabled();
  await expect(page.getByTestId("checks")).toContainText("not a whole number");
  await hb.fill("");
  await hb.pressSequentially("750", { delay: 15 });
  await expect(hb).toHaveValue("750");
  await expect(apply).toBeEnabled();
  // A signal hanging over the band edge.
  await page.getByLabel("Frequency", { exact: true }).fill("927.99");
  await expect(apply).toBeDisabled();
  await expect(page.getByTestId("checks")).toContainText("outside the 902-928 MHz band");
});

test("wipe needs the word", async ({ page }) => {
  await connect(page);
  await tab(page, "Flights");
  await expect(page.locator("table.flights tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "Wipe card…" }).click();
  const dialog = page.getByRole("dialog", { name: "Wipe card" });
  await expect(dialog).toContainText("NOT been downloaded");
  const wipe = dialog.getByRole("button", { name: "Wipe" });
  await expect(wipe).toBeDisabled();
  await dialog.getByRole("textbox").fill("WIPE");
  await wipe.click();
  await expect(page.locator("table.flights tbody tr")).toHaveText(["No flights listed."]);
});

test("hovering a ? shows its help", async ({ page }) => {
  await connect(page);
  await tab(page, "Config");
  const help = page.locator("tr", { has: page.getByLabel("Spreading factor", { exact: true }) }).locator(".help");
  const text = await help.getAttribute("data-tip");
  expect(text?.length).toBeGreaterThan(10);
  const tip = page.getByRole("tooltip");
  await expect(tip).not.toHaveClass(/show/);
  await help.hover();
  await expect(tip).toHaveClass(/show/);
  await expect(tip).toHaveText(text!);
  await expect(tip).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  await expect(tip).not.toHaveClass(/show/);
});

test("pausing leaves a gap, not a line across it", async ({ page }) => {
  await connect(page);
  await tab(page, "Live");
  // Accel's z values, null where the chart breaks.
  const z = () => page.evaluate(() => (window as any).live.charts[0].y[2] as (number | null)[]);
  await expect.poll(async () => (await z()).length).toBeGreaterThan(5);
  expect((await z()).includes(null)).toBe(false);
  await page.getByRole("button", { name: "Pause" }).click();
  await page.waitForTimeout(800);
  const before = (await z()).length;
  await page.getByRole("button", { name: "Resume" }).click();
  await expect.poll(async () => (await z()).length).toBeGreaterThan(before + 3);
  const after = await z();
  expect(after.indexOf(null)).toBe(before);
  expect(after.filter((v) => v === null)).toHaveLength(1);
});

test("a reconnect starts the charts afresh", async ({ page }) => {
  await connect(page);
  await tab(page, "Live");
  const x = () => page.evaluate(() => (window as any).live.charts[0].x as number[]);
  await expect.poll(async () => (await x()).at(-1) ?? 0).toBeGreaterThan(2);
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("status")).toContainText("Connected");
  await expect.poll(async () => (await x()).length).toBeGreaterThan(3);
  const xs = await x();
  expect(xs[0]).toBeLessThan(1.5); // the new link's own seconds, not the old ones
  expect(xs.every((t, i) => i === 0 || t > xs[i - 1])).toBe(true);
});
