// Scratch interaction QA for the rebuilt Layer X shell: margin-bar jump, keyboard, rail collapse,
// compare, tools, empty state. Prints what it checks; screenshots into shots/.
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const OUT = new URL('./shots/', import.meta.url).pathname;
const runs = await (await fetch('http://localhost:8000/api/layerx/runs')).json();
const done = runs.filter((r) => (r.kind ?? 'run') === 'run' && r.status === 'done').sort((a, b) => b.started - a.started);
const [run, other] = [done[0].id, done[1].id];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
const readout = () => page.locator('.lx-tl-readout').textContent();
const check = (name, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);

// 1. Open the run; click the "Tank pressure sag" bar: the cursor goes to its worst moment.
await page.goto(`${BASE}/?lx=2&run=${run}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.lx-tl-readout');
await page.waitForTimeout(800);
const before = await readout();
const bar = page.getByRole('button', { name: /Tank pressure sag/ });
await bar.click();
await page.waitForTimeout(300);
const after = await readout();
check('margin bar jumps the cursor', before !== after && /T\+0\.40/.test(after ?? ''), `${before} -> ${after}`);
await page.waitForTimeout(400);
check('URL carries the cursor', /[?&]t=0\.4\b/.test(page.url()), page.url());

// 2. Keyboard: 2 opens Feed, Enter on a bar jumps, \ collapses the rail, ? opens the sheet.
await page.locator('body').click({ position: { x: 900, y: 600 } }).catch(() => {});
await page.keyboard.press('Escape');
await page.mouse.click(1300, 270);
await page.keyboard.press('2');
await page.waitForTimeout(400);
check('2 opens Feed', (await page.getByRole('tab', { name: /Feed/ }).getAttribute('aria-selected')) === 'true');
check('URL carries the page', /page=feed/.test(page.url()), page.url());
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(100);
await page.keyboard.press(']');
await page.waitForTimeout(150);
check('] steps to the next event', /T\+/.test((await readout()) ?? ''), await readout());
await page.keyboard.press('\\');
await page.waitForTimeout(200);
check('\\ collapses the rail', await page.getByRole('button', { name: 'Expand the setup rail' }).isVisible());
await page.screenshot({ path: `${OUT}rail-collapsed.png` });
await page.keyboard.press('\\');
await page.keyboard.press('?');
await page.waitForTimeout(200);
check('? opens the shortcut sheet', await page.getByRole('dialog', { name: 'Keyboard' }).isVisible());
await page.screenshot({ path: `${OUT}sheet.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
check('Escape closes it', !(await page.getByRole('dialog').count()));

// 3. Compare: C draws the other run in grey and adds delta chips on Overview.
await page.keyboard.press('1');
await page.keyboard.press('c');
await page.waitForTimeout(1500);
check('C compares', /vs=/.test(page.url()), page.url());
await page.screenshot({ path: `${OUT}overview-compare.png` });
await page.keyboard.press('2');
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}feed-compare.png` });

// 4. Tools.
await page.getByRole('radio', { name: 'Injector' }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}tool-injector.png` });
await page.getByRole('radio', { name: 'Optimize' }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}tool-optimize.png` });
await page.getByRole('radio', { name: 'Burn' }).click();

// 5. Light theme.
await page.getByRole('button', { name: /Switch to the light theme/ }).click();
await page.keyboard.press('1');
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}overview-light.png` });
await page.keyboard.press('3');
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}engine-light.png` });
await page.getByRole('button', { name: /Switch to the dark theme/ }).click();

// 6. Empty state: a fresh browser with no run open.
const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const p2 = await ctx2.newPage();
p2.on('pageerror', (e) => errors.push(`pageerror(empty): ${e.message}`));
await p2.goto(`${BASE}/?lx=2`, { waitUntil: 'networkidle' });
await p2.waitForTimeout(2000);
await p2.screenshot({ path: `${OUT}empty.png` });
check('guided start shows', await p2.getByText('Set up a burn').isVisible());
await p2.getByRole('button', { name: /Set tank pressure and bottle fill/ }).click();
await p2.waitForTimeout(400);
const focused = await p2.evaluate(() => document.activeElement?.closest('[data-lx-step]')?.getAttribute('data-lx-step'));
check('a step lights and focuses its rail control', focused === 'before', String(focused));
await p2.screenshot({ path: `${OUT}empty-step2.png` });

// 7. The old GUI still mounts without lx=2.
const p3 = await ctx2.newPage();
await p3.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p3.waitForTimeout(800);
check('old GUI without lx=2', !(await p3.locator('.lx').count()));

console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
