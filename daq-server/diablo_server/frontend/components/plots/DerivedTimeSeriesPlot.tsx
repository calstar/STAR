'use client'

import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { getDataCache } from '@/lib/data-cache';
import { serverNowMs } from '@/lib/plot-time';
import { xWindowMs, tPlusAxisValues, fmtAxisVal, smartYRange, YAxisHysteresis } from '@/lib/plot-shared';

const DEFAULT_WINDOW_SECONDS = 60;
// Data refresh; backend delivers ≤ ~20 pts/s per stream.
const RENDER_INTERVAL_MS = 100;

export type TransformFn = (rawValue: number) => number | null;

export interface DerivedTimeSeriesPlotHandle {
  resetZoom: () => void;
  ready: boolean;
}

interface DerivedTimeSeriesPlotProps {
  title: string;
  entities: string[];
  component: string;
  transform: TransformFn;
  yLabel?: string;
  labels?: string[];
  colors?: string[];
  windowSeconds?: number;
  height?: number;
  className?: string;
  yRange?: [number, number];
  yTicks?: number[];
  /** When true, enable x-axis drag-to-zoom when paused. */
  enablePlayPause?: boolean;
  /** Controlled pause state (use with onPauseChange). If omitted, uses internal state. */
  isPaused?: boolean;
  /** Called when pause state should change. Use with isPaused for controlled mode. */
  onPauseChange?: (paused: boolean) => void;
  /** When false, do not render Play/Pause/Reset toolbar (render in parent instead). Default true. */
  showControls?: boolean;
}

/** Full-range zoom-out over the plot's current data. */
function zoomToFullRange(u: uPlot | null): void {
  if (!u) return;
  const time = (u.data?.[0] as number[] | undefined) ?? [];
  const valid = time.filter((t) => Number.isFinite(t));
  if (valid.length < 2) return;
  const mn = Math.min(...valid);
  const mx = Math.max(...valid);
  const span = mx - mn || 1;
  u.setScale('x', { min: mn - span * 0.02, max: mx + span * 0.02 });
}

