import { test, expect } from '@playwright/test';

test('environmental readouts, plots, and stale state on desktop and mobile', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', (route) => route.fulfill({
    json: { config: { boards: {} }, sensors: [], pressure_bars: [], tabs: ['environmental'], groups: {} },
  }));
  let sendData = true;
  const timers: ReturnType<typeof setInterval>[] = [];
  await page.routeWebSocket('**', (socket) => {
    const tick = () => {
      const timestamp = Date.now();
      socket.send(JSON.stringify({ type: 'connection_status', timestamp,
        payload: { connected: true, elodinConnected: true, simulated: true } }));
      socket.send(JSON.stringify({ type: 'board_status_update', timestamp, payload: { boards: [
        { id: 25, type: 'ENVIRONMENTAL', boardNumber: 25, ip: '192.168.2.25', expected: true, connected: true },
      ] } }));
      if (!sendData) return;
      for (const [component, value] of Object.entries({ temperature_c: 22.5, pressure_pa: 101325, humidity_rh: 45.25 })) {
        socket.send(JSON.stringify({ type: 'sensor_update', timestamp,
          payload: { entity: 'ENV25', component, value, timestamp } }));
      }
    };
    const timer = setInterval(tick, 200);
    timers.push(timer);
    socket.onClose(() => clearInterval(timer));
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/environmental');
    const board = page.getByRole('region', { name: 'Environmental board 25' });
    await expect(board.getByText('22.5', { exact: false }).first()).toBeVisible();
    await expect(board.getByText('101325', { exact: false }).first()).toBeVisible();
    await expect(board.getByText('45.3', { exact: false }).first()).toBeVisible();
    await expect(board.locator('canvas')).toHaveCount(3);
    await expect(page.getByText('Initializing plot...')).toHaveCount(0);
    // Trace pixels prove the real cache and plotting code received each stream.
    await expect.poll(() => board.locator('canvas').evaluateAll((canvases) => canvases.every((canvas) => {
      const element = canvas as HTMLCanvasElement;
      const ctx = element.getContext('2d');
      if (!ctx) return false;
      const pixels = ctx.getImageData(0, 0, element.width, element.height).data;
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        if (pixels[i + 3] > 100 && Math.max(r, g, b) - Math.min(r, g, b) > 60) return true;
      }
      return false;
    }))).toBe(true);
    if (process.env.E2E_SCREENSHOT_PATH) {
      await page.screenshot({ path: process.env.E2E_SCREENSHOT_PATH, fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await board.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    sendData = false;
    await expect(board.getByText('Waiting for fresh data')).toHaveCount(3);
    expect(errors).toEqual([]);
  } finally {
    timers.forEach(clearInterval);
  }
});
