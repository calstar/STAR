// Scratch: axe on the hero alone (harness), dark and light, with a hover card open.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const browser = await chromium.launch();
let total = 0;
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:5173/e2e-scratch/hero.html?theme=${theme}&w=1104&t=1.75&match=1`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('svg[aria-label="Feed system schematic"]', { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.locator('rect[aria-label="TK-LOX"]').focus();
  await page.waitForTimeout(200);
  const res = await new AxeBuilder({ page }).include('.lx section').analyze();
  total += res.violations.length;
  for (const v of res.violations) {
    console.log(`[${theme}] ${v.id} (${v.impact}) x${v.nodes.length}: ${v.help}`);
    for (const n of v.nodes.slice(0, 4)) console.log(`    ${n.target.join(' ')} :: ${(n.failureSummary ?? '').split('\n').slice(1, 2).join(' ').slice(0, 160)}`);
  }
  await ctx.close();
}
console.log(total ? `${total} violation groups` : 'no axe violations');
await browser.close();
