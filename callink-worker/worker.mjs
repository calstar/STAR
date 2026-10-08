// Files approved STARProject reimbursements on CalLink and keeps STARProject's copy of
// CalLink current. Runs until stopped.
//
//   node worker.mjs            # dry: builds and checks each form, files nothing, hands jobs back
//   node worker.mjs --live     # files them
//   node worker.mjs --once     # one pass (claim at most one job), then exit
//
// Never files anything twice. Before posting it looks for the request's [STAR R-n] tag
// on CalLink; a journal entry written before the final POST means a crash at any point
// is reported honestly on restart ("maybe filed" goes to an admin, not back in the queue).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { starproject } from './lib/api.mjs';
import { accountProbes } from './lib/accounts.mjs';
import { ORG, RUNS, brief, getJson, listAll, log, openSession, sessionAlive, sessionExpiresAt } from './lib/callink.mjs';
import { MaybeFiled, NotFiled, fileRequest } from './lib/file.mjs';
import { findByTag } from './lib/match.mjs';
import { scrapeAll } from './lib/scrape.mjs';
import { validateRequest } from './request.mjs';

const live = process.argv.includes('--live');
const once = process.argv.includes('--once');
const POLL_MS = 60_000;
const EXPIRED_POLL_MS = 5 * 60_000;
const SCRAPE_EVERY_MS = 24 * 3600_000;
const ACCOUNTS_EVERY_MS = 3600_000;
const LOGIN_POLL_MS = 10_000;

// Deployed before it's configured (auto-deploy brings up the whole stack), it waits
// rather than crash-looping under `restart: unless-stopped`.
let api;
for (;;) {
  try {
    api = starproject();
    break;
  } catch (e) {
    log(`not configured, waiting: ${brief(e)}`);
    if (once) process.exit(1);
    await new Promise(res => setTimeout(res, 3600_000));
  }
}
const JOURNAL = path.join(RUNS, 'jobs');
const STATE = path.join(RUNS, 'worker-state.json');
fs.mkdirSync(JOURNAL, { recursive: true });

const sleep = ms => new Promise(res => setTimeout(res, ms));
const state = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {});
const saveState = s => fs.writeFileSync(STATE, JSON.stringify(s));

// ---- the journal: what we know about a filing, on disk before and after the POST ------

const journalPath = id => path.join(JOURNAL, `${id}.json`);
const journal = (id, entry) => fs.writeFileSync(journalPath(id), JSON.stringify({ id, at: new Date().toISOString(), ...entry }));

/** Report a journalled outcome; the entry goes once STARProject has it. */
async function report(id, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      await api.result(id, body);
      fs.rmSync(journalPath(id), { force: true });
      return;
    } catch (e) {
      // 409: STARProject already moved on (e.g. reported before a crash); nothing to send.
      if (e.status === 409 || e.status === 404) {
        log(`job ${id}: ${brief(e)}; dropping the journal entry`);
        fs.rmSync(journalPath(id), { force: true });
        return;
      }
      if (attempt >= 5) throw e;
      log(`job ${id}: report failed (${brief(e)}), retrying`);
      await sleep(5000 * attempt);
    }
  }
}

/** On start: settle anything a previous run left half done. */
async function replayJournal() {
  for (const f of fs.readdirSync(JOURNAL)) {
    const j = JSON.parse(fs.readFileSync(path.join(JOURNAL, f), 'utf8'));
    log(`job ${j.id}: found "${j.state}" from a previous run`);
    if (j.state === 'filed') await report(j.id, { ok: true, callinkId: j.callinkId, callinkRequestNumber: j.requestNumber });
    else if (j.state === 'not-filed') await report(j.id, { ok: false, filed: false, error: j.error });
    else await report(j.id, { ok: false, filed: 'unknown', error: `the worker stopped while filing (${j.state}); check CalLink for ${j.tag}` });
  }
}

// ---- jobs -------------------------------------------------------------------------------

/** An earlier filing's lease ran out. Look for it on CalLink; never file it again. */
async function reconcile(ctx, job) {
  const hits = findByTag(await listAll(ctx, { limit: 100, quiet: true }), job.tag);
  log(`R-${job.number}: reconcile, ${hits.length} on CalLink with ${job.tag}`);
  if (hits.length === 1) await report(job.id, { ok: true, callinkId: hits[0].id, callinkRequestNumber: String(hits[0].requestNumber) });
  else if (hits.length === 0) await report(job.id, { ok: false, filed: false, error: `not on CalLink (searched for ${job.tag}) after the worker stopped mid-filing` });
  else await report(job.id, { ok: false, filed: 'unknown', error: `${hits.length} CalLink requests carry ${job.tag}` });
}

