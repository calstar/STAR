'use client';

/**
 * The VIDCOMM video view: the configured streams, live over WebRTC from the video gateway,
 * and nothing else. The app header is suppressed for this route (TopBarWrapper) so the
 * whole window is picture; tiles meet at a hairline with no padding.
 *
 * Layout: the stand layout from config/video.json (a preset and a stream per slot), with
 * this operator's own changes on top -- swap a slot's stream from the tile's picker, or
 * double-click a tile to focus it (again, or Esc, to go back). Those live in this browser
 * only (lib/video/operator-layout) and "Reset layout" drops them; they are also dropped when
 * VIDCOMM changes the stand layout. Large slots and focus play a stream's main URL; small
 * ones its low-res URL when it has one.
 *
 * The only chrome is a small control in the bottom-right corner (every tile keeps its label
 * top-left and its picker bottom-left, so that corner covers nothing) -- Edit, layout reset, the way
 * back to the other views, pop-out, and the gateway's state -- which appears when the mouse
 * moves and fades after IDLE_MS. A problem (gateway or backend unreachable, a bad config)
 * keeps it shown. Edit opens the stream editor beside the grid (components/video/
 * StreamEditor); the grid shows its draft layout, and only Save changes what anyone sees.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import VideoTile from '@/components/video/VideoTile';
import StreamEditor from '@/components/video/StreamEditor';
import RecordingPanel from '@/components/video/RecordingPanel';
import { useWindowManager } from '@/components/windows/WindowManager';
import { isPopupWindow } from '@/lib/is-popup';
import { clock, fetchVideoStreams, type VideoStreamInfo, type VideoStreamsResponse } from '@/lib/video/api';
import { CONTROLS_SLOT, effectiveLayout, fingerprint, withFocus, withSlot, type Cell, type VideoLayout } from '@/lib/video/layout';
import { useRecording } from '@/lib/video/use-recording';
import { useOperatorLayout } from '@/lib/video/operator-layout';
import { streamEndpoint } from '@/lib/video/whep';

const POLL_MS = 5000;
const IDLE_MS = 2500;

/** True for IDLE_MS after the pointer last moved over the page. */
function usePointerActive(): [boolean, () => void] {
  const [active, setActive] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const poke = useCallback(() => {
    setActive(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setActive(false), IDLE_MS);
  }, []);
  useEffect(() => {
    poke();
    return () => clearTimeout(timer.current);
  }, [poke]);
  return [active, poke];
}

/** The per-tile stream picker: an operator's own swap. Shown only on the hovered tile, and
 *  only while the cursor is moving -- it fades with the corner controls -- unless its list is
 *  open (focus). */
