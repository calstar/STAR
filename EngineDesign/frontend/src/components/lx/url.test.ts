import { describe, expect, it } from 'vitest';
import { formatUrlT, isLxPage, readLxUrl, wantsGallery, wantsLayerXTab, wantsV2, writeLxUrl } from './url';

const mem = (v: string | null) => ({ getItem: () => v });

describe('readLxUrl', () => {
  it('reads every Layer X param', () => {
    expect(readLxUrl('?lx=2&run=20261002-231658-7e47d1&page=feed&t=1.85&vs=20261002-224508-cf9797')).toEqual({
      lx: '2', run: '20261002-231658-7e47d1', page: 'feed', t: 1.85, vs: '20261002-224508-cf9797',
    });
  });

  it('drops what it cannot use instead of passing it on', () => {
    const s = readLxUrl('?lx=2&run=../../etc&page=nowhere&t=abc&vs=');
    expect(s).toEqual({ lx: '2', run: null, page: null, t: null, vs: null });
  });

  it('keeps a negative cursor (before Fire) and a blank t is no cursor', () => {
    expect(readLxUrl('?t=-0.4').t).toBe(-0.4);
    expect(readLxUrl('?t=').t).toBeNull();
    expect(readLxUrl('?t=%20').t).toBeNull();
  });
});

describe('writeLxUrl', () => {
  it('leaves every other param where it was', () => {
    const s = writeLxUrl('?foo=1&lx=2&bar=x%20y', { run: 'abc', page: 'engine', t: 1.8512, vs: null });
    const q = new URLSearchParams(s);
    expect(q.get('foo')).toBe('1');
    expect(q.get('bar')).toBe('x y');
    expect(q.get('lx')).toBe('2');
    expect(q.get('run')).toBe('abc');
    expect(q.get('page')).toBe('engine');
    expect(q.get('t')).toBe('1.851');
    expect(q.has('vs')).toBe(false);
    // Order of the untouched params is preserved.
    expect([...q.keys()].slice(0, 3)).toEqual(['foo', 'lx', 'bar']);
  });

  it('keeps the lx the page was opened with, and adds the new GUI\'s when there is none', () => {
    expect(new URLSearchParams(writeLxUrl('?lx=1', { run: 'a' })).get('lx')).toBe('1');
    expect(new URLSearchParams(writeLxUrl('', { run: 'a' })).get('lx')).toBe('2');
  });

  it('removes a param set to null, and the default page', () => {
    const s = writeLxUrl('?lx=2&run=a&page=feed&t=1&vs=b', { run: null, page: 'overview', t: null, vs: null });
    expect(s).toBe('?lx=2');
  });

  it('touches only the params it is given', () => {
    expect(writeLxUrl('?lx=2&run=a&page=feed', { t: 2 })).toBe('?lx=2&run=a&page=feed&t=2');
  });

  it('round-trips', () => {
    const s = writeLxUrl('?x=1', { run: 'r1', page: 'record', t: -0.25, vs: 'r0' });
    expect(readLxUrl(s)).toEqual({ lx: '2', run: 'r1', page: 'record', t: -0.25, vs: 'r0' });
  });
});

describe('formatUrlT', () => {
  it('prints to the millisecond with no trailing zeros, and no negative zero', () => {
    expect(formatUrlT(1.85)).toBe('1.85');
    expect(formatUrlT(1.8)).toBe('1.8');
    expect(formatUrlT(3.4662897869910627)).toBe('3.466');
    expect(formatUrlT(-0.0001)).toBe('0');
  });
});

describe('which GUI', () => {
  it('mounts the rebuilt GUI by default since the cut-over, and the old one only at lx=1', () => {
    expect(wantsV2('')).toBe(true);
    expect(wantsV2('?run=a&page=feed')).toBe(true);
    expect(wantsV2('?lx=2')).toBe(true);
    expect(wantsV2('?lx=1')).toBe(false);
    expect(wantsV2('?lx=1&run=a')).toBe(false);
    // The pre-cut-over opt-in no longer decides anything.
    expect(wantsV2('', mem('v1'))).toBe(true);
    expect(wantsV2('?lx=1', mem('v2'))).toBe(false);
  });

  it('opens on the Layer X tab for either lx', () => {
    expect(wantsLayerXTab('?lx=1')).toBe(true);
    expect(wantsLayerXTab('?lx=2&run=a')).toBe(true);
    expect(wantsLayerXTab('?run=a')).toBe(false);
  });

  it('knows the gallery and the pages', () => {
    expect(wantsGallery('?lx-gallery=1')).toBe(true);
    expect(wantsGallery('?lx-gallery=0')).toBe(false);
    expect(isLxPage('hardware')).toBe(true);
    expect(isLxPage('trade')).toBe(false);
  });
});