async function file(ctx, claimed) {
  const { job, request, receipts } = claimed;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `callink-R${job.number}-`));
  try {
    // Already there? (A filing STARProject never heard about.) Then it is filed.
    const existing = findByTag(await listAll(ctx, { limit: 100, quiet: true }), job.tag);
    if (existing.length) {
      log(`R-${job.number}: already on CalLink as ${existing.map(r => r.requestNumber).join(', ')}; not filing again`);
      if (existing.length === 1) return report(job.id, { ok: true, callinkId: existing[0].id, callinkRequestNumber: String(existing[0].requestNumber) });
      return report(job.id, { ok: false, filed: 'unknown', error: `${existing.length} CalLink requests already carry ${job.tag}` });
    }

    for (const f of receipts) fs.writeFileSync(path.join(dir, f.fileName), await api.receipt(f.url), { mode: 0o600 });
    let checked;
    try {
      checked = validateRequest(structuredClone(request), dir);
    } catch (e) {
      return report(job.id, { ok: false, filed: false, error: brief(e) });
    }

    if (!live) {
      const { built } = await fileRequest(ctx, checked, { submit: false });
      log(`R-${job.number}: dry run, ${built.pairs.length} fields checked; handing it back`);
      await api.release(job.id);
      return;
    }

    journal(job.id, { state: 'posting', tag: job.tag });
    log(`R-${job.number}: filing "${request.subject}" for $${checked.total.toFixed(2)}`);
    try {
      const { filed } = await fileRequest(ctx, checked, { submit: true });
      journal(job.id, { state: 'filed', tag: job.tag, ...filed });
      log(`R-${job.number}: filed${filed.callinkId ? ` as CalLink ${filed.requestNumber}` : ''}`);
      await report(job.id, { ok: true, callinkId: filed.callinkId, callinkRequestNumber: filed.requestNumber });
    } catch (e) {
      if (e instanceof NotFiled) {
        journal(job.id, { state: 'not-filed', tag: job.tag, error: brief(e) });
        log(`R-${job.number}: not filed: ${brief(e)}`);
        await report(job.id, { ok: false, filed: false, error: brief(e) });
      } else {
        // MaybeFiled, or anything unexpected once the POST may have gone out.
        journal(job.id, { state: 'maybe', tag: job.tag, error: brief(e) });
        log(`R-${job.number}: ${e instanceof MaybeFiled ? 'maybe filed' : 'error while filing'}: ${brief(e)}`);
        await report(job.id, { ok: false, filed: 'unknown', error: brief(e) });
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the admin "Sign in to CalLink" button --------------------------------------------

/** Run `session.mjs login --fresh` (the same sign-in as by hand over SSH) and tell
 * STARProject how it goes. The browser profile is one process's at a time, so the
 * caller closes its session first and reopens it after. */
function signIn() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'session.mjs'), 'login', '--fresh'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let last = '';
    const onLine = line => {
      if (!line.trim()) return;
      console.log(line);
      last = line.replace(/^\S+Z /, '');
      if (/approve the Duo push/.test(line)) api.reportLogin('waiting_duo').catch(e => log('login report failed:', brief(e)));
    };
    for (const stream of [child.stdout, child.stderr]) {
      let buf = '';
      stream.on('data', d => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach(onLine);
      });
    }
    child.on('close', code => resolve(code === 0 ? { ok: true } : { ok: false, note: /stuck at|did not reach/.test(last) ? 'Duo was not approved in time' : last }));
  });
}

async function loginIfAsked() {
  if (!(await api.loginRequested().catch(e => { log('login poll failed:', brief(e)); return false; }))) return false;
  log('an admin asked for a CalLink sign-in');
  await ctx.close();
  const res = await signIn();
  ctx = await openSession();
  log(`sign-in ${res.ok ? 'succeeded' : `failed: ${res.note}`}`);
  await api.reportLogin(res.ok ? 'ok' : 'failed', res.note).catch(e => log('login report failed:', brief(e)));
  return true;
}

// ---- the loop -----------------------------------------------------------------------------

