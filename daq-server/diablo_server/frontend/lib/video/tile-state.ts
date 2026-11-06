/**
 * What a video tile says about itself. LIVE is earned by frames, not by a connection: a
 * picture that has stopped moving is the most dangerous thing this page can show during a
 * press proof, because it looks exactly like a quiet live one. So a connected stream with no
 * new frame for STALE_MS is STALE (amber), and stays so until frames come back.
 *
 * Colours (the console's rule: colour only for meaning, red never on this page): green
 * live, amber stale, grey for everything else.
 */
import type { WhepState } from './whep';

export const STALE_MS = 2000;

export type TileStatus =
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'stale'; forMs: number }
  | { kind: 'offline'; reason: string };

export function tileStatus(conn: WhepState, lastFrameAt: number | null, now: number): TileStatus {
  if (conn.kind === 'failed') return { kind: 'offline', reason: conn.reason };
  if (conn.kind === 'connecting' || lastFrameAt === null) return { kind: 'connecting' };
  const age = now - lastFrameAt;
  return age > STALE_MS ? { kind: 'stale', forMs: age } : { kind: 'live' };
}

/** "STALE 4s", "STALE 2m" */
export function staleLabel(forMs: number): string {
  const s = Math.floor(forMs / 1000);
  return s < 120 ? `STALE ${s}s` : `STALE ${Math.floor(s / 60)}m`;
}
