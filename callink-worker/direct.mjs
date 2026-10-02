// File one CalLink purchase request (reimbursement) with plain HTTP: fetch the form, upload
// each receipt, post the form. No page is rendered; the browser profile only supplies the
// session cookies that `node session.mjs login` stored.
//
//   node direct.mjs request.json                    # build and check the POST; do NOT send it
//   node direct.mjs request.json --compare FILE     # ...and diff it against a body that
//                                                   #    `submit.mjs --capture FILE` recorded
//   node direct.mjs request.json --submit           # send it
//
// The form is filled the way a browser would submit it: its own HTML, defaults and all,
// with our answers set, serialised in document order.
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACCOUNT_ID, ACCOUNT_NAME, CATEGORY, CATEGORY_ID, EXPENDITURE, FORM_URL, DIRECT_DEPOSIT, Q, loadRequest } from './request.mjs';

const BASE = 'https://callink.berkeley.edu';
const PROFILE = process.env.CALLINK_PROFILE ?? path.join(os.homedir(), '.local/share/star/callink-profile');

const [specPath, ...flags] = process.argv.slice(2);
const doSubmit = flags.includes('--submit');
const compareWith = flags.includes('--compare') ? flags[flags.indexOf('--compare') + 1] : null;
if (!specPath) {
  console.error('usage: node direct.mjs request.json [--compare FILE | --submit]');
  process.exit(2);
}
const log = (...a) => console.log(new Date().toISOString(), ...a);
const brief = e => String(e?.message ?? e).split('\n')[0];
const clean = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

