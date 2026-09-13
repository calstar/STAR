/**
 * The drawing, live.
 *
 * The same document pid-designer edits, rendered read-only with values on it.
 * Deliberately plain SVG rather than the editor's own canvas: React Flow is
 * built for dragging things around, and none of that helps here. What matters
 * on a live schematic is that a number sits beside the symbol it belongs to,
 * that a line shows which way the fluid is going, and that a valve looks shut
 * when it is shut.
 *
 * Flow is drawn as a moving dash, its speed set by the mass flow and its
 * direction by the sign. It is the one animation on the page, and it earns its
 * place: direction of flow is genuinely hard to read from a number, and it is
 * the first thing anyone asks of a schematic.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Frame, ModelView } from '../api';
import { fixed } from '../api';

import { colorOf, dashPeriod, isFlowing } from '../lib/schematic';

interface Props {
  diagram: ModelView;
  frame: Frame | null;
  onToggle: (id: string) => void;
  /** Drawing ids the operator has pinned by hand, overriding the timeline.
   *  The solve already reflects them — this is so the schematic can *say* a
   *  valve is being held rather than leaving it looking like the sequence
   *  opened it. */
  held: Record<string, number>;
}

export function Schematic({ diagram, frame, onToggle, held }: Props) {
  // Zoom and pan, because a real stand drawing does not fit on a screen at a
  // size anybody can read. Wheel to zoom about the cursor, drag to pan,
  // double-click to fit. Kept in view-box units rather than a CSS transform so
  // strokes and text stay the width they were drawn at.
  const [view, setView] = useState<{ x: number; y: number; k: number }>({
    x: 0,
    y: 0,
    k: 1,
  });
  const [dragging, setDragging] = useState(false);
  const svg = useRef<SVGSVGElement | null>(null);
  const from = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const bounds = useMemo(() => {
    const xs = diagram.symbols.map((s) => s.x);
    const ys = diagram.symbols.map((s) => s.y);
    const pad = 70;
    return {
      x: Math.min(...xs) - pad,
      y: Math.min(...ys) - pad,
      w: Math.max(...xs) - Math.min(...xs) + pad * 2,
      h: Math.max(...ys) - Math.min(...ys) + pad * 2,
    };
  }, [diagram]);

  const at = useMemo(
    () => new Map(diagram.symbols.map((s) => [s.id, s])),
    [diagram],
  );

  const fit = useCallback(() => setView({ x: 0, y: 0, k: 1 }), []);

  /** Zoom about the middle of the view, so the button keeps what you are
   *  looking at on screen. Anchoring at the origin instead sends the drawing
   *  off the bottom-right after two clicks. */
  const zoomBy = useCallback(
    (factor: number) =>
      setView((v) => {
        const k = Math.min(Math.max(v.k * factor, 0.25), 12);
        return {
          k,
          x: v.x + (bounds.w / v.k - bounds.w / k) / 2,
          y: v.y + (bounds.h / v.k - bounds.h / k) / 2,
        };
      }),
    [bounds],
  );

  /** Wheel zoom about the cursor, so the thing under the pointer stays put. */
  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      const box = svg.current?.getBoundingClientRect();
      if (!box) return;
      const scale = Math.exp(-e.deltaY * 0.0015);
      setView((v) => {
        const k = Math.min(Math.max(v.k * scale, 0.25), 12);
        // Fraction of the viewport the cursor sits at, in current view units.
        const fx = (e.clientX - box.left) / box.width;
        const fy = (e.clientY - box.top) / box.height;
        const wBefore = bounds.w / v.k;
        const hBefore = bounds.h / v.k;
        const wAfter = bounds.w / k;
        const hAfter = bounds.h / k;
        return {
          k,
          x: v.x + (wBefore - wAfter) * fx,
          y: v.y + (hBefore - hAfter) * fy,
        };
      });
    },
    [bounds],
  );

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // Left button on empty space only — a drag that starts on a valve is a click.
    if (e.button !== 0 || (e.target as Element).closest('[data-symbol]')) return;
    setDragging(true);
    from.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const start = from.current;
    const box = svg.current?.getBoundingClientRect();
    if (!dragging || !start || !box) return;
    const perPixelX = bounds.w / view.k / box.width;
    const perPixelY = bounds.h / view.k / box.height;
    setView((v) => ({
      ...v,
      x: start.vx - (e.clientX - start.x) * perPixelX,
      y: start.vy - (e.clientY - start.y) * perPixelY,
    }));
  };

  const endDrag = () => {
    setDragging(false);
    from.current = null;
  };

  const box = `${bounds.x + view.x} ${bounds.y + view.y} ${bounds.w / view.k} ${
    bounds.h / view.k
  }`;

  return (
    <div className="relative h-full w-full">
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
        <button
          type="button"
          onClick={() => zoomBy(1.3)}
          aria-label="Zoom in"
          className="h-7 w-7 rounded-md border border-gray-700 bg-black/70 text-sm font-bold text-gray-300 hover:border-gray-500 hover:text-white"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.3)}
          aria-label="Zoom out"
          className="h-7 w-7 rounded-md border border-gray-700 bg-black/70 text-sm font-bold text-gray-300 hover:border-gray-500 hover:text-white"
        >
          −
        </button>
        <button
          type="button"
          onClick={fit}
          className="h-7 rounded-md border border-gray-700 bg-black/70 px-2 font-mono text-[11px] text-gray-400 tabular-nums hover:border-gray-500 hover:text-white"
        >
          {view.k.toFixed(1)}× fit
        </button>
      </div>

    <svg
      ref={svg}
      viewBox={box}
      className="h-full w-full"
      style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
      preserveAspectRatio="xMidYMid meet"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      onDoubleClick={fit}
      role="img"
      aria-label={`${diagram.title} schematic`}
    >
      <defs>
        <style>{`
          @keyframes flow { to { stroke-dashoffset: -24; } }
          @media (prefers-reduced-motion: reduce) {
            .flowing { animation: none !important; }
          }
        `}</style>
      </defs>

      {diagram.lines.map((line) => {
        const a = at.get(line.source);
        const b = at.get(line.target);
        if (!a || !b) return null;
        const flow = frame?.flow_kg_s[line.id] ?? 0;
        const moving = isFlowing(flow);
        const stroke = colorOf(line.fluid);
        // Right-angle routing, matching how the editor draws a run.
        const mid = (a.x + b.x) / 2;
        const path = `M${a.x} ${a.y} L${mid} ${a.y} L${mid} ${b.y} L${b.x} ${b.y}`;
        return (
          <g key={line.id}>
            <path d={path} fill="none" stroke={stroke} strokeWidth={2} opacity={0.35} />
            {moving && (
              <path
                className="flowing"
                d={flow > 0 ? path : `M${b.x} ${b.y} L${mid} ${b.y} L${mid} ${a.y} L${a.x} ${a.y}`}
                fill="none"
                stroke={stroke}
                strokeWidth={2.5}
                strokeDasharray="8 16"
                style={{
                  animation: `flow ${dashPeriod(flow)}s linear infinite`,
                }}
              />
            )}
          </g>
        );
      })}

      {diagram.symbols.map((s) => {
        const pressure = frame?.node_psi[s.id] ?? frame?.pressure_psi[s.id];
        const isValve = diagram.actuators.some((a) => a.id === s.id);
        const open = frame?.open[s.id] ?? false;
        return (
          <Symbol
            key={s.id}
            symbol={s}
            pressure={pressure}
            isValve={isValve}
            open={open}
            held={s.id in held}
            onToggle={() => onToggle(s.id)}
          />
        );
      })}
    </svg>
    </div>
  );
}

