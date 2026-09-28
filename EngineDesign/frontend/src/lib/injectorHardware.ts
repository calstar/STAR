import type { EngineConfig, InjectorHoleCd } from '../api/client';

/**
 * Config <-> form mapping for components/InjectorHardware.tsx. Kept out of the component so it
 * can be tested without a DOM, and because it decides what a blank field means (unset, never
 * zero). Only what shapes the injector's geometry and its holes' Cd is here: structure (FEA),
 * seals, the manifold cover and how the plug is retained are designed separately.
 *
 * Each propellant has ONE hole L/d (discharge.<side>.orifice_l_over_d). It is the L/d the Cd
 * model uses and, with channels on the back, how far each hole runs before it opens into its
 * channel -- so the Cd and the drawing cannot disagree.
 */

export type Draft = Record<string, string>;

const MM = 1000;

export interface Field {
  key: string;
  label: string;
  unit?: string;
  kind?: 'num' | 'int' | 'select';
  options?: { value: string; label: string }[];
  hint?: string;
  /** Shown only when this holds: a field that does nothing for this plug is not offered. */
  show?: (d: Draft) => boolean;
}

const NPT = ['1/8 NPT', '1/4 NPT', '3/8 NPT', '1/2 NPT', '3/4 NPT'];
/** engine/core/discharge.py INLET_GEOMETRY_CD: short-tube Cd at L/d 2-5, Re > 1e4. */
const INLETS: [string, string][] = [
  ['', 'not set'], ['sharp', 'sharp 0.80'], ['chamfered', 'chamfered 0.84'], ['conical', 'conical 0.86'],
  ['rounded_light', 'light radius 0.85'], ['rounded', 'rounded 0.88'], ['bellmouth', 'bellmouth 0.95'],
];
const opt = (...xs: [string, string][]) => xs.map(([value, label]) => ({ value, label }));
const channels = (d: Draft) => d.back === 'channels';
const plenum = (d: Draft) => d.back === 'plenum';

export const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: 'Face',
    fields: [
      { key: 'face', label: 'Face', kind: 'select', options: opt(['flat', 'flat'], ['contoured', 'contoured (square exits)']) },
      { key: 'groove_bottom', label: 'Groove bottom', kind: 'select', options: opt(['flat', 'flat'], ['v', 'V']), show: (d) => d.face === 'contoured' },
      { key: 'exit_land', label: 'Land around exits', unit: 'mm', hint: 'blank = 0.5 mm' },
      { key: 'plate_t', label: 'Plate thickness', unit: 'mm' },
    ],
  },
  {
    title: 'Back',
    fields: [
      { key: 'back', label: 'Back', kind: 'select', options: opt(['channels', 'channels'], ['plenum', 'plenum behind']) },
      { key: 'channel_width', label: 'Channel width', unit: 'mm', hint: 'blank = hole footprint + 2 lands', show: channels },
      { key: 'channel_floor', label: 'Channel floor', kind: 'select', options: opt(['flat', 'flat'], ['coned', 'coned (square inlets)']), show: channels },
      { key: 'counterbore', label: 'Counterbore ⌀', unit: 'mm', hint: 'blank = none', show: plenum },
    ],
  },
  {
    title: 'Holes and Cd',
    fields: [
      { key: 'land_O', label: 'LOX hole L/d', hint: 'sets the LOX Cd, and with channels the LOX channel depth' },
      { key: 'land_F', label: 'Fuel hole L/d', hint: 'sets the fuel Cd, and with channels the fuel channel depth' },
      { key: 'inlet_O', label: 'LOX inlet', kind: 'select', options: opt(...INLETS), hint: 'not set: Cd from hole diameter, and L/d has no effect' },
      { key: 'inlet_F', label: 'Fuel inlet', kind: 'select', options: opt(...INLETS), hint: 'not set: Cd from hole diameter, and L/d has no effect' },
      { key: 'ld_model', label: 'Cd vs L/d', kind: 'select', options: opt(['piecewise', 'flat to L/d 5'], ['lichtarowicz', 'Lichtarowicz 1965']) },
      { key: 'ld_src', label: 'Cd L/d from', kind: 'select', options: opt(['declared', 'the value above'], ['plate', 'the drilled plate']), show: plenum },
    ],
  },
  {
    title: 'Igniter',
    fields: [
      { key: 'thread', label: 'Thread', kind: 'select', options: [{ value: '', label: 'none' }, ...NPT.map((t) => ({ value: t, label: t }))] },
      { key: 'hub_t', label: 'Thickness at port', unit: 'mm', hint: 'blank = plate; thicker makes a boss as wide as the port keep-out', show: (d) => d.thread !== '' },
    ],
  },
];

