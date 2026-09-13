import { useCallback, useEffect, useRef, useState } from 'react';
import { useReadOnly } from '@stardesign-ui';
import { portId, portIds } from './ports';
import type { PortInfo, PortKind } from './ports';
import { NumberField } from './NumberField';

/**
 * Where a manifold's ports actually are.
 *
 * A real block has its tappings where the machinist put them -- two on one
 * face, one on the end, one underneath -- and a drawing that spaces them evenly
 * along one side is a drawing that does not match the hardware. So the ports
 * are draggable, round the perimeter, and what is stored is one number each:
 * the fraction of the way round.
 *
 * **A perimeter fraction, not an (x, y).** Resize the block and the ports stay
 * where they were put, relative to the shape, instead of ending up inside it or
 * off the end. It also makes the value meaningful on its own: 0.25 is a quarter
 * of the way round, whatever size the block is.
 *
 * Nothing is applied until Save. Dragging a port is a fiddly gesture and the
 * canvas behind is live; committing on release would mean every twitch became
 * a version in somebody's history.
 */

export interface ManifoldGeometry {
  width: number;
  height: number;
  /** Port id → fraction of the perimeter, clockwise from the top-left. */
  positions: Record<string, number>;
}

const W = 260, H = 190, PAD = 34;

/** Point on the block's perimeter at fraction `t`, clockwise from top-left. */
export function perimeterPoint(t: number, w: number, h: number) {
  const per = 2 * (w + h);
  let d = ((t % 1) + 1) % 1 * per;
  if (d <= w) return { x: d, y: 0, side: 'top' as const };
  d -= w;
  if (d <= h) return { x: w, y: d, side: 'right' as const };
  d -= h;
  if (d <= w) return { x: w - d, y: h, side: 'bottom' as const };
  d -= w;
  return { x: 0, y: h - d, side: 'left' as const };
}

/** The fraction nearest an arbitrary point — what a drag lands on. */
export function nearestFraction(px: number, py: number, w: number, h: number): number {
  const per = 2 * (w + h);
  const cands: [number, number][] = [
    [Math.min(w, Math.max(0, px)) / per, Math.hypot(px - Math.min(w, Math.max(0, px)), py)],
    [(w + Math.min(h, Math.max(0, py))) / per, Math.hypot(px - w, py - Math.min(h, Math.max(0, py)))],
    [(w + h + (w - Math.min(w, Math.max(0, px)))) / per, Math.hypot(px - Math.min(w, Math.max(0, px)), py - h)],
    [(2 * w + h + (h - Math.min(h, Math.max(0, py)))) / per, Math.hypot(px, py - Math.min(h, Math.max(0, py)))],
  ];
  cands.sort((a, b) => a[1] - b[1]);
  return ((cands[0][0] % 1) + 1) % 1;
}

/** Evenly round the perimeter — what a fresh manifold looks like. */
export function defaultPositions(ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  ids.forEach((id, i) => { out[id] = (i + 0.5) / Math.max(1, ids.length); });
  return out;
}

