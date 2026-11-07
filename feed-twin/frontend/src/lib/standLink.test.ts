import { describe, expect, it } from 'vitest';
import { askedStand, missedStand } from './standLink';

describe('a link that names a stand', () => {
  it('reads the stand the address asks for', () => {
    expect(askedStand('?stand=nope-123')).toBe('nope-123');
    expect(askedStand('?diagram=x')).toBeNull();
    expect(askedStand('')).toBeNull();
  });

  it('says so when the stand it names did not open', () => {
    // /?stand=nope-123 opened the featured stand with no word why.
    const said = missedStand('nope-123', null, true);
    expect(said).toContain('nope-123');
    expect(missedStand('nope-123', { id: 'le4-3' }, true)).toContain('nope-123');
  });

  it('says nothing while the stand is opening, when it opened, or when no link asked', () => {
    expect(missedStand('nope-123', null, false)).toBe('');
    expect(missedStand('le4-3', { id: 'le4-3' }, true)).toBe('');
    expect(missedStand(null, null, true)).toBe('');
  });
});
