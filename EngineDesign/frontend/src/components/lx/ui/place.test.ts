import { describe, expect, it } from 'vitest';
import { placePopover } from './place';

const vp = { w: 1440, h: 900 };
const card = { w: 320, h: 160 };
const rect = (left: number, top: number, w = 80, h = 20) => ({ left, top, right: left + w, bottom: top + h });

describe('placePopover', () => {
  it('goes under the anchor, left edges aligned, when there is room', () => {
    expect(placePopover(rect(100, 100), card, vp)).toEqual({ left: 100, top: 126, side: 'below', align: 'start' });
  });

  it('flips to the right edge near the right of the screen', () => {
    const p = placePopover(rect(1300, 100), card, vp);
    expect(p.align).toBe('end');
    expect(p.left).toBe(1380 - 320);
  });

  it('flips above near the bottom of the screen', () => {
    const p = placePopover(rect(100, 820), card, vp);
    expect(p.side).toBe('above');
    expect(p.top).toBe(820 - 6 - 160);
  });

  it('clamps inside the viewport when neither edge fits (a narrow window)', () => {
    const p = placePopover(rect(150, 100), card, { w: 360, h: 640 });
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + card.w).toBeLessThanOrEqual(360 - 8);
  });

  it('honours a preference for above and for the end edge', () => {
    const p = placePopover(rect(600, 400), card, vp, { prefer: 'above', align: 'end' });
    expect(p).toEqual({ left: 680 - 320, top: 400 - 6 - 160, side: 'above', align: 'end' });
  });

  it('never puts the card off the top of the screen', () => {
    const p = placePopover(rect(100, 10, 80, 860), card, vp);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + card.h).toBeLessThanOrEqual(900 - 8);
  });
});
