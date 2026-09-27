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
