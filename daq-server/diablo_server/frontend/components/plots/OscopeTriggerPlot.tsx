'use client'

import { useEffect, useRef, useState, useCallback } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';
import { SENSOR_DATA_STALE_MS } from '@/lib/sensor-rate';
import { useStaleRenderTick } from '@/lib/store';

export const RAW_TO_DEG = 360.0 / 4096.0;
export const rawToDeg = (raw: number) => (raw & 0x0FFF) * RAW_TO_DEG;

const TRIGGER_THRESHOLD_DEG = 45;
const BUFFER_DURATION_MS = 2000;
const CAPTURE_HALF_MS = 500;
const POST_TRIGGER_COLLECT_MS = 600;
const BASELINE_SAMPLE_COUNT = 10;
const PLATEAU_WINDOW_MS = 100;

const ENC_COLORS = ['#3B82F6', '#F97316'];

type TriggerState = 'IDLE' | 'ARMED' | 'TRIGGERED';

interface ChannelSample {
  t: number; // ms (Date.now)
  v: number; // degrees
}

export interface TransitionResult {
  timeMsRel: number;
  prePlateau: number;
  postPlateau: number;
  angleDelta: number;
}

interface OverlayData {
  r1: TransitionResult | null;
  r2: TransitionResult | null;
  t0Offset: number;
}

export function detectTransition(
  times: number[],
  values: number[],
): TransitionResult | null {
  if (times.length < 4) return null;

  const firstEnd = times[0] + PLATEAU_WINDOW_MS;
  const lastStart = times[times.length - 1] - PLATEAU_WINDOW_MS;

  let preSum = 0, preCount = 0;
  let postSum = 0, postCount = 0;
  for (let i = 0; i < times.length; i++) {
    if (times[i] <= firstEnd) { preSum += values[i]; preCount++; }
    if (times[i] >= lastStart) { postSum += values[i]; postCount++; }
  }
  if (preCount === 0 || postCount === 0) return null;

  const prePlateau = preSum / preCount;
  const postPlateau = postSum / postCount;
  const angleDelta = Math.abs(postPlateau - prePlateau);

  if (angleDelta < TRIGGER_THRESHOLD_DEG * 0.5) return null;

  const midpoint = (prePlateau + postPlateau) / 2;
  const rising = postPlateau > prePlateau;

  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    const crosses = rising
      ? (prev <= midpoint && curr >= midpoint)
      : (prev >= midpoint && curr <= midpoint);
    if (crosses) {
      const dv = curr - prev;
      const dt = times[i] - times[i - 1];
      const frac = dv !== 0 ? (midpoint - prev) / dv : 0.5;
      const crossTime = times[i - 1] + frac * dt;
      return { timeMsRel: crossTime, prePlateau, postPlateau, angleDelta };
    }
  }

  return null;
}

