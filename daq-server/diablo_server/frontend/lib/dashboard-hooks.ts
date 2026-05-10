'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSensorStore } from '@/lib/store';
import { getApiBaseUrl, getWebSocketClient } from '@/lib/websocket';
import { MessageType } from '@/lib/types';
import type { SensorConfig } from '@/lib/sensor-config';
import { buildPressurePlotSeriesFromSensorList, type PressurePlotSeries } from '@/lib/pressure-bar-defs';

export type ActuatorEntry = {
  name: string;
  channel: number;
  entity: string;
  boardId?: number;
};

/**
 * Fetches actuator roles from /api/config and returns them as a stable array.
 * Also handles ADC voltage reference extraction from the same response.
 * Re-fetches automatically when CONFIG_UPDATED arrives over WebSocket.
 */
export function useActuatorsFromConfig(): ActuatorEntry[] {
  const ws = getWebSocketClient();
  const [actuators, setActuators] = useState<ActuatorEntry[]>([]);

  const load = useCallback(() => {
    fetch(`${getApiBaseUrl()}/api/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { config?: { actuator_roles?: Record<string, any>; adc?: { internal_v?: number; absolute_5v_v?: number } } } | null) => {
        const config = data?.config;
        const adc = config?.adc;
        if (adc && typeof adc.internal_v === 'number' && typeof adc.absolute_5v_v === 'number') {
          useSensorStore.getState().setVoltageRefNominals({ internalV: adc.internal_v, absolute5vV: adc.absolute_5v_v });
        }
        const roles = config?.actuator_roles;
        if (!roles || typeof roles !== 'object') return;
        setActuators(
          Object.entries(roles).map(([name, value]) => {
            const channel = Array.isArray(value) && value.length >= 2 && typeof value[1] === 'number' ? value[1] : 1;
            const boardId = Array.isArray(value) && value.length >= 3 && typeof value[2] === 'number' ? value[2] : undefined;
            const entity = `ACT.${name.replace(/\s+/g, '_')}`;
            return { name, channel, entity, boardId };
          })
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const unsub = ws.on(MessageType.CONFIG_UPDATED, load);
    return () => { unsub(); };
  }, [ws, load]);

  return actuators;
}

/**
 * Fetches pressure sensor list from /api/sensor-config and returns plot series.
 * Re-fetches automatically when CONFIG_UPDATED arrives over WebSocket.
 */
export function usePressureSensors(): PressurePlotSeries[] {
  const ws = getWebSocketClient();
  const [series, setSeries] = useState<PressurePlotSeries[]>(() => buildPressurePlotSeriesFromSensorList([]));

  const load = useCallback(() => {
    fetch(`${getApiBaseUrl()}/api/sensor-config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { sensors?: SensorConfig[] } | null) => {
        setSeries(buildPressurePlotSeriesFromSensorList(data?.sensors ?? []));
      })
      .catch(() => {
        setSeries(buildPressurePlotSeriesFromSensorList([]));
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const unsub = ws.on(MessageType.CONFIG_UPDATED, load);
    return () => { unsub(); };
  }, [ws, load]);

  return series;
}
