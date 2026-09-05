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
  cubic: 'text-sky-300 border-sky-600/60 bg-sky-900/40',
  robust: 'text-violet-300 border-violet-600/60 bg-violet-900/40',
  physics: 'text-orange-300 border-orange-600/60 bg-orange-900/40',
};
const MODEL_DESC: Record<Model, string> = {
  cubic: 'Cubic fit from captured points.',
  robust: 'Adaptive fit; learns from points, corrects drift.',
  physics: 'Datasheet conversion (ratiometric / 4-20 mA).',
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
    <div className="flex items-center gap-2 rounded-lg border border-gray-700 bg-black/20 px-3 py-2">
      <span className="text-xs font-bold text-text-muted w-16 truncate">{label}</span>
      <span className="text-sm font-mono text-green-400 tabular-nums flex-1 text-right">{display} kg</span>
      <button type="button" onClick={onZero}
        className="px-2.5 py-1 text-xs font-bold rounded-md border border-amber-600 bg-amber-900/30 text-amber-300 hover:bg-amber-800/50">
        Zero
      </button>
    </div>
  );
}

// ── Sidebar sensor row ──────────────────────────────────────────────────────────
interface SensorRowProps {
  ch: SensorConfig;
  model: Model;
  status?: CalibrationChannelStatus;
  calPsi?: number | null;
  numPoints: number;
  selected: boolean;
  onSelect: () => void;
}
function SensorRow({ ch, model, status, calPsi, numPoints, selected, onSelect }: SensorRowProps) {
  const isDrift = status?.driftDetected ?? false;
  const detail = model === 'physics'
    ? 'datasheet'
    : model === 'robust'
      ? (status?.rlsUpdateCount ? `RLS ${status.rlsUpdateCount}` : 'no data yet')
      : (numPoints > 0 ? `${numPoints} point${numPoints === 1 ? '' : 's'}` : 'uncalibrated');
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-4 py-3.5 flex items-center gap-3 border-l-[3px] transition-colors
        ${selected
          ? 'bg-blue-950/40 border-l-blue-500'
          : 'border-l-transparent hover:bg-white/5'}`}
    >
      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isDrift ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.8)]' : 'bg-gray-600'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-text-muted flex-shrink-0">CH{ch.id}</span>
          <span className={`text-base font-semibold truncate ${selected ? 'text-text' : 'text-gray-200'}`}>{ch.role || `Channel ${ch.id}`}</span>
        </div>
        <div className="text-sm font-mono text-text-muted mt-1">B{ch.boardId} · {detail}</div>
      </div>
      <div className="flex flex-col items-end flex-shrink-0 gap-1.5">
        <span className="text-xl font-mono font-bold tabular-nums text-green-400 leading-none">{fmtPsi(calPsi)}</span>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase ${MODEL_BADGE[model]}`}>{model}</span>
      </div>
    </button>
  );
}

