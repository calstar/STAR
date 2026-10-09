/**
 * Parameters on a P&ID symbol.
 *
 * A number describing hardware is stored as a record, not a float:
 *
 *     { value: 850, unit: 'psi', source: 'manufacturer',
 *       reference: 'Tescom 26-1000 datasheet rev C' }
 *
 * That shape is not invented here. It is `feedtwin.model.Param`, the parameter
 * type of the feed-system physics core, and the P&ID stores it verbatim so the
 * Phase-11 reader can lift a value across without re-typing or guessing. The
 * unit spellings below are exactly the ones `feedtwin.model.units` registers;
 * anything else is rejected there at load, so offering it here would only move
 * the failure somewhere less helpful.
 *
 * `source` has no default on purpose. "Nobody remembers where this came from"
 * is the state a propulsion team's numbers drift into by the second year, and
 * making it un-writable is cheaper than reconstructing it later. The dialog
 * therefore always asks, and `estimated` is a real answer.
 *
 * One deliberate absence, inherited and worth restating: **there is no psig.**
 * Gauge is a reference, not a unit. A pressure typed as psig and stored as psi
 * is one atmosphere low, silently, everywhere downstream -- so the dialog says
 * "absolute" next to every pressure field rather than accepting the spelling.
 */

export type Provenance = 'measured' | 'manufacturer' | 'estimated' | 'default';

/**
 * Two choices, not four.
 *
 * `feedtwin.model.Param` distinguishes measured / manufacturer / estimated /
 * default, and a run report cares about all four. Nobody filling in a valve Cv
 * does. What a person actually knows is whether the number is real or a guess,
 * so that is the question -- and the wider vocabulary stays underneath for
 * anything that wants it.
 */
export const PROVENANCE_LABELS: Record<Provenance, string> = {
  measured:     'Verified',
  manufacturer: 'Verified',
  estimated:    'Estimate',
  default:      'Estimate',
};

/** What the dropdown offers. */
export const PROVENANCE_CHOICES: { value: Provenance; label: string }[] = [
  { value: 'estimated', label: 'Estimate' },
  { value: 'measured',  label: 'Verified' },
];

/** A number, with where it came from. Mirrors `feedtwin.model.Param`. */
export interface ParamValue {
  value: number;
  unit: string;
  source: Provenance;
  reference?: string;
}

export type Dimension =
  | 'pressure' | 'temperature' | 'length' | 'volume'
  | 'flow_coefficient' | 'dimensionless' | 'time' | 'mass' | 'mass_flow' | 'angle'
  | 'specific_heat' | 'thermal_conductance' | 'conductivity' | 'pressure_ratio';

/**
 * Units offered per dimension, in the spelling `feedtwin.model.units` uses.
 * First entry is the default for a new value.
 */
export const UNITS: Record<Dimension, string[]> = {
  pressure:         ['psi', 'bar', 'Pa', 'kPa', 'MPa', 'atm'],
  temperature:      ['K', 'degC', 'degR'],
  length:           ['in', 'mm', 'm', 'cm', 'ft'],
  volume:           ['L', 'mL', 'm^3', 'in^3', 'gal'],
  flow_coefficient: ['Cv', 'Kv'],
  dimensionless:    ['-', '%'],
  time:             ['s', 'ms', 'min'],
  mass:             ['g', 'kg', 'lbm'],
  mass_flow:        ['kg/s', 'g/s', 'lbm/s'],
  angle:            ['deg', 'rad'],
  specific_heat:    ['J/(kg.K)'],
  thermal_conductance: ['W/K'],
  conductivity:     ['W/(m.K)'],
  // How a datasheet writes a supply-pressure effect: "17 psi per 1000 psi".
  pressure_ratio:   ['psi/1000psi', 'psi/100psi', 'psi/psi', 'bar/bar'],
};

/**
 * Pressures that are a difference between two places. The same in psig and
 * psia, so they are offered only the bare units. Mirrors
 * `feedtwin.model.pressure.DIFFERENCE`, which is what feed-twin reads by.
 */
export const PRESSURE_DIFFERENCES: ReadonlySet<string> = new Set([
  'dome_bias', 'set_pressure', 'reseat_pressure', 'cracking_pressure',
  'flow_droop', 'lockup_rise', 'min_inlet_differential',
]);

/** Symbols whose pressures are quoted absolute: the chamber. */
const ABSOLUTE_SYMBOLS: ReadonlySet<string> = new Set(['ENGINE', 'INJECTOR']);

const ABSOLUTE_UNITS = ['psi', 'psig', 'psia', 'bar', 'barg', 'bara', 'kPa', 'MPa', 'Pa', 'atm'];
const DIFFERENCE_UNITS = ['psi', 'bar', 'kPa', 'MPa', 'Pa'];

/** The units a field offers: a difference cannot carry a gauge or absolute reference. */
export function unitsFor(spec: { key: string; dimension: Dimension }): string[] {
  if (spec.dimension !== 'pressure') return UNITS[spec.dimension];
  return PRESSURE_DIFFERENCES.has(spec.key) ? DIFFERENCE_UNITS : ABSOLUTE_UNITS;
}

/** What a pressure field's unit means, said next to it. */
export function pressureNote(key: string, symbol = ''): string {
  if (PRESSURE_DIFFERENCES.has(key)) return 'a difference: the same in psig and psia';
  if (ABSOLUTE_SYMBOLS.has(symbol)) return 'absolute unless psig: a chamber pressure is quoted psia';
  return 'gauge unless psia: a bare psi reads as psig, as the dial does';
}

/** One standard atmosphere [Pa]: what a gauge reads zero at. */
const ATM = 101325;

/** Pascals per unit, and whether the unit names its reference. */
const PA_PER: Record<string, { k: number; ref: '' | 'a' | 'g' }> = {
  Pa: { k: 1, ref: '' }, kPa: { k: 1e3, ref: '' }, MPa: { k: 1e6, ref: '' },
  bar: { k: 1e5, ref: '' }, psi: { k: 6894.757293168361, ref: '' },
  psia: { k: 6894.757293168361, ref: 'a' }, bara: { k: 1e5, ref: 'a' },
  psig: { k: 6894.757293168361, ref: 'g' }, barg: { k: 1e5, ref: 'g' },
  atm: { k: 101325, ref: 'a' },
};

/**
 * A pressure as a gauge reads it [Pa], or nothing if its unit is not one this
 * file knows. Bare units are gauge (or a difference, which is the same thing
 * against the atmosphere); an absolute one gives up an atmosphere.
 *
 * For comparing two pressures on the drawing -- a relief against a burst
 * pressure -- which is only meaningful once both are on one reference. Nothing
 * here is offered to the solver; feed-twin converts for itself, by the same rule.
 */
export function toGaugePa(p: ParamValue | undefined): number | undefined {
  if (!p) return undefined;
  const u = PA_PER[p.unit];
  if (u === undefined) return undefined;
  return p.value * u.k - (u.ref === 'a' ? ATM : 0);
}

/** An absolute pressure [Pa], for a property lookup (saturation at a dewar). */
export function toAbsolutePa(p: ParamValue | undefined): number | undefined {
  const gauge = toGaugePa(p);
  return gauge === undefined ? undefined : gauge + ATM;
}
