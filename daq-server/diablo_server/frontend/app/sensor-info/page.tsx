'use client'

import { useCallback, useEffect, useState } from 'react';
import { useSensorStore, useSensorValue, useStaleRenderTick } from '@/lib/store';
import { BOARD_LIVE_TELEMETRY_STALE_MS } from '@/lib/sensor-rate';
import { getWebSocketClient, getApiBaseUrl } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';
import { getAliasedSensorRate, useAliasedSensorRate } from '@/lib/aliased-sensor-rate';
import { getEntityColor } from '@/lib/sensor-colors';
import {
  buildActChannelsFromBoards,
  buildEncoderDataFromBoards,
  buildLcDataFromBoards,
  buildRtdDataFromBoards,
  buildTcDataFromBoards,
  SENSOR_INFO_DEFAULT_ACT_DATA,
  SENSOR_INFO_DEFAULT_ENCODER_DATA,
  SENSOR_INFO_DEFAULT_LC_DATA,
  SENSOR_INFO_DEFAULT_RTD_DATA,
  SENSOR_INFO_DEFAULT_TC_DATA,
  type RtdLcRowConfig,
  type TcRowConfig,
  type EncoderRowConfig,
} from '@/lib/sensor-info-entities';

// ── Constants ────────────────────────────────────────────────────────────────


// ── Static sensor definitions ─────────────────────────────────────────────────

interface PtSensor {
  label: string;
  rawEntity: string;  // PT.CH1 — for raw_adc_counts
  calEntity: string;  // PT_Cal.CH1 — for pressure_psi
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

function fmtCurrent(v: number | null): string {
  if (v === null || !isFinite(v)) return '---';
  return v.toFixed(3);
}

function fmtResistance(v: number | null): string {
  if (v === null || !isFinite(v)) return '---';
  return v.toFixed(3);
}

/** AS5600 12-bit angle → degrees (same as encoders pane). */
const ENC_RAW_TO_DEG = 360.0 / 4096.0;
function encRawToDeg(raw: number): number {
  return (raw & 0x0fff) * ENC_RAW_TO_DEG;
}

function fmtDeg(v: number | null): string {
  if (v === null || !isFinite(v)) return '---';
  return encRawToDeg(v).toFixed(1);
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
  // ADC code read from cal entity — calibration_service always publishes raw u32 alongside converted value.
  const adc     = useSensorValue(sensor.calEntity, 'raw_adc_counts');
  const psi     = useSensorValue(sensor.calEntity, 'pressure_psi');
  const rateAdc = useAliasedSensorRate(sensor.calEntity, 'raw_adc_counts');
  const ratePsi = useAliasedSensorRate(sensor.calEntity, 'pressure_psi');
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
  const adc      = useSensorValue(sensor.calEntity, 'raw_adc_counts');
  const psi      = useSensorValue(sensor.calEntity, 'pressure_psi');
  const rateAdc  = useAliasedSensorRate(sensor.calEntity, 'raw_adc_counts');
  const ratePsi  = useAliasedSensorRate(sensor.calEntity, 'pressure_psi');
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
      <td className="px-4 py-2 tabular-nums text-cyan-400">{fmtHz(rate)} <span className="text-gray-600 text-xs">Hz</span></td>
    </tr>
  );
}

// ── TC row ───────────────────────────────────────────────────────────────────

function TcRow({ entity: _entity, calEntity, label, color }: { entity: string; calEntity: string; label: string; color: string; voltageReference: number }) {
  const adc  = useSensorValue(calEntity, 'raw_adc_counts');
  const tempC = useSensorValue(calEntity, 'temperature_c');
  const rateAdc = useAliasedSensorRate(calEntity, 'raw_adc_counts');
  const rateCal = useAliasedSensorRate(calEntity, 'temperature_c');
  const rate = Math.max(rateAdc, rateCal);

  return (
    <tr className="border-b border-gray-800/40 hover:bg-gray-900/30 transition-colors">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
          <span className="text-gray-200 font-sans font-medium text-xs">{label}</span>
        </div>
      </td>
      <td className="px-4 py-2 tabular-nums text-purple-300">{fmtAdc(adc)}</td>
      <td className="px-4 py-2 tabular-nums text-amber-400">
        {fmtTemp(tempC)} <span className="text-gray-600 text-xs">°C</span>
      </td>
      <td className="px-4 py-2 tabular-nums text-cyan-400">{fmtHz(rate)} <span className="text-gray-600 text-xs">Hz</span></td>
    </tr>
  );
}

