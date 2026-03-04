'use client'

import { useCallback, useEffect, useState } from 'react';
import DerivedTimeSeriesPlot from '@/components/plots/DerivedTimeSeriesPlot';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';
import {
  kTypeVoltageToTempC,
  codeToForce,
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
  entity, label, color, refVoltage,
}: {
  entity: string; label: string; color: string; refVoltage: number;
}) {
  const raw = useSensorValue(entity, 'raw_adc_counts');
  const volt = raw !== null ? adcToVoltageCustom(raw, refVoltage) : null;
  const temp = volt !== null ? kTypeVoltageToTempC(volt) : null;
  return <DerivedReadoutBox label={label} value={temp} unit="°C" color={color} decimals={1} />;
}

function RTDTempReadout({ entity, label, color }: { entity: string; label: string; color: string }) {
  const temp = useSensorValue(entity, 'temperature_c');
  return <DerivedReadoutBox label={label} value={temp} unit="°C" color={color} decimals={1} />;
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

/** Defaults for ratiometric load-cell force (VDD ref = 1). Adjust per hardware/datasheet. */
const LC_DEFAULTS = {
  adcRefVoltage: 3.3,      // VDD when voltage_reference = 1
  excitationVoltage: 5,
  sensitivityMvPerV: 2,
  pgaGain: 128,
  fullScaleForceN: 1000,
};

function LCForceReadout({
  entity,
  label,
  color,
}: {
  entity: string;
  label: string;
  color: string;
}) {
  const raw = useSensorValue(entity, 'raw_adc_counts');
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
    <DerivedReadoutBox label={label} value={forceN} unit="N" color={color} decimals={1} />
  );
}

export default function LCS_TCS_RTDPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateState  = useSensorStore((s) => s.updateState);
  const ws = getWebSocketClient();

  const TC_REF_VOLTAGE = 2.5;

  // Dynamic channel lists from config
  const [tcEntities,  setTcEntities]  = useState<string[]>([]);
  const [tcLabels,    setTcLabels]    = useState<string[]>([]);
  const [rtdEntities, setRtdEntities] = useState<string[]>([]);
  const [rtdCalEntities, setRtdCalEntities] = useState<string[]>([]);
  const [rtdLabels,   setRtdLabels]   = useState<string[]>([]);
  const [lcEntities,  setLcEntities]  = useState<string[]>([]);
  const [lcLabels,    setLcLabels]    = useState<string[]>([]);

  const loadChannelConfig = useCallback(() => {
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        const boards = data?.config?.boards;
        if (!boards) return;

        const tc = buildChannels(boards, 'TC');
        if (tc.length) {
          setTcEntities(tc.map((ch) => `TC.CH${ch}`));
          setTcLabels(tc.map((ch) => `TC Ch${ch}`));
        }

        const rtd = buildChannels(boards, 'RTD');
        if (rtd.length) {
          setRtdEntities(rtd.map((ch) => `RTD.CH${ch}`));
          setRtdCalEntities(rtd.map((ch) => `RTD_Cal.CH${ch}`));
          setRtdLabels(rtd.map((ch) => `RTD Ch${ch}`));
        }

        const lc = buildChannels(boards, 'LC');
        if (lc.length) {
          setLcEntities(lc.map((ch) => `LC.CH${ch}`));
          setLcLabels(lc.map((ch) => `LC Ch${ch}`));
        }
      })
      .catch(() => {/* leave defaults empty */});
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

  // Plot transforms
  const tcTransform = useCallback(
    (v: number) => kTypeVoltageToTempC(adcToVoltageCustom(v, TC_REF_VOLTAGE)),
    []
  );

  // RTD plot uses component temperature_c (backend sends °C); no conversion needed
  const rtdTransform = useCallback((v: number) => (Number.isFinite(v) ? v : null), []);

  const lcTransform = useCallback((v: number) => {
    const n = codeToForce(
      v,
      LC_DEFAULTS.adcRefVoltage,
      LC_DEFAULTS.excitationVoltage,
      LC_DEFAULTS.sensitivityMvPerV,
      LC_DEFAULTS.pgaGain,
      LC_DEFAULTS.fullScaleForceN
    );
    return n ?? NaN;
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
                  {tcEntities.map((entity, i) => (
                    <TCTempReadout
                      key={entity}
                      entity={entity}
                      label={tcLabels[i]}
                      color={SENSE_COLORS[i % SENSE_COLORS.length]}
                      refVoltage={TC_REF_VOLTAGE}
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
              RTDs (Pt100)
            </h2>
          </div>
          <div className="bg-card rounded-xl border border-gray-800 p-4 flex flex-col gap-4 flex-1 min-h-0">
            {rtdEntities.length > 0 ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 flex-shrink-0">
                  {rtdCalEntities.map((entity, i) => (
                    <RTDTempReadout
                      key={entity}
                      entity={entity}
                      label={`${rtdLabels[i]} T`}
                      color={SENSE_COLORS[i % SENSE_COLORS.length]}
                    />
                  ))}
                </div>
                <div className="flex-shrink-0">
                  <SensorReadoutStrip
                    variant="compact"
                    sensors={rtdEntities.map((entity, i) => ({
                      label: `${rtdLabels[i]} ADC`,
                      entity,
                      component: 'raw_resistance_counts',
                      unit: 'counts',
                      color: SENSE_COLORS[i % SENSE_COLORS.length],
                      decimals: 0,
                    }))}
                  />
                </div>
                <SectionPlot
                  title="Temperature (°C) — Pt100"
                  entities={rtdCalEntities}
                  component="temperature_c"
                  transform={rtdTransform}
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
                  title="Force (N) — ratiometric formula"
                  entities={lcEntities}
                  component="raw_adc_counts"
                  transform={lcTransform}
                  yLabel="Force (N)"
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
