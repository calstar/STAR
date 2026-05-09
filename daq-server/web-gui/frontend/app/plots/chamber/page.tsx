'use client'

import { useCallback, useEffect, useState } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import ActuatorStatePanel from '@/components/plots/ActuatorStatePanel';
import { useSensorStore, useSensorValue, useLoadCellForceKg } from '@/lib/store';
import { getApiBaseUrl, getWebSocketClient } from '@/lib/websocket';
import { MessageType } from '@/lib/types';
import { getEntityColor, getActuatorColor } from '@/lib/sensor-colors';
import { useSensorConfig } from '@/lib/sensor-config';

/** Chamber PT role names in display order (config: sensor_roles_pt_board channels 4, 8, 9, 10). */
const CHAMBER_PT_ROLES_ORDER = ['Chamber Mid PT 1', 'Chamber Mid PT 2', 'Chamber Throat PT 1', 'Chamber Throat PT 2'];
const WINDOW_SECONDS = 60;

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


const READOUT_CARD_CLASS = 'bg-white/[0.02] border border-white/5 rounded-lg px-3 py-2.5 flex items-center gap-3 min-w-[5rem] flex-1 basis-0';

function fmtPsi(value: number): string {
  return Math.abs(value) < 10 ? value.toFixed(1) : value.toFixed(0);
}

function PtPsiCompact({ entity, label, color }: { entity: string; label: string; color: string }) {
  const value = useSensorValue(entity, 'pressure_psi');
  const display = value !== null && Number.isFinite(value) ? fmtPsi(value) : '—';
  return (
    <div className={READOUT_CARD_CLASS}>
      <span className="text-xs text-gray-400 font-bold uppercase tracking-widest truncate">{label}</span>
      <span className="text-lg font-black font-mono tabular-nums ml-auto" style={{ color }}>{display}</span>
      <span className="text-xs text-gray-500 font-semibold uppercase">PSI</span>
    </div>
  );
}

function TcTempCompact({ calEntity, label, color }: { entity: string; calEntity: string; label: string; color: string; voltageReference: number }) {
  const value = useSensorValue(calEntity, 'temperature_c');
  const display = value !== null && Number.isFinite(value) ? value.toFixed(1) : '—';
  return (
    <div className={READOUT_CARD_CLASS}>
      <span className="text-xs text-gray-400 font-bold uppercase tracking-widest truncate">{label}</span>
      <span className="text-lg font-black font-mono tabular-nums ml-auto" style={{ color }}>{display}</span>
      <span className="text-xs text-gray-500 font-semibold uppercase">°C</span>
    </div>
  );
}

function LcKgCompact({ calEntity, label, color }: { entity: string; calEntity: string; label: string; color: string }) {
  const value = useLoadCellForceKg(calEntity); // offset already applied in store, C++ outputs kg
  const display = value !== null && Number.isFinite(value) ? value.toFixed(1) : '—';
  return (
    <div className={READOUT_CARD_CLASS}>
      <span className="text-xs text-gray-400 font-bold uppercase tracking-widest truncate">{label}</span>
      <span className="text-lg font-black font-mono tabular-nums ml-auto" style={{ color }}>{display}</span>
      <span className="text-xs text-gray-500 font-semibold uppercase">kg</span>
    </div>
  );
}