// ── RTD row ──────────────────────────────────────────────────────────────────

function RtdRow({ entity: _entity, calEntity, label, color }: { entity: string; calEntity: string; label: string; color: string }) {
  // Cal packet carries raw ADC u32 at offset 16 (same field as all other types) — use raw_adc_counts on cal entity.
  const adc     = useSensorValue(calEntity, 'raw_adc_counts');
  const tempC   = useSensorValue(calEntity, 'temperature_c');
  const rateAdc = useAliasedSensorRate(calEntity, 'raw_adc_counts');
  const rateCal = useAliasedSensorRate(calEntity, 'temperature_c');
  const rate    = Math.max(rateAdc, rateCal);

  return (
    <tr className="border-b border-gray-800/40 hover:bg-gray-900/30 transition-colors">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
          <span className="text-gray-200 font-sans font-medium text-xs">{label}</span>
        </div>
      </td>
      <td className="px-4 py-2 tabular-nums text-purple-300">
        {fmtAdc(adc)}
      </td>
      <td className="px-4 py-2 tabular-nums text-green-400">
        {fmtTemp(tempC)} <span className="text-gray-600 text-xs">°C</span>
      </td>
      <td className="px-4 py-2 tabular-nums text-cyan-400">{fmtHz(rate)} <span className="text-gray-600 text-xs">Hz</span></td>
    </tr>
  );
}

// ── LC row ───────────────────────────────────────────────────────────────────

function LcRow({ entity: _entity, calEntity, label, color }: { entity: string; calEntity: string; label: string; color: string }) {
  const adc  = useSensorValue(calEntity, 'raw_adc_counts');
  const forceKg = useSensorValue(calEntity, 'force_kg');
  const rateAdc = useAliasedSensorRate(calEntity, 'raw_adc_counts');
  const rateCal = useAliasedSensorRate(calEntity, 'force_kg');
  const rate = Math.max(rateAdc, rateCal);

  return (
    <tr className="border-b border-gray-800/40 hover:bg-gray-900/30 transition-colors">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
          <span className="text-gray-200 font-sans font-medium text-xs">{label}</span>
        </div>
      </td>
      <td className="px-4 py-2 tabular-nums text-purple-300">{fmtAdc(adc)}</td>
      <td className="px-4 py-2 tabular-nums text-orange-400">
        {fmtForce(forceKg)} <span className="text-gray-600 text-xs">kg</span>
      </td>
      <td className="px-4 py-2 tabular-nums text-cyan-400">{fmtHz(rate)} <span className="text-gray-600 text-xs">Hz</span></td>
    </tr>
  );
}

// ── ACT row ──────────────────────────────────────────────────────────────

function ActRow({ entity: _entity, calEntity, label, color }: { entity: string; calEntity: string; label: string; color: string }) {
  const adc  = useSensorValue(calEntity, 'raw_adc_counts');
  const currentA = useSensorValue(calEntity, 'current_a');
  const rateAdc = useAliasedSensorRate(calEntity, 'raw_adc_counts');
  const rateCal = useAliasedSensorRate(calEntity, 'current_a');
  const rate = Math.max(rateAdc, rateCal);

  return (
    <tr className="border-b border-gray-800/40 hover:bg-gray-900/30 transition-colors">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
          <span className="text-gray-200 font-sans font-medium text-xs">{label}</span>
        </div>
      </td>
      <td className="px-4 py-2 tabular-nums text-purple-300">{fmtAdc(adc)}</td>
      <td className="px-4 py-2 tabular-nums text-yellow-400">
        {fmtCurrent(currentA)} <span className="text-gray-600 text-xs">A</span>
      </td>
      <td className="px-4 py-2 tabular-nums text-cyan-400">{fmtHz(rate)} <span className="text-gray-600 text-xs">Hz</span></td>
    </tr>
  );
}

// ── Encoder row (raw_angle counts → °) ───────────────────────────────────────

