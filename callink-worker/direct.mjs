// File one CalLink purchase request (reimbursement) with plain HTTP, from a request file.
// No page is rendered; the browser profile only supplies the session's cookies.
//
//   node direct.mjs request.json                    # build and check the POST; do NOT send it
//   node direct.mjs request.json --compare FILE     # ...and diff it against a body that
//                                                   #    `submit.mjs --capture FILE` recorded
//   node direct.mjs request.json --submit           # send it
import fs from 'node:fs';
import { brief, log, openSession } from './lib/callink.mjs';
import { MaybeFiled, fileRequest } from './lib/file.mjs';
import { ACCOUNT_NAME, loadRequest } from './request.mjs';

const [specPath, ...flags] = process.argv.slice(2);
const submit = flags.includes('--submit');
const compareWith = flags.includes('--compare') ? flags[flags.indexOf('--compare') + 1] : null;
if (!specPath) {
  console.error('usage: node direct.mjs request.json [--compare FILE | --submit]');
  process.exit(2);
}

let request;
try {
  request = loadRequest(specPath);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

const ctx = await openSession();
let exitCode = 1;
try {
  if (submit) log(`submitting "${request.spec.subject}" for $${request.total.toFixed(2)} to ${ACCOUNT_NAME}`);
  const { built, filed } = await fileRequest(ctx, request, {
    submit,
    onUpload: (n, original, unique) => log(`item ${n}: uploaded ${original} as ${unique}`),
  });
  for (const c of built.checks) log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.what}: ${c.got}${c.ok ? '' : ` (want ${c.want})`}`);

  if (compareWith) {
    // Same fields, same order, same values, except what is fresh per page load or upload.
    const theirs = [...new URLSearchParams(fs.readFileSync(compareWith, 'utf8'))];
    const volatile = k => k === '__RequestVerificationToken' || k.endsWith('.TemporaryUniqueFileName');
    const diffs = [];
    for (let i = 0; i < Math.max(built.pairs.length, theirs.length); i++) {
      const [ka, va] = built.pairs[i] ?? ['<none>', ''];
      const [kb, vb] = theirs[i] ?? ['<none>', ''];
      if (ka !== kb || (!volatile(ka) && va !== vb)) diffs.push(`#${i}: ours ${ka}=${JSON.stringify(va)}  browser ${kb}=${JSON.stringify(vb)}`);
    }
    log(`compare: ${built.pairs.length} fields ours, ${theirs.length} browser, ${diffs.length} differences`);
    for (const d of diffs.slice(0, 40)) console.log('  ' + d);
    exitCode = diffs.length ? 1 : 0;
  } else if (!submit) {
    log(`dry run: ${built.pairs.length} fields built and checked, not sent. Re-run with --submit.`);
    exitCode = 0;
  } else {
    log(filed.callinkId
      ? `submitted: CalLink request ${filed.requestNumber} (id ${filed.callinkId})`
      : 'submitted; could not single it out on the list (the next scrape links it)');
    exitCode = 0;
  }
} catch (e) {
  log(e instanceof MaybeFiled ? 'MAYBE FILED, check CalLink before retrying:' : 'error:', brief(e));
} finally {
  await ctx.close();
}
process.exit(exitCode);
