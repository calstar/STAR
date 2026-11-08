import { describe, expect, it } from 'vitest';
import { MAX_CAMERAS, clipAt, coverage, clipUrl, defaultCameras, drifted, fileOffset, fileToWall, frameSeconds, leaderOf, pageForward, playable, sameClip, streamsOf, toggleCamera } from './video';
import type { VideoClip } from './types';

const clip = (stream: string, kind: string, start: number, duration: number, recording = `r${start}_${kind}`): VideoClip => ({
  recording, kind, stream, start, end: start + duration, duration, approx: true,
  pieces: [{ fileS: 0, wall: start }], clockOffset: null, clockUncertainty: null, frameS: 1 / 30,
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
    pieces: [{ fileS: 0, wall: 1000 }, { fileS: 20, wall: 1052 }], clockOffset: null, clockUncertainty: null, frameS: null,
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

  it('a playing file maps back onto the timeline, jumping the outage it played through', () => {
    expect(fileToWall(c, 0)).toBe(1000);
    expect(fileToWall(c, 19.5)).toBe(1019.5);
    expect(fileToWall(c, 20)).toBe(1052);
    expect(fileToWall(c, 25)).toBe(1057);
    for (const t of [1003, 1019, 1052, 1061]) expect(fileToWall(c, fileOffset(c, t)!)).toBe(t);
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

describe('playback', () => {
  it('steps by the clip\'s own frame period, or 1/30 s when it has none', () => {
    expect(frameSeconds(clip('a', 'record', 0, 10))).toBe(1 / 30);
    expect(frameSeconds({ ...clip('a', 'record', 0, 10), frameS: 0.04 })).toBe(0.04);
    expect(frameSeconds({ ...clip('a', 'record', 0, 10), frameS: null })).toBe(1 / 30);
    expect(frameSeconds(null)).toBe(1 / 30);
  });

  it('the last frame is not somewhere to play from', () => {
    const c = clip('a', 'record', 0, 10);
    expect(playable(c, 9.9)).toBe(true);
    expect(playable(c, 9.99)).toBe(false);
    expect(playable(c, 10)).toBe(false);
  });

  describe('paging the plot while playing', () => {
    const bounds: [number, number] = [0, 100];
    it('nothing while the playhead is in view', () => {
      expect(pageForward([10, 20], bounds, 15)).toBeNull();
      expect(pageForward([10, 20], bounds, 20)).toBeNull();
    });
    it('one window forward, same width, once it runs off the right', () => {
      expect(pageForward([10, 20], bounds, 20.05)).toEqual([20, 30]);
    });
    it('a playhead that jumped (an outage) lands just inside the new window', () => {
      const [s, e] = pageForward([10, 20], bounds, 50)!;
      expect(e - s).toBeCloseTo(10);
      expect(s).toBeLessThan(50);
      expect(s).toBeGreaterThan(49);
    });
    it('slides back to end at the run\'s end, and stops there', () => {
      expect(pageForward([85, 95], bounds, 95.1)).toEqual([90, 100]);
      expect(pageForward([90, 100], bounds, 100.5)).toBeNull();
    });
  });
});

describe('several cameras', () => {
  it('open on the preferred camera if the run has it, else the first with footage', () => {
    expect(defaultCameras(['a', 'b', 'c'], 'b')).toEqual(['b']);
    expect(defaultCameras(['a', 'b', 'c'], 'zz')).toEqual(['a']);
    expect(defaultCameras(['a', 'b', 'c'], null)).toEqual(['a']);
    expect(defaultCameras([], 'a')).toEqual([]);
  });

  it('turning cameras on keeps picker order, stops at four, and never empties', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    expect(toggleCamera(['c'], 'a', order)).toEqual(['a', 'c']);
    expect(toggleCamera(['a', 'b', 'c', 'd'], 'e', order)).toEqual(['a', 'b', 'c', 'd']);
    expect(toggleCamera(['a', 'c'], 'a', order)).toEqual(['c']);
    expect(toggleCamera(['a'], 'a', order)).toEqual(['a']);
    expect(MAX_CAMERAS).toBe(4);
  });

  it('the leader is the first shown camera with footage left to play', () => {
    const clips = [clip('a', 'record', 100, 10), clip('b', 'record', 95, 30)];
    expect(leaderOf(['a', 'b'], clips, 105)).toBe('a');
    expect(leaderOf(['b', 'a'], clips, 105)).toBe('b');
    // a's footage is over (or on its last frame): b leads.
    expect(leaderOf(['a', 'b'], clips, 110)).toBe('b');
    expect(leaderOf(['a', 'b'], clips, 112)).toBe('b');
    // Nobody has footage: the page clock carries the playhead.
    expect(leaderOf(['a', 'b'], clips, 200)).toBeNull();
    expect(leaderOf(['a'], clips, null)).toBeNull();
  });

  it('a follower is re-seeked only past one frame of drift', () => {
    expect(drifted(10.02, 10, 1 / 30)).toBe(false);
    expect(drifted(10.04, 10, 1 / 30)).toBe(true);
    expect(drifted(9.96, 10, 1 / 30)).toBe(true);
  });
});

describe('coverage bands', () => {
  it('one span per stretch of footage, sorted, other cameras ignored', () => {
    const clips = [clip('a', 'record', 200, 10), clip('a', 'record', 100, 10), clip('b', 'record', 150, 10)];
    expect(coverage(clips, 'a')).toEqual([[100, 110], [200, 210]]);
    expect(coverage(clips, 'b')).toEqual([[150, 160]]);
    expect(coverage(clips, 'c')).toEqual([]);
  });

  it('a Save and a Record of the same moment are one span', () => {
    expect(coverage([clip('a', 'save', 50, 60), clip('a', 'record', 100, 30)], 'a')).toEqual([[50, 130]]);
  });

  it('an outage inside a clip is a gap; a segment boundary\'s few ms is not', () => {
    const c: VideoClip = {
      ...clip('a', 'record', 1000, 30),
      end: 1062,
      pieces: [{ fileS: 0, wall: 1000 }, { fileS: 10, wall: 1010.02 }, { fileS: 20, wall: 1052 }],
    };
    expect(coverage([c], 'a')).toEqual([[1000, 1020.02], [1052, 1062]]);
  });
});
