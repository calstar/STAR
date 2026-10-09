import assert from 'node:assert/strict';
import { test } from 'node:test';
import { partNames } from '../src/onshape/client.ts';

test('a single part takes the display name, whatever the file called it', () => {
  assert.deepEqual(partNames('1/4 Tube Union SS', ['Mirror1']), ['1/4 Tube Union SS']);
});

test('several parts keep meaningful names and number the generic ones', () => {
  assert.deepEqual(partNames('1/4 Union', ['SS-400-6 BODY', 'NUT', 'Mirror 1', 'Body2']), [
    '1/4 Union - SS-400-6 BODY',
    '1/4 Union - NUT',
    '1/4 Union (3)',
    '1/4 Union (4)',
  ]);
});

import { massValue, splitMass } from '../src/onshape/client.ts';

test('a fitting weight is split across its bodies by volume, or equally if volumes are unknown', () => {
  assert.deepEqual(splitMass(1, [3, 1]), [0.75, 0.25]);
  assert.deepEqual(splitMass(1, [3, null]), [0.5, 0.5]);
  assert.equal(massValue(0.0283495231), '0.0283495 kg');
});
