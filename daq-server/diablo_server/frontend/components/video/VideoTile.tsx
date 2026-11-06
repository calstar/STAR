'use client';

/**
 * One live stream, edge to edge: the picture fills the tile and the label sits on top of
 * it, so no screen goes to chrome. Video only -- the element is muted and the WHEP offer
 * asks for no audio.
 *
 * The picture is letterboxed (object-contain), never cropped: an edge of the frame is
 * where a vent or a line is most likely to be.
 *
 * A failed attempt retries on its own (RETRY_MS), so a camera that reboots or a gateway
 * that restarts comes back without anyone touching the page.
 */
import { useEffect, useRef, useState } from 'react';
import { playWhep, type WhepState } from '@/lib/video/whep';
import type { VideoStreamInfo } from '@/lib/video/api';

const RETRY_MS = 3000;

function StateBadge({ state }: { state: WhepState }) {
  if (state.kind === 'live') {
    return (
      <span className="flex items-center gap-1.5 text-green-400">
        <span className="h-1.5 w-1.5 rounded-full bg-green-400" aria-hidden />
        LIVE
      </span>
    );
  }
  return <span className="text-ink-3">{state.kind === 'connecting' ? 'CONNECTING' : 'OFFLINE'}</span>;
}

export default function VideoTile({ stream }: { stream: VideoStreamInfo }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<WhepState>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const stop = playWhep(stream.id, video, (s) => {
      setState(s);
      if (s.kind === 'failed') retry = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
    });
    return () => {
      if (retry) clearTimeout(retry);
      stop();
    };
  }, [stream.id, attempt]);

  return (
    <figure className="relative min-h-0 min-w-0 overflow-hidden bg-black" data-testid={`video-tile-${stream.id}`} data-state={state.kind}>
      <video ref={videoRef} className="absolute inset-0 h-full w-full object-contain" muted autoPlay playsInline disablePictureInPicture />

      {state.kind === 'failed' && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center font-mono text-xs text-ink-3">
          {state.reason}
        </div>
      )}

      {/* The label, over the picture. A dark plate keeps it readable on a bright frame. */}
      <figcaption className="pointer-events-none absolute left-2 top-2 flex max-w-[calc(100%-1rem)] items-center gap-3 bg-black/70 px-2 py-1 font-mono text-[11px] uppercase tracking-[0.18em]">
        <span className="truncate text-ink">{stream.label}</span>
        <StateBadge state={state} />
      </figcaption>
    </figure>
  );
}