function EncRow({ row, color }: { row: EncoderRowConfig; color: string }) {
  const raw = useSensorValue(row.entity, 'raw_angle');
  const rate = useAliasedSensorRate(row.entity, 'raw_angle');

  return (
    <tr className="border-b border-gray-800/40 hover:bg-gray-900/30 transition-colors">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
          <span
            className="text-gray-200 font-sans font-medium text-xs"
            title={`Board ${row.boardId}`}
          >
            B{row.boardId} {row.label}
          </span>
        </div>
      </td>
      <td className="px-4 py-2 tabular-nums text-purple-300">{fmtAdc(raw)}</td>
      <td className="px-4 py-2 tabular-nums text-violet-300">
        {fmtDeg(raw)} <span className="text-gray-600 text-xs">°</span>
      </td>
      <td className="px-4 py-2 tabular-nums text-cyan-400">{fmtHz(rate)} <span className="text-gray-600 text-xs">Hz</span></td>
    </tr>
  );
}

const SENSE_COLORS = ['#F59E0B', '#10B981', '#3B82F6', '#EC4899', '#F87171', '#A78BFA', '#34D399', '#FBBF24', '#60A5FA', '#E879F9'];

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SensorInfoPage() {
  const ws = getWebSocketClient();

  // ── DAQ / relay data-rate probe (Elodin relay → backend) ────────────────────
  const [relayPackets, setRelayPackets] = useState<number | null>(null);
  const [relayRateHz, setRelayRateHz] = useState<number>(0);
  /** Backend avg per-channel Hz per board group from Elodin ingest (pre-WS-throttle ≈ scan rate). */
  const [boardScanHz, setBoardScanHz] = useState({
    pt1: 0, pt2: 0, tc: 0, rtd: 0, lc: 0, act: 0, enc: 0,
  });
  /** Wall time of last successful `/api/debug` response (ingest + board scan metrics). */
  const [lastDebugPollOkMs, setLastDebugPollOkMs] = useState<number | null>(null);
  useStaleRenderTick();

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
          const b = data.boardScanRateHz;
          if (b && typeof b === 'object') {
            setBoardScanHz({
              pt1: typeof b.pt1 === 'number' ? b.pt1 : 0,
              pt2: typeof b.pt2 === 'number' ? b.pt2 : 0,
              tc: typeof b.tc === 'number' ? b.tc : 0,
              rtd: typeof b.rtd === 'number' ? b.rtd : 0,
              lc: typeof b.lc === 'number' ? b.lc : 0,
              act: typeof b.act === 'number' ? b.act : 0,
              enc: typeof b.enc === 'number' ? b.enc : 0,
            });
          }
          setLastDebugPollOkMs(now);
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
  const [tcData, setTcData] = useState<TcRowConfig[]>(SENSOR_INFO_DEFAULT_TC_DATA);
  const [rtdData, setRtdData] = useState<RtdLcRowConfig[]>(SENSOR_INFO_DEFAULT_RTD_DATA);
  const [lcData, setLcData] = useState<RtdLcRowConfig[]>(SENSOR_INFO_DEFAULT_LC_DATA);
  const [actData, setActData] = useState<
    { entity: string; calEntity: string; label: string; boardId: number; localCh: number }[]
  >(SENSOR_INFO_DEFAULT_ACT_DATA);
  const [encData, setEncData] = useState<EncoderRowConfig[]>(SENSOR_INFO_DEFAULT_ENCODER_DATA);

  const loadChannelConfig = useCallback(() => {
    fetch(`${getApiBaseUrl()}/api/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        const config = data?.config;
        const boards = config?.boards;
        const encRoles = config?.sensor_roles_encoder_board as Record<string, number> | undefined;
        const adc = config?.adc;
        if (adc && typeof adc.internal_v === 'number' && typeof adc.absolute_5v_v === 'number') {
          useSensorStore.getState().setVoltageRefNominals({ internalV: adc.internal_v, absolute5vV: adc.absolute_5v_v });
        }
        if (!boards) return;
        const tc = buildTcDataFromBoards(boards as Record<string, unknown>);
        if (tc.length) setTcData(tc);
        const rtd = buildRtdDataFromBoards(boards as Record<string, unknown>);
        if (rtd.length) setRtdData(rtd);
        const lc = buildLcDataFromBoards(boards as Record<string, unknown>);
        if (lc.length) setLcData(lc);
        const act = buildActChannelsFromBoards(boards as Record<string, unknown>);
        if (act.length) setActData(act);
        const enc = buildEncoderDataFromBoards(boards as Record<string, unknown>, encRoles ?? null);
        if (enc.length) setEncData(enc);
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
          .filter((s) => {
            if (typeof s?.calEntity !== 'string') return false;
            const calEntity = s.calEntity as string;
            return calEntity.startsWith('PT_Cal.') || /^PT\d+_Cal\.CH\d+$/.test(calEntity);
          })
          .map((s) => {
            const role = String(s.role || s.calEntity);
            const calEntity = String(s.calEntity);
            const rawEntity = String(s.entity);
            return {
              label: role,
              rawEntity,
              calEntity,
              color: getEntityColor(calEntity),
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

  useEffect(() => {
    const unsub = ws.on(MessageType.CONFIG_UPDATED, () => { loadChannelConfig(); loadPtSensors(); });
    return () => { unsub(); };
  }, [ws, loadChannelConfig, loadPtSensors]);

  const ingestMetricsStale =
    lastDebugPollOkMs != null && Date.now() - lastDebugPollOkMs >= BOARD_LIVE_TELEMETRY_STALE_MS;

  return (
    <main className="h-full bg-background text-text overflow-auto">
      <div className="p-4 flex flex-col gap-4 max-w-7xl mx-auto">

        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-bold tracking-widest text-gray-300 uppercase">Sensor Info</h1>
          <span className="text-xs text-gray-500 font-mono">ADC · Converted · per-row rate = this browser; header = ingest Hz per channel (pre-throttle, from Elodin)</span>
        </div>

        <div className="flex flex-wrap gap-3 mb-2">
          <div className="bg-card border border-gray-800 rounded-lg px-4 py-3 text-xs font-mono text-gray-300">
            <div className="text-[10px] uppercase text-gray-500 tracking-widest mb-1">Backend Ingest (from Elodin DB)</div>
            <div className="flex gap-6 items-baseline">
              <div>
                <span className="text-gray-500 mr-1">Packets:</span>
                <span className="text-cyan-400" data-testid="sensor-info-packets-count">
                  {ingestMetricsStale ? '---' : relayPackets != null ? relayPackets.toLocaleString() : '---'}
                </span>
              </div>
              <div>
                <span className="text-gray-500 mr-1">Ingest Rate:</span>
                <span className="text-cyan-400" data-testid="sensor-info-ingest-rate-hz">
                  {ingestMetricsStale ? '---' : `${fmtHz(relayRateHz)} Hz`}
                </span>
              </div>
            </div>
            <div className="text-[10px] text-gray-600 mt-1">
              Total packets/sec ingested by backend from Elodin DB (all sensor types combined; not per-channel frontend rate).
            </div>
          </div>

          <div className="bg-card border border-gray-800 rounded-lg px-4 py-3 text-[11px] font-mono text-gray-300 flex flex-col gap-1">
            <div className="text-[10px] uppercase text-gray-500 tracking-widest mb-1">
              Board ingest scan rate (avg Hz / channel)
            </div>
            <div className="text-[10px] text-gray-600 mb-1">
              Mean per-channel rate from relay before WebSocket throttle (true DAQ/board delivery rate).
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-7 gap-x-4 gap-y-1" data-testid="sensor-info-board-scan">
              <div>
                <div className="text-[10px] text-gray-500">PT B21 (PT1.*)</div>
                <div className="text-cyan-400">{ingestMetricsStale ? '---' : `${fmtHz(boardScanHz.pt1)} Hz`}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">HPT B22 (PT2.*)</div>
                <div className="text-cyan-400">{ingestMetricsStale ? '---' : `${fmtHz(boardScanHz.pt2)} Hz`}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">TC B51 (TC*)</div>
                <div className="text-cyan-400">{ingestMetricsStale ? '---' : `${fmtHz(boardScanHz.tc)} Hz`}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">RTD B31 (RTD*)</div>
                <div className="text-cyan-400">{ingestMetricsStale ? '---' : `${fmtHz(boardScanHz.rtd)} Hz`}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">LC B41 (LC*)</div>
                <div className="text-cyan-400">{ingestMetricsStale ? '---' : `${fmtHz(boardScanHz.lc)} Hz`}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">ENC B61 (ENC*)</div>
                <div className="text-cyan-400">{ingestMetricsStale ? '---' : `${fmtHz(boardScanHz.enc)} Hz`}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">ACT B12/14 (ACT*)</div>
                <div className="text-cyan-400">{ingestMetricsStale ? '---' : `${fmtHz(boardScanHz.act)} Hz`}</div>
              </div>
            </div>
          </div>
        </div>

        {/* ── PT (Pressure Transducers – board 21) ─────────────────────────── */}
        <SensorTable
          title="PT — Pressure Transducers"
          color="#E67E22"
          headers={['Channel', 'ADC Code', 'Pressure', 'Frontend Rate']}
        >
          {ptSensors.length === 0 ? (
            <tr><td colSpan={4} className="px-4 py-3 text-gray-600 text-xs">Loading PT roles…</td></tr>
          ) : (
            ptSensors.map((s) => <PtRow key={s.calEntity} sensor={s} />)
          )}
        </SensorTable>

        {/* ── HPT (High-Pressure PT – board 22) ───────────────────────────── */}
        <SensorTable
          title="HPT — High-Pressure PT (4–20 mA)"
          color="#9B59B6"
          headers={['Channel', 'ADC Code', 'Pressure', 'Frontend Rate']}
        >
          {hptSensors.length === 0 ? (
            <tr><td colSpan={4} className="px-4 py-3 text-gray-600 text-xs">Loading HP PT roles…</td></tr>
          ) : (
            hptSensors.map((s) => <HptRow key={s.calEntity} sensor={s} />)
          )}
        </SensorTable>

        {/* ── TC (Thermocouples – board 51) ────────────────────────────────── */}
        <SensorTable
          title="TC — Thermocouples, K-type (Board 51)"
          color="#F59E0B"
          headers={['Channel', 'ADC Code', 'Temp (derived)', 'Frontend Rate']}
        >
          {tcData.map((d, i) => (
            <TcRow
              key={d.entity}
              entity={d.entity}
              calEntity={d.calEntity}
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
          headers={['Channel', 'ADC Code', 'Temp', 'Frontend Rate']}
        >
          {rtdData.map((d, i) => (
            <RtdRow
              key={d.entity}
              entity={d.entity}
              calEntity={d.calEntity}
              label={d.label}
              color={SENSE_COLORS[i % SENSE_COLORS.length]}
            />
          ))}
        </SensorTable>

        {/* ── LC (Load Cells – board 41) ───────────────────────────────────── */}
        <SensorTable
          title="LC — Load Cells (Board 41)"
          color="#3B82F6"
          headers={['Channel', 'ADC Code', 'Force (derived)', 'Frontend Rate']}
        >
          {lcData.map((d, i) => (
            <LcRow
              key={d.entity}
              entity={d.entity}
              calEntity={d.calEntity}
              label={d.label}
              color={SENSE_COLORS[i % SENSE_COLORS.length]}
            />
          ))}
        </SensorTable>

        {/* ── ENC (Encoders – board 61) ────────────────────────────────────── */}
        <SensorTable
          title="ENC — Magnetic Encoders (Board 61)"
          color="#7C3AED"
          headers={['Channel', 'Raw counts', 'Angle (12-bit → °)', 'Frontend Rate']}
        >
          {encData.map((row, i) => (
            <EncRow key={row.entity} row={row} color={SENSE_COLORS[i % SENSE_COLORS.length]} />
          ))}
        </SensorTable>

        {/* ── ACT (Actuators – boards 12, 14) ──────────────────────────── */}
        <SensorTable
          title="ACT — Actuator Current Sense (Boards 12, 14)"
          color="#EF4444"
          headers={['Channel', 'ADC Code', 'Current', 'Frontend Rate']}
        >
          {actData.map((d, i) => (
            <ActRow
              key={`${d.boardId}-${d.localCh}`}
              entity={d.entity}
              calEntity={d.calEntity}
              label={d.label}
              color={SENSE_COLORS[i % SENSE_COLORS.length]}
            />
          ))}
        </SensorTable>

      </div>
    </main>
  );
}
