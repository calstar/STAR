// File one CalLink purchase request (reimbursement) by driving the real form with the
// session that `node session.mjs login` stored.
//
//   node submit.mjs request.json            # fill, upload and check everything; do NOT submit
//   node submit.mjs request.json --submit   # ...and press Submit Request
//
// The request file holds the payee, contact answers and up to six items; receipt paths
// are relative to the file. The account is not in it: every request goes to MISC-STAR.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

import { PROFILE, RUNS as OUT } from './lib/callink.mjs';
import { ACCOUNT_ID, ACCOUNT_NAME, CATEGORY, CATEGORY_ID, EXPENDITURE, FORM_URL, DIRECT_DEPOSIT, Q, loadRequest } from './request.mjs';


const [specPath, ...flags] = process.argv.slice(2);
const doSubmit = flags.includes('--submit');
// --capture FILE: press Submit, but cancel the POST before it leaves and save its body.
const captureTo = flags.includes('--capture') ? flags[flags.indexOf('--capture') + 1] : null;
if (!specPath) {
  console.error('usage: node submit.mjs request.json [--submit]');
  process.exit(2);
}
const log = (...a) => console.log(new Date().toISOString(), ...a);
const brief = e => String(e?.message ?? e).split('\n')[0];
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

let spec, items, total;
try {
  ({ spec, items, total } = loadRequest(specPath));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

// ---- fill the form ---------------------------------------------------------------------
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const shot = name => page.screenshot({ path: path.join(OUT, `${stamp}-submit-${name}.png`), fullPage: true });

// The .form-group whose label matches, e.g. /^Item #1: Vendor/. Fails unless exactly one does.
async function group(re) {
  const groups = page.locator('#finance_form .form-group').filter({
    has: page.locator('.label-set, label').first().filter({ hasText: re }),
  });
  const n = await groups.count();
  if (n !== 1) throw new Error(`expected one question matching ${re}, found ${n}`);
  return groups;
}
async function fillText(re, value) {
  if (value == null || value === '') return;
  const g = await group(re);
  await g.locator('input[type=text], textarea').first().fill(String(value));
}
async function choose(re, optionRe) {
  const g = await group(re);
  const select = g.locator('select').first();
  const options = await select.locator('option').allInnerTexts();
  const match = options.filter(o => optionRe.test(o.trim()));
  if (match.length !== 1) throw new Error(`${re}: expected one option matching ${optionRe}, found [${match}]`);
  await select.selectOption({ label: match[0] });
}
async function selectAccount() {
  await page.click('#accountSelectButton');
  // Each row is <a class="account-picker" id="{accountId}">Select</a> | account name | parent
  // account (MISC-STAR's parent is the SUMMARY account, so match the name cell exactly).
  const pick = page.locator(`a.account-picker[id="${ACCOUNT_ID}"]`);
  await pick.waitFor({ timeout: 15_000 });
  const name = (await pick.locator('xpath=ancestor::tr/td[2]').innerText()).trim();
  if (name !== ACCOUNT_NAME) throw new Error(`account ${ACCOUNT_ID} is "${name}", expected ${ACCOUNT_NAME}`);
  await pick.click();
  await page.waitForFunction(id => document.querySelector('#AccountId')?.value === id, ACCOUNT_ID, { timeout: 10_000 });
}

async function upload(n, file) {
  const g = await group(Q.upload(n));
  await g.locator('input[type=button], button').first().click();
  // The dialog CalLink loads from GetFileUploadDialog: a form with a file input.
  const input = page.locator('input[type=file]').filter({ visible: true }).first();
  await input.waitFor({ timeout: 15_000 }).catch(() => {});
  const fileInput = (await input.count()) ? input : page.locator('input[type=file]').last();
  const uploaded = page.waitForResponse(r => /FileUploadQuestion\/uploadfile/i.test(r.url()), { timeout: 60_000 });
  await fileInput.setInputFiles(file);
  // Some versions upload on change, others need the dialog's own button.
  const go = page.getByRole('button', { name: /^(upload|submit|save|ok)$/i }).filter({ visible: true }).first();
  if (await go.count()) await go.click().catch(() => {});
  const r = await uploaded;
  if (r.status() !== 200) throw new Error(`upload ${n} -> HTTP ${r.status()}`);
  // The page copies the server's temp name into this item's hidden fields.
  const unique = g.locator('input[name$=".TemporaryUniqueFileName"]');
  await page.waitForFunction(el => !!el?.value, await unique.elementHandle(), { timeout: 15_000 });
  const tmp = await unique.inputValue();
  log(`item ${n}: uploaded ${path.basename(file)} as ${tmp}`);
}

let exitCode = 1;
try {
  await page.goto(FORM_URL, { waitUntil: 'networkidle' });
  if (new URL(page.url()).hostname !== 'callink.berkeley.edu') throw new Error('not signed in: run node session.mjs login');

  await page.fill('#Subject', spec.subject);
  await page.fill('#Description', spec.description ?? '');
  await page.fill('#RequestedAmount', total.toFixed(2));
  await page.selectOption('#CategoryId', { label: CATEGORY });
  await selectAccount();

  const p = spec.payee;
  await page.fill('#PayeeFirstName', p.firstName);
  await page.fill('#PayeeLastName', p.lastName);
  await page.fill('#PayeeStreet', p.street);
  await page.fill('#PayeeStreet2', p.street2 ?? '');
  await page.fill('#PayeeCity', p.city);
  await page.fill('#PayeeState', p.state);
  await page.fill('#PayeeZipCode', p.zip);

  const q1 = await group(Q.ucMember);
  // Always YES (a UC Berkeley student or staff member), with the UID in its write-in box.
  await q1.locator('input[type=radio]').first().check();
  await q1.locator('input[type=text]').first().fill(String(spec.uid));
  await page.locator('#finance_form .form-group').filter({ hasText: Q.certify })
    .locator('input[type=checkbox]').check();
  await fillText(Q.email, spec.email);
  await fillText(Q.phone, spec.phone);
  await choose(Q.expenditure, EXPENDITURE[spec.expenditureAction]);
  await fillText(Q.special, spec.specialInstructions);
  if (spec.expenditureAction === 'Direct Deposit') await choose(Q.directDeposit, spec.directDepositSignedUp ? DIRECT_DEPOSIT.done : DIRECT_DEPOSIT.pending);
  await fillText(Q.event, spec.eventDetails);

  for (const [i, it] of items.entries()) {
    const n = i + 1;
    await fillText(Q.item(n, 'Date of Expense'), it.date);
    await choose(Q.item(n, 'Type of Expense'), new RegExp(`^${it.type}$`, 'i'));
    await fillText(Q.item(n, 'Vendor name'), it.vendor);
    await fillText(Q.item(n, 'Location'), it.location);
    await fillText(Q.item(n, 'Invoice Number'), it.invoice);
    await fillText(Q.item(n, 'Total of Expense'), Number(it.total).toFixed(2));
    await fillText(Q.item(n, 'Additional Misc'), it.notes);
    await upload(n, it.path);
  }

  // ---- check what the form will send, not what we meant to type ------------------------
  const sent = await page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('#finance_form'))));
  const accountText = (await page.locator('#account-select-text').innerText()).trim();
  const checks = [
    ['AccountId', sent.AccountId, ACCOUNT_ID],
    ['CategoryId', sent.CategoryId, CATEGORY_ID],
    ['account shown', accountText.includes(ACCOUNT_NAME), true],
    ['RequestedAmount', Number(sent.RequestedAmount).toFixed(2), total.toFixed(2)],
    ['Subject', sent.Subject, spec.subject],
    ['uploads', Object.keys(sent).filter(k => k.endsWith('.TemporaryUniqueFileName') && sent[k]).length, items.length],
  ];
  let ok = true;
  for (const [what, got, want] of checks) {
    const pass = String(got) === String(want);
    ok &&= pass;
    log(`${pass ? 'ok  ' : 'FAIL'} ${what}: ${got}${pass ? '' : ` (want ${want})`}`);
  }
  await shot('filled');
  if (!ok) throw new Error('form check failed; not submitting');

  if (captureTo) {
    let body = null;
    await page.route('**/CreatePurchaseRequest', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      body = route.request().postData();
      await route.abort();
    });
    await page.click('#saveButton');
    await page.waitForTimeout(3000);
    if (body == null) throw new Error('Submit did not send a POST (client-side validation?)');
    fs.writeFileSync(captureTo, body, { mode: 0o600 });
    log(`captured the POST body (${body.length} bytes) to ${captureTo}; it was NOT sent`);
    exitCode = 0;
  } else if (!doSubmit) {
    // Every answered field, labelled with its question where it has one.
    const filled = await page.evaluate(() => {
      const clean = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll('#finance_form input, #finance_form select, #finance_form textarea')]
        .filter(el => el.name && !/Index$|Token|Url$/.test(el.name) && (el.type === 'radio' || el.type === 'checkbox' ? el.checked : el.value && el.value !== '-1'))
        .filter(el => el.type !== 'hidden' || /AccountId|Temporary/.test(el.name))
        .map(el => {
          const q = clean(el.closest('.form-group')?.querySelector('.label-set, label')?.innerText).slice(0, 45);
          const v = el.tagName === 'SELECT' ? el.selectedOptions[0]?.text : el.type === 'radio' || el.type === 'checkbox' ? clean(el.closest('label')?.innerText).slice(0, 40) : el.value;
          return `${(q || el.name).padEnd(45)} = ${clean(v).slice(0, 80)}`;
        });
    });
    console.log(filled.join('\n'));
    log(`dry run: form filled and checked, not submitted (screenshot in ${OUT}). Re-run with --submit.`);
    exitCode = 0;
  } else {
    log(`submitting "${spec.subject}" for $${total.toFixed(2)} to ${ACCOUNT_NAME}`);
    await Promise.all([page.waitForLoadState('networkidle'), page.click('#saveButton')]);
    await page.waitForTimeout(2000);
    await shot('after-submit');
    const errors = (await page.locator('.field-validation-error, .validation-summary-errors li, .alert-danger')
      .allInnerTexts()).map(s => s.trim()).filter(Boolean);
    if (errors.length) throw new Error(`CalLink refused the form:\n  ${errors.join('\n  ')}`);
    if (/CreatePurchaseRequest/i.test(page.url())) throw new Error(`still on the form after submit (${page.url()})`);
    log(`submitted; CalLink went to ${page.url()}`);
    exitCode = 0;
  }
} catch (e) {
  log('error:', brief(e));
  await shot('error').catch(() => {});
} finally {
  await ctx.close();
}
process.exit(exitCode);
