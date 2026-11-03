import { describe, expect, it } from 'vitest';
import { linkedIn, readLinked } from './PIDDesigner';

// `?diagram=<id>&owner=<owner>` opens that diagram, but only one in your list.
const list = [
  { id: 'stand', owner: 'me@berkeley.edu', mine: true },
  { id: 'stand', owner: 'bob@berkeley.edu', mine: false },
  { id: 'cart', owner: 'bob@berkeley.edu', mine: false },
];

describe('diagram links', () => {
  it('reads the id and optional owner', () => {
    expect(readLinked('?diagram=stand&owner=bob%40berkeley.edu')).toEqual({ id: 'stand', owner: 'bob@berkeley.edu' });
    expect(readLinked('?diagram=stand')).toEqual({ id: 'stand', owner: null });
    expect(readLinked('?x=1')).toBeNull();
  });

  it('picks the owner it names, or your own without one', () => {
    expect(linkedIn(list, { id: 'stand', owner: 'bob@berkeley.edu' })).toBe(list[1]);
    expect(linkedIn(list, { id: 'stand', owner: null })).toBe(list[0]);
    expect(linkedIn(list, { id: 'stand', owner: 'me@berkeley.edu' })).toBe(list[0]);
  });

  it('opens nothing outside your list', () => {
    expect(linkedIn(list, { id: 'secret', owner: 'eve@berkeley.edu' })).toBeUndefined();
    expect(linkedIn(list, { id: 'cart', owner: null })).toBeUndefined();
    expect(linkedIn(list, null)).toBeUndefined();
  });
});
