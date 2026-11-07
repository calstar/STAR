import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VideoClip } from '../types';
import { clipAt, clipUrl, fileToWall, frameSeconds, playable, sameClip, streamsOf } from '../video';

interface Props {
  clips: VideoClip[];
  /** Epoch seconds the plot's playhead is on; null until someone clicks the plot. */
  playhead: number | null;
  /** Move the playhead: a frame step, the "first footage" shortcut, or play itself. */
  onPlayhead: (t: number) => void;
  playing: boolean;
  onPlaying: (on: boolean) => void;
}

/** What the clip's placement rests on, for its tooltip. */
function timingNote(c: VideoClip): string {
  if (c.approx) return '';
  if (c.clockOffset == null) return 'Placed by its timing file. The gateway’s clock was not measured against the DAQ’s, so the two are taken as equal.';
  const ms = Math.round(c.clockOffset * 1000);
  const pm = c.clockUncertainty != null ? ` (±${Math.max(1, Math.round(c.clockUncertainty * 1000))} ms)` : '';
  return `Placed by its timing file. The gateway’s clock was ${Math.abs(ms)} ms ${ms >= 0 ? 'ahead of' : 'behind'} the DAQ’s${pm} when this was recorded; corrected.`;
}

const timeOfDay = (t: number) =>
  new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** A key typed into a field is the field's, not the player's. */
const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

// While playing, a playhead within this of where the video already is came from the video
// itself: following it with a seek would stall playback for nothing.
const FOLLOW_SLOP_S = 0.25;

/**
 * One camera's recording at the playhead, and the controls that move it: play/pause at 1×
 * (space), one frame back or forward (← / →). The file is fetched by Range as the browser
 * needs it; nothing seeks on hover.
 *
 * While playing, the video drives the playhead: each frame it shows is reported at the time
 * it was filmed (requestVideoFrameCallback's mediaTime, through the clip's pieces). Where the
 * camera has no footage, the page clock carries the playhead at real speed until it does.
 */
