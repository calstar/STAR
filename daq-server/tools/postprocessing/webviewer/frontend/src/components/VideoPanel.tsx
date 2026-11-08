import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VideoClip } from '../types';
import {
  MAX_CAMERAS, clipAt, clipUrl, defaultCameras, drifted, fileOffset, fileToWall, frameSeconds,
  leaderOf, playable, sameClip, streamsOf, toggleCamera,
} from '../video';

interface Props {
  clips: VideoClip[];
  /** Epoch seconds the plot's playhead is on; null until someone clicks the plot. */
  playhead: number | null;
  /** Move the playhead: a frame step, the "first footage" shortcut, or play itself. */
  onPlayhead: (t: number) => void;
  playing: boolean;
  onPlaying: (on: boolean) => void;
}

// The camera a viewer wants first is theirs, not the run's: kept per browser.
const PREFERRED_KEY = 'webviewer.videoPreferred';
const loadPreferred = () => {
  try {
    return localStorage.getItem(PREFERRED_KEY);
  } catch {
    return null; // storage blocked: no preference
  }
};
const savePreferred = (s: string | null) => {
  try {
    if (s) localStorage.setItem(PREFERRED_KEY, s);
    else localStorage.removeItem(PREFERRED_KEY);
  } catch { /* the preference simply doesn't persist */ }
};

