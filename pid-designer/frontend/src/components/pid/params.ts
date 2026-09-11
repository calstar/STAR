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
  | 'specific_heat' | 'thermal_conductance';

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
};

/** Pressures are absolute. Said in the UI, next to the field. */
export const ABSOLUTE_NOTE = 'absolute, not gauge';
