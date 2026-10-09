import 'uplot/dist/uPlot.min.css';
import './chart.css';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useOptionalTimeStore } from '../time/hooks';
import type { TimeStore } from '../time/store';
import { useUnits, type QuantityKind } from '../units';
import { ChartEngine } from './engine';
import { inUnits, type ChartQuantity } from './quantity';
import type { ChartData } from './types';

export interface ChartProps extends ChartData {
  /** Total height [px], readout row included: 220 standard, 300 hero, 140 small multiples. */
  height: number;
  /** What the chart is, for a screen reader ("Tank, injector and chamber pressure"). */
  title?: string;
  /** The cursor to follow; default the page's TimeProvider. null: a cursor of its own. */
  store?: TimeStore | null;
  /**
   * What the values are, in the model's units (psia, N, kg, a fraction for a percent): the chart
   * converts them, its bands, limits and pinned ends to the page's unit system and takes `yUnit`
   * and the readout's decimals from it. Without it the values are drawn as given, in `yUnit`.
   */
  quantity?: ChartQuantity | QuantityKind;
  className?: string;
}

/**
 * A Layer X time chart: uPlot underneath, the page's time cursor on top.
 *
 * Series are named at their right ends (no legend), the readout row above the plot gives each
 * value at the cursor with the y unit heading the tick column, and hovering scrubs every view on
 * the page. Memoise `t`, `series` and the decoration props: a new array identity is new data,
 * and the plot re-takes it.
 */
export function Chart({
  t, series, yUnit, band, bands, spans, limits, worst, events, xLabel, digits, yPin, xTime, xLog,
  height, title, store, quantity, className,
}: ChartProps) {
  const rootRef = useRef<HTMLElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ChartEngine | null>(null);
  const pageStore = useOptionalTimeStore();
  const units = useUnits();
  const active = store === undefined ? pageStore : store;
  const qKey = quantity === undefined ? '' : JSON.stringify(quantity);

  const data = useMemo<ChartData>(() => {
    const raw: ChartData = { t, series, yUnit, band, bands, spans, limits, worst, events, xLabel, digits, yPin, xTime, xLog };
    return qKey ? inUnits(raw, JSON.parse(qKey) as ChartQuantity | QuantityKind, units) : raw;
  }, [t, series, yUnit, band, bands, spans, limits, worst, events, xLabel, digits, yPin, xTime, xLog, qKey, units]);

  useLayoutEffect(() => {
    const engine = engineRef.current;
    if (!engine) {
      engineRef.current = new ChartEngine(rootRef.current!, readoutRef.current!, plotRef.current!, data, active);
    } else {
      // Data first: whether the chart follows the page's cursor depends on its x axis.
      engine.update(data);
      engine.setStore(active);
    }
  }, [data, active]);

  useLayoutEffect(
    () => () => {
      engineRef.current?.destroy();
      engineRef.current = null;
    },
    [],
  );

  const unit = data.yUnit;
  const name = title ?? `${series.filter((s) => s.label && !s.ghost).map((s) => s.label).join(', ')}${unit ? ` (${unit})` : ''}`;
  return (
    <figure ref={rootRef} className={`lx-chart${className ? ` ${className}` : ''}`} style={{ height }} aria-label={name} data-y-unit={unit || undefined}>
      <div ref={readoutRef} className="lx-chart-readout" />
      <div ref={plotRef} className="lx-chart-plot" />
    </figure>
  );
}
