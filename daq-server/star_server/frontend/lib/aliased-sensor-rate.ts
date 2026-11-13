/**
 * Sensor Hz from actual WS update timestamps (see sensor-rate.ts), with the same
 * entity aliases as the Zustand store (e.g. legacy ENC.CH* → ENC1.CH*).
 *
 * Board status `frequencyHz` is derived from **heartbeats** on the backend — not
 * sensor scan rate — so UI that needs stream rate must use this, not BoardStatus.frequencyHz.
 */

import { useEffect, useState } from 'react';
import { ALIASES } from './store';
import { getSensorRate } from './sensor-rate';

export function getAliasedSensorRate(entity: string, component: string): number {
  const key = `${entity}.${component}`;
  let best = getSensorRate(entity, component);
  const fallbacks = ALIASES[key];
  if (fallbacks) {
    for (const fb of fallbacks) {
      const i = fb.lastIndexOf('.');
      if (i <= 0) continue;
      const fbEntity = fb.slice(0, i);
      const fbComponent = fb.slice(i + 1);
      best = Math.max(best, getSensorRate(fbEntity, fbComponent));
    }
  }
  return best;
}

export function useAliasedSensorRate(entity: string, component: string, intervalMs = 500): number {
  const [rate, setRate] = useState(0);
  useEffect(() => {
    const compute = () => setRate(getAliasedSensorRate(entity, component));
    compute();
    const id = setInterval(compute, intervalMs);
    return () => clearInterval(id);
  }, [entity, component, intervalMs]);
  return rate;
}
