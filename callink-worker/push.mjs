// Send CalLink's requests to STARProject's Finance tab.
//
//   node push.mjs              # scrape CalLink (reusing settled requests) and push it all,
//                              # including which requests CalLink no longer lists
//   node push.mjs --from-disk  # push the last scrape's files as they are (no CalLink call)
import fs from 'node:fs';
import path from 'node:path';
import { starproject } from './lib/api.mjs';
import { DATA, brief, log, openSession } from './lib/callink.mjs';
import { scrapeAll } from './lib/scrape.mjs';

const api = starproject();
try {
  let records, listedIds = null;
  if (process.argv.includes('--from-disk')) {
    const dir = path.join(DATA, 'requests');
    records = fs.readdirSync(dir).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    log(`read ${records.length} scraped requests from ${dir}`);
  } else {
    const ctx = await openSession();
    try {
      ({ records, listedIds } = await scrapeAll(ctx, { cached: true }));
    } finally {
      await ctx.close();
    }
  }
  const out = await api.pushScrape(records, listedIds);
  log(`pushed: ${JSON.stringify(out)}`);
  process.exitCode = out.failed.length ? 1 : 0;
} catch (e) {
  log('error:', brief(e));
  process.exitCode = 1;
}
