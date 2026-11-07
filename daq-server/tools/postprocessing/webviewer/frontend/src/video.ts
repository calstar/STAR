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
