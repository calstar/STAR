'use client'

import { useEffect, useState } from 'react';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';
import { useSensorRate } from '@/lib/sensor-rate';
import { kTypeVoltageToTempC, codeToForce } from '@/lib/sense-conversions';

// ── Constants ────────────────────────────────────────────────────────────────

const ADC_FULL_SCALE = 2 ** 31;
const TC_REF_VOLTAGE = 2.5;

const LC_DEFAULTS = {
  adcRefVoltage: 3.3,
  excitationVoltage: 5,
  sensitivityMvPerV: 2,
  pgaGain: 128,
  fullScaleForceN: 1000,
};

function adcToVoltage(rawAdc: number, refVolts: number): number {
  const u = rawAdc >>> 0;
  const signed = u > 0x7fffffff ? u - 0x100000000 : u;
  return (signed / ADC_FULL_SCALE) * refVolts;
}

// ── Static sensor definitions ─────────────────────────────────────────────────

interface PtSensor {
  label: string;
  entity: string; // PT_Cal. namespace
  color: string;
}

const PT_SENSORS: PtSensor[] = [
  { label: 'Fuel Upstream',   entity: 'PT_Cal.Fuel_Upstream',   color: '#E67E22' },
  { label: 'GSE Low',         entity: 'PT_Cal.GSE_Low',         color: '#D7BDE2' },
  { label: 'Fuel Downstream', entity: 'PT_Cal.Fuel_Downstream', color: '#C0392B' },
  { label: 'Fuel Fill Tank',  entity: 'PT_Cal.Fuel_Fill_Tank',  color: '#F39C12' },
  { label: 'Ox Upstream',     entity: 'PT_Cal.Ox_Upstream',     color: '#5DADE2' },
  { label: 'GN2 Regulated',   entity: 'PT_Cal.GN2_Regulated',   color: '#3CB371' },
  { label: 'Ox Downstream',   entity: 'PT_Cal.Ox_Downstream',   color: '#2471A3' },
];

const HPT_SENSORS: PtSensor[] = [
  { label: 'GSE High', entity: 'PT_Cal.GSE_High', color: '#8E44AD' },
  { label: 'GSE Mid',  entity: 'PT_Cal.GSE_Mid',  color: '#9B59B6' },
  { label: 'GN2 High', entity: 'PT_Cal.GN2_High', color: '#32CD32' },
];

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtAdc(v: number | null): string {
  if (v === null || !isFinite(v)) return '---';
  return (v >>> 0).toLocaleString();
}

function fmtPsi(v: number | null): string {
  if (v === null || !isFinite(v)) return '---';
  return v.toFixed(1);
}

function fmtTemp(v: number | null): string {
  if (v === null || !isFinite(v)) return '---';
  return v.toFixed(1);
}

function fmtHz(v: number): string {
  if (v <= 0) return '---';
  return v.toFixed(1);
}

function fmtMa(v: number | null): string {
  if (v === null || !isFinite(v)) return '---';
  return v.toFixed(2);
}

function fmtForce(v: number | null): string {
  if (v === null || !isFinite(v)) return '---';
  return v.toFixed(2);
}

function fmtResistance(v: number | null): string {
  if (v === null || !isFinite(v)) return '---';
  return v.toFixed(3);
}

// ── Shared table wrapper ──────────────────────────────────────────────────────

