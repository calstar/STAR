'use client';

/**
 * Recordings: what Save and Record have kept, with a way to get at the files.
 *
 * The files are on the gateway machine (star-rfs at the workspace, the media Mac in the
 * desert), not necessarily the machine showing this page, and a browser cannot open a file
 * manager itself. So "Open" asks the video agent to open the folder in that machine's file
 * manager (Finder; xdg-open on Linux) -- useful when you are sitting at it. Elsewhere, the
 * folder path is shown to copy. Kept files are video only, one per stream.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  fetchVideoStreams, listRecordings, openRecording, size, VideoApiError, type RecordingEntry,
} from '@/lib/video/api';

const POLL_MS = 10_000;

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export default function RecordingsPage() {
  const [list, setList] = useState<{ dir: string; recordings: RecordingEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await listRecordings());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    fetchVideoStreams().then((d) => setHost(d.gateway.host)).catch(() => {});
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const open = async (name?: string) => {
    setOpening(name ?? '');
    try {
      await openRecording(name);
      setNote(`Opened in the file manager on ${where}.`);
    } catch (e) {
      setNote(e instanceof VideoApiError ? e.errors.join('; ') : String(e));
    } finally {
      setOpening(null);
    }
  };

  const where = !host || host === '127.0.0.1' || host === 'localhost' ? 'the DAQ server' : host;
  const recordings = list?.recordings ?? [];

  return (
    <main className="flex h-full flex-col overflow-auto bg-background p-4 text-text">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="mb-1 font-mono text-[15px] font-semibold uppercase tracking-[0.32em] text-ink">Recordings</h1>
          <p className="font-mono text-[11px] text-ink-3">
            On {where}{list ? <> · <span className="select-all text-ink-2">{list.dir}</span></> : null}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="ctl h-8 px-3 text-[10px] text-ink-2" onClick={() => void load()}>Refresh</button>
          <button type="button" className="ctl h-8 px-3 text-[10px]" disabled={opening !== null || !!error} onClick={() => void open()}>
            Open recordings folder
          </button>
        </div>
      </header>

      {note && <p className="mb-3 border border-line px-3 py-2 font-mono text-[11px] text-ink-2" role="status">{note}</p>}
      {error && <p className="mb-3 border border-line px-3 py-2 font-mono text-[11px] text-ink-2">Recordings unavailable: {error}</p>}

      {list && recordings.length === 0 ? (
        <div className="flex flex-1 items-center justify-center border border-line font-mono text-xs uppercase tracking-[0.18em] text-ink-3">
          No recordings yet -- Save or Record in the Video view
        </div>
      ) : (
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.18em] text-ink-3">
              <th className="py-2 pr-4 font-normal">When</th>
              <th className="py-2 pr-4 font-normal">Kind</th>
              <th className="py-2 pr-4 font-normal">Streams</th>
              <th className="py-2 pr-4 text-right font-normal">Size</th>
              <th className="py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {recordings.map((r) => (
              <tr key={r.name} className="border-b border-line align-top" data-testid={`recording-${r.name}`}>
                <td className="py-2 pr-4 text-ink">{when(r.startedAt)}</td>
                <td className="py-2 pr-4 uppercase tracking-[0.12em] text-ink-2">
                  {r.active ? <span className="flex items-center gap-1.5 text-ink"><span className="h-1.5 w-1.5 rounded-full bg-white" />recording</span> : r.kind}
                </td>
                <td className="py-2 pr-4 text-ink-2">
                  {r.files.length ? r.files.map((f) => f.stream).join(', ') : <span className="text-ink-3">{r.active ? 'in progress' : 'none'}</span>}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-ink-2">{r.bytes ? size(r.bytes) : '--'}</td>
                <td className="py-2 text-right">
                  <button type="button" className="ctl h-6 px-2 text-[10px] text-ink-2" disabled={opening !== null} onClick={() => void open(r.name)}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
