/**
 * What a vessel is made of, what wraps it, and what its contents sit at.
 *
 * Lookup tables, so a person picks a material and the drawing writes the
 * number -- with the source named, and with `verified: false` on any figure
 * that has not yet been checked against a datasheet. The drawing tool's rule
 * is that a number it writes for you is a `default` with a reference, never
 * something you appear to have typed.
 */

import type { ParamValue } from './params';

export interface Preset {
  id: string;
  label: string;
  value: number;
  unit: string;
  reference: string;
  /** False when the figure is an estimate awaiting a datasheet. */
  verified: boolean;
}

/** A `ParamValue` from a preset, with its provenance attached. */
export const paramFromPreset = (p: Preset): ParamValue => ({
  value: p.value, unit: p.unit, source: 'default',
  reference: p.verified ? p.reference : `${p.reference} — UNVERIFIED`,
});

// ── Tank materials → wall specific heat ──────────────────────────────────────

export const TANK_MATERIALS: Preset[] = [
  { id: 'al6061', label: 'Aluminium 6061-T6', value: 897, unit: 'J/(kg.K)', verified: true,
    reference: 'NIST cryogenic materials data, Al 6061-T6 specific heat at 300 K' },
  { id: 'ss316', label: '316 stainless', value: 500, unit: 'J/(kg.K)', verified: false,
    reference: '316 SS specific heat 0.50 kJ/(kg.K), typical mill datasheet — not yet checked against one' },
  { id: 'ss304', label: '304 stainless', value: 500, unit: 'J/(kg.K)', verified: true,
    reference: 'SAE 304 stainless, 0.50 kJ/(kg.K) at 20 °C' },
  // Carbon/epoxy overwrap: rule of mixtures on the constituents, at a 60 %
  // fibre volume fraction (about 70 % by mass at 1.8 vs 1.2 g/cm³). Liner not
  // included. A real COPV wants its own figure from the maker.
  { id: 'copv', label: 'COPV (carbon/epoxy)', value: 870, unit: 'J/(kg.K)', verified: false,
    reference: 'rule of mixtures: carbon fibre 740, epoxy 1160 J/(kg.K) (PMC12430415), 60 % fibre by volume; liner excluded' },
];

export const DEFAULT_MATERIAL = 'al6061';

// ── Insulation → conductivity ────────────────────────────────────────────────

export const INSULATIONS: Preset[] = [
  // k = thickness / R. An R-13 batt is 3.5 in (0.0889 m) at R-13 h·ft²·°F/BTU
  // = 2.289 m²·K/W, so k = 0.0389 W/(m·K). Arithmetic on the product's own
  // rating, which is the number printed on the bag.
  { id: 'fiberglass_r13', label: 'Fiberglass batt (R-13, 3.5 in)', value: 0.039, unit: 'W/(m.K)', verified: true,
    reference: 'Owens Corning R-13 unfaced batt, 3.5 in: k = 0.0889 m / (13 × 0.1761 m²·K/W)' },
];

// ── Temperature presets ──────────────────────────────────────────────────────

/** Room, and the normal boiling points. NIST Chemistry WebBook. */
export const TEMPERATURES: Preset[] = [
  { id: 'ambient', label: 'Ambient, 293 K', value: 293, unit: 'K', verified: true, reference: 'room temperature, 20 °C' },
  { id: 'lox', label: 'LOX, 90.2 K', value: 90.19, unit: 'K', verified: true, reference: 'NIST WebBook: oxygen normal boiling point' },
  { id: 'ln2', label: 'LN2, 77.4 K', value: 77.36, unit: 'K', verified: true, reference: 'NIST WebBook: nitrogen normal boiling point' },
  { id: 'lch4', label: 'LCH4, 111.7 K', value: 111.67, unit: 'K', verified: true, reference: 'NIST WebBook: methane normal boiling point' },
];

// ── Saturation: what a dewar sits at ────────────────────────────────────────

/**
 * Saturation temperature against pressure, NIST WebBook (fluid.cgi, SatP),
 * fetched 2026-09-12. Pairs of [K, psia]. A dewar delivers at a pressure and
 * its liquid sits on this curve, so the temperature is not a second question.
 */
