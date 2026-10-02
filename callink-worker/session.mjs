// CalLink session: log in through CalNet + Duo push, keep the browser profile on disk,
// and report whether the stored session still reaches the CalLink form.
//
//   node session.mjs login   # sign in if needed; waits for you to approve the Duo push
//   node session.mjs check   # no sign-in; appends ok/expired to the session log
//
// Credentials come from $CALLINK_ENV (default ~/.config/star/callink.env):
//   CALNET_USERNAME=...
//   CALNET_PASSWORD=...
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv } from './lib/env.mjs';

const FORM_URL = 'https://callink.berkeley.edu/actionCenter/organization/star/Finance/CreatePurchaseRequest';
const PROFILE = process.env.CALLINK_PROFILE ?? path.join(os.homedir(), '.local/share/star/callink-profile');
const OUT = process.env.CALLINK_OUT ?? path.join(os.homedir(), '.local/share/star/callink-runs');
const DUO_WAIT_MS = 120_000;

const mode = process.argv[2];
if (!['login', 'check'].includes(mode)) {
  console.error('usage: node session.mjs login|check');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${stamp}-${name}.png`), fullPage: true });


const onCallink = page => new URL(page.url()).hostname === 'callink.berkeley.edu';

async function visibleButtons(page) {
  return page.$$eval('button, input[type=submit], a[role=button]', els =>
    els.filter(e => e.offsetParent !== null).map(e => (e.innerText || e.value || '').trim()).filter(Boolean));
}

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('framenavigated', f => { if (f === page.mainFrame()) log('nav', f.url().split('?')[0]); });

let status = 'expired';
try {
  await page.goto(FORM_URL, { waitUntil: 'networkidle' });

  if (!onCallink(page) && mode === 'login') {
    const { CALNET_USERNAME, CALNET_PASSWORD } = readEnv(['CALNET_USERNAME', 'CALNET_PASSWORD']);
    await page.fill('#username', CALNET_USERNAME);
    await page.fill('#password', CALNET_PASSWORD);
    await Promise.all([page.waitForLoadState('networkidle'), page.click('#submitBtn')]);
    await shot(page, 'after-password');
    log('after password at', new URL(page.url()).hostname, 'buttons:', await visibleButtons(page));

    // Duo Universal Prompt: wait for the push approval, clicking through the
    // "trust this browser" question if Duo asks it.
    log(`approve the Duo push on your phone (waiting ${DUO_WAIT_MS / 1000}s)`);
    const deadline = Date.now() + DUO_WAIT_MS;
    while (!onCallink(page) && Date.now() < deadline) {
      const trust = page.getByRole('button', { name: /yes, this is my device|trust browser/i });
      if (await trust.isVisible().catch(() => false)) {
        log('duo asked to trust this browser; answering yes');
        await trust.click();
      }
      await page.waitForTimeout(2000);
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    if (!onCallink(page)) {
      await shot(page, 'stuck');
      log('did not reach CalLink; stuck at', page.url().split('?')[0], 'buttons:', await visibleButtons(page));
    }
  }

  if (onCallink(page)) {
    const token = await page.$('input[name=__RequestVerificationToken]');
    const responses = await page.$$eval('[name^="pageResponse.Responses"]', els => els.length);
    status = token ? 'ok' : 'callink-but-no-form';
    log(`on CalLink form: token=${!!token} responseFields=${responses}`);
    await shot(page, 'form');
  }

  const cookies = (await ctx.cookies()).filter(c => /berkeley|campuslabs|duo/.test(c.domain));
  for (const c of cookies) {
    const exp = c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session';
    log('cookie', c.domain, c.name, 'expires', exp);
  }
} finally {
  fs.appendFileSync(path.join(OUT, 'session.log'), `${new Date().toISOString()} ${mode} ${status}\n`);
  log('status', status);
  await ctx.close();
}
process.exit(status === 'ok' ? 0 : 1);
