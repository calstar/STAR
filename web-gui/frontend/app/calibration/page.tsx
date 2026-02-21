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

// ── Channel metadata ──────────────────────────────────────────────────────────
const PT_CHANNELS: { id: number; role: string; entity: string; calEntity: string }[] = [
  { id: 1,  role: 'Fuel Upstream',   entity: 'PT.Fuel_Upstream',   calEntity: 'PT_Cal.Fuel_Upstream'  },
  { id: 2,  role: 'GSE Low',         entity: 'PT.GSE_Low',         calEntity: 'PT_Cal.GSE_Low'        },
  { id: 3,  role: 'GSE Mid',       entity: 'PT.GSE_Mid',         calEntity: 'PT_Cal.GSE_Mid'        },
  { id: 4,  role: 'Fuel Downstream', entity: 'PT.Fuel_Downstream', calEntity: 'PT_Cal.Fuel_Downstream'},
  { id: 5,  role: 'Ox Upstream',     entity: 'PT.Ox_Upstream',     calEntity: 'PT_Cal.Ox_Upstream'    },
  { id: 6,  role: 'GN2 Regulated',   entity: 'PT.GN2_Regulated',   calEntity: 'PT_Cal.GN2_Regulated'  },
  { id: 7,  role: 'Ox Downstream',   entity: 'PT.Ox_Downstream',   calEntity: 'PT_Cal.Ox_Downstream'  },
  { id: 8,  role: 'PT CH 8',         entity: 'PT.PT_CH8',          calEntity: 'PT_Cal.PT_CH8'         },
  { id: 9,  role: 'PT CH 9',         entity: 'PT.PT_CH9',          calEntity: 'PT_Cal.PT_CH9'         },
  { id: 10, role: 'PT CH 10',        entity: 'PT.PT_CH10',         calEntity: 'PT_Cal.PT_CH10'        },
];

const CONFIDENCE_COLORS: Record<CalibrationConfidence, string> = {
  MAXIMUM:      'text-green-400 border-green-700 bg-green-900/30',
  HIGH:         'text-blue-400 border-blue-700 bg-blue-900/30',
  MEDIUM:       'text-yellow-400 border-yellow-700 bg-yellow-900/30',
  LOW:          'text-orange-400 border-orange-700 bg-orange-900/30',
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

// ── Single channel card — compact and readable ─────────────────────────────────
interface ChannelCardProps {
  ch:      typeof PT_CHANNELS[number];
  status?: CalibrationChannelStatus;
  rawAdc?: number | null;
  calPsi?: number | null;
  onCapture: (sensorId: number, refPsi: number) => void;
}

function ChannelCard({ ch, status, rawAdc, calPsi, onCapture }: ChannelCardProps) {
  const [refInput, setRefInput] = useState('');
  const conf = status?.confidence ?? 'UNCALIBRATED';
  const isDrift = status?.driftDetected ?? false;

  const handleCapture = () => {
    const psi = parseFloat(refInput);
    if (isNaN(psi)) return;
    onCapture(ch.id, psi);
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

      {/* Capture input */}
      <div className="flex gap-1 mt-auto pt-1 border-t border-gray-800/60">
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
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function CalibrationPage() {
  const updateSensor   = useSensorStore((s) => s.updateSensor);
  const getSensorValue = useGetSensorValue();
  const ws = getWebSocketClient();

  const [calStatus, setCalStatus]       = useState<CalibrationStatusPayload | null>(null);
  const [lastUpdate, setLastUpdate]     = useState<Date | null>(null);
  const [phase2Active, setPhase2Active] = useState(true);
  const phase2Ref = useRef(phase2Active);
  phase2Ref.current = phase2Active;

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

  const sendCalCmd = useCallback((cmd: CalibrationCommand) => {
    ws.send({ type: MessageType.CALIBRATION_COMMAND, timestamp: Date.now(), payload: cmd });
  }, [ws]);

  const handleCapture = useCallback((sensorId: number, referencePressure: number) => {
    sendCalCmd({ commandType: 'capture_reference', sensorId, referencePressure });
  }, [sendCalCmd]);

  const handleZeroAll = useCallback(() => {
    sendCalCmd({ commandType: 'zero_all' });
  }, [sendCalCmd]);

  const togglePhase2 = useCallback(() => {
    sendCalCmd({ commandType: phase2Ref.current ? 'disable_phase2' : 'enable_phase2' });
  }, [sendCalCmd]);

  const handleSave = useCallback(() => {
    sendCalCmd({ commandType: 'save_coefficients' });
  }, [sendCalCmd]);

  const statusMap = new Map<number, CalibrationChannelStatus>(
    (calStatus?.channels ?? []).map((c) => [c.sensorId, c])
  );

  const driftCount   = (calStatus?.channels ?? []).filter(c => c.driftDetected).length;
  const totalRls     = (calStatus?.channels ?? []).reduce((s, c) => s + (c.rlsUpdateCount ?? 0), 0);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden">

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-card">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold tracking-tight">Calibration</h1>
          <span className="text-xs text-gray-500 font-mono">
            {calStatus ? `${calStatus.channels.length} ch` : '—'}
            {' · '}
            {totalRls} RLS
            {driftCount > 0 && <span className="text-red-400 ml-1">· {driftCount} drift</span>}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleZeroAll}
            className="px-3 py-1.5 text-xs font-bold rounded border transition-all
                       bg-yellow-900/40 border-yellow-600 text-yellow-300 hover:bg-yellow-800/60"
          >
            ZERO ALL
          </button>
          <button
            onClick={togglePhase2}
            className={`px-3 py-1.5 text-xs font-bold rounded border transition-all ${
              phase2Active
                ? 'bg-green-900/30 border-green-700 text-green-400'
                : 'bg-gray-800 border-gray-600 text-gray-500'
            }`}
          >
            P2 {phase2Active ? 'ON' : 'OFF'}
          </button>
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
      {(!calStatus || (calStatus.channels.every(c => c.rlsUpdateCount === 0))) && (
        <div className="flex-shrink-0 bg-blue-950/20 border-b border-blue-800/30 px-4 py-2 text-xs text-blue-300">
          <strong>Quick start:</strong> With all PTs at atmospheric (0 PSI), click{' '}
          <span className="font-mono bg-blue-900/40 px-1 rounded">ZERO ALL</span> to initialize.
          Then provide known reference pressures via CAPTURE to build the calibration curve.
          Phase 2 auto-refines in the background.
        </div>
      )}

      {/* ── Channel grid — 5 columns × 2 rows ──────────────────────── */}
      <div className="flex-1 overflow-auto min-h-0 p-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 h-full auto-rows-fr">
          {PT_CHANNELS.map((ch) => (
            <ChannelCard
              key={ch.id}
              ch={ch}
              status={statusMap.get(ch.id)}
              rawAdc={getSensorValue(ch.entity, 'raw_adc_counts')}
              calPsi={getSensorValue(ch.calEntity, 'pressure_psi')}
              onCapture={handleCapture}
            />
          ))}
        </div>
      </div>
    </main>
  );
}
