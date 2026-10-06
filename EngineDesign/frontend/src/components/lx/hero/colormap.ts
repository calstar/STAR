/**
 * The schematic's two encodings, as pure functions:
 *
 *   colour   local pressure on one sequential colormap, viridis (perceptually uniform, monotonic in
 *            lightness, readable under deuteranopia and protanopia). Each theme uses the window of
 *            it that keeps a 1.5 px line at 3:1 against its panel: dark [0.35, 1] (blue-teal to
 *            yellow), light [0, 0.6] (purple to green). Lightness still runs one way in both, so
 *            order reads without the colourbar.
 *   width    mass flow, 1 px (no flow) to 5 px (the run's largest), on a square-root scale so the
 *            gas lines (a few g/s against kg/s of liquid) still read as flowing.
 *
 * Pressure is placed on a log scale of absolute pressure: a stand runs from a 4,500 psi bottle to
 * the atmosphere, and a linear scale would paint every line downstream of the regulator one colour.
 */

export type ThemeName = 'dark' | 'light';

/** matplotlib's viridis at 17 even steps (exact; from matplotlib.colormaps['viridis']). */
export const VIRIDIS: readonly string[] = [
  '#440154', '#48186a', '#472d7b', '#424086', '#3b528b', '#33638d', '#2c728e', '#26828e', '#21918c',
  '#1fa088', '#28ae80', '#3fbc73', '#5ec962', '#84d44b', '#addc30', '#d8e219', '#fde725',
];

/** The part of viridis each theme draws with: [low, high] in 0..1. */
export const WINDOW: Record<ThemeName, readonly [number, number]> = {
  dark: [0.35, 1],
  light: [0, 0.6],
};

const hexToRgb = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const STOPS = VIRIDIS.map(hexToRgb);

const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');

/** viridis(u) for u in 0..1 (clamped), linear between the 17 stops, as #rrggbb. */
export function viridis(u: number): string {
  const x = Math.min(1, Math.max(0, Number.isFinite(u) ? u : 0)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  return `#${hex2(a[0] + (b[0] - a[0]) * f)}${hex2(a[1] + (b[1] - a[1]) * f)}${hex2(a[2] + (b[2] - a[2]) * f)}`;
}

/** The colour of a normalised value (0 = the scale's low end) in a theme; null for no value. */
export function seqColor(u: number | null | undefined, theme: ThemeName): string | null {
  if (u === null || u === undefined || !Number.isFinite(u)) return null;
  const [lo, hi] = WINDOW[theme];
  return viridis(lo + (hi - lo) * Math.min(1, Math.max(0, u)));
}

// ------------------------------------------------------------------ pressure scale

export interface PressureScale {
  /** Absolute pressure [psia] at the low and high ends. */
  lo: number;
  hi: number;
  /** psia -> 0..1 (clamped); NaN for no value. */
  norm(psia: number | null | undefined): number;
}

/**
 * A log scale over absolute pressure. `lo` is floored at 1 psia (a vented line reads the site's
 * atmosphere, never zero absolute); a degenerate range is widened so it still maps.
 */
export function pressureScale(lo: number, hi: number): PressureScale {
  let a = Math.max(1, Number.isFinite(lo) ? lo : 1);
  let b = Number.isFinite(hi) ? hi : a * 10;
  if (b < a) [a, b] = [b, a];
  a = Math.max(1, a);
  if (b / a < 1.5) b = a * 1.5;
  const la = Math.log(a);
  const span = Math.log(b) - la;
  return {
    lo: a,
    hi: b,
    norm(p) {
      if (p === null || p === undefined || !Number.isFinite(p)) return NaN;
      return Math.min(1, Math.max(0, (Math.log(Math.max(p, 1e-9)) - la) / span));
    },
  };
}

/** The low and high ends of a scale covering finite values in `columns` (absolute psia). */
export function pressureRange(columns: Iterable<readonly (number | null | undefined)[]>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const col of columns) {
    for (const v of col) {
      if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
}

/**
 * Colourbar ticks: both ends, and round display values (1, 2, 5 x 10^k in the display unit) between,
 * each with its position 0..1 along the bar. `toDisplay`/`fromDisplay` convert psia to the page's
 * unit (psia, bar). Interior ticks are taken roundest first (powers of ten, then 2s and 5s) while
 * their labels, `widthOf(value)` px wide on a `barPx` bar, keep `gapPx` clear of every label kept.
 */
export function colorbarTicks(scale: PressureScale, toDisplay: (psia: number) => number, fromDisplay: (d: number) => number,
  { barPx = 160, widthOf = (v: number) => String(Math.round(v)).length * 7, gapPx = 8, max = 3 }:
  { barPx?: number; widthOf?: (v: number) => number; gapPx?: number; max?: number } = {}): { u: number; value: number }[] {
  const lo = toDisplay(scale.lo);
  const hi = toDisplay(scale.hi);
  // The end labels sit inside the bar's ends (left-aligned at 0, right-aligned at 1).
  const span = (t: { u: number; value: number }, end: 'lo' | 'hi' | null): [number, number] => {
    const w = widthOf(t.value);
    const x = t.u * barPx;
    return end === 'lo' ? [x, x + w] : end === 'hi' ? [x - w, x] : [x - w / 2, x + w / 2];
  };
  const kept: { t: { u: number; value: number }; s: [number, number] }[] = [
    { t: { u: 0, value: lo }, s: span({ u: 0, value: lo }, 'lo') },
    { t: { u: 1, value: hi }, s: span({ u: 1, value: hi }, 'hi') },
  ];
  const cands: { u: number; value: number; rank: number }[] = [];
  const top = Math.max(Math.abs(lo), Math.abs(hi), 1);
  for (let k = -2; k <= Math.ceil(Math.log10(top)) + 1; k++) {
    for (const [m, rank] of [[1, 0], [5, 1], [2, 2]] as const) {
      const v = m * 10 ** k;
      if (v <= lo || v >= hi) continue;
      cands.push({ u: scale.norm(fromDisplay(v)), value: v, rank });
    }
  }
  cands.sort((a, b) => a.rank - b.rank || Math.abs(a.u - 0.5) - Math.abs(b.u - 0.5));
  let inner = 0;
  for (const c of cands) {
    if (inner >= max) break;
    const s = span(c, null);
    if (s[0] < 0 || s[1] > barPx) continue;
    if (kept.every((k) => s[1] + gapPx <= k.s[0] || k.s[1] + gapPx <= s[0])) {
      kept.push({ t: { u: c.u, value: c.value }, s });
      inner++;
    }
  }
  return kept.map((k) => k.t).sort((a, b) => a.u - b.u);
}

// ------------------------------------------------------------------ flow width

export const WIDTH_MIN = 1;
export const WIDTH_MAX = 5;

/** Stroke width [px] for a mass flow against the run's largest; 1 px for none or unknown. */
export function flowWidth(mdot: number | null | undefined, max: number): number {
  if (mdot === null || mdot === undefined || !Number.isFinite(mdot) || !(max > 0)) return WIDTH_MIN;
  const f = Math.min(1, Math.abs(mdot) / max);
  return WIDTH_MIN + (WIDTH_MAX - WIDTH_MIN) * Math.sqrt(f);
}

// ------------------------------------------------------------------ contrast (for tests and the bar)

/** WCAG relative luminance of #rrggbb. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