/** What the clip's placement rests on, for its tooltip. */
function timingNote(c: VideoClip): string {
  if (c.approx) {
    return 'This clip has no timing file, so its start is read from the recording folder’s ' +
      'name: whole seconds, and the file is cut at a keyframe. Expect it to sit within a ' +
      'second or two of the data, not a frame.';
  }
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

// While playing, a playhead within this of where a video already is came from playback
// itself: seeking to it would stall the video for nothing. Fine drift is the leader's job.
const FOLLOW_SLOP_S = 0.25;

/**
 * The run's cameras at the playhead, up to four at once, and the controls that move it:
 * play/pause at 1× (space), one frame back or forward (← / →). A camera that is off has no
 * <video> at all, so it never fetches a byte; one that is on fetches by Range as it plays.
 *
 * While playing, one tile leads (leaderOf): the frames it actually shows move the playhead
 * (requestVideoFrameCallback's mediaTime, through the clip's pieces), and on each of them
 * every other playing tile is compared with where that instant falls in its own clip and
 * re-seeked only past a frame of drift. Where no shown camera has footage, the page clock
 * carries the playhead at real speed until one does.
 */
export default function VideoPanel({ clips, playhead, onPlayhead, playing, onPlaying }: Props) {
  const streams = useMemo(() => streamsOf(clips), [clips]);
  const [preferred, setPreferred] = useState<string | null>(loadPreferred);
  const [shown, setShown] = useState<string[]>(() => defaultCameras(streams, loadPreferred()));
  // A new run (new clip list): start again from the preferred camera.
  useEffect(() => {
    setShown(defaultCameras(streams, loadPreferred()));
  }, [streams]);

  const videos = useRef(new Map<string, HTMLVideoElement>());
  const loaded = useRef(new Map<string, VideoClip>());
  // One ref callback per camera, kept: a new function each render would make React detach
  // and reattach the <video> every frame, forgetting what it had loaded and reloading it.
  const refs = useRef(new Map<string, (el: HTMLVideoElement | null) => void>());
  const refFor = (stream: string) => {
    let f = refs.current.get(stream);
    if (!f) {
      f = (el) => {
        if (el) videos.current.set(stream, el);
        else {
          videos.current.delete(stream);
          loaded.current.delete(stream);
        }
      };
      refs.current.set(stream, f);
    }
    return f;
  };
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const report = useRef(onPlayhead);
  report.current = onPlayhead;

  const tiles = shown.map((stream) => {
    const at = playhead == null ? null : clipAt(clips, stream, playhead);
    return { stream, at, live: at != null && playable(at.clip, at.offset) };
  });
  const leader = playing ? leaderOf(shown, clips, playhead) : null;
  const leaderAt = tiles.find((t) => t.stream === leader)?.at ?? null;

  // Put every shown video where the playhead is, playing or not as asked.
  const placeKey = tiles.map((t) => `${t.stream}:${t.at?.clip.recording ?? '-'}:${t.at?.offset ?? '-'}:${t.live}`).join('|');
  useEffect(() => {
    const undo: (() => void)[] = [];
    for (const { stream, at, live } of tiles) {
      const v = videos.current.get(stream);
      if (!v) continue;
      if (!at) {
        if (!v.paused) v.pause();
        continue;
      }
      const go = () => {
        const following = playing && !v.paused && Math.abs(v.currentTime - at.offset) < FOLLOW_SLOP_S;
        if (!following) v.currentTime = Math.min(at.offset, Math.max(0, (v.duration || at.clip.duration) - 1e-3));
        if (playing && live && v.paused) v.play().catch(() => onPlaying(false));
        if ((!playing || !live) && !v.paused) v.pause();
      };
      if (!sameClip(loaded.current.get(stream) ?? null, at.clip)) {
        loaded.current.set(stream, at.clip);
        v.src = clipUrl(at.clip);
        v.addEventListener('loadedmetadata', go, { once: true });
        undo.push(() => v.removeEventListener('loadedmetadata', go));
      } else if (v.readyState >= 1) {
        go();
      }
    }
    return () => undo.forEach((f) => f());
    // `tiles` is rebuilt every render; placeKey is what it says.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeKey, playing]);

  // The leader's frames move the playhead and pull drifting followers back in line.
  useEffect(() => {
    const v = leader ? videos.current.get(leader) : undefined;
    if (!playing || !leader || !leaderAt || !v) return;
    const clip = leaderAt.clip;
    const others = () => [...videos.current.entries()].filter(([s]) => s !== leader);
    const onFrame = (fileS: number) => {
      const wall = fileToWall(clip, fileS);
      report.current(wall);
      for (const [s, f] of others()) {
        const fc = loaded.current.get(s);
        if (!fc || f.paused || f.seeking) continue;
        const wanted = fileOffset(fc, wall);
        if (wanted != null && drifted(f.currentTime, wanted, frameSeconds(fc))) f.currentTime = wanted;
      }
    };
    // The last frame is shown 1/fps before the file's end, so the playhead would stop just
    // short of it, still "on footage", with nothing left to play: put it at the end, where
    // the next camera with footage, or the page clock, takes over.
    const onEnded = () => report.current(fileToWall(clip, clip.duration));
    v.addEventListener('ended', onEnded);
    let id = 0;
    let stop = false;
    if (typeof v.requestVideoFrameCallback === 'function') {
      const cb = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (stop) return;
        if (!v.paused) onFrame(meta.mediaTime);
        id = v.requestVideoFrameCallback(cb);
      };
      id = v.requestVideoFrameCallback(cb);
      return () => {
        stop = true;
        v.cancelVideoFrameCallback(id);
        v.removeEventListener('ended', onEnded);
      };
    }
    const onTime = () => onFrame(v.currentTime);
    v.addEventListener('timeupdate', onTime);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('ended', onEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, leader, leaderAt?.clip.recording]);

  // Playing with no shown camera on footage: the page clock carries the playhead.
  useEffect(() => {
    if (!playing || leader) return;
    let last = performance.now();
    let id = requestAnimationFrame(function tick(now) {
      const t = playheadRef.current;
      if (t != null) report.current(t + (now - last) / 1000);
      last = now;
      id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, [playing, leader]);

  // One frame of the leading camera, else the first shown one on footage, else the first.
  const stepClip = leaderAt?.clip ?? tiles.find((t) => t.at)?.at?.clip ?? clips.find((c) => c.stream === shown[0]);
  const frame = frameSeconds(stepClip);
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

  const star = (s: string) => {
    const next = preferred === s ? null : s;
    setPreferred(next);
    savePreferred(next);
  };
  const first = clips.find((c) => shown.includes(c.stream));
  const none = playhead == null;

  return (
    <div className="video-panel">
      <div className="video-head">
        <span className="video-title">Video</span>
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
        <div className="video-cams" role="group" aria-label="Cameras">
          {streams.map((s) => {
            const on = shown.includes(s);
            const full = !on && shown.length >= MAX_CAMERAS;
            return (
              <span key={s} className={`video-cam${on ? ' on' : ''}`}>
                <button
                  className="video-cam-name"
                  aria-pressed={on}
                  disabled={full}
                  title={full ? `At most ${MAX_CAMERAS} cameras at once` : on ? 'Hide this camera' : 'Show this camera'}
                  onClick={() => setShown((cur) => toggleCamera(cur, s, streams))}
                >
                  {s}
                </button>
                <button
                  className={`video-star${preferred === s ? ' on' : ''}`}
                  aria-pressed={preferred === s}
                  title={preferred === s ? 'Your preferred camera (opens first). Click to clear.' : 'Open runs on this camera'}
                  onClick={() => star(s)}
                >
                  ★
                </button>
              </span>
            );
          })}
        </div>
        <div className="spacer" />
        {first && (
          <button className="btn sm" onClick={() => onPlayhead(first.start)}>
            First footage
          </button>
        )}
      </div>
      <div className={`video-grid n${tiles.length}`}>
        {tiles.map(({ stream, at }) => (
          <div key={stream} className="video-stage">
            <video
              ref={refFor(stream)}
              className="video-el"
              muted
              playsInline
              preload="metadata"
              hidden={!at}
            />
            {!at && (
              <div className="video-empty">
                {none ? 'Click the plot to see the video at that moment.' : 'No video at this time.'}
              </div>
            )}
            <div className="video-caption" title={at ? timingNote(at.clip) : undefined}>
              {stream}
              {at && (
                <>
                  {' · '}{at.clip.kind === 'record' ? 'Record' : 'Save'} {timeOfDay(at.clip.start)}
                  {at.clip.approx && <span className="video-approx"> · approx. timing</span>}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
