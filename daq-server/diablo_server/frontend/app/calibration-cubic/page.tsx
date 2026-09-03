'use client'

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  ComposedChart, Scatter, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Label,
} from 'recharts';
import { useGetSensorValue, useSensorDataVersion } from '@/lib/store';
import { getWebSocketClient, getApiBaseUrl } from '@/lib/websocket';
import { MessageType, CalibrationCommand, CubicCalibrationChannel } from '@/lib/types';
import { useSensorConfig } from '@/lib/sensor-config';

// ── The service returns coeffs; the browser only EVALUATES them for the overlay (no fitting). ──
function evalCubicNorm(adc: number, poly: number[], min: number, scale: number): number {
  const s = scale || 1;
  const x = (adc - min) / s;
  let xp = 1;
  let y = 0;
  for (let i = 0; i < poly.length; i++) { y += poly[i] * xp; xp *= x; }
  return y;
}

function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !isFinite(v)) return '---';
  return v.toFixed(digits);
}

const STATUS_COLORS: Record<string, string> = {
  OK: 'text-green-400 border-green-700 bg-green-900/30',
  PENDING: 'text-yellow-400 border-yellow-700 bg-yellow-900/30',
  ERROR: 'text-red-400 border-red-700 bg-red-900/30',
  NONE: 'text-gray-500 border-gray-700 bg-gray-800/40',
};

