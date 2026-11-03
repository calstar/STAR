import type { EngineConfig, ProfileParams } from '../api/client';

/** The design's tanks are held by a regulator unless it says they blow down (the schema's default
 *  is ``dome_regulated``). */
export function isRegulated(config: EngineConfig | null): boolean {
  const dr = config?.design_requirements as Record<string, unknown> | undefined;
  return (dr?.feed_pressure_model ?? 'dome_regulated') !== 'blowdown';
}

/** The Simple Profile a design starts from, at its tank pressure ``p0``. A regulated design holds
 *  that pressure through the burn; a blowdown one decays from it (to 70 % unless the person set an
 *  end below it). It used to decay for every design, so a regulated stand's first Time-Series was a
 *  578 -> 405 psia blowdown it never sees. */
export function seededProfile(prev: ProfileParams, p0: number, regulated: boolean): ProfileParams {
  const start = Math.round(p0 * 10) / 10;
  if (regulated) return { ...prev, start_pressure_psi: start, end_pressure_psi: start, profile_type: 'linear' };
  return {
    ...prev,
    start_pressure_psi: start,
    end_pressure_psi: prev.end_pressure_psi < start ? prev.end_pressure_psi : Math.round(0.7 * start),
  };
}
