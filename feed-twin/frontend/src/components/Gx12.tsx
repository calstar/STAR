/**
 * A GX12 panel-mount connector, as it looks on the front of the DAQ box: a
 * hex nut on the panel, the round shell, a key notch at twelve o'clock and
 * four pins in the insulator. Plugged, the mating plug covers it -- a
 * knurled coupling ring round a dark boot, and the cable leaving it -- so an
 * empty socket and a cabled one are told apart across the room, as on the
 * real box.
 */

/** Where the eye goes: a connector picked, waiting for a symbol, or under a
 *  carried cable. */
export type Gx12Mark = 'selected' | 'armed' | 'ok' | 'bad' | null;

const FOCUS = '#60A5FA';

/** Corners of the panel nut, flat side up. */
const HEX = Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 3) * i;
  return `${(19 * Math.cos(a)).toFixed(2)},${(19 * Math.sin(a)).toFixed(2)}`;
}).join(' ');

/** The coupling ring's knurl. */
const KNURL = Array.from({ length: 28 }, (_, i) => {
  const a = ((Math.PI * 2) / 28) * i;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return `M${(11.6 * c).toFixed(2)} ${(11.6 * s).toFixed(2)}L${(14 * c).toFixed(2)} ${(14 * s).toFixed(2)}`;
}).join('');

/** Four pins on a circle, clear of the key. */
const PINS = [45, 135, 225, 315].map((deg) => {
  const a = (deg * Math.PI) / 180;
  return { x: 4.6 * Math.cos(a), y: 4.6 * Math.sin(a) };
});

export function Gx12({
  filled,
  mark = null,
  open = false,
  dim = false,
  size = 40,
}: {
  /** A cable is plugged in. */
  filled: boolean;
  mark?: Gx12Mark;
  /** The valve on it is open (a running stand). */
  open?: boolean;
  /** Read only. */
  dim?: boolean;
  size?: number;
}) {
  const ring =
    mark === 'selected'
      ? { stroke: 'var(--ink)', dash: undefined }
      : mark === 'armed'
        ? { stroke: FOCUS, dash: '3 2.5' }
        : mark === 'ok'
          ? { stroke: FOCUS, dash: undefined }
          : mark === 'bad'
            ? { stroke: 'var(--bad)', dash: undefined }
            : null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="-24 -24 48 48"
      aria-hidden="true"
      style={{ display: 'block', opacity: dim ? 0.55 : 1, overflow: 'visible' }}
    >
      {ring && (
        <circle r={22.5} fill="none" stroke={ring.stroke} strokeWidth={1.75} strokeDasharray={ring.dash}>
          {mark === 'armed' && (
            <animate attributeName="stroke-dashoffset" from="0" to="11" dur="0.9s" repeatCount="indefinite" />
          )}
        </circle>
      )}
      {/* The panel nut and the shell's flange. */}
      <polygon points={HEX} fill="#141414" stroke="#3a3a3a" strokeWidth={1} />
      <circle r={15.5} fill="#1c1c1c" stroke="#575757" strokeWidth={1} />
      {filled ? (
        <g>
          {/* The cable, leaving the plug's boot. */}
          <path d="M-2.6 5 L-2.6 24 L2.6 24 L2.6 5 Z" fill="#1a1a1a" stroke="#6b6b6b" strokeWidth={0.8} />
          {/* The coupling ring, knurled, screwed home. */}
          <circle r={14} fill="#2b2b2b" stroke="var(--color-success)" strokeWidth={1} strokeOpacity={0.85} />
          <path d={KNURL} stroke="#8f8f8f" strokeWidth={0.8} />
          <circle r={11.2} fill="#0d0d0d" stroke="#4d4d4d" strokeWidth={0.8} />
          {/* The boot, and the cable end-on. */}
          <circle r={6.8} fill="#202020" stroke="#6b6b6b" strokeWidth={0.8} />
          <circle r={3.6} fill="#0a0a0a" stroke="#4d4d4d" strokeWidth={0.6} />
        </g>
      ) : (
        <g>
          {/* The threaded shell, open. */}
          <circle r={12.8} fill="none" stroke="#333333" strokeWidth={1} strokeDasharray="1 1.4" />
          <circle r={11.2} fill="#050505" stroke="#8a8a8a" strokeWidth={1} />
          <circle r={8.4} fill="#262626" />
          {/* The key, at twelve o'clock. */}
          <rect x={-1.7} y={-11.6} width={3.4} height={3.6} fill="#8a8a8a" />
          {PINS.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={1.35} fill="#c8c8c8" stroke="#050505" strokeWidth={0.5} />
          ))}
        </g>
      )}
      {open && <circle cx={16.5} cy={-16.5} r={3.4} fill="var(--ok)" stroke="#000" strokeWidth={1} />}
    </svg>
  );
}