export function ManifoldEditor({ outlets, geometry, ports, onSave }: {
  outlets: number;
  geometry: ManifoldGeometry | undefined;
  ports: Record<string, PortInfo>;
  onSave: (g: ManifoldGeometry) => void;
}) {
  const readOnly = useReadOnly();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<string | null>(null);

  const ids = ['in', ...portIds('p', outlets)];
  void portId;

  const [draft, setDraft] = useState<ManifoldGeometry>(() => ({
    width: geometry?.width ?? 120,
    height: geometry?.height ?? 26,
    positions: { ...defaultPositions(ids), ...(geometry?.positions ?? {}) },
  }));

  // A port that has appeared since last time needs somewhere to be.
  useEffect(() => {
    setDraft(d => {
      const next = { ...d.positions };
      let changed = false;
      const spare = defaultPositions(ids);
      for (const id of ids) if (next[id] === undefined) { next[id] = spare[id]; changed = true; }
      for (const id of Object.keys(next)) if (!ids.includes(id)) { delete next[id]; changed = true; }
      return changed ? { ...d, positions: next } : d;
    });
  }, [outlets]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty =
    draft.width !== (geometry?.width ?? 120) ||
    draft.height !== (geometry?.height ?? 26) ||
    ids.some(id => draft.positions[id] !== geometry?.positions?.[id]);

  // Block drawn centred in the panel, scaled to fit.
  const k = Math.min((W - PAD * 2) / Math.max(1, draft.width), (H - PAD * 2) / Math.max(1, draft.height), 2.2);
  const bw = draft.width * k, bh = draft.height * k;
  const ox = (W - bw) / 2, oy = (H - bh) / 2;

  const onMove = useCallback((e: React.PointerEvent) => {
    if (!drag || readOnly || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W - ox;
    const py = ((e.clientY - r.top) / r.height) * H - oy;
    const t = nearestFraction(px, py, bw, bh);
    setDraft(d => ({ ...d, positions: { ...d.positions, [drag]: t } }));
  }, [drag, readOnly, ox, oy, bw, bh]);

  // `NumberField` rather than a bare input for the reason given in that file:
  // re-deriving the text from the model each keystroke makes the field
  // unclearable, because the digits on the way to a number are not numbers.
  const size = (key: 'width' | 'height') => (
    <NumberField
      value={String(draft[key])}
      readOnly={readOnly}
      onCommit={v => setDraft(d => ({ ...d, [key]: v }))}
      className="w-[54px] rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[11px] outline-none focus:border-[var(--color-accent)]"
    />
  );

  return (
    <div className="space-y-1.5 border-t border-[var(--color-border)] pt-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Geometry</span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
          w {size('width')} h {size('height')} px
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)]"
        style={{ aspectRatio: `${W} / ${H}` }}
        onPointerMove={onMove}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        <rect x={ox} y={oy} width={bw} height={bh} rx={3}
          fill="rgba(148,163,184,0.10)" stroke="#94a3b8" strokeWidth={1.2} />
        <line x1={ox + 4} y1={oy + bh / 2} x2={ox + bw - 4} y2={oy + bh / 2}
          stroke="#64748b" strokeWidth={1} strokeDasharray="3 3" />

        {ids.map(id => {
          const p = perimeterPoint(draft.positions[id] ?? 0, bw, bh);
          const kind: PortKind = ports[id]?.kind ?? 'flow';
          if (kind === 'plug') return null;
          const cx = ox + p.x, cy = oy + p.y;
          const on = drag === id;
          const colour = id === 'in' ? '#38bdf8' : '#94a3b8';
          return (
            <g key={id}
               onPointerDown={e => { if (!readOnly) { e.stopPropagation(); setDrag(id); } }}
               style={{ cursor: readOnly ? 'default' : 'grab' }}>
              <circle cx={cx} cy={cy} r={9} fill="transparent" />
              <circle cx={cx} cy={cy} r={on ? 5 : 3.6}
                fill={colour}
                stroke={colour} strokeWidth={1.4} />
              <text
                x={cx + (p.side === 'right' ? 9 : p.side === 'left' ? -9 : 0)}
                y={cy + (p.side === 'bottom' ? 13 : p.side === 'top' ? -6 : 3)}
                textAnchor={p.side === 'right' ? 'start' : p.side === 'left' ? 'end' : 'middle'}
                fontSize={8} fontFamily="monospace" fill={colour}
              >
                {ports[id]?.label || id}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          Drag a port round the block.
        </span>
        <button
          disabled={readOnly || !dirty}
          onClick={() => onSave(draft)}
          className={`ml-auto rounded px-2 py-0.5 text-[11px] transition-colors ${
            dirty && !readOnly
              ? 'bg-[var(--color-accent)] text-white'
              : 'text-[var(--color-text-muted)]'
          }`}
        >
          {dirty ? 'Save layout' : 'Saved'}
        </button>
      </div>
    </div>
  );
}
