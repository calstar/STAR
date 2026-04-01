'use client'

import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { getStartupTime } from '@/lib/startup-time';
import { getDataCache } from '@/lib/data-cache';
import { getServerTimeNow } from '@/lib/server-time';

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

// ── Smart Y-range — padding so flat lines are always visible ─────────────────
function smartYRange(dataMin: number, dataMax: number): [number, number] {
  if (dataMin === dataMax) {
    const margin = dataMin === 0 ? 1 : Math.abs(dataMin) * 0.05;
    return [dataMin - margin, dataMax + margin];
  }
  const span = dataMax - dataMin;
  const pad = Math.max(span * 0.12, Math.abs(dataMax) * 0.001);
  return [dataMin - pad, dataMax + pad];
}

// ── Axis formatter ────────────────────────────────────────────────────────────
function fmtAxisVal(val: number): string {
  if (!isFinite(val)) return '';
  const abs = Math.abs(val);
  if (abs >= 1e9) return (val / 1e9).toFixed(1) + 'G';
  if (abs >= 1e6) return (val / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (val / 1e3).toFixed(1) + 'K';
  if (abs >= 100) return val.toFixed(0);
  if (abs >= 1)   return val.toFixed(1);
  return val.toFixed(2);
}

function applyTransform(v: number, transform?: (x: number) => number): number {
  return !isFinite(v) || !transform ? v : transform(v);
}

const DEFAULT_WINDOW_SECONDS = 60;
// Match data-cache ~40 Hz so uPlot gets enough points for smooth pressure traces (was 10 Hz → stair steps).
const RENDER_INTERVAL_MS     = 25;
const Y_AXIS_INTERVAL_MS     = 200;

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
  const startTimeRef   = useRef<number>(getStartupTime());
  const initializedRef = useRef(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [legendFontSize, setLegendFontSize] = useState(14);
  const legendRef = useRef<HTMLDivElement>(null);

  const updateConnectionStatus = useSensorStore((s) => s.updateConnectionStatus);
  const connectionStatus       = useSensorStore((s) => s.connectionStatus);
  const actuallyConnected      = connectionStatus?.connected ?? false;
  const missionStartTime       = useSensorStore((s) => s.missionStartTime);

  // Re-anchor time base when the backend sends missionStartTime.
  useEffect(() => {
    if (missionStartTime !== null && missionStartTime > 0 && missionStartTime !== startTimeRef.current) {
      startTimeRef.current = missionStartTime;
      // No local buffer to clear — render loop reads from DataCache on next tick.
    }
  }, [missionStartTime]); // eslint-disable-line react-hooks/exhaustive-deps

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
    ws.connect();
    const unsubStatus = ws.onConnectionStatus((s) => updateConnectionStatus(s));

    const seriesLabels = entities.map((e, i) => labels?.[i] ?? e.split('.').pop() ?? e);

    // ── uPlot options ─────────────────────────────────────────────────────────
    const buildOpts = (w: number, h: number): uPlot.Options => ({
      width: w, height: h, pxAlign: true,
      scales: {
        x: {
          time: false,
          range: (): [number, number] => {
            const now = (getServerTimeNow() - startTimeRef.current) / 1000;
            return [Math.max(0, now - Math.min(windowSeconds, now + 1)), now];
          },
        },
        y: {
          auto: true,
          range: (u, mn, mx): [number, number] => {
            const all: number[] = [];
            for (let i = 1; i < u.data.length; i++) {
              for (const v of u.data[i] as number[]) if (isFinite(v)) all.push(v);
            }
            if (all.length > 0) return smartYRange(Math.min(...all), Math.max(...all));
            if (isFinite(mn) && isFinite(mx)) return smartYRange(mn, mx);
            return [0, 100];
          },
        },
      },
      axes: [
        {
          label: 'T+ (s)', stroke: '#9CA3AF',
          grid: { show: true, stroke: '#555', width: 1 },
          ticks: { show: true, stroke: '#777', width: 1 },
          font: 'bold 12px monospace', labelFont: '12px system-ui', gap: 8, space: 120,
          values: (_u, vals) => vals.map(v => v == null ? '' : Math.round(v).toString()),
        },
        {
          label: yLabel, stroke: '#9CA3AF',
          grid: { show: true, stroke: '#555', width: 1 },
          ticks: { show: true, stroke: '#777', width: 1 },
          font: 'bold 12px monospace', labelFont: '12px system-ui', size: 60, gap: 5, space: 80,
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

      const now     = (getServerTimeNow() - startTimeRef.current) / 1000;
      const cached  = cache.getAlignedHistory(entities, componentMap, windowSeconds);
      const tData   = cached?.time.length   ? cached.time   : [now];
      const vData   = cached?.values.length
        ? cached.values.map((v, i) => v.map(x => applyTransform(x, transforms[i])))
        : entities.map(() => [NaN]);

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
    let lastYAxisUpdate = 0;

    const renderLoop = () => {
      if (!initializedRef.current) { tryInit(); if (!initializedRef.current) return; }
      if (!plotInstanceRef.current) return;

      const now     = (getServerTimeNow() - startTimeRef.current) / 1000;
      const nowMs   = getServerTimeNow();

      // Scroll x-axis every tick.
      plotInstanceRef.current.setScale('x', {
        min: Math.max(0, now - windowSeconds),
        max: now,
      });

      if (nowMs - lastDataUpdate >= RENDER_INTERVAL_MS) {
        const cached = cache.getAlignedHistory(entities, componentMap, windowSeconds);
        if (cached && cached.time.length > 0) {
          const tData = cached.time;
          const vData = cached.values.map((v, i) => v.map(x => applyTransform(x, transforms[i])));
          const resetScales = nowMs - lastYAxisUpdate >= Y_AXIS_INTERVAL_MS;
          if (resetScales) lastYAxisUpdate = nowMs;
          try {
            plotInstanceRef.current.setData([tData, ...vData], resetScales);
          } catch (err) {
            console.error('[TimeSeriesPlot] setData failed:', err);
          }
        }
        lastDataUpdate = nowMs;
      }

      // Size sync
      const dims = getDims();
      if (dims && plotInstanceRef.current &&
        (Math.abs(dims.w - plotInstanceRef.current.width) > 2 ||
         Math.abs(dims.h - plotInstanceRef.current.height) > 2)) {
        plotInstanceRef.current.setSize({ width: dims.w, height: dims.h });
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

  // Scale legend text to fill one row
  useEffect(() => {
    const el = legendRef.current;
    if (!el) return;
    const fit = () => {
      requestAnimationFrame(() => {
        if (!el) return;
        const client = el.clientWidth, scroll = el.scrollWidth;
        if (client <= 0) return;
        setLegendFontSize(prev => {
          const ratio = client / scroll;
          if (Math.abs(ratio - 1) < 0.02) return prev;
          return Math.min(24, Math.max(8, prev * ratio));
        });
      });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [entities, labels, legendFontSize]);

  return (
    <div
      className={`w-full h-full flex flex-col min-h-0 min-w-0 ${height ? '' : 'flex-1'} ${className ?? ''}`}
      style={height ? { height: height + 32 } : { height: '100%', width: '100%' }}
    >
      <div className="flex items-center justify-end mb-1 px-1 flex-shrink-0">
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <div className={`w-2 h-2 rounded-full ${actuallyConnected ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`} />
          <span className="text-[10px] font-mono text-gray-500">{actuallyConnected ? 'Live' : 'No signal'}</span>
        </div>
      </div>
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 min-w-0"
        style={{ position: 'relative', width: '100%', height: '100%', flex: '1 1 0%' }}
      >
        <div ref={plotRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} />
        {!isInitialized && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm z-10 pointer-events-none bg-gray-900/50">
            Initializing plot...
          </div>
        )}
      </div>
      <div
        ref={legendRef}
        className="flex flex-nowrap gap-x-3 gap-y-0 px-1.5 py-1.5 flex-shrink-0 overflow-hidden min-h-0"
      >
        {entities.map((e, i) => (
          <div
            key={e}
            className="flex items-center gap-2 bg-black/20 px-2 py-0.5 rounded-md border border-white/5 flex-shrink-0"
          >
            <span
              className="w-3 h-[2px] rounded-full inline-block flex-shrink-0"
              style={{ background: colors[i] || '#3498DB', boxShadow: `0 0 6px ${(colors[i] || '#3498DB')}80` }}
            />
            <span className="font-semibold font-mono text-gray-300 whitespace-nowrap" style={{ fontSize: `${legendFontSize}px` }}>
              {labels?.[i] ?? e.split('.').pop() ?? e}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
