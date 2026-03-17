'use client'

import { useCallback, useEffect, useState } from 'react';
import DerivedTimeSeriesPlot from '@/components/plots/DerivedTimeSeriesPlot';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import { useSensorStore, useSensorValue, useLoadCellForceLbf } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';
import {
  kTypeVoltageToTempC,
  pt1000VoltageToTempC,
  codeToForce,
} from '@/lib/sense-conversions';
import { adcToVoltage as adcToVoltageFromRef } from '@/lib/voltageRef';
import { getApiBaseUrl } from '@/lib/websocket';

const ADC_FULL_SCALE = 2 ** 31;

function adcToVoltageCustom(rawAdc: number, refVolts: number): number {
  const u = rawAdc >>> 0;
  const signed = u > 0x7fffffff ? u - 0x100000000 : u;
  return (signed / ADC_FULL_SCALE) * refVolts;
}

const TC_ENTITIES = ['TC.CH1', 'TC.CH2', 'TC.CH3', 'TC.CH4'];
const RTD_ENTITIES = ['RTD.CH1', 'RTD.CH2', 'RTD.CH3', 'RTD.CH4'];
const TC_LABELS = ['TC Ch1', 'TC Ch2', 'TC Ch3', 'TC Ch4'];
const RTD_LABELS = ['RTD Ch1', 'RTD Ch2', 'RTD Ch3', 'RTD Ch4'];
const SENSE_COLORS = ['#F59E0B', '#10B981', '#3B82F6', '#EC4899'];

const WINDOW_SECONDS = 60;

// ── Config helper ─────────────────────────────────────────────────────────────

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

/** Build TC entity list with each board's voltage_reference (0=internal, 1=VDD, 2=5V). Uses first TC board's ref when multiple. */
function buildTcChannelsWithRef(boards: Record<string, any>): { entity: string; label: string; voltageReference: number }[] {
  const out: { entity: string; label: string; voltageReference: number }[] = [];
  for (const board of Object.values(boards)) {
    if (board.type !== 'TC' || board.enabled === false) continue;
    const ref = Math.min(2, Math.max(0, (board.voltage_reference as number) ?? 0));
    const active: number[] =
      Array.isArray(board.active_connectors) && board.active_connectors.length > 0
        ? (board.active_connectors as number[])
        : Array.from({ length: (board.num_sensors as number) ?? 10 }, (_, i) => i + 1);
    for (const ch of active) {
      out.push({ entity: `TC.CH${ch}`, label: `TC Ch${ch}`, voltageReference: ref });
    }
  }
  return out;
}

// ── Readout boxes ─────────────────────────────────────────────────────────────

function DerivedReadoutBox({
  label, value, unit, color, decimals = 1,
}: {
  label: string; value: number | null; unit: string; color: string; decimals?: number;
}) {
  return (
    <div className="bg-gray-900/60 rounded-xl px-4 py-3 flex flex-col gap-0.5 min-w-0 border border-gray-800/80">
      <span className="text-xl font-bold text-gray-200 uppercase tracking-wider truncate">
        {label}
      </span>
      <span className="text-4xl font-bold font-mono tabular-nums leading-tight" style={{ color }}>
        {value !== null && Number.isFinite(value) ? value.toFixed(decimals) : '—'}
      </span>
      <span className="text-xs text-gray-500 font-medium">{unit}</span>
    </div>
  );
}

function TCTempReadout({
  entity, calEntity, label, color, voltageReference,
}: {
  entity: string; calEntity: string; label: string; color: string; voltageReference: number;
}) {
  const calTemp = useSensorValue(calEntity, 'temperature_c');
  const raw = useSensorValue(entity, 'raw_adc_counts');
  const nominals = useSensorStore((s) => s.voltageRefNominals);
  const volt = raw !== null && Math.abs(raw) < 2e9 ? adcToVoltageFromRef(raw, voltageReference, nominals) : null;
  const fromRaw = volt !== null && Number.isFinite(volt) ? kTypeVoltageToTempC(volt) : null;
  // Prefer raw-derived temp so readout matches plot (raw ADC → temp); avoid showing 0 when plot has data
  const value = fromRaw !== null && Number.isFinite(fromRaw) ? fromRaw : (calTemp !== null && Number.isFinite(calTemp) ? calTemp : null);
  return <DerivedReadoutBox label={label} value={value} unit="°C" color={color} decimals={1} />;
}

/** RTD temp: prefer RTD_Cal from calibration server; fallback raw ADC→temp when cal not available. */
const RTD_ADC_REF_V = 2.5;

