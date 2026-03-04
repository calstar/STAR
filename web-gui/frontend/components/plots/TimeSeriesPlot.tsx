'use client'

import { useEffect, useRef, useState } from 'react';
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
  windowSeconds?: number; // Configurable time window for history
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

// For high-pressure PTs, only accept updates from the canonical or HP_PT alias,
// not from PT_CHx (standard board channel), so we don't mix two boards into one series.
const HP_PLOT_ENTITY_SOURCES: Record<string, string[]> = {
  'PT_Cal.GN2_High': ['PT_Cal.GN2_High', 'PT_Cal.HP_PT_4'],
  'PT_Cal.GSE_High': ['PT_Cal.GSE_High', 'PT_Cal.HP_PT_3'],
  'PT_Cal.GSE_Mid': ['PT_Cal.GSE_Mid', 'PT_Cal.HP_PT_1'],
};

function shouldAcceptUpdateForSeries(plotEntity: string, updateEntity: string): boolean {
  const allowed = HP_PLOT_ENTITY_SOURCES[plotEntity];
  if (allowed) return allowed.includes(updateEntity);
  return true; // non-HP series: accept any alias
}

// ── Smart Y-range — padding so flat lines are always visible ─────────────────
function smartYRange(dataMin: number, dataMax: number): [number, number] {
  // This function should only be called with valid finite values
  if (dataMin === dataMax) {
    const margin = dataMin === 0 ? 1 : Math.abs(dataMin) * 0.05;
    return [dataMin - margin, dataMax + margin];
  }
  const span = dataMax - dataMin;
  const pad = Math.max(span * 0.12, Math.abs(dataMax) * 0.001);
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
  if (abs >= 1) return val.toFixed(1);
  return val.toFixed(2);
}

// ── Memory constants ──────────────────────────────────────────────────────────
const DEFAULT_WINDOW_SECONDS = 60;   // 60 s rolling window (can be overridden via prop)
const SAMPLE_HZ = 30;   // matches backend broadcast rate (~33 ms per entity)

