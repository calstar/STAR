'use client'

import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { getDataCache } from '@/lib/data-cache';
import { serverNowMs } from '@/lib/plot-time';
import { xWindowMs, tPlusAxisValues, fmtAxisVal, YAxisHysteresis } from '@/lib/plot-shared';
import { AXIS_FONT, AXIS_GRID, AXIS_STROKE, AXIS_TICKS } from '@/lib/plot-theme';

interface TimeSeriesPlotProps {
  title: string;
  entities: string[];
  component: string;
  components?: string[];
  colors: string[];
  yLabel?: string;
  labels?: string[];
  height?: number;
  className?: string;
  windowSeconds?: number;
  /** Optional per-series value transform (e.g. lbf → N). */
  valueTransforms?: ((v: number) => number)[];
}

/** Per-point value for uPlot: a real number, or null meaning "no sample here".
 *
 *  null, never NaN. uPlot's gap detection tests `yVal === null`; NaN passes that check
 *  and reaches `lineTo(NaN, NaN)`, which the canvas spec makes a no-op — so a NaN run is
 *  drawn as one straight interpolated segment across the hole, the opposite of a gap.
 *  (The old whole-series NaN fill only looked right because EVERY point was a no-op, so
 *  nothing was drawn at all — which is what erased real history.) */
function applyTransform(v: number, transform?: (x: number) => number): number | null {
  if (!Number.isFinite(v)) return null;
  return transform ? transform(v) : v;
}

const DEFAULT_WINDOW_SECONDS = 60;
// Data/scroll refresh. Backend delivers ≤ ~20 pts/s per stream; 25 ms keeps the
// x-scroll smooth without wasting CPU.
const RENDER_INTERVAL_MS     = 25;
// Y-axis scale is only allowed to recompute this often. Higher = less shaking under noisy data.
const Y_AXIS_INTERVAL_MS     = 1500;

