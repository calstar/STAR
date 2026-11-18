/**
 * The whole stand as one picture, for the DAQ's schematic page.
 *
 * The DAQ shows the drawing read-only, both pages at once, and paints live
 * readings onto it. It cannot run this canvas (it is another app, on another
 * React), so it gets a picture -- and a picture it can paint onto only if it
 * can find each symbol and line in it. Two things make that possible:
 *
 * - every symbol is tagged `data-pid-symbol="<node id>"` and every line
 *   `data-pid-line="<edge id>"` (put on the live canvas for the length of the
 *   shot, `shootSheet` in exportImage.ts), so the overlay never depends on
 *   React Flow's own class names;
 * - every symbol's box is written out in the stand's coordinates (`boxes`),
 *   so the overlay places a reading without measuring HTML inside an SVG.
 *
 * A page is a sheet shot on its own, as the sheet export takes it; this lays
 * the sheets side by side under their page names. Pages are joined at paired
 * disconnects and nowhere else (pages.ts), so each half of a pair is labelled
 * with its mate: following a fill across the umbilical means finding the
 * other half.
 *
 * Pure string work, so it runs where the tests do: no DOM.
 */

/** One page, shot. Sheet pixels are `(flow + origin/scale) * scale`. */
export interface SheetShot {
  page: string;
  /** `<svg ...>...</svg>` as html-to-image hands it back, decoded. */
  svg: string;
  width: number;
  height: number;
  /** Where flow (0, 0) lands on the sheet, in sheet pixels. */
  origin: { x: number; y: number };
  /** Sheet pixels per flow unit. */
  scale: number;
}

/** A symbol as the stand needs it: where it is, and what it mates with. */
export interface StandNode {
  id: string;
  page: string;
  label: string;
  /** Flow units, absolute. */
  x: number; y: number; width: number; height: number;
  /** `options.pairedWith`: the other half of a disconnect pair, if any. */
  pairedWith?: string;
}

export interface StandSheet {
  svg: string;
  width: number;
  height: number;
  /** Every symbol's box, in stand pixels: [x, y, width, height]. */
  boxes: Record<string, [number, number, number, number]>;
  /** Mate of each half of a disconnect pair, both ways. */
  mates: Record<string, string>;
  /** Ids the picture should carry and does not. Non-empty is a failed export. */
  missing: { symbols: string[]; lines: string[] };
}

/** Space between pages, and above them for the page name, in sheet pixels. */
export const GAP = 192;
export const CAPTION = 72;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Each half of each disconnect pair, mapped to its mate.
 *
 * pid-designer saves only the half that was edited (gse-pages-and-hookup.md),
 * so a pairing written on one half counts for both. Two halves naming
 * different partners are not a pair -- feed-twin leaves them unmated, and a
 * label claiming otherwise would draw a connection the twin does not make.
 */
export function matesOf(nodes: StandNode[]): Record<string, string> {
  const ids = new Set(nodes.map(n => n.id));
  const named = new Map<string, string>();
  for (const n of nodes) if (n.pairedWith && ids.has(n.pairedWith) && n.pairedWith !== n.id) named.set(n.id, n.pairedWith);
  const out: Record<string, string> = {};
  for (const [a, b] of named) {
    const back = named.get(b);
    if (back !== undefined && back !== a) continue;
    out[a] = b;
    out[b] = a;
  }
  return out;
}

/** The text under each half of a pair: its mate's tag, and the mate's page when it is another. */
export function mateLabel(node: StandNode, mate: StandNode): string {
  const tag = mate.label || mate.id;
  return mate.page === node.page ? `⇄ ${tag}` : `⇄ ${tag} (${mate.page})`;
}

/**
 * Lay the pages side by side and say what is missing.
 *
 * `lines` is every edge that should be drawn: an edge between two symbols on
 * one page. (An edge between pages is not drawn, by the drawing's own rule.)
 */
export function composeStand(
  shots: SheetShot[],
  nodes: StandNode[],
  lines: string[],
  ink = '#f2f2f2',
): StandSheet {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const mates = matesOf(nodes);
  const boxes: StandSheet['boxes'] = {};
  const parts: string[] = [];
  let x = 0;
  let height = 0;

  for (const shot of shots) {
    const top = CAPTION;
    parts.push(
      `<text x="${x}" y="${CAPTION / 2}" font-family="ui-monospace, Menlo, monospace" font-size="${CAPTION / 2}" ` +
      `font-weight="bold" fill="${esc(ink)}" data-pid-page-name="${esc(shot.page)}">${esc(shot.page)}</text>`,
    );
    parts.push(nest(shot.svg, x, top, shot.page));
    for (const n of nodes) {
      if (n.page !== shot.page) continue;
      boxes[n.id] = [
        x + shot.origin.x + n.x * shot.scale,
        top + shot.origin.y + n.y * shot.scale,
        n.width * shot.scale,
        n.height * shot.scale,
      ];
    }
    height = Math.max(height, top + shot.height);
    x += shot.width + GAP;
  }
  const width = Math.max(0, x - GAP);

  for (const [id, mateId] of Object.entries(mates)) {
    const box = boxes[id];
    const node = byId.get(id)!;
    if (!box) continue;
    const [bx, by, bw, bh] = box;
    parts.push(
      `<text x="${bx + bw / 2}" y="${by + bh + 28}" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" ` +
      `font-size="22" fill="${esc(ink)}" data-pid-mate="${esc(id)}">${esc(mateLabel(node, byId.get(mateId)!))}</text>`,
    );
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    parts.join('') + '</svg>';

  const placed = new Set(shots.map(s => s.page));
  const has = (attr: string, id: string) => svg.includes(`${attr}="${esc(id)}"`);
  return {
    svg, width, height, boxes, mates,
    missing: {
      symbols: nodes.filter(n => placed.has(n.page) && !has('data-pid-symbol', n.id)).map(n => n.id),
      lines: lines.filter(id => !has('data-pid-line', id)),
    },
  };
}

/** A sheet's own `<svg>` placed at (x, y) inside the stand's. */
function nest(svg: string, x: number, y: number, page: string): string {
  const body = svg.replace(/^\s*<\?xml[^>]*>\s*/, '');
  if (!/^<svg[\s>]/.test(body)) throw new Error(`sheet "${page}" is not an SVG`);
  return body.replace(/^<svg/, `<svg x="${x}" y="${y}" data-pid-page="${esc(page)}"`);
}
