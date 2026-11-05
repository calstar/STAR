import type { EngineConfig } from '../api/client';

/**
 * A key for "which engine is this, physically".
 *
 * Forward Mode keeps its tabs mounted, so nothing used to clear `results` when the config changed:
 * after switching methalox -> ethalox the Combustion stability panel kept showing the previous
 * propellant's frequencies, lags, radar and verdict, beside tank pressures that had already moved
 * to the new config. The stability sensitivity overrides survived too, so a methane-tuned SMD was
 * applied to ethanol on the next evaluation.
 *
 * Keyed on propellants and injector only — deliberately NOT on the whole config. Retuning a tank
 * pressure, a chamber length or a cooling parameter leaves your results on screen, because those
 * results still describe the same engine; changing what it burns or how it injects does not.
 */
export function engineIdentity(config: EngineConfig | null | undefined): string {
  if (!config) return '';
  const fluids = config.fluids as Record<string, { name?: string }> | undefined;
  const injector = config.injector as Record<string, unknown> | undefined;
  return [
    config.propellant_preset ?? '',
    injector?.type ?? '',
    fluids?.oxidizer?.name ?? '',
    fluids?.fuel?.name ?? '',
  ].join('|');
}

/**
 * What a change of engine identity does to a displayed result.
 *
 * `prev` is '' until a config has arrived: the design opening on page load is adopted, never
 * treated as a change -- there is nothing on screen to clear, and the "propellant or injector
 * changed" banner it used to raise greeted every fresh visitor. Between two real engines the
 * result is cleared, and the banner says so only when there was a result to clear.
 */
export function identityTransition(prev: string, next: string, hadResult: boolean): { clear: boolean; warn: boolean } {
  if (prev === next || prev === '' || next === '') return { clear: false, warn: false };
  return { clear: true, warn: hadResult };
}

/** JSON with object keys sorted, so the same config always serializes the same way. */
/** JSON with object keys sorted, so two equal values always give the same string. */
export function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

/**
 * A key for "this exact design": every field, less the tank setpoints (a Time-Series curve sets its
 * own pressures, so moving the setpoint does not change what the curve ran on). A burn made on one
 * fingerprint is not shown against another.
 */
export function configFingerprint(config: EngineConfig | null | undefined): string {
  if (!config) return '';
  const c = JSON.parse(JSON.stringify(config)) as Record<string, Record<string, unknown> | undefined>;
  for (const t of ['lox_tank', 'fuel_tank']) if (c[t]) delete c[t]!.initial_pressure_psi;
  const s = stable(c);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
