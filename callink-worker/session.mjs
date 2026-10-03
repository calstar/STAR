// CalLink session: log in through CalNet + Duo push, keep the browser profile on disk,
// and report whether the stored session still reaches the CalLink form.
//
//   node session.mjs login   # sign in if needed; waits for you to approve the Duo push
//   node session.mjs login --fresh  # sign in again even if signed in (renews the 24 h);
//                                   # keeps the old session if the new sign-in fails
//   node session.mjs check   # no sign-in; appends ok/expired to the session log
//
// Credentials come from $CALLINK_ENV (default ~/.config/star/callink.env):
//   CALNET_USERNAME=...
//   CALNET_PASSWORD=...
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { PROFILE, RUNS as OUT } from './lib/callink.mjs';
import { readEnv } from './lib/env.mjs';

const FORM_URL = 'https://callink.berkeley.edu/actionCenter/organization/star/Finance/CreatePurchaseRequest';
const DUO_WAIT_MS = 120_000;
// Duo's push screen ("Check for a Duo Push"; "Enter code in Duo Mobile" for verified push).
const DUO_PUSH_TEXT = /duo push|enter (this )?code|check your phone|sent to/i;
const DUO_PUSH_ASSUME_MS = 8_000;

const mode = process.argv[2];
const fresh = process.argv.includes('--fresh');
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
const isCallink = c => /(^|\.)callink\.berkeley\.edu$/.test(c.domain);
const previous = fresh && mode === 'login' ? (await ctx.cookies()).filter(isCallink) : [];
try {
  if (previous.length) {
    // Drop only CalLink's own cookies, so it asks CalNet for a new 24 h login.
    log('fresh: setting the current CalLink session aside');
    await ctx.clearCookies({ domain: /callink\.berkeley\.edu$/ });
  }
  await page.goto(FORM_URL, { waitUntil: 'networkidle' });

  if (!onCallink(page) && mode === 'login') {
    const { CALNET_USERNAME, CALNET_PASSWORD } = readEnv(['CALNET_USERNAME', 'CALNET_PASSWORD']);
    await page.fill('#username', CALNET_USERNAME);
    await page.fill('#password', CALNET_PASSWORD);
    await Promise.all([page.waitForLoadState('networkidle'), page.click('#submitBtn')]);
    await shot(page, 'after-password');
    log('after password at', new URL(page.url()).hostname, 'buttons:', await visibleButtons(page));

    // Duo Universal Prompt: wait for the push approval, clicking through the
    // "trust this browser" question if Duo asks it. A browser Duo remembers goes
    // straight through with no push, so only say a push is waiting once Duo shows
    // one, or once we've sat on Duo long enough that it must be waiting for something.
    // (callink-worker relays the "approve the Duo push" line to the /finance banner.)
    const deadline = Date.now() + DUO_WAIT_MS;
    const pushAssumedAt = Date.now() + DUO_PUSH_ASSUME_MS;
    let announced = false;
    let heading = '';
    while (!onCallink(page) && Date.now() < deadline) {
      const trust = page.getByRole('button', { name: /yes, this is my device|trust browser/i });
      if (await trust.isVisible().catch(() => false)) {
        log('duo asked to trust this browser; answering yes');
        await trust.click();
      }
      const now = (await page.locator('h1, h2').first().innerText({ timeout: 500 }).catch(() => '')).trim();
      if (now && now !== heading) log('duo shows:', (heading = now).slice(0, 80));
      if (!announced && (DUO_PUSH_TEXT.test(heading) || Date.now() >= pushAssumedAt)) {
        announced = true;
        log(`approve the Duo push on your phone (waiting ${Math.round((deadline - Date.now()) / 1000)}s)`);
      }
      await page.waitForTimeout(1000);
    }
    if (!announced && onCallink(page)) log('duo remembered this browser; no push needed');
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
  if (previous.length && status !== 'ok') {
    log('fresh sign-in failed; putting the previous session back');
    await ctx.clearCookies({ domain: /callink\.berkeley\.edu$/ }).catch(() => {});
    await ctx.addCookies(previous).catch(e => log('could not restore it:', e.message));
  }
  fs.appendFileSync(path.join(OUT, 'session.log'), `${new Date().toISOString()} ${mode} ${status}\n`);
  log('status', status);
  await ctx.close();
}
process.exit(status === 'ok' ? 0 : 1);
