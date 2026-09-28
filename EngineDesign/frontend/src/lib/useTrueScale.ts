import { useEffect, useMemo, useState } from 'react';
import { contourLayout } from './contourScale';

/**
 * Width of the element `ref` is attached to, and a true-scale layout (lib/contourScale) for a
 * contour spanning [xMin, xMax] with maximum radius rMax at that width. Every chamber chart uses
 * this, so none of them can drift back to fitting the card instead of the plot.
 */
export function useTrueScale(xMin: number, xMax: number, rMax: number, full: boolean) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const update = () => setWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  const layout = useMemo(
    () => (Number.isFinite(xMin) && Number.isFinite(xMax) && xMax > xMin && rMax > 0 && width > 0
      ? contourLayout(xMin, xMax, rMax, full, width)
      : null),
    [xMin, xMax, rMax, full, width],
  );
  return { ref: setEl, width, layout };
}
