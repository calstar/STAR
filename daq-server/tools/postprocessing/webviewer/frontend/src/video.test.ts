import { describe, expect, it } from 'vitest';
import { clipAt, clipUrl, fileOffset, sameClip, streamsOf } from './video';
import type { VideoClip } from './types';

const clip = (stream: string, kind: string, start: number, duration: number, recording = `r${start}_${kind}`): VideoClip => ({
  recording, kind, stream, start, end: start + duration, duration, approx: true,
  pieces: [{ fileS: 0, wall: start }], clockOffset: null, clockUncertainty: null,
});

describe('clipAt', () => {
  const clips = [
    clip('cam1', 'record', 100, 30),
    clip('cam2', 'record', 100, 30),
    clip('cam1', 'record', 200, 10),
  ];

  it('finds the clip covering the instant and the offset into it', () => {
    expect(clipAt(clips, 'cam1', 112.5)).toEqual({ clip: clips[0], offset: 12.5 });
    expect(clipAt(clips, 'cam1', 205)).toEqual({ clip: clips[2], offset: 5 });
  });

  it('includes both ends of a clip', () => {
    expect(clipAt(clips, 'cam1', 100)?.offset).toBe(0);
    expect(clipAt(clips, 'cam1', 130)?.offset).toBe(30);
  });

  it('has nothing between clips, before them, after them, or for another camera', () => {
    expect(clipAt(clips, 'cam1', 150)).toBeNull();
    expect(clipAt(clips, 'cam1', 99.9)).toBeNull();
    expect(clipAt(clips, 'cam1', 211)).toBeNull();
    expect(clipAt(clips, 'cam3', 110)).toBeNull();
  });

  it('prefers a Record over a Save covering the same moment, whichever is listed first', () => {
    const save = clip('cam1', 'save', 50, 300);
    const rec = clip('cam1', 'record', 100, 30);
    expect(clipAt([save, rec], 'cam1', 110)?.clip).toBe(rec);
    expect(clipAt([rec, save], 'cam1', 110)?.clip).toBe(rec);
    // Outside the Record, the Save is what there is.
    expect(clipAt([save, rec], 'cam1', 60)?.clip).toBe(save);
  });

  it('between two clips of the same kind, the earlier-started one plays', () => {
    const a = clip('cam1', 'save', 0, 300);
    const b = clip('cam1', 'save', 60, 300);
    expect(clipAt([b, a], 'cam1', 100)?.clip).toBe(a);
  });
});

describe('a clip with an outage in it (timing file pieces)', () => {
  // 20 s filmed from t=1000, the camera dropped for 32 s, then 10 s more from t=1052.
  const c: VideoClip = {
    recording: 'r', kind: 'record', stream: 'cam1', start: 1000, end: 1062, duration: 30, approx: false,
    pieces: [{ fileS: 0, wall: 1000 }, { fileS: 20, wall: 1052 }], clockOffset: null, clockUncertainty: null,
  };

  it('maps a moment after the outage to where the file really has it', () => {
    expect(fileOffset(c, 1055)).toBe(23);
    expect(fileOffset(c, 1052)).toBe(20);
    expect(fileOffset(c, 1062)).toBe(30);
  });

  it('before the outage, file time is wall time from the start', () => {
    expect(fileOffset(c, 1012.5)).toBe(12.5);
    expect(fileOffset(c, 1020)).toBe(20);
  });

  it('inside the outage there is no frame, rather than the wrong one', () => {
    expect(fileOffset(c, 1021)).toBeNull();
    expect(fileOffset(c, 1051.9)).toBeNull();
    expect(clipAt([c], 'cam1', 1030)).toBeNull();
  });

  it('outside the clip there is nothing either', () => {
    expect(fileOffset(c, 999)).toBeNull();
    expect(fileOffset(c, 1062.1)).toBeNull();
  });
});

describe('helpers', () => {
  it('lists each camera once, sorted', () => {
    expect(streamsOf([clip('b', 'record', 0, 1), clip('a', 'record', 0, 1), clip('b', 'save', 5, 1)])).toEqual(['a', 'b']);
  });

  it('builds an escaped file URL', () => {
    expect(clipUrl(clip('cam 1', 'record', 0, 1, '2026-11-07_140322_record'))).toBe(
      '/api/video/2026-11-07_140322_record/cam%201.mp4',
    );
  });

  it('compares clips by recording and stream', () => {
    const a = clip('cam1', 'record', 0, 1, 'x');
    expect(sameClip(a, { ...a })).toBe(true);
    expect(sameClip(a, { ...a, stream: 'cam2' })).toBe(false);
    expect(sameClip(a, null)).toBe(false);
  });
});
