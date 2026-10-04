/** Text for layout done outside CSS (direct labels, timeline markers, axis ticks). */

import { useMemo, useSyncExternalStore } from 'react';
import { fmt } from '../../layerx/format';

export const MONO = "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace";
export const SANS = "'Inter Variable', Inter, system-ui, sans-serif";

let ctx: CanvasRenderingContext2D | null | undefined;

/** Width of `text` in `font` [CSS px]; a 6.5 px-a-character estimate where there is no canvas. */
export function textWidth(text: string, font: string): number {
  if (ctx === undefined) ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  if (!ctx) return text.length * 6.5;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** A number for the page: fixed decimals, a real minus sign. */
export function num(v: number | null | undefined, digits: number): string {
  return fmt(v, digits).replace(/^-/, '−');
}

// ------------------------------------------------------------------ fonts arriving

/**
 * Text measured before the bundled fonts arrive is measured in the fallback face, which is
 * narrower or wider; layout that measures text (the timeline's labels, a chart's gutters) does it
 * again when a font finishes loading. The epoch counts those moments.
 */
let fontEpoch = 0;
const fontListeners = new Set<() => void>();
let watching = false;

function bump(): void {
  fontEpoch += 1;
  for (const f of fontListeners) f();
}

function watchFonts(): void {
  if (watching || typeof document === 'undefined' || !document.fonts) return;
  watching = true;
  document.fonts.ready.then(bump, () => {});
  document.fonts.addEventListener?.('loadingdone', bump);
}

/** Calls `fn` whenever a font finishes loading; returns the unsubscribe. */
export function onFontsChange(fn: () => void): () => void {
  watchFonts();
  fontListeners.add(fn);
  return () => fontListeners.delete(fn);
}

export function currentFontEpoch(): number {
  return fontEpoch;
}

/**
 * A text measurer for `font` that changes identity when a font loads, so a `useMemo` that lays
 * text out with it runs again with the real widths.
 */
export function useTextMeasure(font: string): (text: string) => number {
  const epoch = useSyncExternalStore(onFontsChange, currentFontEpoch, currentFontEpoch);
  return useMemo(() => (text: string) => widthAt(epoch, font, text), [font, epoch]);
}

/** Widths of the current font epoch, cached; a new epoch starts an empty cache. */
let cacheEpoch = -1;
const widthCache = new Map<string, number>();
function widthAt(epoch: number, font: string, text: string): number {
  if (epoch !== cacheEpoch) {
    widthCache.clear();
    cacheEpoch = epoch;
  }
  const key = `${font}|${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  const w = textWidth(text, font);
  widthCache.set(key, w);
  return w;
}
