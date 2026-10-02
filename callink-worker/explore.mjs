// Read-only exploration: open a CalLink URL with the stored session, dump links and network JSON.
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const PROFILE = path.join(os.homedir(), '.local/share/star/callink-profile');
const OUT = path.join(os.homedir(), '.local/share/star/callink-explore');
const url = process.argv[2];
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
const page = ctx.pages()[0] ?? await ctx.newPage();
const api = [];
page.on('response', async r => {
  const ct = r.headers()['content-type'] || '';
  if (r.request().resourceType() === 'xhr' || r.request().resourceType() === 'fetch' || ct.includes('json'))
    api.push(`${r.request().method()} ${r.status()} ${r.url()} [${ct.split(';')[0]}]`);
});
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const name = (process.argv[3] || 'page');
fs.writeFileSync(path.join(OUT, name + '.html'), await page.content());
await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
console.log('FINAL', page.url());
console.log('TITLE', await page.title());
const links = await page.$$eval('a[href]', as => [...new Set(as.map(a => `${a.innerText.trim().replace(/\s+/g,' ').slice(0,50)} -> ${a.getAttribute('href')}`))]);
console.log('LINKS\n' + links.filter(l => /finance|purchase|request|budget|funding/i.test(l)).join('\n'));
console.log('API\n' + api.join('\n'));
await ctx.close();
