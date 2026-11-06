/** The stream editor's rules (lib/video/editor.ts): ids from labels, and what a save sends. */
import { describe, it, expect } from 'vitest';
import { draftsFrom, isDirty, newDraft, slugId, toSave, withLabel } from '@/lib/video/editor';

const loaded = {
  revision: 'r1',
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
