/**
 * Records which firmware each board was running, per run.
 *
 * Append-only `<dbDir>/firmware.jsonl`, one line per board per distinct digest,
 * following lc-tare.ts: each line is a thing that happened, and nothing is ever
 * rewritten. The question this answers is the one you ask after a bad run --
 * "what was board 21 running during daq_20261109_170800?" -- and it answers it
 * without Elodin, from a file sitting next to the run's data.
 *
 * Why not just the time series: daq_bridge publishes the digest to Elodin
 * [0x11, board_id] only when it changes, which is the right call for storage but
 * means the value lives in a component a reader has to go looking for. This file
 * is the run's own answer, beside `<dbDir>.toml` (the config snapshot) and
 * `lc_tare.jsonl`.
 *
 * No active session means no record -- the board's firmware is still shown live
 * in the Boards pane, it just is not pinned to a run that does not exist.
 */
import * as fs from 'fs';
import * as path from 'path';

import { loadSession } from './session-state.js';

/** What we have already written this run, so a 1 Hz heartbeat cannot spam the file. */
const written = new Map<number, string>();
let writtenDbDir: string | null = null;

export function resetFirmwareLog(): void {
  written.clear();
  writtenDbDir = null;
}

/**
 * Note that `boardId` is running `digest`. Writes a line only the first time a
 * (board, digest) pair is seen in a run; safe to call on every heartbeat.
 */
export function recordFirmware(boardId: number, digest: string, type: string): void {
  const session = loadSession();
  const dbDir = session?.active ? session.dbDir : null;
  if (!dbDir) return;

  // A new run starts a new file, so forget what the previous one held.
  if (dbDir !== writtenDbDir) {
    written.clear();
    writtenDbDir = dbDir;
  }
  if (written.get(boardId) === digest) return;
  written.set(boardId, digest);

  const line = JSON.stringify({
    boardId,
    type,
    digest,
    seenAtMs: Date.now(),
  });
  try {
    fs.mkdirSync(dbDir, { recursive: true });
    fs.appendFileSync(path.join(dbDir, 'firmware.jsonl'), line + '\n');
  } catch (err) {
    // Never let bookkeeping break ingestion.
    console.warn('[ThinServer] ⚠️ Failed to append firmware.jsonl:', err);
  }
}