export default function TimeSeriesPlot({
  title, entities, component, components, colors,
  yLabel = 'Value', labels, height, className,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
}: TimeSeriesPlotProps) {
  const componentMap = components ?? entities.map(() => component);
  const MAX_POINTS = windowSeconds * SAMPLE_HZ;

  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const plotInstanceRef = useRef<uPlot | null>(null);
  // ── Use global T+0 so all windows share the same time axis ─────
  const startTimeRef = useRef<number>(getStartupTime());
  const latestValuesRef = useRef<number[]>(entities.map(() => NaN));
  const receivedUpdateThisIntervalRef = useRef<boolean[]>(entities.map(() => false));

  const dataRef = useRef<{ time: number[]; values: number[][] }>({
    time: [],
    values: entities.map(() => []),
  });

  // Ref to the latest loadCacheData function, so the missionStartTime effect can reload.
  const loadCacheDataRef = useRef<(() => void) | null>(null);
  const initializedRef = useRef(false);
  const [isInitialized, setIsInitialized] = useState(false);

  const updateConnectionStatus = useSensorStore((s) => s.updateConnectionStatus);
  const connectionStatus = useSensorStore((s) => s.connectionStatus);
  const actuallyConnected = connectionStatus?.connected ?? false;
  const missionStartTime = useSensorStore((s) => s.missionStartTime);

  // Keep startTimeRef in sync with the backend's mission start time.
  // startTimeRef is initialized at mount using whatever getStartupTime() returns at that moment,
  // but missionStartTime may arrive slightly later. Once it does, re-anchor so the plot time
  // axis matches the data-cache time axis and eliminates non-monotonic time arrays.
  useEffect(() => {
    if (missionStartTime !== null && missionStartTime > 0 && missionStartTime !== startTimeRef.current) {
      startTimeRef.current = missionStartTime;
      // Clear the data buffer — it was built on the old time reference.
      dataRef.current = { time: [], values: entities.map(() => []) };
      // Reload from the cache now that the time reference is correct.
      loadCacheDataRef.current?.();
    }
  }, [missionStartTime]); // eslint-disable-line react-hooks/exhaustive-deps

  const entitiesKey = entities.join(',');
  const colorsKey = colors.join(',');
  const windowKey = windowSeconds; // Include windowSeconds in dependency tracking

  useEffect(() => {
    // Reset initialization state when dependencies change (including windowSeconds)
    initializedRef.current = false;
    setIsInitialized(false);

    // Safety check: if entities structure changed, reset internal buffers to match
    // so that uPlot receives exactly the right number of series data arrays
    if (dataRef.current.values.length !== entities.length) {
      dataRef.current.time = [];
      dataRef.current.values = entities.map(() => []);
      latestValuesRef.current = entities.map(() => NaN);
      receivedUpdateThisIntervalRef.current = entities.map(() => false);
    }

    if (plotInstanceRef.current) {
      plotInstanceRef.current.destroy();
      plotInstanceRef.current = null;
    }

    const ws = getWebSocketClient();
    ws.connect();

    const unsubStatus = ws.onConnectionStatus((s) => updateConnectionStatus(s));
    const seriesLabels = entities.map(
      (e, i) => labels?.[i] ?? e.split('.').pop() ?? e
    );

    // ── Build uPlot options ───────────────────────────────────────────────
    const buildOpts = (w: number, h: number): uPlot.Options => ({
      width: w,
      height: h,
      pxAlign: true,
      scales: {
        x: {
          time: false,
          range: (): [number, number] => {
            const now = (Date.now() - startTimeRef.current) / 1000;
            const window = Math.min(windowSeconds, now + 1);
            return [Math.max(0, now - window), now];
          },
        },
        y: {
          auto: true,
          range: (u, mn, mx): [number, number] => {
            // Calculate min/max from actual sensor data (ignore uPlot's mn/mx which might be NaN)
            // Get all data from all series
            const allValues: number[] = [];
            for (let i = 1; i < u.data.length; i++) {
              const series = u.data[i] as number[];
              if (series) {
                for (const val of series) {
                  if (isFinite(val)) {
                    allValues.push(val);
                  }
                }
              }
            }

            // If we have valid data, use it; otherwise use uPlot's calculated values
            if (allValues.length > 0) {
              const dataMin = Math.min(...allValues);
              const dataMax = Math.max(...allValues);
              return smartYRange(dataMin, dataMax);
            }

            // Fallback: use uPlot's calculated values if they're valid
            if (isFinite(mn) && isFinite(mx)) {
              return smartYRange(mn, mx);
            }

            // No valid data yet - return a reasonable default that won't clamp
            // This will be updated as soon as data arrives
            return [0, 100];
          },
        },
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
          values: (_u, vals) => vals.map((v) => (v == null ? '' : Math.round(v).toString())),
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
          values: (_u, vals) => vals.map((v) => (v == null ? '' : fmtAxisVal(v))),
        },
      ],
      series: [
        {},
        ...entities.map((_, idx) => ({
          label: seriesLabels[idx],
          stroke: colors[idx] || '#3498DB',
          width: 3,
          points: { show: false },
        })),
      ],
      cursor: { show: true, x: true, y: false },
      legend: {
        show: false,
      },
      padding: [8, 12, 0, 0] as [number, number, number, number],
    });

    // ── Dimension helper — measure the CONTAINER (stable CSS size) ────────
    const getDims = (): { w: number; h: number } | null => {
      const el = containerRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const w = Math.max(0, Math.floor(rect.width));
      const h = Math.max(0, Math.floor(rect.height));
      if (w < 100 || h < 100) return null;
      return { w, h };
    };

    // ── Pre-fill from background cache so plot has history on open ────
    const cache = getDataCache();
    const loadCacheData = () => {
      try {
        const cached = cache.getAlignedHistory(entities, componentMap, windowSeconds);
        if (cached && cached.time.length > 0 && cached.values.length > 0) {
          console.log(`[TimeSeriesPlot] Loading ${cached.time.length} cached points for ${entities.join(', ')}`);
          dataRef.current.time = [...cached.time];
          dataRef.current.values = cached.values.map(v => [...v]);
          cached.values.forEach((vals, i) => {
            if (vals && vals.length > 0) {
              // Find last valid value
              for (let j = vals.length - 1; j >= 0; j--) {
                if (isFinite(vals[j])) {
                  latestValuesRef.current[i] = vals[j];
                  break;
                }
              }
            }
          });
          return true;
        } else {
          console.log(`[TimeSeriesPlot] No cached data found for ${entities.join(', ')}`);
        }
      } catch (err) {
        console.warn('[TimeSeriesPlot] Cache load failed:', err);
      }
      return false;
    };

    // Expose loadCacheData so the missionStartTime effect can reload after a time-base reset.
    loadCacheDataRef.current = loadCacheData;

    // When HISTORICAL_DATA arrives from backend, reload if our buffer is still empty or stale.
    // This handles the race where missionStartTime effect fires before HISTORICAL_DATA fills cache.
    const unsubscribeHistorical = cache.onHistoricalData(() => {
      if (dataRef.current.time.length === 0) {
        loadCacheData();
      }
    });

    // Try loading cache data immediately
    const hasCache = loadCacheData();
    if (hasCache) {
      console.log(`[TimeSeriesPlot] Pre-loaded ${dataRef.current.time.length} points from cache`);
    }

    const tryInit = () => {
      if (initializedRef.current || !plotRef.current) return;
      const dims = getDims();
      if (!dims) return;

      // Re-check cache right before init to get latest data
      loadCacheData();

      const now = (Date.now() - startTimeRef.current) / 1000;

      // Use cached data if available, otherwise create empty arrays
      let timeData = dataRef.current.time.length > 0 ? dataRef.current.time : [now];
      let valueData = dataRef.current.values.map(v => v.length > 0 ? v : [NaN]);

      // Ensure all arrays are aligned
      const maxLen = Math.max(timeData.length, ...valueData.map(v => v.length));
      if (maxLen === 0) {
        timeData = [now];
        valueData = entities.map(() => [NaN]);
      } else {
        // Pad time array if needed
        while (timeData.length < maxLen) {
          timeData.push(timeData.length > 0 ? timeData[timeData.length - 1] + 0.1 : now);
        }
        // Pad value arrays if needed
        valueData = valueData.map(v => {
          const arr = [...v];
          while (arr.length < maxLen) arr.push(NaN);
          return arr;
        });
      }

      const data: uPlot.AlignedData = [timeData, ...valueData];

      try {
        if (!plotRef.current) return;
        const opts = buildOpts(dims.w, dims.h);
        plotInstanceRef.current = new uPlot(opts, data, plotRef.current);
        initializedRef.current = true;
        setIsInitialized(true);
      } catch (err) {
        console.error(`[TimeSeriesPlot] Init failed:`, err);
        throw err;
      }
    };

    const attemptInit = () => {
      if (initializedRef.current) return;
      if (!containerRef.current || !plotRef.current) return;
      const dims = getDims();
      if (!dims) return;
      tryInit();
    };

    // Wait for next frame to ensure DOM is ready
    requestAnimationFrame(() => {
      attemptInit();
      setTimeout(attemptInit, 100);
      setTimeout(attemptInit, 300);
      setTimeout(attemptInit, 600);
    });

    const ro = new ResizeObserver(() => {
      if (!initializedRef.current) {
        attemptInit();
      } else if (plotInstanceRef.current) {
        const dims = getDims();
        if (dims) plotInstanceRef.current.setSize({ width: dims.w, height: dims.h });
      }
    });
    if (containerRef.current) ro.observe(containerRef.current);

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

      // Add to cache immediately
      if (isFinite(update.value)) {
        cache.addDataPoint(update.entity, update.component, update.value);
      }

      let idx = entities.indexOf(update.entity);
      if (idx < 0) {
        const canon = resolveEntity(update.entity, update.component);
        if (canon) idx = entities.indexOf(canon);
      }
      if (idx >= 0 && update.component === componentMap[idx]) {
        // For HP pressure series, only use updates from the canonical or HP_PT entity,
        // not PT_CHx (avoids 0/5000 spiking when standard board and HP board both send data).
        if (!shouldAcceptUpdateForSeries(entities[idx], update.entity)) return;
        latestValuesRef.current[idx] = update.value;
        receivedUpdateThisIntervalRef.current[idx] = true;
      }
    });

    // ── Smooth rendering loop using requestAnimationFrame (60 FPS) ────────
    // Separate data sampling (10 Hz) from rendering (60 FPS) for smooth scrolling
    let lastDataUpdate = 0;
    let lastYAxisUpdate = 0;
    const DATA_UPDATE_INTERVAL = 1000 / SAMPLE_HZ; // 100ms for data updates
    const Y_AXIS_UPDATE_INTERVAL = 200; // 200ms for Y-axis auto-scaling (5 Hz)

    let animationFrameId: number | null = null;
    const renderLoop = () => {
      if (!initializedRef.current) {
        tryInit();
        if (!initializedRef.current) {
          animationFrameId = requestAnimationFrame(renderLoop);
          return;
        }
      }

      if (!plotInstanceRef.current) {
        animationFrameId = requestAnimationFrame(renderLoop);
        return;
      }

      const now = (Date.now() - startTimeRef.current) / 1000;
      const cutoff = now - windowSeconds;
      const d = dataRef.current;
      const currentTime = Date.now();
      let dataChanged = false;

      // Update data at 10 Hz (only when needed)
      if (currentTime - lastDataUpdate >= DATA_UPDATE_INTERVAL) {
        // Guard: if new 'now' would create a non-monotonic time array (e.g. due to
        // misaligned historical pre-fill), reset the buffer and start fresh.
        if (d.time.length > 0 && now < d.time[d.time.length - 1] - 1) {
          d.time = [];
          d.values = entities.map(() => []);
        }

        d.time.push(now);
        entities.forEach((_, i) => {
          const val = receivedUpdateThisIntervalRef.current[i] ? latestValuesRef.current[i] : NaN;
          d.values[i].push(val);
          receivedUpdateThisIntervalRef.current[i] = false;
        });

        // Trim older than window
        let first = 0;
        while (first < d.time.length && d.time[first] < cutoff) first++;
        if (first > 0) {
          d.time = d.time.slice(first);
          d.values = d.values.map((a) => a.slice(first));
        }
        if (d.time.length > MAX_POINTS) {
          const excess = d.time.length - MAX_POINTS;
          d.time = d.time.slice(excess);
          d.values = d.values.map((a) => a.slice(excess));
        }

        lastDataUpdate = currentTime;
        dataChanged = true;
      }

      // Update x-axis smoothly at 60 FPS (every frame)
      // This ensures continuous scrolling based on server time
      const xMin = Math.max(0, now - windowSeconds);
      const xMax = now;
      plotInstanceRef.current.setScale('x', {
        min: xMin,
        max: xMax,
      });

      // Update plot data every frame for smooth rendering
      const timeData = d.time.length > 0 ? d.time : [now];
      const valueData = d.values.map(v => v.length > 0 ? v : [NaN]);

      try {
        // Reset scales periodically (when data changes or every 200ms) to update Y-axis
        const shouldResetScales = dataChanged || (currentTime - lastYAxisUpdate >= Y_AXIS_UPDATE_INTERVAL);
        if (shouldResetScales) {
          lastYAxisUpdate = currentTime;
        }
        plotInstanceRef.current.setData([timeData, ...valueData], shouldResetScales);
      } catch (err) {
        console.error('[TimeSeriesPlot] setData failed:', err);
      }

      // ── Continuous size sync — catches layout changes ──────────────────
      const dims = getDims();
      if (dims && plotInstanceRef.current &&
        (Math.abs(dims.w - plotInstanceRef.current.width) > 2 ||
          Math.abs(dims.h - plotInstanceRef.current.height) > 2)) {
        plotInstanceRef.current.setSize({ width: dims.w, height: dims.h });
      }

      // Continue animation loop
      animationFrameId = requestAnimationFrame(renderLoop);
    };

    // Start the smooth rendering loop
    animationFrameId = requestAnimationFrame(renderLoop);

    return () => {
      unsubSensor();
      unsubStatus();
      unsubscribeHistorical();
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      plotInstanceRef.current?.destroy();
      plotInstanceRef.current = null;
      initializedRef.current = false;
      setIsInitialized(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entitiesKey, colorsKey, component, yLabel, height, windowKey]);

  return (
    <div
      className={`w-full h-full flex flex-col min-h-0 min-w-0 ${height ? '' : 'flex-1'} ${className ?? ''}`}
      style={height ? { height: height + 32 } : { height: '100%', width: '100%' }}
    >
      {/* Connection indicator */}
      <div className="flex items-center justify-end mb-1 px-1 flex-shrink-0">
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <div className={`w-2 h-2 rounded-full ${actuallyConnected ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`} />
          <span className="text-[11px] font-mono text-gray-500">{actuallyConnected ? 'Live' : 'No signal'}</span>
        </div>
      </div>
      {/* Chart container: measured by ResizeObserver. plotRef inside receives uPlot. */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 min-w-0"
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          flex: '1 1 0%'
        }}
      >
        <div
          ref={plotRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%'
          }}
        />
        {!isInitialized && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm z-10 pointer-events-none bg-gray-900/50">
            Initializing plot...
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 px-2 py-2 flex-shrink-0">
        {entities.map((e, i) => (
          <div key={e} className="flex items-center gap-2.5 bg-black/20 px-2.5 py-1 rounded-md border border-white/5">
            <span className="w-3.5 h-[3px] rounded-full inline-block" style={{ background: colors[i] || '#3498DB', boxShadow: `0 0 10px ${colors[i]}A0` }} />
            <span className="text-sm font-semibold font-mono text-gray-300">
              {labels?.[i] ?? e.split('.').pop() ?? e}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
