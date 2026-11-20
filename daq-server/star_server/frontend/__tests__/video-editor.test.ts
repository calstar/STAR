/** The stream editor's rules (lib/video/editor.ts): ids from labels, and what a save sends. */
import { describe, it, expect } from 'vitest';
import { draftLayoutFrom, draftsFrom, freeUdpPort, isDirty, layoutIds, newDraft, slugId, startLayout, toSave, withKind, withLabel, withPreset } from '@/lib/video/editor';

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

  it('opens from what the operator sees, so Save keeps their tile picks', () => {
    // Saved slots empty; the operator put the pad camera and the controls in with the tile pickers.
    const saved = { preset: '1+5' as const, slots: [null, null, null, null, null, null] };
    const shown = { preset: '1+5' as const, slots: ['pad', '@controls', null, null, null, null] };
    const drafts = draftsFrom({ ...loaded, layout: saved });
    const layout = draftLayoutFrom(startLayout(saved, shown), drafts);
    expect(layoutIds(layout, drafts)).toEqual(shown);
    // ...and that counts as a change against the saved layout, so Save is offered.
    expect(JSON.stringify(layout)).not.toBe(JSON.stringify(draftLayoutFrom(saved, drafts)));
  });

  it('opens from the saved layout when the screen is not showing it', () => {
    const saved = { preset: '1+5' as const, slots: [null, 'pad', null, null, null, null] };
    expect(startLayout(saved, undefined)).toEqual(saved);
    expect(startLayout(saved, { preset: '2x2', slots: ['pad', null, null, null] })).toEqual(saved);
    expect(startLayout(saved, { preset: '1+5', slots: ['pad'] })).toEqual(saved);
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

describe('the Save note', () => {
  it('says where it went, and names any stream that did not make it', async () => {
    const { describeSave } = await import('@/lib/video/api');
    expect(describeSave({ folder: '/srv/daq-server/video/recordings/2026-11-06_120000_save', seconds: 300, streams: [{ stream: 'pad', file: 'x', seconds: 300 }, { stream: 'eng', file: 'y', seconds: 300 }] }))
      .toBe('saved 2 streams (last 5 min) to recordings/2026-11-06_120000_save');
    // Just after a restart the buffer is young: say what was really kept, not the window.
    expect(describeSave({ folder: 'C:\\rec\\f', seconds: 300, streams: [{ stream: 'pad', file: 'x', seconds: 28 }, { stream: 'hides', error: 'nothing buffered for this stream' }] }))
      .toBe('saved 1 stream (last 28 s) to recordings/f; not saved: hides (nothing buffered for this stream)');
    expect(describeSave({ folder: '/r/f', seconds: 300, streams: [{ stream: 'pad', file: 'x', seconds: 94, gaps: 1 }, { stream: 'eng', file: 'y', seconds: 94, gaps: 0 }] }))
      .toBe('saved 2 streams (last 94 s) to recordings/f; gaps (stream was down) in pad');
  });
});

describe('recording words', () => {
  it('clock, disk left, and the line after Stop', async () => {
    const { clock, diskLeft, describeRecording } = await import('@/lib/video/api');
    expect(clock(724)).toBe('12:04');
    expect(clock(3729)).toBe('1:02:09');
    // 100 GB free, 5 GB floor, 2 MB/s -> 95e9 / 2e6 = 47,500 s = 13 h 11.7 m
    expect(diskLeft({ available: true, disk: { freeBytes: 100e9, totalBytes: 1e12 }, stopBelowBytes: 5e9, bytesPerSecond: 2e6 })).toBe('100 GB free, 13 h 12 m at this rate');
    expect(diskLeft({ available: true, disk: { freeBytes: 6e9, totalBytes: 1e12 }, stopBelowBytes: 5e9, bytesPerSecond: 2e6 })).toBe('6 GB free, 8 m at this rate');
    expect(describeRecording({ folder: '/r/2026-11-06_120000_record', seconds: 0, reason: 'stopped', startedAt: 0, stoppedAt: 724_000, streams: [{ stream: 'pad', file: 'x' }] }))
      .toBe('recorded 12:04, 1 stream to recordings/2026-11-06_120000_record');
    expect(describeRecording({ folder: '/r/f', seconds: 0, reason: 'disk nearly full', streams: [{ stream: 'pad', file: 'x', gaps: 1 }] }))
      .toBe('recording ended early (disk nearly full) -- 1 stream to recordings/f; gaps (stream was down) in pad');
  });
});

describe('a Recording controls slot in the editor', () => {
  it('survives the round trip through draft keys', () => {
    const drafts = draftsFrom(loaded);
    const l = draftLayoutFrom({ preset: '2x2', slots: ['pad', '@controls', null, null] }, drafts);
    expect(layoutIds(l, drafts)).toEqual({ preset: '2x2', slots: ['pad', '@controls', null, null] });
  });
});

describe('zoom to fill in the editor', () => {
  it('is saved only when on, for either kind, and counts as a change', () => {
    const [d] = draftsFrom(loaded);
    expect(d.fill).toBe(false);
    expect('fill' in toSave([d]).streams[0]).toBe(false);
    expect(toSave([{ ...d, fill: true }]).streams[0]).toMatchObject({ fill: true });
    expect(toSave([{ ...d, kind: 'udp', port: '5600', fill: true }]).streams[0]).toEqual({ id: 'pad', label: 'Pad overview', kind: 'udp', port: 5600, record: true, fill: true });
    expect(isDirty([{ ...d, fill: true }], [d])).toBe(true);
  });

  it('loads as set', () => {
    const cfg = { ...loaded, streams: [{ ...loaded.streams[0], fill: true }] };
    expect(draftsFrom(cfg)[0].fill).toBe(true);
  });
});

describe('recording sizes', () => {
  it('read in the unit that fits', async () => {
    const { size } = await import('@/lib/video/api');
    expect([size(1_400_000_000), size(230_400_000), size(12_000), size(10)]).toEqual(['1.4 GB', '230 MB', '12 KB', '1 KB']);
  });
});
