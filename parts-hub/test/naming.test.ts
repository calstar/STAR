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
