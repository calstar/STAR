// Scratch QA of the run states with the backend's answers stubbed (nothing is started or written):
// running, failed, and the units menu.
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const OUT = new URL('./shots/', import.meta.url).pathname;
const runs = await (await fetch('http://localhost:8000/api/layerx/runs')).json();
const real = runs.filter((r) => (r.kind ?? 'run') === 'run' && r.status === 'done').sort((a, b) => b.started - a.started)[0];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const fake = (id, over) => ({ id, kind: 'run', status: 'running', stage: 'Nozzle erosion, pass 2', progress: 0.46, error: null,
  started: Date.now() / 1000 - 37, finished: null, design: '', settings: { ...real.settings, flight: true, replay: true }, ...over });
await page.route('**/api/layerx/runs/FAKE-RUNNING', (r) => r.fulfill({ json: fake('FAKE-RUNNING') }));
await page.route('**/api/layerx/runs/FAKE-FAILED', (r) => r.fulfill({ json: fake('FAKE-FAILED', { status: 'failed', stage: 'Burning, pass 1',
  error: 'The T-0 state did not settle: the regulator never locked up (dome 513 psig against a 4 psi bottle).\nTraceback (most recent call last):\n  File "engine/layerx/analysis.py", line 812, in settle\n    raise SettleError(...)' }) }));

await page.goto(`${BASE}/?lx=2&run=FAKE-RUNNING`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}state-running.png` });
console.log('running:', await page.getByText('Re-burning with the eroded throat').isVisible());

await page.goto(`${BASE}/?lx=2&run=FAKE-FAILED`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.getByRole('button', { name: 'Details' }).click();
await page.screenshot({ path: `${OUT}state-failed.png` });
console.log('failed:', await page.getByText('The run failed').isVisible());

await page.unrouteAll();
await page.goto(`${BASE}/?lx=2&run=${real.id}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.lx-tl-readout');
await page.getByRole('button', { name: 'Units' }).click();
await page.getByRole('menuitemradio', { name: /Imperial/ }).click();
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}overview-imperial.png` });
await page.keyboard.press('2');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}feed-imperial.png` });
await page.getByRole('button', { name: 'Units' }).click();
await page.getByRole('menuitemradio', { name: /^Stand/ }).click();
await page.keyboard.press('Escape');
await browser.close();
