'use client';

/**
 * The VIDCOMM video view: every configured stream, live over WebRTC from the video gateway,
 * and nothing else. The app header is suppressed for this route (TopBarWrapper) so the
 * whole window is picture; tiles meet at a hairline with no padding.
 *
 * The only chrome is a small control in the top-right corner -- the way back to the other
 * views, pop-out, and the gateway's state -- which appears when the mouse moves and fades
 * after IDLE_MS. A problem (gateway or backend unreachable, a bad config) keeps it shown.
 *
 * Streams come from the backend (config/video.json); the page re-reads them every few
 * seconds, so a stream added on the server or a gateway coming back shows up on its own.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import VideoTile from '@/components/video/VideoTile';
import { useWindowManager } from '@/components/windows/WindowManager';
import { isPopupWindow } from '@/lib/is-popup';
import { fetchVideoStreams, type VideoStreamsResponse } from '@/lib/video/api';

const POLL_MS = 5000;
const IDLE_MS = 2500;

/** Columns for an even grid of n tiles. */
function columnsFor(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}

/** True for IDLE_MS after the pointer last moved over the page. */
function usePointerActive(): [boolean, () => void] {
  const [active, setActive] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const poke = () => {
    setActive(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setActive(false), IDLE_MS);
  };
  useEffect(() => {
    poke();
    return () => clearTimeout(timer.current);
  }, []);
  return [active, poke];
}

export default function VideoPage() {
  const [data, setData] = useState<VideoStreamsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, poke] = usePointerActive();
  const { openWindow } = useWindowManager();
  const popup = isPopupWindow();

  useEffect(() => {
    const ctl = new AbortController();
    const load = () =>
      fetchVideoStreams(ctl.signal)
        .then((d) => { setData(d); setLoadError(null); })
        .catch((e) => { if (!ctl.signal.aborted) setLoadError(e instanceof Error ? e.message : String(e)); });
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { ctl.abort(); clearInterval(t); };
  }, []);

  const streams = data?.streams ?? [];
  const cols = columnsFor(streams.length);
  const rows = Math.max(1, Math.ceil(streams.length / cols));

  const problem = loadError
    ? 'backend unreachable'
    : data && !data.gateway.reachable
      ? 'gateway unreachable'
      : null;
  const showControls = active || !!problem || (data?.errors.length ?? 0) > 0;

  return (
    <main className="relative h-full min-h-0 flex-1 overflow-hidden bg-black text-text" onMouseMove={poke} onPointerDown={poke}>
      {data && streams.length === 0 ? (
        <div className="flex h-full items-center justify-center font-mono text-xs uppercase tracking-[0.18em] text-ink-3">
          No streams configured
        </div>
      ) : (
        <div
          className="grid h-full gap-px bg-line"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
        >
          {streams.map((s) => <VideoTile key={s.id} stream={s} />)}
          {/* Fill the last row, or the hairline colour shows through the empty cells. */}
          {Array.from({ length: cols * rows - streams.length }, (_, i) => <div key={`empty-${i}`} className="bg-black" />)}
        </div>
      )}

      <div
        className={`absolute right-2 top-2 z-10 flex flex-col items-end gap-1 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      >
        <div className="flex items-center gap-1 bg-black/80 font-mono text-[10px] uppercase tracking-[0.18em]">
          <span className={`px-2 py-1 ${problem ? 'text-ink' : 'text-ink-3'}`} title={data?.gateway.error ?? loadError ?? undefined}>
            {problem ?? (data ? 'gateway connected' : '')}
          </span>
          {!popup && (
            <>
              <button type="button" className="ctl h-6 px-2 text-[10px] text-ink-2" onClick={() => openWindow('popout:/video', 'Video', '/video')}>
                Pop out
              </button>
              <Link to="/views" className="ctl h-6 px-2 text-[10px] text-ink-2">Views</Link>
            </>
          )}
        </div>
        {data && data.errors.length > 0 && (
          <ul className="max-w-md bg-black/80 px-2 py-1 font-mono text-[11px] text-ink-2">
            {data.errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
      </div>
    </main>
  );
}
