'use client'

import { useEffect, useRef, useState, useCallback } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';

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

interface Sample {
  timeMs: number;
  enc1Deg: number;
  enc2Deg: number;
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

  const circularBuffer = useRef<Sample[]>([]);
  const baselineEnc1 = useRef<number[]>([]);
  const baselineEnc2 = useRef<number[]>([]);
  const triggerTimeMs = useRef<number | null>(null);
  const overlayDataRef = useRef<OverlayData | null>(null);

  const latestEnc1 = useRef<number>(NaN);
  const latestEnc2 = useRef<number>(NaN);

  const setState = useCallback((s: TriggerState) => {
    triggerStateRef.current = s;
    setTriggerState(s);
  }, []);

  const handleArm = useCallback(() => {
    circularBuffer.current = [];
    baselineEnc1.current = [];
    baselineEnc2.current = [];
    triggerTimeMs.current = null;
    overlayDataRef.current = null;
    setSkewMs(null);
    setEnc1Result(null);
    setEnc2Result(null);
    setLeaderLabel('');

    // Clear the plot
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

  // Subscribe to encoder updates
  useEffect(() => {
    const ws = getWebSocketClient();
    ws.connect();

    const unsub = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => {
      const update = p as SensorUpdate;
      if (update.component !== 'raw_angle') return;
      if (update.entity === 'ENC.CH1') latestEnc1.current = rawToDeg(update.value);
      else if (update.entity === 'ENC.CH2') latestEnc2.current = rawToDeg(update.value);
      else return;

      if (triggerStateRef.current === 'TRIGGERED') return;

      const nowMs = Date.now();
      const enc1 = latestEnc1.current;
      const enc2 = latestEnc2.current;
      if (isNaN(enc1) || isNaN(enc2)) return;

      const sample: Sample = { timeMs: nowMs, enc1Deg: enc1, enc2Deg: enc2 };
      const buf = circularBuffer.current;
      buf.push(sample);

      const cutoff = nowMs - BUFFER_DURATION_MS;
      while (buf.length > 0 && buf[0].timeMs < cutoff) buf.shift();

      if (triggerStateRef.current !== 'ARMED') return;

      // Collecting post-trigger data
      if (triggerTimeMs.current !== null) {
        if (nowMs - triggerTimeMs.current >= POST_TRIGGER_COLLECT_MS) {
          const tTrig = triggerTimeMs.current;
          const windowStart = tTrig - CAPTURE_HALF_MS;
          const windowEnd = tTrig + CAPTURE_HALF_MS;
          const captured = buf.filter((s) => s.timeMs >= windowStart && s.timeMs <= windowEnd);
          setState('TRIGGERED');
          analyzeAndRender(captured, tTrig);
        }
        return;
      }

      // Update baselines
      baselineEnc1.current.push(enc1);
      baselineEnc2.current.push(enc2);
      if (baselineEnc1.current.length > BASELINE_SAMPLE_COUNT) baselineEnc1.current.shift();
      if (baselineEnc2.current.length > BASELINE_SAMPLE_COUNT) baselineEnc2.current.shift();

      if (baselineEnc1.current.length < 3) return;

      const medianOf = (arr: number[]) => {
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      };

      const b1 = medianOf(baselineEnc1.current);
      const b2 = medianOf(baselineEnc2.current);
      const d1 = Math.abs(enc1 - b1);
      const d2 = Math.abs(enc2 - b2);

      if (d1 > TRIGGER_THRESHOLD_DEG || d2 > TRIGGER_THRESHOLD_DEG) {
        triggerTimeMs.current = nowMs;
      }
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setState]);

  const analyzeAndRender = useCallback((captured: Sample[], tTrig: number) => {
    if (captured.length < 4) return;

    const times = captured.map((s) => s.timeMs - tTrig);
    const enc1Vals = captured.map((s) => s.enc1Deg);
    const enc2Vals = captured.map((s) => s.enc2Deg);

    const r1 = detectTransition(times, enc1Vals);
    const r2 = detectTransition(times, enc2Vals);

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

    // Store overlay data so the draw hook can re-render markers on resize
    overlayDataRef.current = { r1, r2, t0Offset };

    // Render to uPlot with times relative to first transition
    const relTimes = times.map((t) => t - t0Offset);
    const timeArr = new Float64Array(relTimes);
    const enc1Arr = new Float64Array(enc1Vals);
    const enc2Arr = new Float64Array(enc2Vals);

    const plot = uplotRef.current;
    if (!plot) return;

    const xExtent = Math.max(Math.abs(Math.min(...relTimes)), Math.abs(Math.max(...relTimes)));
    const allVals = [...enc1Vals, ...enc2Vals].filter(isFinite);
    const yMin = Math.min(...allVals);
    const yMax = Math.max(...allVals);
    const yPad = Math.max((yMax - yMin) * 0.15, 5);

    plot.setScale('x', { min: -xExtent, max: xExtent });
    plot.setScale('y', { min: yMin - yPad, max: yMax + yPad });
    plot.setData([timeArr, enc1Arr, enc2Arr]);
  }, []);

  // Create uPlot instance with a draw hook for overlays
  useEffect(() => {
    if (!plotDivRef.current) return;

    const drawHook = (u: uPlot) => {
      const od = overlayDataRef.current;
      if (!od) return;

      const ctx = u.ctx;
      const { r1, r2, t0Offset } = od;

      // valToPos returns CSS pixel positions
      const valToX = (ms: number) => u.valToPos(ms - t0Offset, 'x');
      const valToY = (deg: number) => u.valToPos(deg, 'y');

      const plotLeft = u.bbox.left / devicePixelRatio;
      const plotTop = u.bbox.top / devicePixelRatio;
      const plotWidth = u.bbox.width / devicePixelRatio;
      const plotHeight = u.bbox.height / devicePixelRatio;

      ctx.save();

      const drawDashedVLine = (xMs: number, color: string, label: string) => {
        const x = valToX(xMs);
        if (x < plotLeft || x > plotLeft + plotWidth) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(x, plotTop);
        ctx.lineTo(x, plotTop + plotHeight);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(label, x, plotTop - 4);
      };

      const drawDottedHLine = (deg: number, color: string) => {
        const y = valToY(deg);
        if (y < plotTop || y > plotTop + plotHeight) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(plotLeft, y);
        ctx.lineTo(plotLeft + plotWidth, y);
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      };

      // Draw plateau lines
      if (r1) {
        drawDottedHLine(r1.prePlateau, ENC_COLORS[0]);
        drawDottedHLine(r1.postPlateau, ENC_COLORS[0]);
      }
      if (r2) {
        drawDottedHLine(r2.prePlateau, ENC_COLORS[1]);
        drawDottedHLine(r2.postPlateau, ENC_COLORS[1]);
      }

      // Draw transition markers
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
          points: { show: false },
        },
        {
          label: 'Encoder 2',
          stroke: ENC_COLORS[1],
          width: 2,
          points: { show: false },
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
