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
  let best: VideoClip | null = null;
  for (const c of clips) {
    if (c.stream !== stream || t < c.start || t > c.end) continue;
    if (!best || rank(c) < rank(best) || (rank(c) === rank(best) && c.start < best.start)) best = c;
  }
  return best ? { clip: best, offset: t - best.start } : null;
}

const rank = (c: VideoClip) => (c.kind === 'record' ? 0 : 1);
