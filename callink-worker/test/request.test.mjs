import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ACCOUNT_NAME, FIXED_ITEM, validateRequest } from '../request.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-'));
fs.writeFileSync(path.join(dir, 'r.pdf'), '%PDF-1.4\n');
const valid = () => ({
  subject: 'Test reimbursement',
  payee: { firstName: 'Ada', lastName: 'Lovelace', street: '1 Main St', city: 'Berkeley', state: 'CA', zip: '94704' },
  uid: '7654321',
  email: 'ada@berkeley.edu',
  phone: '5105550100',
  items: [{ date: '10/01/2026', vendor: 'McMaster-Carr', total: '12.34', file: 'r.pdf' }, { date: '10/02/2026', vendor: 'Swagelok', total: '7.66', file: 'r.pdf' }],
});

test('fills in what STAR fixes and sums the items', () => {
  const { spec, items, total } = validateRequest(valid(), dir);
  assert.equal(spec.expenditureAction, 'Direct Deposit');
  assert.equal(spec.directDepositSignedUp, true);
  assert.equal(total, 20);
  assert.deepEqual(items.map(i => [i.type, i.location, i.invoice]), [Object.values(FIXED_ITEM), Object.values(FIXED_ITEM)]);
});

test('refuses to let a request choose its account, category, amount or item type', () => {
  for (const extra of [{ account: 'SUMMARY' }, { categoryId: 1 }, { requestedAmount: '500' }]) {
    assert.throws(() => validateRequest({ ...valid(), ...extra }, dir), new RegExp(ACCOUNT_NAME.slice(0, 8) + '|sum of the items'));
  }
  const r = valid();
  r.items[0].type = 'Food';
  assert.throws(() => validateRequest(r, dir), /"type" cannot be set/);
});

test('refuses a student ID as the UID', () => {
  assert.throws(() => validateRequest({ ...valid(), uid: '3031234' }, dir), /student ID/);
});
