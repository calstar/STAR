// Read-only scrape of every STAR purchase request on CalLink, using the session that
// `node session.mjs login` stored. Nothing here posts to CalLink.
//
//   node scrape.mjs                 # all requests
//   node scrape.mjs --limit 5       # newest five, for testing
//   node scrape.mjs --receipts      # also download each receipt file
//   node scrape.mjs --cached        # reuse requests already scraped whose status is final
//
// Writes to $CALLINK_DATA (default ~/.local/share/star/callink-data):
//   requests/<id>.json   list row + detail API + parsed print page
//   requests.csv         one row per request
//   items.csv            one row per receipt item
//   receipts/<id>/...    with --receipts
// The output holds payee addresses and emails: keep it on the server.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'https://callink.berkeley.edu';
const ORG = 'STAR';
const PROFILE = process.env.CALLINK_PROFILE ?? path.join(os.homedir(), '.local/share/star/callink-profile');
const DATA = process.env.CALLINK_DATA ?? path.join(os.homedir(), '.local/share/star/callink-data');
const PAGE_SIZE = 100;
const CONCURRENCY = 3;
// Statuses after which a request no longer changes, so --cached may skip it.
const FINAL = new Set(['Approved', 'Denied', 'Paid', 'Completed', 'Canceled', 'Cancelled']);

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const withReceipts = args.includes('--receipts');
const cached = args.includes('--cached');
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',').map(Number)) : null;
const log = (...a) => console.log(new Date().toISOString(), ...a);
// Playwright appends a call log with the request's Cookie header to its errors: keep line one only.
const brief = e => String(e?.message ?? e).split('\n')[0];

fs.mkdirSync(path.join(DATA, 'requests'), { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
const parser = await ctx.newPage();

// CalLink sometimes stalls a request for 30 s; the same call answers at once when retried.
async function get(url, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.request.get(url, { maxRedirects: 0, ...opts });
    } catch (e) {
      if (attempt === 3 || !/Timeout/.test(e.message)) throw e;
      log(`retrying ${url.replace(BASE, '').split('?')[0]} after: ${brief(e)}`);
      await new Promise(res => setTimeout(res, 2000 * attempt));
    }
  }
}

async function getJson(p) {
  const r = await get(BASE + p, { headers: { accept: 'application/json' } });
  if (r.status() !== 200) throw new Error(`GET ${p} -> ${r.status()} (session expired? run: node session.mjs login)`);
  return r.json();
}

async function listAll() {
  const rows = [];
  for (let skip = 0; rows.length < limit; skip += PAGE_SIZE) {
    const q = new URLSearchParams({
      take: String(PAGE_SIZE), skip: String(skip), status: 'All', searchText: '', categoryId: '0',
      stageId: '0', branchId: '0', processId: '0', orderByField: 'SubmittedOn',
      orderByDirection: 'Descending', showOnlyRecentlyDeleted: 'false',
    });
    const page = await getJson(`/api/finance/${ORG}/requests/purchase/list-items?${q}`);
    rows.push(...page.items);
    log(`listed ${rows.length}/${page.totalItems}`);
    if (page.items.length < PAGE_SIZE || rows.length >= page.totalItems) break;
  }
  return rows.slice(0, limit);
}

// The print page is a run of <strong>question</strong> followed by the answer: a <p>
// with text, <em>No Response</em>, or a getdocument link for an upload.
// The fetches run concurrently; the one parser page is used by one request at a time.
let parserBusy = Promise.resolve();
async function parsePrint(id) {
  const r = await get(`${BASE}/actionCenter/organization/${ORG}/finance/print/${id}`);
  if (r.status() !== 200) throw new Error(`print ${id} -> ${r.status()}`);
  const html = await r.text();
  const turn = parserBusy.then(() => parseHtml(html));
  parserBusy = turn.catch(() => {});
  return turn;
}

async function parseHtml(html) {
  await parser.setContent(html, { waitUntil: 'domcontentloaded' });
  return parser.evaluate(() => {
    const clean = s => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    const out = [];
    for (const q of document.querySelectorAll('strong')) {
      const question = clean(q.innerText);
      if (!question) continue;
      const answers = [];
      for (let el = q.nextElementSibling; el && el.tagName !== 'STRONG'; el = el.nextElementSibling) answers.push(el);
      if (!answers.length) continue;
      const files = answers.flatMap(el => [...el.querySelectorAll('a[href*="getdocument"]')])
        .map(a => ({ name: clean(a.innerText), href: a.getAttribute('href'),
                     documentId: a.getAttribute('href').match(/DocumentId=(\d+)/i)?.[1] ?? null }));
      const text = clean(answers.map(el => el.innerText).join('\n'));
      out.push({ question, answer: text === 'No Response' ? null : text, files });
    }
    return out;
  });
}

