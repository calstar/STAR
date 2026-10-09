// Scratch: the dev gallery at ?lx-gallery=1, both sheets.
import { chromium } from 'playwright';
const OUT = new URL('./shots/', import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/?lx-gallery=1', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}gallery-ui.png` });
await page.getByRole('button', { name: 'Charts and timeline' }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}gallery-charts.png` });
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
