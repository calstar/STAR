import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findByTag, findNewRequest } from '../lib/match.mjs';

const since = new Date('2026-10-02T10:00:00Z');
const row = (id, name, amount, at) => ({ id, requestNumber: id + 100, name, submittedAmount: amount, submittedOn: at });
const subject = 'LE3 fittings [STAR R-42]';

test('finds the request just filed', () => {
  const rows = [row(3, subject, 12.34, '2026-10-02T10:00:05Z'), row(2, 'Other', 12.34, '2026-10-02T10:00:04Z')];
  assert.equal(findNewRequest(rows, { subject, totalCents: 1234, since })?.id, 3);
});

test("copes with CalLink stamping Eastern time as UTC", () => {
  // Filed 12:00:00Z; CalLink's list said 07:59:59+00:00 (seen 2026-10-02).
  const rows = [row(1892418, subject, 1.0, '2026-10-02T07:59:59+00:00')];
  assert.equal(findNewRequest(rows, { subject, totalCents: 100, since: new Date('2026-10-02T11:59:58Z') })?.id, 1892418);
});

test('needs the amount and the time to agree too', () => {
  assert.equal(findNewRequest([row(3, subject, 99, '2026-10-02T10:00:05Z')], { subject, totalCents: 1234, since }), null);
  assert.equal(findNewRequest([row(3, subject, 12.34, '2026-09-01T00:00:00Z')], { subject, totalCents: 1234, since }), null);
});

test('refuses to guess between two matches', () => {
  const rows = [row(4, subject, 12.34, '2026-10-02T10:00:06Z'), row(3, subject, 12.34, '2026-10-02T10:00:05Z')];
  assert.equal(findNewRequest(rows, { subject, totalCents: 1234, since }), null);
});

test('finds a tag whenever it was filed, and only at the end of the subject', () => {
  const rows = [row(1, subject, 1, '2025-01-01'), row(2, 'LE3 fittings [STAR R-42] (copy)', 1, '2025-01-01'), row(3, 'x [STAR R-421]', 1, '2025-01-01')];
  assert.deepEqual(findByTag(rows, '[STAR R-42]').map(r => r.id), [1]);
});