const medianOf = (arr: number[]) => {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export default function OscopeTriggerPlot() {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotDivRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);

  const [triggerState, setTriggerState] = useState<TriggerState>('IDLE');
  const triggerStateRef = useRef<TriggerState>('IDLE');

  const [skewMs, setSkewMs] = useState<number | null>(null);
  const [enc1Result, setEnc1Result] = useState<TransitionResult | null>(null);
  const [enc2Result, setEnc2Result] = useState<TransitionResult | null>(null);
  const [leaderLabel, setLeaderLabel] = useState('');

  // Per-channel circular buffers — each only contains samples actually received
  // for that channel, so dots are at real receive timestamps.
  const buf1 = useRef<ChannelSample[]>([]);
  const buf2 = useRef<ChannelSample[]>([]);
  const baseline1 = useRef<number[]>([]);
  const baseline2 = useRef<number[]>([]);

  const triggerTimeMs = useRef<number | null>(null);
  const overlayDataRef = useRef<OverlayData | null>(null);

  const lastEncoderPacketMsRef = useRef<number | null>(null);

  const staleClock = useStaleRenderTick();

  const setState = useCallback((s: TriggerState) => {
    triggerStateRef.current = s;
    setTriggerState(s);
  }, []);

  const clearAllBuffers = () => {
    buf1.current = [];
    buf2.current = [];
    baseline1.current = [];
    baseline2.current = [];
  };

  const handleArm = useCallback(() => {
    clearAllBuffers();
    triggerTimeMs.current = null;
    overlayDataRef.current = null;
    setSkewMs(null);
    setEnc1Result(null);
    setEnc2Result(null);
    setLeaderLabel('');

    const plot = uplotRef.current;
    if (plot) {
      plot.setData([new Float64Array(0), new Float64Array(0), new Float64Array(0)]);
    }

    setState('ARMED');
  }, [setState]);

  const handleReset = useCallback(() => {
    triggerTimeMs.current = null;
    overlayDataRef.current = null;
    setState('IDLE');
    setSkewMs(null);
    setEnc1Result(null);
    setEnc2Result(null);
    setLeaderLabel('');

    const plot = uplotRef.current;
    if (plot) {
      plot.setData([new Float64Array(0), new Float64Array(0), new Float64Array(0)]);
    }
  }, [setState]);

  const analyzeAndRender = useCallback((cap1: ChannelSample[], cap2: ChannelSample[], tTrig: number) => {
    const times1 = cap1.map((s) => s.t - tTrig);
    const vals1 = cap1.map((s) => s.v);
    const times2 = cap2.map((s) => s.t - tTrig);
    const vals2 = cap2.map((s) => s.v);

    const r1 = detectTransition(times1, vals1);
    const r2 = detectTransition(times2, vals2);

    setEnc1Result(r1);
    setEnc2Result(r2);

    let t0Offset = 0;
    let computedSkew: number | null = null;
    let leader = '';

    if (r1 && r2) {
      t0Offset = Math.min(r1.timeMsRel, r2.timeMsRel);
      computedSkew = r1.timeMsRel - r2.timeMsRel;
      if (computedSkew < 0) leader = 'Encoder 1 leads';
      else if (computedSkew > 0) leader = 'Encoder 2 leads';
      else leader = 'Simultaneous';
    } else if (r1) {
      t0Offset = r1.timeMsRel;
    } else if (r2) {
      t0Offset = r2.timeMsRel;
    }

    setSkewMs(computedSkew);
    setLeaderLabel(leader);

    overlayDataRef.current = { r1, r2, t0Offset };

    // Build merged-time aligned arrays for uPlot. Each channel's points only
    // exist on its own real receive timestamps; gaps for the other channel
    // become NaN so points won't render there.
    const rel1 = times1.map((t) => t - t0Offset);
    const rel2 = times2.map((t) => t - t0Offset);

    const merged = Array.from(new Set<number>([...rel1, ...rel2])).sort((a, b) => a - b);
    const xs = new Float64Array(merged);
    const y1 = new Float64Array(merged.length);
    const y2 = new Float64Array(merged.length);

    const map1 = new Map<number, number>();
    for (let i = 0; i < rel1.length; i++) map1.set(rel1[i], vals1[i]);
    const map2 = new Map<number, number>();
    for (let i = 0; i < rel2.length; i++) map2.set(rel2[i], vals2[i]);

    for (let i = 0; i < merged.length; i++) {
      const x = merged[i];
      y1[i] = map1.has(x) ? (map1.get(x) as number) : NaN;
      y2[i] = map2.has(x) ? (map2.get(x) as number) : NaN;
    }

    const plot = uplotRef.current;
    if (!plot) return;

    if (merged.length === 0) {
      plot.setData([new Float64Array(0), new Float64Array(0), new Float64Array(0)]);
      return;
    }

    const xExtent = Math.max(Math.abs(merged[0]), Math.abs(merged[merged.length - 1]));
    const finiteVals = [...vals1, ...vals2].filter(isFinite);
    const yMin = finiteVals.length ? Math.min(...finiteVals) : 0;
    const yMax = finiteVals.length ? Math.max(...finiteVals) : 360;
    const yPad = Math.max((yMax - yMin) * 0.15, 5);

    plot.setScale('x', { min: -xExtent, max: xExtent });
    plot.setScale('y', { min: yMin - yPad, max: yMax + yPad });
    plot.setData([xs, y1, y2]);
  }, []);

  // Subscribe to encoder updates
  useEffect(() => {
    const ws = getWebSocketClient();

    const unsub = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => {
      const update = p as SensorUpdate;
      if (update.component !== 'raw_angle') return;
      const e = update.entity;

      let buf: ChannelSample[];
      let baseline: number[];
      if (e === 'ENC1.CH1' || e === 'ENC.CH1') {
        buf = buf1.current;
        baseline = baseline1.current;
      } else if (e === 'ENC1.CH2' || e === 'ENC.CH2') {
        buf = buf2.current;
        baseline = baseline2.current;
      } else {
        return;
      }

      const nowMs = Date.now();
      const deg = rawToDeg(update.value);
      lastEncoderPacketMsRef.current = nowMs;

      if (triggerStateRef.current === 'TRIGGERED') return;

      buf.push({ t: nowMs, v: deg });
      const cutoff = nowMs - BUFFER_DURATION_MS;
      while (buf.length > 0 && buf[0].t < cutoff) buf.shift();

      if (triggerStateRef.current !== 'ARMED') return;

      // Collecting post-trigger data
      if (triggerTimeMs.current !== null) {
        if (nowMs - triggerTimeMs.current >= POST_TRIGGER_COLLECT_MS) {
          const tTrig = triggerTimeMs.current;
          const wStart = tTrig - CAPTURE_HALF_MS;
          const wEnd = tTrig + CAPTURE_HALF_MS;
          const cap1 = buf1.current.filter((s) => s.t >= wStart && s.t <= wEnd);
          const cap2 = buf2.current.filter((s) => s.t >= wStart && s.t <= wEnd);
          setState('TRIGGERED');
          analyzeAndRender(cap1, cap2, tTrig);
        }
        return;
      }

      // Update this channel's baseline median
      baseline.push(deg);
      if (baseline.length > BASELINE_SAMPLE_COUNT) baseline.shift();
      if (baseline.length < 3) return;

      const med = medianOf(baseline);
      if (Math.abs(deg - med) > TRIGGER_THRESHOLD_DEG) {
        triggerTimeMs.current = nowMs;
      }
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setState, analyzeAndRender]);

  // Clear live ARMED preview when encoder packets stop (same stale window as dashboard).
  useEffect(() => {
    const last = lastEncoderPacketMsRef.current;
    if (last == null) return;
    if (Date.now() - last < SENSOR_DATA_STALE_MS) return;
    if (triggerStateRef.current !== 'ARMED') return;
    clearAllBuffers();
    const plot = uplotRef.current;
    if (plot) {
      plot.setData([new Float64Array(0), new Float64Array(0), new Float64Array(0)]);
    }
  }, [staleClock]);

  // Create uPlot instance with a draw hook for overlays
  useEffect(() => {
    if (!plotDivRef.current) return;

    const drawHook = (u: uPlot) => {
      const od = overlayDataRef.current;
      if (!od) return;

      const ctx = u.ctx;
      const { r1, r2, t0Offset } = od;
      const dpr = devicePixelRatio || 1;

      // Draw hook runs against the raw canvas (device pixels), so request
      // canvas-pixel positions and use bbox as-is.
      const valToX = (ms: number) => u.valToPos(ms - t0Offset, 'x', true);
      const valToY = (deg: number) => u.valToPos(deg, 'y', true);

      const plotLeft = u.bbox.left;
      const plotTop = u.bbox.top;
      const plotWidth = u.bbox.width;
      const plotHeight = u.bbox.height;

      ctx.save();

      const drawDashedVLine = (xMs: number, color: string, label: string) => {
        const x = valToX(xMs);
        if (x < plotLeft || x > plotLeft + plotWidth) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 * dpr;
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.beginPath();
        ctx.moveTo(x, plotTop);
        ctx.lineTo(x, plotTop + plotHeight);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.font = `bold ${11 * dpr}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(label, x, plotTop - 4 * dpr);
      };

      const drawDottedHLine = (deg: number, color: string) => {
        const y = valToY(deg);
        if (y < plotTop || y > plotTop + plotHeight) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1 * dpr;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(plotLeft, y);
        ctx.lineTo(plotLeft + plotWidth, y);
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      };

      // Plateau lines
      if (r1) {
        drawDottedHLine(r1.prePlateau, ENC_COLORS[0]);
        drawDottedHLine(r1.postPlateau, ENC_COLORS[0]);
      }
      if (r2) {
        drawDottedHLine(r2.prePlateau, ENC_COLORS[1]);
        drawDottedHLine(r2.postPlateau, ENC_COLORS[1]);
      }

      // Transition markers
      if (r1 && r2) {
        const firstMs = Math.min(r1.timeMsRel, r2.timeMsRel);
        const secondMs = Math.max(r1.timeMsRel, r2.timeMsRel);
        drawDashedVLine(firstMs, '#ffffff', 't = 0');
        const delta = secondMs - firstMs;
        drawDashedVLine(secondMs, '#fbbf24', `t = +${delta.toFixed(1)} ms`);
      } else if (r1) {
        drawDashedVLine(r1.timeMsRel, '#ffffff', 't = 0');
      } else if (r2) {
        drawDashedVLine(r2.timeMsRel, '#ffffff', 't = 0');
      }

      ctx.restore();
    };

    const opts: uPlot.Options = {
      width: plotDivRef.current.clientWidth || 800,
      height: 300,
      cursor: { show: true },
      scales: {
        x: { time: false, min: -CAPTURE_HALF_MS, max: CAPTURE_HALF_MS },
        y: { auto: false, min: 0, max: 360 },
      },
      axes: [
        {
          stroke: '#888',
          grid: { stroke: 'rgba(255,255,255,0.06)' },
          values: (_u: uPlot, vals: number[]) => vals.map((v) => `${v.toFixed(0)} ms`),
          label: 'Time (ms)',
          labelSize: 14,
          font: '11px monospace',
        },
        {
          stroke: '#888',
          grid: { stroke: 'rgba(255,255,255,0.06)' },
          values: (_u: uPlot, vals: number[]) => vals.map((v) => `${v.toFixed(0)}°`),
          label: 'Angle (°)',
          labelSize: 14,
          font: '11px monospace',
        },
      ],
      series: [
        { label: 'Time' },
        {
          label: 'Encoder 1',
          stroke: ENC_COLORS[0],
          width: 2,
          spanGaps: true,
          points: { show: true, size: 6, fill: ENC_COLORS[0] },
        },
        {
          label: 'Encoder 2',
          stroke: ENC_COLORS[1],
          width: 2,
          spanGaps: true,
          points: { show: true, size: 6, fill: ENC_COLORS[1] },
        },
      ],
      hooks: {
        draw: [drawHook],
      },
    };

    const emptyData: uPlot.AlignedData = [new Float64Array(0), new Float64Array(0), new Float64Array(0)];
    const plot = new uPlot(opts, emptyData, plotDivRef.current);
    uplotRef.current = plot;

    const ro = new ResizeObserver(() => {
      if (plotDivRef.current && uplotRef.current) {
        uplotRef.current.setSize({
          width: plotDivRef.current.clientWidth,
          height: 300,
        });
      }
    });
    ro.observe(plotDivRef.current);

    return () => {
      ro.disconnect();
      plot.destroy();
      uplotRef.current = null;
    };
  }, []);

  return (
    <div ref={containerRef} className="bg-card rounded-lg border border-gray-800 p-4">
      {/* Controls */}
      <div className="flex items-center gap-4 mb-3">
        <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">
          Oscilloscope Trigger
        </h3>

        <div className="flex items-center gap-2">
          {triggerState === 'IDLE' && (
            <button
              onClick={handleArm}
              className="px-4 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider bg-green-700 hover:bg-green-600 text-white transition-colors"
            >
              ARM
            </button>
          )}
          {triggerState === 'ARMED' && (
            <button
              onClick={handleReset}
              className="px-4 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider bg-yellow-700/60 hover:bg-yellow-600/70 text-yellow-200 animate-pulse transition-colors"
            >
              ARMED — waiting...
            </button>
          )}
          {triggerState === 'TRIGGERED' && (
            <button
              onClick={handleReset}
              className="px-4 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
            >
              RESET
            </button>
          )}
        </div>

        <div
          className={`text-xs font-mono font-bold uppercase tracking-wider ${
            triggerState === 'IDLE'
              ? 'text-gray-500'
              : triggerState === 'ARMED'
                ? 'text-yellow-400'
                : 'text-red-400'
          }`}
        >
          {triggerState}
        </div>
      </div>

      {/* Plot */}
      <div ref={plotDivRef} className="w-full" />

      {/* Results */}
      {triggerState === 'TRIGGERED' && (
        <div className="mt-3 flex flex-wrap items-center gap-6 px-2 py-3 rounded-md bg-black/20 border border-white/5">
          {enc1Result && (
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: ENC_COLORS[0] }} />
              <span className="text-sm font-mono text-gray-300">
                Encoder 1: <span className="font-bold text-white">{enc1Result.angleDelta.toFixed(1)}°</span> change
              </span>
            </div>
          )}
          {enc2Result && (
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: ENC_COLORS[1] }} />
              <span className="text-sm font-mono text-gray-300">
                Encoder 2: <span className="font-bold text-white">{enc2Result.angleDelta.toFixed(1)}°</span> change
              </span>
            </div>
          )}
          {skewMs !== null && (
            <div className="ml-auto flex items-center gap-3">
              <span className="text-lg font-mono font-bold text-white">
                Skew: {skewMs >= 0 ? '+' : ''}{skewMs.toFixed(1)} ms
              </span>
              {leaderLabel && (
                <span className="text-sm font-mono text-gray-400">({leaderLabel})</span>
              )}
            </div>
          )}
          {skewMs === null && (enc1Result || enc2Result) && !(enc1Result && enc2Result) && (
            <div className="ml-auto text-sm font-mono text-yellow-400">
              Only one transition detected
            </div>
          )}
          {!enc1Result && !enc2Result && (
            <div className="ml-auto text-sm font-mono text-red-400">
              No transitions detected in capture window
            </div>
          )}
        </div>
      )}

      {triggerState === 'IDLE' && (
        <div className="mt-2 text-xs text-gray-500 font-mono">
          Press ARM, then actuate two valves simultaneously. Captures a 1s window when either encoder moves &gt;45°.
        </div>
      )}
    </div>
  );
}
