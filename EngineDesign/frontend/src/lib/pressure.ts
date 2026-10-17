/**
 * Pressures as people read them: psia for an absolute pressure, psi for a difference.
 *
 * EngineDesign's model is absolute throughout: a `*_psi` field (tank, chamber, the Forward Mode
 * inputs) is an absolute pressure, and `*_pa` / `[Pa]` values are absolute pascals. The screens
 * used to label all of them "psi", so 578 typed into Forward Mode read as gauge while the model
 * took it as absolute (P_inj = 578 - 41.9 psi of feed loss = 536.1 psia). The labels say psia
 * now; nothing is converted on the wire.
 *
 * A difference -- a drop, a bias, a band, a tolerance, an excursion -- has no atmosphere in it and
 * is plain psi.
 */

export const PA_PER_PSI = 6894.757293168361;
export const ATMOSPHERE_PSI = 101325 / PA_PER_PSI;

/** The unit to print for an absolute pressure. */
export const PSIA = 'psia';
/** The unit to print for a pressure difference. */
export const PSI_DIFF = 'psi';

// Key words that make a pressure-valued field a difference rather than an absolute pressure.
const DIFFERENCE = /(^|_)(dp|delta|drop|droop|bias|differential|excursion|band|tol|tolerance|scale|margin|deadband|rise|sag|hammer)(_|$)/i;

/** Is this field (a config key, or a quantity name like "P_inj_O = P_tank - dP_feed") a pressure
 *  difference? Only the quantity itself counts, not the formula after it. */
export function isPressureDifference(name: string): boolean {
  const head = name.trim().split(/[\s=]/)[0];
  if (/^(Δ|d)P/.test(head)) return true;
  return DIFFERENCE.test(head);
}

/** The display unit for a field whose stored unit is `psi`: psia unless it is a difference. */
export function psiUnitFor(name: string): string {
  return isPressureDifference(name) ? PSI_DIFF : PSIA;
}

/** Pa -> psi, no rounding. */
export function paToPsi(pa: number): number {
  return pa / PA_PER_PSI;
}

/** An absolute pressure in Pa as "536.1 psia" (difference: "41.9 psi"). */
export function fmtPa(pa: number, { places = 1, difference = false } = {}): string {
  if (!Number.isFinite(pa)) return '—';
  const v = paToPsi(pa);
  return `${v.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places })} ${difference ? PSI_DIFF : PSIA}`;
}

/**
 * A value the backend formatted as text ("3.6964e+06 Pa", "98019 Pa"), as a person reads it:
 * pascals become psia (psi when `name` says it is a difference). Anything else is returned as is.
 */
export function friendlyPressureText(name: string, text: string): string {
  const m = /^\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*Pa\s*$/i.exec(text);
  if (!m) return text;
  return fmtPa(Number(m[1]), { places: 1, difference: isPressureDifference(name) });
}
