/**
 * The video agent's pure parts (daq-server/video/agent.mjs): reading MediaMTX's segment names
 * and choosing the segments that cover a Save. Its file work against real segments and ffmpeg
 * is in test/video-gateway.integration.test.ts.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain ESM, no types: it runs on the gateway machine with bare Node
import { countGaps, segmentStart, segmentsForWindow, stamp } from '../../../../video/agent.mjs';

const at = (h: number, m: number, s: number) => new Date(2026, 10, 6, h, m, s).getTime();
const name = (h: number, m: number, s: number) =>
  `2026-11-06_${String(h).padStart(2, '0')}-${String(m).padStart(2, '0')}-${String(s).padStart(2, '0')}-000000.mp4`;

describe('segment names', () => {
  it('read as local start times, microseconds included', () => {
    expect(segmentStart('2026-11-06_00-04-41-227264.mp4')).toBe(new Date(2026, 10, 6, 0, 4, 41, 227).getTime());
    expect(segmentStart('list.txt')).toBeNull();
    expect(segmentStart('2026-11-06_00-04-41.mp4')).toBeNull();
  });
});

describe('which segments a Save keeps', () => {
  // Segments every 10 s from 12:00:00; Save at 12:00:45 with a 20 s window -> from 12:00:25.
  const names = [0, 10, 20, 30, 40].map((s) => name(12, 0, s));

  it('everything starting in the window, plus the one already running when it opened', () => {
    expect(segmentsForWindow(names, at(12, 0, 45), 20_000)).toEqual([name(12, 0, 20), name(12, 0, 30), name(12, 0, 40)]);
  });

  it('a segment starting exactly at the window edge needs nothing before it', () => {
    expect(segmentsForWindow(names, at(12, 0, 50), 20_000)).toEqual([name(12, 0, 30), name(12, 0, 40)]);
  });

  it('a window inside one long segment keeps just that segment', () => {
    expect(segmentsForWindow(names, at(12, 0, 48), 5_000)).toEqual([name(12, 0, 40)]);
  });

  it('a buffer shorter than the window keeps all of it, in order, ignoring stray files', () => {
    expect(segmentsForWindow([...names].reverse().concat('list.txt'), at(12, 0, 45), 300_000)).toEqual(names);
  });

  it('nothing buffered keeps nothing', () => {
    expect(segmentsForWindow([], at(12, 0, 45), 20_000)).toEqual([]);
  });
});

describe('gaps in what was kept', () => {
  it('none in a steady run of segments, nor in a short last one', () => {
    expect(countGaps([0, 10, 20, 30, 40, 43].map((s) => name(12, 0, s)))).toBe(0);
  });

  it('a gateway or camera outage shows as a jump well past the usual spacing', () => {
    expect(countGaps([0, 10, 20, 52, 62, 72].map((s) => name(12, 0, s)))).toBe(1);
    expect(countGaps([0, 3, 6, 9, 30, 33, 36].map((s) => name(12, 0, s)))).toBe(1); // 3 s segments (tests)
  });
});

describe('folder names', () => {
  it('sort by time', () => {
    expect(stamp(new Date(2026, 10, 6, 9, 5, 3))).toBe('2026-11-06_090503');
  });
});
