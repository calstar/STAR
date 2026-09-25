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
