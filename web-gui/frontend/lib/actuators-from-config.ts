/**
 * Actuator list driven by config.toml actuator_roles.
 * All frontend actuator references (labels, entities) should use this so they stay in sync with config.
 */

import React from 'react';
import { getApiBaseUrl } from './websocket';

export interface ActuatorFromConfig {
  name: string;
  entity: string;
  channel: number;
  boardId?: number;
  boardIp?: string;
}

let cached: ActuatorFromConfig[] | null = null;

function entityFromName(name: string): string {
  return `ACT.${name.replace(/\s+/g, '_')}`;
}

/**
 * Fetch actuator_roles from /api/config and return list of { name, entity, channel, boardIp? }.
 * Entity is ACT.{name_with_underscores} to match backend.
 */
export async function fetchActuatorsFromConfig(): Promise<ActuatorFromConfig[]> {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/config`);
    if (!res.ok) return [];
    const data = await res.json();
    const roles = data?.config?.actuator_roles ?? data?.actuator_roles;
    if (!roles || typeof roles !== 'object') return [];
    const list: ActuatorFromConfig[] = Object.entries(roles).map(([name, value]) => {
      const arr = Array.isArray(value) ? value : [];
      // [type, channel] or [type, channel, board_id number] or [type, channel, board_ip string]
      const channel = arr.length >= 2 && typeof arr[1] === 'number' ? arr[1] : 1;
      const boardId = arr.length >= 3 && typeof arr[2] === 'number' ? arr[2] : undefined;
      const boardIp = arr.length >= 3 && typeof arr[2] === 'string' ? arr[2] : undefined;
      return { name, entity: entityFromName(name), channel, boardId, boardIp };
    });
    return list;
  } catch {
    return [];
  }
}

/**
 * Get actuators from config (cached per session). Call invalidateActuatorsCache() after config changes.
 */
export function getCachedActuators(): ActuatorFromConfig[] | null {
  return cached;
}

export function setCachedActuators(list: ActuatorFromConfig[]): void {
  cached = list;
}

export function invalidateActuatorsCache(): void {
  cached = null;
}

/**
 * React hook: fetch actuators from config once and cache. Returns list and loading state.
 * Use in client components: const { actuators, loading } = useActuatorsFromConfig();
 */
export function useActuatorsFromConfig(): { actuators: ActuatorFromConfig[]; loading: boolean } {
  const [actuators, setActuators] = React.useState<ActuatorFromConfig[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (cached) {
      setActuators(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchActuatorsFromConfig()
      .then((list) => {
        setCachedActuators(list);
        setActuators(list);
      })
      .finally(() => setLoading(false));
  }, []);

  return { actuators, loading };
}