function SlotPicker({ value, streams, active, onPick }: {
  value: string | null;
  streams: VideoStreamInfo[];
  /** The cursor moved recently (the same clock as the corner controls). */
  active: boolean;
  onPick: (id: string | null) => void;
}) {
  return (
    <select
      aria-label="Stream in this slot"
      className={`absolute bottom-2 left-2 max-w-[40%] border border-line-strong bg-black/80 px-1 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-2 opacity-0 transition-opacity duration-300 focus:opacity-100 ${active ? 'group-hover:opacity-100' : ''}`}
      value={value ?? ''}
      onChange={(e) => onPick(e.target.value || null)}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <option value="">Empty</option>
      {streams.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      <option value={CONTROLS_SLOT}>Recording controls</option>
    </select>
  );
}

/**
 * React keys for the grid's cells, by the stream they show (the nth showing of it), so a
 * stream that moves to another slot keeps its connection instead of reconnecting.
 */
function cellKeys(slots: (string | null)[], n: number): string[] {
  const seen = new Map<string, number>();
  return Array.from({ length: n }, (_, i) => {
    const id = slots[i] ?? `empty`;
    const k = (seen.get(id) ?? 0) + 1;
    seen.set(id, k);
    return `${id}#${k}`;
  });
}

function cellStyle(c: Cell) {
  return { gridColumn: `${c.col + 1} / span ${c.colSpan}`, gridRow: `${c.row + 1} / span ${c.rowSpan}` };
}

export default function VideoPage() {
  const [data, setData] = useState<VideoStreamsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, poke] = usePointerActive();
  const { openWindow } = useWindowManager();
  const popup = isPopupWindow();
  const [editing, setEditing] = useState(false);
  const [draftLayout, setDraftLayout] = useState<VideoLayout | null>(null);
  const [override, setOverride] = useOperatorLayout();
  const load = useCallback((signal?: AbortSignal) =>
    fetchVideoStreams(signal)
      .then((d) => { setData(d); setLoadError(null); })
      .catch((e) => { if (!signal?.aborted) setLoadError(e instanceof Error ? e.message : String(e)); }), []);

  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    const t = setInterval(() => void load(ctl.signal), POLL_MS);
    return () => { ctl.abort(); clearInterval(t); };
  }, [load]);

  const r = useRecording(data?.buffer, useCallback(() => void load(), [load]));
  const streams = useMemo(() => data?.streams ?? [], [data]);
  const included = streams.filter((s) => s.record).length;
  const ids = useMemo(() => streams.map((s) => s.id), [streams]);
  const byId = useMemo(() => new Map(streams.map((s) => [s.id, s])), [streams]);
  const stand: VideoLayout = useMemo(() => data?.layout ?? { preset: 'auto', slots: [] }, [data]);

  // While editing, the grid shows the editor's draft, untouched by this operator's changes.
  const shown = editing && draftLayout ? draftLayout : stand;
  const eff = effectiveLayout(shown, ids, editing ? null : override);

  // The stand layout moved on: this operator's changes no longer apply, so forget them.
  useEffect(() => {
    if (data && override && override.base !== fingerprint(stand, ids)) setOverride(null);
  }, [data, override, stand, ids, setOverride]);

  const setFocus = useCallback((id: string | null) => setOverride(withFocus(stand, ids, override, id)), [stand, ids, override, setOverride]);

  useEffect(() => {
    if (!eff.focus) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocus(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [eff.focus, setFocus]);

  const where = data && data.gateway.host !== '127.0.0.1' ? ` (${data.gateway.host})` : '';
  const problem = loadError
    ? 'backend unreachable'
    : data && !data.gateway.reachable
      ? /refused the password/.test(data.gateway.error ?? '')
        ? `gateway refused the password${where}`
        : `gateway unreachable${where}`
      : null;
  const empty = !!data && streams.length === 0;
  // Only while the cursor moves (or with nothing to show yet, so Edit can be found): the
  // picture is the point. Problems are not lost when it fades -- each tile names its own.
  const showControls = !editing && (active || empty);
  const buffer = data?.buffer;
  const bufferMin = buffer?.bufferSeconds ? Math.round(buffer.bufferSeconds / 60) : 5;
  const recording = !!buffer?.recording?.active;
  const focused = eff.focus ? byId.get(eff.focus) : undefined;

  const tileFor = (id: string | null, large: boolean, slot: number | null) => {
    const s = id ? byId.get(id) : undefined;
    const picker = slot !== null && !editing && (
      <SlotPicker value={id} streams={streams} active={active} onPick={(v) => setOverride(withSlot(stand, ids, override, slot, v))} />
    );
    if (id === CONTROLS_SLOT) return <RecordingPanel r={r} total={included}>{picker}</RecordingPanel>;
    if (!s) {
      return (
        <div className="group relative flex items-center justify-center bg-black font-mono text-[10px] uppercase tracking-[0.18em] text-ink-4" data-testid={slot !== null ? `video-slot-${slot}` : undefined}>
          Empty
          {picker}
        </div>
      );
    }
    return (
      <VideoTile
        label={s.label}
        endpoint={streamEndpoint(s.id, !large && s.hasLowRes)}
        testId={`video-tile-${s.id}`}
        recording={r.streams.has(s.id) ? r.elapsed : null}
        fill={s.fill}
        onDoubleClick={editing ? undefined : () => setFocus(eff.focus ? null : s.id)}
      >
        {picker}
      </VideoTile>
    );
  };

  return (
    <main className="flex h-full min-h-0 flex-1 overflow-hidden bg-black text-text">
      <div className="relative min-w-0 flex-1" onMouseMove={poke} onPointerDown={poke}>
        {empty ? (
          <div className="flex h-full items-center justify-center font-mono text-xs uppercase tracking-[0.18em] text-ink-3">
            No streams configured -- Edit to add one
          </div>
        ) : focused ? (
          <div className="grid h-full" data-testid="video-focus">{tileFor(focused.id, true, null)}</div>
        ) : (
          <div
            className="grid h-full gap-px bg-line"
            data-testid="video-grid"
            data-preset={shown.preset}
            style={{
              gridTemplateColumns: `repeat(${eff.geometry.cols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${eff.geometry.rows}, minmax(0, 1fr))`,
            }}
          >
            {cellKeys(eff.slots, eff.geometry.cells.length).map((key, i) => {
              const c = eff.geometry.cells[i];
              return (
                <div key={key} className="grid min-h-0 min-w-0 bg-black" style={cellStyle(c)}>
                  {tileFor(eff.slots[i] ?? null, c.large, shown.preset === 'auto' ? null : i)}
                </div>
              );
            })}
            {/* An even 'auto' grid can end short of its last row; keep the gaps black. */}
            {Array.from({ length: eff.geometry.cols * eff.geometry.rows - eff.geometry.cells.reduce((n, c) => n + c.colSpan * c.rowSpan, 0) }, (_, i) => (
              <div key={`empty-${i}`} className="bg-black" />
            ))}
          </div>
        )}

        <div
          className={`absolute bottom-2 right-2 z-10 flex flex-col-reverse items-end gap-1 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        >
          <div className="flex items-center gap-1 bg-black/80 font-mono text-[10px] uppercase tracking-[0.18em]">
            {/* Said only when something is wrong: a healthy gateway needs no words on the picture. */}
            {problem && (
              <span className="px-2 py-1 text-ink" title={data?.gateway.error ?? loadError ?? undefined}>{problem}</span>
            )}
            {focused && (
              <button type="button" className="ctl h-6 px-2 text-[10px] text-ink-2" onClick={() => setFocus(null)}>
                Back to grid
              </button>
            )}
            {eff.overridden && (
              <button type="button" className="ctl h-6 px-2 text-[10px] text-ink-2" title="Drop your own changes and show the stand layout" onClick={() => setOverride(null)}>
                Reset layout
              </button>
            )}
            {recording && (
              <span className="flex items-center gap-1.5 px-2 py-1 text-ink" data-testid="corner-rec">
                <span className="h-1.5 w-1.5 rounded-full bg-white" aria-hidden />
                REC {clock(r.elapsed ?? 0)} · {buffer?.recording?.streams?.length ?? 0} of {included}
              </span>
            )}
            {recording ? (
              <button type="button" className="ctl h-6 px-2 text-[10px] text-ink" disabled={!!r.busy || buffer?.recording?.stopping} onClick={() => void r.stop()}>
                {r.busy === 'stop' || buffer?.recording?.stopping ? 'Stopping' : 'Stop'}
              </button>
            ) : (
              <button
                type="button"
                className="ctl h-6 px-2 text-[10px] text-ink-2"
                disabled={!!r.busy || !buffer?.available || included === 0}
                title={buffer?.available ? 'Record every stream marked "include in recording" until Stop, on the gateway machine' : buffer?.error}
                onClick={() => void r.record()}
              >
                {r.busy === 'record' ? 'Starting' : 'Record'}
              </button>
            )}
            <button
              type="button"
              className="ctl h-6 px-2 text-[10px] text-ink-2"
              disabled={!!r.busy || !buffer?.available || included === 0}
              title={buffer?.available ? `Keep the last ${bufferMin} minutes of every stream marked "include in recording", on the gateway machine` : buffer?.error}
              onClick={() => void r.save()}
            >
              {r.busy === 'save' ? 'Saving' : `Save last ${bufferMin} min`}
            </button>
            <button type="button" className="ctl h-6 px-2 text-[10px] text-ink-2" onClick={() => setEditing(true)}>
              Edit
            </button>
            {!popup && (
              <>
                <button type="button" className="ctl h-6 px-2 text-[10px] text-ink-2" onClick={() => openWindow('popout:/video', 'Video', '/video')}>
                  Pop out
                </button>
                <Link to="/views" className="ctl h-6 px-2 text-[10px] text-ink-2">Views</Link>
              </>
            )}
          </div>
          {r.note && (
            <div className="max-w-xl bg-black/80 px-2 py-1 font-mono text-[11px] text-ink">{r.note}</div>
          )}
          {data && data.errors.length > 0 && (
            <ul className="max-w-md bg-black/80 px-2 py-1 font-mono text-[11px] text-ink-2">
              {data.errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
        </div>
      </div>
      {editing && (
        <StreamEditor
          onClose={() => setEditing(false)}
          onSaved={() => { setOverride(null); void load(); }}
          onDraftLayout={setDraftLayout}
        />
      )}
    </main>
  );
}
