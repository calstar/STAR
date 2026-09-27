import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { renderLocally } from '../src/render/index.ts';

const testfiles = path.join(import.meta.dirname, '../node_modules/occt-import-js/test/testfiles');

test('draws a STEP file as a 300 px PNG', async () => {
  const png = await renderLocally(path.join(testfiles, 'rounded-cube/rounded-cube.step'), 'cube.step');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 300);
  assert.equal(png.readUInt32BE(20), 300);
});

test('draws an STL', async () => {
  const stl = path.join(fs.mkdtempSync('/tmp/stl-'), 'tri.stl');
  fs.writeFileSync(stl, 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n');
  const png = await renderLocally(stl, 'tri.stl');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
});

test('rejects files that are not CAD', async () => {
  const bad = path.join(fs.mkdtempSync('/tmp/bad-'), 'bad.step');
  fs.writeFileSync(bad, 'not a step file');
  await assert.rejects(renderLocally(bad, 'bad.step'));
});
