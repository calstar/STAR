import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error plain browser JS module, no types
import { buildIndex, search } from '../public/shared/search.js';

const parts = [
  { name: '1/4 Tube Union SS', partNumber: 'SS-400-6', vendor: 'Swagelok', category: 'Fittings', tags: ['union'], customFields: [{ key: 'Material', value: '316 SS' }] },
  { name: '1/4 Ball Valve 2-Way', partNumber: 'SS-43GS4', vendor: 'Swagelok', category: 'Valves', notes: 'Use for oxidizer lines' },
  { name: '1/4-20 x 3/4 SHCS', partNumber: '91251A540', vendor: 'McMaster-Carr', category: 'Fasteners' },
  { name: 'Pressure Transducer 0-5000 psi', partNumber: 'PX309-5KGI', vendor: 'Omega', category: 'Sensors' },
];
const index = buildIndex(parts);
const names = (q: string, opts?: object) => search(index, q, opts).map((p: { name: string }) => p.name);

test('matches every field, not just the name', () => {
  assert.deepEqual(names('mcmaster'), ['1/4-20 x 3/4 SHCS']);
  assert.deepEqual(names('316'), ['1/4 Tube Union SS']);
  assert.deepEqual(names('oxidizer'), ['1/4 Ball Valve 2-Way']);
  assert.deepEqual(names('PX309'), ['Pressure Transducer 0-5000 psi']);
});

test('ignores punctuation in part numbers and tolerates typos', () => {
  assert.deepEqual(names('ss4006'), ['1/4 Tube Union SS']);
  assert.deepEqual(names('vlave'), ['1/4 Ball Valve 2-Way']);
  assert.deepEqual(names('transdcuer'), ['Pressure Transducer 0-5000 psi']);
});

test('all query words must match; category narrows', () => {
  assert.deepEqual(names('1/4 valve'), ['1/4 Ball Valve 2-Way']);
  assert.deepEqual(names('zzz'), []);
  assert.deepEqual(names('', { category: 'Sensors' }), ['Pressure Transducer 0-5000 psi']);
  assert.equal(names('').length, parts.length);
});

// Fittings the way people actually search for them.
const fittings = buildIndex([
  { name: '1/4 Tube x 3/8 NPT Male Connector', partNumber: 'SS-400-1-6', vendor: 'Swagelok', category: 'Fittings' },
  { name: '1/4 Tube x 1/4 NPT Male Connector', partNumber: 'SS-400-1-4', vendor: 'Swagelok', category: 'Fittings' },
  { name: '3/8 Tube x 1/4 NPT Reducer', partNumber: 'SS-600-R-4', vendor: 'Swagelok', category: 'Fittings' },
  { name: '3/8 Tube Tee', partNumber: 'SS-600-3', vendor: 'Swagelok', category: 'Fittings' },
  { name: '1/4-20 x 3/4 SHCS', partNumber: '91251A540', vendor: 'McMaster-Carr', category: 'Fasteners' },
  { name: 'Pressure Transducer', partNumber: 'PX309', customFields: [{ key: 'Range', value: '0-5000 psi' }] },
  { name: 'Ball Valve', partNumber: 'SS-43GS4', customFields: [{ key: 'Max pressure', value: '3000 psi' }] },
  { name: 'Tube Union 0.25 in', partNumber: 'U-25' },
]);
const find = (q: string) => search(fittings, q).map((p: { name: string }) => p.name);

test('"1/4 to 3/8 npt" finds the 1/4 x 3/8 adapters, not 1/4 x 1/4 or plain 3/8 parts', () => {
  for (const q of ['1/4 to 3/8 npt', '3/8 npt 1/4', '1/4" x 3/8" NPT', '1/4x3/8 npt', '1/4in to 3/8in npt']) {
    assert.deepEqual(find(q), ['1/4 Tube x 3/8 NPT Male Connector', '3/8 Tube x 1/4 NPT Reducer'], q);
  }
});

test('sizes and part numbers are never typo-matched', () => {
  assert.deepEqual(find('5000 psi'), ['Pressure Transducer'], '3000 psi is a different valve');
  assert.deepEqual(find('ss4001-6'), ['1/4 Tube x 3/8 NPT Male Connector']);
  assert.deepEqual(find('SS-400-1-4'), ['1/4 Tube x 1/4 NPT Male Connector']);
  assert.ok(!find('1/4').includes('3/8 Tube Tee'));
  assert.deepEqual(find('3/4'), ['1/4-20 x 3/4 SHCS'], '3/4 is not inside 13/4 or 3/48');
});

test('fractions and decimals are interchangeable', () => {
  assert.ok(find('0.25').includes('1/4 Tube x 3/8 NPT Male Connector'));
  assert.ok(find('.375').includes('3/8 Tube Tee'));
  assert.ok(find('1/4 union').includes('Tube Union 0.25 in'), 'a decimal in the name answers a fraction query');
});
