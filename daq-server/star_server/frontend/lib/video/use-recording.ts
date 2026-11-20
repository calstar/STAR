/**
 * Record / Stop / Save from the Video view, shared by the corner control and the Recording
 * controls panel (a layout slot), so the two never disagree. The state itself is the video
 * agent's (on the gateway machine), read with every /api/video/streams poll; this hook adds
 * the button actions, a note about the last action, and a ticking clock for REC.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  describeRecording, describeSave, saveBuffer, startRecording, stopRecording, type BufferStatus,
} from './api';

const NOTE_MS = 8000;

export interface Recording {
  buffer: BufferStatus | undefined;
  /** Seconds since Record, ticking locally between polls (null when not recording). */
  elapsed: number | null;
  /** Streams being recorded. */
  streams: Set<string>;
  busy: 'save' | 'record' | 'stop' | null;
  note: string | null;
  save: () => Promise<void>;
  record: () => Promise<void>;
  stop: () => Promise<void>;
}

export function useRecording(buffer: BufferStatus | undefined, reload: () => void): Recording {
  const [busy, setBusy] = useState<Recording['busy']>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const rec = buffer?.recording;

  useEffect(() => {
    if (!rec?.active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [rec?.active]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);

  const act = useCallback(async (kind: NonNullable<Recording['busy']>, fn: () => Promise<string>) => {
    setBusy(kind);
    try {
      setNote(await fn());
    } catch (e) {
      setNote(`${kind} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
      reload();
    }
  }, [reload]);

  return {
    buffer,
    elapsed: rec?.active && rec.startedAt ? Math.max(0, (now - rec.startedAt) / 1000) : null,
    streams: new Set(rec?.active ? rec.streams ?? [] : []),
    busy,
    note,
    save: () => act('save', async () => describeSave(await saveBuffer())),
    record: () => act('record', async () => {
      const r = await startRecording();
      return `recording ${r.streams.length} stream${r.streams.length === 1 ? '' : 's'}`;
    }),
    stop: () => act('stop', async () => describeRecording(await stopRecording())),
  };
}
