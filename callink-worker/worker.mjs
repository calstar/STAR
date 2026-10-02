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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { starproject } from './lib/api.mjs';
import { RUNS, brief, listAll, log, openSession, sessionAlive } from './lib/callink.mjs';
import { MaybeFiled, NotFiled, fileRequest } from './lib/file.mjs';
import { findByTag } from './lib/match.mjs';
import { scrapeAll } from './lib/scrape.mjs';
import { validateRequest } from './request.mjs';

const live = process.argv.includes('--live');
const once = process.argv.includes('--once');
const POLL_MS = 60_000;
const EXPIRED_POLL_MS = 5 * 60_000;
const SCRAPE_EVERY_MS = 24 * 3600_000;

const api = starproject();
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

// ---- the loop -----------------------------------------------------------------------------

async function scrapeAndPush(ctx) {
  log('nightly scrape');
  const { records, listedIds, failedIds } = await scrapeAll(ctx, { cached: true });
  const out = await api.pushScrape(records, failedIds.length ? null : listedIds);
  log(`pushed scrape: ${JSON.stringify({ ...out, failed: out.failed.length })}`);
  saveState({ ...state(), lastScrapeAt: new Date().toISOString() });
}

log(`worker starting (${live ? 'LIVE: files on CalLink' : 'dry run'}${once ? ', one pass' : ''})`);
await replayJournal();
const ctx = await openSession();
let stopping = false;
let wake = () => {};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; wake(); log(`${sig}: finishing the current step`); });
// Wait between polls, but stop waiting the moment we're asked to stop.
const idle = ms => new Promise(res => { const t = setTimeout(res, ms); wake = () => { clearTimeout(t); res(); }; });

try {
  while (!stopping) {
    const alive = await sessionAlive(ctx).catch(() => false);
    await api.heartbeat({ session: alive ? 'ok' : 'expired', lastScrapeAt: state().lastScrapeAt ?? null }).catch(e => log('heartbeat failed:', brief(e)));
    if (!alive) {
      log('CalLink session expired: run `node session.mjs login` and approve the Duo push');
      if (once) break;
      await idle(EXPIRED_POLL_MS);
      continue;
    }

    const last = state().lastScrapeAt;
    if (!once && (!last || Date.now() - new Date(last).getTime() > SCRAPE_EVERY_MS)) {
      await scrapeAndPush(ctx).catch(e => log('scrape failed:', brief(e)));
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