export default function ChamberGraphsPage() {
    const ws = getWebSocketClient();
    const allSensors = useSensorConfig();
    // Chamber PTs only (exclude TC/LC with "Chamber" in role); order Mid 1, Mid 2, Throat 1, Throat 2
    const ptSensors = CHAMBER_PT_ROLES_ORDER
      .map((role) =>
        allSensors.find((s) => {
          const calEntity = s.calEntity;
          return (calEntity.startsWith('PT_Cal.') || /^PT\d+_Cal\.CH\d+$/.test(calEntity)) && s.role === role;
        })
      )
      .filter((s): s is NonNullable<typeof s> => s != null);

    const [tcData, setTcData] = useState<{ entity: string; label: string; voltageReference: number }[]>([]);
    const [lcEntities, setLcEntities] = useState<string[]>([]);
    const [lcLabels, setLcLabels] = useState<string[]>([]);

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
          const allTc = buildTcChannelsWithRef(boards);
          const tc = allTc.filter((d) => {
            const ch = parseInt(d.entity.replace('TC.CH', ''), 10);
            return [2, 3, 4, 5].includes(ch);
          });
          if (tc.length) setTcData(tc);
          const lc = buildChannels(boards, 'LC');
          if (lc.length) {
            setLcEntities(lc.map((ch) => `LC.CH${ch}`));
            setLcLabels(lc.map((ch) => `LC Ch${ch}`));
          }
        })
        .catch(() => {});
    }, []);

    useEffect(() => { loadChannelConfig(); }, [loadChannelConfig]);
    useEffect(() => {
        const unsub = ws.on(MessageType.CONFIG_UPDATED, () => loadChannelConfig());
        return () => { unsub(); };
    }, [ws, loadChannelConfig]);

    const tcEntities = tcData.map((d) => d.entity);
    const tcCalEntities = tcData.map((d) => d.entity.replace('TC.', 'TC_Cal.'));
    const tcLabels = tcData.map((d) => d.label);
    const lcCalEntities = lcEntities.map((e) => e.replace('LC.', 'LC_Cal.'));

    const ptEntities = ptSensors.map(s => s.calEntity);
    const ptLabels = ptSensors.map(s => s.role);
    const ptColors = ptEntities.map(e => getEntityColor(e));
    const tcColors = tcEntities.map(e => getEntityColor(e));
    const lcColors = lcEntities.map(e => getEntityColor(e));

    return (
        <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

            <div className="flex items-center flex-shrink-0 justify-between">
                <div className="flex items-center">
                    <div className="w-1 h-5 bg-orange-500 rounded-full mr-3" />
                    <h1 className="text-base font-bold text-orange-400 tracking-wider">CHAMBER SYSTEM</h1>
                </div>
                <div className="flex gap-2 bg-gray-900 rounded-lg p-1">
                    <div className="px-4 py-1.5 text-sm font-bold rounded-md bg-gray-800 text-gray-300">
                        Unified View
                    </div>
                </div>
            </div>

            <div className="flex-shrink-0 rounded-lg bg-card border border-gray-800 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Pressure & live readouts</div>
                <div className="flex min-w-0 overflow-x-auto flex-wrap gap-2">
                        {ptSensors.map((s, i) => (
                            <PtPsiCompact key={s.calEntity} entity={s.calEntity} label={['Mid 1', 'Mid 2', 'Throat 1', 'Throat 2'][i] ?? `P${i + 1}`} color={getEntityColor(s.calEntity)} />
                        ))}
                        {tcData.map((d, i) => (
                            <TcTempCompact key={d.entity} entity={d.entity} calEntity={d.entity.replace('TC.', 'TC_Cal.')} label={d.label.replace('TC Ch', 'TC')} color={tcColors[i] ?? getEntityColor(d.entity)} voltageReference={d.voltageReference} />
                        ))}
                        {lcEntities.map((e, i) => (
                            <LcKgCompact key={e} entity={e} calEntity={e.replace('LC.', 'LC_Cal.')} label={`LC${i + 1}`} color={lcColors[i] ?? getEntityColor(e)} />
                        ))}
                    </div>
            </div>

            <div className="flex-1 min-h-0 flex flex-col gap-2">
                {/* 3 columns of graphs side-by-side */}
                <div className="flex-[3] min-h-0 flex flex-row gap-2 min-w-0">
                    <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0">
                        <TimeSeriesPlot title="Chamber PT Pressures" entities={ptEntities} labels={ptLabels} component="pressure_psi" colors={ptColors} yLabel="Pressure (PSI)" />
                    </div>
                    <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0 gap-2">
                        <div className="flex-1 min-h-0 flex flex-col">
                            <div className="text-xs font-medium text-gray-500 flex-shrink-0 px-1">TC Temperatures (°C)</div>
                            {tcEntities.length > 0 ? (
                              <TimeSeriesPlot title="" entities={tcCalEntities} component="temperature_c" yLabel="Temperature (°C)" labels={tcLabels} colors={tcColors} windowSeconds={WINDOW_SECONDS} />
                            ) : (
                              <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">No TC boards in config</div>
                            )}
                        </div>
                        <div className="flex-1 min-h-0 flex flex-col">
                            <div className="text-xs font-medium text-gray-500 flex-shrink-0 px-1">LC Forces (kg)</div>
                            {lcEntities.length > 0 ? (
                              <TimeSeriesPlot title="" entities={lcCalEntities} component="force_kg" yLabel="Force (kg)" labels={lcLabels} colors={lcColors} windowSeconds={WINDOW_SECONDS} />
                            ) : (
                              <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">No LC boards in config</div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="flex-[1] min-h-[200px] flex-shrink-0 overflow-auto">
                    <ActuatorStatePanel
                        title="Chamber Actuators"
                        actuators={[
                            { label: 'LOX Main', entity: 'ACT.LOX_Main', color: getActuatorColor('ACT.LOX_Main') },
                            { label: 'Fuel Main', entity: 'ACT.Fuel_Main', color: getActuatorColor('ACT.Fuel_Main') },
                        ]}
                    />
                </div>
            </div>

        </main>
    );
}