async function scrapeAndPush(ctx) {
  log('nightly scrape');
  const { records, listedIds, failedIds } = await scrapeAll(ctx, { cached: true });
  const out = await api.pushScrape(records, failedIds.length ? null : listedIds);
  log(`pushed scrape: ${JSON.stringify({ ...out, failed: out.failed.length })}`);
  saveState({ ...state(), lastScrapeAt: new Date().toISOString(), accountProbes: accountProbes(records) });
  await refreshAccounts(ctx).catch(e => log('account balances failed:', brief(e)));
}

/** STAR's CalLink balances for the Finance tab: the detail of the newest request on
 * each account the last scrape saw, plus the newest request overall (a few GETs). */
async function refreshAccounts(ctx) {
  const asOf = new Date().toISOString();
  // Stamped first, so a failure waits an hour like a success instead of retrying each poll.
  saveState({ ...state(), lastAccountsAt: asOf });
  const ids = new Set(Object.values(state().accountProbes ?? {}));
  const [newest] = await listAll(ctx, { limit: 1, quiet: true });
  if (newest) ids.add(newest.id);
  const accounts = new Map();
  for (const id of ids) {
    const a = (await getJson(ctx, `/api/finance/${ORG}/requests/purchase/${id}/`)).financeAccount;
    if (a && Number.isInteger(a.id)) accounts.set(a.id, a);
  }
  if (accounts.size) {
    const out = await api.accounts([...accounts.values()], asOf);
    log(`reported ${accounts.size} CalLink account balance${accounts.size > 1 ? 's' : ''} (${out.updated} updated)`);
  }
}

log(`worker starting (${live ? 'LIVE: files on CalLink' : 'dry run'}${once ? ', one pass' : ''})`);
await replayJournal();
let ctx = await openSession();
let stopping = false;
let wake = () => {};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; wake(); log(`${sig}: finishing the current step`); });
const nap = ms => new Promise(res => { const t = setTimeout(res, ms); wake = () => { clearTimeout(t); res(); }; });
// Wait between polls, but stop waiting the moment we're asked to stop, and answer a
// sign-in request within seconds (then go round the loop at once to report it).
async function idle(ms) {
  for (const end = Date.now() + ms; !stopping && Date.now() < end; ) {
    await nap(Math.min(LOGIN_POLL_MS, end - Date.now()));
    if (!stopping && !once && (await loginIfAsked())) return;
  }
}

try {
  while (!stopping) {
    if (!once) await loginIfAsked();
    const alive = await sessionAlive(ctx).catch(() => false);
    const expires = alive ? await sessionExpiresAt(ctx) : null;
    await api.heartbeat({
      session: alive ? 'ok' : 'expired',
      sessionExpiresAt: expires?.toISOString() ?? null,
      lastScrapeAt: state().lastScrapeAt ?? null,
    }).catch(e => log('heartbeat failed:', brief(e)));
    if (!alive) {
      log('CalLink session expired: press "Sign in to CalLink" on /reimbursements (or run `node session.mjs login`) and approve the Duo push');
      if (once) break;
      await idle(EXPIRED_POLL_MS);
      continue;
    }

    const last = state().lastScrapeAt;
    // A state from before account balances has no probes yet: scrape now to find them.
    if (!once && (!last || !state().accountProbes || Date.now() - new Date(last).getTime() > SCRAPE_EVERY_MS)) {
      await scrapeAndPush(ctx).catch(e => {
        log('scrape failed:', brief(e));
        // Not again every poll: the next try is the nightly one.
        if (last) saveState({ ...state(), accountProbes: state().accountProbes ?? {} });
      });
    }
    const lastAccounts = state().lastAccountsAt;
    if (!once && (!lastAccounts || Date.now() - new Date(lastAccounts).getTime() > ACCOUNTS_EVERY_MS)) {
      await refreshAccounts(ctx).catch(e => log('account balances failed:', brief(e)));
    }

    const claimed = await api.claim().catch(e => { log('claim failed:', brief(e)); return null; });
    if (claimed?.kind === 'reconcile') await reconcile(ctx, claimed.job);
    else if (claimed?.kind === 'file') await file(ctx, claimed);
    if (once) break;
    if (!claimed) await idle(POLL_MS);
  }
} catch (e) {
  log('worker error:', brief(e));
  process.exitCode = 1;
} finally {
  await ctx.close();
}
