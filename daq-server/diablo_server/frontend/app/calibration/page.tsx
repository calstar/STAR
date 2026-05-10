'use client'

import { useEffect, useState, useCallback } from 'react';
import { useSensorStore, useGetSensorValue, useSensorDataVersion, useLoadCellForceLbf } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import {
  MessageType,
  SensorUpdate,
  CalibrationChannelStatus,
  CalibrationStatusPayload,
  CalibrationCommand,
  CalibrationConfidence,
} from '@/lib/types';
import { useSensorConfig, SensorConfig } from '@/lib/sensor-config';
import { getApiBaseUrl } from '@/lib/websocket';

// ── PT_CHANNELS is now derived from config.toml via useSensorConfig().
// The hardcoded list below is removed.

const CONFIDENCE_COLORS: Record<CalibrationConfidence, string> = {
  MAXIMUM: 'text-green-400 border-green-700 bg-green-900/30',
  HIGH: 'text-blue-400 border-blue-700 bg-blue-900/30',
  MEDIUM: 'text-yellow-400 border-yellow-700 bg-yellow-900/30',
  LOW: 'text-orange-400 border-orange-700 bg-orange-900/30',
  UNCALIBRATED: 'text-gray-500 border-gray-700 bg-gray-800/40',
};

function fmtPsi(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '---';
  if (Math.abs(v) > 99999) return '---';
  return v.toFixed(2);
}

function fmtAdc(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '---';
  return v.toLocaleString();
}

const LBF_TO_KG = 0.453592;

// ── Load cell 0-point card: show offset-adjusted force + Zero button ───────────
function LoadCellZeroCard({ calEntity, label, onZero }: { calEntity: string; label: string; getSensorValue: (e: string, c: string) => number | null; onZero: () => void }) {
  const forceLbf = useLoadCellForceLbf(calEntity);
  const kg = forceLbf != null && Number.isFinite(forceLbf) ? forceLbf * LBF_TO_KG : null;
  const display = kg != null ? kg.toFixed(2) : '—';
  return (
    <div className="flex items-center gap-2 rounded border border-gray-700 bg-card px-3 py-2">
      <span className="text-[10px] font-bold text-gray-500 w-16">{label}</span>
      <span className="text-sm font-mono text-green-400 tabular-nums w-14">{display} kg</span>
      <button
        type="button"
        onClick={onZero}
        className="px-2 py-1 text-[10px] font-bold rounded border border-amber-600 bg-amber-900/30 text-amber-300 hover:bg-amber-800/50"
      >
        Zero
      </button>
    </div>
  );
}

// ── Single channel card — compact and readable ─────────────────────────────────
interface ChannelCardProps {
  ch: SensorConfig;
  status?: CalibrationChannelStatus;
  rawAdc?: number | null;
  calPsi?: number | null;
  onCapture: (sensorId: number, boardId: number, refPsi: number) => void;
}

