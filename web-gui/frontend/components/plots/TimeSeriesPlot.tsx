'use client'

import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useSensorStore, ALIASES } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';
import { getStartupTime } from '@/lib/startup-time';
import { getDataCache } from '@/lib/data-cache';

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
}

// ── Alias reverse lookup ──────────────────────────────────────────────────────
function buildReverseAliases(): Record<string, string> {
  const rev: Record<string, string> = {};
  for (const [canonical, fallbacks] of Object.entries(ALIASES)) {
    const canonicalEntity = canonical.split('.').slice(0, -1).join('.');
    for (const fb of fallbacks) rev[fb] = canonicalEntity;
  }
  return rev;
}
const REVERSE_ALIASES = buildReverseAliases();

function resolveEntity(incomingEntity: string, incomingComponent: string): string | null {
  return REVERSE_ALIASES[`${incomingEntity}.${incomingComponent}`] ?? null;
}

// ── Smart Y-range — padding so flat lines are always visible ─────────────────
function smartYRange(dataMin: number, dataMax: number): [number, number] {
  if (!isFinite(dataMin) || !isFinite(dataMax)) return [0, 1];
  if (dataMin === dataMax) {
    const margin = dataMin === 0 ? 1 : Math.abs(dataMin) * 0.05;
    return [dataMin - margin, dataMax + margin];
  }
  const span = dataMax - dataMin;
  const pad  = Math.max(span * 0.12, Math.abs(dataMax) * 0.001);
  return [dataMin - pad, dataMax + pad];
}

// ── Axis formatter: K / M / G suffixes ───────────────────────────────────────
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

// ── Memory constants ──────────────────────────────────────────────────────────
const WINDOW_SECONDS = 60;   // 60 s rolling window
const SAMPLE_HZ      = 10;   // matches backend broadcast rate (100 ms per entity)
const MAX_POINTS     = WINDOW_SECONDS * SAMPLE_HZ;  // 600