const SAT_PSIA: Record<'nitrogen' | 'oxygen', [number, number][]> = {
  nitrogen: [
    [64, 2.1179], [68, 4.1308], [72, 7.4278], [76, 12.488], [80, 19.852], [84, 30.106],
    [88, 43.875], [92, 61.809], [96, 84.580], [100, 112.88], [104, 147.42], [108, 188.96],
    [112, 238.29], [116, 296.32], [120, 364.13], [124, 443.26],
  ],
  oxygen: [
    [56, 0.035041], [60, 0.10527], [64, 0.27240], [68, 0.62393], [72, 1.2923], [76, 2.4612],
    [80, 4.3690], [84, 7.3078], [88, 11.620], [92, 17.691], [96, 25.946], [100, 36.840],
    [104, 50.853], [108, 68.482], [112, 90.242], [116, 116.66], [120, 148.27], [124, 185.62],
    [128, 229.29], [132, 279.87], [136, 337.99], [140, 404.33], [144, 479.70], [148, 565.04],
    [152, 661.75],
  ],
};

export const PSIA_PER_PA = 1 / 6894.757293168361;

/**
 * Saturation temperature at an absolute pressure, or undefined off the table.
 *
 * Interpolated in log(p) against T, which is close to straight for a vapour
 * pressure curve, so a 4 K table grid is well inside a tenth of a kelvin.
 */
export function saturationK(species: string, pressurePa: number): number | undefined {
  const table = SAT_PSIA[species as 'nitrogen' | 'oxygen'];
  if (!table || !(pressurePa > 0)) return undefined;
  const psia = pressurePa * PSIA_PER_PA;
  const lp = Math.log(psia);
  for (let i = 0; i < table.length - 1; i++) {
    const [t0, p0] = table[i], [t1, p1] = table[i + 1];
    if (psia >= p0 && psia <= p1) {
      const f = (lp - Math.log(p0)) / (Math.log(p1) - Math.log(p0));
      return Math.round((t0 + f * (t1 - t0)) * 100) / 100;
    }
  }
  return undefined;
}

export const SAT_REFERENCE = 'NIST WebBook saturation curve, interpolated in log p';

// ── Cd → Cv ──────────────────────────────────────────────────────────────────

/**
 * The Cv a Cd and a bore amount to.
 *
 * Cv is the water flow in US gpm at 1 psi drop. For an orifice, Q = Cd·A·√(2Δp/ρ):
 * at Δp = 6894.76 Pa and ρ = 998 kg/m³ that is 3.717 m/s through the area, so
 * one square inch (6.4516e-4 m²) passes 2.398e-3 m³/s = 38.0 gpm per unit Cd.
 * Hence Cv = 38.0 · Cd · A[in²]. Written so a drawing that chose Cd still
 * solves in a feed-twin whose valves only know Cv; feed-twin will grow a Cd
 * model and this stops being written.
 */
export const GPM_PER_IN2_AT_1PSI = 38.0;

export function cvFromCd(cd: number, boreMm: number): number {
  const areaIn2 = Math.PI * (boreMm / 25.4) ** 2 / 4;
  return Math.round(GPM_PER_IN2_AT_1PSI * cd * areaIn2 * 1000) / 1000;
}

// ── Line materials → roughness ───────────────────────────────────────────────

/**
 * What the team's tube is, and the roughness that goes with it.
 *
 * Drawn aluminium tube is the Moody chart's "drawn tubing" row. The two
 * stainless finishes come from Farshad's measured table as shipped in the
 * `fluids` library (`roughness_Farshad`): electropolished and bare stainless.
 * Farshad measured 13 % chrome steel, not 316; the finish is what the number
 * tracks, but the alloy differs, so both stainless rows say so.
 */
export const LINE_MATERIALS: Preset[] = [
  { id: 'al6061', label: 'Aluminium 6061-T6 (drawn tube)', value: 0.0015, unit: 'mm', verified: true,
    reference: 'Moody (1944) drawn tubing, 0.0015 mm; fluids.friction roughness table' },
  { id: 'ss316_polished', label: '316 stainless, polished', value: 0.030, unit: 'mm', verified: false,
    reference: 'Farshad (2001) electropolished stainless, 0.030 mm, via fluids.roughness_Farshad — measured on Cr13, not 316' },
  { id: 'ss316_rough', label: '316 stainless, as drawn / rough', value: 0.055, unit: 'mm', verified: false,
    reference: 'Farshad (2001) bare stainless, 0.055 mm, via fluids.roughness_Farshad — measured on Cr13, not 316' },
];

export const DEFAULT_LINE_MATERIAL = 'ss316_polished';
