'use client'

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSensorStore, useGetSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import {
  MessageType,
  SensorUpdate,
  CalibrationChannelStatus,
  CalibrationStatusPayload,
  CalibrationCommand,
  CalibrationConfidence,
} from '@/lib/types';

// ── Channel metadata (matches config.toml sensor_roles + PT_NAMES) ───────────
const PT_CHANNELS: { id: number; role: string; entity: string }[] = [
  { id: 1,  role: 'Fuel Upstream',   entity: 'PT.Fuel_Upstream'   },
  { id: 2,  role: 'GSE Low',         entity: 'PT.GSE_Low'          },
  { id: 3,  role: 'GSE Mid',         entity: 'PT.GSE_Mid'          },
  { id: 4,  role: 'Fuel Downstream', entity: 'PT.Fuel_Downstream'  },
  { id: 5,  role: 'Ox Upstream',     entity: 'PT.Ox_Upstream'      },
  { id: 6,  role: 'GN2 Regulated',   entity: 'PT.GN2_Regulated'    },
  { id: 7,  role: 'Ox Downstream',   entity: 'PT.Ox_Downstream'    },
  { id: 8,  role: 'PT CH 8',         entity: 'PT.PT_CH8'           },
  { id: 9,  role: 'PT CH 9',         entity: 'PT.PT_CH9'           },
  { id: 10, role: 'PT CH 10',        entity: 'PT.PT_CH10'          },
];

// ── Colour + label helpers ────────────────────────────────────────────────────
const CONFIDENCE_STYLE: Record<CalibrationConfidence, { bg: string; text: string; border: string }> = {
  MAXIMUM:     { bg: 'bg-green-900/40',  text: 'text-green-300',  border: 'border-green-700'  },
  HIGH:        { bg: 'bg-blue-900/40',   text: 'text-blue-300',   border: 'border-blue-700'   },
  MEDIUM:      { bg: 'bg-yellow-900/40', text: 'text-yellow-300', border: 'border-yellow-700' },
  LOW:         { bg: 'bg-orange-900/40', text: 'text-orange-300', border: 'border-orange-700' },
  UNCALIBRATED:{ bg: 'bg-gray-800/60',   text: 'text-gray-400',   border: 'border-gray-700'   },
};

function ConfidenceBadge({ level }: { level: CalibrationConfidence }) {
  const s = CONFIDENCE_STYLE[level];
  return (
    <span className={`text-xs font-bold px-2 py-0.5 rounded border ${s.bg} ${s.text} ${s.border}`}>
      {level}
    </span>
  );
}

function CoeffRow({ label, value }: { label: string; value: number }) {
  const formatted = value === 0 ? '0' : value.toExponential(4);
  return (
    <div className="flex justify-between text-xs font-mono">
      <span className="text-text-muted">{label}</span>
      <span className="text-text">{formatted}</span>
    </div>
  );
}

// ── Mini residual trend bar (last 100 residuals normalised 0-100) ─────────────
function GlrBar({ glr, threshold = 3 }: { glr: number; threshold?: number }) {
  const pct = Math.min((glr / (threshold * 2)) * 100, 100);
  const color = glr > threshold ? '#EF4444' : glr > threshold * 0.7 ? '#F59E0B' : '#22C55E';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-xs font-mono w-10 text-right" style={{ color }}>
        {glr.toFixed(2)}
      </span>
    </div>
  );
}

// ── Single channel card ───────────────────────────────────────────────────────
interface ChannelCardProps {
  ch:    typeof PT_CHANNELS[number];
  status?: CalibrationChannelStatus;
  rawAdc?: number | null;
  onCapture: (sensorId: number, refPsi: number) => void;
  onReset:   (sensorId: number) => void;
}