export default function VideoPanel({ clips, playhead, onPlayhead, playing, onPlaying }: Props) {
  const streams = useMemo(() => streamsOf(clips), [clips]);
  const [stream, setStream] = useState(streams[0] ?? '');
  useEffect(() => {
    if (!streams.includes(stream)) setStream(streams[0] ?? '');
  }, [streams, stream]);

  const at = playhead == null ? null : clipAt(clips, stream, playhead);
  const live = at != null && playable(at.clip, at.offset);
  const videoRef = useRef<HTMLVideoElement>(null);
  const loaded = useRef<VideoClip | null>(null);
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const report = useRef(onPlayhead);
  report.current = onPlayhead;

  // Put the video where the playhead is, and playing or not as asked.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!at) {
      v.pause();
      return;
    }
    const go = () => {
      const following = playing && !v.paused && Math.abs(v.currentTime - at.offset) < FOLLOW_SLOP_S;
      if (!following) v.currentTime = Math.min(at.offset, Math.max(0, (v.duration || at.clip.duration) - 1e-3));
      if (playing && live && v.paused) v.play().catch(() => onPlaying(false));
      if ((!playing || !live) && !v.paused) v.pause();
    };
    if (!sameClip(loaded.current, at.clip)) {
      loaded.current = at.clip;
      v.src = clipUrl(at.clip);
      v.addEventListener('loadedmetadata', go, { once: true });
      return () => v.removeEventListener('loadedmetadata', go);
    }
    if (v.readyState >= 1) go();
    // `at` is rebuilt every render; what matters is the clip, the offset and the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at?.clip.recording, at?.clip.stream, at?.offset, playing, live]);

  // Playing with footage: the frames the video actually shows move the playhead.
  useEffect(() => {
    const v = videoRef.current;
    if (!playing || !live || !at || !v) return;
    const clip = at.clip;
    let id = 0;
    let stop = false;
    // The last frame is shown 1/fps before the file's end, so the playhead would stop just
    // short of it, still "on footage", with nothing left to play: put it at the end, where
    // the page clock takes over.
    const onEnded = () => report.current(fileToWall(clip, clip.duration));
    v.addEventListener('ended', onEnded);
    if (typeof v.requestVideoFrameCallback === 'function') {
      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (stop) return;
        if (!v.paused) report.current(fileToWall(clip, meta.mediaTime));
        id = v.requestVideoFrameCallback(onFrame);
      };
      id = v.requestVideoFrameCallback(onFrame);
      return () => {
        stop = true;
        v.cancelVideoFrameCallback(id);
        v.removeEventListener('ended', onEnded);
      };
    }
    const onTime = () => report.current(fileToWall(clip, v.currentTime));
    v.addEventListener('timeupdate', onTime);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('ended', onEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, live, at?.clip.recording, at?.clip.stream]);

  // Playing with no footage here (before a clip, in an outage, past its end): the page
  // clock carries the playhead at real speed.
  useEffect(() => {
    if (!playing || live) return;
    let last = performance.now();
    let id = requestAnimationFrame(function tick(now) {
      const t = playheadRef.current;
      if (t != null) report.current(t + (now - last) / 1000);
      last = now;
      id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, [playing, live]);

  // One frame of the camera on screen (or of the nearest one, off footage).
  const frame = frameSeconds(at?.clip ?? clips.find((c) => c.stream === stream));
  const step = useCallback(
    (dir: 1 | -1) => {
      const t = playheadRef.current;
      if (t == null) return;
      onPlaying(false);
      onPlayhead(t + dir * frame);
    },
    [frame, onPlayhead, onPlaying],
  );
  const toggle = useCallback(() => {
    if (playheadRef.current == null) return;
    onPlaying(!playing);
  }, [playing, onPlaying]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
      // Space on a focused button presses that button; let it, rather than toggling twice.
      if (e.key === ' ' && (e.target as HTMLElement | null)?.tagName === 'BUTTON') return;
      if (e.key === ' ') toggle();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, step]);

  const first = clips.find((c) => c.stream === stream);
  const none = playhead == null;

  return (
    <div className="video-panel">
      <div className="video-head">
        <span className="video-title">Video</span>
        {streams.length > 1 ? (
          <select className="input video-select" value={stream} onChange={(e) => setStream(e.target.value)}>
            {streams.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        ) : (
          <span className="video-stream">{stream}</span>
        )}
        <div className="video-transport">
          <button className="btn sm" onClick={() => step(-1)} disabled={none} title="One frame back (←)">
            ◀
          </button>
          <button className="btn sm video-play" onClick={toggle} disabled={none} title="Play / pause (space)">
            {playing ? 'Pause' : 'Play'}
          </button>
          <button className="btn sm" onClick={() => step(1)} disabled={none} title="One frame forward (→)">
            ▶
          </button>
        </div>
        {at && (
          <span className="video-meta" title={timingNote(at.clip) || undefined}>
            {at.clip.kind === 'record' ? 'Record' : 'Save'} {timeOfDay(at.clip.start)}
            {at.clip.approx && (
              <span
                className="video-approx"
                title={
                  'This clip has no timing file, so its start is read from the recording ' +
                  'folder’s name: whole seconds, and the file is cut at a keyframe. ' +
                  'Expect it to sit within a second or two of the data, not a frame.'
                }
              >
                {' '}· approx. timing
              </span>
            )}
          </span>
        )}
        <div className="spacer" />
        {first && (
          <button className="btn sm" onClick={() => onPlayhead(first.start)}>
            First footage
          </button>
        )}
      </div>
      <div className="video-stage">
        <video ref={videoRef} className="video-el" muted playsInline preload="metadata" hidden={!at} />
        {!at && (
          <div className="video-empty">
            {none ? 'Click the plot to see the video at that moment.' : 'No video at this time.'}
          </div>
        )}
      </div>
    </div>
  );
}