function ChannelCard({ ch, status, rawAdc, calPsi, onCapture }: ChannelCardProps) {
  const [refInput, setRefInput] = useState('');
  const conf = status?.confidence ?? 'UNCALIBRATED';
  const isDrift = status?.driftDetected ?? false;

  const handleCapture = () => {
    const psi = parseFloat(refInput);
    if (isNaN(psi)) return;
    onCapture(ch.id, ch.boardId, psi);
    setRefInput('');
  };

  return (
    <div
      className={`rounded border p-2.5 flex flex-col gap-1.5 transition-all bg-card
        ${isDrift ? 'border-red-600 shadow-[0_0_10px_rgba(239,68,68,0.2)]' : 'border-gray-800'}`}
    >
      {/* Header row: CH + name + confidence */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[10px] font-bold text-gray-500">CH{ch.id}</span>
          <span className="text-xs font-semibold text-text truncate">{ch.role}</span>
        </div>
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0 ${CONFIDENCE_COLORS[conf]}`}>
          {conf === 'UNCALIBRATED' ? 'UNCAL' : conf}
        </span>
      </div>

      {/* Big PSI readout */}
      <div className="bg-gray-900/60 rounded px-2 py-1.5 flex items-baseline justify-between">
        <span className="text-[10px] text-gray-500 font-bold">PSI</span>
        <span className="text-xl font-bold font-mono tabular-nums text-green-400 leading-none">
          {fmtPsi(calPsi)}
        </span>
      </div>

      {/* ADC + RLS count (compact row) */}
      <div className="flex items-center justify-between text-[10px] font-mono text-gray-500 px-0.5">
        <span>ADC {fmtAdc(rawAdc)}</span>
        <span>RLS {status?.rlsUpdateCount ?? 0}</span>
      </div>

      {/* GLR drift bar — tiny but informative */}
      {status && (
        <div className="flex items-center gap-1.5 px-0.5">
          <span className="text-[9px] text-gray-600">GLR</span>
          <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${Math.min((status.glrStat / 6) * 100, 100)}%`,
                background: status.glrStat > 3 ? '#EF4444' : status.glrStat > 2 ? '#F59E0B' : '#22C55E',
              }}
            />
          </div>
          <span className="text-[9px] font-mono text-gray-500 w-6 text-right">
            {status.glrStat.toFixed(1)}
          </span>
          {isDrift && <span className="text-[9px] text-red-400 font-bold animate-pulse">⚠</span>}
        </div>
      )}

      {/* Capture input — only for channels in calibration sequence (low-pressure PTs) */}
      <div className="flex gap-1 mt-auto pt-1 border-t border-gray-800/60">
        {ch.inCalibrationSequence ? (
          <>
            <input
              type="number"
              step="any"
              placeholder="Ref PSI"
              value={refInput}
              onChange={(e) => setRefInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCapture()}
              className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs
                         font-mono text-text placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleCapture}
              disabled={!refInput}
              className="px-2 py-1 text-[10px] font-bold rounded bg-blue-700 hover:bg-blue-600
                         disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-white"
            >
              CAPTURE
            </button>
          </>
        ) : (
          <span className="text-[10px] text-gray-500 italic">HP — no cal</span>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function CalibrationPage() {
  useSensorDataVersion(); // re-render on sensor flush so getSensorValue() shows fresh data
  const getSensorValue = useGetSensorValue();
  const ws = getWebSocketClient();
  const ptChannels = useSensorConfig();

  const [calStatus, setCalStatus] = useState<CalibrationStatusPayload | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [calFilePath, setCalFilePath] = useState<string | null>(null);
  const [phase2Active, setPhase2Active] = useState(true); // reflects backend flag; RLS lives in calibration_service
  const [numReferenceGauges, setNumReferenceGauges] = useState(1);
  const [singleRefPsi, setSingleRefPsi] = useState('');
  const [selectedBoardId, setSelectedBoardId] = useState<number | 'all'>('all');

  // Gauge → PT channel mapping (when multiple gauges): gauge index 1..N → channel ids
  const [gaugeToChannels, setGaugeToChannels] = useState<Record<number, number[]>>({ 1: [1] });
  const [gaugeRefs, setGaugeRefs] = useState<Record<number, string>>({});
  const [lcChannels, setLcChannels] = useState<{ calEntity: string; label: string }[]>([]);
  const setLoadCellZeroOffset = useSensorStore((s) => s.setLoadCellZeroOffset);

  const availableBoards = Array.from(new Set(ptChannels.map((c) => c.boardId))).sort((a, b) => a - b);
  const visibleChannels = ptChannels.filter((c) => selectedBoardId === 'all' || c.boardId === selectedBoardId);

  // Default mapping when number of gauges changes: Gauge 1→[1], Gauge 2→[2], ...
  useEffect(() => {
    const n = numReferenceGauges;
    setGaugeToChannels((prev) => {
      const next = { ...prev };
      for (let g = 1; g <= n; g++) {
        if (!next[g]?.length) next[g] = [g];
      }
      return next;
    });
  }, [numReferenceGauges]);

  useEffect(() => {
    fetch(`${getApiBaseUrl()}/api/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { config?: { boards?: Record<string, { type?: string; enabled?: boolean; active_connectors?: number[]; num_sensors?: number }> } } | null) => {
        const boards = data?.config?.boards;
        if (!boards) return;
        const chs: number[] = [];
        for (const board of Object.values(boards)) {
          if (board?.type !== 'LC' || board.enabled === false) continue;
          const active = Array.isArray(board.active_connectors) && board.active_connectors.length > 0
            ? board.active_connectors
            : Array.from({ length: board.num_sensors ?? 10 }, (_, i) => i + 1);
          chs.push(...active);
        }
        setLcChannels(chs.map((ch) => ({ calEntity: `LC_Cal.CH${ch}`, label: `LC Ch${ch}` })));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const u2 = ws.on(MessageType.CALIBRATION_STATUS, (p: unknown) => {
      const payload = p as CalibrationStatusPayload;
      setCalStatus(payload);
      setLastUpdate(new Date(payload.timestamp ?? Date.now()));
      setPhase2Active(payload.phase2Enabled);
      if (payload.calibrationFilePath != null) setCalFilePath(payload.calibrationFilePath);
    });
    const u3 = ws.on(MessageType.ERROR, (p: unknown) => {
      const payload = p as { message?: string };
      const msg = payload?.message ?? 'Unknown error';
      console.error('[Calibration] Backend error:', msg);
      alert(`❌ Calibration: ${msg}`);
    });
    return () => { u2(); u3(); };
  }, [ws]);

  // Poll calibration status (backend no longer syncs every 2s)
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/api/calibration_status`);
        if (!res.ok) return;
        const data = await res.json();
        if (data && !data.error) {
          setCalStatus(data as CalibrationStatusPayload);
          setLastUpdate(new Date(data.timestamp ?? Date.now()));
          setPhase2Active(data.phase2Enabled);
          if (data.calibrationFilePath != null) setCalFilePath(data.calibrationFilePath);
        }
      } catch (_) { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, []);

  const sendCalCmd = useCallback((cmd: CalibrationCommand) => {
    ws.send({ type: MessageType.CALIBRATION_COMMAND, timestamp: Date.now(), payload: cmd });
  }, [ws]);

  const handleCapture = useCallback((sensorId: number, boardId: number, referencePressure: number) => {
    sendCalCmd({ commandType: 'capture_reference', sensorId, boardId, referencePressure });
  }, [sendCalCmd]);

  const handleZeroAll = useCallback(() => {
    sendCalCmd({ commandType: 'zero_all' });
  }, [sendCalCmd]);

  const handleClearCalibration = useCallback(() => {
    if (typeof window !== 'undefined' && !window.confirm('Clear all calibration and start from scratch?')) return;
    sendCalCmd({ commandType: 'clear_calibration' });
  }, [sendCalCmd]);

  const handleCaptureAll = useCallback(() => {
    const psi = parseFloat(singleRefPsi);
    if (isNaN(psi)) return;
    for (const ch of visibleChannels) {
      if (!ch.inCalibrationSequence) continue;
      sendCalCmd({ commandType: 'capture_reference', sensorId: ch.id, boardId: ch.boardId, referencePressure: psi });
    }
    setSingleRefPsi('');
  }, [sendCalCmd, singleRefPsi, visibleChannels]);

  const toggleGaugeChannel = useCallback((gauge: number, uniqueId: number) => {
    setGaugeToChannels((prev) => {
      const list = prev[gauge] ?? [];
      const next = list.includes(uniqueId) ? list.filter((c) => c !== uniqueId) : [...list, uniqueId].sort((a, b) => a - b);
      return { ...prev, [gauge]: next };
    });
  }, []);

  const handleCaptureByGauges = useCallback(() => {
    for (let g = 1; g <= numReferenceGauges; g++) {
      const refStr = gaugeRefs[g];
      const ref = parseFloat(refStr ?? '');
      if (isNaN(ref)) continue;
      const uniqueIds = gaugeToChannels[g] ?? [];
      for (const uid of uniqueIds) {
        // Find by unique board*100 + channel
        const ch = ptChannels.find(c => (c.boardId * 100 + c.id) === uid);
        if (ch) {
          sendCalCmd({ commandType: 'capture_reference', sensorId: ch.id, boardId: ch.boardId, referencePressure: ref });
        }
      }
    }
    setGaugeRefs({});
  }, [sendCalCmd, numReferenceGauges, gaugeToChannels, gaugeRefs, ptChannels]);

  const handleSave = useCallback(() => {
    sendCalCmd({ commandType: 'save_coefficients' });
  }, [sendCalCmd]);

  const statusMap = new Map<number, CalibrationChannelStatus>(
    (calStatus?.channels ?? []).map((c) => [c.sensorId, c])
  );

  const getStatus = (channelId: number, boardId: number) => {
    return statusMap.get(boardId * 100 + channelId);
  };

  const driftCount = (calStatus?.channels ?? []).filter(c => c.driftDetected).length;
  const totalRls = (calStatus?.channels ?? []).reduce((s, c) => s + (c.rlsUpdateCount ?? 0), 0);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden">

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-card">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold tracking-tight">Robust Calibration</h1>
          <span className="text-xs text-gray-400 font-semibold bg-gray-800 px-2 py-0.5 rounded uppercase tracking-wider">
            Single Pipeline
          </span>
          <span className="text-xs text-gray-500 font-mono">
            {calStatus ? `${(calStatus.channels ?? []).length} ch` : '—'}
            {' · '}
            {totalRls} RLS
            {driftCount > 0 && <span className="text-red-400 ml-1">· {driftCount} drift</span>}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-gray-500 mr-1">Board:</span>
          <select
            value={selectedBoardId}
            onChange={(e) => setSelectedBoardId(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-text mr-4"
          >
            <option value="all">All</option>
            {availableBoards.map((bId) => (
              <option key={bId} value={bId}>Board {bId}</option>
            ))}
          </select>

          <span className="text-[10px] text-gray-500 mr-1">Ref gauges:</span>
          <select
            value={numReferenceGauges}
            onChange={(e) => setNumReferenceGauges(Number(e.target.value))}
            className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-text"
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          {numReferenceGauges === 1 && (
            <>
              <input
                type="number"
                step="any"
                placeholder="Ref PSI (all ch)"
                value={singleRefPsi}
                onChange={(e) => setSingleRefPsi(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCaptureAll()}
                className="w-24 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-text"
              />
              <button
                onClick={handleCaptureAll}
                disabled={!singleRefPsi}
                className="px-2 py-1 text-[10px] font-bold rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white"
              >
                CAPTURE ALL
              </button>
            </>
          )}
          <button
            onClick={handleZeroAll}
            className="px-3 py-1.5 text-xs font-bold rounded border transition-all
                       bg-yellow-900/40 border-yellow-600 text-yellow-300 hover:bg-yellow-800/60"
          >
            ZERO ALL
          </button>
          <button
            onClick={handleClearCalibration}
            className="px-3 py-1.5 text-xs font-bold rounded border border-red-700 bg-red-900/30 text-red-300 hover:bg-red-800/50"
          >
            CLEAR
          </button>
          <span
            className="px-3 py-1.5 text-xs font-bold rounded border bg-green-900/30 border-green-700 text-green-400 cursor-default"
            title="Recursive calibration runs in calibration_service (FSW). This UI only sends commands and shows Elodin data."
          >
            FSW {phase2Active ? 'active' : 'idle'}
          </span>
          <button
            onClick={handleSave}
            className="px-3 py-1.5 text-xs font-bold rounded border bg-blue-900/30
                       border-blue-700 text-blue-400 hover:bg-blue-800/50 transition-all"
          >
            SAVE
          </button>
          <span className="text-[10px] text-gray-600 font-mono ml-1">
            {lastUpdate ? lastUpdate.toLocaleTimeString() : '—'}
          </span>
        </div>
      </div>

      {/* ── Instruction strip (only if never zeroed) ────────────────── */}
      {(!calStatus || (calStatus.channels ?? []).every(c => c.rlsUpdateCount === 0)) && (
        <div className="flex-shrink-0 bg-blue-950/20 border-b border-blue-800/30 px-4 py-2 text-xs text-blue-300">
          <strong>Quick start:</strong> With all PTs at atmospheric (0 PSI), click{' '}
          <span className="font-mono bg-blue-900/40 px-1 rounded">ZERO ALL</span> to initialize.
          Then provide known reference pressures via CAPTURE to build the calibration curve.
          Robust Calibration auto-refines in the background.
        </div>
      )}

      {/* ── Calibration file path strip ──────────────────────────────── */}
      {calFilePath && (
        <div className="flex-shrink-0 border-b border-gray-800 px-4 py-1.5 flex items-center gap-2">
          <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Cal file</span>
          <span
            className="text-[10px] font-mono text-gray-400 truncate"
            title={calFilePath}
          >
            {calFilePath}
          </span>
        </div>
      )}

      {/* ── Load cells: 0-point offset (display = raw − offset) ───────── */}
      {lcChannels.length > 0 && (
        <div className="flex-shrink-0 border-b border-gray-700 bg-gray-900/50 px-4 py-3">
          <div className="text-xs font-bold text-gray-400 mb-2">Load cells — 0 point (offset only)</div>
          <div className="flex flex-wrap items-center gap-3">
            {lcChannels.map(({ calEntity, label }) => (
              <LoadCellZeroCard
                key={calEntity}
                calEntity={calEntity}
                label={label}
                getSensorValue={getSensorValue}
                onZero={() => {
                  const raw = getSensorValue(calEntity, 'force_lbf');
                  if (raw != null && Number.isFinite(raw)) setLoadCellZeroOffset(calEntity, raw);
                }}
              />
            ))}
            <button
              type="button"
              onClick={() => {
                lcChannels.forEach(({ calEntity }) => {
                  const raw = getSensorValue(calEntity, 'force_lbf');
                  if (raw != null && Number.isFinite(raw)) setLoadCellZeroOffset(calEntity, raw);
                });
              }}
              className="px-3 py-1.5 text-xs font-bold rounded border border-amber-600 bg-amber-900/30 text-amber-300 hover:bg-amber-800/50"
            >
              Zero all LCs
            </button>
          </div>
        </div>
      )}

      {/* ── Gauge → PT mapping (when multiple gauges) ────────────────── */}
      {numReferenceGauges > 1 && (
        <div className="flex-shrink-0 border-b border-gray-700 bg-gray-900/50 px-4 py-3">
          <div className="text-xs font-bold text-gray-400 mb-2">Map each reference gauge to PT channels, then enter ref (PSI) and capture</div>
          <div className="flex flex-wrap items-center gap-4">
            {Array.from({ length: numReferenceGauges }, (_, i) => i + 1).map((g) => (
              <div key={g} className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-bold text-gray-500 w-14">Gauge {g}:</span>
                <div className="flex items-center gap-0.5">
                  {visibleChannels.filter((c) => c.inCalibrationSequence).map((c) => {
                    const uid = c.boardId * 100 + c.id;
                    return (
                      <label key={uid} className="flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={(gaugeToChannels[g] ?? []).includes(uid)}
                          onChange={() => toggleGaugeChannel(g, uid)}
                          className="sr-only peer"
                        />
                        <span className="px-1.5 py-0.5 text-[9px] font-mono rounded border border-gray-600 peer-checked:bg-blue-700 peer-checked:border-blue-500 text-gray-400 peer-checked:text-white" title={`Board ${c.boardId}`}>
                          {c.id}<sup>{c.boardId}</sup>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <input
                  type="number"
                  step="any"
                  placeholder="Ref PSI"
                  value={gaugeRefs[g] ?? ''}
                  onChange={(e) => setGaugeRefs((prev) => ({ ...prev, [g]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && handleCaptureByGauges()}
                  className="w-20 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs font-mono text-text"
                />
              </div>
            ))}
            <button
              onClick={handleCaptureByGauges}
              className="px-3 py-1.5 text-xs font-bold rounded bg-blue-700 hover:bg-blue-600 text-white"
            >
              CAPTURE ALL GAUGES
            </button>
          </div>
        </div>
      )}

      {/* ── Channel grid — 5 columns × 2 rows ──────────────────────── */}
      <div className="flex-1 overflow-auto min-h-0 p-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 h-full auto-rows-fr">
          {visibleChannels.map((ch) => (
            <ChannelCard
              key={`${ch.boardId}-${ch.id}`}
              ch={ch}
              status={getStatus(ch.id, ch.boardId)}
              rawAdc={getSensorValue(ch.calEntity, 'raw_adc_counts')}
              calPsi={getSensorValue(ch.calEntity, 'pressure_psi')}
              onCapture={handleCapture}
            />
          ))}
        </div>
      </div>
    </main>
  );
}