const DerivedTimeSeriesPlot = forwardRef<DerivedTimeSeriesPlotHandle, DerivedTimeSeriesPlotProps>(function DerivedTimeSeriesPlot({
  title,
  entities,
  component,
  transform,
  yLabel = 'Value',
  labels,
  colors = [],
  windowSeconds = DEFAULT_WINDOW_SECONDS,
  height,
  className = '',
  yRange,
  yTicks,
  enablePlayPause = false,
  isPaused: controlledPaused,
  onPauseChange,
  showControls = true,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const [ready, setReady] = useState(false);
  const [internalPaused, setInternalPaused] = useState(false);
  const isPaused = controlledPaused ?? internalPaused;
  const setIsPaused = onPauseChange ?? setInternalPaused;
  const isPausedRef = useRef(false);
  isPausedRef.current = isPaused;

  useImperativeHandle(ref, () => ({
    resetZoom() {
      zoomToFullRange(uplotRef.current);
    },
    ready,
  }), [ready]);

  // Update cursor.drag at runtime when pause state changes (avoid destroying plot)
  useEffect(() => {
    const u = uplotRef.current;
    if (!u || !enablePlayPause) return;
    const dragZoomActive = isPaused;
    (u.cursor as { drag?: { x?: boolean; y?: boolean; setScale?: boolean; uni?: number } }).drag = dragZoomActive
      ? { x: true, y: false, setScale: true, uni: 10 }
      : { x: false, y: false, setScale: false };
  }, [enablePlayPause, isPaused]);

  const componentMap = entities.map(() => component);

  useEffect(() => {
    if (!containerRef.current || !plotRef.current) return;

    const cache = getDataCache();
    const seriesLabels = entities.map((e, i) => labels?.[i] ?? e.split('.').pop() ?? e);
    const colorList = entities.map((_, i) => colors[i] || '#94a3b8');

    if (uplotRef.current) {
      uplotRef.current.destroy();
      uplotRef.current = null;
    }
    setReady(false);

    const getDims = (): { w: number; h: number } | null => {
      const el = containerRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const w = Math.max(0, Math.floor(rect.width));
      const h = Math.max(0, Math.floor(rect.height));
      if (w < 100 || h < 100) return null;
      return { w, h };
    };

    /** Windowed cache read with the per-point transform applied (null → NaN). */
    const readData = (): uPlot.AlignedData | null => {
      const cached = cache.getAlignedHistory(entities, componentMap, windowSeconds);
      if (!cached || cached.time.length === 0) return null;
      const t = transformRef.current;
      const vData = cached.values.map((arr) =>
        arr.map((v) => {
          if (!Number.isFinite(v)) return NaN;
          const out = t(v);
          return out === null || !Number.isFinite(out) ? NaN : out;
        })
      );
      return [cached.time, ...vData];
    };

    const yAxis = new YAxisHysteresis(500);
    const dragZoomActive = enablePlayPause && isPausedRef.current;

    const buildOpts = (w: number, h: number): uPlot.Options => ({
      width: w,
      height: h,
      pxAlign: true,
      scales: {
        x: {
          time: false,
          // Live: scrolling server-timeline window. Paused: honor whatever
          // range was requested (drag-zoom / reset-zoom setScale calls).
          range: (_u, reqMin, reqMax): [number, number] => {
            if (enablePlayPause && isPausedRef.current) return [reqMin, reqMax];
            return xWindowMs(windowSeconds);
          },
        },
        y: yRange
          ? { auto: false, range: (): [number, number] => yRange }
          : { auto: false },
      },
      axes: [
        {
          label: 'T+ (s)',
          stroke: '#9CA3AF',
          grid: { show: true, stroke: '#555', width: 1 },
          ticks: { show: true, stroke: '#777', width: 1 },
          font: 'bold 12px monospace',
          labelFont: '12px system-ui',
          gap: 8,
          space: 120,
          values: tPlusAxisValues,
        },
        {
          label: yLabel,
          stroke: '#9CA3AF',
          grid: { show: true, stroke: '#555', width: 1 },
          ticks: { show: true, stroke: '#777', width: 1 },
          font: 'bold 12px monospace',
          labelFont: '12px system-ui',
          size: 60,
          gap: 5,
          space: 80,
          values: yTicks
            ? (_u: uPlot, _vals: number[]) => yTicks.map((v) => fmtAxisVal(v))
            : (_u: uPlot, vals: number[]) => vals.map((v) => (v == null ? '' : fmtAxisVal(v))),
          ...(yTicks ? { splits: () => yTicks } : {}),
        },
      ],
      series: [
        {},
        ...entities.map((_, i) => ({
          label: seriesLabels[i],
          stroke: colorList[i],
          width: 3,
          points: { show: false },
        })),
      ],
      cursor: {
        show: true,
        x: true,
        y: false,
        drag: dragZoomActive
          ? { x: true, y: false, setScale: true, uni: 10 }
          : { x: false, y: false, setScale: false },
      },
      legend: { show: false },
      padding: [8, 12, 0, 0] as [number, number, number, number],
    });

    const applyYScale = (data: uPlot.AlignedData, force = false): void => {
      const u = uplotRef.current;
      if (!u) return;
      if (yRange) {
        u.setScale('y', { min: yRange[0], max: yRange[1] });
        return;
      }
      const seriesValues = data.slice(1) as number[][];
      if (force) {
        let mn = Infinity, mx = -Infinity;
        for (const s of seriesValues) for (const v of s) if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
        if (isFinite(mn) && isFinite(mx)) {
          const [min, max] = smartYRange(mn, mx);
          u.setScale('y', { min, max });
        }
        return;
      }
      const range = yAxis.update(seriesValues, serverNowMs());
      if (range) u.setScale('y', { min: range[0], max: range[1] });
    };

    const tryInit = () => {
      if (uplotRef.current || !plotRef.current) return;
      const dims = getDims();
      if (!dims) return;

      const data = readData() ?? [[serverNowMs()], ...entities.map(() => [NaN])] as uPlot.AlignedData;

      try {
        if (!plotRef.current) return;
        uplotRef.current = new uPlot(buildOpts(dims.w, dims.h), data, plotRef.current);
        applyYScale(data, true);
        setReady(true);
      } catch (err) {
        console.error('[DerivedTimeSeriesPlot] init failed:', err);
      }
    };

    const renderLoop = () => {
      if (!uplotRef.current) { tryInit(); if (!uplotRef.current) return; }

      // Paused: freeze data and scales entirely — drag-zoom owns the x-scale.
      if (enablePlayPause && isPausedRef.current) return;

      const [xMin, xMax] = xWindowMs(windowSeconds);
      uplotRef.current.setScale('x', { min: xMin, max: xMax });

      const data = readData();
      if (data) {
        try {
          uplotRef.current.setData(data, false);
        } catch (_) {}
        applyYScale(data);
      }

      const dims = getDims();
      if (dims && (Math.abs(dims.w - uplotRef.current.width) > 2 || Math.abs(dims.h - uplotRef.current.height) > 2)) {
        uplotRef.current.setSize({ width: dims.w, height: dims.h });
      }
    };

    requestAnimationFrame(() => {
      tryInit();
      setTimeout(tryInit, 100);
      setTimeout(tryInit, 300);
      setTimeout(tryInit, 600);
    });
    const intervalId = setInterval(renderLoop, RENDER_INTERVAL_MS);

    // Init as soon as a backfill lands (window opened before data existed).
    const unsubHistorical = cache.onHistoricalData(() => {
      if (!uplotRef.current) tryInit();
    });

    const ro = new ResizeObserver(() => {
      const dims = getDims();
      if (dims && uplotRef.current) {
        uplotRef.current.setSize({ width: dims.w, height: dims.h });
      } else if (dims && !uplotRef.current) {
        tryInit();
      }
    });
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      unsubHistorical();
      clearInterval(intervalId);
      ro.disconnect();
      uplotRef.current?.destroy();
      uplotRef.current = null;
      setReady(false);
    };
  }, [entities.join(','), component, windowSeconds, yLabel, colors.join(','), yRange?.join(','), yTicks?.join(','), enablePlayPause]);

  return (
    <div
      className={`w-full flex flex-col min-h-0 min-w-0 ${className}`}
      style={height ? { height: height + 32 } : { flex: '1 1 0%' }}
    >
      {enablePlayPause && showControls && (
        <div className="flex items-center gap-3 mb-2 flex-shrink-0">
          {title && (
            <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">{title}</h3>
          )}
          <div className="flex items-center gap-1 rounded-md border border-gray-700 bg-gray-900 px-2 py-1">
            <button
              type="button"
              onClick={() => setIsPaused(false)}
              className={`rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors ${
                !isPaused ? 'bg-violet-600 text-white' : 'text-gray-400 hover:bg-gray-700 hover:text-gray-200'
              }`}
              title="Resume live updates"
              disabled={!ready}
            >
              Play
            </button>
            <button
              type="button"
              onClick={() => setIsPaused(true)}
              className={`rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors ${
                isPaused ? 'bg-amber-600 text-white' : 'text-gray-400 hover:bg-gray-700 hover:text-gray-200'
              }`}
              title="Pause to zoom"
              disabled={!ready}
            >
              Pause
            </button>
            {isPaused && (
              <button
                type="button"
                onClick={() => zoomToFullRange(uplotRef.current)}
                className="rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-200"
                title="Reset zoom to full range"
              >
                Reset zoom
              </button>
            )}
          </div>
        </div>
      )}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-[200px] min-w-0"
        style={{ position: 'relative', width: '100%', height: '100%', flex: '1 1 0%' }}
      >
        <div ref={plotRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm z-10 pointer-events-none bg-gray-900/50">
            Loading...
          </div>
        )}
      </div>
    </div>
  );
});

export default DerivedTimeSeriesPlot;