function Symbol({
  symbol,
  pressure,
  isValve,
  open,
  held,
  onToggle,
}: {
  symbol: ModelView['symbols'][number];
  pressure?: number;
  isValve: boolean;
  open: boolean;
  held: boolean;
  onToggle: () => void;
}) {
  const { x, y, type, tag } = symbol;
  const stroke = colorOf(symbol.fluid);
  const label = (dy: number, text: string, fill = 'var(--muted)', size = 10) => (
    <text
      x={x}
      y={y + dy}
      textAnchor="middle"
      fontSize={size}
      fill={fill}
      fontFamily="var(--mono)"
    >
      {text}
    </text>
  );

  let glyph: React.ReactNode = null;
  if (type === 'TANK' || type === 'KBOTTLE' || type === 'DEWAR') {
    const h = type === 'TANK' ? 44 : 34;
    glyph = (
      <rect
        x={x - 17}
        y={y - h / 2}
        width={34}
        height={h}
        rx={type === 'KBOTTLE' ? 16 : 7}
        fill="var(--lift)"
        stroke={stroke}
        strokeWidth={2}
      />
    );
  } else if (type === 'PT' || type === 'PG' || type === 'RTD' || type === 'TC') {
    glyph = (
      <circle
        cx={x}
        cy={y}
        r={13}
        fill="var(--background)"
        stroke="var(--dim)"
        strokeWidth={1.5}
        strokeDasharray="3 2"
      />
    );
  } else if (type === 'ENGINE' || type === 'INJECTOR') {
    glyph = (
      <path
        d={`M${x - 16} ${y - 16} L${x + 16} ${y - 16} L${x + 6} ${y + 4} L${x + 16} ${y + 20} L${x - 16} ${y + 20} L${x - 6} ${y + 4} Z`}
        fill="var(--lift)"
        stroke="var(--muted)"
        strokeWidth={2}
      />
    );
  } else if (type === 'MANIFOLD') {
    glyph = (
      <rect
        x={x - 22}
        y={y - 9}
        width={44}
        height={18}
        rx={3}
        fill="var(--lift)"
        stroke={stroke}
        strokeWidth={2}
      />
    );
  } else if (type === 'PR') {
    glyph = (
      <g>
        <path
          d={`M${x - 13} ${y - 11} L${x + 13} ${y + 11} L${x + 13} ${y - 11} L${x - 13} ${y + 11} Z`}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
        />
        <path d={`M${x} ${y - 11} L${x} ${y - 20}`} stroke={stroke} strokeWidth={2} />
        <circle cx={x} cy={y - 23} r={4} fill="none" stroke={stroke} strokeWidth={2} />
      </g>
    );
  } else {
    // Valves and everything else: the bowtie.
    const fill = isValve
      ? open
        ? 'rgba(63,185,143,0.25)'
        : 'rgba(210,74,99,0.25)'
      : 'none';
    const edge = isValve ? (open ? 'var(--ok)' : 'var(--bad)') : stroke;
    glyph = (
      <path
        d={`M${x - 13} ${y - 11} L${x + 13} ${y + 11} L${x + 13} ${y - 11} L${x - 13} ${y + 11} Z`}
        fill={fill}
        stroke={edge}
        strokeWidth={2}
      />
    );
  }

  const body = (
    <g>
      {glyph}
      {/* A held valve carries a ring in the interaction colour. The state is
          the operator's, not the sequence's, and nothing else on the drawing
          would say so. */}
      {held && (
        <circle
          cx={x}
          cy={y}
          r={19}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.25}
          strokeDasharray="2 3"
        />
      )}
      {label(type === 'TANK' ? 38 : 30, tag, 'var(--dim)', 9.5)}
      {pressure !== undefined &&
        label(type === 'PT' ? 4 : -26, `${fixed(pressure, 0)}`, 'var(--text)', 11)}
    </g>
  );

  if (!isValve) return body;
  return (
    <g
      data-symbol={symbol.id}
      onClick={onToggle}
      style={{ cursor: 'pointer' }}
      role="button"
      tabIndex={0}
      aria-label={`${tag}, ${open ? 'open' : 'closed'}${
        held ? ', held by hand' : ''
      } — click to toggle`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      {body}
    </g>
  );
}
