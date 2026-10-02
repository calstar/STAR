// Read-only scrape of every STAR purchase request on CalLink, using the session that
// `node session.mjs login` stored. Nothing here posts to CalLink.
//
//   node scrape.mjs                 # all requests
//   node scrape.mjs --limit 5       # newest five, for testing
//   node scrape.mjs --receipts      # also download each receipt file
//   node scrape.mjs --cached        # reuse requests already scraped whose status is final
//   node scrape.mjs --only 1,2,3    # just these ids (CSVs still cover everything on disk)
//
// Writes to $CALLINK_DATA (default ~/.local/share/star/callink-data):
//   requests/<id>.json   list row + detail API + parsed print page
//   requests.csv         one row per request
//   items.csv            one row per receipt item
//   receipts/<id>/...    with --receipts
// The output holds payee addresses and emails: keep it on the server.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, brief, log, openSession } from './lib/callink.mjs';
import { scrapeAll } from './lib/scrape.mjs';

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',').map(Number)) : null;

// Members type totals as "505.51", "$505.51" or "1,411.09".
const money = s => {
  const n = parseFloat(String(s ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const csv = rows => rows.map(r => r.map(v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',')).join('\n') + '\n';

const ctx = await openSession();
try {
  const { records, failedIds } = await scrapeAll(ctx, { limit, only, cached: args.includes('--cached'), receipts: args.includes('--receipts') });
  // CSVs from every saved request, so a partial run (--only, --limit) doesn't shrink them.
  const recs = [...records];
  const fresh = new Set(recs.map(r => r.list.id));
  for (const f of fs.readdirSync(path.join(DATA, 'requests'))) {
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
  log(`done: ${records.length} scraped, ${failedIds.length} failed -> ${DATA}`);
  process.exitCode = failedIds.length ? 1 : 0;
} catch (e) {
  log('error:', brief(e));
  process.exitCode = 1;
} finally {
  await ctx.close();
}
