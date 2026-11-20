'use client';

/**
 * One live stream, edge to edge: the picture fills the tile and the label sits on top of
 * it, so no screen goes to chrome. Video only -- the element is muted and the WHEP offer
 * asks for no audio.
 *
 * Status comes from frames, not the connection (lib/video/tile-state): LIVE (green) while
 * decoded frames keep arriving, STALE (amber, with how long) when they stop, CONNECTING and
 * NO SIGNAL (grey) otherwise, with a short code (lib/video/whep SignalCode) and nothing longer:
 * when the gateway refuses a stream the backend asks the camera itself (GET .../check), and
 * the answer is narrowed to UNREACH, REFUSED, AUTH, PATH or NO DATA; GW if the camera is fine;
 * NET when no media path reaches this browser (off the stand LAN).
 *
 * The picture is letterboxed (object-contain) by default, never cropped: an edge of the
 * frame is where a vent or a line is most likely to be. A stream set to "Zoom to fill"
 * (object-cover) fills the tile instead, for cameras whose aspect ratio wastes the slot. A failed attempt retries on its own.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getApiBaseUrl } from '@/lib/websocket';
import { playWhep, type WhepState } from '@/lib/video/whep';
import { codeForProblem, staleLabel, tileStatus, type TileStatus } from '@/lib/video/tile-state';
import type { SignalCode } from '@/lib/video/whep';
import { clock } from '@/lib/video/api';

const RETRY_MS = 3000;
const TICK_MS = 500;
/** A camera that has not produced a frame by now is asked directly, rather than waiting out
 *  the gateway's on-demand timeout (10 s) to learn it is unplugged. */
const EARLY_CHECK_MS = 2500;

function StateBadge({ status }: { status: TileStatus }) {
  if (status.kind === 'live') {
    return (
      <span className="flex items-center gap-1.5 text-green-400">
        <span className="h-1.5 w-1.5 rounded-full bg-green-400" aria-hidden />
        LIVE
      </span>
    );
  }
  if (status.kind === 'stale') {
    return (
      <span className="flex items-center gap-1.5 text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />
        {staleLabel(status.forMs)}
      </span>
    );
  }
  return <span className="text-ink-3">{status.kind === 'connecting' ? 'CONNECTING' : 'NO SIGNAL'}</span>;
}

/** The backend's check of the camera behind a stream endpoint (null if it cannot say). */
async function checkCamera(endpoint: string): Promise<{ ok: boolean; problem?: string } | null> {
  try {
    const res = await fetch(`${getApiBaseUrl()}${endpoint}/check`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** A gateway refusal, narrowed by asking the camera: its code, or GW if the camera is fine. */
async function explain(endpoint: string): Promise<SignalCode> {
  const r = await checkCamera(endpoint);
  if (!r || r.ok) return 'GW';
  return codeForProblem(r.problem);
}

/** Track decoded frames: requestVideoFrameCallback where there is one, else currentTime. */
function useLastFrame(video: HTMLVideoElement | null, key: unknown): number | null {
  const [last, setLast] = useState<number | null>(null);
  useEffect(() => {
    setLast(null);
    if (!video) return;
    let handle = 0;
    let stopped = false;
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (h: number) => void };
    if (v.requestVideoFrameCallback) {
      const onFrame = () => {
        if (stopped) return;
        setLast(Date.now());
        handle = v.requestVideoFrameCallback!(onFrame);
      };
      handle = v.requestVideoFrameCallback(onFrame);
      return () => { stopped = true; v.cancelVideoFrameCallback?.(handle); };
    }
    let t = -1;
    const poll = setInterval(() => {
      if (v.currentTime !== t && v.readyState >= 2) { t = v.currentTime; setLast(Date.now()); }
    }, 200);
    return () => clearInterval(poll);
  }, [video, key]);
  return last;
}

export interface VideoTileProps {
  /** What the overlay says. */
  label: string;
  /** WHEP endpoint: streamEndpoint(id) or previewEndpoint(id). */
  endpoint: string;
  testId?: string;
  onDoubleClick?: () => void;
  /** Extra overlay (the page's slot picker). */
  children?: ReactNode;
  /** Seconds this stream has been recording, or null. Shown always, not with the controls. */
  recording?: number | null;
  /** Zoom to fill the tile, cropping what overhangs (the stream's "Zoom to fill"). */
  fill?: boolean;
}

export default function VideoTile({ label, endpoint, testId, onDoubleClick, children, recording = null, fill = false }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [conn, setConn] = useState<WhepState>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const lastFrame = useLastFrame(video, `${endpoint}#${attempt}`);
  /** A camera problem found while still connecting (see EARLY_CHECK_MS). */
  const [early, setEarly] = useState<SignalCode | null>(null);
  const isStream = endpoint.startsWith('/api/video/streams/');

  useEffect(() => setVideo(videoRef.current), []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const stop = playWhep(endpoint, el, (s) => {
      if (s.kind !== 'failed') { setConn(s); return; }
      retry = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
      // Keep showing the last known code while the camera is asked again.
      if (s.where === 'gateway' && isStream) {
        void explain(endpoint).then((code) => live && setConn({ ...s, code }));
      } else {
        setConn(s);
      }
    });
    return () => {
      live = false;
      if (retry) clearTimeout(retry);
      stop();
    };
  }, [endpoint, attempt, isStream]);

  const raw = tileStatus(conn, lastFrame, now);
  useEffect(() => {
    if (raw.kind !== 'connecting') { setEarly(null); return; }
    if (!isStream) return;
    let live = true;
    const t = setTimeout(() => {
      void checkCamera(endpoint).then((r) => { if (live && r && !r.ok) setEarly(codeForProblem(r.problem)); });
    }, EARLY_CHECK_MS);
    return () => { live = false; clearTimeout(t); };
  }, [raw.kind, endpoint, attempt, isStream]);
  const status: TileStatus = raw.kind === 'connecting' && early ? { kind: 'offline', code: early } : raw;

  return (
    <figure
      className="group relative min-h-0 min-w-0 overflow-hidden bg-black"
      data-testid={testId}
      data-state={status.kind}
      data-endpoint={endpoint}
      onDoubleClick={onDoubleClick}
    >
      <video ref={videoRef} className={`absolute inset-0 h-full w-full ${fill ? 'object-cover' : 'object-contain'}`} muted autoPlay playsInline disablePictureInPicture />

      {status.kind === 'offline' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 font-mono uppercase" data-testid={testId ? `${testId}-reason` : undefined}>
          <span className="text-sm tracking-[0.32em] text-ink-2">No signal</span>
          <span className="text-[11px] tracking-[0.18em] text-ink-3">{status.code}</span>
        </div>
      )}

      {/* The label, over the picture. A dark plate keeps it readable on a bright frame. */}
      <figcaption className="pointer-events-none absolute left-2 top-2 flex max-w-[calc(100%-1rem)] items-center gap-3 bg-black/70 px-2 py-1 font-mono text-[11px] uppercase tracking-[0.18em]">
        <span className="truncate text-ink">{label}</span>
        <StateBadge status={status} />
        {recording !== null && (
          // White, never red: red is the stand's colour on this console.
          <span className="flex items-center gap-1.5 text-ink" data-testid={testId ? `${testId}-rec` : undefined}>
            <span className="h-1.5 w-1.5 rounded-full bg-white" aria-hidden />
            REC {clock(recording)}
          </span>
        )}
      </figcaption>
      {children}
    </figure>
  );
}