// "Item #3: Total of Expense (Include ...)" -> item 3, field "total".
const ITEM_FIELDS = [
  [/date of expense/i, 'date'], [/type of expense/i, 'type'], [/vendor name/i, 'vendor'],
  [/location/i, 'location'], [/invoice number/i, 'invoice'], [/total of expense/i, 'total'],
  [/additional misc/i, 'notes'], [/upload/i, 'receipt'],
];
function itemsFrom(answers) {
  const items = new Map();
  for (const { question, answer, files } of answers) {
    // The form labels later uploads "Upload Item #2 file here", and item 3's date as "Iterm #3".
    const m = question.match(/^It(?:e|er)m #(\d+):\s*(.*)$/i) ?? question.match(/^(?:Upload) Item #(\d+)\b()/i);
    if (!m) continue;
    const field = m[2] ? ITEM_FIELDS.find(([re]) => re.test(m[2]))?.[1] : 'receipt';
    if (!field) continue;
    const item = items.get(m[1]) ?? { item: Number(m[1]) };
    item[field] = field === 'receipt' ? files : answer;
    items.set(m[1], item);
  }
  // An item with no vendor, total and receipt is an unused slot on the form.
  return [...items.values()].filter(i => i.vendor || i.total || i.receipt?.length);
}

async function downloadReceipts(id, items) {
  const dir = path.join(DATA, 'receipts', String(id));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of items.flatMap(i => i.receipt ?? [])) {
    const dest = path.join(dir, `${f.documentId}-${f.name.replace(/[^\w.-]+/g, '_')}`);
    if (fs.existsSync(dest)) continue;
    const r = await get(BASE + f.href);
    if (r.status() !== 200) { log(`receipt ${id}/${f.name} -> ${r.status()}`); continue; }
    fs.writeFileSync(dest, await r.body());
  }
}

async function scrapeOne(row) {
  const file = path.join(DATA, 'requests', `${row.id}.json`);
  if (cached && fs.existsSync(file)) {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (FINAL.has(prev.list.status) && prev.list.status === row.status) return prev;
  }
  const detail = await getJson(`/api/finance/${ORG}/requests/purchase/${row.id}/`);
  const answers = await parsePrint(row.id);
  const rec = { scrapedAt: new Date().toISOString(), list: row, detail, answers, items: itemsFrom(answers) };
  fs.writeFileSync(file, JSON.stringify(rec, null, 1));
  if (withReceipts) await downloadReceipts(row.id, rec.items);
  return rec;
}

// Members type totals as "505.51", "$505.51" or "1,411.09".
const money = s => {
  const n = parseFloat(String(s ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const csv = rows => rows.map(r => r.map(v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',')).join('\n') + '\n';

try {
  const listed = await listAll();
  const rows = only ? listed.filter(r => only.has(r.id)) : listed;
  const recs = [];
  let next = 0, failed = 0;
  const failedIds = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < rows.length) {
      const row = rows[next++];
      try {
        recs.push(await scrapeOne(row));
      } catch (e) {
        failed++;
        log(`request ${row.id} failed: ${brief(e)}`);
        failedIds.push(row.id);
        if (/session expired/.test(e.message)) throw new Error(brief(e));
      }
      if (recs.length % 25 === 0) log(`scraped ${recs.length}/${rows.length}`);
    }
  }));
  const fresh = new Set(recs.map(r => r.list.id));
  if (only) for (const f of fs.readdirSync(path.join(DATA, 'requests'))) {
    const rec = JSON.parse(fs.readFileSync(path.join(DATA, 'requests', f), 'utf8'));
    if (!fresh.has(rec.list.id)) recs.push(rec);
  }
  recs.sort((a, b) => b.list.submittedOn.localeCompare(a.list.submittedOn));

  fs.writeFileSync(path.join(DATA, 'requests.csv'), csv([
    ['id', 'requestNumber', 'subject', 'submittedBy', 'submittedOn', 'status', 'stage', 'category',
     'account', 'submittedAmount', 'approvedAmount', 'itemsTotal', 'items', 'payee'],
    ...recs.map(({ list: l, detail: d, items }) => [
      l.id, l.requestNumber, l.name, l.submittedByName, l.submittedOn, l.status, l.currentStepName,
      d.financeCategory?.name, d.financeAccount?.name, l.submittedAmount, l.approvedAmount,
      items.reduce((s, i) => s + (money(i.total) ?? 0), 0).toFixed(2), items.length,
      [d.payee?.firstName, d.payee?.lastName].filter(Boolean).join(' '),
    ]),
  ]));
  fs.writeFileSync(path.join(DATA, 'items.csv'), csv([
    ['id', 'requestNumber', 'submittedBy', 'item', 'date', 'type', 'vendor', 'location', 'invoice',
     'total', 'amount', 'notes', 'receipts'],
    ...recs.flatMap(({ list: l, items }) => items.map(i => [
      l.id, l.requestNumber, l.submittedByName, i.item, i.date, i.type, i.vendor, i.location,
      i.invoice, i.total, money(i.total), i.notes, (i.receipt ?? []).map(f => f.name).join('; '),
    ])),
  ]));
  fs.writeFileSync(path.join(DATA, 'failed.txt'), failedIds.join('\n') + (failedIds.length ? '\n' : ''));
  log(`done: ${recs.length} requests, ${failed} failed -> ${DATA}`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await ctx.close();
}
