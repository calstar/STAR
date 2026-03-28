'use client'

import { useCallback, useEffect, useState } from 'react';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient, getApiBaseUrl } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';
import { useSensorRate, getSensorRate } from '@/lib/sensor-rate';
import { getEntityColor } from '@/lib/sensor-colors';

// ── Constants ────────────────────────────────────────────────────────────────


// ── Static sensor definitions ─────────────────────────────────────────────────

interface PtSensor {
  label: string;
  entity: string; // PT_Cal. namespace
  color: string;
  channelId?: number;
  boardId?: number;
  boardIp?: string;
}

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

// ── Board-level rate helper ────────────────────────────────────────────────────

function useBoardRate(
  keys: Array<{ entity: string; component: string }>,
  intervalMs = 1000
): number {
  const [rate, setRate] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const compute = () => {
      const total = keys.reduce((sum, k) => sum + getSensorRate(k.entity, k.component), 0);
      if (!cancelled) setRate(total);
    };

    compute();
    const id = setInterval(compute, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [JSON.stringify(keys), intervalMs]);

  return rate;
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
          <span
            className="text-gray-200 font-sans font-medium text-xs"
            title={sensor.boardIp ? `Board ${sensor.boardId ?? '?'} • ${sensor.boardIp}` : undefined}
          >
            {sensor.boardId ? `B${sensor.boardId} ` : ''}
            {sensor.channelId ? `CH${sensor.channelId} ` : ''}
            {sensor.label}
          </span>
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
          <span
            className="text-gray-200 font-sans font-medium text-xs"
            title={sensor.boardIp ? `Board ${sensor.boardId ?? '?'} • ${sensor.boardIp}` : undefined}
          >
            {sensor.boardId ? `B${sensor.boardId} ` : ''}
            {sensor.channelId ? `CH${sensor.channelId} ` : ''}
            {sensor.label}
          </span>
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

function TcRow({ entity, label, color }: { entity: string; label: string; color: string; voltageReference: number }) {
  const raw  = useSensorValue(entity, 'raw_adc_counts');
  const calEntity = entity.replace('TC.', 'TC_Cal.');
  const tempC = useSensorValue(calEntity, 'temperature_c');
  const rateRaw = useSensorRate(entity, 'raw_adc_counts');
  const rateCal = useSensorRate(calEntity, 'temperature_c');
  const rate = Math.max(rateRaw, rateCal);

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
  const rawRes  = useSensorValue(entity, 'raw_resistance_counts');
  const tempC   = useSensorValue(calEntity, 'temperature_c');
  const rateRaw = useSensorRate(entity, 'raw_resistance_counts');
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
        {fmtAdc(rawRes)}
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
  const calEntity = entity.replace('LC.', 'LC_Cal.');
  const forceKg = useSensorValue(calEntity, 'force_kg');
  const rateRaw = useSensorRate(entity, 'raw_adc_counts');
  const rateCal = useSensorRate(calEntity, 'force_kg');
  const rate = Math.max(rateRaw, rateCal);

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
        {fmtForce(forceKg)} <span className="text-gray-600 text-xs">kg</span>
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

/** TC channels with each board's voltage_reference (0=internal, 1=VDD, 2=5V). */
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

const SENSE_COLORS = ['#F59E0B', '#10B981', '#3B82F6', '#EC4899', '#F87171', '#A78BFA', '#34D399', '#FBBF24', '#60A5FA', '#E879F9'];

// Default channel lists match config.toml active_connectors so the first
// render produces the same component tree as after the config fetch.
// This prevents a 0 → N row transition that can trigger "more hooks" errors.
const TC_DEFAULT_CHANNELS  = [2, 3, 4, 5];   // tc_board  active_connectors
const RTD_DEFAULT_CHANNELS = [1, 2, 3, 4];   // rtd_board active_connectors
const LC_DEFAULT_CHANNELS  = [1, 2, 3];      // lc_board  active_connectors

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SensorInfoPage() {
  const ws = getWebSocketClient();

  // ── DAQ / relay data-rate probe (Elodin relay → backend) ────────────────────
  const [relayPackets, setRelayPackets] = useState<number | null>(null);
  const [relayRateHz, setRelayRateHz] = useState<number>(0);

  useEffect(() => {
    let prevCount: number | null = null;
    let prevTime: number | null = null;
    let cancelled = false;

    const poll = () => {
      fetch(`${getApiBaseUrl()}/api/debug`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: any) => {
          if (!data || cancelled) return;
          const count: number = typeof data.relayPacketsReceived === 'number' ? data.relayPacketsReceived : 0;
          const now = Date.now();
          setRelayPackets(count);
          if (prevCount != null && prevTime != null) {
            const dt = (now - prevTime) / 1000;
            const dn = count - prevCount;
            if (dt > 0 && dn >= 0) {
              setRelayRateHz(dn / dt);
            }
          }
          prevCount = count;
          prevTime = now;
        })
        .catch(() => {
          // leave last values on error
        });
    };

    poll();
    const id = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const [ptSensors,  setPtSensors]  = useState<PtSensor[]>([]);
  const [hptSensors, setHptSensors] = useState<PtSensor[]>([]);

  // Dynamic channel lists from /api/config, seeded with defaults so the
  // initial render matches the post-config-fetch structure.
  const [tcData, setTcData] = useState<{ entity: string; label: string; voltageReference: number }[]>(
    TC_DEFAULT_CHANNELS.map((ch) => ({ entity: `TC.CH${ch}`, label: `TC Ch${ch}`, voltageReference: 0 }))
  );
  const [rtdChannels, setRtdChannels] = useState<number[]>(RTD_DEFAULT_CHANNELS);
  const [lcChannels, setLcChannels] = useState<number[]>(LC_DEFAULT_CHANNELS);

  const loadChannelConfig = useCallback(() => {
    fetch(`${getApiBaseUrl()}/api/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        const config = data?.config;
        const boards = config?.boards;
        const adc = config?.adc;
        if (adc && typeof adc.internal_v === 'number' && typeof adc.absolute_5v_v === 'number') {
          useSensorStore.getState().setVoltageRefNominals({ internalV: adc.internal_v, absolute5vV: adc.absolute_5v_v });
        }
        if (!boards) return;
        const tc = buildTcChannelsWithRef(boards);
        if (tc.length) setTcData(tc);
        const rtd = buildChannels(boards, 'RTD');
        if (rtd.length) setRtdChannels(rtd);
        const lc = buildChannels(boards, 'LC');
        if (lc.length) setLcChannels(lc);
      })
      .catch(() => {/* keep defaults on failure */});
  }, []);

  useEffect(() => {
    loadChannelConfig();
  }, [loadChannelConfig]);

  const loadPtSensors = useCallback(() => {
    fetch(`${getApiBaseUrl()}/api/sensor-config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        const sensors = data?.sensors as any[] | undefined;
        if (!Array.isArray(sensors)) return;

        const mapped = sensors
          .filter((s) => typeof s?.calEntity === 'string' && (s.calEntity as string).startsWith('PT_Cal.'))
          .map((s) => {
            const role = String(s.role || s.calEntity);
            const entity = String(s.calEntity);
            return {
              label: role,
              entity,
              color: getEntityColor(entity),
              channelId: typeof s.id === 'number' ? s.id : undefined,
              boardId: typeof s.boardId === 'number' ? s.boardId : undefined,
              boardIp: typeof s.boardIp === 'string' ? s.boardIp : undefined,
              isHpPt: !!s.isHpPt,
            } as PtSensor & { isHpPt?: boolean };
          });

        const pt = mapped
          .filter((s: any) => !s.isHpPt)
          .sort((a: any, b: any) => (a.boardId ?? 0) - (b.boardId ?? 0) || (a.channelId ?? 0) - (b.channelId ?? 0));
        const hpt = mapped
          .filter((s: any) => !!s.isHpPt)
          .sort((a: any, b: any) => (a.boardId ?? 0) - (b.boardId ?? 0) || (a.channelId ?? 0) - (b.channelId ?? 0));

        setPtSensors(pt);
        setHptSensors(hpt);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadPtSensors();
  }, [loadPtSensors]);

  // ── Board-level DAQ breakdown (approximate, from per-entity stream rates) ────
  const pt21Keys = ptSensors
    .filter((s) => (s.boardId ?? 21) === 21)
    .map((s) => ({ entity: s.entity, component: 'pressure_psi' }));
  const pt22Keys = hptSensors
    .filter((s) => (s.boardId ?? 22) === 22)
    .map((s) => ({ entity: s.entity, component: 'pressure_psi' }));
  const tcKeys = tcData.map((d) => ({ entity: d.entity, component: 'raw_adc_counts' }));
  const rtdKeys = rtdChannels.map((ch) => ({ entity: `RTD.CH${ch}`, component: 'raw_resistance_counts' }));
  const lcKeys = lcChannels.map((ch) => ({ entity: `LC.CH${ch}`, component: 'raw_adc_counts' }));

  const pt21Rate = useBoardRate(pt21Keys);
  const pt22Rate = useBoardRate(pt22Keys);
  const tcRate = useBoardRate(tcKeys);
  const rtdRate = useBoardRate(rtdKeys);
  const lcRate = useBoardRate(lcKeys);

  useEffect(() => {
    ws.connect();
    const unsub = ws.on(MessageType.CONFIG_UPDATED, () => { loadChannelConfig(); loadPtSensors(); });
    return () => { unsub(); };
  }, [ws, loadChannelConfig, loadPtSensors]);

  return (
    <main className="h-full bg-background text-text overflow-auto">
      <div className="p-4 flex flex-col gap-4 max-w-7xl mx-auto">

        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-bold tracking-widest text-gray-300 uppercase">Sensor Info</h1>
          <span className="text-xs text-gray-500 font-mono">ADC · Converted · Rate = updates/sec per channel received by GUI</span>
        </div>

        <div className="flex flex-wrap gap-3 mb-2">
          <div className="bg-card border border-gray-800 rounded-lg px-4 py-3 text-xs font-mono text-gray-300">
            <div className="text-[10px] uppercase text-gray-500 tracking-widest mb-1">DAQ Stream (Elodin DB)</div>
            <div className="flex gap-6 items-baseline">
              <div>
                <span className="text-gray-500 mr-1">Packets:</span>
                <span className="text-cyan-400">{relayPackets != null ? relayPackets.toLocaleString() : '---'}</span>
              </div>
              <div>
                <span className="text-gray-500 mr-1">Rate:</span>
                <span className="text-cyan-400">{fmtHz(relayRateHz)} Hz</span>
              </div>
            </div>
            <div className="text-[10px] text-gray-600 mt-1">
              Total packets/sec from Elodin DB seen by the backend (all sensor types combined).
            </div>
          </div>

          <div className="bg-card border border-gray-800 rounded-lg px-4 py-3 text-[11px] font-mono text-gray-300 flex flex-col gap-1">
            <div className="text-[10px] uppercase text-gray-500 tracking-widest mb-1">
              Board Total Rates (all channels summed)
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-x-4 gap-y-1">
              <div>
                <div className="text-[10px] text-gray-500">PT B21</div>
                <div className="text-cyan-400">{fmtHz(pt21Rate)} Hz</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">HPT B22</div>
                <div className="text-cyan-400">{fmtHz(pt22Rate)} Hz</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">TC B51</div>
                <div className="text-cyan-400">{fmtHz(tcRate)} Hz</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">RTD B31</div>
                <div className="text-cyan-400">{fmtHz(rtdRate)} Hz</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">LC B41</div>
                <div className="text-cyan-400">{fmtHz(lcRate)} Hz</div>
              </div>
            </div>
          </div>
        </div>

        {/* ── PT (Pressure Transducers – board 21) ─────────────────────────── */}
        <SensorTable
          title="PT — Pressure Transducers"
          color="#E67E22"
          headers={['Channel', 'ADC Code', 'Pressure', 'Rate']}
        >
          {ptSensors.length === 0 ? (
            <tr><td colSpan={4} className="px-4 py-3 text-gray-600 text-xs">Loading PT roles…</td></tr>
          ) : (
            ptSensors.map((s) => <PtRow key={s.entity} sensor={s} />)
          )}
        </SensorTable>

        {/* ── HPT (High-Pressure PT – board 22) ───────────────────────────── */}
        <SensorTable
          title="HPT — High-Pressure PT (4–20 mA)"
          color="#9B59B6"
          headers={['Channel', 'ADC Code', 'Pressure', 'Current', 'Rate']}
        >
          {hptSensors.length === 0 ? (
            <tr><td colSpan={5} className="px-4 py-3 text-gray-600 text-xs">Loading HP PT roles…</td></tr>
          ) : (
            hptSensors.map((s) => <HptRow key={s.entity} sensor={s} />)
          )}
        </SensorTable>

        {/* ── TC (Thermocouples – board 51) ────────────────────────────────── */}
        <SensorTable
          title="TC — Thermocouples, K-type (Board 51)"
          color="#F59E0B"
          headers={['Channel', 'ADC Code', 'Temp (derived)', 'Rate']}
        >
          {tcData.map((d, i) => (
            <TcRow
              key={d.entity}
              entity={d.entity}
              label={d.label}
              color={SENSE_COLORS[i % SENSE_COLORS.length]}
              voltageReference={d.voltageReference}
            />
          ))}
        </SensorTable>

        {/* ── RTD (board 31) ───────────────────────────────────────────────── */}
        <SensorTable
          title="RTD — Pt1000 Temperature (Board 31)"
          color="#10B981"
          headers={['Channel', 'ADC Code', 'Temp', 'Rate']}
        >
          {rtdChannels.map((ch, i) => (
            <RtdRow
              key={ch}
              entity={`RTD.CH${ch}`}
              calEntity={`RTD_Cal.CH${ch}`}
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
