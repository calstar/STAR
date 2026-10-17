/**
 * Pressure as people read it: absolute, in psia.
 *
 * The wire stays gauge (ADR 0007, which replaces item 6 of ADR 0004). Every
 * `*_psi` field, a knob's `psig`, a channel's values, a run record, a hookup,
 * a saved stand and this browser's own storage carry psig -- the zero the
 * stand's DAQ reads against -- and a channel's `unit` says 'psig' as a machine
 * tag. Everything on the screen, and everything typed into it, is psia.
 *
 * This file is the only place the two meet in the frontend, as
 * `feedtwin.session.gauge` is in the library. Convert a gauge number here,
 * once, at the edge: arithmetic on two pressures (lockup less dome, a dip, a
 * residual) is done in gauge first, because a difference is the same number
 * of psi either way and an atmosphere added to it twice is a bug.
 *
 * The zero is the standard atmosphere, the same 101,325 Pa as the library's
 * `ATMOSPHERE`: what the stand's transducers cancel. A gauge reading converted
 * here is therefore exact against the model, and a psia number typed here
 * goes back to the gauge the model takes without drift.
 */

import { fixed } from '../api';

/** One psi [Pa]: the library's `PSI`. */
const PSI_PA = 6894.757293168361;

/** The standard atmosphere [psi]: 101,325 Pa, 14.696 psi. The zero of every
 *  gauge number on the wire. */
export const ATMOSPHERE_PSI = 101325 / PSI_PA;

/** What every pressure a person reads or types is in. */
export const PRESSURE_UNIT = 'psia';

/** The tag the wire puts on a gauge number: a channel's `unit`, a tunable's
 *  before it said `gauge_wire`, a run outcome's. Never shown. */
const GAUGE = 'psig';

/** A gauge number off the wire, absolute [psia]. */
export const toPsia = (gauge: number): number => gauge + ATMOSPHERE_PSI;

/** An absolute pressure [psia], as the gauge number the wire takes. */
export const fromPsia = (psia: number): number => psia - ATMOSPHERE_PSI;

/** What a psia input commits: the typed (or turned) value snapped to its
 *  detent in psia, as the gauge number the wire takes. A knob's 5 psi detent
 *  is 5 psi on the dial a person reads, not on the one the wire keeps. */
export const commitPsia = (psia: number, step: number): number =>
  fromPsia(step > 0 ? Math.round(psia / step) * step : psia);

/** `commitPsia` for a field with bounds [gauge]: the ends of its travel are
 *  detents too, as a dial's stops are, and it never commits past them. So a
 *  vented 14.7 psia typed on a 5 psi detent is the vented end (0 on the wire),
 *  not 15 psia -- which would be a dewar pushing at 0.3 psi. */
export const snapPsia = (psia: number, step: number, low?: number, high?: number): number => {
  const want = fromPsia(psia);
  let gauge = commitPsia(psia, step);
  if (low !== undefined) gauge = Math.max(low, gauge);
  if (high !== undefined) gauge = Math.min(high, gauge);
  for (const end of [low, high]) {
    if (end !== undefined && Math.abs(end - want) < Math.abs(gauge - want)) gauge = end;
  }
  return gauge;
};

/** A gauge number, as it reads on the screen: "514.7 psia". */
export const fmtP = (gauge: number, places = 0): string => `${fixed(toPsia(gauge), places)} ${PRESSURE_UNIT}`;

/** A gauge number's psia value alone, for a cell whose unit is in its header. */
export const psiaText = (gauge: number, places = 0): string => fixed(toPsia(gauge), places);

/** A gauge number as a psia field holds it, ready to edit: whole on a whole
 *  psia, a tenth off one. A drawn 500 psig is 514.7 psia, and a field that
 *  rounded it to "515" would show a setting nobody made. */
export const psiaEntry = (gauge: number): string => {
  const psia = toPsia(gauge);
  return Math.abs(psia - Math.round(psia)) < 0.05 ? String(Math.round(psia)) : psia.toFixed(1);
};

/** A channel that carries pressure. A channel with no unit is a pressure: the
 *  wire's default. Every list of pressure channels goes through this -- one
 *  filter that missed the default once hid every transducer from a panel. */
export const isPressureChannel = (c: { unit?: string | null }): boolean => (c.unit || GAUGE) === GAUGE;

/** A unit tag from the wire, as a person reads it: gauge pressure is shown
 *  psia; everything else is itself. */
export const unitLabel = (unit: string): string => (unit === GAUGE ? PRESSURE_UNIT : unit);

/** A number tagged gauge on the wire (a run outcome, a tunable before it said
 *  `gauge_wire`, a drawing parameter written psig). */
export const isGaugeUnit = (unit: string | null | undefined): boolean => unit === GAUGE;

/** A run record's input, by its flattened key, that is a gauge pressure: a
 *  knob's setting (`knobs.<id>`), a vessel's at T-0 (`t0.tanks.<id>.psig`),
 *  or a gauge Configuration row (`setup.<key>`, from `isGaugeTunable`). */
export const isGaugeInput = (key: string, gaugeSetup: ReadonlySet<string>): boolean =>
  key.startsWith('knobs.') || key.endsWith(`.${GAUGE}`) || gaugeSetup.has(key);

/** A Configuration row whose value, bounds and default are gauge on the wire
 *  and psia on the screen: the dome, the COPV charge, the dewar. */
export const isGaugeTunable = (t: { unit: string; gauge_wire?: boolean }): boolean =>
  Boolean(t.gauge_wire) || t.unit === GAUGE;

/** A value with its own unit (a drawing's parameter, an assumption), shown
 *  absolute when it is gauge. Any other unit is shown as written. */
export const asShown = (v: { value: number; unit: string }): { value: number; unit: string } =>
  isGaugeUnit(v.unit) ? { value: toPsia(v.value), unit: PRESSURE_UNIT } : v;

/** The hover on a transducer's reading. The real stand's DAQ shows gauge, so
 *  an operator checking the twin against it needs the number it would print. */
export const daqReads = (gauge: number): string => `DAQ reads ${fixed(gauge, 1)} ${GAUGE}`;