export default function TimeSeriesPlot({
  title, entities, component, components, colors,
  yLabel = 'Value', labels, height, className,
}: TimeSeriesPlotProps) {
  const componentMap = components ?? entities.map(() => component);

  const containerRef    = useRef<HTMLDivElement>(null);
  const plotRef         = useRef<HTMLDivElement>(null);
  const plotInstanceRef = useRef<uPlot | null>(null);
  // ── Use global T+0 so all windows share the same time axis ─────
  const startTimeRef    = useRef<number>(getStartupTime());
  const latestValuesRef = useRef<number[]>(entities.map(() => NaN));

  const dataRef = useRef<{ time: number[]; values: number[][] }>({
    time:   [],
    values: entities.map(() => []),
  });

  const updateConnectionStatus = useSensorStore((s) => s.updateConnectionStatus);
  const connectionStatus       = useSensorStore((s) => s.connectionStatus);
  const actuallyConnected      = connectionStatus?.connected ?? false;

  const entitiesKey = entities.join(',');
  const colorsKey   = colors.join(',');

  useEffect(() => {
    const ws = getWebSocketClient();
    ws.connect();

    const unsubStatus = ws.onConnectionStatus((s) => updateConnectionStatus(s));
    const seriesLabels = entities.map(
      (e, i) => labels?.[i] ?? e.split('.').pop() ?? e
    );

    // ── Build uPlot options ───────────────────────────────────────────────
    const buildOpts = (w: number, h: number): uPlot.Options => ({
      width:   w,
      height:  h,
      pxAlign: true,
      scales: {
        x: {
          time: false,
          range: (): [number, number] => {
            const now = (Date.now() - startTimeRef.current) / 1000;
            const window = Math.min(WINDOW_SECONDS, now + 1);
            return [Math.max(0, now - window), now];
          },
        },
        y: {
          auto: true,
          range: (_u, mn, mx): [number, number] => smartYRange(mn, mx),
        },
      },
      axes: [
        {
          label:     'T+ (s)',
          stroke:    '#9CA3AF',
          grid:      { show: true, stroke: '#555', width: 1 },
          ticks:     { show: true, stroke: '#777', width: 1 },
          font:      'bold 12px monospace',
          labelFont: '12px system-ui',
          gap:       4,
        },
        {
          label:     yLabel,
          stroke:    '#9CA3AF',
          grid:      { show: true, stroke: '#555', width: 1 },
          ticks:     { show: true, stroke: '#777', width: 1 },
          font:      'bold 12px monospace',
          labelFont: '12px system-ui',
          size:      72,
          gap:       5,
          values:    (_u, vals) => vals.map((v) => (v == null ? '' : fmtAxisVal(v))),
        },
      ],
      series: [
        {},
        ...entities.map((_, idx) => ({
          label:  seriesLabels[idx],
          stroke: colors[idx] || '#3498DB',
          width:  3,
          points: { show: false },
        })),
      ],
      cursor: { show: true, x: true, y: false },
      legend: {
        show:    true,
        live:    true,
        markers: { width: 16 },
      },
      padding: [8, 12, 0, 0] as [number, number, number, number],
    });

    // ── Dimension helper — measure the CONTAINER (stable CSS size) ────────
    const getDims = (): { w: number; h: number } | null => {
      const el = containerRef.current;
      if (!el) return null;
      const w = el.clientWidth;
      const h = el.clientHeight;
      return (w > 60 && h > 40) ? { w, h } : null;
    };

    // ── Pre-fill from background cache so plot has history on open ────
    try {
      const cache = getDataCache();
      const cached = cache.getAlignedHistory(entities, componentMap, WINDOW_SECONDS);
      if (cached && cached.time.length > 0) {
        dataRef.current.time = cached.time;
        dataRef.current.values = cached.values;
        cached.values.forEach((vals, i) => {
          const last = vals[vals.length - 1];
          if (isFinite(last)) latestValuesRef.current[i] = last;
        });
      }
    } catch (err) {
      console.warn('[TimeSeriesPlot] Cache pre-fill failed:', err);
    }

    let initialized = false;

    const tryInit = () => {
      if (initialized || !plotRef.current) return;
      const dims = getDims();
      if (!dims || dims.w < 100 || dims.h < 50) return; // Ensure minimum size
      initialized = true;
      
      // Always initialize with data, even if empty - uPlot handles empty data
      const data: uPlot.AlignedData = [
        dataRef.current.time.length > 0 ? dataRef.current.time : [0],
        ...dataRef.current.values.map(v => v.length > 0 ? v : [NaN])
      ];
      
      try {
        plotInstanceRef.current = new uPlot(buildOpts(dims.w, dims.h), data, plotRef.current);
      } catch (err) {
        console.error('[TimeSeriesPlot] Initialization failed:', err);
        initialized = false;
      }
    };

    // ── ResizeObserver on the outer container ─────────────────────────────
    const ro = new ResizeObserver(() => {
      if (!initialized) {
        tryInit();
      } else if (plotInstanceRef.current) {
        const dims = getDims();
        if (dims) {
          plotInstanceRef.current.setSize({ width: dims.w, height: dims.h });
        }
      }
    });
    
    // Set up observer - use a small delay to ensure refs are set
    const setupObserver = () => {
      if (containerRef.current) {
        ro.observe(containerRef.current);
        // Also try init immediately if container is ready
        tryInit();
      }
    };
    
    // Try immediately
    setupObserver();
    
    // Fallback: try again after short delays in case container wasn't ready
    const initTimeout1 = setTimeout(() => {
      setupObserver();
      if (!initialized) tryInit();
    }, 50);
    
    const initTimeout2 = setTimeout(() => {
      if (!initialized && containerRef.current) {
        tryInit();
      }
    }, 200);

    // Window resize safety net
    const onWinResize = () => {
      if (!plotInstanceRef.current) return;
      const dims = getDims();
      if (dims) plotInstanceRef.current.setSize({ width: dims.w, height: dims.h });
    };
    window.addEventListener('resize', onWinResize);

    // ── WS handler: O(1) — store the latest value per series ─────────────
    const unsubSensor = ws.on(MessageType.SENSOR_UPDATE, (payload: unknown) => {
      const update = payload as SensorUpdate;
      let idx = entities.indexOf(update.entity);
      if (idx < 0) {
        const canon = resolveEntity(update.entity, update.component);
        if (canon) idx = entities.indexOf(canon);
      }
      if (idx >= 0 && update.component === componentMap[idx]) {
        latestValuesRef.current[idx] = update.value;
      }
    });

    // ── 10 Hz sample + render + size-sync loop ──────────────────────────
    const sampleInterval = setInterval(() => {
      // Always try to initialize if not done yet
      if (!initialized) {
        tryInit();
        if (!initialized) return;
      }

      if (!plotInstanceRef.current) return;

      const now    = (Date.now() - startTimeRef.current) / 1000;
      const cutoff = now - WINDOW_SECONDS;
      const d      = dataRef.current;

      // Add new data point
      d.time.push(now);
      entities.forEach((_, i) => {
        const val = latestValuesRef.current[i];
        d.values[i].push(isFinite(val) ? val : NaN);
      });

      // Trim older than window
      let first = 0;
      while (first < d.time.length && d.time[first] < cutoff) first++;
      if (first > 0) {
        d.time   = d.time.slice(first);
        d.values = d.values.map((a) => a.slice(first));
      }
      if (d.time.length > MAX_POINTS) {
        const excess = d.time.length - MAX_POINTS;
        d.time   = d.time.slice(excess);
        d.values = d.values.map((a) => a.slice(excess));
      }

      // Update plot data - ensure we always have at least one time point
      const timeData = d.time.length > 0 ? d.time : [now];
      const valueData = d.values.map(v => v.length > 0 ? v : [NaN]);
      
      try {
        plotInstanceRef.current.setData([timeData, ...valueData], true);
      } catch (err) {
        console.error('[TimeSeriesPlot] setData failed:', err);
      }

      // ── Continuous size sync — catches layout changes ──────────────────
      const dims = getDims();
      if (dims && plotInstanceRef.current &&
          (Math.abs(dims.w - plotInstanceRef.current.width) > 2 ||
           Math.abs(dims.h - plotInstanceRef.current.height) > 2)) {
        try {
          plotInstanceRef.current.setSize({ width: dims.w, height: dims.h });
        } catch (err) {
          console.error('[TimeSeriesPlot] setSize failed:', err);
        }
      }
    }, 1000 / SAMPLE_HZ);

    return () => {
      unsubSensor();
      unsubStatus();
      clearInterval(sampleInterval);
      clearTimeout(initTimeout1);
      clearTimeout(initTimeout2);
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      plotInstanceRef.current?.destroy();
      plotInstanceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entitiesKey, colorsKey, component, yLabel, height]);

  return (
    <div
      className={`w-full flex flex-col min-h-0 min-w-0 ${height ? '' : 'flex-1'} ${className ?? ''}`}
      style={height ? { height: height + 32 } : undefined}
    >
      {/* Title bar */}
      <div className="flex items-center justify-between mb-1 px-1 flex-shrink-0">
        <h3 className="text-sm font-bold text-gray-100 truncate">{title}</h3>
        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
          <div className={`w-2 h-2 rounded-full ${actuallyConnected ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`} />
          <span className="text-[11px] font-mono text-gray-500">{actuallyConnected ? 'Live' : 'No signal'}</span>
        </div>
      </div>
      {/* Chart container: measured by ResizeObserver. plotRef inside receives uPlot. */}
      <div ref={containerRef} className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
        <div ref={plotRef} className="absolute inset-0" />
      </div>
    </div>
  );
}

