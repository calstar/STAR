/** The stream editor's rules (lib/video/editor.ts): ids from labels, and what a save sends. */
import { describe, it, expect } from 'vitest';
import { draftLayoutFrom, draftsFrom, freeUdpPort, isDirty, layoutIds, newDraft, slugId, toSave, withKind, withLabel, withPreset } from '@/lib/video/editor';

const loaded = {
  revision: 'r1',
  layout: { preset: '1+5' as const, slots: [null, 'pad', null, null, null, null] },
  gateway: { host: '', passwordSet: false },
  ingestHost: 'star-rfs.local',
  streams: [
    { id: 'pad', label: 'Pad overview', kind: 'rtsp' as const, url: 'rtsp://192.0.2.10/main', lowResUrl: 'rtsp://192.0.2.10/sub', record: true, username: 'admin', passwordSet: true },
  ],
};

describe('stream ids', () => {
  it('are made from the label and kept unique', () => {
    expect(slugId('Engine Close-up!', [])).toBe('engine-close-up');
    expect(slugId('Pad', ['pad', 'pad-2'])).toBe('pad-3');
    expect(slugId('***', [])).toBe('stream');
  });

  it('follow a new stream\'s label, but never a saved one\'s', () => {
    let d = [...draftsFrom(loaded), newDraft(draftsFrom(loaded))];
    d = withLabel(d, d[1].key, 'Engine close-up');
    expect(d[1].id).toBe('engine-close-up');
    d = withLabel(d, d[0].key, 'Renamed');
    expect(d[0].id).toBe('pad');
  });

  it('stop following once the id was edited by hand', () => {
    let d = [newDraft([])];
    d = [{ ...d[0], id: 'custom', idEdited: true }];
    d = withLabel(d, d[0].key, 'Something');
    expect(d[0].id).toBe('custom');
  });
});

describe('saving', () => {
  it('omits an untouched password so the saved one is kept', () => {
    const { streams, credentials } = toSave(draftsFrom(loaded));
    expect(streams).toEqual([{ id: 'pad', label: 'Pad overview', kind: 'rtsp', url: 'rtsp://192.0.2.10/main', lowResUrl: 'rtsp://192.0.2.10/sub', record: true }]);
    expect(credentials).toEqual({ pad: { username: 'admin' } });
    expect('password' in credentials.pad).toBe(false);
  });

  it('sends a typed password, or null to clear one', () => {
    const [d] = draftsFrom(loaded);
    expect(toSave([{ ...d, newPassword: 'new' }]).credentials.pad.password).toBe('new');
    expect(toSave([{ ...d, clearPassword: true }]).credentials.pad.password).toBeNull();
  });

  it('drops an empty low-res URL and trims fields', () => {
    const [d] = draftsFrom(loaded);
    expect(toSave([{ ...d, lowResUrl: '  ', label: ' Pad ' }]).streams[0]).toEqual({ id: 'pad', label: 'Pad', kind: 'rtsp', url: 'rtsp://192.0.2.10/main', record: true });
  });

  it('knows when there is nothing to save', () => {
    const orig = draftsFrom(loaded);
    expect(isDirty(orig, orig)).toBe(false);
    expect(isDirty([{ ...orig[0], label: 'x' }], orig)).toBe(true);
    expect(isDirty([{ ...orig[0], newPassword: 'p' }], orig)).toBe(true);
    expect(isDirty([], orig)).toBe(true);
  });
});

describe('layout in the editor', () => {
  it('slots follow a stream through an id change, and resolve to ids on save', () => {
    const drafts = [...draftsFrom(loaded), newDraft(draftsFrom(loaded))];
    let layout = draftLayoutFrom(loaded.layout, drafts);
    expect(layout.slots[1]).toBe(drafts[0].key);
    layout = { ...layout, slots: [drafts[1].key, ...layout.slots.slice(1)] };
    const renamed = withLabel(drafts, drafts[1].key, 'Engine');
    expect(layoutIds(layout, renamed)).toEqual({ preset: '1+5', slots: ['engine', 'pad', null, null, null, null] });
  });

  it('a removed stream leaves an empty slot', () => {
    const drafts = draftsFrom(loaded);
    const layout = draftLayoutFrom(loaded.layout, drafts);
    expect(layoutIds(layout, []).slots).toEqual([null, null, null, null, null, null]);
  });

  it('changing preset keeps the slots that still fit', () => {
    const l = { preset: '1+5' as const, slots: ['a', 'b', 'c', null, null, 'f'] };
    expect(withPreset(l, '2x2')).toEqual({ preset: '2x2', slots: ['a', 'b', 'c', null] });
    expect(withPreset(l, '1+7').slots).toEqual(['a', 'b', 'c', null, null, 'f', null, null]);
    expect(withPreset(l, 'auto')).toEqual({ preset: 'auto', slots: [] });
  });
});

describe('a HiDes (UDP) stream in the editor', () => {
  it('switching to UDP picks the first free port in the video range', () => {
    let d = [newDraft([]), newDraft([])];
    d = withKind(d, d[0].key, 'udp');
    d = withKind(d, d[1].key, 'udp');
    expect(d.map((x) => x.port)).toEqual(['5600', '5601']);
    expect(freeUdpPort(d)).toBe('5602');
  });

  it('saves a port, and no URL or credentials', () => {
    const [d] = withKind([{ ...newDraft([]), id: 'hides', label: 'HiDes', url: 'rtsp://leftover', username: 'u', newPassword: 'p' }], '', 'rtsp');
    const udp = { ...d, kind: 'udp' as const, port: '5600' };
    expect(toSave([udp])).toEqual({ streams: [{ id: 'hides', label: 'HiDes', kind: 'udp', port: 5600, record: true }], credentials: {} });
  });

  it('a kind or port change is a change to save', () => {
    const orig = draftsFrom(loaded);
    expect(isDirty([{ ...orig[0], kind: 'udp' }], orig)).toBe(true);
    expect(isDirty([{ ...orig[0], port: '5600' }], orig)).toBe(true);
  });
});

describe('OBS URLs', () => {
  it('point at the gateway, main and low-res', async () => {
    const { obsUrls } = await import('@/lib/video/editor');
    const [pad] = draftsFrom(loaded);
    expect(obsUrls(pad, 'theombp.local')).toEqual([
      { label: 'main', url: 'rtsp://theombp.local:8554/raw/pad' },
      { label: 'low-res', url: 'rtsp://theombp.local:8554/raw/pad/low' },
    ]);
    expect(obsUrls({ id: 'hides', kind: 'udp', lowResUrl: '' }, 'star-rfs.local')).toEqual([{ label: 'main', url: 'rtsp://star-rfs.local:8554/raw/hides' }]);
  });
});
