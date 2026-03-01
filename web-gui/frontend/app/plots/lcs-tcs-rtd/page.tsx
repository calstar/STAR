'use client'

import { useCallback, useEffect, useState } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import DerivedTimeSeriesPlot from '@/components/plots/DerivedTimeSeriesPlot';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';
import {
  kTypeVoltageToTempC,
  pt1000ResistanceToTempC,
} from '@/lib/sense-conversions';

const ADC_FULL_SCALE = 2 ** 31;

function adcToVoltageCustom(rawAdc: number, refVolts: number): number {
  const u = rawAdc >>> 0;
  const signed = u > 0x7fffffff ? u - 0x100000000 : u;
  return (signed / ADC_FULL_SCALE) * refVolts;
}

const TC_ENTITIES = ['TC.TC_CH1', 'TC.TC_CH2', 'TC.TC_CH3', 'TC.TC_CH4'];
const RTD_ENTITIES = ['RTD.RTD_CH1', 'RTD.RTD_CH2', 'RTD.RTD_CH3', 'RTD.RTD_CH4'];
const TC_LABELS = ['TC Ch1', 'TC Ch2', 'TC Ch3', 'TC Ch4'];
const RTD_LABELS = ['RTD Ch1', 'RTD Ch2', 'RTD Ch3', 'RTD Ch4'];
const SENSE_COLORS = ['#F59E0B', '#10B981', '#3B82F6', '#EC4899'];

const WINDOW_SECONDS = 60;

/** Single readout box showing a derived value (e.g. temperature from raw). */
function DerivedReadoutBox({
  label,
  value,
  unit,
  color,
  decimals = 1,
}: {
  label: string;
  value: number | null;
  unit: string;
  color: string;
  decimals?: number;
}) {
  return (
    <div className="bg-gray-900/60 rounded-xl px-4 py-3 flex flex-col gap-0.5 min-w-0 border border-gray-800/80">
      <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider truncate">
        {label}
      </span>
      <span className="text-2xl font-bold font-mono tabular-nums leading-tight" style={{ color }}>
        {value !== null && Number.isFinite(value) ? value.toFixed(decimals) : '—'}
      </span>
      <span className="text-[10px] text-gray-500 font-medium">{unit}</span>
    </div>
  );
}

function TCTempReadout({
  entity,
  label,
  color,
  refVoltage,
}: {
  entity: string;
  label: string;
  color: string;
  refVoltage: number;
}) {
  const raw = useSensorValue(entity, 'raw_adc_counts');
  const volt = raw !== null ? adcToVoltageCustom(raw, refVoltage) : null;
  const temp = volt !== null ? kTypeVoltageToTempC(volt) : null;
  return (
    <DerivedReadoutBox label={label} value={temp} unit="°C" color={color} decimals={1} />
  );
}

function RTDTempReadout({ entity, label, color }: { entity: string; label: string; color: string }) {
  const r = useSensorValue(entity, 'raw_resistance');
  const temp = r !== null ? pt1000ResistanceToTempC(r) : null;
  return (
    <DerivedReadoutBox label={label} value={temp} unit="°C" color={color} decimals={1} />
  );
}

