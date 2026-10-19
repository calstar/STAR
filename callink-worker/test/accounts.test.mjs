import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountProbes } from '../lib/accounts.mjs';

const rec = (id, submittedOn, acct) => ({ list: { id, submittedOn }, detail: { financeAccount: acct ? { id: acct } : null } });

test('remembers the newest request on each account', () => {
  assert.deepEqual(accountProbes([
    rec(1, '2020-02-03T21:23:11+00:00', 94918),
    rec(2, '2026-09-28T02:12:55+00:00', 94919),
    rec(3, '2025-01-01T00:00:00+00:00', 94919),
    rec(4, '2021-02-03T00:00:00+00:00', 94918),
    rec(5, '2026-10-01T00:00:00+00:00', null),
  ]), { 94918: 4, 94919: 2 });
});