function ChannelCard({ ch, status, rawAdc, onCapture, onReset }: ChannelCardProps) {
  const [refInput, setRefInput] = useState('');
  const conf = status?.confidence ?? 'UNCALIBRATED';
  const styles = CONFIDENCE_STYLE[conf];
  const isDrift = status?.driftDetected ?? false;

  const handleCapture = () => {
    const psi = parseFloat(refInput);
    if (isNaN(psi)) return;
    onCapture(ch.id, psi);
    setRefInput('');
  };

  return (
    <div
      className={`rounded-lg border p-3 flex flex-col gap-2 transition-all
        ${isDrift ? 'border-red-600 shadow-[0_0_12px_rgba(239,68,68,0.25)]' : styles.border}
        bg-card`}
    >
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs font-bold text-text-muted">CH {ch.id}</span>
          <span className="text-sm font-semibold text-text ml-2">{ch.role}</span>
        </div>
        <div className="flex items-center gap-2">
          {isDrift && (
            <span className="text-xs font-bold text-red-400 animate-pulse">⚠ DRIFT</span>
          )}
          <ConfidenceBadge level={conf} />
        </div>
      </div>

      {/* ── Live ADC reading ── */}
      <div className="flex items-center gap-3 bg-gray-900/50 rounded px-2 py-1">
        <span className="text-xs text-text-muted">RAW ADC</span>
        <span className="text-sm font-mono text-text flex-1 text-right">
          {rawAdc !== null && rawAdc !== undefined ? rawAdc.toLocaleString() : '---'}
        </span>
      </div>

      {/* ── Coefficients ── */}
      {status ? (
        <div className="bg-gray-900/40 rounded px-2 py-1.5 space-y-0.5">
          <CoeffRow label="A (x³)" value={status.coeffs.A} />
          <CoeffRow label="B (x²)" value={status.coeffs.B} />
          <CoeffRow label="C (x)"  value={status.coeffs.C} />
          <CoeffRow label="D"      value={status.coeffs.D} />
        </div>
      ) : (
        <div className="bg-gray-900/40 rounded px-2 py-1.5 text-xs text-text-muted italic">
          No calibration loaded
        </div>
      )}

      {/* ── RLS + GLR stats ── */}
      {status && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-text-muted">RLS Updates</span>
            <span className="font-mono text-text">{status.updateCount.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-text-muted">Mean Residual</span>
            <span className="font-mono text-text">{status.meanResidual.toFixed(3)} PSI</span>
          </div>
          <div className="text-xs text-text-muted mb-0.5">GLR Stat (drift detector)</div>
          <GlrBar glr={status.glrStat} />
        </div>
      )}

      {/* ── Phase 1: capture reference point ── */}
      <div className="flex gap-1 mt-auto pt-1 border-t border-gray-800">
        <input
          type="number"
          placeholder="Ref PSI"
          value={refInput}
          onChange={(e) => setRefInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCapture()}
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono
                     text-text placeholder-gray-600 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={handleCapture}
          disabled={!refInput}
          className="px-2 py-1 text-xs font-bold rounded bg-blue-700 hover:bg-blue-600
                     disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          CAPTURE
        </button>
        <button
          onClick={() => onReset(ch.id)}
          className="px-2 py-1 text-xs font-bold rounded bg-gray-700 hover:bg-gray-600
                     transition-colors text-orange-300"
        >
          RST
        </button>
      </div>
    </div>
  );
}

