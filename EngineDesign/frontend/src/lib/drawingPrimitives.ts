/**
 * Drawing primitives from engine/core/injectors/drawing.py, and a DXF writer for them.
 *
 * The backend places every line; this module only turns the list into a file. SVG rendering
 * is in components/InjectorDrawing.tsx and reads the same list, so what is on screen is what
 * CAD receives.
 */

export type Pt = [number, number];

export type Primitive =
  | { t: 'poly'; layer: string; pts: Pt[]; closed: boolean; id?: string }
  | { t: 'circle'; layer: string; c: Pt; r: number; id?: string }
  | { t: 'dim'; layer: string; a: Pt; b: Pt; off: Pt; text: string; side?: 'right' }
  | { t: 'text'; layer: string; at: Pt; text: string; anchor: 'start' | 'middle' | 'end' };

export interface InjectorDrawings {
  face: Primitive[];
  back: Primitive[];
  section_doublet: Primitive[];
  section_between: Primitive[];
  /** The half-section alone, x = radius, y = up from the face: a CAD revolve sketch. */
  revolve?: Primitive[];
  /** The cover plate from above: feed ports over the channels. */
  ports?: Primitive[];
}

/** AutoCAD colour index per layer, so the file opens legibly without a layer setup. */
const LAYER_ACI: Record<string, number> = {
  PLATE: 7, SLEEVE: 8, LINER: 30, CHAMBER: 7, GROOVE: 7, CHANNEL_O: 4, CHANNEL_F: 30, PASSAGE_O: 4, PASSAGE_F: 30, JET_O: 4, JET_F: 30,
  IMPINGE: 7, IMPINGE_RING: 7, IGNITER: 7, THREAD: 8, HOLE_O: 4, HOLE_F: 30, BAD: 1, HIDDEN: 8, CENTER: 1, BREAK: 8,
  PITCH_O: 4, PITCH_F: 30, KEEPOUT: 2, LAND: 2, NOTE: 8, DIM: 3, SEAL: 3,
};

/** Layers that are shading only: drawn filled on screen, not written to CAD. */
const FILL_ONLY = new Set(['HOLE_O', 'HOLE_F']);

export function bbox(prims: Primitive[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  for (const p of prims) {
    if (p.t === 'poly') p.pts.forEach(([x, y]) => add(x, y));
    else if (p.t === 'circle') { add(p.c[0] - p.r, p.c[1] - p.r); add(p.c[0] + p.r, p.c[1] + p.r); }
    else if (p.t === 'dim') { add(...p.a); add(...p.b); add(p.a[0] + p.off[0], p.a[1] + p.off[1]); add(p.b[0] + p.off[0], p.b[1] + p.off[1]); }
    else add(...p.at);
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** DXF R12 (AC1009): the most widely readable flavour. Model units mm or inch. */
export function primitivesToDxf(prims: Primitive[], unit: 'mm' | 'in' = 'mm'): string {
  const k = unit === 'mm' ? 1000 : 1 / 0.0254;
  const f = (v: number) => (v * k).toFixed(4);
  const layers = Array.from(new Set(prims.map((p) => p.layer).filter((l) => !FILL_ONLY.has(l))));
  const out: string[] = [];
  const g = (...kv: (string | number)[]) => { for (const x of kv) out.push(String(x)); };
  g(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, unit === 'mm' ? 4 : 1, 0, 'ENDSEC');
  g(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LTYPE', 70, 1,
    0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, '0.0', 0, 'ENDTAB');
  g(0, 'TABLE', 2, 'LAYER', 70, layers.length);
  for (const L of layers) g(0, 'LAYER', 2, L, 70, 0, 62, LAYER_ACI[L] ?? 7, 6, 'CONTINUOUS');
  g(0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES');
  const line = (L: string, a: Pt, b: Pt) => g(0, 'LINE', 8, L, 10, f(a[0]), 20, f(a[1]), 30, '0.0', 11, f(b[0]), 21, f(b[1]), 31, '0.0');
  const txt = (L: string, at: Pt, s: string, h: number) => g(0, 'TEXT', 8, L, 10, f(at[0]), 20, f(at[1]), 30, '0.0', 40, (h * k).toFixed(4), 1, s);
  const size = bbox(prims);
  const th = Math.max(size.w, size.h) / 90;
  for (const p of prims) {
    if (FILL_ONLY.has(p.layer)) continue;     // a hole's fill: its walls are the edges
    if (p.t === 'poly') {
      g(0, 'POLYLINE', 8, p.layer, 66, 1, 70, p.closed ? 1 : 0);
      for (const [x, y] of p.pts) g(0, 'VERTEX', 8, p.layer, 10, f(x), 20, f(y), 30, '0.0');
      g(0, 'SEQEND', 8, p.layer);
    } else if (p.t === 'circle') {
      g(0, 'CIRCLE', 8, p.layer, 10, f(p.c[0]), 20, f(p.c[1]), 30, '0.0', 40, f(p.r));
    } else if (p.t === 'dim') {
      const a2: Pt = [p.a[0] + p.off[0], p.a[1] + p.off[1]];
      const b2: Pt = [p.b[0] + p.off[0], p.b[1] + p.off[1]];
      line(p.layer, p.a, a2); line(p.layer, p.b, b2); line(p.layer, a2, b2);
      txt(p.layer, [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2 + th * 0.4], p.text, th);
    } else {
      txt(p.layer, p.at, p.text, th);
    }
  }
  g(0, 'ENDSEC', 0, 'EOF');
  return out.join('\n') + '\n';
}

export function downloadText(content: string, filename: string, type = 'application/dxf') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