const s = (v: unknown, k = 1) => (v === null || v === undefined || v === '' ? '' : String(+(Number(v) * k).toPrecision(8)));

export function draftFromConfig(c: EngineConfig): Draft {
  const req = (c.design_requirements ?? {}) as Record<string, unknown>;
  const inj = (c.injector ?? {}) as Record<string, Record<string, unknown> | null>;
  const ig = inj.igniter ?? {};
  const pl = inj.plate ?? {};
  const dis = (c.discharge ?? {}) as Record<string, Record<string, unknown>>;
  return {
    face: String(pl.face ?? 'contoured'),
    groove_bottom: String(pl.groove_bottom ?? 'flat'),
    exit_land: s(pl.exit_land, MM),
    plate_t: s(req.layer1_injector_plate_thickness_m, MM),
    back: String(pl.back ?? 'channels'),
    channel_width: s(pl.channel_width, MM),
    channel_floor: String(pl.channel_floor ?? 'flat'),
    counterbore: s(req.layer1_injector_counterbore_dia_m, MM),
    thread: String(ig.thread ?? ''),
    hub_t: s(ig.hub_thickness, MM),
    ld_src: String(dis.oxidizer?.l_over_d_source ?? 'declared'),
    ld_model: String(dis.oxidizer?.length_model ?? 'piecewise'),
    land_O: s(dis.oxidizer?.orifice_l_over_d),
    land_F: s(dis.fuel?.orifice_l_over_d),
    inlet_O: String(dis.oxidizer?.inlet_geometry ?? ''),
    inlet_F: String(dis.fuel?.inlet_geometry ?? ''),
  };
}

/** The partial config the draft stands for. Blank means unset (null), never zero. */
export function updatesFromDraft(d: Draft): Record<string, unknown> {
  const m = (k: string) => (d[k] === '' ? null : Number(d[k]) / MM);
  const n = (k: string) => (d[k] === '' ? null : Number(d[k]));
  const plate = {
    face: d.face, groove_bottom: d.groove_bottom, exit_land: m('exit_land'),
    back: d.back, channel_width: m('channel_width'), channel_floor: d.channel_floor,
  };
  const igniter = d.thread ? { thread: d.thread, hub_thickness: m('hub_t') } : null;
  const side = (k: 'O' | 'F') => ({
    // With channels the hole IS the passage to the floor: the plate cannot give another L/d.
    l_over_d_source: d.back === 'channels' ? 'declared' : d.ld_src,
    length_model: d.ld_model,
    orifice_l_over_d: n(`land_${k}`),
    inlet_geometry: d[`inlet_${k}`] || null,
  });
  return {
    injector: { plate, igniter },
    discharge: { oxidizer: side('O'), fuel: side('F') },
    design_requirements: {
      layer1_injector_plate_thickness_m: m('plate_t'),
      layer1_injector_counterbore_dia_m: m('counterbore'),
    },
  };
}

/** ``base`` with ``patch`` laid over it, objects merged key by key (arrays and nulls replace). */
export function mergeDeep<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...((base ?? {}) as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = out[k];
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object'
      ? mergeDeep(b, v) : v;
  }
  return out as T;
}

/**
 * What a change of hole Cd does, in the two ways the engine can take it. The holes do not
 * change size, so at the same mass flow the injector drop scales as (Cd_before / Cd_after)^2
 * (mdot = Cd A sqrt(2 rho dp)); at the same drop the flow scales as Cd_after / Cd_before. A
 * forward solve holds the tank pressures, so it lands between the two; Layer 1 re-sizes the
 * holes to put the drop back in its band.
 */
export function cdChange(before: InjectorHoleCd | null, after: InjectorHoleCd | null) {
  if (!before || !after || !(before.value > 0) || !(after.value > 0)) return null;
  return {
    before: before.value,
    after: after.value,
    dpSameFlow: (before.value / after.value) ** 2 - 1,
    flowSameDp: after.value / before.value - 1,
  };
}

/** One line on what a hole's Cd is made of. */
export function cdBasis(cd: InjectorHoleCd | null): string {
  if (!cd) return 'no discharge block';
  if (!cd.inlet) return `Cd ${cd.value.toFixed(3)} from hole diameter; inlet not set, so L/d has no effect`;
  const parts = [`${cd.inlet} ${cd.inlet_cd!.toFixed(3)}`];
  if (cd.uses_ld) parts.push(`× ${cd.length_factor!.toFixed(3)} for L/d ${cd.l_over_d!.toFixed(1)}`);
  if (cd.approach) parts.push(`× ${cd.approach.toFixed(3)} counterbore`);
  return `Cd ${cd.value.toFixed(3)} = ${parts.join(' ')}`;
}
