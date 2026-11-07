/**
 * The video agent's pure parts (daq-server/video/agent.mjs): reading MediaMTX's segment names
 * and choosing the segments that cover a Save. Its file work against real segments and ffmpeg
 * is in test/video-gateway.integration.test.ts.
 */
import { describe, it, expect, afterAll } from 'vitest';
// @ts-expect-error -- plain ESM, no types: it runs on the gateway machine with bare Node
import { countGaps, createAgent, openerFor, segmentStart, segmentsForWindow, stamp, timingFor } from '../../../../video/agent.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

describe('the timing file: when each stretch of a kept file was filmed', () => {
  it('a steady run maps file time straight onto the segments\' own start times', () => {
    const t = timingFor([0, 10, 20].map((s) => name(12, 0, s)), [10, 10, 10], 30);
    expect(t.firstFrameMs).toBe(at(12, 0, 0));
    expect(t.pieces).toEqual([
      { fileS: 0, wallMs: at(12, 0, 0) },
      { fileS: 10, wallMs: at(12, 0, 10) },
      { fileS: 20, wallMs: at(12, 0, 20) },
    ]);
    expect(t).toMatchObject({ version: 1, durationS: 30, latencyMs: 0 });
  });

  it('the keyframe cut: the first frame is where the file starts, not the segment', () => {
    // Record pressed 4.5 s into the first segment; the concat kept from a keyframe at 4 s.
    const t = timingFor([0, 10].map((s) => name(12, 0, s)), [10, 10], 16);
    expect(t.firstFrameMs).toBe(at(12, 0, 4));
    expect(t.pieces).toEqual([
      { fileS: 0, wallMs: at(12, 0, 4) },
      { fileS: 6, wallMs: at(12, 0, 10) },
    ]);
  });

  it('an outage: frames after it keep their real time instead of sliding early', () => {
    // Camera dropped from 12:00:20 to 12:00:52; the file plays straight through the gap.
    const t = timingFor([0, 10, 52].map((s) => name(12, 0, s)), [10, 10, 10], 30);
    expect(t.pieces[2]).toEqual({ fileS: 20, wallMs: at(12, 0, 52) });
  });

  it('a short last segment (Stop mid-segment) changes nothing before it', () => {
    const t = timingFor([0, 10, 20].map((s) => name(12, 0, s)), [10, 10, 3.2], 23.2);
    expect(t.firstFrameMs).toBe(at(12, 0, 0));
    expect(t.pieces[2]).toEqual({ fileS: 20, wallMs: at(12, 0, 20) });
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

describe('the recordings list and Open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-agent-'));
  const rec = join(dir, 'recordings');
  const opened: string[] = [];
  const agent = createAgent({ videoDir: dir, openPath: async (p: string) => { opened.push(p); } });

  mkdirSync(join(rec, '2026-11-06_120000_save'), { recursive: true });
  writeFileSync(join(rec, '2026-11-06_120000_save', 'pad.mp4'), Buffer.alloc(1000));
  writeFileSync(join(rec, '2026-11-06_120000_save', 'eng.mp4'), Buffer.alloc(500));
  mkdirSync(join(rec, '2026-11-06_130500_record'), { recursive: true });
  writeFileSync(join(rec, '2026-11-06_130500_record', 'pad.mp4'), Buffer.alloc(2000));
  mkdirSync(join(rec, 'not-a-recording'), { recursive: true });

  it('lists recordings newest first, with their files and sizes, ignoring other folders', async () => {
    const { recordings, dir: where } = await agent.listRecordings();
    expect(where).toBe(rec);
    expect(recordings.map((r: any) => r.name)).toEqual(['2026-11-06_130500_record', '2026-11-06_120000_save']);
    expect(recordings[1]).toMatchObject({ kind: 'save', bytes: 1500, files: [{ stream: 'eng', bytes: 500 }, { stream: 'pad', bytes: 1000 }], active: false });
    expect(recordings[0].startedAt).toBe(new Date(2026, 10, 6, 13, 5, 0).getTime());
  });

  it('opens the folder, or one recording, and nothing else', async () => {
    await agent.openFolder(undefined);
    await agent.openFolder('2026-11-06_120000_save');
    expect(opened).toEqual([rec, join(rec, '2026-11-06_120000_save')]);
    for (const bad of ['../../etc', '/etc', 'not-a-recording', '2026-11-06_999999_save', 42]) {
      await expect(agent.openFolder(bad as any)).rejects.toThrow(/not a recording|no such recording/);
    }
    expect(opened).toHaveLength(2);
  });

  it('a machine with no file manager says so', async () => {
    const headless = createAgent({ videoDir: dir, openPath: async () => { throw new Error('xdg-open: no method available'); } });
    await expect(headless.openFolder(undefined)).rejects.toThrow(/could not open a file manager on this machine/);
  });

  it('uses Finder on macOS and xdg-open on Linux', () => {
    expect([openerFor('darwin'), openerFor('linux'), openerFor('win32')]).toEqual(['open', 'xdg-open', 'explorer']);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
