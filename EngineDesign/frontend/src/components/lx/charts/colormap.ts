/**
 * Sequential colormaps for heat layers (x–t heatmaps, Isp contours) and the schematic's pressure
 * stroke: perceptually uniform, readable in greyscale and by deuteranopes and protanopes, so a
 * value's colour never depends on telling red from green.
 *
 * Stops are matplotlib's viridis (17 even steps) and magma (tenths), by van der Walt & Smith
 * (2015, CC0), joined linearly in sRGB.
 */

export type ColormapName = 'viridis' | 'magma';

const STOPS: Record<ColormapName, readonly string[]> = {
  // 17 even steps, the same stops the schematic uses (hero/colormap.ts), so a pressure colour on the
  // schematic and on a heat layer agree.
  viridis: [
    '#440154', '#48186a', '#472d7b', '#424086', '#3b528b', '#33638d', '#2c728e', '#26828e', '#21918c',
    '#1fa088', '#28ae80', '#3fbc73', '#5ec962', '#84d44b', '#addc30', '#d8e219', '#fde725',
  ],
  magma: ['#000004', '#140e36', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f7705c', '#fe9f6d', '#fecf92', '#fcfdbf'],
};

type RGB = [number, number, number];

function hex(c: string): RGB {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const RGB_STOPS: Record<ColormapName, RGB[]> = {
  viridis: STOPS.viridis.map(hex),
  magma: STOPS.magma.map(hex),
};

/** The colour at `f` in [0, 1] (clamped; NaN is the low end) as [r, g, b] 0..255. */
export function colormapRGB(name: ColormapName, f: number): RGB {
  const stops = RGB_STOPS[name];
  const x = Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
  const pos = x * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const k = pos - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
}

/** The colour at `f` as a CSS `rgb()` string. */
export function colormapCss(name: ColormapName, f: number): string {
  const [r, g, b] = colormapRGB(name, f);
  return `rgb(${r} ${g} ${b})`;
}

/** Relative luminance (WCAG) of an sRGB colour, for picking a label's ink on a cell. */
export function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
