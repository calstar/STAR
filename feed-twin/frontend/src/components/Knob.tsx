/**
 * A hand-loaded regulator's knob.
 *
 * On the stand the dome and the high-press set points are not numbers typed
 * into anything; somebody turns a handle and watches a gauge. This is that:
 * a 270-degree sweep with detents, turned by dragging it round from where
 * it sits, by the wheel one detent at a time, or by the arrow keys. The set pressure reads in the
 * middle; what the system actually did with it reads underneath, from the
 * transducer the operator would look at.
 *
 * Drawn plainly -- a dark ring, a pointer, ticks -- so it reads as an
 * instrument and not as a toy.
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { fixed } from '../api';

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  /** One detent. The wheel and the arrow keys move by this; a drag snaps to it. */
  step: number;
  unit: string;
  onChange: (value: number) => void;
  /** What the set point produced, read where the operator would read it;
   *  `hint` is its hover (the DAQ's own number for a transducer). */
  actual?: { label: string; value: number; hint?: string };
  /** Where the system's limit sits on the sweep, drawn as a red arc beyond it. */
  redline?: number;
  disabled?: boolean;
  size?: number;
}

const SWEEP = 270; // degrees of travel
// degrees, clockwise from 12 o'clock, where `min` sits: 7:30, so the travel
// runs round the top to 4:30 and the gap is at the bottom, under the reading.
// It was 135 (4:30), which turned the gap to the right and put the reading
// and its unit on the arc.
const START = 225;

const polar = (cx: number, cy: number, r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
};

/** The detent `count` clicks from `value` in direction `dir`, inside
 *  [min, max]. From a value between detents -- a drawn setting, or a gauge
 *  setting read in psia, 0.3 psi off a 5 psi detent -- the first click lands
 *  on the nearer detent that way, not a whole step past it (4,514.7 down one
 *  50 psi detent is 4,500, not 4,450). */
export function nextDetent(value: number, step: number, dir: 1 | -1, count: number, min: number, max: number): number {
  const k = value / step;
  const n = dir > 0 ? Math.floor(k + 1e-9) + count : Math.ceil(k - 1e-9) - count;
  return Math.min(max, Math.max(min, n * step));
}

/** Inside this share of the dial's half-width the pointer turns nothing: a
 *  few pixels of jitter by the centre sweep through a large bearing, and a
 *  click there sent the dome from 550 to 685 psia. */
const DEAD_ZONE = 0.5;
/** A press turns nothing until the pointer has moved this far from where it
 *  went down [px]: a click on the readout is a click, not a turn. */
const BREAKAWAY_PX = 8;

/** A hand on the knob: where it went down, the bearing it turns from, and
 *  the unsnapped value it holds. `live` once it has broken away; `lost`
 *  while it is in the dead zone, so it picks up afresh on the way out. */
export interface KnobGrab {
  x0: number;
  y0: number;
  bearing: number;
  value: number;
  live: boolean;
  lost: boolean;
}

/** Clockwise from 12 o'clock [deg], of a point relative to the centre. */
const bearingOf = (x: number, y: number) => {
  const deg = (Math.atan2(y, x) * 180) / Math.PI + 90;
  return deg < 0 ? deg + 360 : deg;
};

/** A press at (x, y) from the dial's centre, `half` its half-width [px]:
 *  a grab, or null in the dead zone. */
export function knobGrab(x: number, y: number, half: number, value: number): KnobGrab | null {
  if (Math.hypot(x, y) < DEAD_ZONE * half) return null;
  return { x0: x, y0: y, bearing: bearingOf(x, y), value, live: false, lost: false };
}

/** The hand moved to (x, y): the grab carried on, and the value it turns the
 *  knob to (unsnapped), or null when this move turns nothing. A drag turns
 *  from where it is, by how far the hand has gone round, like a handle. */
export function knobTurn(
  grab: KnobGrab,
  x: number,
  y: number,
  half: number,
  min: number,
  max: number,
): { grab: KnobGrab; value: number | null } {
  if (Math.hypot(x, y) < DEAD_ZONE * half) return { grab: { ...grab, lost: true }, value: null };
  const b = bearingOf(x, y);
  if (!grab.live && Math.hypot(x - grab.x0, y - grab.y0) < BREAKAWAY_PX) return { grab, value: null };
  // Breaking away, or back out of the dead zone: turn from here.
  if (!grab.live || grab.lost) return { grab: { ...grab, bearing: b, live: true, lost: false }, value: null };
  let turned = b - grab.bearing;
  if (turned > 180) turned -= 360;
  if (turned < -180) turned += 360;
  const next = grab.value + (turned / SWEEP) * (max - min);
  // Carry the grab along so a turn past an end stop does not wind up.
  return { grab: { ...grab, bearing: b, value: Math.min(max, Math.max(min, next)) }, value: next };
}

