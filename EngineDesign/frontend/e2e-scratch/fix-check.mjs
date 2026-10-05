import { chromium } from 'playwright';
const OUT = '/private/tmp/claude-501/-Users-carlton-Downloads-STAR-ASF-STAR-EngineDesign/6e249fb6-61aa-428c-b921-67469511876f/scratchpad/fix/';
const RUN = '20261003-150223-c3608e';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
async function open(p, t) {
  await page.goto(`http://localhost:5173/?run=${RUN}&page=${p}&t=${t}`, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Layer X', exact: true }).click();
  await page.waitForTimeout(4000);
}
await open('overview', 3.43);
const txt = await page.innerText('main');
const fig = txt.match(/Bottle at burnout\n[^\n]+/)?.[0];
const bar = txt.match(/Bottle over lockup at burnout[^\n]*\n?[^\n]*/)?.[0];
const svg = await page.$$eval('svg text', (els) => els.map((e) => e.textContent).filter((s) => /psig/.test(s)));
console.log('figure:', fig, '| bar:', bar, '| schematic psig:', svg.join(', '));
console.log('banner:', (txt.match(/The rail differs[^\n]*|The design changed[^\n]*/) ?? ['none'])[0]);
await page.screenshot({ path: OUT + 'overview.png' });
await open('feed', 3.43);
const ftxt = await page.innerText('main');
console.log('ladder bottle rows:', (ftxt.match(/Bottle\n[^\n]+/g) ?? []).join(' | '), '| bottle chart:', ftxt.match(/Bottle [\d,]+/)?.[0]);
await open('engine', 1.7);
await page.screenshot({ path: OUT + 'engine.png', fullPage: true });
await open('hardware', 1.7);
const sec = await page.$('svg[aria-label*="ngine"]');
if (sec) { const b = await sec.boundingBox(); await page.mouse.move(b.x + b.width * 0.85, b.y + b.height * 0.4); await page.waitForTimeout(500); }
const tip = await page.$('[role=tooltip]');
if (tip) {
  const r = await tip.evaluate((e) => { const b = e.getBoundingClientRect(); return { w: b.width, right: b.right, sw: e.scrollWidth, cw: e.clientWidth, vw: innerWidth }; });
  console.log('tooltip:', JSON.stringify(r));
}
await page.screenshot({ path: OUT + 'hardware-hover.png' });
console.log('errors:', errs.join('; ') || 'none');
await browser.close();
