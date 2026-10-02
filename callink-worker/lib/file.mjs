// File one purchase request (reimbursement) on CalLink with plain HTTP: fetch the form,
// upload each receipt, post the form. The form is filled the way a browser would
// submit it: CalLink's own HTML, defaults and all, with our answers set, serialised in
// document order. (docs/finance/callink-reimbursement.md has how this was proven.)
//
// What can go wrong is split by whether CalLink may have the request:
//   NotFiled   - nothing was posted, or CalLink sent the form back; safe to retry.
//   MaybeFiled - the final POST went out and we can't tell; never retry blindly.
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import { BASE, FORM_URL, brief, get, listAll } from './callink.mjs';
import { findNewRequest } from './match.mjs';
import { ACCOUNT_ID, CATEGORY, CATEGORY_ID, DIRECT_DEPOSIT, EXPENDITURE, Q } from '../request.mjs';

export class NotFiled extends Error {}
export class MaybeFiled extends Error {}

const clean = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const mimeOf = f => ({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' })[path.extname(f).toLowerCase()] ?? 'application/octet-stream';

// ---- the form as a DOM we can set values on ----------------------------------------------
function formEditor(html) {
  const $ = cheerio.load(html);
  const form = $('#finance_form');
  if (!form.length) throw new NotFiled('no #finance_form on the page (signed out? run: node session.mjs login)');

  // The .form-group whose label matches. Fails unless exactly one does.
  const group = re => {
    const hits = form.find('.form-group').filter((_, g) => re.test(clean($(g).find('.label-set, label').first().text())));
    if (hits.length !== 1) throw new NotFiled(`expected one question matching ${re}, found ${hits.length}`);
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
    if (opts.length !== 1) throw new NotFiled(`${what}: expected one option matching ${optionRe}, found ${opts.length}`);
    sel.find('option').removeAttr('selected');
    opts.attr('selected', 'selected');
  };
  const choose = (re, optionRe) => selectIn(group(re).find('select').first(), optionRe, re);
  const byName = name => {
    const el = form.find(`[name="${name}"]`);
    if (el.length !== 1) throw new NotFiled(`expected one field named ${name}, found ${el.length}`);
    return el;
  };
  return { $, form, group, setText, choose, selectIn, byName };
}

// jQuery's serializeArray is the browser's successful-controls rule: no unchecked
// radios/checkboxes, no buttons or file inputs, a select sends its selected option.
const serialize = f => f.form.serializeArray().map(({ name, value }) => [name, value]);

// What the page's Upload File button does: fetch the dialog, then post the file to the
// dialog form's own action, with the form's anti-forgery token (without it CalLink
// redirects to its error page).
async function upload(ctx, dialogUrl, token, file) {
  const d = await get(ctx, `${dialogUrl}?_=${Date.now()}`, { headers: { referer: FORM_URL, 'x-requested-with': 'XMLHttpRequest' } });
  const action = cheerio.load(await d.text())('form').attr('action');
  if (d.status() !== 200 || !action) throw new NotFiled(`upload dialog -> ${d.status()}`);
  let r;
  try {
    r = await ctx.request.post(new URL(action, BASE).href, {
      headers: { referer: FORM_URL, origin: BASE },
      multipart: {
        PostedFile: { name: path.basename(file), mimeType: mimeOf(file), buffer: fs.readFileSync(file) },
        __RequestVerificationToken: token,
      },
      maxRedirects: 0,
    });
  } catch (e) {
    throw new NotFiled(`upload of ${path.basename(file)}: ${brief(e)}`);
  }
  // <div class="validResponse">{uuid}.pdf</div><div class="fileName">{original}</div>
  const $ = cheerio.load(await r.text());
  const unique = clean($('.validResponse').text());
  const original = clean($('.fileName').text());
  if (r.status() !== 200 || !unique) {
    const where = r.headers().location ? ` -> ${r.headers().location}` : '';
    throw new NotFiled(`upload of ${path.basename(file)} refused (${r.status()}${where}): ${clean($.text()).slice(0, 200)}`);
  }
  return { unique, original };
}

/**
 * Fetch the form, upload the receipts, and set every answer. `request` is what
 * request.mjs validateRequest returned. Returns the form fields as they would be
 * posted, and the checks on them (account, category, amount, subject, uploads).
 */
export async function buildForm(ctx, { spec, items, total }, { onUpload } = {}) {
  const page = await get(ctx, FORM_URL);
  if (page.status() !== 200) throw new NotFiled(`form -> ${page.status()} (signed out? run: node session.mjs login)`);
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
    throw new NotFiled('question 1 no longer reads YES / No; check the form before submitting');
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
    const { unique, original } = await upload(ctx, new URL(dialogUrl, BASE).href, f.byName('__RequestVerificationToken').attr('value'), it.path);
    block.find('input[name$=".TemporaryFileName"]').attr('value', original);
    block.find('input[name$=".TemporaryUniqueFileName"]').attr('value', unique);
    onUpload?.(n, original, unique);
  }

  const pairs = serialize(f);
  const value = name => pairs.filter(([k]) => k === name).map(([, v]) => v);
  const checks = [
    ['AccountId', value('AccountId').join(), ACCOUNT_ID],
    ['CategoryId', value('CategoryId').join(), CATEGORY_ID],
    ['category shown', f.byName('CategoryId').find('option[selected]').text().trim(), CATEGORY],
    ['RequestedAmount', value('RequestedAmount').join(), total.toFixed(2)],
    ['Subject', value('Subject').join(), spec.subject],
    ['uploads', pairs.filter(([k, v]) => k.endsWith('.TemporaryUniqueFileName') && v).length, items.length],
    ['token', value('__RequestVerificationToken').filter(Boolean).length, 1],
  ].map(([what, got, want]) => ({ what, got: String(got), want: String(want), ok: String(got) === String(want) }));
  return { action: new URL(f.form.attr('action'), BASE).href, pairs, checks };
}

/**
 * Build the form and, with `submit`, post it. Returns the built form, and after a
 * submit the new request's CalLink id and number when it can be found on the list
 * (null when not exactly one match; the next scrape links it by its tag).
 */
export async function fileRequest(ctx, request, { submit = false, onUpload } = {}) {
  const since = new Date();
  const built = await buildForm(ctx, request, { onUpload });
  const failed = built.checks.filter(c => !c.ok);
  if (failed.length) throw new NotFiled(`form check failed: ${failed.map(c => `${c.what}=${c.got} (want ${c.want})`).join(', ')}`);
  if (!submit) return { built, filed: null };

  let r;
  try {
    r = await ctx.request.post(built.action, {
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: FORM_URL, origin: BASE },
      data: new URLSearchParams(built.pairs).toString(),
      maxRedirects: 0,
      timeout: 60_000,
    });
  } catch (e) {
    throw new MaybeFiled(`posting the form: ${brief(e)}`);
  }
  // Success is a redirect to the request list; a 200 is the form sent back with its errors.
  const where = r.headers().location ?? '';
  if (r.status() === 200) {
    const $ = cheerio.load(await r.text());
    const errors = $('.field-validation-error, .validation-summary-errors li, .alert-danger').map((_, e) => clean($(e).text())).get().filter(Boolean);
    throw new NotFiled(`CalLink sent the form back: ${errors.join('; ') || 'no error text'}`);
  }
  if (!(r.status() >= 300 && r.status() < 400 && /requests\/purchase|finance/i.test(where))) {
    throw new MaybeFiled(`unexpected reply to the form: ${r.status()}${where ? ' -> ' + where : ''}`);
  }

  // Filed. Which request is it? Look for it at the top of the list.
  let found = null;
  try {
    const rows = await listAll(ctx, { limit: 20, quiet: true });
    found = findNewRequest(rows, { subject: request.spec.subject, totalCents: Math.round(request.total * 100), since });
  } catch {
    // Finding it is a nicety; the scrape links it by its tag either way.
  }
  return { built, filed: { callinkId: found?.id ?? null, requestNumber: found ? String(found.requestNumber) : null } };
}
