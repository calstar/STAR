'use client'

import { useCallback, useEffect, useState } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import { useSensorStore, useSensorValue, useLoadCellForceKg } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType } from '@/lib/types';
import { getApiBaseUrl } from '@/lib/websocket';

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
  calEntity, label, color,
}: {
  entity: string; calEntity: string; label: string; color: string; voltageReference: number;
}) {
  const value = useSensorValue(calEntity, 'temperature_c');
  return <DerivedReadoutBox label={label} value={value} unit="°C" color={color} decimals={1} />;
}

function RTDTempReadout({
  calEntity, label, color,
}: {
  entity: string; calEntity: string; label: string; color: string;
}) {
  const value = useSensorValue(calEntity, 'temperature_c');
  return <DerivedReadoutBox label={label} value={value} unit="°C" color={color} decimals={1} />;
}

/** ADC counts → resistance (Ω) for display. R = V*1e6/I, V = (adc/2^31)*ref. */
function rtdAdcToResistanceOhm(adc: number, refV: number = 2.5, excitationUa: number = 1000): number | null {
  if (!Number.isFinite(adc)) return null;
  const u = adc >>> 0;
  const signed = u > 0x7fffffff ? u - 0x100000000 : u;
  const volt = (signed / (2 ** 31)) * refV;
  if (!Number.isFinite(volt)) return null;
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
  title, entities, component, yLabel, labels, colors,
}: {
  title: string;
  entities: string[];
  component: string;
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
        <TimeSeriesPlot
          title=""
          entities={entities}
          component={component}
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
function LCForceReadout({
  calEntity, label, color,
}: {
  entity: string; calEntity: string; label: string; color: string;
}) {
  const value = useLoadCellForceKg(calEntity); // offset already applied in store, C++ outputs kg
  return <DerivedReadoutBox label={label} value={value} unit="kg" color={color} decimals={1} />;
}

export default function LCS_TCS_RTDPage() {
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
      fetch(`${getApiBaseUrl()}/api/config`).then((r) => (r.ok ? r.json() : null)),
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

  useEffect(() => {
    const unsub = ws.on(MessageType.CONFIG_UPDATED, () => loadChannelConfig());
    return () => { unsub(); };
  }, [ws, loadChannelConfig]);

  const tcEntities = tcData.map((d) => d.entity);
  const tcCalEntities = tcData.map((d) => d.entity.replace('TC.', 'TC_Cal.'));
  const tcLabels = tcData.map((d) => d.label);

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
                  title="Temperature (°C) — K-type"
                  entities={tcCalEntities}
                  component="temperature_c"
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
                  entities={rtdCalEntities}
                  component="temperature_c"
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
                  title="Force (kg)"
                  entities={lcCalEntities}
                  component="force_kg"
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
