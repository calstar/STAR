'use client'

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSensorStore, useGetSensorValue, useSensorDataVersion, useLoadCellForceLbf } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import {
  MessageType,
  CalibrationChannelStatus,
  CalibrationStatusPayload,
  CalibrationCommand,
  CubicCalibrationChannel,
} from '@/lib/types';
import { useSensorConfig, SensorConfig } from '@/lib/sensor-config';
import { getApiBaseUrl } from '@/lib/websocket';
import { CalibrationChart, PhysicsParams, CURVE_COLORS } from '@/components/calibration/CalibrationChart';

type Model = 'cubic' | 'robust' | 'physics';

// Per-model badge styling — the whole point is that a sensor's selected model reads at a glance.
const MODEL_BADGE: Record<Model, string> = {
  cubic: 'text-sky-300 border-sky-700 bg-sky-900/40',
  robust: 'text-violet-300 border-violet-700 bg-violet-900/40',
  physics: 'text-orange-300 border-orange-700 bg-orange-900/40',
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

// ── Load cell 0-point card (separate concern; kept until LC calibration gets its own home) ──────
function LoadCellZeroCard({ calEntity, label, onZero }: { calEntity: string; label: string; onZero: () => void }) {
  const forceLbf = useLoadCellForceLbf(calEntity);
  const kg = forceLbf != null && Number.isFinite(forceLbf) ? forceLbf * LBF_TO_KG : null;
  const display = kg != null ? kg.toFixed(2) : '—';
  return (
    <div className="flex items-center gap-2 rounded border border-gray-700 bg-card px-3 py-2">
      <span className="text-[10px] font-bold text-gray-500 w-16">{label}</span>
      <span className="text-sm font-mono text-green-400 tabular-nums w-14">{display} kg</span>
      <button type="button" onClick={onZero}
        className="px-2 py-1 text-[10px] font-bold rounded border border-amber-600 bg-amber-900/30 text-amber-300 hover:bg-amber-800/50">
        Zero
      </button>
    </div>
  );
}

// ── Single PT channel card ──────────────────────────────────────────────────────
interface ChannelCardProps {
  ch: SensorConfig;
  model: Model;
  status?: CalibrationChannelStatus;
  rawAdc?: number | null;
  calPsi?: number | null;
  numPoints: number;
  selected?: boolean;
  onSelect?: () => void;
  onCapture: (sensorId: number, boardId: number, refPsi: number) => void;
}

function ChannelCard({ ch, model, status, rawAdc, calPsi, numPoints, selected, onSelect, onCapture }: ChannelCardProps) {
  const [refInput, setRefInput] = useState('');
  const isPhysics = model === 'physics';
  const isDrift = status?.driftDetected ?? false;

  const handleCapture = () => {
    const psi = parseFloat(refInput);
    if (isNaN(psi)) return;
    onCapture(ch.id, ch.boardId, psi);
    setRefInput('');
  };

  return (
    <div
      onClick={onSelect}
      className={`rounded border p-2.5 flex flex-col gap-1.5 transition-all bg-card cursor-pointer
        ${selected ? 'ring-2 ring-blue-500 ' : ''}${isDrift ? 'border-red-600 shadow-[0_0_10px_rgba(239,68,68,0.2)]' : 'border-gray-800'}`}
    >
      {/* Header: CH + name + MODEL badge */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[10px] font-bold text-gray-500">CH{ch.id}</span>
          <span className="text-xs font-semibold text-text truncate">{ch.role}</span>
        </div>
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0 uppercase ${MODEL_BADGE[model]}`}>
          {model}
        </span>
      </div>

      {/* Big PSI readout */}
      <div className="bg-gray-900/60 rounded px-2 py-1.5 flex items-baseline justify-between">
        <span className="text-[10px] text-gray-500 font-bold">PSI</span>
        <span className="text-xl font-bold font-mono tabular-nums text-green-400 leading-none">{fmtPsi(calPsi)}</span>
      </div>

      {/* ADC + points/RLS */}
      <div className="flex items-center justify-between text-[10px] font-mono text-gray-500 px-0.5">
        <span>ADC {fmtAdc(rawAdc)}</span>
        <span>{model === 'robust' ? `RLS ${status?.rlsUpdateCount ?? 0}` : `${numPoints} pts`}</span>
      </div>

      {/* Capture — disabled in physics (points are meaningless for a datasheet conversion) */}
      <div className="flex gap-1 mt-auto pt-1 border-t border-gray-800/60">
        {isPhysics ? (
          <span className="text-[10px] text-gray-500 italic">Physics — no points</span>
        ) : (
          <>
            <input
              type="number" step="any" placeholder="Ref PSI" value={refInput}
              onChange={(e) => setRefInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCapture()}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs font-mono text-text placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={(e) => { e.stopPropagation(); handleCapture(); }}
              disabled={!refInput}
              className="px-2 py-1 text-[10px] font-bold rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-white"
            >
              CAPTURE
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function CalibrationPage() {
  useSensorDataVersion();
  const getSensorValue = useGetSensorValue();
  const ws = getWebSocketClient();
  const ptChannels = useSensorConfig();

  const [calStatus, setCalStatus] = useState<CalibrationStatusPayload | null>(null);
  const [singleRefPsi, setSingleRefPsi] = useState('');
  const [selectedBoardId, setSelectedBoardId] = useState<number | 'all'>('all');
  const [cubicState, setCubicState] = useState<Record<string, CubicCalibrationChannel>>({});
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [overlay, setOverlay] = useState<{ cubic: boolean; robust: boolean; physics: boolean }>({ cubic: true, robust: true, physics: true });

  // Full config (for physics params + LC list). Boards keyed by config key (e.g. "pt_board").
  const [cfgBoards, setCfgBoards] = useState<Record<string, any>>({});
  const [cfgRoot, setCfgRoot] = useState<Record<string, any>>({});
  const [lcChannels, setLcChannels] = useState<{ calEntity: string; label: string }[]>([]);
  const setLoadCellZeroOffset = useSensorStore((s) => s.setLoadCellZeroOffset);

  // Each sensor's streaming model (service truth); default by interface when the record is absent.
  const modelOf = useCallback((uid: number): Model => {
    const rec = cubicState[String(uid)];
    if (rec?.active_model) return rec.active_model as Model;
    const ch = ptChannels.find((c) => c.boardId * 100 + c.id === uid);
    return ch?.isHpPt ? 'physics' : 'cubic';
  }, [cubicState, ptChannels]);

  // board_id → { key, board } so we can resolve per-sensor physics params from config.
  const boardById = useMemo(() => {
    const m = new Map<number, { key: string; board: any }>();
    for (const [key, board] of Object.entries(cfgBoards)) {
      if (board && typeof (board as any).board_id === 'number') m.set((board as any).board_id, { key, board });
    }
    return m;
  }, [cfgBoards]);

  const physicsParamsOf = useCallback((uid: number): PhysicsParams | undefined => {
    const ch = ptChannels.find((c) => c.boardId * 100 + c.id === uid);
    if (!ch) return undefined;
    const entry = boardById.get(ch.boardId);
    if (!entry) return undefined;
    const { key, board } = entry;
    const isLoop = board.pt_type === '4-20 mA absolute' || board.hp_pt_full_scale_psi != null;
    const fsMap = cfgRoot[`calibration_full_scale_${key}`] as Record<string, number> | undefined;
    const rsMap = cfgRoot[`calibration_sense_resistor_${key}`] as Record<string, number> | undefined;
    const fullScale = (ch.role && fsMap?.[ch.role] != null) ? fsMap[ch.role] : (isLoop ? (board.hp_pt_full_scale_psi ?? 5000) : 1000);
    const senseResistor = (ch.role && rsMap?.[ch.role] != null) ? rsMap[ch.role] : (board.hp_pt_sense_resistor_ohms ?? 120);
    return { fullScale, isLoop, senseResistor, adcRefVoltage: board.adc_ref_voltage ?? 2.5 };
  }, [ptChannels, boardById, cfgRoot]);

  // Every PT sensor appears here; the model badge says which calibration each uses.
  const availableBoards = Array.from(new Set(ptChannels.map((c) => c.boardId))).sort((a, b) => a - b);
  const visibleChannels = ptChannels.filter((c) => selectedBoardId === 'all' || c.boardId === selectedBoardId);
  const selectedState = selectedUid != null ? cubicState[String(selectedUid)] : undefined;
  const selectedChannel = selectedUid != null ? ptChannels.find((c) => c.boardId * 100 + c.id === selectedUid) : undefined;
  const selectedModel = selectedUid != null ? modelOf(selectedUid) : undefined;

  // Load full config once (physics params + LC channels).
  useEffect(() => {
    fetch(`${getApiBaseUrl()}/api/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { config?: Record<string, any> } | null) => {
        const cfg = data?.config;
        if (!cfg) return;
        setCfgRoot(cfg);
        const boards = (cfg.boards ?? {}) as Record<string, any>;
        setCfgBoards(boards);
        const chs: number[] = [];
        for (const board of Object.values(boards)) {
          if ((board as any)?.type !== 'LC' || (board as any).enabled === false) continue;
          const active = Array.isArray((board as any).active_connectors) && (board as any).active_connectors.length > 0
            ? (board as any).active_connectors
            : Array.from({ length: (board as any).num_sensors ?? 10 }, (_, i) => i + 1);
          chs.push(...active);
        }
        setLcChannels(chs.map((ch) => ({ calEntity: `LC_Cal.CH${ch}`, label: `LC Ch${ch}` })));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const u2 = ws.on(MessageType.CALIBRATION_STATUS, (p: unknown) => setCalStatus(p as CalibrationStatusPayload));
    const u3 = ws.on(MessageType.ERROR, (p: unknown) => {
      const msg = (p as { message?: string })?.message ?? 'Unknown error';
      console.error('[Calibration] Backend error:', msg);
      alert(`❌ Calibration: ${msg}`);
    });
    return () => { u2(); u3(); };
  }, [ws]);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/api/calibration_status`);
        if (!res.ok) return;
        const data = await res.json();
        if (data && !data.error) setCalStatus(data as CalibrationStatusPayload);
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, []);

  const fetchCubic = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/cubic_calibration`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && typeof data.cubic_state === 'object' && data.cubic_state) {
        setCubicState(data.cubic_state as Record<string, CubicCalibrationChannel>);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchCubic();
    const id = setInterval(fetchCubic, 2000);
    return () => clearInterval(id);
  }, [fetchCubic]);

  const sendCalCmd = useCallback((cmd: CalibrationCommand) => {
    ws.send({ type: MessageType.CALIBRATION_COMMAND, timestamp: Date.now(), payload: cmd });
    setTimeout(fetchCubic, 350);
    setTimeout(fetchCubic, 900);
  }, [ws, fetchCubic]);

  const handleCapture = useCallback((sensorId: number, boardId: number, referencePressure: number) => {
    sendCalCmd({ commandType: 'capture_point', sensorId, boardId, referencePressure });
  }, [sendCalCmd]);

  const handleNewCalibration = useCallback(() => {
    if (!selectedChannel) return;
    if (typeof window !== 'undefined' && !window.confirm(`Clear the calibration for ${selectedChannel.role || 'CH' + selectedChannel.id}? Drops its captured points and resets both cubic and robust to nothing (0).`)) return;
    sendCalCmd({ commandType: 'new_calibration', sensorId: selectedChannel.id, boardId: selectedChannel.boardId });
  }, [selectedChannel, sendCalCmd]);

  const handleZeroAllRobust = useCallback(() => {
    sendCalCmd({ commandType: 'zero_all' });
  }, [sendCalCmd]);

  const handleCaptureAll = useCallback(() => {
    const psi = parseFloat(singleRefPsi);
    if (isNaN(psi)) return;
    for (const ch of visibleChannels) {
      if (modelOf(ch.boardId * 100 + ch.id) === 'physics') continue; // no points in physics
      sendCalCmd({ commandType: 'capture_point', sensorId: ch.id, boardId: ch.boardId, referencePressure: psi });
    }
    setSingleRefPsi('');
  }, [sendCalCmd, singleRefPsi, visibleChannels, modelOf]);

  const handleSave = useCallback(() => {
    sendCalCmd({ commandType: 'save_coefficients' });
  }, [sendCalCmd]);

  const statusMap = new Map<number, CalibrationChannelStatus>((calStatus?.channels ?? []).map((c) => [c.sensorId, c]));
  const getStatus = (channelId: number, boardId: number) => statusMap.get(boardId * 100 + channelId);

  const counts = useMemo(() => {
    const c = { cubic: 0, robust: 0, physics: 0 };
    for (const ch of ptChannels) c[modelOf(ch.boardId * 100 + ch.id)]++;
    return c;
  }, [ptChannels, modelOf]);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden">
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-card">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold tracking-tight">PT Calibration</h1>
          <span className="text-xs text-gray-500 font-mono">
            <span className="text-sky-300">{counts.cubic} cubic</span>{' · '}
            <span className="text-violet-300">{counts.robust} robust</span>{' · '}
            <span className="text-orange-300">{counts.physics} physics</span>
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-gray-500 mr-1">Board:</span>
          <select
            value={selectedBoardId}
            onChange={(e) => setSelectedBoardId(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-text mr-3"
          >
            <option value="all">All</option>
            {availableBoards.map((bId) => (<option key={bId} value={bId}>Board {bId}</option>))}
          </select>

          <input
            type="number" step="any" placeholder="Ref PSI (all ch)" value={singleRefPsi}
            onChange={(e) => setSingleRefPsi(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCaptureAll()}
            className="w-28 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-text"
          />
          <button onClick={handleCaptureAll} disabled={!singleRefPsi}
            className="px-2 py-1 text-[10px] font-bold rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white">
            CAPTURE ALL
          </button>
          <button onClick={handleZeroAllRobust}
            title="Tare robust sensors to read 0 at the current pressure. Cubic/physics sensors are unaffected (their zero is defined by the fit / datasheet)."
            className="px-3 py-1.5 text-xs font-bold rounded border bg-yellow-900/40 border-yellow-600 text-yellow-300 hover:bg-yellow-800/60">
            ZERO ROBUST
          </button>
          <button onClick={handleSave}
            className="px-3 py-1.5 text-xs font-bold rounded border bg-blue-900/30 border-blue-700 text-blue-400 hover:bg-blue-800/50">
            SAVE
          </button>
        </div>
      </div>

      {/* ── Load cells (separate concern) ────────────────────────────────── */}
      {lcChannels.length > 0 && (
        <div className="flex-shrink-0 border-b border-gray-700 bg-gray-900/50 px-4 py-3">
          <div className="text-xs font-bold text-gray-400 mb-2">Load cells — 0 point (offset only; separate from PT calibration)</div>
          <div className="flex flex-wrap items-center gap-3">
            {lcChannels.map(({ calEntity, label }) => (
              <LoadCellZeroCard key={calEntity} calEntity={calEntity} label={label}
                onZero={() => {
                  const raw = getSensorValue(calEntity, 'force_lbf');
                  if (raw != null && Number.isFinite(raw)) setLoadCellZeroOffset(calEntity, raw);
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── PT channel grid ──────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto min-h-0 p-3">
        {ptChannels.length === 0 ? (
          <div className="text-sm text-gray-500 p-2">No PT sensors configured.</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 auto-rows-fr">
            {visibleChannels.map((ch) => {
              const uid = ch.boardId * 100 + ch.id;
              return (
                <ChannelCard
                  key={`${ch.boardId}-${ch.id}`}
                  ch={ch}
                  model={modelOf(uid)}
                  status={getStatus(ch.id, ch.boardId)}
                  rawAdc={getSensorValue(ch.calEntity, 'raw_adc_counts')}
                  calPsi={getSensorValue(ch.calEntity, 'pressure_psi')}
                  numPoints={cubicState[String(uid)]?.numPoints ?? 0}
                  selected={uid === selectedUid}
                  onSelect={() => setSelectedUid(uid)}
                  onCapture={handleCapture}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* ── Selected sensor: model + curve previews + points ─────────────── */}
      {selectedChannel && selectedModel && (
        <div className="flex-shrink-0 border-t border-gray-800 bg-card/40 p-3 max-h-[46vh] overflow-auto">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-text">{selectedChannel.role || `CH${selectedChannel.id}`}</span>
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase ${MODEL_BADGE[selectedModel]}`}>{selectedModel}</span>
              <span className="text-[11px] text-gray-500 font-mono">
                B{selectedChannel.boardId} · CH{selectedChannel.id} · {selectedState?.numPoints ?? 0} pts
              </span>
              <span className="text-[10px] text-gray-500">· change model in Config → Roles</span>
            </div>
            <div className="flex items-center gap-2">
              {selectedModel !== 'physics' && (
                <button onClick={handleNewCalibration}
                  className="px-3 py-1.5 text-xs font-bold rounded border border-red-700 bg-red-900/30 text-red-300 hover:bg-red-800/50"
                  title="Drop captured points and reset both cubic and robust to nothing (0)">
                  CLEAR
                </button>
              )}
              <button onClick={() => setSelectedUid(null)} className="px-2 py-1.5 text-xs text-gray-400 hover:text-gray-200" title="Close">✕</button>
            </div>
          </div>

          {/* Overlay toggles / legend */}
          <div className="flex items-center gap-4 mb-2 text-[11px] flex-wrap">
            {(['cubic', 'robust', 'physics'] as Model[]).map((m) => (
              <label key={m} className="flex items-center gap-1.5 cursor-pointer select-none">
                <input type="checkbox" checked={overlay[m]} onChange={(e) => setOverlay((o) => ({ ...o, [m]: e.target.checked }))} />
                <span className="inline-block w-3 h-0.5 rounded" style={{ background: CURVE_COLORS[m], height: m === selectedModel ? 3 : 2 }} />
                <span className={m === selectedModel ? 'font-bold text-text' : 'text-gray-400'}>{m}{m === selectedModel ? ' (active)' : ''}</span>
              </label>
            ))}
            <span className="text-gray-500 ml-auto">points fade <span className="text-gray-600">older</span> → <span className="text-gray-200">newer</span></span>
          </div>

          <CalibrationChart
            state={selectedState}
            height={240}
            activeModel={selectedModel}
            show={overlay}
            physics={physicsParamsOf(selectedUid!)}
          />

          {/* Captured points table */}
          {selectedState?.points && selectedState.points.length > 0 && (
            <div className="mt-2 max-h-32 overflow-auto border border-gray-800 rounded">
              <table className="w-full text-[11px] font-mono">
                <thead className="sticky top-0 bg-gray-900 text-gray-500">
                  <tr><th className="text-left px-2 py-1">#</th><th className="text-right px-2 py-1">PSI</th><th className="text-right px-2 py-1">ADC</th></tr>
                </thead>
                <tbody>
                  {selectedState.points.map((p, i) => (
                    <tr key={i} className="odd:bg-gray-900/40">
                      <td className="px-2 py-0.5 text-gray-500">{i + 1}</td>
                      <td className="px-2 py-0.5 text-right text-text">{p.psi.toFixed(2)}</td>
                      <td className="px-2 py-0.5 text-right text-gray-400">{p.adc.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
