import { test, expect } from '@playwright/test';

// Uses the running guitest stack. No API or WebSocket routes are replaced.
test('live environmental readings and plots reach the desktop and mobile GUI', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const samples = new Map<string, Set<number>>();
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    const message = JSON.parse(payload.toString());
    if (message.type !== 'sensor_update') return;
    for (const row of Array.isArray(message.payload) ? message.payload : [message.payload]) {
      if (row.entity !== 'ENV25' || !Number.isFinite(row.value)) continue;
      const timestamps = samples.get(row.component) ?? new Set<number>();
      timestamps.add(row.timestamp);
      samples.set(row.component, timestamps);
    }
  }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/environmental');
  const board = page.getByRole('region', { name: 'Environmental board 25', exact: true });
  await expect(board).toBeVisible();
  const measurements = [
    { label: 'Temperature', component: 'temperature_c', unit: '°C', min: 21.4, max: 23.6 },
    { label: 'Relative humidity', component: 'humidity_rh', unit: '%RH', min: 43.9, max: 46.1 },
    { label: 'Absolute pressure', component: 'pressure_pa', unit: 'Pa', min: 101224, max: 101426 },
  ];
  for (const measurement of measurements) {
    await expect.poll(() => samples.get(measurement.component)?.size ?? 0).toBeGreaterThanOrEqual(3);
    const tile = board.locator('div.rounded-lg').filter({
      has: page.getByRole('heading', { name: measurement.label, exact: true }),
    });
    const readout = tile.locator('p.font-mono');
    await expect(readout).toContainText(measurement.unit);
    await expect.poll(async () => {
      const value = parseFloat(await readout.innerText());
      return Number.isFinite(value) && value >= measurement.min && value <= measurement.max;
    }).toBe(true);
  }
  await expect(board.getByText('Waiting for fresh data')).toHaveCount(0);
  await expect(board.locator('canvas')).toHaveCount(3);
  await expect(page.getByText('Initializing plot...')).toHaveCount(0);
  // Colored trace pixels prove the real cache and plotting code received data.
  await expect.poll(() => board.locator('canvas').evaluateAll(canvases => canvases.every(canvas => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 100 && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) -
        Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 60) return true;
    }
    return false;
  }))).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(board).toBeVisible();
  expect(await board.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
