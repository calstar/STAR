import './timeline.css';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { timeTicks, xTickLabels } from '../charts/axis';
import { SANS, useTextMeasure } from '../charts/measure';
import { Button } from '../ui/Button';
import { Menu, MenuItem } from '../ui/Menu';
import { useTimeOf, useOptionalTimeStore } from './hooks';
import { firingSpan, formatT, layoutMarkers, priorityOf, timeDigits } from './markers';
import { clamp } from './search';
import { SPEEDS, type TimeEvent, type TimeState, type TimeStore } from './store';

/**
 * The burn's clock, docked under every Burn page: play and speed, the firing span, the events,
 * and the cursor, which every chart, number and the schematic follow.
 *
 * The cursor handle and the time readout move by subscription (no React render while scrubbing);
 * the bar re-renders only when the run, its events, the speed or play/pause change.
 */

const LABEL_FONT = `11px ${SANS}`;
const NO_EVENTS: readonly TimeEvent[] = [];
const NO_TIMES: readonly number[] = [];

const speedWord = (s: number) => (s === 0.25 ? '¼×' : s === 0.5 ? '½×' : `${s}×`);

const selPlaying = (s: TimeState) => s.playing;
const selSpeed = (s: TimeState) => s.speed;
const selEvents = (s: TimeState) => s.events;
const selRange = (s: TimeState) => s.range;
const selSeries = (s: TimeState) => s.series;

export interface TimelineProps {
  /** Default: the page's TimeProvider. */
  store?: TimeStore;
  /** The firing span [s]; default Fire to burnout from the events. */
  firing?: readonly [number, number] | null;
  className?: string;
}