let spec, items, total;
try {
  ({ spec, items, total } = loadRequest(specPath));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

// ---- the form as a DOM we can set values on ----------------------------------------------
function formEditor(html) {
  const $ = cheerio.load(html);
  const form = $('#finance_form');
  if (!form.length) throw new Error('no #finance_form on the page (signed out? run: node session.mjs login)');

  // The .form-group whose label matches. Fails unless exactly one does.
  const group = re => {
    const hits = form.find('.form-group').filter((_, g) => re.test(clean($(g).find('.label-set, label').first().text())));
    if (hits.length !== 1) throw new Error(`expected one question matching ${re}, found ${hits.length}`);
    return hits;
  };
  const setText = (re, value) => {
    if (value == null || value === '') return;
    const el = group(re).find('input[type=text], textarea').first();
    if (el.is('textarea')) el.text(String(value));
    else el.attr('value', String(value));
  };
  const selectIn = (sel, optionRe, what) => {
    const opts = sel.find('option').filter((_, o) => optionRe.test(clean($(o).text())));
    if (opts.length !== 1) throw new Error(`${what}: expected one option matching ${optionRe}, found ${opts.length}`);
    sel.find('option').removeAttr('selected');
    opts.attr('selected', 'selected');
  };
  const choose = (re, optionRe) => selectIn(group(re).find('select').first(), optionRe, re);
  const byName = name => {
    const el = form.find(`[name="${name}"]`);
    if (el.length !== 1) throw new Error(`expected one field named ${name}, found ${el.length}`);
    return el;
  };
  return { $, form, group, setText, choose, selectIn, byName };
}

// jQuery's serializeArray is the browser's successful-controls rule: no unchecked
// radios/checkboxes, no buttons or file inputs, a select sends its selected option.
const serialize = f => f.form.serializeArray().map(({ name, value }) => [name, value]);

// ---- receipts ---------------------------------------------------------------------------
// What the page's Upload File button does: fetch the dialog, then post the file to the
// dialog form's own action.
async function upload(request, dialogUrl, token, file) {
  const d = await request.get(`${dialogUrl}?_=${Date.now()}`, { headers: { referer: FORM_URL, 'x-requested-with': 'XMLHttpRequest' }, maxRedirects: 0 });
  const action = cheerio.load(await d.text())('form').attr('action');
  if (d.status() !== 200 || !action) throw new Error(`upload dialog -> ${d.status()}`);
  const r = await request.post(new URL(action, BASE).href, {
    headers: { referer: FORM_URL, origin: BASE },
    // The page's script adds the form's anti-forgery token; without it CalLink errors out.
    multipart: {
      PostedFile: { name: path.basename(file), mimeType: mimeOf(file), buffer: fs.readFileSync(file) },
      __RequestVerificationToken: token,
    },
    maxRedirects: 0,
  });
  const body = await r.text();
  // <div class="validResponse">{uuid}.pdf</div><div class="fileName">{original}</div>
  const $ = cheerio.load(body);
  const unique = clean($('.validResponse').text());
  const original = clean($('.fileName').text());
  if (r.status() !== 200 || !unique) throw new Error(`upload of ${path.basename(file)} refused (${r.status()}${r.headers().location ? " -> " + r.headers().location : ""}): ${clean($.text()).slice(0, 200)}`);
  return { unique, original };
}
const mimeOf = f => ({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' })[path.extname(f).toLowerCase()] ?? 'application/octet-stream';

// ---- run --------------------------------------------------------------------------------
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
let exitCode = 1;
try {
  const page = await ctx.request.get(FORM_URL, { maxRedirects: 0 });
  if (page.status() !== 200) throw new Error(`form -> ${page.status()} (signed out? run: node session.mjs login)`);
  const f = formEditor(await page.text());

  f.byName('Subject').attr('value', spec.subject);
  f.byName('Description').text(spec.description ?? '');
  f.byName('RequestedAmount').attr('value', total.toFixed(2));
  f.selectIn(f.byName('CategoryId'), new RegExp(`^${CATEGORY}$`), 'CategoryId');
  f.byName('AccountId').attr('value', ACCOUNT_ID);
  const p = spec.payee;
  for (const [name, v] of [['PayeeFirstName', p.firstName], ['PayeeLastName', p.lastName], ['PayeeStreet', p.street],
    ['PayeeStreet2', p.street2 ?? ''], ['PayeeCity', p.city], ['PayeeState', p.state], ['PayeeZipCode', p.zip]]) {
    f.byName(name).attr('value', v);
  }

  const q1 = f.group(Q.ucMember);
  const radios = q1.find('input[type=radio]');
  if (radios.length !== 2 || !/^YES/.test(clean(radios.eq(0).closest('label').text()))) {
    throw new Error('question 1 no longer reads YES / No; check the form before submitting');
  }
  // Always YES (a UC Berkeley student or staff member), with the UID in its write-in box.
  radios.eq(0).attr('checked', 'checked');
  q1.find('input[type=text]').first().attr('value', String(spec.uid));
  f.group(Q.certify).find('input[type=checkbox]').attr('checked', 'checked');
  f.setText(Q.email, spec.email);
  f.setText(Q.phone, spec.phone);
  f.choose(Q.expenditure, EXPENDITURE[spec.expenditureAction]);
  f.setText(Q.special, spec.specialInstructions);
  if (spec.expenditureAction === 'Direct Deposit') f.choose(Q.directDeposit, spec.directDepositSignedUp ? DIRECT_DEPOSIT.done : DIRECT_DEPOSIT.pending);
  f.setText(Q.event, spec.eventDetails);

  for (const [i, it] of items.entries()) {
    const n = i + 1;
    f.setText(Q.item(n, 'Date of Expense'), it.date);
    f.choose(Q.item(n, 'Type of Expense'), new RegExp(`^${it.type}$`, 'i'));
    f.setText(Q.item(n, 'Vendor name'), it.vendor);
    f.setText(Q.item(n, 'Location'), it.location);
    f.setText(Q.item(n, 'Invoice Number'), it.invoice);
    f.setText(Q.item(n, 'Total of Expense'), Number(it.total).toFixed(2));
    f.setText(Q.item(n, 'Additional Misc'), it.notes);
    const block = f.group(Q.upload(n));
    const dialogUrl = block.find('input[name=uploadDialogUrl]').attr('value');
    const { unique, original } = await upload(ctx.request, new URL(dialogUrl, BASE).href, f.byName('__RequestVerificationToken').attr('value'), it.path);
    block.find('input[name$=".TemporaryFileName"]').attr('value', original);
    block.find('input[name$=".TemporaryUniqueFileName"]').attr('value', unique);
    log(`item ${n}: uploaded ${original} as ${unique}`);
  }

  const pairs = serialize(f);
  const get = name => pairs.filter(([k]) => k === name).map(([, v]) => v);
  const checks = [
    ['AccountId', get('AccountId').join(), ACCOUNT_ID],
    ['CategoryId', get('CategoryId').join(), CATEGORY_ID],
    ['category shown', f.byName('CategoryId').find('option[selected]').text().trim(), CATEGORY],
    ['RequestedAmount', get('RequestedAmount').join(), total.toFixed(2)],
    ['Subject', get('Subject').join(), spec.subject],
    ['uploads', pairs.filter(([k, v]) => k.endsWith('.TemporaryUniqueFileName') && v).length, items.length],
    ['token', get('__RequestVerificationToken').filter(Boolean).length, 1],
  ];
  let ok = true;
  for (const [what, got, want] of checks) {
    const pass = String(got) === String(want);
    ok &&= pass;
    log(`${pass ? 'ok  ' : 'FAIL'} ${what}: ${got}${pass ? '' : ` (want ${want})`}`);
  }
  if (!ok) throw new Error('form check failed; not submitting');

  if (compareWith) {
    // Same fields, same order, same values, except what is fresh per page load or upload.
    const theirs = [...new URLSearchParams(fs.readFileSync(compareWith, 'utf8'))];
    const volatile = k => k === '__RequestVerificationToken' || k.endsWith('.TemporaryUniqueFileName');
    const diffs = [];
    for (let i = 0; i < Math.max(pairs.length, theirs.length); i++) {
      const [ka, va] = pairs[i] ?? ['<none>', ''];
      const [kb, vb] = theirs[i] ?? ['<none>', ''];
      if (ka !== kb || (!volatile(ka) && va !== vb)) diffs.push(`#${i}: ours ${ka}=${JSON.stringify(va)}  browser ${kb}=${JSON.stringify(vb)}`);
    }
    log(`compare: ${pairs.length} fields ours, ${theirs.length} browser, ${diffs.length} differences`);
    for (const d of diffs.slice(0, 40)) console.log('  ' + d);
    exitCode = diffs.length ? 1 : 0;
  } else if (!doSubmit) {
    log(`dry run: ${pairs.length} fields built and checked, not sent. Re-run with --submit.`);
    exitCode = 0;
  } else {
    log(`submitting "${spec.subject}" for $${total.toFixed(2)} to ${ACCOUNT_NAME}`);
    const r = await ctx.request.post(new URL(f.form.attr('action'), BASE).href, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      data: new URLSearchParams(pairs).toString(),
      maxRedirects: 0,
    });
    // Success is a redirect to the request list; a 200 is the form back with its errors.
    const where = r.headers()['location'] ?? '';
    if (r.status() >= 300 && r.status() < 400 && /requests\/purchase|finance/i.test(where)) {
      log(`submitted; CalLink redirected to ${where}`);
      exitCode = 0;
    } else {
      const $ = cheerio.load(await r.text());
      const errors = $('.field-validation-error, .validation-summary-errors li, .alert-danger').map((_, e) => clean($(e).text())).get().filter(Boolean);
      throw new Error(`CalLink did not accept it (${r.status()}${where ? ' -> ' + where : ''}): ${errors.join('; ') || 'no error text'}`);
    }
  }
} catch (e) {
  log('error:', brief(e));
} finally {
  await ctx.close();
}
process.exit(exitCode);