export default function TimeSeriesPlot({
  title, entities, component, components, colors,
  yLabel = 'Value', labels, height, className,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
  valueTransforms,
}: TimeSeriesPlotProps) {
  const componentMap = components ?? entities.map(() => component);
  const transforms   = valueTransforms ?? entities.map(() => undefined);

  const containerRef   = useRef<HTMLDivElement>(null);
  const plotRef        = useRef<HTMLDivElement>(null);
  const plotInstanceRef = useRef<uPlot | null>(null);
  const initializedRef = useRef(false);
  const [isInitialized, setIsInitialized] = useState(false);

  const updateConnectionStatus = useSensorStore((s) => s.updateConnectionStatus);
  const connectionStatus       = useSensorStore((s) => s.connectionStatus);
  const actuallyConnected      = connectionStatus?.connected ?? false;

  const entitiesKey = entities.join(',');
  const colorsKey   = colors.join(',');

  // NOTE: `height` intentionally NOT in dep array — ResizeObserver handles size changes.
  useEffect(() => {
    initializedRef.current = false;
    setIsInitialized(false);
    if (plotInstanceRef.current) {
      plotInstanceRef.current.destroy();
      plotInstanceRef.current = null;
    }

    const ws  = getWebSocketClient();
    const unsubStatus = ws.onConnectionStatus((s) => updateConnectionStatus(s));

    const seriesLabels = entities.map((e, i) => labels?.[i] ?? e.split('.').pop() ?? e);

    // ── uPlot options ─────────────────────────────────────────────────────────
    // X data/scales are epoch ms on the server timeline (see plot-time.ts);
    // the axis DISPLAYS T+ seconds via tPlusAxisValues — a missionStartTime
    // change relabels the axis without touching data.
    // Y: auto:false — we drive it explicitly with hysteresis (see plot-shared).
    const yAxis = new YAxisHysteresis(Y_AXIS_INTERVAL_MS);

    const buildOpts = (w: number, h: number): uPlot.Options => ({
      width: w, height: h, pxAlign: true,
      scales: {
        x: {
          time: false,
          range: (): [number, number] => xWindowMs(windowSeconds),
        },
        y: {
          // auto: false — prevents uPlot from recalculating Y on every setScale('x') call
          // (which fires 40×/sec and causes visible axis jumping).
          auto: false,
        },
      },
      axes: [
        {
          label: 'T+ (s)', stroke: AXIS_STROKE,
          grid: { ...AXIS_GRID },
          ticks: { ...AXIS_TICKS },
          font: AXIS_FONT, labelFont: '12px system-ui', gap: 8, space: 120,
          values: tPlusAxisValues,
        },
        {
          label: yLabel, stroke: AXIS_STROKE,
          grid: { ...AXIS_GRID },
          ticks: { ...AXIS_TICKS },
          font: AXIS_FONT, labelFont: '12px system-ui', size: 60, gap: 5, space: 80,
          values: (_u, vals) => vals.map(v => v == null ? '' : fmtAxisVal(v)),
        },
      ],
      series: [
        {},
        ...entities.map((_, idx) => ({
          label: seriesLabels[idx], stroke: colors[idx] || '#3498DB', width: 3, points: { show: false },
        })),
      ],
      cursor: { show: true, x: true, y: false },
      legend: { show: false },
      padding: [8, 12, 0, 0] as [number, number, number, number],
    });

    const getDims = (): { w: number; h: number } | null => {
      const el = containerRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const w = Math.floor(r.width), h = Math.floor(r.height);
      return w >= 100 && h >= 100 ? { w, h } : null;
    };

    const cache = getDataCache();

    const tryInit = () => {
      if (initializedRef.current || !plotRef.current) return;
      const dims = getDims();
      if (!dims) return;

      const cached  = cache.getAlignedHistory(entities, componentMap, windowSeconds);
      const tData   = cached?.time.length   ? cached.time   : [serverNowMs()];
      const vData   = cached?.values.length
        ? cached.values.map((v, i) => v.map(x => applyTransform(x, transforms[i])))
        : entities.map(() => [null]);

      try {
        const opts = buildOpts(dims.w, dims.h);
        plotInstanceRef.current = new uPlot(opts, [tData, ...vData], plotRef.current);
        initializedRef.current = true;
        setIsInitialized(true);
      } catch (err) {
        console.error('[TimeSeriesPlot] Init failed:', err);
      }
    };

    requestAnimationFrame(() => {
      tryInit();
      setTimeout(tryInit, 100);
      setTimeout(tryInit, 300);
      setTimeout(tryInit, 600);
    });

    // Reload when historical data arrives and we're not yet initialized.
    const unsubHistorical = cache.onHistoricalData(() => {
      if (!initializedRef.current) tryInit();
    });

    const ro = new ResizeObserver(() => {
      if (!initializedRef.current) { tryInit(); }
      else if (plotInstanceRef.current) {
        const dims = getDims();
        if (dims) plotInstanceRef.current.setSize({ width: dims.w, height: dims.h });
      }
    });
    if (containerRef.current) ro.observe(containerRef.current);

    const onWinResize = () => {
      if (!plotInstanceRef.current) return;
      const dims = getDims();
      if (dims) plotInstanceRef.current.setSize({ width: dims.w, height: dims.h });
    };
    window.addEventListener('resize', onWinResize);

    // ── Render loop — reads DataCache (see RENDER_INTERVAL_MS) ─────────────────
    let lastDataUpdate  = 0;

    const renderLoop = () => {
      if (!initializedRef.current) { tryInit(); if (!initializedRef.current) return; }
      if (!plotInstanceRef.current) return;

      const [xMin, xMax] = xWindowMs(windowSeconds);
      const nowMs = xMax;

      // Scroll x-axis every tick.
      plotInstanceRef.current.setScale('x', { min: xMin, max: xMax });

      if (nowMs - lastDataUpdate >= RENDER_INTERVAL_MS) {
        const cached = cache.getAlignedHistory(entities, componentMap, windowSeconds);
        if (cached && cached.time.length > 0) {
          const tData = cached.time;
          const vData = cached.values.map((v, i) => v.map(x => applyTransform(x, transforms[i])));
          try {
            // Always pass false — Y auto-scaling is handled explicitly below.
            plotInstanceRef.current.setData([tData, ...vData], false);
          } catch (err) {
            console.error('[TimeSeriesPlot] setData failed:', err);
          }

          // Explicit Y-axis update with hysteresis, rate-limited (plot-shared).
          const yRange = yAxis.update(vData, nowMs);
          if (yRange) {
            plotInstanceRef.current.setScale('y', { min: yRange[0], max: yRange[1] });
          }
        }
        lastDataUpdate = nowMs;
      }
    };

    const intervalId = setInterval(renderLoop, RENDER_INTERVAL_MS);
    renderLoop();

    return () => {
      unsubStatus();
      unsubHistorical();
      clearInterval(intervalId);
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      plotInstanceRef.current?.destroy();
      plotInstanceRef.current = null;
      initializedRef.current = false;
      setIsInitialized(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entitiesKey, colorsKey, component, yLabel, windowSeconds]); // height intentionally omitted

  return (
    <div
      className={`w-full h-full flex flex-col min-h-0 min-w-0 ${height ? '' : 'flex-1'} ${className ?? ''}`}
      style={height ? { height: height + 32 } : { height: '100%', width: '100%' }}
    >
      <div className="flex items-center justify-end mb-1 px-1 flex-shrink-0">
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <div className={`h-1.5 w-1.5 rounded-full ${actuallyConnected ? 'bg-green-400' : 'bg-red-500'}`} />
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">{actuallyConnected ? 'Live' : 'No signal'}</span>
        </div>
      </div>
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 min-w-0"
        style={{ position: 'relative', width: '100%', height: '100%', flex: '1 1 0%' }}
      >
        <div ref={plotRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} />
        {!isInitialized && (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-[12px] text-ink-3 z-10 pointer-events-none">
            Initializing plot...
          </div>
        )}
      </div>
      {/* Wraps onto more lines rather than shrinking to fit one: the old fit-to-one-row
          scaling bottomed out at 8 px on a narrow screen and clipped whatever was left. */}
      <div className="flex flex-shrink-0 flex-wrap gap-x-3 gap-y-1 px-1.5 py-1.5">
        {entities.map((e, i) => (
          <div
            key={e}
            className="flex items-center gap-2 flex-shrink-0"
          >
            <span
              className="w-3 h-[2px] inline-block flex-shrink-0"
              style={{ background: colors[i] || '#3498DB' }}
            />
            <span className="whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.06em] text-ink-2 xl:text-[12px]">
              {labels?.[i] ?? e.split('.').pop() ?? e}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
