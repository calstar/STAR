import { useEffect, useMemo, useRef, useState } from 'react';
import type { VideoClip } from '../types';
import { clipAt, clipUrl, sameClip, streamsOf } from '../video';

interface Props {
  clips: VideoClip[];
  /** Epoch seconds the plot's playhead is on; null until someone clicks the plot. */
  playhead: number | null;
  /** Put the playhead somewhere (the "first footage" shortcut). */
  onPlayhead: (t: number) => void;
}

/** What the clip's placement rests on, for its tooltip. */
function timingNote(c: VideoClip): string {
  if (c.approx) return '';
  if (c.clockOffset == null) return 'Placed by its timing file. The gateway\u2019s clock was not measured against the DAQ\u2019s, so the two are taken as equal.';
  const ms = Math.round(c.clockOffset * 1000);
  const pm = c.clockUncertainty != null ? ` (\u00b1${Math.max(1, Math.round(c.clockUncertainty * 1000))} ms)` : '';
  return `Placed by its timing file. The gateway\u2019s clock was ${Math.abs(ms)} ms ${ms >= 0 ? 'ahead of' : 'behind'} the DAQ\u2019s${pm} when this was recorded; corrected.`;
}

const timeOfDay = (t: number) =>
  new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * One camera's recording at the playhead. The file is fetched by Range as the browser
 * needs it, and a seek happens only when the playhead moves, never on hover.
 */
export default function VideoPanel({ clips, playhead, onPlayhead }: Props) {
  const streams = useMemo(() => streamsOf(clips), [clips]);
  const [stream, setStream] = useState(streams[0] ?? '');
  useEffect(() => {
    if (!streams.includes(stream)) setStream(streams[0] ?? '');
  }, [streams, stream]);

  const at = playhead == null ? null : clipAt(clips, stream, playhead);
  const videoRef = useRef<HTMLVideoElement>(null);
  const loaded = useRef<VideoClip | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!at) {
      v.pause();
      return;
    }
    const seek = () => {
      v.currentTime = Math.min(at.offset, Math.max(0, (v.duration || at.clip.duration) - 1e-3));
    };
    if (!sameClip(loaded.current, at.clip)) {
      loaded.current = at.clip;
      v.src = clipUrl(at.clip);
      v.addEventListener('loadedmetadata', seek, { once: true });
      return () => v.removeEventListener('loadedmetadata', seek);
    }
    if (v.readyState >= 1) seek();
    // at is rebuilt every render; what matters is the clip and the offset into it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at?.clip.recording, at?.clip.stream, at?.offset]);

  const first = clips.find((c) => c.stream === stream);

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
            {playhead == null ? 'Click the plot to see the video at that moment.' : 'No video at this time.'}
          </div>
        )}
      </div>
    </div>
  );
}