const arc = (cx: number, cy: number, r: number, from: number, to: number) => {
  const a = polar(cx, cy, r, from);
  const b = polar(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`;
};

export default function Knob({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  actual,
  redline,
  disabled = false,
  size = 180,
}: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = useCallback(
    (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step)),
    [min, max, step],
  );
  // Whole on a detent, a tenth off one: a drawn 500 psig is 514.7 psia, and
  // "515" would be a setting nobody made.
  const places = Math.abs(value - Math.round(value)) < 0.05 ? 0 : 1;
  const frac = (value - min) / (max - min);
  const angle = START + SWEEP * Math.min(Math.max(frac, 0), 1);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 14;

  // Where the pointer is from the centre [px], and the dial's half-width.
  const where = (clientX: number, clientY: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return null;
    return { x: clientX - (box.left + box.width / 2), y: clientY - (box.top + box.height / 2), half: box.width / 2 };
  };

  // A drag turns the knob *from where it is*, by how far the hand has gone
  // round -- like a handle, which does not jump to wherever you first touch
  // it -- and only once it has moved off the press, outside the dead zone
  // by the centre (`knobTurn`). The grab holds the unsnapped value so a slow
  // turn still moves; the detents are applied to what is shown.
  const grab = useRef<KnobGrab | null>(null);
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    const p = where(e.clientX, e.clientY);
    const held = p && knobGrab(p.x, p.y, p.half, value);
    if (!held) return;
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    grab.current = held;
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragging || disabled || !grab.current) return;
    const p = where(e.clientX, e.clientY);
    if (!p) return;
    const turn = knobTurn(grab.current, p.x, p.y, p.half, min, max);
    grab.current = turn.grab;
    if (turn.value !== null) onChange(clamp(turn.value));
  };
  const onPointerUp = () => {
    grab.current = null;
    setDragging(false);
  };

  // The wheel: one detent per notch, and not the page.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (disabled) return;
      e.preventDefault();
      onChange(nextDetent(value, step, e.deltaY < 0 ? 1 : -1, 1, min, max));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [disabled, onChange, step, value, min, max]);

  const ticks = Array.from({ length: 11 }, (_, i) => START + (SWEEP * i) / 10);
  const tip = polar(cx, cy, r - 4, angle);
  const tail = polar(cx, cy, r * 0.45, angle);
  const redFrom = redline !== undefined ? START + SWEEP * Math.min(Math.max((redline - min) / (max - min), 0), 1) : null;

  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <span className="caps text-[11px]">{label}</span>
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (disabled) return;
          const big = e.shiftKey ? 10 : 1;
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') onChange(nextDetent(value, step, 1, big, min, max));
          if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') onChange(nextDetent(value, step, -1, big, min, max));
          if (e.key === 'Home') onChange(min);
          if (e.key === 'End') onChange(max);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`rounded-full outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
          disabled ? 'cursor-not-allowed opacity-60' : dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
      >
        <defs>
          <radialGradient id={`knob-face-${label}`} cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#1c1c1c" />
            <stop offset="100%" stopColor="#0a0a0a" />
          </radialGradient>
        </defs>
        {/* travel */}
        <path d={arc(cx, cy, r, START, START + SWEEP)} fill="none" stroke="#262626" strokeWidth={6} strokeLinecap="round" />
        {/* set */}
        <path d={arc(cx, cy, r, START, angle)} fill="none" stroke="#d0d0d0" strokeWidth={6} strokeLinecap="round" />
        {redFrom !== null && redFrom < START + SWEEP && (
          <path d={arc(cx, cy, r, redFrom, START + SWEEP)} fill="none" stroke="#ef4444" strokeWidth={6} strokeLinecap="round" opacity={0.7} />
        )}
        {ticks.map((t, i) => {
          const a = polar(cx, cy, r - 9, t);
          const b = polar(cx, cy, r - (i % 5 === 0 ? 17 : 13), t);
          return <line key={t} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#575757" strokeWidth={i % 5 === 0 ? 2 : 1} />;
        })}
        {/* the handle */}
        <circle cx={cx} cy={cy} r={r * 0.62} fill={`url(#knob-face-${label})`} stroke="#333333" strokeWidth={2} />
        <line x1={tail.x} y1={tail.y} x2={tip.x} y2={tip.y} stroke="#e2e2e2" strokeWidth={3} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={3} fill="#e2e2e2" />
        <text
          x={cx}
          y={cy + r * 0.62 + 18}
          textAnchor="middle"
          fontFamily="Menlo, Consolas, monospace"
          fontSize={15}
          fontWeight={700}
          fill="#e2e2e2"
          style={{ pointerEvents: 'none' }}
        >
          {fixed(value, places)}
        </text>
        <text x={cx} y={cy + r * 0.62 + 30} textAnchor="middle" fontSize={9} fill="#888" style={{ pointerEvents: 'none' }}>
          {unit}
        </text>
      </svg>
      {actual && (
        <span className="font-mono text-[11px] tabular-nums text-text-muted" title={actual.hint}>
          {actual.label}: <span className="text-text">{fixed(actual.value, 1)}</span> {unit}
        </span>
      )}
    </div>
  );
}
