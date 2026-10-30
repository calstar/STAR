import { describe, expect, it } from 'vitest';
import type { DocMeta } from '../api/documents';
import { pickInitialDesign } from './initialDesign';

const doc = (id: string, updatedAt: string, extra: Partial<DocMeta> = {}): DocMeta => ({
  id, name: id, createdAt: '2026-09-01T00:00:00Z', updatedAt, mine: true, ...extra,
});

// The team's store as it stood on 2026-10-17: the seeded draft first, the design in use second.
const team = [
  doc('design-1', '2026-09-08T07:13:47Z'),
  doc('ethalox-7200n-doublet', '2026-10-06T06:51:08Z'),
];

describe('pickInitialDesign', () => {
  it('opens the design worked on last, not the first in the list', () => {
    expect(pickInitialDesign(team, null)?.id).toBe('ethalox-7200n-doublet');
  });
  it('keeps the design this browser had open', () => {
    expect(pickInitialDesign(team, { id: 'design-1', owner: null })?.id).toBe('design-1');
  });
  it('ignores a remembered design that is gone', () => {
    expect(pickInitialDesign(team, { id: 'deleted', owner: null })?.id).toBe('ethalox-7200n-doublet');
  });
  it('prefers your own design to a newer one shared with you', () => {
    const shared = doc('theirs', '2026-10-16T00:00:00Z', { mine: false, owner: 'someone@berkeley.edu' });
    expect(pickInitialDesign([...team, shared], null)?.id).toBe('ethalox-7200n-doublet');
  });
  it('takes the main design when the app marks one', () => {
    expect(pickInitialDesign([...team, doc('main', '2026-01-01T00:00:00Z', { featured: true })], null)?.id).toBe('main');
  });
  it('has nothing to open in an empty store', () => {
    expect(pickInitialDesign([], null)).toBeNull();
  });
});
