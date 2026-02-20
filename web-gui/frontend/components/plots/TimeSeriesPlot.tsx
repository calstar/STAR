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

  const initializedRef = useRef(false);

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
      if (!el) {
        return null;
      }
      // Use getBoundingClientRect for accurate dimensions
      const rect = el.getBoundingClientRect();
      const w = Math.max(0, Math.floor(rect.width));
      const h = Math.max(0, Math.floor(rect.height));
      
      // Log dimensions for debugging
      if (w < 50 || h < 30) {
        console.log(`[TimeSeriesPlot] ${title}: Container too small: ${w}x${h}`);
        return null;
      }
      
      console.log(`[TimeSeriesPlot] ${title}: Container size: ${w}x${h}`);
      return { w, h };
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
      } else {
        // Initialize with current time so plot shows immediately
        const now = (Date.now() - startTimeRef.current) / 1000;
        dataRef.current.time = [now];
        dataRef.current.values = entities.map(() => [NaN]);
      }
    } catch (err) {
      console.warn('[TimeSeriesPlot] Cache pre-fill failed:', err);
      // Initialize with current time so plot shows immediately
      const now = (Date.now() - startTimeRef.current) / 1000;
      dataRef.current.time = [now];
      dataRef.current.values = entities.map(() => [NaN]);
    }

    const tryInit = () => {
      if (initializedRef.current) {
        console.log(`[TimeSeriesPlot] ${title}: Already initialized, skipping`);
        return;
      }
      if (!plotRef.current) {
        console.log(`[TimeSeriesPlot] ${title}: plotRef.current is null`);
        return;
      }
      const dims = getDims();
      if (!dims) {
        console.log(`[TimeSeriesPlot] ${title}: No valid dimensions yet`);
        return;
      }
      console.log(`[TimeSeriesPlot] ${title}: Attempting initialization with ${dims.w}x${dims.h}`);
      
      // Re-check cache right before init to get latest data
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
        console.warn('[TimeSeriesPlot] Cache re-check failed:', err);
      }
      
      // Always initialize with data - ensure we have at least one time point
      const now = (Date.now() - startTimeRef.current) / 1000;
      let timeData = dataRef.current.time.length > 0 ? dataRef.current.time : [now];
      let valueData = dataRef.current.values.map(v => v.length > 0 ? v : [NaN]);
      
      // If we have no data at all, create a single point so plot renders
      if (timeData.length === 0) {
        timeData = [now];
        valueData = entities.map(() => [NaN]);
      }
      
      // Ensure all series have the same length
      const maxLen = Math.max(timeData.length, ...valueData.map(v => v.length));
      while (timeData.length < maxLen) timeData.push(now);
      valueData = valueData.map(v => {
        while (v.length < maxLen) v.push(NaN);
        return v;
      });
      
      const data: uPlot.AlignedData = [timeData, ...valueData];
      
      try {
        if (!plotRef.current) {
          console.warn(`[TimeSeriesPlot] plotRef.current is null for: ${title}`);
          return;
        }
        plotInstanceRef.current = new uPlot(buildOpts(dims.w, dims.h), data, plotRef.current);
        // Immediately update with cached data if we have history
        if (dataRef.current.time.length > 1) {
          plotInstanceRef.current.setData([dataRef.current.time, ...dataRef.current.values], true);
        }
        initializedRef.current = true;
        console.log(`[TimeSeriesPlot] ✓ Initialized: ${title} (${dims.w}x${dims.h}, ${timeData.length} points)`);
      } catch (err) {
        console.error(`[TimeSeriesPlot] ✗ Initialization failed for ${title}:`, err);
        console.error('[TimeSeriesPlot] Details:', { 
          title, 
          dims, 
          hasPlotRef: !!plotRef.current,
          timeDataLen: timeData.length,
          valueDataLens: valueData.map(v => v.length)
        });
        initializedRef.current = false;
        plotInstanceRef.current = null;
      }
    };

    // ── Aggressive initialization - try immediately and repeatedly ────────
    // Don't wait for ResizeObserver - initialize as soon as container has any size
    const attemptInit = () => {
      if (initializedRef.current) return;
      if (!containerRef.current || !plotRef.current) return;
      const dims = getDims();
      if (!dims) return; // getDims already checks minimum size
      tryInit();
    };
    
    // Try immediately on mount
    attemptInit();
    
    // Try again after delays (React might not have laid out yet)
    const initTimeout1 = setTimeout(attemptInit, 10);
    const initTimeout2 = setTimeout(attemptInit, 50);
    const initTimeout3 = setTimeout(attemptInit, 100);
    const initTimeout4 = setTimeout(attemptInit, 200);
    const initTimeout5 = setTimeout(attemptInit, 500);
    const initTimeout6 = setTimeout(attemptInit, 1000);
    
    // ── ResizeObserver for size changes (after init) ─────────────────────
    const ro = new ResizeObserver((entries) => {
      if (!initializedRef.current) {
        attemptInit(); // Keep trying if not initialized
      } else if (plotInstanceRef.current) {
        const dims = getDims();
        if (dims) {
          try {
            plotInstanceRef.current.setSize({ width: dims.w, height: dims.h });
          } catch (err) {
            console.error('[TimeSeriesPlot] ResizeObserver setSize failed:', err);
          }
        }
      }
    });
    
    // Set up observer once container ref is available
    if (containerRef.current) {
      ro.observe(containerRef.current);
    } else {
      // Fallback: observe when ref becomes available
      const checkRef = setInterval(() => {
        if (containerRef.current) {
          ro.observe(containerRef.current);
          attemptInit();
          clearInterval(checkRef);
        }
      }, 50);
      setTimeout(() => clearInterval(checkRef), 2000); // Give up after 2s
    }

    // Window resize safety net
    const onWinResize = () => {
      if (!plotInstanceRef.current) return;
      const dims = getDims();
      if (dims) plotInstanceRef.current.setSize({ width: dims.w, height: dims.h });
    };
    window.addEventListener('resize', onWinResize);

    // ── WS handler: O(1) — store the latest value per series ─────────────
    // IMPORTANT: Collect data immediately, even before plot is initialized
    // This ensures we have data ready when the plot initializes
    const unsubSensor = ws.on(MessageType.SENSOR_UPDATE, (payload: unknown) => {
      const update = payload as SensorUpdate;
      let idx = entities.indexOf(update.entity);
      if (idx < 0) {
        const canon = resolveEntity(update.entity, update.component);
        if (canon) idx = entities.indexOf(canon);
      }
      if (idx >= 0 && update.component === componentMap[idx]) {
        latestValuesRef.current[idx] = update.value;
        
        // If plot is already initialized, add data point immediately (don't wait for 10Hz loop)
        if (initializedRef.current && plotInstanceRef.current) {
          const now = (Date.now() - startTimeRef.current) / 1000;
          const d = dataRef.current;
          
          // Only add if this is a new time point (avoid duplicates)
          const lastTime = d.time.length > 0 ? d.time[d.time.length - 1] : -Infinity;
          if (now - lastTime >= 0.05) { // At least 50ms between points (20 Hz max)
            d.time.push(now);
            entities.forEach((_, i) => {
              const val = latestValuesRef.current[i];
              d.values[i].push(isFinite(val) ? val : NaN);
            });
            
            // Trim to window
            const cutoff = now - WINDOW_SECONDS;
            let first = 0;
            while (first < d.time.length && d.time[first] < cutoff) first++;
            if (first > 0) {
              d.time = d.time.slice(first);
              d.values = d.values.map(a => a.slice(first));
            }
            if (d.time.length > MAX_POINTS) {
              const excess = d.time.length - MAX_POINTS;
              d.time = d.time.slice(excess);
              d.values = d.values.map(a => a.slice(excess));
            }
            
            // Update plot immediately
            plotInstanceRef.current.setData([d.time, ...d.values], true);
          }
        }
      }
    });

    // ── 10 Hz sample + render + size-sync loop ──────────────────────────
    const sampleInterval = setInterval(() => {
      // Always try to initialize if not done yet
      if (!initializedRef.current) {
        tryInit();
        if (!initializedRef.current) return;
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
      clearTimeout(initTimeout3);
      clearTimeout(initTimeout4);
      clearTimeout(initTimeout5);
      clearTimeout(initTimeout6);
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
      <div className="flex items-center justify-between mb-2 px-1 flex-shrink-0">
        <h3 className="text-base font-bold text-gray-100 truncate">{title}</h3>
        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
          <div className={`w-2.5 h-2.5 rounded-full ${actuallyConnected ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`} />
          <span className="text-xs font-mono text-gray-400 font-semibold">{actuallyConnected ? 'Live' : 'No signal'}</span>
        </div>
      </div>
      {/* Chart container: measured by ResizeObserver. plotRef inside receives uPlot. */}
      <div 
        ref={containerRef} 
        className="relative flex-1 min-h-0 min-w-0 overflow-hidden" 
        style={{ position: 'relative', width: '100%', height: '100%', minHeight: '200px' }}
      >
        <div 
          ref={plotRef} 
          className="absolute inset-0 u-plot-container" 
          style={{ width: '100%', height: '100%' }}
        />
        {!initializedRef.current && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm z-10">
            Initializing plot...
          </div>
        )}
      </div>
    </div>
  );
}

