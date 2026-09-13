import { useMemo, useState } from 'react';
import { buildElements, buildWalls, wallPoints } from './flowPath';
import type { LineSegment } from './segments';

/**
 * The flow path, drawn.
 *
 * Its whole job is to let somebody check that the program read their tally the
 * way they meant it. A wrong bore, a reducer facing the wrong way, an
 * engagement swallowing more tube than expected -- all arithmetic until you see
 * the shape, and obvious afterwards.
 *
 * **The radius is exaggerated, and it says so.** A 1.6 m run at 10 mm bore is
 * 160:1; drawn true to scale the bore is a hairline and the picture says
 * nothing. Length and radius therefore carry their own scales, both stated, the
 * way a bore profile is drawn anywhere else. What is preserved exactly is what
 * the picture is *for*: the ratios between bores, and where along the run each
 * change happens.
 */

// The pipe wall, drawn -- the same functional blue as Sketch.tsx's WALL
// (same concept, a different view of it), kept deliberately rather than
// grayed out: it's real geometry, not decoration.
const BORE = '#38bdf8';
const BORE_FILL = 'rgba(56,189,248,0.13)';
// A value the solver assumed rather than one that was measured or set --
// the same "verify this" semantic as --color-warning, so it uses that token.
const ASSUMED = 'var(--color-warning)';

export function BoreProfile({ segments }: { segments: LineSegment[] }) {
  const [hover, setHover] = useState<string | null>(null);

  const model = useMemo(() => {
    const elements = buildElements(segments);
    return { elements, walls: buildWalls(elements) };
  }, [segments]);

  const { elements, walls } = model;

  if (elements.length === 0 || walls.stations.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded border border-dashed border-[var(--color-border)] p-4">
        <p className="text-center text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          Add a segment and the flow path is drawn here,
          <br />so you can see what will be solved.
        </p>
      </div>
    );
  }

  // Every segment has to say how long it is before the total means anything.
  const lengthStated = segments.every(s => s.length?.value !== undefined && s.length.value !== null);

  const W = 300, H = 260, PAD = 18;

  // Independent scales: at true scale a 1.6 m run at 10 mm bore is 160:1 and
  // the bore is a hairline. Exaggerate the radius, and say by how much.
  const maxR = Math.max(...walls.stations.map(s => s.r), 1e-6);

  // Radius blown up until the widest bore reads at a sensible size, capped so
  // a short run does not become a balloon.
  const rScale = Math.min(24, Math.max(1, (H * 0.22) / maxR));
  const scaled = buildWalls(elements);
  const pts = wallPoints(scaled.stations, rScale);

  const all = [...pts.left, ...pts.right];
  const xs = all.map(p => p[0]);
  const ys = all.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const k = Math.min((W - PAD * 2) / Math.max(1e-6, maxX - minX),
                     (H - PAD * 2) / Math.max(1e-6, maxY - minY));
  const tx = (x: number) => PAD + (x - minX) * k;
  const ty = (y: number) => PAD + (y - minY) * k;

  const path =
    'M ' + pts.left.map(p => `${tx(p[0]).toFixed(2)},${ty(p[1]).toFixed(2)}`).join(' L ') +
    ' L ' + [...pts.right].reverse().map(p => `${tx(p[0]).toFixed(2)},${ty(p[1]).toFixed(2)}`).join(' L ') +
    ' Z';

  const centre = 'M ' + scaled.stations
    .map(s => `${tx(s.x).toFixed(2)},${ty(s.y).toFixed(2)}`).join(' L ');

  const anyAssumed = elements.some(e => e.assumed);
  const hovered = walls.spans.find(s => s.element.id === hover);

  return (
    <div className="flex h-full flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
          Flow path
        </span>
        {/* A drawn length is not a stated one. Without a length on every
            segment this figure is whatever the picture needed to be drawn at,
            and printing it as metres claimed a number nobody typed. */}
        <span className="font-mono text-[10px]"
              style={{ color: lengthStated ? 'var(--color-text-muted)' : ASSUMED }}>
          {lengthStated ? `${(walls.length / 1000).toFixed(3)} m` : 'length not stated'}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)]"
        style={{ aspectRatio: `${W} / ${H}` }}
      >
        <path d={path} fill={BORE_FILL} stroke={BORE} strokeWidth={1.2} strokeLinejoin="round" />
        <path d={centre} fill="none" stroke="var(--color-text-muted)" strokeWidth={0.8} strokeDasharray="4 3" />

        {/* Where each element begins, and what it is. */}
        {walls.spans.map(({ element, mid }) => {
          const s = scaled.stations.find(p => Math.hypot(p.x - mid.x, p.y - mid.y) < 1e-6)
            ?? scaled.stations[0];
          const nx = -Math.sin(s.heading), ny = Math.cos(s.heading);
          const on = hover === element.id;
          return (
            <g key={element.id}
               onMouseEnter={() => setHover(element.id)}
               onMouseLeave={() => setHover(null)}>
              {element.kind !== 'tube' && (
                <line
                  x1={tx(s.x + nx * s.r * rScale)} y1={ty(s.y + ny * s.r * rScale)}
                  x2={tx(s.x - nx * s.r * rScale)} y2={ty(s.y - ny * s.r * rScale)}
                  stroke={element.assumed ? ASSUMED : 'var(--color-text-muted)'}
                  strokeWidth={on ? 1.6 : 0.9}
                  strokeDasharray={element.kind === 'transition' ? '2 2' : undefined}
                />
              )}
              {/* A fat invisible target, so hovering a thin fitting works. */}
              <circle cx={tx(s.x)} cy={ty(s.y)} r={7} fill="transparent" />
              {on && (
                <circle cx={tx(s.x)} cy={ty(s.y)} r={2.4} fill={BORE} />
              )}
            </g>
          );
        })}
      </svg>

      <p className="font-mono text-[9px] leading-relaxed text-[var(--color-text-muted)]">
        {/* "radius ×11.2" read as a bend radius. It is the exaggeration: at
            true scale a metre of 10 mm tube is a hairline. */}
        bore drawn ×{rScale.toFixed(1)} · widest {(maxR * 2).toFixed(2)} mm
        {anyAssumed && <span className="text-amber-500"> · amber = assumed</span>}
      </p>

      <p className="min-h-[26px] text-[10px] leading-tight text-[var(--color-text-secondary)]">
        {hovered ? (
          <>
            <b>{hovered.element.label}</b>
            {' · '}⌀{(hovered.element.rStart * 2).toFixed(2)}
            {hovered.element.rEnd !== hovered.element.rStart &&
              ` → ${(hovered.element.rEnd * 2).toFixed(2)}`} mm
            {' · '}{hovered.element.length.toFixed(1)} mm long
            {hovered.element.engagement !== undefined &&
              ` · engages ${hovered.element.engagement} mm`}
            {hovered.element.assumed && <span className="text-amber-500"> · assumed</span>}
          </>
        ) : (
          <span className="text-[var(--color-text-muted)]">Hover a station to read it.</span>
        )}
      </p>
    </div>
  );
}
