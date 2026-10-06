/**
 * The schematic's shapes and inks, shared by the static symbols and the live layer that paints
 * state over them. Paths are about the symbol's centre, along its through-axis.
 */

export const INK = 'var(--lx-text-2)';
export const INK_QUIET = 'var(--lx-text-3)';
export const PAPER = 'var(--lx-surface)';

/** A valve body: two triangles meeting at the centre, `w` along the line. */
export const bowtie = (w: number, h: number) =>
  `M${-w / 2} ${-h / 2} L0 0 L${-w / 2} ${h / 2} Z M${w / 2} ${-h / 2} L0 0 L${w / 2} ${h / 2} Z`;

export const VALVE_W = 18;
export const VALVE_H = 10;
export const REG_W = 20;
export const REG_H = 11;

/** A tank's outline: a vessel with elliptical heads. */
export const tankShape = (w: number, h: number) => ({ x: -w / 2, y: -h / 2, width: w, height: h, rx: w / 2, ry: Math.min(w / 4, h / 4) });
export const bottleShape = (w: number, h: number) => ({ x: -w / 2, y: -h / 2, width: w, height: h, rx: w / 2, ry: w / 2 });

/** The engine, pointing right: injector face, chamber, throat, bell. */
export const ENGINE_PATH = 'M-16 -10 L2 -10 L8 -3.5 L16 -9 L16 9 L8 3.5 L2 10 L-16 10 Z';
export const CHAMBER_PATH = 'M-16 -10 L2 -10 L8 -3.5 L8 3.5 L2 10 L-16 10 Z';
