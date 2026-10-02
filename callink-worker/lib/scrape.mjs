// Read-only scrape of STAR's purchase requests: CalLink's list and detail JSON, plus
// the print page, which carries every answer with the "additional questions" expanded.
import fs from 'node:fs';
import path from 'node:path';
import { BASE, DATA, ORG, SessionExpired, brief, get, getJson, listAll, log } from './callink.mjs';

const CONCURRENCY = 3;
// Statuses after which a request no longer changes, so `cached` may skip it.
const FINAL = new Set(['Approved', 'Denied', 'Paid', 'Completed', 'Canceled', 'Cancelled']);

// "Item #3: Total of Expense (Include ...)" -> item 3, field "total".
const ITEM_FIELDS = [
  [/date of expense/i, 'date'], [/type of expense/i, 'type'], [/vendor name/i, 'vendor'],
  [/location/i, 'location'], [/invoice number/i, 'invoice'], [/total of expense/i, 'total'],
  [/additional misc/i, 'notes'], [/upload/i, 'receipt'],
];

export function itemsFrom(answers) {
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

/** Scrapes one request at a time per call, sharing one hidden page to parse print pages. */
export async function createScraper(ctx) {
  const parser = await ctx.newPage();
  // Fetches run concurrently; the one parser page is used by one request at a time.
  let parserBusy = Promise.resolve();

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

  async function parsePrint(id) {
    const r = await get(ctx, `/actionCenter/organization/${ORG}/finance/print/${id}`);
    if (r.status() >= 300 && r.status() < 400) throw new SessionExpired(`print ${id}`);
    if (r.status() !== 200) throw new Error(`print ${id} -> ${r.status()}`);
    const html = await r.text();
    const turn = parserBusy.then(() => parseHtml(html));
    parserBusy = turn.catch(() => {});
    return turn;
  }

  async function downloadReceipts(id, items) {
    const dir = path.join(DATA, 'receipts', String(id));
    fs.mkdirSync(dir, { recursive: true });
    for (const f of items.flatMap(i => i.receipt ?? [])) {
      const dest = path.join(dir, `${f.documentId}-${f.name.replace(/[^\w.-]+/g, '_')}`);
      if (fs.existsSync(dest)) continue;
      const r = await get(ctx, BASE + f.href);
      if (r.status() !== 200) { log(`receipt ${id}/${f.name} -> ${r.status()}`); continue; }
      fs.writeFileSync(dest, await r.body());
    }
  }

  /** One request's full record; written to DATA/requests/<id>.json. */
  async function scrapeOne(row, { cached = false, receipts = false } = {}) {
    const file = path.join(DATA, 'requests', `${row.id}.json`);
    if (cached && fs.existsSync(file)) {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (FINAL.has(prev.list.status) && prev.list.status === row.status) return prev;
    }
    const detail = await getJson(ctx, `/api/finance/${ORG}/requests/purchase/${row.id}/`);
    const answers = await parsePrint(row.id);
    const rec = { scrapedAt: new Date().toISOString(), list: row, detail, answers, items: itemsFrom(answers) };
    fs.writeFileSync(file, JSON.stringify(rec, null, 1), { mode: 0o600 });
    if (receipts) await downloadReceipts(row.id, rec.items);
    return rec;
  }

  return { scrapeOne, close: () => parser.close() };
}

/**
 * Scrape every request CalLink lists (or `only` those ids, or the newest `limit`).
 * Returns the records, the ids CalLink listed (deleted requests are not listed), and
 * the ids that failed. A dead session stops the whole run.
 */
export async function scrapeAll(ctx, { limit = Infinity, only = null, cached = false, receipts = false } = {}) {
  fs.mkdirSync(path.join(DATA, 'requests'), { recursive: true });
  const listed = await listAll(ctx, { limit });
  const rows = only ? listed.filter(r => only.has(r.id)) : listed;
  const scraper = await createScraper(ctx);
  const records = [];
  const failedIds = [];
  let next = 0;
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (next < rows.length) {
        const row = rows[next++];
        try {
          records.push(await scraper.scrapeOne(row, { cached, receipts }));
        } catch (e) {
          if (e instanceof SessionExpired) throw e;
          log(`request ${row.id} failed: ${brief(e)}`);
          failedIds.push(row.id);
        }
        if (records.length % 100 === 0) log(`scraped ${records.length}/${rows.length}`);
      }
    }));
  } finally {
    await scraper.close();
  }
  records.sort((a, b) => b.list.submittedOn.localeCompare(a.list.submittedOn));
  return { records, listedIds: limit === Infinity && !only ? listed.map(r => r.id) : null, failedIds };
}