function RTDTempReadout({
  entity, calEntity, label, color,
}: {
  entity: string; calEntity: string; label: string; color: string;
}) {
  const calTemp = useSensorValue(calEntity, 'temperature_c');
  const raw = useSensorValue(entity, 'raw_resistance_counts');
  const volt = raw !== null && Number.isFinite(raw) ? adcToVoltageCustom(raw, RTD_ADC_REF_V) : null;
  const fallbackTemp = volt !== null && Number.isFinite(volt) ? pt1000VoltageToTempC(volt) : null;
  const value = calTemp !== null && Number.isFinite(calTemp) ? calTemp : fallbackTemp;
  return <DerivedReadoutBox label={label} value={value} unit="°C" color={color} decimals={1} />;
}

/** ADC counts → resistance (Ω) for display. R = V*1e6/I, V = (adc/2^31)*ref. */
function rtdAdcToResistanceOhm(adc: number, refV: number = 2.5, excitationUa: number = 1000): number | null {
  if (!Number.isFinite(adc)) return null;
  const volt = adcToVoltageCustom(adc, refV);
  if (volt === null || !Number.isFinite(volt)) return null;
  if (excitationUa <= 0) return null;
  return (Math.abs(volt) * 1e6) / excitationUa;
}

function RTDRawReadout({ entity, label, color }: { entity: string; label: string; color: string }) {
  const raw = useSensorValue(entity, 'raw_resistance_counts');
  const rOhm = raw !== null ? rtdAdcToResistanceOhm(raw) : null;
  const display = raw !== null ? raw.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
  return (
    <div className="bg-white/[0.02] backdrop-blur-md border border-white/5 rounded-lg px-3 py-2 flex flex-col gap-1 min-w-0 hover:bg-white/[0.04] flex-1">
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400 font-bold uppercase tracking-widest truncate">{label}</span>
        <span className="text-lg font-black font-mono tabular-nums ml-auto" style={{ color }}>
          {display}
        </span>
        <span className="text-xs text-gray-500 font-semibold uppercase">counts</span>
      </div>
      <span className="text-xs text-gray-500 font-mono tabular-nums">
        {rOhm !== null ? `${rOhm.toFixed(2)} Ω` : '— Ω'}
      </span>
    </div>
  );
}

// ── Shared plot wrapper ───────────────────────────────────────────────────────

function SectionPlot({
  title, entities, component, transform, yLabel, labels, colors,
}: {
  title: string;
  entities: string[];
  component: string;
  transform: (v: number) => number | null;
  yLabel: string;
  labels: string[];
  colors: string[];
}) {
  return (
    <div className="flex flex-col flex-1 min-h-0 rounded-lg overflow-hidden bg-gray-950/50 border border-gray-800">
      <div className="px-3 py-2 border-b border-gray-800 text-xs font-medium text-gray-500 flex-shrink-0">
        {title}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <DerivedTimeSeriesPlot
          title=""
          entities={entities}
          component={component}
          transform={transform}
          yLabel={yLabel}
          labels={labels}
          colors={colors}
          windowSeconds={WINDOW_SECONDS}
        />
      </div>
    </div>
  );
}

/** Ratiometric LC: ref = excitation, so only sensitivity and PGA set full-scale code. */
const LC_DEFAULTS = {
  sensitivityMvPerV: 2,
  pgaGain: 32,
  fullScaleForceKg: 300,
};
const LBF_TO_KG = 0.453592;

function LCForceReadout({
  entity, calEntity, label, color,
}: {
  entity: string; calEntity: string; label: string; color: string;
}) {
  const calLbf = useLoadCellForceLbf(calEntity); // offset already applied in store
  const raw = useSensorValue(entity, 'raw_adc_counts');
  const fallbackKg =
    raw !== null
      ? codeToForce(
          raw,
          LC_DEFAULTS.sensitivityMvPerV,
          LC_DEFAULTS.pgaGain,
          LC_DEFAULTS.fullScaleForceKg
        )
      : null;
  const value =
    calLbf !== null && Number.isFinite(calLbf)
      ? calLbf * LBF_TO_KG
      : fallbackKg;
  return <DerivedReadoutBox label={label} value={value} unit="kg" color={color} decimals={1} />;
}

