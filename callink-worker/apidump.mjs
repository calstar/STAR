// Read-only: GET CalLink API paths with the stored session, save JSON.
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const PROFILE = path.join(os.homedir(), '.local/share/star/callink-profile');
const OUT = path.join(os.homedir(), '.local/share/star/callink-explore');
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
for (const [name, p] of process.argv.slice(2).map(a => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)])) {
  const r = await ctx.request.get('https://callink.berkeley.edu' + p, { headers: { accept: 'application/json' } });
  const body = await r.text();
  fs.writeFileSync(path.join(OUT, name + '.json'), body);
  console.log(name, r.status(), body.length, 'bytes');
}
await ctx.close();