// ── Main calibration page ─────────────────────────────────────────────────────
export default function CalibrationPage() {
  const updateSensor   = useSensorStore((s) => s.updateSensor);
  const getSensorValue = useGetSensorValue();
  const ws = getWebSocketClient();

  const [calStatus, setCalStatus]     = useState<CalibrationStatusPayload | null>(null);
  const [lastUpdate, setLastUpdate]   = useState<Date | null>(null);
  const [phase2Active, setPhase2Active] = useState(true);
  const phase2ActiveRef = useRef(phase2Active);
  phase2ActiveRef.current = phase2Active;

  // ── WebSocket subscriptions ────────────────────────────────────────────────
  useEffect(() => {
    ws.connect();
    const u1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const u2 = ws.on(MessageType.CALIBRATION_STATUS, (p: unknown) => {
      const payload = p as CalibrationStatusPayload;
      setCalStatus(payload);
      setLastUpdate(new Date(payload.timestamp));
      setPhase2Active(payload.phase2Enabled);
    });
    return () => { u1(); u2(); };
  }, [ws, updateSensor]);

  // ── Commands ───────────────────────────────────────────────────────────────
  const sendCalCmd = useCallback((cmd: CalibrationCommand) => {
    ws.send({ type: MessageType.CALIBRATION_COMMAND, timestamp: Date.now(), payload: cmd });
  }, [ws]);

  const handleCapture = useCallback((sensorId: number, referencePressure: number) => {
    sendCalCmd({ commandType: 'capture_reference', sensorId, referencePressure });
  }, [sendCalCmd]);

  const handleReset = useCallback((sensorId: number) => {
    sendCalCmd({ commandType: 'reset_channel', sensorId });
  }, [sendCalCmd]);

  const togglePhase2 = useCallback(() => {
    sendCalCmd({ commandType: phase2ActiveRef.current ? 'disable_phase2' : 'enable_phase2' });
  }, [sendCalCmd]);

  const handleSave = useCallback(() => {
    sendCalCmd({ commandType: 'save_coefficients' });
  }, [sendCalCmd]);

  // ── Build lookup from channelId → CalibrationChannelStatus ────────────────
  const statusMap = new Map<number, CalibrationChannelStatus>(
    (calStatus?.channels ?? []).map((c) => [c.sensorId, c])
  );

  // ── Summary stats ─────────────────────────────────────────────────────────
  const driftCount   = (calStatus?.channels ?? []).filter((c) => c.driftDetected).length;
  const maxConf      = (calStatus?.channels ?? []).filter((c) => c.confidence === 'MAXIMUM').length;
  const uncalibrated = PT_CHANNELS.filter((c) => !statusMap.has(c.id)).length;
  const totalUpdates = (calStatus?.channels ?? []).reduce((s, c) => s + c.updateCount, 0);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-3">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Autonomous Calibration Engine</h1>
          <p className="text-xs text-text-muted mt-0.5">
            Phase 1 (human-in-loop TLS/Bayesian) · Phase 2 (RLS + GLR drift · auto-recal)
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Phase 2 toggle */}
          <button
            onClick={togglePhase2}
            className={`px-4 py-1.5 text-xs font-bold rounded border transition-all
              ${phase2Active
                ? 'bg-green-900/40 border-green-700 text-green-300 hover:bg-green-800/60'
                : 'bg-gray-800 border-gray-600 text-gray-400 hover:bg-gray-700'
              }`}
          >
            Phase 2: {phase2Active ? 'ACTIVE' : 'PAUSED'}
          </button>

          {/* Save */}
          <button
            onClick={handleSave}
            className="px-4 py-1.5 text-xs font-bold rounded border bg-blue-900/40
                       border-blue-700 text-blue-300 hover:bg-blue-800/60 transition-all"
          >
            Save Coefficients
          </button>

          {/* Last update */}
          <span className="text-xs text-text-muted font-mono">
            {lastUpdate ? `↻ ${lastUpdate.toLocaleTimeString()}` : 'Waiting…'}
          </span>
        </div>
      </div>

      {/* ── System summary strip ───────────────────────────────────────── */}
      <div className="flex-shrink-0 grid grid-cols-4 gap-3">
        {[
          { label: 'Channels Loaded',   value: calStatus?.channels.length ?? 0, color: 'text-blue-400'   },
          { label: 'MAXIMUM Confidence',value: maxConf,                          color: 'text-green-400'  },
          { label: 'Drift Detected',    value: driftCount,                       color: driftCount > 0 ? 'text-red-400' : 'text-green-400' },
          { label: 'Total RLS Updates', value: totalUpdates.toLocaleString(),    color: 'text-text'       },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-card rounded-lg border border-gray-800 px-4 py-3 text-center">
            <div className={`text-2xl font-bold font-mono ${color}`}>{value}</div>
            <div className="text-xs text-text-muted mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* ── Framework description banner ──────────────────────────────── */}
      <div className="flex-shrink-0 bg-card border border-gray-800 rounded-lg px-4 py-2 flex flex-wrap gap-4 text-xs text-text-muted">
        {[
          '📐 Env-robust basis φ(v,e) [Eq 66-72]',
          '📏 Total Least Squares [Eq 112-118]',
          '🧮 Bayesian regression + hierarchical priors [Eq 126-149]',
          '🔄 RLS forgetting factor λ=0.995 [Eq 162-166]',
          '⚡ GLR drift detection [Eq 235-248]',
          '🧠 Empirical Bayes pop-prior evolution',
          '🎯 Active learning — recal on quality drop',
          '↗ Transfer learning across sessions',
        ].map((t) => (
          <span key={t} className="font-mono">{t}</span>
        ))}
      </div>

      {/* ── Phase 1 guidance ──────────────────────────────────────────── */}
      <div className="flex-shrink-0 bg-blue-950/30 border border-blue-800/50 rounded-lg px-4 py-2 text-xs text-blue-300">
        <span className="font-bold">Phase 1  — human-in-loop calibration: </span>
        Apply a known reference pressure to each channel, enter the PSI value in the{' '}
        <span className="font-mono bg-blue-900/40 px-1 rounded">Ref PSI</span> field and hit{' '}
        <span className="font-mono bg-blue-900/40 px-1 rounded">CAPTURE</span>.
        The backend captures the current raw ADC and runs an RLS update immediately.
        Repeat across the operating range; Phase 2 takes over autonomously once the
        GLR statistic stabilises below the drift threshold.
      </div>

      {/* ── Channel grid ──────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto min-h-0">
        {uncalibrated === PT_CHANNELS.length && !calStatus ? (
          /* No calibration file found */
          <div className="h-full flex flex-col items-center justify-center gap-4 text-center">
            <div className="text-5xl">📐</div>
            <div className="text-xl font-bold text-text-muted">No calibration data loaded</div>
            <div className="text-sm text-gray-500 max-w-md">
              The Phase 2 engine needs an initial calibration file.  Run
              <code className="mx-1 px-1 bg-gray-800 rounded text-blue-300">
                python3 scripts/calibration/calibration_orchestrator.py
              </code>
              to perform Phase 1 calibration, then the engine will initialise automatically.
            </div>
            <div className="mt-2 text-xs text-gray-600">
              You can also capture reference points below once data is flowing.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {PT_CHANNELS.map((ch) => (
              <ChannelCard
                key={ch.id}
                ch={ch}
                status={statusMap.get(ch.id)}
                rawAdc={getSensorValue(ch.entity, 'raw_adc_counts')}
                onCapture={handleCapture}
                onReset={handleReset}
              />
            ))}
          </div>
        )}
      </div>

    </main>
  );
}
