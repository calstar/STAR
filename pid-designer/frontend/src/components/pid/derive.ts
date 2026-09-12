/**
 * Numbers the drawing writes for you, from choices you made.
 *
 * A material dropdown becomes a specific heat; an insulation choice becomes a
 * conductivity; a Cd and a bore become the Cv feed-twin's valves speak; a
 * "17 psi per 1000 psi" pair becomes one coefficient. Each lands as a
 * `default` with a reference naming what it came from, so a run report
 * counts it as derived and never as something a person measured.
 *
 * Kept out of the dialog so it can be tested without one.
 */

import type { ParamValue } from './params';
import { INSULATIONS, LINE_MATERIALS, TANK_MATERIALS, cvFromCd, paramFromPreset } from './materials';

/**
 * What to add to (or remove from) the params on save, given the options.
 *
 * `params` is what the dialog collected from the fields; the result is the
 * full set to store.
 */
export function deriveParams(
  type: string,
  options: Record<string, string>,
  params: Record<string, ParamValue>,
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = { ...params };

  if (type === 'TANK') {
    const material = TANK_MATERIALS.find(m => m.id === (options.material ?? ''));
    if (material) out.wall_capacity = paramFromPreset(material);
    else delete out.wall_capacity;

    const insulation = options.insulation ?? 'none';
    if (insulation === 'none') {
      // Bare: nothing between the tank and the room, and nothing to say.
      delete out.insulation_thickness;
      delete out.insulation_conductivity;
    } else if (insulation !== 'custom') {
      const preset = INSULATIONS.find(i => i.id === insulation);
      if (preset) out.insulation_conductivity = paramFromPreset(preset);
    }
  }

  // Cd chosen: the Cv it amounts to is written beside it, from the bore.
  // Cv chosen: a stale Cd from an earlier choice is not left behind.
  const given = options.flowCoefficient;
  if (given === 'Cd') {
    const cd = out.Cd;
    const bore = out.bore;
    if (cd && bore && bore.unit === 'mm') {
      out.Cv = { value: cvFromCd(cd.value, bore.value), unit: 'Cv', source: 'default',
        reference: `from Cd ${cd.value} and bore ${bore.value} mm: Cv = 38.0·Cd·A[in²]` };
    } else if (cd && bore && bore.unit === 'in') {
      out.Cv = { value: cvFromCd(cd.value, bore.value * 25.4), unit: 'Cv', source: 'default',
        reference: `from Cd ${cd.value} and bore ${bore.value} in: Cv = 38.0·Cd·A[in²]` };
    } else {
      delete out.Cv;
    }
  } else if (given === 'Cv') {
    delete out.Cd;
  }

  return out;
}

/**
 * A supply effect from the pair on the datasheet.
 *
 * "17 psi per 1000 psi" is stored as 17 with unit `psi/1000psi`, one of the
 * spellings feed-twin registers. A pair quoted per some other inlet drop is
 * scaled to per 1000 so the stored number reads the way the unit says.
 */
export function supplyCoefficient(risePsi: number, perInletPsi: number, source: ParamValue['source']): ParamValue | undefined {
  if (!(risePsi >= 0) || !(perInletPsi > 0)) return undefined;
  const per1000 = Math.round((risePsi * 1000 / perInletPsi) * 1000) / 1000;
  return { value: per1000, unit: 'psi/1000psi', source,
    reference: `${risePsi} psi outlet rise per ${perInletPsi} psi inlet drop` };
}

/**
 * What a line's dialog writes from its choices.
 *
 * - The material becomes feed-twin's `roughness`, or the custom figure does.
 * - "Fall, inlet − outlet" becomes the signed `elevation_change` (a rise)
 *   feed-twin reads, negated. Two names for one number; the drawing keeps
 *   the one people measure and the solver keeps the one it defines.
 * - `flex_hose` construction is what the hose flag turns into.
 *
 * Returns the params to store and the catalogue kind the line is.
 */
export function deriveLineParams(
  options: Record<string, string>,
  params: Record<string, ParamValue>,
): { params: Record<string, ParamValue>; lineType: 'pipe' | 'flex_hose'; construction?: string } {
  const out: Record<string, ParamValue> = { ...params };

  const material = LINE_MATERIALS.find(m => m.id === (options.material ?? ''));
  if (material) {
    out.roughness = paramFromPreset(material);
    delete out.roughness_custom;
  } else if (out.roughness_custom) {
    out.roughness = out.roughness_custom;
    delete out.roughness_custom;
  } else {
    delete out.roughness;
  }

  const fall = out.fall;
  delete out.fall;
  if (fall) {
    out.elevation_change = { ...fall, value: -fall.value,
      reference: fall.reference ?? 'fall, inlet − outlet, as measured' };
  } else {
    delete out.elevation_change;
  }

  const hose = options.hose ?? 'no';
  return hose === 'no'
    ? { params: out, lineType: 'pipe' }
    : { params: out, lineType: 'flex_hose', construction: hose };
}