// ── Detail readout stat tile ────────────────────────────────────────────────────
function Stat({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-xl border border-gray-700 bg-card px-4 py-3">
      <div className="text-xs font-bold text-text-muted uppercase tracking-wide">{label}</div>
      <div className={`font-mono font-bold tabular-nums leading-tight mt-1 ${className}`}>{value}</div>
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
  const [selectedBoardId, setSelectedBoardId] = useState<number | 'all'>('all');
  const [cubicState, setCubicState] = useState<Record<string, CubicCalibrationChannel>>({});
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [overlay, setOverlay] = useState<{ cubic: boolean; robust: boolean; physics: boolean }>({ cubic: true, robust: true, physics: true });
  const [refInput, setRefInput] = useState('');
  const [showLoadCells, setShowLoadCells] = useState(false);

  // Draggable sidebar width (persisted). Clamped so it can't swallow the detail panel or vanish.
  const SIDEBAR_MIN = 240, SIDEBAR_MAX = 640;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 320;
    const saved = Number(window.localStorage.getItem('calibration.sidebarWidth'));
    return Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : 320;
  });
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + (ev.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setSidebarWidth((w) => { try { window.localStorage.setItem('calibration.sidebarWidth', String(w)); } catch { /* ignore */ } return w; });
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

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
  const visibleChannels = useMemo(
    () => ptChannels.filter((c) => selectedBoardId === 'all' || c.boardId === selectedBoardId),
    [ptChannels, selectedBoardId],
  );
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

  const handleCaptureSelected = useCallback(() => {
    if (!selectedChannel || selectedModel === 'physics') return;
    const psi = parseFloat(refInput);
    if (isNaN(psi)) return;
    sendCalCmd({ commandType: 'capture_point', sensorId: selectedChannel.id, boardId: selectedChannel.boardId, referencePressure: psi });
    setRefInput('');
  }, [selectedChannel, selectedModel, refInput, sendCalCmd]);

  const handleNewCalibration = useCallback(() => {
    if (!selectedChannel) return;
    if (typeof window !== 'undefined' && !window.confirm(`Clear the calibration for ${selectedChannel.role || 'CH' + selectedChannel.id}? Drops its captured points and resets both cubic and robust to nothing (0).`)) return;
    sendCalCmd({ commandType: 'new_calibration', sensorId: selectedChannel.id, boardId: selectedChannel.boardId });
  }, [selectedChannel, sendCalCmd]);

  const handleZeroAll = useCallback(() => {
    const n = ptChannels.filter((c) => modelOf(c.boardId * 100 + c.id) !== 'physics').length;
    if (typeof window !== 'undefined' && !window.confirm(`Capture a 0 psi reference point on all ${n} cubic/robust PT sensor${n === 1 ? '' : 's'}? Vent them to atmosphere first — this adds a real point to each sensor's shared fit.`)) return;
    sendCalCmd({ commandType: 'zero_all' });
  }, [sendCalCmd, ptChannels, modelOf]);

  const statusMap = new Map<number, CalibrationChannelStatus>((calStatus?.channels ?? []).map((c) => [c.sensorId, c]));
  const getStatus = (channelId: number, boardId: number) => statusMap.get(boardId * 100 + channelId);

  const counts = useMemo(() => {
    const c = { cubic: 0, robust: 0, physics: 0 };
    for (const ch of ptChannels) c[modelOf(ch.boardId * 100 + ch.id)]++;
    return c;
  }, [ptChannels, modelOf]);

  const selStatus = selectedChannel ? getStatus(selectedChannel.id, selectedChannel.boardId) : undefined;
  const selRawAdc = selectedChannel ? getSensorValue(selectedChannel.calEntity, 'raw_adc_counts') : null;
  const selPsi = selectedChannel ? getSensorValue(selectedChannel.calEntity, 'pressure_psi') : null;
  const selPoints = selectedState?.numPoints ?? 0;
  const selPhysics = selectedUid != null ? physicsParamsOf(selectedUid) : undefined;

  // Fourth stat tile is model-specific — a plain "OK" told you nothing.
  //  cubic  → whether the fit is live (needs ≥2 points)
  //  robust → drift-detector state
  //  physics→ the datasheet full-scale range it's converting against
  let healthLabel = 'Fit', healthValue = '—', healthClass = 'text-gray-300';
  if (selectedModel === 'robust') {
    healthLabel = 'Drift';
    healthValue = selStatus?.driftDetected ? 'Detected' : 'None';
    healthClass = selStatus?.driftDetected ? 'text-red-400' : 'text-green-400';
  } else if (selectedModel === 'physics') {
    healthLabel = 'Full scale';
    healthValue = selPhysics ? `${selPhysics.fullScale} psi` : '—';
    healthClass = 'text-orange-300';
  } else {
    healthLabel = 'Cubic fit';
    if (selPoints >= 2) { healthValue = 'Live'; healthClass = 'text-green-400'; }
    else if (selPoints === 1) { healthValue = 'Need ≥2 pts'; healthClass = 'text-amber-400'; }
    else { healthValue = 'None'; healthClass = 'text-gray-400'; }
  }

  return (
    <main className="h-full bg-background text-text flex overflow-hidden">
      {/* ── Sidebar: sensor list ───────────────────────────────────────────── */}
      <aside style={{ width: sidebarWidth }} className="flex-shrink-0 border-r border-gray-800 bg-black/20 flex flex-col min-h-0">
        {/* Header */}
        <div className="flex-shrink-0 px-4 py-4 border-b border-gray-800">
          <h1 className="text-2xl font-bold tracking-tight">PT Calibration</h1>
          <div className="text-base text-text-muted font-mono mt-2 flex gap-3">
            <span className="text-sky-300">{counts.cubic} cubic</span>
            <span className="text-violet-300">{counts.robust} robust</span>
            <span className="text-orange-300">{counts.physics} physics</span>
          </div>
        </div>

        {/* Board filter */}
        {availableBoards.length > 1 && (
          <div className="flex-shrink-0 px-4 py-3 border-b border-gray-800/60 flex items-center gap-2">
            <span className="text-sm text-text-muted">Board</span>
            <select
              value={selectedBoardId}
              onChange={(e) => setSelectedBoardId(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              className="flex-1 bg-background border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            >
              <option value="all" className="bg-background text-white">All boards</option>
              {availableBoards.map((bId) => (<option key={bId} value={bId} className="bg-background text-white">Board {bId}</option>))}
            </select>
          </div>
        )}

        {/* Sensor list */}
        <div className="flex-1 overflow-auto min-h-0 divide-y divide-gray-800/40">
          {ptChannels.length === 0 ? (
            <div className="text-sm text-text-muted p-4">No PT sensors configured.</div>
          ) : (
            visibleChannels.map((ch) => {
              const uid = ch.boardId * 100 + ch.id;
              return (
                <SensorRow
                  key={`${ch.boardId}-${ch.id}`}
                  ch={ch}
                  model={modelOf(uid)}
                  status={getStatus(ch.id, ch.boardId)}
                  calPsi={getSensorValue(ch.calEntity, 'pressure_psi')}
                  numPoints={cubicState[String(uid)]?.numPoints ?? 0}
                  selected={uid === selectedUid}
                  onSelect={() => setSelectedUid(uid)}
                />
              );
            })
          )}
        </div>

        {/* Global action: Zero all — captures a 0 psi reference point on every cubic/robust sensor.
            It's a real point (feeds the shared fit + persists), not a tare. */}
        {(counts.cubic + counts.robust) > 0 && (
          <div className="flex-shrink-0 px-4 py-3 border-t border-gray-800">
            <button onClick={handleZeroAll}
              title="Capture a 0 psi reference point on every cubic/robust PT sensor. Vent to atmosphere first — this adds a real point to each sensor's shared fit (physics sensors are skipped)."
              className="w-full px-4 py-2.5 text-sm font-bold rounded-lg border bg-yellow-900/30 border-yellow-600/60 text-yellow-300 hover:bg-yellow-800/50 transition-colors">
              Zero all
            </button>
          </div>
        )}

        {/* Load cells (separate concern) — collapsible */}
        {lcChannels.length > 0 && (
          <div className="flex-shrink-0 border-t border-gray-800">
            <button
              onClick={() => setShowLoadCells((v) => !v)}
              className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-bold text-text-muted hover:text-text"
            >
              <span>Load cells — 0 point ({lcChannels.length})</span>
              <span className="text-gray-600">{showLoadCells ? '▾' : '▸'}</span>
            </button>
            {showLoadCells && (
              <div className="px-3 pb-3 space-y-2 max-h-56 overflow-auto">
                <div className="text-[11px] text-gray-600 px-1">Offset only; separate from PT calibration.</div>
                {lcChannels.map(({ calEntity, label }) => (
                  <LoadCellZeroCard key={calEntity} calEntity={calEntity} label={label}
                    onZero={() => {
                      const raw = getSensorValue(calEntity, 'force_lbf');
                      if (raw != null && Number.isFinite(raw)) setLoadCellZeroOffset(calEntity, raw);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </aside>

      {/* Drag handle — widen/narrow the sidebar */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="w-1 flex-shrink-0 cursor-col-resize bg-gray-800 hover:bg-blue-500 active:bg-blue-500 transition-colors"
      />

      {/* ── Detail: everything about the selected sensor ───────────────────── */}
      <section className="flex-1 min-w-0 overflow-auto">
        {!selectedChannel || !selectedModel ? (
          <div className="h-full flex flex-col items-center justify-center text-text-muted gap-2">
            <div className="text-lg">Select a sensor to view its calibration</div>
            <div className="text-sm text-gray-600">Live pressure, captured points, and curve previews appear here.</div>
          </div>
        ) : (
          <div className="p-8 max-w-5xl mx-auto flex flex-col gap-6">
            {/* Header */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="text-3xl font-bold text-text tracking-tight">{selectedChannel.role || `Channel ${selectedChannel.id}`}</h2>
                  <span className={`text-xs font-bold px-2.5 py-1 rounded-md border uppercase ${MODEL_BADGE[selectedModel]}`}>{selectedModel}</span>
                </div>
                <div className="text-sm text-text-muted font-mono mt-1.5">
                  Board {selectedChannel.boardId} · CH{selectedChannel.id}
                  {selectedModel !== 'physics' && ` · ${selectedState?.numPoints ?? 0} captured point${(selectedState?.numPoints ?? 0) === 1 ? '' : 's'}`}
                </div>
                <div className="text-sm text-text-muted mt-1.5 max-w-2xl">
                  {MODEL_DESC[selectedModel]}
                  {selectedModel !== 'physics' && selPoints === 0 && (
                    <span className="text-amber-400/80"> Reads 0 until you capture points.</span>
                  )}
                  {' '}<span className="text-gray-600">Change the model in Config → Roles.</span>
                </div>
              </div>
              {selectedModel !== 'physics' && (
                <button onClick={handleNewCalibration}
                  className="px-5 py-2.5 text-sm font-bold rounded-lg border border-red-700 bg-red-900/30 text-red-300 hover:bg-red-800/50 transition-colors"
                  title="Drop captured points and reset both cubic and robust to nothing (0)">
                  Clear calibration
                </button>
              )}
            </div>

            {/* Live readouts */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Pressure" value={`${fmtPsi(selPsi)} psi`} className="text-3xl text-green-400" />
              <Stat label="Raw ADC" value={fmtAdc(selRawAdc)} className="text-xl text-gray-300" />
              <Stat label={selectedModel === 'robust' ? 'RLS updates' : 'Points'} value={selectedModel === 'robust' ? String(selStatus?.rlsUpdateCount ?? 0) : String(selPoints)} className="text-xl text-gray-300" />
              <Stat label={healthLabel} value={healthValue} className={`text-xl ${healthClass}`} />
            </div>

            {/* Capture — disabled in physics (points are meaningless for a datasheet conversion) */}
            <div className="rounded-xl border border-gray-700 bg-card p-5">
              <div className="text-sm font-bold text-text mb-3">Capture reference point</div>
              {selectedModel === 'physics' ? (
                <div className="text-sm text-text-muted italic">Physics conversion uses datasheet parameters — captured points don't apply.</div>
              ) : (
                <div className="flex items-center gap-3 flex-wrap">
                  <input
                    type="number" step="any" placeholder="Reference PSI"
                    value={refInput}
                    onChange={(e) => setRefInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleCaptureSelected()}
                    className="w-44 bg-black/30 border border-gray-700 rounded-lg px-4 py-2.5 text-base font-mono text-text placeholder-gray-600 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={handleCaptureSelected}
                    disabled={!refInput}
                    className="px-6 py-2.5 text-sm font-bold rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-white"
                  >
                    Capture
                  </button>
                  <span className="text-sm text-text-muted">Records the current ADC at this known pressure. Feeds both the cubic &amp; robust fits.</span>
                </div>
              )}
            </div>

            {/* Curve previews */}
            <div className="rounded-xl border border-gray-700 bg-card p-5">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
                <div className="text-sm font-bold text-text">Curve previews</div>
                <div className="flex items-center gap-4 text-sm flex-wrap">
                  {(['cubic', 'robust', 'physics'] as Model[]).map((m) => (
                    <label key={m} className="flex items-center gap-2 cursor-pointer select-none">
                      <input type="checkbox" checked={overlay[m]} onChange={(e) => setOverlay((o) => ({ ...o, [m]: e.target.checked }))} />
                      <span className="inline-block w-4 rounded" style={{ background: CURVE_COLORS[m], height: m === selectedModel ? 4 : 2 }} />
                      <span className={m === selectedModel ? 'font-bold text-text' : 'text-text-muted'}>{m}{m === selectedModel ? ' (active)' : ''}</span>
                    </label>
                  ))}
                  <span className="text-text-muted text-xs">points fade <span className="text-gray-600">older</span> → <span className="text-gray-200">newer</span></span>
                </div>
              </div>
              <CalibrationChart
                state={selectedState}
                height={340}
                activeModel={selectedModel}
                show={overlay}
                physics={physicsParamsOf(selectedUid!)}
              />
            </div>

            {/* Captured points table */}
            {selectedState?.points && selectedState.points.length > 0 && (
              <div className="rounded-xl border border-gray-700 bg-card p-5">
                <div className="text-sm font-bold text-text mb-3">Captured points</div>
                <div className="max-h-64 overflow-auto border border-gray-800 rounded-lg">
                  <table className="w-full text-sm font-mono">
                    <thead className="sticky top-0 bg-gray-900 text-text-muted">
                      <tr><th className="text-left px-4 py-2">#</th><th className="text-right px-4 py-2">Reference PSI</th><th className="text-right px-4 py-2">ADC</th></tr>
                    </thead>
                    <tbody>
                      {selectedState.points.map((p, i) => (
                        <tr key={i} className="odd:bg-white/[0.02]">
                          <td className="px-4 py-1.5 text-text-muted">{i + 1}</td>
                          <td className="px-4 py-1.5 text-right text-text">{p.psi.toFixed(2)}</td>
                          <td className="px-4 py-1.5 text-right text-gray-400">{p.adc.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
