import { test, expect, type Page } from '@playwright/test';

/**
 * LabJack T7, through the running guitest stack: config_base.toml's labjack_1 (board_id 81, slot 1)
 * streamed by `t7_bridge --fake` (start_tmux_dev.sh, USE_SIM=1) and calibrated by
 * calibration_service like any ESP32 sensor. No API or WebSocket route is replaced.
 *
 * The fake signals sit at: PT 30 % of 1000 psi ±3 %, TC ~60 °C ±10, LC 20 % of 500 kg ±2 %.
 * The config editor checks edit in memory only and never press Save — saving would rewrite and
 * deploy the active profile of the stack under test.
 */

const T7 = {
  pt: { role: 'T7 Tank PT', entity: 'T71_Cal.AIN1', component: 'pressure_psi', min: 250, max: 350 },
  tc: { role: 'T7 Nozzle TC', entity: 'T71_Cal.AIN2', component: 'temperature_c', min: 45, max: 75 },
  lc: { role: 'T7 Thrust LC', entity: 'T71_Cal.AIN4', component: 'force_kg', min: 85, max: 115 },
};

/** Every finite T7 SENSOR_UPDATE value the page's own WebSocket receives, by entity.component. */
function collectT7(page: Page): Map<string, number[]> {
  const seen = new Map<string, number[]>();
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    let message: any;
    try { message = JSON.parse(payload.toString()); } catch { return; }
    if (message.type !== 'sensor_update') return;
    for (const row of Array.isArray(message.payload) ? message.payload : [message.payload]) {
      if (typeof row?.entity !== 'string' || !row.entity.startsWith('T7') || !Number.isFinite(row.value)) continue;
      const key = `${row.entity}.${row.component}`;
      const list = seen.get(key) ?? [];
      list.push(row.value);
      seen.set(key, list);
    }
  }));
  return seen;
}

test('T7 inputs stream live, calibrated, to the GUI like ESP32 sensors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const seen = collectT7(page);
  await page.goto('/plots/lcs-tcs-rtd');

  for (const ch of [T7.pt, T7.tc, T7.lc]) {
    const key = `${ch.entity}.${ch.component}`;
    await expect.poll(() => seen.get(key)?.length ?? 0, { message: `${key} samples` }).toBeGreaterThanOrEqual(3);
    const recent = (seen.get(key) ?? []).slice(-3);
    expect(recent.every((v) => v >= ch.min && v <= ch.max), `${key} in [${ch.min}, ${ch.max}]: ${recent}`).toBe(true);
  }
  // The raw volts and the µV calibration code arrive too.
  await expect.poll(() => seen.get('T71.AIN1.volts')?.length ?? 0).toBeGreaterThanOrEqual(3);
  await expect.poll(() => seen.get('T71_Cal.AIN1.raw_adc_counts')?.length ?? 0).toBeGreaterThanOrEqual(3);

  // The TC and LC tiles render under their roles, beside the ESP32 boards' channels.
  await expect(page.getByText(T7.tc.role, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(T7.lc.role, { exact: false }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('the Calibration page lists the T7 PT and load cell', async ({ page }) => {
  await page.goto('/calibration');
  await expect(page.getByText(T7.pt.role, { exact: false }).first()).toBeAttached();
  await expect(page.getByText(T7.lc.role, { exact: false }).first()).toBeAttached();
});

test('the config editor shows the T7 and validates its channel table as it is edited', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/config?tab=boards');
  const header = page.getByText('LabJack T7 Board', { exact: false }).first();
  await expect(header).toBeVisible();
  await header.click();

  // The three configured inputs, by role, each with its kind.
  const roleInputs = page.locator('input[placeholder="name, e.g. LOX Tank"]');
  await expect(roleInputs).toHaveCount(3);
  await expect.poll(() => roleInputs.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)))
    .toEqual([T7.pt.role, T7.tc.role, T7.lc.role]);
  // PT and LC take a calibration model like an ESP32 sensor; the default is physics.
  await expect(page.getByTitle('Streaming calibration model for this sensor').first()).toHaveValue('physics');
  // A clean T7 shows no problems.
  await expect(page.getByText('needs a role', { exact: false })).toHaveCount(0);

  // Add a channel: it starts as a PT with no role, so the same rules t7_bridge applies flag it.
  await page.getByRole('button', { name: '+ Add channel' }).click();
  await expect(roleInputs).toHaveCount(4);
  await expect(page.getByText('a PT channel needs a role', { exact: false })).toBeVisible();
  await expect(page.getByText('a PT needs full_scale', { exact: false })).toBeVisible();

  // Make it a load cell: the PT rules give way to the LC ones.
  const kinds = page.locator('tbody select').filter({ has: page.locator('option[value="VOLTAGE"]') });
  await kinds.nth(3).selectOption('LC');
  await expect(page.getByText('an LC needs excitation_v', { exact: false })).toBeVisible();
  await expect(page.getByText('a PT needs full_scale', { exact: false })).toHaveCount(0);

  // Reusing an ESP32 sensor's role is refused on the card, as the session gate refuses it.
  await roleInputs.nth(3).fill('Fuel Upstream');
  await expect(page.getByText('is also a sensor on', { exact: false })).toBeVisible();

  // Remove it again: back to clean, nothing saved.
  await page.locator('tbody').getByRole('button', { name: 'Remove' }).nth(3).click();
  await expect(roleInputs).toHaveCount(3);
  await expect(page.getByText('an LC needs excitation_v', { exact: false })).toHaveCount(0);
  expect(errors).toEqual([]);
});