export default function LCS_TCS_RTDPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateState  = useSensorStore((s) => s.updateState);
  const ws = getWebSocketClient();

  // Dynamic channel lists from config (TC includes board voltage_reference per channel)
  const [tcData, setTcData] = useState<{ entity: string; label: string; voltageReference: number }[]>([]);
  const [rtdEntities, setRtdEntities] = useState<string[]>([]);
  const [rtdCalEntities, setRtdCalEntities] = useState<string[]>([]);
  const [rtdLabels, setRtdLabels] = useState<string[]>([]);
  const [lcEntities, setLcEntities] = useState<string[]>([]);
  const [lcCalEntities, setLcCalEntities] = useState<string[]>([]);
  const [lcLabels, setLcLabels] = useState<string[]>([]);

  const loadChannelConfig = useCallback(() => {
    Promise.all([
      fetch('/api/config').then((r) => (r.ok ? r.json() : null)),
      fetch(`${getApiBaseUrl()}/api/sensor-config`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([configRes, sensorRes]) => {
      const config = configRes?.config;
      const boards = config?.boards;
      const adc = config?.adc;
      const sensorConfig = sensorRes?.sensors as Array<{ calEntity: string; role: string }> | undefined;

      if (adc && typeof adc.internal_v === 'number' && typeof adc.absolute_5v_v === 'number') {
        useSensorStore.getState().setVoltageRefNominals({ internalV: adc.internal_v, absolute5vV: adc.absolute_5v_v });
      }
      if (!boards) return;

      const tc = buildTcChannelsWithRef(boards);
      if (tc.length) setTcData(tc);

      const rtd = buildChannels(boards, 'RTD');
      if (rtd.length) {
        const entities = rtd.map((ch) => `RTD.CH${ch}`);
        const calEntities = rtd.map((ch) => `RTD_Cal.CH${ch}`);
        const labels = rtd.map((ch) => {
          const role = sensorConfig?.find((s) => s.calEntity === `RTD_Cal.CH${ch}`)?.role;
          return role ?? `RTD Ch${ch}`;
        });
        setRtdEntities(entities);
        setRtdCalEntities(calEntities);
        setRtdLabels(labels);
      }

      const lc = buildChannels(boards, 'LC');
      if (lc.length) {
        setLcEntities(lc.map((ch) => `LC.CH${ch}`));
        setLcCalEntities(lc.map((ch) => `LC_Cal.CH${ch}`));
        setLcLabels(lc.map((ch) => `LC Ch${ch}`));
      }
    }).catch(() => {});
  }, []);

  // Fetch board config on mount and whenever backend signals config reload
  useEffect(() => {
    loadChannelConfig();
  }, [loadChannelConfig]);

  // WebSocket subscriptions
  useEffect(() => {
    ws.connect();
    const unsub1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) =>
      updateSensor(p as SensorUpdate)
    );
    const unsub2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) =>
      updateState(p as StateUpdate)
    );
    const unsub3 = ws.on(MessageType.CONFIG_UPDATED, () => {
      loadChannelConfig();
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [ws, updateSensor, updateState, loadChannelConfig]);

  const voltageRefNominals = useSensorStore((s) => s.voltageRefNominals);
  const tcEntities = tcData.map((d) => d.entity);
  const tcLabels = tcData.map((d) => d.label);
  // Plot transform uses first TC board's ref (single-board case; multi-board uses first board's ref)
  const tcRefForPlot = tcData[0]?.voltageReference ?? 0;
  const tcRefVoltage = tcRefForPlot === 1 ? NaN : (tcRefForPlot === 0 ? voltageRefNominals.internalV : voltageRefNominals.absolute5vV);
  const tcTransform = useCallback(
    (v: number) => {
      if (!Number.isFinite(tcRefVoltage)) return null;
      const volt = adcToVoltageCustom(v, tcRefVoltage);
      return volt !== null && Number.isFinite(volt) ? kTypeVoltageToTempC(volt) : null;
    },
    [tcRefVoltage]
  );

  const lcTransform = useCallback((v: number) => {
    const kg = codeToForce(
      v,
      LC_DEFAULTS.sensitivityMvPerV,
      LC_DEFAULTS.pgaGain,
      LC_DEFAULTS.fullScaleForceKg
    );
    return kg ?? NaN;
  }, []);

  return (
    <main className="h-full min-h-0 bg-background text-text flex flex-col overflow-hidden">
      <div className="flex-1 min-h-0 p-4 grid grid-cols-1 lg:grid-cols-3 gap-4 overflow-hidden min-w-0 lg:grid-rows-[1fr]">

        {/* ── TC (left column) ──────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3 min-w-0 h-full">
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-1.5 h-10 rounded-full bg-amber-500/90" />
            <h2 className="text-3xl font-bold tracking-widest text-gray-400 uppercase">
              Thermocouples (K-type)
            </h2>
          </div>
          <div className="bg-card rounded-xl border border-gray-800 p-4 flex flex-col gap-4 flex-1 min-h-0">
            {tcEntities.length > 0 ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 flex-shrink-0">
                  {tcData.map((d, i) => (
                    <TCTempReadout
                      key={d.entity}
                      entity={d.entity}
                      calEntity={d.entity.replace('TC.', 'TC_Cal.')}
                      label={d.label}
                      color={SENSE_COLORS[i % SENSE_COLORS.length]}
                      voltageReference={d.voltageReference}
                    />
                  ))}
                </div>
                <div className="flex-shrink-0">
                  <SensorReadoutStrip
                    variant="compact"
                    sensors={tcEntities.map((entity, i) => ({
                      label: `${tcLabels[i]} ADC`,
                      entity,
                      component: 'raw_adc_counts',
                      unit: 'counts',
                      color: SENSE_COLORS[i % SENSE_COLORS.length],
                      decimals: 0,
                    }))}
                  />
                </div>
                <SectionPlot
                  title="Temperature (°C) — K-type from raw ADC"
                  entities={tcEntities}
                  component="raw_adc_counts"
                  transform={tcTransform}
                  yLabel="Temperature (°C)"
                  labels={tcLabels}
                  colors={SENSE_COLORS.slice(0, tcEntities.length)}
                />
              </>
            ) : (
              <p className="text-sm text-gray-500 text-center py-4">
                No TC boards enabled in config.toml
              </p>
            )}
          </div>
        </section>

        {/* ── RTD (middle column) ────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3 min-w-0 h-full">
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-1.5 h-10 rounded-full bg-emerald-500/90" />
            <h2 className="text-3xl font-bold tracking-widest text-gray-400 uppercase">
              RTDs (Pt1000)
            </h2>
          </div>
          <div className="bg-card rounded-xl border border-gray-800 p-4 flex flex-col gap-4 flex-1 min-h-0">
            {rtdEntities.length > 0 ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 flex-shrink-0">
                  {rtdEntities.map((entity, i) => (
                    <RTDTempReadout
                      key={entity}
                      entity={entity}
                      calEntity={rtdCalEntities[i]}
                      label={`${rtdLabels[i]} T`}
                      color={SENSE_COLORS[i % SENSE_COLORS.length]}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5 flex-shrink-0">
                  {rtdEntities.map((entity, i) => (
                    <RTDRawReadout
                      key={entity}
                      entity={entity}
                      label={`${rtdLabels[i]} ADC`}
                      color={SENSE_COLORS[i % SENSE_COLORS.length]}
                    />
                  ))}
                </div>
                <SectionPlot
                  title="RTD Temperature (°C)"
                  entities={rtdEntities}
                  component="raw_resistance_counts"
                  transform={(v) => {
                    if (!Number.isFinite(v)) return null;
                    const volt = adcToVoltageCustom(v, RTD_ADC_REF_V);
                    return pt1000VoltageToTempC(volt) ?? null;
                  }}
                  yLabel="Temperature (°C)"
                  labels={rtdLabels}
                  colors={SENSE_COLORS.slice(0, rtdEntities.length)}
                />
              </>
            ) : (
              <p className="text-sm text-gray-500 text-center py-4">
                No RTD boards enabled in config.toml
              </p>
            )}
          </div>
        </section>

        {/* ── LC (right column) ─────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3 min-w-0 h-full">
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-1.5 h-10 rounded-full bg-violet-500/90" />
            <h2 className="text-3xl font-bold tracking-widest text-gray-400 uppercase">
              Load cells (LCS)
            </h2>
          </div>
          <div className="bg-card rounded-xl border border-gray-800 p-4 flex flex-col gap-4 flex-1 min-h-0">
            {lcEntities.length > 0 ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 flex-shrink-0">
                  {lcEntities.map((entity, i) => (
                    <LCForceReadout
                      key={entity}
                      entity={entity}
                      calEntity={lcCalEntities[i]}
                      label={lcLabels[i]}
                      color={SENSE_COLORS[i % SENSE_COLORS.length]}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 flex-shrink-0">
                  <SensorReadoutStrip
                    variant="compact"
                    sensors={lcEntities.map((entity, i) => ({
                      label: `${lcLabels[i]} ADC`,
                      entity,
                      component: 'raw_adc_counts',
                      unit: 'counts',
                      color: SENSE_COLORS[i % SENSE_COLORS.length],
                      decimals: 0,
                    }))}
                  />
                </div>
                <SectionPlot
                  title="Force (kg) — ratiometric formula"
                  entities={lcEntities}
                  component="raw_adc_counts"
                  transform={lcTransform}
                  yLabel="Force (kg)"
                  labels={lcLabels}
                  colors={SENSE_COLORS.slice(0, lcEntities.length)}
                />
              </>
            ) : (
              <p className="text-sm text-gray-500 text-center py-4">
                No LC boards enabled in config.toml
              </p>
            )}
          </div>
        </section>

      </div>
    </main>
  );
}