export default function CubicCalibrationPage() {
  useSensorDataVersion();  // re-render on sensor flush so live ADC/PSI stay fresh
  const getSensorValue = useGetSensorValue();
  const ws = getWebSocketClient();
  const allChannels = useSensorConfig();

  // Low-pressure PTs only — HP (4-20 mA) PTs are not cubic-calibrated.
  const ptChannels = useMemo(
    () => allChannels.filter((c) => c.inCalibrationSequence && !c.isHpPt)
      .sort((a, b) => (a.boardId - b.boardId) || (a.id - b.id)),
    [allChannels],
  );

  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [refInput, setRefInput] = useState('');
  const [cubicState, setCubicState] = useState<Record<string, CubicCalibrationChannel>>({});

  // Default selection once channels load.
  useEffect(() => {
    if (selectedUid == null && ptChannels.length > 0) {
      setSelectedUid(ptChannels[0].boardId * 100 + ptChannels[0].id);
    }
  }, [ptChannels, selectedUid]);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/cubic_calibration`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && typeof data.cubic_state === 'object' && data.cubic_state) {
        setCubicState(data.cubic_state as Record<string, CubicCalibrationChannel>);
      }
    } catch { /* ignore transient fetch errors */ }
  }, []);

  // Poll the service's record; also refetch shortly after each capture/clear.
  useEffect(() => {
    fetchState();
    const id = setInterval(fetchState, 2000);
    return () => clearInterval(id);
  }, [fetchState]);

  const sendCalCmd = useCallback((cmd: CalibrationCommand) => {
    ws.send({ type: MessageType.CALIBRATION_COMMAND, timestamp: Date.now(), payload: cmd });
    // Nudge a refetch after the service has processed + persisted.
    setTimeout(fetchState, 350);
    setTimeout(fetchState, 900);
  }, [ws, fetchState]);

  const selected = selectedUid != null ? ptChannels.find((c) => c.boardId * 100 + c.id === selectedUid) : undefined;
  const selectedState = selectedUid != null ? cubicState[String(selectedUid)] : undefined;

  const liveAdc = selected ? getSensorValue(selected.calEntity, 'raw_adc_counts') : null;
  const livePsi = selected ? getSensorValue(selected.calEntity, 'pressure_psi') : null;

  const handleCapture = useCallback(() => {
    if (!selected) return;
    const psi = parseFloat(refInput);
    if (isNaN(psi)) return;
    sendCalCmd({ commandType: 'capture_cubic_point', sensorId: selected.id, boardId: selected.boardId, referencePressure: psi });
    setRefInput('');
  }, [selected, refInput, sendCalCmd]);

  const handleClear = useCallback(() => {
    if (!selected) return;
    if (typeof window !== 'undefined' && !window.confirm(`Clear all captured points for ${selected.role || 'CH' + selected.id}? Reverts to the factory cubic.`)) return;
    sendCalCmd({ commandType: 'clear_cubic_channel', sensorId: selected.id, boardId: selected.boardId });
  }, [selected, sendCalCmd]);

  // Build the chart series: captured scatter points + a sampled fitted curve.
  const chartData = useMemo(() => {
    const pts = selectedState?.points ?? [];
    const rows: { adc: number; psi?: number; psiFit?: number }[] = pts.map((p) => ({ adc: p.adc, psi: p.psi }));
    const poly = selectedState?.polyCoeffs;
    if (poly && poly.length >= 2 && pts.length >= 2) {
      const adcs = pts.map((p) => p.adc);
      let lo = Math.min(...adcs);
      let hi = Math.max(...adcs);
      const pad = (hi - lo) * 0.05 || 1;
      lo -= pad; hi += pad;
      const N = 60;
      for (let i = 0; i <= N; i++) {
        const adc = lo + ((hi - lo) * i) / N;
        rows.push({ adc, psiFit: evalCubicNorm(adc, poly, selectedState!.adcNormMin, selectedState!.adcNormScale) });
      }
    }
    return rows.sort((a, b) => a.adc - b.adc);
  }, [selectedState]);

  const statusOf = (uid: number): string => cubicState[String(uid)]?.status ?? 'NONE';
  const pointsOf = (uid: number): number => cubicState[String(uid)]?.points?.length ?? 0;

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden">
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-card">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold tracking-tight">Cubic Calibration</h1>
          <span className="text-xs text-gray-400 font-semibold bg-gray-800 px-2 py-0.5 rounded uppercase tracking-wider">
            One PT at a time
          </span>
          <span className="text-[11px] text-gray-500">
            {ptChannels.length} low-pressure PT{ptChannels.length === 1 ? '' : 's'} · fit runs in calibration_service
          </span>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* ── Left: channel list ─────────────────────────────────────────── */}
        <aside className="w-56 flex-shrink-0 border-r border-gray-800 overflow-auto bg-card/40">
          {ptChannels.map((c) => {
            const uid = c.boardId * 100 + c.id;
            const active = uid === selectedUid;
            const st = statusOf(uid);
            return (
              <button
                key={uid}
                onClick={() => setSelectedUid(uid)}
                className={`w-full text-left px-3 py-2 border-b border-gray-800/60 flex items-center justify-between gap-2
                  ${active ? 'bg-blue-900/30 border-l-2 border-l-blue-500' : 'hover:bg-gray-800/40'}`}
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-text truncate">{c.role || `CH${c.id}`}</div>
                  <div className="text-[10px] text-gray-500 font-mono">B{c.boardId} · CH{c.id}</div>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <span className={`text-[9px] font-bold px-1 rounded border ${STATUS_COLORS[st] ?? STATUS_COLORS.NONE}`}>
                    {st === 'NONE' ? '—' : st}
                  </span>
                  <span className="text-[9px] text-gray-500 font-mono">{pointsOf(uid)} pts</span>
                </div>
              </button>
            );
          })}
          {ptChannels.length === 0 && (
            <div className="p-3 text-xs text-gray-500">No low-pressure PT channels in the active config.</div>
          )}
        </aside>

        {/* ── Right: detail for the selected channel ─────────────────────── */}
        <section className="flex-1 min-w-0 overflow-auto p-4">
          {!selected ? (
            <div className="text-sm text-gray-500">Select a PT channel to calibrate.</div>
          ) : (
            <div className="flex flex-col gap-4 max-w-4xl">
              {/* Header + live readouts */}
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <div className="text-base font-bold text-text">{selected.role || `CH${selected.id}`}</div>
                  <div className="text-[11px] text-gray-500 font-mono">Board {selected.boardId} · Connector {selected.id} · {selected.calEntity}</div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className="text-[10px] text-gray-500 font-bold">LIVE PSI</div>
                    <div className="text-xl font-bold font-mono text-green-400 tabular-nums">{fmt(livePsi)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] text-gray-500 font-bold">LIVE ADC</div>
                    <div className="text-lg font-mono text-gray-300 tabular-nums">{liveAdc == null ? '---' : Math.round(liveAdc).toLocaleString()}</div>
                  </div>
                </div>
              </div>

              {/* Capture controls */}
              <div className="flex items-center gap-2 flex-wrap border border-gray-800 rounded p-3 bg-card">
                <span className="text-[11px] text-gray-400 font-semibold">Set the real pressure now, then capture:</span>
                <input
                  type="number"
                  step="any"
                  placeholder="Reference PSI"
                  value={refInput}
                  onChange={(e) => setRefInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCapture()}
                  className="w-32 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm font-mono text-text
                             placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleCapture}
                  disabled={!refInput}
                  className="px-3 py-1.5 text-xs font-bold rounded bg-blue-700 hover:bg-blue-600
                             disabled:opacity-30 disabled:cursor-not-allowed text-white"
                >
                  CAPTURE POINT
                </button>
                <button
                  onClick={handleClear}
                  className="px-3 py-1.5 text-xs font-bold rounded border border-red-700 bg-red-900/30 text-red-300 hover:bg-red-800/50 ml-auto"
                >
                  CLEAR CHANNEL
                </button>
              </div>

              {/* Fit status */}
              <div className="flex items-center gap-4 text-xs flex-wrap">
                <span className={`font-bold px-2 py-0.5 rounded border ${STATUS_COLORS[selectedState?.status ?? 'NONE'] ?? STATUS_COLORS.NONE}`}>
                  {selectedState?.status ?? 'NO DATA'}
                </span>
                <span className="text-gray-400 font-mono">{selectedState?.points?.length ?? 0} points</span>
                <span className="text-gray-400 font-mono">degree {selectedState?.degree ?? 0}</span>
                <span className="text-gray-400 font-mono">RMSE {selectedState ? fmt(selectedState.rmse, 3) : '---'} PSI</span>
                {selectedState?.last_error ? <span className="text-red-400">{selectedState.last_error}</span> : null}
              </div>

              {/* Graph: captured points + fitted curve */}
              <div className="border border-gray-800 rounded bg-card p-2" style={{ height: 420 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 12, right: 20, bottom: 28, left: 12 }}>
                    <CartesianGrid stroke="#222" />
                    <XAxis type="number" dataKey="adc" domain={['auto', 'auto']} stroke="#888"
                           tick={{ fontSize: 10, fill: '#888' }} tickFormatter={(v) => Number(v).toExponential(1)}>
                      <Label value="Raw ADC code" position="bottom" offset={12} fill="#888" fontSize={11} />
                    </XAxis>
                    <YAxis type="number" stroke="#888" tick={{ fontSize: 10, fill: '#888' }}
                           tickFormatter={(v) => Number(v).toFixed(0)}>
                      <Label value="Pressure (PSI)" angle={-90} position="insideLeft" fill="#888" fontSize={11} />
                    </YAxis>
                    <Tooltip
                      contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 11 }}
                      labelFormatter={(v) => `ADC ${Number(v).toExponential(3)}`}
                      formatter={(val: number, name: string) => [Number(val).toFixed(2) + ' PSI', name === 'psi' ? 'captured' : 'fit']}
                    />
                    <Line type="monotone" dataKey="psiFit" stroke="#38BDF8" dot={false} strokeWidth={2} connectNulls isAnimationActive={false} name="fit" />
                    <Scatter dataKey="psi" fill="#F59E0B" name="psi" isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* Captured points table */}
              {selectedState?.points && selectedState.points.length > 0 && (
                <div className="border border-gray-800 rounded overflow-hidden">
                  <table className="w-full text-xs font-mono">
                    <thead className="bg-gray-900 text-gray-400">
                      <tr><th className="text-left px-3 py-1">#</th><th className="text-right px-3 py-1">Ref PSI</th><th className="text-right px-3 py-1">ADC code</th></tr>
                    </thead>
                    <tbody>
                      {selectedState.points.map((p, i) => (
                        <tr key={i} className="border-t border-gray-800/60 text-gray-300">
                          <td className="px-3 py-1">{i + 1}</td>
                          <td className="px-3 py-1 text-right">{p.psi.toFixed(2)}</td>
                          <td className="px-3 py-1 text-right">{Math.round(p.adc).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
