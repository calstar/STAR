/**
 * What a config dialog holds while a number is being edited, and how that
 * becomes a `ParamValue` again.
 *
 * Two rules, both about not losing what was there:
 *
 * **Provenance survives a round trip.** The dialog offers two choices --
 * verified or estimate -- because that is the question a person can answer.
 * Underneath, `feedtwin.model.Param` distinguishes four, and a run report
 * cares about all four: a catalogue bore is `default` with a reference naming
 * the catalogue, a datasheet Cv is `manufacturer` with the sheet named. The
 * old draft collapsed those to `estimated` and `measured` on the way *in*, so
 * opening a dialog and pressing Save rewrote the provenance of every number
 * on the symbol and dropped every reference -- silently, on the button people
 * press most. A draft now carries the source it was given and the reference
 * with it, and only changes them when somebody changes them.
 *
 * **A suggestion is not a value.** `spec.suggested` used to be written into
 * the draft as if typed, so Save on an untouched line wrote `K_minor: 0`,
 * `elevation_change: 0`, a roughness and a wall thickness, all tagged
 * `estimated` -- numbers nobody stated, indistinguishable afterwards from
 * numbers somebody did. The drawing's own rule is that absent means not
 * stated, never zero. So a suggestion is shown as a placeholder, and a field
 * left blank stays absent; feed-twin fills it and says so in its report.
 */

import type { ParamSpec } from './spec';
import type { ParamValue, Provenance } from './params';
import { explicitUnit, isAbsoluteField, toPsia, unitsFor } from './params';

export interface Draft {
  value: string;
  unit: string;
  source: Provenance;
  reference?: string;
  /** The second number of a ratio row: "per [this] psi inlet drop". */
  per?: string;
}

/** The two answers the dialog offers, and which of the four each stands for. */
export const VERIFIED: ReadonlySet<Provenance> = new Set(['measured', 'manufacturer']);

export const isVerified = (source: Provenance) => VERIFIED.has(source);

export function toDraft(spec: ParamSpec, existing?: ParamValue, symbol = ''): Draft {
  const units = unitsFor(spec);
  const pressureAt = spec.dimension === 'pressure' && isAbsoluteField(spec.key);
  if (existing) {
    // A supply coefficient stored as N psi/1000psi reopens as "N per 1000".
    const per = spec.ratio ? (existing.unit === 'psi/1000psi' ? '1000' : existing.unit === 'psi/100psi' ? '100' : '1') : undefined;
    // A pressure at a place written in psi -- bare or psig -- reopens in psia,
    // the number the sheet prints beside the symbol: a COPV drawn at "4000
    // psi" opens at 4014.696 psia, not at a second number for the same thing.
    // Three decimals, so a Save that rewrites it moves it by less than a
    // ten-thousandth of a psi. Any other unit reopens saying its reference
    // (a bare bar reads as barg, as feed-twin reads it) and keeps its number.
    const unit = pressureAt ? explicitUnit(spec.key, existing.unit, symbol) : existing.unit;
    const psia = unit === 'psig' ? toPsia(existing, symbol) : undefined;
    return {
      value: psia !== undefined ? String(Number(psia.toFixed(3))) : String(existing.value),
      unit: (psia !== undefined ? 'psia' : unit) || units[0],
      source: existing.source,
      ...(existing.reference ? { reference: existing.reference } : {}),
      ...(per ? { per } : {}),
    };
  }
  // A new pressure at a place is typed in psia: what everything else shows.
  if (pressureAt) return { value: '', unit: units[0], source: 'estimated' };
  return { value: '', unit: spec.suggested?.unit ?? spec.unit ?? units[0], source: 'estimated' };
}

/**
 * The value a draft stands for, or nothing.
 *
 * Blank is absent. Not zero, not the suggestion: absent. A reference is kept
 * whenever there is one, because "Tescom 26-1000 datasheet rev C" is the
 * whole reason the number can be trusted.
 */
export function fromDraft(draft: Draft | undefined): ParamValue | undefined {
  if (!draft) return undefined;
  const text = draft.value.trim();
  if (text === '') return undefined;
  const value = Number(text);
  if (!Number.isFinite(value)) return undefined;
  return {
    value,
    unit: draft.unit,
    source: draft.source,
    ...(draft.reference ? { reference: draft.reference } : {}),
  };
}

/**
 * What the user picked in the two-way select, applied to a draft.
 *
 * Picking the answer a draft already gives changes nothing -- so a
 * `manufacturer` value whose select reads "verified" stays `manufacturer`
 * when the select is left where it is. Picking the other answer moves to the
 * plain member of that pair, and drops the reference, which was about the
 * number's old standing and no longer describes it.
 */
export function pickProvenance(draft: Draft, verified: boolean): Draft {
  if (isVerified(draft.source) === verified) return draft;
  // Explicitly undefined rather than omitted: the dialog spreads this over
  // the draft it holds, and an omitted key would leave the old reference.
  return { ...draft, source: verified ? 'measured' : 'estimated', reference: undefined };
}

/** The placeholder a blank field shows: the suggestion, said as a suggestion. */
export function placeholderFor(spec: ParamSpec, symbol = ''): string {
  if (!spec.suggested) return '—';
  // Said in the unit the field opens in: a pressure at a place, in psia.
  if (spec.dimension === 'pressure' && isAbsoluteField(spec.key)) {
    const psia = toPsia({ ...spec.suggested, source: 'default' }, symbol);
    if (psia !== undefined) return `${Math.round(psia)} psia if blank`;
  }
  return `${spec.suggested.value} ${spec.suggested.unit} if blank`;
}
