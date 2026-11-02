import { fmt } from '../../layerx/format';
import type { HardwareDiag } from '../contract';

/** A time after burnout in the unit a person reads it in: "+0.55 s", "+4.1 min", "+2.9 h". */
export function afterBurnout(s: number | null | undefined): { value: string; unit: string } {
  if (s === null || s === undefined || !Number.isFinite(s)) return { value: '—', unit: '' };
  if (s < 120) return { value: `+${fmt(s, s < 10 ? 2 : 0)}`, unit: 's' };
  if (s < 2 * 3600) return { value: `+${fmt(s / 60, 1)}`, unit: 'min' };
  return { value: `+${fmt(s / 3600, 1)}`, unit: 'h' };
}

/**
 * The soak's headline figures, from the summary a run writes since 2026-10-17 or, for a run before
 * it, from its stations: the bond line behind the insert (which peaks, seconds after shutdown) and
 * the outer face (which, with both faces adiabatic, only approaches its equilibrium).
 */
export function soakFigures(soak: NonNullable<HardwareDiag['soak']>) {
  const rows = soak.stations ?? [];
  const bond = rows.length ? rows.reduce((a, b) => ((b.T_interface_peak_K ?? -Infinity) > (a.T_interface_peak_K ?? -Infinity) ? b : a)) : null;
  const back = rows.find((r) => r.station === soak.station) ?? null;
  const asymptotic = soak.asymptotic ?? (soak.t_peak_s !== null && soak.t_peak_s !== undefined && soak.duration_s
    ? soak.t_peak_s > 0.5 * soak.duration_s : false);
  return {
    bondK: soak.interface_peak_K ?? bond?.T_interface_peak_K ?? null,
    bondT: soak.t_interface_peak_s ?? bond?.t_interface_peak_s ?? null,
    bondStation: soak.interface_station ?? bond?.station ?? null,
    outerK: soak.peak_K ?? null,
    outerT: asymptotic ? soak.t_95_s ?? back?.t_back_95_s ?? null : soak.t_peak_s ?? null,
    asymptotic,
  };
}
