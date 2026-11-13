'use client';

/**
 * The recording controls as a tile: put "Recording controls" in any slot (Edit's layout, or
 * a tile's own picker) and Record, Stop and Save sit in the grid, always visible -- no menu
 * to open, nothing that fades.
 *
 * Monochrome, as the page is: REC is white, never red (red belongs to the stand).
 */
import type { ReactNode } from 'react';
import { clock, diskLeft } from '@/lib/video/api';
import type { Recording } from '@/lib/video/use-recording';

export default function RecordingPanel({ r, total, children }: {
  r: Recording;
  /** Streams marked "include in recording" (what Record and Save take). */
  total: number;
  /** The slot picker, so the panel can be swapped back to a stream. */
  children?: ReactNode;
}) {
  const b = r.buffer;
  const rec = b?.recording;
  const recording = !!rec?.active;
  const down = !b?.available;
  const bufferMin = b?.bufferSeconds ? Math.round(b.bufferSeconds / 60) : 5;
  const disk = b ? diskLeft(b) : null;
  const btn = 'ctl h-9 min-w-[7rem] px-3 text-[11px]';

  return (
    <section className="group relative flex min-h-0 min-w-0 flex-col justify-center gap-4 overflow-auto bg-black p-5 font-mono" data-testid="recording-panel" aria-label="Recording controls">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.32em] text-ink">Recording</h2>
        {recording ? (
          <span className="flex items-center gap-1.5 text-[13px] uppercase tracking-[0.18em] text-ink" data-testid="rec-clock">
            <span className="h-2 w-2 rounded-full bg-white" aria-hidden />
            {rec?.stopping ? 'Stopping' : `REC ${clock(r.elapsed ?? 0)}`}
          </span>
        ) : (
          <span className="text-[11px] uppercase tracking-[0.18em] text-ink-3">{down ? 'unavailable' : 'not recording'}</span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {recording ? (
          <button type="button" className={`${btn} text-ink`} disabled={!!r.busy || rec?.stopping} onClick={() => void r.stop()}>
            {r.busy === 'stop' || rec?.stopping ? 'Stopping' : 'Stop'}
          </button>
        ) : (
          <button type="button" className={`${btn} text-ink`} disabled={!!r.busy || down || total === 0} title={down ? b?.error : undefined} onClick={() => void r.record()}>
            {r.busy === 'record' ? 'Starting' : '● Record'}
          </button>
        )}
        <button type="button" className={`${btn} text-ink-2`} disabled={!!r.busy || down || total === 0} title={down ? b?.error : undefined} onClick={() => void r.save()}>
          {r.busy === 'save' ? 'Saving' : `Save last ${bufferMin} min`}
        </button>
      </div>

      <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="uppercase tracking-[0.18em] text-ink-3">Streams</dt>
        <dd className="text-ink-2">{recording ? `${rec?.streams?.length ?? 0} of ${total} recording` : `${total} included`}</dd>
        <dt className="uppercase tracking-[0.18em] text-ink-3">Disk</dt>
        <dd className="text-ink-2">{disk ?? (down ? b?.error : '--')}</dd>
        {r.note && (
          <>
            <dt className="uppercase tracking-[0.18em] text-ink-3">Last</dt>
            <dd className="text-ink" role="status">{r.note}</dd>
          </>
        )}
      </dl>
      {children}
    </section>
  );
}
