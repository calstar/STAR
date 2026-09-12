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
  /** What the set point produced, read where the operator would read it. */
  actual?: { label: string; value: number };
  /** Where the system's limit sits on the sweep, drawn as a red arc beyond it. */
  redline?: number;
  disabled?: boolean;
  size?: number;
}

const SWEEP = 270; // degrees of travel
const START = 135; // degrees, clockwise from 12 o'clock, where `min` sits

const polar = (cx: number, cy: number, r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
};

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
  const frac = (value - min) / (max - min);
  const angle = START + SWEEP * Math.min(Math.max(frac, 0), 1);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 14;

  // Where the pointer is round the centre, clockwise from 12 o'clock.
  const bearing = (clientX: number, clientY: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return null;
    const x = clientX - (box.left + box.width / 2);
    const y = clientY - (box.top + box.height / 2);
    let deg = (Math.atan2(y, x) * 180) / Math.PI + 90;
    if (deg < 0) deg += 360;
    return deg;
  };

  // A drag turns the knob *from where it is*, by how far the hand has gone
  // round -- like a handle, which does not jump to wherever you first touch
  // it. The grab holds the unsnapped value so a slow turn still moves; the
  // detents are applied to what is shown.
  const grab = useRef<{ bearing: number; value: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    const b = bearing(e.clientX, e.clientY);
    if (b === null) return;
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    grab.current = { bearing: b, value };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragging || disabled || !grab.current) return;
    const b = bearing(e.clientX, e.clientY);
    if (b === null) return;
    let turned = b - grab.current.bearing;
    if (turned > 180) turned -= 360;
    if (turned < -180) turned += 360;
    const next = grab.current.value + (turned / SWEEP) * (max - min);
    // Carry the grab along so a turn past an end stop does not wind up.
    grab.current = { bearing: b, value: Math.min(max, Math.max(min, next)) };
    onChange(clamp(next));
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
      onChange(clamp(value + (e.deltaY < 0 ? step : -step)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [clamp, disabled, onChange, step, value]);

  const ticks = Array.from({ length: 11 }, (_, i) => START + (SWEEP * i) / 10);
  const tip = polar(cx, cy, r - 4, angle);
  const tail = polar(cx, cy, r * 0.45, angle);
  const redFrom = redline !== undefined ? START + SWEEP * Math.min(Math.max((redline - min) / (max - min), 0), 1) : null;

  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</span>
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
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') onChange(clamp(value + step * big));
          if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') onChange(clamp(value - step * big));
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
            <stop offset="0%" stopColor="#2a2a33" />
            <stop offset="100%" stopColor="#101015" />
          </radialGradient>
        </defs>
        {/* travel */}
        <path d={arc(cx, cy, r, START, START + SWEEP)} fill="none" stroke="#2f2f38" strokeWidth={6} strokeLinecap="round" />
        {/* set */}
        <path d={arc(cx, cy, r, START, angle)} fill="none" stroke="#3B82F6" strokeWidth={6} strokeLinecap="round" />
        {redFrom !== null && redFrom < START + SWEEP && (
          <path d={arc(cx, cy, r, redFrom, START + SWEEP)} fill="none" stroke="#E74C3C" strokeWidth={6} strokeLinecap="round" opacity={0.7} />
        )}
        {ticks.map((t, i) => {
          const a = polar(cx, cy, r - 9, t);
          const b = polar(cx, cy, r - (i % 5 === 0 ? 17 : 13), t);
          return <line key={t} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#6b6b76" strokeWidth={i % 5 === 0 ? 2 : 1} />;
        })}
        {/* the handle */}
        <circle cx={cx} cy={cy} r={r * 0.62} fill={`url(#knob-face-${label})`} stroke="#3a3a44" strokeWidth={2} />
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
          {fixed(value, 0)}
        </text>
        <text x={cx} y={cy + r * 0.62 + 30} textAnchor="middle" fontSize={9} fill="#888" style={{ pointerEvents: 'none' }}>
          {unit}
        </text>
      </svg>
      {actual && (
        <span className="font-mono text-[11px] tabular-nums text-text-muted">
          {actual.label}: <span className="text-text">{fixed(actual.value, 1)}</span> {unit}
        </span>
      )}
    </div>
  );
}