function SensorTable({
  title,
  color,
  headers,
  children,
}: {
  title: string;
  color: string;
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800">
        <div className="w-1.5 h-5 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-sm font-bold tracking-widest text-gray-400 uppercase">{title}</span>
      </div>
      <table className="w-full text-sm font-mono">
        <thead>
          <tr className="border-b border-gray-800/60">
            {headers.map((h) => (
              <th
                key={h}
                className="text-left px-4 py-2 text-xs font-semibold tracking-wider text-gray-500 uppercase"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// ── PT row ───────────────────────────────────────────────────────────────────

function PtRow({ sensor }: { sensor: PtSensor }) {
  const adc     = useSensorValue(sensor.entity, 'raw_adc_counts');
  const psi     = useSensorValue(sensor.entity, 'pressure_psi');
  const rateAdc = useSensorRate(sensor.entity, 'raw_adc_counts');
  const ratePsi = useSensorRate(sensor.entity, 'pressure_psi');
  const rate    = Math.max(rateAdc, ratePsi);

  return (
    <tr className="border-b border-gray-800/40 hover:bg-gray-900/30 transition-colors">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: sensor.color }} />
          <span className="text-gray-200 font-sans font-medium text-xs">{sensor.label}</span>
        </div>
      </td>
      <td className="px-4 py-2 tabular-nums text-purple-300">{fmtAdc(adc)}</td>
      <td className="px-4 py-2 tabular-nums" style={{ color: sensor.color }}>
        {fmtPsi(psi)} <span className="text-gray-600 text-xs">PSI</span>
      </td>
      <td className="px-4 py-2 tabular-nums text-cyan-400">{fmtHz(rate)} <span className="text-gray-600 text-xs">Hz</span></td>
    </tr>
  );
}

// ── HPT row ──────────────────────────────────────────────────────────────────

function HptRow({ sensor }: { sensor: PtSensor }) {
  const adc      = useSensorValue(sensor.entity, 'raw_adc_counts');
  const psi      = useSensorValue(sensor.entity, 'pressure_psi');
  const ma       = useSensorValue(sensor.entity, 'current_ma');
  const rateAdc  = useSensorRate(sensor.entity, 'raw_adc_counts');
  const ratePsi  = useSensorRate(sensor.entity, 'pressure_psi');
  const rate     = Math.max(rateAdc, ratePsi);

  return (
    <tr className="border-b border-gray-800/40 hover:bg-gray-900/30 transition-colors">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: sensor.color }} />
          <span className="text-gray-200 font-sans font-medium text-xs">{sensor.label}</span>
        </div>
      </td>
      <td className="px-4 py-2 tabular-nums text-purple-300">{fmtAdc(adc)}</td>
      <td className="px-4 py-2 tabular-nums" style={{ color: sensor.color }}>
        {fmtPsi(psi)} <span className="text-gray-600 text-xs">PSI</span>
      </td>
      <td className="px-4 py-2 tabular-nums text-blue-400">
        {fmtMa(ma)} <span className="text-gray-600 text-xs">mA</span>
      </td>
      <td className="px-4 py-2 tabular-nums text-cyan-400">{fmtHz(rate)} <span className="text-gray-600 text-xs">Hz</span></td>
    </tr>
  );
}

// ── TC row ───────────────────────────────────────────────────────────────────

function TcRow({ entity, label, color }: { entity: string; label: string; color: string }) {
  const raw  = useSensorValue(entity, 'raw_adc_counts');
  const rate = useSensorRate(entity, 'raw_adc_counts');

  const tempC =
    raw !== null
      ? kTypeVoltageToTempC(adcToVoltage(raw, TC_REF_VOLTAGE))
      : null;

  return (
    <tr className="border-b border-gray-800/40 hover:bg-gray-900/30 transition-colors">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
          <span className="text-gray-200 font-sans font-medium text-xs">{label}</span>
        </div>
      </td>
      <td className="px-4 py-2 tabular-nums text-purple-300">{fmtAdc(raw)}</td>
      <td className="px-4 py-2 tabular-nums text-amber-400">
        {fmtTemp(tempC)} <span className="text-gray-600 text-xs">°C</span>
      </td>
      <td className="px-4 py-2 tabular-nums text-cyan-400">{fmtHz(rate)} <span className="text-gray-600 text-xs">Hz</span></td>
    </tr>
  );
}

// ── RTD row ──────────────────────────────────────────────────────────────────

function RtdRow({ entity, calEntity, label, color }: { entity: string; calEntity: string; label: string; color: string }) {
  const rawRes  = useSensorValue(entity, 'raw_resistance');
  const tempC   = useSensorValue(calEntity, 'temperature_c');
  const rateRaw = useSensorRate(entity, 'raw_resistance');
  const rateCal = useSensorRate(calEntity, 'temperature_c');
  const rate    = Math.max(rateRaw, rateCal);

  return (
    <tr className="border-b border-gray-800/40 hover:bg-gray-900/30 transition-colors">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
          <span className="text-gray-200 font-sans font-medium text-xs">{label}</span>
        </div>
      </td>
      <td className="px-4 py-2 tabular-nums text-purple-300">
        {fmtResistance(rawRes)} <span className="text-gray-600 text-xs">Ω</span>
      </td>
      <td className="px-4 py-2 tabular-nums text-green-400">
        {fmtTemp(tempC)} <span className="text-gray-600 text-xs">°C</span>
      </td>
      <td className="px-4 py-2 tabular-nums text-cyan-400">{fmtHz(rate)} <span className="text-gray-600 text-xs">Hz</span></td>
    </tr>
  );
}

// ── LC row ───────────────────────────────────────────────────────────────────

function LcRow({ entity, label, color }: { entity: string; label: string; color: string }) {
  const raw  = useSensorValue(entity, 'raw_adc_counts');
  const rate = useSensorRate(entity, 'raw_adc_counts');

  const forceN =
    raw !== null
      ? codeToForce(
          raw,
          LC_DEFAULTS.adcRefVoltage,
          LC_DEFAULTS.excitationVoltage,
          LC_DEFAULTS.sensitivityMvPerV,
          LC_DEFAULTS.pgaGain,
          LC_DEFAULTS.fullScaleForceN
        )
      : null;

  return (
    <tr className="border-b border-gray-800/40 hover:bg-gray-900/30 transition-colors">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
          <span className="text-gray-200 font-sans font-medium text-xs">{label}</span>
        </div>
      </td>
      <td className="px-4 py-2 tabular-nums text-purple-300">{fmtAdc(raw)}</td>
      <td className="px-4 py-2 tabular-nums text-orange-400">
        {fmtForce(forceN)} <span className="text-gray-600 text-xs">N</span>
      </td>
      <td className="px-4 py-2 tabular-nums text-cyan-400">{fmtHz(rate)} <span className="text-gray-600 text-xs">Hz</span></td>
    </tr>
  );
}

// ── Channel builder from /api/config ─────────────────────────────────────────

function buildChannels(boards: Record<string, any>, type: 'TC' | 'RTD' | 'LC'): number[] {
  const channels: number[] = [];
  for (const board of Object.values(boards)) {
    if (board.type !== type || board.enabled === false) continue;
    const active: number[] =
      Array.isArray(board.active_connectors) && board.active_connectors.length > 0
        ? (board.active_connectors as number[])
        : Array.from({ length: (board.num_sensors as number) ?? 10 }, (_, i) => i + 1);
    channels.push(...active);
  }
  return channels;
}

const SENSE_COLORS = ['#F59E0B', '#10B981', '#3B82F6', '#EC4899', '#F87171', '#A78BFA', '#34D399', '#FBBF24', '#60A5FA', '#E879F9'];

// Default channel lists match config.toml active_connectors so the first
// render produces the same component tree as after the config fetch.
// This prevents a 0 → N row transition that can trigger "more hooks" errors.
const TC_DEFAULT_CHANNELS  = [2, 3, 4, 5];    // tc_board  active_connectors
const RTD_DEFAULT_CHANNELS = [1, 2, 3, 4];    // rtd_board active_connectors
const LC_DEFAULT_CHANNELS  = [1, 2, 3];        // lc_board  active_connectors

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SensorInfoPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateState  = useSensorStore((s) => s.updateState);
  const ws = getWebSocketClient();

  // Initialised with defaults so rows are present immediately; config fetch
  // refines the lists if they differ from the defaults.
  const [tcChannels,  setTcChannels]  = useState<number[]>(TC_DEFAULT_CHANNELS);
  const [rtdChannels, setRtdChannels] = useState<number[]>(RTD_DEFAULT_CHANNELS);
  const [lcChannels,  setLcChannels]  = useState<number[]>(LC_DEFAULT_CHANNELS);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        const boards = data?.config?.boards;
        if (!boards) return;
        const tc = buildChannels(boards, 'TC');
        if (tc.length) setTcChannels(tc);
        const rtd = buildChannels(boards, 'RTD');
        if (rtd.length) setRtdChannels(rtd);
        const lc = buildChannels(boards, 'LC');
        if (lc.length) setLcChannels(lc);
      })
      .catch(() => {/* keep defaults on failure */});
  }, []);

  useEffect(() => {
    ws.connect();
    const u1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const u2 = ws.on(MessageType.STATE_UPDATE,  (p: unknown) => updateState(p as StateUpdate));
    return () => { u1(); u2(); };
  }, [ws, updateSensor, updateState]);

  return (
    <main className="h-full bg-background text-text overflow-auto">
      <div className="p-4 flex flex-col gap-4 max-w-7xl mx-auto">

        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-bold tracking-widest text-gray-300 uppercase">Sensor Info</h1>
          <span className="text-xs text-gray-500 font-mono">ADC · Converted · Data Rate per channel</span>
        </div>

        {/* ── PT (Pressure Transducers – board 21) ─────────────────────────── */}
        <SensorTable
          title="PT — Pressure Transducers (Board 21)"
          color="#E67E22"
          headers={['Channel', 'ADC Code', 'Pressure', 'Rate']}
        >
          {PT_SENSORS.map((s) => (
            <PtRow key={s.entity} sensor={s} />
          ))}
        </SensorTable>

        {/* ── HPT (High-Pressure PT – board 22) ───────────────────────────── */}
        <SensorTable
          title="HPT — High-Pressure PT (Board 22, 4–20 mA)"
          color="#9B59B6"
          headers={['Channel', 'ADC Code', 'Pressure', 'Current', 'Rate']}
        >
          {HPT_SENSORS.map((s) => (
            <HptRow key={s.entity} sensor={s} />
          ))}
        </SensorTable>

        {/* ── TC (Thermocouples – board 51) ────────────────────────────────── */}
        <SensorTable
          title="TC — Thermocouples, K-type (Board 51)"
          color="#F59E0B"
          headers={['Channel', 'ADC Code', 'Temp (derived)', 'Rate']}
        >
          {tcChannels.map((ch, i) => (
            <TcRow
              key={ch}
              entity={`TC.TC_CH${ch}`}
              label={`TC Ch${ch}`}
              color={SENSE_COLORS[i % SENSE_COLORS.length]}
            />
          ))}
        </SensorTable>

        {/* ── RTD (board 31) ───────────────────────────────────────────────── */}
        <SensorTable
          title="RTD — Pt100 Temperature (Board 31)"
          color="#10B981"
          headers={['Channel', 'Raw Resistance', 'Temp', 'Rate']}
        >
          {rtdChannels.map((ch, i) => (
            <RtdRow
              key={ch}
              entity={`RTD.RTD_CH${ch}`}
              calEntity={`RTD_Cal.RTD_CH${ch}`}
              label={`RTD Ch${ch}`}
              color={SENSE_COLORS[i % SENSE_COLORS.length]}
            />
          ))}
        </SensorTable>

        {/* ── LC (Load Cells – board 41) ───────────────────────────────────── */}
        <SensorTable
          title="LC — Load Cells (Board 41)"
          color="#3B82F6"
          headers={['Channel', 'ADC Code', 'Force (derived)', 'Rate']}
        >
          {lcChannels.map((ch, i) => (
            <LcRow
              key={ch}
              entity={`LC.CH${ch}`}
              label={`LC Ch${ch}`}
              color={SENSE_COLORS[i % SENSE_COLORS.length]}
            />
          ))}
        </SensorTable>

      </div>
    </main>
  );
}
