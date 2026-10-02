// What a reimbursement request file must hold, and the parts of the CalLink form that do
// not come from it. Shared by submit.mjs (drives the page) and direct.mjs (posts the form).
import fs from 'node:fs';
import path from 'node:path';

export const FORM_URL = 'https://callink.berkeley.edu/actionCenter/organization/star/Finance/CreatePurchaseRequest';
// Always MISC-STAR. The form warns never to pick SUMMARY; TEMP REST is not ours to spend.
export const ACCOUNT_ID = '94919';
export const ACCOUNT_NAME = '3-70-203828-00000-MISC-STAR';
// Always a Reimbursement; the request file cannot choose another category.
export const CATEGORY_ID = '1352';
export const CATEGORY = 'Reimbursement';
export const MAX_ITEMS = 6;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const EXPENDITURE = {
  'Mail to Payee': /^Mail to Payee/,
  'Hold for Pickup': /^Hold for Pickup/,
  'Direct Deposit': /^Direct Deposit/,
  Other: /^Other/,
};

// The question labels on the form. Item 3's date is spelt "Iterm #3"; items 2-6 label
// their upload "Upload Item #N file here".
export const Q = {
  ucMember: /^1\.\s*Is payee a UC Berkeley/i,
  certify: /^\s*I certify that what I have typed above/i,
  email: /^2\.\s*REQUIRED: Payee's Email/i,
  phone: /^3\.\s*REQUIRED: Payee's Phone/i,
  expenditure: /^4\.\s*Expenditure Action/i,
  special: /^5\.\s*SPECIAL INSTRUCTIONS/i,
  directDeposit: /^6\.\s*Direct Deposit/i,
  event: /^Event Details/i,
  item: (n, rest) => new RegExp(`^(?:Item|Iterm) #${n}:\\s*${rest}`, 'i'),
  upload: n => (n === 1 ? /^Item #1:\s*Upload/i : new RegExp(`^Upload Item #${n} file`, 'i')),
};

// Answers the form asks for that STAR always gives the same way. They are not in the
// request file; loadRequest fills them in.
export const FIXED_ITEM = { type: 'Supplies', location: 'Berkeley, CA', invoice: '' };
export const DEFAULT_EXPENDITURE = 'Direct Deposit';
// Q6, for Direct Deposit: has the payee done ASUC's direct-deposit sign-up?
export const DIRECT_DEPOSIT = {
  done: /already successfully completed/i,
  pending: /will complete the form within 3 business days/i,
};

const REQUEST_KEYS = ['subject', 'description', 'payee', 'uid', 'email', 'phone', 'expenditureAction',
  'directDepositSignedUp', 'specialInstructions', 'eventDetails', 'items'];
const ITEM_KEYS = ['date', 'vendor', 'total', 'comment', 'file'];

// Read and check a request file, and fill in what STAR fixes. Throws with every problem
// at once. Every payee is a UC Berkeley student or staff member, so a UID is required.
export function loadRequest(specPath) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const specDir = path.dirname(path.resolve(specPath));
  const problems = [];
  // Fixed answers are not inputs: a file that tries to set one is a mistake, not a choice.
  for (const k of Object.keys(spec)) {
    if (/account|category/i.test(k)) problems.push(`"${k}" cannot be set: every request is ${CATEGORY} on ${ACCOUNT_NAME}`);
    else if (/amount|total/i.test(k)) problems.push(`"${k}" cannot be set: the requested amount is always the sum of the items`);
    else if (!REQUEST_KEYS.includes(k)) problems.push(`unknown field "${k}" (allowed: ${REQUEST_KEYS.join(', ')})`);
  }
  const need = (v, what) => { if (!String(v ?? '').trim()) problems.push(`missing ${what}`); };
  need(spec.subject, 'subject');
  for (const k of ['firstName', 'lastName', 'street', 'city', 'state', 'zip']) need(spec.payee?.[k], `payee.${k}`);
  need(spec.uid, 'uid');
  if (spec.uid && !/^\d{7,8}$/.test(String(spec.uid))) problems.push(`uid "${spec.uid}" is not a 7-8 digit UC Berkeley UID`);
  if (/^303/.test(String(spec.uid ?? ''))) problems.push('uid starts with 303: that is a student ID, not a UID');
  need(spec.email, 'email');
  need(spec.phone, 'phone');
  spec.expenditureAction ??= DEFAULT_EXPENDITURE;
  if (!EXPENDITURE[spec.expenditureAction]) problems.push(`expenditureAction must be one of ${Object.keys(EXPENDITURE).join(', ')}`);
  if (spec.expenditureAction === 'Other') need(spec.specialInstructions, 'specialInstructions (required for Other)');
  if (spec.directDepositSignedUp != null && typeof spec.directDepositSignedUp !== 'boolean') problems.push('directDepositSignedUp must be true or false');
  spec.directDepositSignedUp ??= true;
  const items = spec.items ?? [];
  if (!items.length || items.length > MAX_ITEMS) problems.push(`need 1-${MAX_ITEMS} items, got ${items.length}`);
  items.forEach((it, i) => {
    for (const k of Object.keys(it)) {
      if (!ITEM_KEYS.includes(k)) problems.push(`items[${i}]: "${k}" cannot be set (allowed: ${ITEM_KEYS.join(', ')}; type, location and invoice are fixed)`);
    }
    for (const k of ['date', 'vendor', 'total', 'file']) need(it[k], `items[${i}].${k}`);
    if (!/^\d+(\.\d{1,2})?$/.test(String(it.total))) problems.push(`items[${i}].total "${it.total}" is not an amount like 12.34`);
    if (it.file) {
      it.path = path.resolve(specDir, it.file);
      if (!fs.existsSync(it.path)) problems.push(`items[${i}].file not found: ${it.path}`);
      else if (fs.statSync(it.path).size > MAX_FILE_BYTES) problems.push(`items[${i}].file is over 4 MB`);
    }
  });
  if (problems.length) throw new Error('request file has problems:\n  ' + problems.join('\n  '));
  const filled = items.map(it => ({ ...it, ...FIXED_ITEM, notes: it.comment ?? '' }));
  const total = filled.reduce((s, it) => s + Math.round(Number(it.total) * 100), 0) / 100;
  return { spec, items: filled, total };
}
