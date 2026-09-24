import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReadOnly } from '@stardesign-ui';
import type { PortInfo, PortKind } from './ports';
import { NumberField } from './NumberField';
import { defaultPositions, fractionOf, nearestFraction, perimeterPoint } from './manifoldGeometry';
import type { ManifoldGeometry } from './manifoldGeometry';
import { manifoldLayout, manifoldPortIds } from './nodes/ManifoldNode';

export { defaultPositions, nearestFraction, perimeterPoint } from './manifoldGeometry';
export type { ManifoldGeometry } from './manifoldGeometry';

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

const W = 260, H = 190, PAD = 34;

/**
 * The layout the editor opens on: the manifold exactly as it is drawn.
 *
 * A saved layout comes back as it was saved, key for key, with any port it
 * does not mention put where the drawing puts it. Without one, the drawn
 * default is turned into perimeter fractions, so saving it unchanged draws
 * every port where it already was.
 */
export function drawnGeometry(
  outlets: number,
  orientation: string | undefined,
  geometry?: ManifoldGeometry,
): ManifoldGeometry {
  const ids = manifoldPortIds(outlets);
  if (geometry) {
    const spare = defaultPositions(ids);
    const positions = { ...geometry.positions };
    for (const id of ids) if (positions[id] === undefined) positions[id] = spare[id];
    return { width: geometry.width, height: geometry.height, positions };
  }
  const layout = manifoldLayout(outlets, orientation);
  const positions: Record<string, number> = {};
  for (const id of ids) positions[id] = fractionOf(layout.ports[id], layout.width, layout.height);
  return { width: layout.width, height: layout.height, positions };
}

const sameGeometry = (a: ManifoldGeometry, b: ManifoldGeometry, ids: string[]) =>
  a.width === b.width && a.height === b.height && ids.every(id => a.positions[id] === b.positions[id]);

/**
 * Fraction `t` of a `w` x `h` block, moved onto a `toW` x `toH` one by where
 * it is drawn: the same side, the same whole number of px along it, pulled in
 * to the corner if the side is now shorter than that.
 *
 * Not the same fraction. A fraction is a share of the whole perimeter, so on
 * a block that has grown at one end it slides every port towards that end --
 * and a manifold given more outlets grows at the far end, leaving the ones it
 * had where they were.
 */
function carry(t: number, w: number, h: number, toW: number, toH: number): number {
  if (w === toW && h === toH) return t;
  const p = perimeterPoint(t, w, h);
  const across = p.side === 'top' || p.side === 'bottom';
  const along = Math.min(across ? toW : toH, Math.max(0, Math.round(across ? p.x : p.y)));
  return fractionOf({ side: p.side, along }, toW, toH);
}

/**
 * A draft with edits in it, laid on a drawing that has changed under it.
 *
 * The draft is the drawing as it was when the editor last looked (`base`)
 * plus what has been done to it here. When the drawing changes -- the outlet
 * count or direction is changed in the dialog -- those edits are laid on the
 * new drawing (`seed`) rather than the draft being kept as it is: a draft
 * kept whole keeps the old block's size, and the new outlets, placed as
 * shares of the new block's perimeter, landed on the old one between the
 * outlets it already had.
 *
 * A size typed here is kept. A port dragged here stays where it was dragged
 * to. Every other port goes where the new drawing puts it. Where the block
 * the draft ends up on is not the one a port was placed on, it is carried
 * across by where it is drawn (`carry`).
 */
export function rebaseDraft(
  draft: ManifoldGeometry,
  base: ManifoldGeometry,
  seed: ManifoldGeometry,
  ids: string[],
): ManifoldGeometry {
  if (sameGeometry(draft, base, Object.keys(base.positions))) return seed;
  const width = draft.width !== base.width ? draft.width : seed.width;
  const height = draft.height !== base.height ? draft.height : seed.height;
  const positions: Record<string, number> = {};
  for (const id of ids) {
    const moved = draft.positions[id] !== undefined && draft.positions[id] !== base.positions[id];
    positions[id] = moved
      ? carry(draft.positions[id], draft.width, draft.height, width, height)
      : carry(seed.positions[id], seed.width, seed.height, width, height);
  }
  return { width, height, positions };
}

const geometryKey = (g: ManifoldGeometry) =>
  `${g.width}x${g.height}:` + Object.keys(g.positions).sort().map(id => `${id}=${g.positions[id]}`).join(',');

export function ManifoldEditor({ outlets, orientation, geometry, ports, onSave }: {
  outlets: number;
  /** The block's direction, which decides its default shape. */
  orientation?: string;
  geometry: ManifoldGeometry | undefined;
  ports: Record<string, PortInfo>;
  onSave: (g: ManifoldGeometry) => void;
}) {
  const readOnly = useReadOnly();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<string | null>(null);

  const ids = manifoldPortIds(outlets);

  // What the drawing shows now. The draft starts as it, and `dirty` is
  // measured against it: opening the editor is not an edit, so "Save layout"
  // stays off until a port has actually been moved.
  const seed = useMemo(
    () => drawnGeometry(outlets, orientation, geometry),
    [outlets, orientation, geometry],
  );
  const [draft, setDraft] = useState<ManifoldGeometry>(seed);
  const [base, setBase] = useState<ManifoldGeometry>(seed);

  // The drawing changed under the editor -- the outlet count or direction was
  // changed in the dialog, or a layout was just saved. An untouched draft
  // follows it; one with edits in it has them laid on the new drawing (see
  // `rebaseDraft`), and a port that has gone is dropped. Keyed by content, so
  // a seed that is merely a new object changes nothing.
  const seedKey = geometryKey(seed);
  useEffect(() => {
    if (geometryKey(base) === seedKey) return;
    setDraft(d => rebaseDraft(d, base, seed, ids));
    setBase(seed);
  }, [seedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !sameGeometry(draft, seed, ids);

  // Block drawn centred in the panel, scaled to fit.
  const k = Math.min((W - PAD * 2) / Math.max(1, draft.width), (H - PAD * 2) / Math.max(1, draft.height), 2.2);
  const bw = draft.width * k, bh = draft.height * k;
  const ox = (W - bw) / 2, oy = (H - bh) / 2;

  const onMove = useCallback((e: React.PointerEvent) => {
    if (!drag || readOnly || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W - ox;
    const py = ((e.clientY - r.top) / r.height) * H - oy;
    // Landed on a whole pixel of the real block, not wherever the panel's
    // scale put it: a port at 61.6 px is a line that can never be drawn
    // straight into anything standing on the grid.
    const per = 2 * (draft.width + draft.height);
    const t = Math.round(nearestFraction(px, py, bw, bh) * per) / per;
    setDraft(d => ({ ...d, positions: { ...d.positions, [drag]: t } }));
  }, [drag, readOnly, ox, oy, bw, bh, draft.width, draft.height]);

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
          fill="var(--color-bg-tertiary)" stroke="var(--color-text-secondary)" strokeWidth={1.2} />
        <line x1={ox + 4} y1={oy + bh / 2} x2={ox + bw - 4} y2={oy + bh / 2}
          stroke="var(--color-text-muted)" strokeWidth={1} strokeDasharray="3 3" />

        {ids.map(id => {
          const p = perimeterPoint(draft.positions[id] ?? 0, bw, bh);
          const kind: PortKind = ports[id]?.kind ?? 'flow';
          if (kind === 'plug') return null;
          const cx = ox + p.x, cy = oy + p.y;
          const on = drag === id;
          const colour = id === 'in' ? 'var(--color-accent)' : 'var(--color-text-secondary)';
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
