'use client'

import { useCallback, useEffect, useState } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import { useSensorStore, useSensorValue, useLoadCellForceKg } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType } from '@/lib/types';
import { getApiBaseUrl } from '@/lib/websocket';
import { buildSenseRowsFromBoards, type SenseRowConfig } from '@/lib/sensor-info-entities';

const SENSE_COLORS = ['#F59E0B', '#10B981', '#3B82F6', '#EC4899'];

const WINDOW_SECONDS = 60;

// ── Config helper ─────────────────────────────────────────────────────────────



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

function RTDRawReadout({ calEntity, label, color }: { calEntity: string; label: string; color: string }) {
  // Cal packet carries raw ADC u32 (same field as PT/TC/LC) — use raw_adc_counts on cal entity.
  const raw = useSensorValue(calEntity, 'raw_adc_counts');
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
  calEntity, label, color, offsetKg, onTare, onClearTare, disabled, disabledReason,
}: {
  entity: string; calEntity: string; label: string; color: string;
  /** Live tare from the backend, or null when untared. Never assumed from a click — see poll. */
  offsetKg: number | null;
  onTare: () => void; onClearTare: () => void;
  disabled: boolean; disabledReason: string;
}) {
  // Tared when a tare is standing, absolute otherwise. The value is derived by the backend and
  // published as its own component, so this readout and the plot below it cannot disagree.
  const value = useLoadCellForceKg(calEntity);
  const tared = offsetKg != null;
  return (
    <div className="flex flex-col gap-1">
      <DerivedReadoutBox label={label} value={value} unit="kg" color={color} decimals={1} />
      <div className="flex items-center gap-1.5 px-1">
        <button
          onClick={tared ? onClearTare : onTare}
          disabled={disabled}
          title={
            disabled
              ? disabledReason
              : tared
                ? `Remove the tare and show absolute weight again (currently \u2212${offsetKg!.toFixed(1)} kg).`
                : 'Zero the DISPLAY at the current load. Display only \u2014 does not affect calibration, control, abort, or what is recorded.'
          }
          className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
            disabled
              ? 'border-gray-800 text-gray-600 cursor-not-allowed'
              : tared
                ? 'border-amber-600 text-amber-400 hover:bg-amber-900/30'
                : 'border-gray-600 text-gray-300 hover:bg-gray-700'
          }`}
        >
          {tared ? 'Clear tare' : 'Tare'}
        </button>
        {tared && (
          <span className="text-[10px] text-amber-400 tabular-nums" title="Offset subtracted from the displayed weight.">
            &minus;{offsetKg!.toFixed(1)} kg
          </span>
        )}
      </div>
    </div>
  );
}

export default function LCS_TCS_RTDPage() {
  const ws = getWebSocketClient();

  // Dynamic channel lists from config (TC includes board voltage_reference per channel)
  const [tcData, setTcData] = useState<SenseRowConfig[]>([]);
  const [rtdEntities, setRtdEntities] = useState<string[]>([]);
  const [rtdCalEntities, setRtdCalEntities] = useState<string[]>([]);
  const [rtdLabels, setRtdLabels] = useState<string[]>([]);
  const [lcEntities, setLcEntities] = useState<string[]>([]);
  const [lcCalEntities, setLcCalEntities] = useState<string[]>([]);
  const [lcLabels, setLcLabels] = useState<string[]>([]);
  // uid = boardId * 100 + connector, taken from the config rows. NEVER parsed back out of an
  // entity string: the number in "LC2_Cal.CH1" is the Elodin slot (board_id % 10), not the board
  // id, so two boards sharing a slot would resolve to the same uid — the collision that once put
  // a load cell's curve on a 5000 psi transducer.
  const [lcUids, setLcUids] = useState<number[]>([]);
  /** entity -> offset kg, polled from the backend. The source of truth for what is tared. */
  const [lcTares, setLcTares] = useState<Record<string, number>>({});
  const [sessionActive, setSessionActive] = useState(false);
  /** Set when a tare command was sent and the backend has not confirmed it yet. */
  const [tarePending, setTarePending] = useState(false);

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

      // Board-scoped throughout: two boards of one type routinely share a connector
      // number, and a bare LC_Cal.CH1 resolves through the store's alias table to
      // whichever board it happens to find first — two rows, one board's data.
      const tc = buildSenseRowsFromBoards(boards, 'TC');
      if (tc.length) setTcData(tc);

      const rtd = buildSenseRowsFromBoards(boards, 'RTD');
      if (rtd.length) {
        setRtdEntities(rtd.map((r) => r.entity));
        setRtdCalEntities(rtd.map((r) => r.calEntity));
        setRtdLabels(rtd.map((r) => {
          const role = sensorConfig?.find((s) => s.calEntity === r.calEntity)?.role;
          return role ?? r.label;
        }));
      }

      const lc = buildSenseRowsFromBoards(boards, 'LC');
      if (lc.length) {
        setLcEntities(lc.map((r) => r.entity));
        setLcCalEntities(lc.map((r) => r.calEntity));
        setLcLabels(lc.map((r) => r.label));
        setLcUids(lc.map((r) => r.boardId * 100 + r.channel));
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

  // A tare is only real once the backend says so. [0x46,0x00] carries no reply, so a click tells
  // us nothing: the calibration service can refuse a tare outright when the stream is stale, and
  // an optimistic zero would be a lie about a load cell. Poll the file the subtraction itself
  // reads, so the badge and the number can never disagree.
  const fetchTares = useCallback(() => {
    fetch(`${getApiBaseUrl()}/api/lc_tare`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const next: Record<string, number> = {};
        for (const t of (d.tares ?? []) as Array<{ entity: string; offsetKg: number }>) {
          if (Number.isFinite(t.offsetKg)) next[t.entity] = t.offsetKg;
        }
        setLcTares(next);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchTares();
    const id = setInterval(fetchTares, 2000);
    return () => clearInterval(id);
  }, [fetchTares]);

  // No live stream means no fresh ADC to tare against, so the service would refuse anyway.
  useEffect(() => {
    const unsub = ws.on(MessageType.SESSION_UPDATE, (p: unknown) =>
      setSessionActive(!!(p as { active?: boolean })?.active));
    fetch(`${getApiBaseUrl()}/api/config/profiles`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setSessionActive(!!d.sessionActive); })
      .catch(() => {});
    return () => { unsub(); };
  }, [ws]);

  const sendTareCmd = useCallback((commandType: 'tare_lc' | 'clear_tare_lc', uid?: number) => {
    ws.send({
      type: MessageType.CALIBRATION_COMMAND,
      timestamp: Date.now(),
      payload: uid == null
        ? { commandType }
        : { commandType, sensorId: uid % 100, boardId: Math.floor(uid / 100) },
    });
    // Accelerate the poll rather than assuming an outcome. If nothing changes within ~2 s the
    // banner says so, instead of a button that looks like it worked.
    setTarePending(true);
    const t0 = Date.now();
    const quick = setInterval(fetchTares, 120);
    setTimeout(() => { clearInterval(quick); setTarePending(false); void t0; }, 2200);
  }, [ws, fetchTares]);

  const anyTared = lcCalEntities.some((e) => lcTares[e] != null);

  const tcEntities = tcData.map((d) => d.entity);
  // d.calEntity, never a string replace: entities are board-scoped (TC1.CH2), so
  // 'TC1.CH2'.replace('TC.', 'TC_Cal.') silently returns the raw entity unchanged.
  const tcCalEntities = tcData.map((d) => d.calEntity);
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
                      calEntity={d.calEntity}
                      label={d.label}
                      color={SENSE_COLORS[i % SENSE_COLORS.length]}
                      voltageReference={d.voltageReference}
                    />
                  ))}
                </div>
                <div className="flex-shrink-0">
                  <SensorReadoutStrip
                    variant="compact"
                    sensors={tcCalEntities.map((entity, i) => ({
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
                  {rtdCalEntities.map((calEntity, i) => (
                    <RTDRawReadout
                      key={calEntity}
                      calEntity={calEntity}
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
                <div className="flex items-center justify-between gap-2 flex-shrink-0">
                  <span className="text-[11px] text-gray-500">
                    {anyTared
                      ? 'Tared \u2014 showing weight relative to the tared load. Calibration is unaffected.'
                      : 'Showing absolute weight.'}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {anyTared && (
                      <button
                        onClick={() => sendTareCmd('clear_tare_lc')}
                        disabled={!sessionActive}
                        title="Remove every load-cell tare and show absolute weight again."
                        className="text-[10px] px-2 py-0.5 rounded border border-amber-600 text-amber-400 hover:bg-amber-900/30 disabled:border-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed"
                      >
                        Clear all tares
                      </button>
                    )}
                    <button
                      onClick={() => sendTareCmd('tare_lc')}
                      disabled={!sessionActive}
                      title={sessionActive
                        ? 'Zero the DISPLAY on every load cell at its current load. Display only \u2014 does not affect calibration, control, abort, or what is recorded.'
                        : 'Start a session to tare \u2014 a tare needs a live stream.'}
                      className="text-[10px] px-2 py-0.5 rounded border border-gray-600 text-gray-300 hover:bg-gray-700 disabled:border-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed"
                    >
                      Tare all
                    </button>
                  </div>
                </div>
                {tarePending && (
                  <div className="text-[11px] text-amber-400 flex-shrink-0">
                    Waiting for the calibration service to confirm\u2026
                  </div>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 flex-shrink-0">
                  {lcEntities.map((entity, i) => (
                    <LCForceReadout
                      offsetKg={lcTares[lcCalEntities[i]] ?? null}
                      onTare={() => sendTareCmd('tare_lc', lcUids[i])}
                      onClearTare={() => sendTareCmd('clear_tare_lc', lcUids[i])}
                      disabled={!sessionActive || lcUids[i] == null}
                      disabledReason={sessionActive ? 'No uid for this channel in config.' : 'Start a session to tare \u2014 a tare needs a live stream.'}
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
                    sensors={lcCalEntities.map((entity, i) => ({
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
                  component="force_kg_tared"
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