export default function LCS_TCS_RTDPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateState = useSensorStore((s) => s.updateState);
  const ws = getWebSocketClient();
  const [tcRefVoltage, setTcRefVoltage] = useState(2.5);

  useEffect(() => {
    ws.connect();
    const unsub1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) =>
      updateSensor(p as SensorUpdate)
    );
    const unsub2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) =>
      updateState(p as StateUpdate)
    );
    return () => {
      unsub1();
      unsub2();
    };
  }, [ws, updateSensor, updateState]);

  const tcTransform = useCallback(
    (v: number) => {
      const volt = adcToVoltageCustom(v, tcRefVoltage);
      return kTypeVoltageToTempC(volt);
    },
    [tcRefVoltage]
  );

  const rtdTransform = useCallback((v: number) => pt1000ResistanceToTempC(v), []);

  return (
    <main className="h-full min-h-0 bg-background text-text flex flex-col overflow-auto">
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-4 pb-3 border-b border-gray-800/80">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">
              LCS / TCS / RTD
            </h1>
            <p className="text-sm text-gray-400 mt-0.5">
              Thermocouples (K-type) · RTDs (Pt1000) · Load cell when available
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                TC ref (V)
              </label>
              <select
                value={tcRefVoltage}
                onChange={(e) => setTcRefVoltage(Number(e.target.value))}
                className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-1 focus:ring-amber-500/50 focus:border-amber-500/50 outline-none"
              >
                <option value={2.5}>2.5</option>
                <option value={3.3}>3.3</option>
                <option value={5}>5</option>
              </select>
            </div>
            <span className="text-xs text-gray-500 font-mono">
              {WINDOW_SECONDS} s window
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 p-4 flex flex-col gap-6 overflow-auto">
        {/* ── Thermocouples ───────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-1 h-6 rounded-full bg-amber-500/90" />
            <h2 className="text-sm font-bold tracking-widest text-gray-400 uppercase">
              Thermocouples (K-type)
            </h2>
          </div>
          <div className="bg-card rounded-xl border border-gray-800 p-4 flex flex-col gap-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {TC_ENTITIES.map((entity, i) => (
                <TCTempReadout
                  key={entity}
                  entity={entity}
                  label={TC_LABELS[i]}
                  color={SENSE_COLORS[i]}
                  refVoltage={tcRefVoltage}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <SensorReadoutStrip
                sensors={TC_ENTITIES.map((entity, i) => ({
                  label: `${TC_LABELS[i]} ADC`,
                  entity,
                  component: 'raw_adc_counts',
                  unit: 'counts',
                  color: SENSE_COLORS[i],
                  decimals: 0,
                }))}
              />
            </div>
            <div className="flex flex-col min-h-[320px] rounded-lg overflow-hidden bg-gray-950/50 border border-gray-800">
              <div className="px-3 py-2 border-b border-gray-800 text-xs font-medium text-gray-500">
                Temperature (°C) — K-type from raw ADC
              </div>
              <div className="flex-1 min-h-[280px]">
                <DerivedTimeSeriesPlot
                  title=""
                  entities={TC_ENTITIES}
                  component="raw_adc_counts"
                  transform={tcTransform}
                  yLabel="Temperature (°C)"
                  labels={TC_LABELS}
                  colors={SENSE_COLORS}
                  windowSeconds={WINDOW_SECONDS}
                />
              </div>
            </div>
          </div>
        </section>

        {/* ── RTDs ────────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-1 h-6 rounded-full bg-emerald-500/90" />
            <h2 className="text-sm font-bold tracking-widest text-gray-400 uppercase">
              RTDs (Pt1000)
            </h2>
          </div>
          <div className="bg-card rounded-xl border border-gray-800 p-4 flex flex-col gap-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {RTD_ENTITIES.map((entity, i) => (
                <RTDTempReadout
                  key={entity}
                  entity={entity}
                  label={`${RTD_LABELS[i]} T`}
                  color={SENSE_COLORS[i]}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <SensorReadoutStrip
                sensors={RTD_ENTITIES.map((entity, i) => ({
                  label: `${RTD_LABELS[i]} R`,
                  entity,
                  component: 'raw_resistance',
                  unit: 'Ω',
                  color: SENSE_COLORS[i],
                  decimals: 1,
                }))}
              />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="flex flex-col min-h-[320px] rounded-lg overflow-hidden bg-gray-950/50 border border-gray-800">
                <div className="px-3 py-2 border-b border-gray-800 text-xs font-medium text-gray-500">
                  Resistance (Ω)
                </div>
                <div className="flex-1 min-h-[280px]">
                  <TimeSeriesPlot
                    title=""
                    entities={RTD_ENTITIES}
                    labels={RTD_LABELS}
                    component="raw_resistance"
                    colors={SENSE_COLORS}
                    yLabel="Resistance (Ω)"
                    windowSeconds={WINDOW_SECONDS}
                  />
                </div>
              </div>
              <div className="flex flex-col min-h-[320px] rounded-lg overflow-hidden bg-gray-950/50 border border-gray-800">
                <div className="px-3 py-2 border-b border-gray-800 text-xs font-medium text-gray-500">
                  Temperature (°C) — Pt1000
                </div>
                <div className="flex-1 min-h-[280px]">
                  <DerivedTimeSeriesPlot
                    title=""
                    entities={RTD_ENTITIES}
                    component="raw_resistance"
                    transform={rtdTransform}
                    yLabel="Temperature (°C)"
                    labels={RTD_LABELS}
                    colors={SENSE_COLORS}
                    windowSeconds={WINDOW_SECONDS}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Load cell placeholder ───────────────────────────────────────── */}
        <section className="flex flex-col gap-3 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-1 h-6 rounded-full bg-gray-500/90" />
            <h2 className="text-sm font-bold tracking-widest text-gray-400 uppercase">
              Load cells (LCS)
            </h2>
          </div>
          <div className="bg-card rounded-xl border border-gray-800 border-dashed p-6 flex flex-col items-center justify-center min-h-[120px]">
            <p className="text-sm text-gray-500 text-center max-w-md">
              Load cell channels will appear here when the backend supports LC packet types.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
