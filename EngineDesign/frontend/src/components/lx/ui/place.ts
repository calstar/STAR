/**
 * Where a popover (hover card, menu) goes so it stays on screen: under its anchor, left edges
 * aligned, flipping to the right edge or above when it would leave the viewport, and clamped as a
 * last resort. Pure, so the flips are tested rather than eyeballed.
 */
export interface Rect { left: number; top: number; right: number; bottom: number }
export interface Size { w: number; h: number }
export interface Placement { left: number; top: number; side: 'below' | 'above'; align: 'start' | 'end' }

export function placePopover(anchor: Rect, card: Size, viewport: Size, opts: {
  prefer?: 'below' | 'above'; align?: 'start' | 'end'; gap?: number; margin?: number;
} = {}): Placement {
  const { prefer = 'below', gap = 6, margin = 8 } = opts;
  let align = opts.align ?? 'start';

  // Horizontal: the preferred edge, else the other, else clamped inside the viewport.
  const startLeft = anchor.left;
  const endLeft = anchor.right - card.w;
  const fits = (l: number) => l >= margin && l + card.w <= viewport.w - margin;
  let left = align === 'start' ? startLeft : endLeft;
  if (!fits(left)) {
    const other = align === 'start' ? endLeft : startLeft;
    if (fits(other)) { left = other; align = align === 'start' ? 'end' : 'start'; }
    else left = Math.min(Math.max(left, margin), Math.max(margin, viewport.w - margin - card.w));
  }

  // Vertical: the preferred side if it fits, else the other if it fits, else the roomier one.
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - card.h;
  const fitsBelow = below + card.h <= viewport.h - margin;
  const fitsAbove = above >= margin;
  let side: Placement['side'];
  if (prefer === 'below') side = fitsBelow || !fitsAbove && viewport.h - anchor.bottom >= anchor.top ? 'below' : 'above';
  else side = fitsAbove || !fitsBelow && anchor.top > viewport.h - anchor.bottom ? 'above' : 'below';
  let top = side === 'below' ? below : above;
  top = Math.min(Math.max(top, margin), Math.max(margin, viewport.h - margin - card.h));

  return { left, top, side, align };
}
