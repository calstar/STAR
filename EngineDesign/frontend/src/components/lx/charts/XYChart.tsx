import './chart.css';
import { useLayoutEffect, useRef } from 'react';
import { useOptionalTimeStore } from '../time/hooks';
import type { TimeStore } from '../time/store';
import { XYEngine } from './xy';
import type { XYData } from './xyTypes';

export interface XYChartProps extends XYData {
  /** Total height [px], readout row included. */
  height: number;
  /** What the chart is, for a screen reader. */
  title: string;
  /** The page's cursor (for a time axis or a timed path); default the page's TimeProvider. */
  store?: TimeStore | null;
  className?: string;
}

/**
 * An x–y chart on the Layer X look: a Nyquist plot (re/im with the critical point), the operating
 * map (the burn's path over O/F and Pc on Isp contours, with the design point and limit lines),
 * or, with a heat layer and `timeAxis`, an x–t heatmap. Canvas underneath, DOM text on top placed
 * so nothing collides; a timed path or a time axis follows the page's cursor.
 *
 * Memoise the arrays: a new identity redraws.
 */
export function XYChart({ height, title, store, className, ...data }: XYChartProps) {
  const readoutRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const engineRef = useRef<XYEngine | null>(null);
  const pageStore = useOptionalTimeStore();
  const active = store === undefined ? pageStore : store;
  const {
    series, heat, marks, regions, lines, worst, xName, yName, xUnit, yUnit, xLog, xPin, yPin, equalAspect, timeAxis, events, xDigits, yDigits,
  } = data;

  useLayoutEffect(() => {
    const d: XYData = { series, heat, marks, regions, lines, worst, xName, yName, xUnit, yUnit, xLog, xPin, yPin, equalAspect, timeAxis, events, xDigits, yDigits };
    const engine = engineRef.current;
    if (!engine) {
      engineRef.current = new XYEngine(rootRef.current!, readoutRef.current!, plotRef.current!, d, active);
    } else {
      engine.update(d);
      engine.setStore(active);
    }
  }, [series, heat, marks, regions, lines, worst, xName, yName, xUnit, yUnit, xLog, xPin, yPin, equalAspect, timeAxis, events, xDigits, yDigits, active]);

  useLayoutEffect(
    () => () => {
      engineRef.current?.destroy();
      engineRef.current = null;
    },
    [],
  );

  return (
    <figure ref={rootRef} className={`lx-chart lx-xy${className ? ` ${className}` : ''}`} style={{ height }} aria-label={title}>
      <div ref={readoutRef} className="lx-chart-readout" aria-live="off" />
      <div ref={plotRef} className="lx-chart-plot" />
    </figure>
  );
}
