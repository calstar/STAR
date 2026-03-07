'use client'

import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { getDataCache } from '@/lib/data-cache';
import { getStartupTime } from '@/lib/startup-time';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';

const DEFAULT_WINDOW_SECONDS = 60;
const SAMPLE_HZ = 60;

export type TransformFn = (rawValue: number) => number | null;

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
}

function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(1) + 'G';
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

function smartYRange(dataMin: number, dataMax: number): [number, number] {
  if (dataMin === dataMax) {
    const margin = dataMin === 0 ? 1 : Math.abs(dataMin) * 0.05;
    return [dataMin - margin, dataMax + margin];
  }
  const span = dataMax - dataMin;
  const pad = Math.max(span * 0.12, Math.abs(dataMax) * 0.001);
  return [dataMin - pad, dataMax + pad];
}

export default function DerivedTimeSeriesPlot({
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
}: DerivedTimeSeriesPlotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const startTimeRef = useRef<number>(getStartupTime());
  const latestValuesRef = useRef<number[]>(entities.map(() => NaN));
  const receivedUpdateThisIntervalRef = useRef<boolean[]>(entities.map(() => false));
  const dataRef = useRef<{ time: number[]; values: number[][] }>({
    time: [],
    values: entities.map(() => []),
  });
  const [ready, setReady] = useState(false);

  const componentMap = entities.map(() => component);
  const MAX_POINTS = windowSeconds * SAMPLE_HZ;

  useEffect(() => {
    if (!containerRef.current || !plotRef.current) return;

    const cache = getDataCache();
    const ws = getWebSocketClient();
    const seriesLabels = entities.map((e, i) => labels?.[i] ?? e.split('.').pop() ?? e);
    const colorList = entities.map((_, i) => colors[i] || '#94a3b8');

    if (dataRef.current.values.length !== entities.length) {
      dataRef.current.time = [];
      dataRef.current.values = entities.map(() => []);
      latestValuesRef.current = entities.map(() => NaN);
    }

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
            const allValues: number[] = [];
            for (let i = 1; i < u.data.length; i++) {
              const series = u.data[i] as number[];
              if (series) {
                for (const val of series) {
                  if (isFinite(val)) allValues.push(val);
                }
              }
            }
            if (allValues.length > 0) {
              const dataMin = Math.min(...allValues);
              const dataMax = Math.max(...allValues);
              return smartYRange(dataMin, dataMax);
            }
            if (isFinite(mn) && isFinite(mx)) return smartYRange(mn, mx);
            return [-400, 100];
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
          values: (_u, vals) => vals.map((v) => (v == null ? '' : fmtVal(v))),
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
      cursor: { show: true, x: true, y: false },
      legend: { show: false },
      padding: [8, 12, 0, 0] as [number, number, number, number],
    });

    const loadCacheData = (): boolean => {
      try {
        const cached = cache.getAlignedHistory(entities, componentMap, windowSeconds);
        if (cached && cached.time.length > 0 && cached.values.length > 0) {
          const t = transformRef.current;
          dataRef.current.time = [...cached.time];
          dataRef.current.values = cached.values.map((arr) =>
            arr.map((v) => {
              const out = t(v);
              return out === null || !Number.isFinite(out) ? NaN : out;
            })
          );
          cached.values.forEach((vals, i) => {
            if (vals && vals.length > 0) {
              for (let j = vals.length - 1; j >= 0; j--) {
                const out = t(vals[j]);
                if (out !== null && Number.isFinite(out)) {
                  latestValuesRef.current[i] = out;
                  break;
                }
              }
            }
          });
          return true;
        }
      } catch (err) {
        console.warn('[DerivedTimeSeriesPlot] Cache load failed:', err);
      }
      return false;
    };

    loadCacheData();

    const tryInit = () => {
      if (uplotRef.current || !plotRef.current) return;
      const dims = getDims();
      if (!dims) return;

      loadCacheData();

      const now = (Date.now() - startTimeRef.current) / 1000;
      let timeData = dataRef.current.time.length > 0 ? dataRef.current.time : [now];
      let valueData = dataRef.current.values.map((v) => (v.length > 0 ? v : [NaN]));

      const maxLen = Math.max(timeData.length, ...valueData.map((v) => v.length));
      if (maxLen === 0) {
        timeData = [now];
        valueData = entities.map(() => [NaN]);
      } else {
        while (timeData.length < maxLen) {
          timeData.push(timeData.length > 0 ? timeData[timeData.length - 1] + 0.1 : now);
        }
        valueData = valueData.map((v) => {
          const arr = [...v];
          while (arr.length < maxLen) arr.push(NaN);
          return arr;
        });
      }

      const data: uPlot.AlignedData = [timeData, ...valueData];

      try {
        if (!plotRef.current) return;
        uplotRef.current = new uPlot(buildOpts(dims.w, dims.h), data, plotRef.current);
        setReady(true);
      } catch (err) {
        console.error('[DerivedTimeSeriesPlot] init failed:', err);
      }
    };

    const unsubSensor = ws.on(MessageType.SENSOR_UPDATE, (payload: unknown) => {
      const update = payload as SensorUpdate;
      if (!isFinite(update.value)) return;

      const idx = entities.indexOf(update.entity);
      if (idx >= 0 && componentMap[idx] === update.component) {
        const out = transformRef.current(update.value);
        latestValuesRef.current[idx] = out !== null && Number.isFinite(out) ? out : NaN;
        receivedUpdateThisIntervalRef.current[idx] = true;
      }
    });

    let lastDataUpdate = 0;
    const DATA_UPDATE_INTERVAL = 1000 / SAMPLE_HZ;

    let animationFrameId: number | null = null;
    const renderLoop = () => {
      if (!uplotRef.current) {
        animationFrameId = requestAnimationFrame(renderLoop);
        return;
      }

      const now = (Date.now() - startTimeRef.current) / 1000;
      const cutoff = now - windowSeconds;
      const d = dataRef.current;
      const currentTime = Date.now();

      let dataChanged = false;
      if (currentTime - lastDataUpdate >= DATA_UPDATE_INTERVAL) {
        d.time.push(now);
        entities.forEach((_, i) => {
          const val = receivedUpdateThisIntervalRef.current[i] ? latestValuesRef.current[i] : NaN;
          d.values[i].push(val);
          receivedUpdateThisIntervalRef.current[i] = false;
        });

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

      uplotRef.current.setScale('x', {
        min: Math.max(0, now - windowSeconds),
        max: now,
      });

      if (dataChanged) {
        const timeData = d.time.length > 0 ? d.time : [now];
        const valueData = d.values.map((v) => (v.length > 0 ? v : [NaN]));
        try {
          uplotRef.current.setData([timeData, ...valueData]);
        } catch (_) {}
        const allY: number[] = [];
        valueData.forEach((series) => {
          series.forEach((v) => {
            if (Number.isFinite(v)) allY.push(v);
          });
        });
        if (allY.length > 0) {
          const yMin = Math.min(...allY);
          const yMax = Math.max(...allY);
          const [min, max] = smartYRange(yMin, yMax);
          uplotRef.current.setScale('y', { min, max });
        }
      }

      const dims = getDims();
      if (dims && (Math.abs(dims.w - uplotRef.current.width) > 2 || Math.abs(dims.h - uplotRef.current.height) > 2)) {
        uplotRef.current.setSize({ width: dims.w, height: dims.h });
      }

      animationFrameId = requestAnimationFrame(renderLoop);
    };

    requestAnimationFrame(() => {
      tryInit();
      setTimeout(tryInit, 100);
      setTimeout(tryInit, 300);
      setTimeout(tryInit, 600);
    });
    animationFrameId = requestAnimationFrame(renderLoop);

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
      unsubSensor();
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      ro.disconnect();
      uplotRef.current?.destroy();
      uplotRef.current = null;
      setReady(false);
    };
  }, [entities.join(','), component, windowSeconds, yLabel, colors.join(',')]);

  return (
    <div
      className={`w-full flex flex-col min-h-0 min-w-0 ${className}`}
      style={height ? { height: height + 32 } : { flex: '1 1 0%' }}
    >
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
}
