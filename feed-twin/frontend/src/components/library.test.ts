import { describe, expect, it } from 'vitest';
import type { Artifact, ImportResult } from '../api';
import { pulledFrom, superseded } from './LibraryPanel';
import { importedNote } from './SourcePanel';

const art = (id: string, source: string, imported_at: string, name = 'Ethalox 7200N Doublet'): Artifact => ({
  id,
  kind: 'engine',
  name,
  sha256: id,
  size: 1,
  imported_at,
  source,
  notes: '',
  summary: {},
});

describe('two pulls of one design', () => {
  const old = art('aaa', 'engine-design:local/ethalox-7200n-doublet@working copy', '2026-10-01T00:00:00+00:00');
  const now = art('bbb', 'engine-design:local/ethalox-7200n-doublet@working copy', '2026-10-17T00:00:00+00:00');
  const upload = art('ccc', 'upload', '2026-10-02T00:00:00+00:00');

  it('names the design document a pull came from, and nothing for an upload', () => {
    expect(pulledFrom(old)).toBe('engine-design:local/ethalox-7200n-doublet');
    expect(pulledFrom(upload)).toBeNull();
  });
  it('marks the older pull superseded, never the newest or an upload', () => {
    expect([...superseded([now, old, upload])]).toEqual(['aaa']);
  });
});

describe('what an import says when it lands', () => {
  const result = (name: string, already: boolean): ImportResult => ({
    artifact: { ...art('a22', 'upload', '', name), kind: 'diagram' },
    already_present: already,
  });
  it('a pull that is a drawing already here says which one', () => {
    expect(importedNote(result('LE4 (6)', true), 'LE4 Stand')).toBe(
      'LE4 Stand is already in the library as LE4 (6) — the same drawing.',
    );
  });
  it('the same name again says so plainly', () => {
    expect(importedNote(result('LE4 (6)', true), 'LE4 (6)')).toBe('LE4 (6) was already in the library — the same drawing.');
  });
  it('a new drawing is imported', () => {
    expect(importedNote(result('LE4 Stand', false), 'LE4 Stand')).toBe('Imported LE4 Stand.');
  });
});
