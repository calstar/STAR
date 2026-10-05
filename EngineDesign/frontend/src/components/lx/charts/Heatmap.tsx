import { useMemo } from 'react';
import type { TimeStore } from '../time/store';
import type { ColormapName } from './colormap';
import type { ChartEvent } from './types';
import { XYChart } from './XYChart';
import type { HeatLayer } from './xyTypes';

export interface HeatmapProps {
  /** The burn's clock [s] (one value per row of `z`). */
  t: readonly number[];
  /** The other axis: an axial station [mm], a node... ascending. */
  s: readonly number[];
  /** `z[k][j]`: the value at time t[k], station s[j] (the sidecar's layout: one row per step). */
  z: readonly (readonly (number | null)[])[];
  /** The field's name and unit: "q", "MW/m²". */
  name: string;
  unit: string;
  /** The station axis' name and unit: "x", "mm". */
  sName: string;
  sUnit: string;
  /** Default viridis; magma reads as heat. */
  colormap?: ColormapName;
  range?: readonly [number, number];
  digits?: number;
  /** Iso-lines over the cells. */
  contours?: readonly number[] | { count: number };
  events?: readonly ChartEvent[];
  height: number;
  title: string;
  store?: TimeStore | null;
  className?: string;
}

/**
 * An x–t heatmap (heat flux or wall temperature along the engine through the burn): time across,
 * like every other chart, so the page's cursor is the same vertical line; the station up the side;
 * a CVD-safe sequential colormap with its colourbar at the right. Hovering a cell scrubs the page
 * and reads the cell out; at rest the readout gives the peak along the cursor's column.
 */
export function Heatmap({ t, s, z, name, unit, sName, sUnit, colormap, range, digits, contours, events, height, title, store, className }: HeatmapProps) {
  const heat = useMemo<HeatLayer>(
    () => ({ x: t, y: s, z, unit, name, colormap, range, digits, contours }),
    [t, s, z, unit, name, colormap, range, digits, contours],
  );
  return (
    <XYChart series={NO_SERIES} heat={heat} xUnit="s" yUnit={sUnit} yName={sName} timeAxis="x" events={events}
             height={height} title={title} store={store} className={className} />
  );
}

const NO_SERIES: never[] = [];
