/**
 * Video on the plot's timeline: which clip a camera shows at an instant, and where in it.
 *
 * Pure functions over the clip list the backend serves (GET /api/runs/<id>/video): times
 * are epoch seconds, the same axis the plot draws. Kept apart from the components so the
 * arithmetic that decides "what frame is this" can be tested on its own.
 */
import type { VideoClip } from './types';

/** The cameras with footage in this run, in a stable order. */
export function streamsOf(clips: VideoClip[]): string[] {
  return [...new Set(clips.map((c) => c.stream))].sort();
}

/** URL of a clip's file. Range-served, so the browser fetches only what it plays. */
export const clipUrl = (c: VideoClip) =>
  `/api/video/${encodeURIComponent(c.recording)}/${encodeURIComponent(c.stream)}.mp4`;

/** Same clip? (Changing `src` reloads the file, so only do it when this differs.) */
export const sameClip = (a: VideoClip | null, b: VideoClip | null) =>
  !!a && !!b && a.recording === b.recording && a.stream === b.stream;

/**
 * Where in `c`'s file the moment `t` is, in seconds, or null when the clip has no frame
 * then: before it, after it, or inside an outage it played straight through.
 */
export function fileOffset(c: VideoClip, t: number): number | null {
  const ps = c.pieces;
  for (let i = ps.length - 1; i >= 0; i--) {
    const p = ps[i];
    if (t < p.wall) continue;
    const len = (i + 1 < ps.length ? ps[i + 1].fileS : c.duration) - p.fileS;
    return t - p.wall <= len ? p.fileS + (t - p.wall) : null;
  }
  return null;
}

/**
 * The clip `stream` shows at time `t`, and the offset into it in seconds; null when that
 * camera has no footage then. Where clips overlap (a Save made during a Record holds the
 * same seconds), a Record wins, then the one that started first, so playback switches
 * file as rarely as possible.
 */
export function clipAt(
  clips: VideoClip[],
  stream: string,
  t: number,
): { clip: VideoClip; offset: number } | null {
  let best: { clip: VideoClip; offset: number } | null = null;
  for (const c of clips) {
    if (c.stream !== stream || t < c.start || t > c.end) continue;
    const offset = fileOffset(c, t);
    if (offset == null) continue;
    const b = best?.clip;
    if (!b || rank(c) < rank(b) || (rank(c) === rank(b) && c.start < b.start)) best = { clip: c, offset };
  }
  return best;
}

const rank = (c: VideoClip) => (c.kind === 'record' ? 0 : 1);

/** When the frame at `fileS` seconds into `c` was filmed (epoch seconds, DAQ clock). The
 *  inverse of fileOffset, for following a playing video with the playhead. */
export function fileToWall(c: VideoClip, fileS: number): number {
  let p = c.pieces[0];
  for (const q of c.pieces) if (q.fileS <= fileS) p = q;
  return p.wall + (fileS - p.fileS);
}

/** Seconds per frame of a clip, for the arrow keys. Every camera here is 30 fps or near
 *  it, so a clip whose header did not say steps as if it were. */
export const frameSeconds = (c: VideoClip | null | undefined) =>
  c?.frameS && c.frameS > 0 ? c.frameS : 1 / 30;

/** True while there is footage left to play from `offset` (the last frame is not
 *  "playable": playing from it would end at once, or restart the file). */
export const playable = (c: VideoClip, offset: number) => offset < c.duration - frameSeconds(c) / 2;

/**
 * During play, the window to page to when the playhead `t` has run past the right edge of
 * `view`: the next window of the same width, slid back to end at the run's end if it would
 * overrun. Null while the playhead is still in view (or the view is already at the end).
 */
export function pageForward(
  view: [number, number],
  bounds: [number, number],
  t: number,
): [number, number] | null {
  const [lo, hi] = view;
  if (t <= hi || hi >= bounds[1]) return null;
  const span = hi - lo;
  let start = Math.max(hi, t - span * 0.02); // a playhead that jumped far lands just inside
  let end = start + span;
  if (end > bounds[1]) [start, end] = [bounds[1] - span, bounds[1]];
  return [start, end];
}

/** Most cameras shown at once: each one decodes its own video. */
export const MAX_CAMERAS = 4;

/** The cameras a run opens with: the viewer's preferred one if this run has it, else the
 *  first that has footage. */
export function defaultCameras(streams: string[], preferred: string | null): string[] {
  if (preferred && streams.includes(preferred)) return [preferred];
  return streams.length ? [streams[0]] : [];
}

/** Turn a camera on or off, keeping the shown ones in picker order and at most
 *  MAX_CAMERAS; the last one cannot be turned off (there would be nothing to watch). */
export function toggleCamera(shown: string[], stream: string, order: string[]): string[] {
  if (shown.includes(stream)) return shown.length > 1 ? shown.filter((s) => s !== stream) : shown;
  if (shown.length >= MAX_CAMERAS) return shown;
  return order.filter((s) => s === stream || shown.includes(s));
}

/**
 * During play, the tile whose frames move the playhead: the first shown camera (in order)
 * with footage left to play at `t`. Null when none has, and the page clock carries it.
 */
export function leaderOf(shown: string[], clips: VideoClip[], t: number | null): string | null {
  if (t == null) return null;
  for (const s of shown) {
    const at = clipAt(clips, s, t);
    if (at && playable(at.clip, at.offset)) return s;
  }
  return null;
}

/** A follower is re-seeked only once it has drifted more than one of its own frames from
 *  where the leader says it should be: a seek costs a decode from the last keyframe. */
export const drifted = (current: number, wanted: number, frame: number) => Math.abs(current - wanted) > frame;

/** Breaks shorter than this between two stretches of footage are not shown as gaps: they
 *  are a segment boundary's few ms, not an outage anyone needs to see. */
const COVERAGE_JOIN_S = 0.5;

/**
 * Where camera `stream` has footage: [start, end] spans in epoch seconds, sorted, overlaps
 * (a Save and a Record of the same moment) merged, and the outages inside a clip left out.
 */
export function coverage(clips: VideoClip[], stream: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const c of clips) {
    if (c.stream !== stream) continue;
    c.pieces.forEach((p, i) => {
      const len = (i + 1 < c.pieces.length ? c.pieces[i + 1].fileS : c.duration) - p.fileS;
      if (len > 0) spans.push([p.wall, p.wall + len]);
    });
  }
  spans.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + COVERAGE_JOIN_S) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}
