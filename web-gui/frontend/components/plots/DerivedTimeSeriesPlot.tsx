'use client'

import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { getDataCache } from '@/lib/data-cache';
import { getStartupTime } from '@/lib/startup-time';

const DEFAULT_WINDOW_SECONDS = 60;
const SAMPLE_HZ = 10;
const POLL_MS = 200;

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
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current || !plotRef.current) return;

    const componentMap = entities.map(() => component);
    const cache = getDataCache();
    const seriesLabels = entities.map((e, i) => labels?.[i] ?? e.split('.').pop() ?? e);
    const colorList = entities.map((_, i) => colors[i] || '#94a3b8');

    const getDims = (): { w: number; h: number } | null => {
      const el = containerRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const w = Math.max(0, Math.floor(rect.width));
      const h = Math.max(0, Math.floor(rect.height));
      if (w < 100 || h < 100) return null;
      return { w, h };
    };

    let data: uPlot.AlignedData = [
      [],
      ...entities.map(() => [] as number[]),
    ];

    const opts: uPlot.Options = {
      width: 400,
      height: 300,
      pxAlign: true,
      scales: {
        x: { time: false },
        y: { auto: true },
      },
      axes: [
        {
          label: 'T+ (s)',
          stroke: '#9CA3AF',
          grid: { show: true, stroke: '#555', width: 1 },
          ticks: { show: true, stroke: '#777', width: 1 },
          font: 'bold 11px monospace',
          labelFont: 'bold 11px system-ui',
          size: 50,
          values: (_u, vals) => vals.map((v) => (v == null ? '' : Math.round(v).toString())),
        },
        {
          label: yLabel,
          stroke: '#9CA3AF',
          grid: { show: true, stroke: '#555', width: 1 },
          ticks: { show: true, stroke: '#777', width: 1 },
          font: 'bold 11px monospace',
          labelFont: 'bold 11px system-ui',
          size: 70,
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
      padding: [10, 14, 8, 4] as [number, number, number, number],
    };

    const updateData = () => {
      const cached = cache.getAlignedHistory(entities, componentMap, windowSeconds);
      if (!cached || cached.time.length === 0) return;
      const t = transformRef.current;
      const transformed = cached.values.map((arr) =>
        arr.map((v) => {
          const out = t(v);
          return out === null || !Number.isFinite(out) ? NaN : out;
        })
      );
      data = [cached.time, ...transformed];
      if (uplotRef.current) {
        try {
          uplotRef.current.setData(data);
        } catch (_) {}
      }
    };

    const init = () => {
      const dims = getDims();
      if (!dims) return;
      updateData();
      opts.width = dims.w;
      opts.height = dims.h;
      try {
        uplotRef.current = new uPlot(opts, data, plotRef.current!);
        setReady(true);
      } catch (err) {
        console.error('[DerivedTimeSeriesPlot] init failed:', err);
      }
    };

    const tryInit = () => {
      if (uplotRef.current) return;
      init();
    };

    requestAnimationFrame(tryInit);
    const t1 = setTimeout(tryInit, 100);
    const t2 = setTimeout(tryInit, 300);
    const t3 = setTimeout(tryInit, 600);

    const intervalId = setInterval(() => {
      updateData();
      if (uplotRef.current) {
        const now = (Date.now() - getStartupTime()) / 1000;
        uplotRef.current.setScale('x', {
          min: Math.max(0, now - windowSeconds),
          max: now,
        });
      }
    }, POLL_MS);

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
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearInterval(intervalId);
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
      <div className="flex flex-wrap gap-x-4 gap-y-2 px-3 py-2 flex-shrink-0 border-t border-gray-800/80 bg-gray-900/30">
        {entities.map((e, i) => (
          <div key={e} className="flex items-center gap-2">
            <span
              className="w-3 h-1 rounded-full inline-block flex-shrink-0"
              style={{ background: colors[i] || '#94a3b8' }}
            />
            <span className="text-xs font-medium font-mono text-gray-400">
              {labels?.[i] ?? e.split('.').pop() ?? e}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