export function Timeline({ store, firing, className }: TimelineProps) {
  const pageStore = useOptionalTimeStore();
  const active = store ?? pageStore;
  const playing = useTimeOf(active, selPlaying, Object.is, false);
  const speed = useTimeOf(active, selSpeed, Object.is, 1);
  const events = useTimeOf(active, selEvents, Object.is, NO_EVENTS);
  const range = useTimeOf(active, selRange, Object.is, null);
  const series = useTimeOf(active, selSeries, Object.is, NO_TIMES);
  const digits = useMemo(() => timeDigits(series), [series]);

  const trackRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLOutputElement>(null);
  const [width, setWidth] = useState(0);
  const dragging = useRef(false);

  useLayoutEffect(() => {
    const track = trackRef.current;
    // The observer reports the first size on its own, right after observe().
    if (!track || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    ro.observe(track);
    return () => ro.disconnect();
  }, []);

  const r0 = range?.[0] ?? 0;
  const r1 = range?.[1] ?? 1;
  const span = r1 > r0 ? r1 - r0 : 1;
  const xOf = useCallback((t: number) => ((t - r0) / span) * width, [r0, span, width]);

  // Measured again when the bundled font arrives: a label measured in the fallback face would be
  // cut or would crowd its neighbour.
  const measure = useTextMeasure(LABEL_FONT);
  const markers = useMemo(
    () => (range ? layoutMarkers(events, { x: xOf, width, measure: (s) => measure(s) + 2 }) : []),
    [events, range, xOf, width, measure],
  );
  const fireSpan = firing === undefined ? firingSpan(events) : firing;
  const axis = useMemo(() => {
    if (!range || width <= 0) return [];
    // The charts' rule: the step from the span, so the clock and every chart tick the same seconds.
    const { ticks, digits: d } = timeTicks(r0, r1, width);
    const text = xTickLabels(ticks, d, 's');
    return ticks.map((v, k) => ({ v, x: xOf(v), text: text[k] }));
  }, [range, r0, r1, width, xOf]);

  // The handle and the readout follow the cursor without a React render.
  useLayoutEffect(() => {
    const handle = handleRef.current;
    const out = readoutRef.current;
    if (!handle || !out || !active) return;
    let lastT = Number.NaN;
    const sync = () => {
      const s = active.get();
      if (s.t === lastT) return;
      lastT = s.t;
      const t = range ? clamp(s.t, r0, r1) : s.t;
      handle.style.transform = `translateX(${range ? xOf(t) : 0}px)`;
      const text = formatT(t, digits);
      out.textContent = text;
      handle.setAttribute('aria-valuenow', t.toFixed(digits));
      const here = s.events.find((e) => Math.abs(e.t - t) < 0.5 * 10 ** -digits);
      handle.setAttribute('aria-valuetext', here ? `${text.replace('\u00a0', ' ')}, ${here.label}` : text.replace('\u00a0', ' '));
    };
    sync();
    return active.subscribe(sync);
  }, [active, range, r0, r1, xOf, digits]);

  const tAt = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track || width <= 0) return r0;
    const rect = track.getBoundingClientRect();
    return r0 + (clamp(clientX - rect.left, 0, width) / width) * span;
  }, [r0, span, width]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!active || !range || e.button !== 0) return;
    const marker = (e.target as HTMLElement).closest<HTMLElement>('[data-marker-t]');
    e.preventDefault();
    handleRef.current?.focus({ preventScroll: true });
    if (marker) {
      active.setT(Number(marker.dataset.markerT));
      return;
    }
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    active.setT(tAt(e.clientX));
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current && active) active.setT(tAt(e.clientX));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onHandleKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!active) return;
    const big = e.shiftKey ? 10 : 1;
    const act: Record<string, () => void> = {
      ArrowRight: () => active.step(big),
      ArrowUp: () => active.step(big),
      ArrowLeft: () => active.step(-big),
      ArrowDown: () => active.step(-big),
      PageUp: () => active.step(10),
      PageDown: () => active.step(-10),
      Home: () => active.home(),
      End: () => active.end(),
    };
    const fn = act[e.key];
    if (!fn || e.ctrlKey || e.metaKey || e.altKey) return;
    // Prevented, so the page's own shortcut handler does not move the cursor a second time.
    e.preventDefault();
    fn();
  };

  const disabled = !active || !range;
  const fx0 = fireSpan && range ? clamp(xOf(fireSpan[0]), 0, width) : 0;
  const fx1 = fireSpan && range ? clamp(xOf(fireSpan[1]), 0, width) : 0;

  return (
    <div className={`lx-tl${className ? ` ${className}` : ''}`} role="group" aria-label="Burn timeline">
      <div className="lx-tl-controls">
        <Button iconOnly variant="ghost" disabled={disabled} className="lx-tl-play"
                aria-label={playing ? 'Pause' : 'Play'} aria-keyshortcuts="Space" title={playing ? 'Pause (Space)' : 'Play (Space)'}
                onClick={() => active?.togglePlaying()}
                icon={playing ? (
                  <svg viewBox="0 0 12 12" width="12" height="12"><path d="M3 2h2v8H3zM7 2h2v8H7z" fill="currentColor" /></svg>
                ) : (
                  <svg viewBox="0 0 12 12" width="12" height="12"><path d="M3 1.8v8.4L10 6z" fill="currentColor" /></svg>
                )} />
        <Menu label={<span className="lx-num">{speedWord(speed)}</span>} ariaLabel={`Playback speed, ${speedWord(speed)}`}
              title="Playback speed" disabled={disabled} minWidth={88}>
          {[...SPEEDS].reverse().map((s) => (
            <MenuItem key={s} checked={s === speed} onClick={() => active?.setSpeed(s)}>
              <span className="lx-num">{speedWord(s)}</span>
            </MenuItem>
          ))}
        </Menu>
      </div>

      <div ref={trackRef} className="lx-tl-track" onPointerDown={onPointerDown} onPointerMove={onPointerMove}
           onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <div className="lx-tl-labels">
          {markers.filter((m) => m.showLabel).map((m) => (
            <span key={m.key} className={`lx-tl-label lx-tl-k-${m.kind}`} data-marker-t={m.t}
                  style={{ transform: `translateX(${m.labelLeft}px)`, width: m.labelWidth }}
                  title={m.events.map((e) => `${e.label} · ${formatT(e.t, digits).replace('\u00a0', ' ')}`).join('\n')}>
              {m.label}
            </span>
          ))}
        </div>
        <div className="lx-tl-lane">
          <div className="lx-tl-rail" />
          {fireSpan && range && fx1 > fx0 && <div className="lx-tl-firing" style={{ transform: `translateX(${fx0}px)`, width: fx1 - fx0 }} />}
          {markers.map((m) => (
            <span key={m.key} className={`lx-tl-tick lx-tl-k-${m.kind}${priorityOf(m) >= 75 ? ' lx-tl-tick-strong' : ''}`}
                  data-marker-t={m.t} style={{ transform: `translateX(${m.x}px)` }}
                  title={m.events.map((e) => e.label).join(' · ')} />
          ))}
          <div ref={handleRef} className="lx-tl-handle" role="slider" tabIndex={disabled ? -1 : 0}
               aria-label="Time cursor" aria-valuemin={r0} aria-valuemax={r1} aria-disabled={disabled || undefined}
               aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End"
               onKeyDown={onHandleKey}>
            <span className="lx-tl-handle-line" />
            <span className="lx-tl-handle-knob" />
          </div>
        </div>
        <div className="lx-tl-axis" aria-hidden="true">
          {axis.map((a) => (
            <span key={a.v} className="lx-tl-axis-tick lx-num"
                  style={{ left: a.x, transform: a.x < 16 ? 'none' : a.x > width - 28 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
              {a.text}
            </span>
          ))}
        </div>
      </div>

      <output ref={readoutRef} className="lx-tl-readout lx-num" aria-hidden="true">{formatT(0, digits)}</output>
    </div>
  );
}
