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
  kind?: 'num' | 'int' | 'select' | 'text';
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
      { key: 'channel_floor', label: 'Channel floor', kind: 'select', options: opt(['flat', 'flat'], ['coned', 'coned (square inlets)'], ['spot', 'flat + drill spot']), show: channels },
      { key: 'channel_width', label: 'Channel width', unit: 'mm', hint: 'drill-spot floor: the flat floor beside the spot. blank = hole footprint + 2 lands', show: channels },
      { key: 'spot', label: 'Drill spot', unit: 'mm', hint: 'facet square to the hole, across the hole; blank = d + 2 lands', show: (d) => channels(d) && d.channel_floor === 'spot' },
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
  {
    title: 'Feed ports (cover plate)',
    fields: [
      { key: 'ports', label: 'Ports per ring', kind: 'int', hint: 'each splits two ways round its channel; blank = 1', show: channels },
      { key: 'port_thread', label: 'Port thread', kind: 'select', options: [{ value: '', label: 'not drawn' }, ...NPT.map((t) => ({ value: t, label: t }))], show: channels },
      { key: 'port_bore', label: 'Port bore', unit: 'mm', hint: 'what the port opens onto the channel with; blank = tap drill', show: (d) => channels(d) && d.port_thread !== '' },
      { key: 'port_clock', label: 'Fuel ports from LOX', unit: '°', hint: 'blank = half the port pitch', show: (d) => channels(d) && d.port_thread !== '' },
    ],
  },
  {
    title: 'Rim gland',
    fields: [
      { key: 'gland_z', label: 'From face', unit: 'mm', hint: 'to the groove\'s face-side wall; blank = no gland' },
      { key: 'gland_w', label: 'Width', unit: 'mm', show: (d) => d.gland_z !== '' },
      { key: 'gland_d', label: 'Depth', unit: 'mm', show: (d) => d.gland_z !== '' },
      { key: 'gland_rc', label: 'Corner radius', unit: 'mm', show: (d) => d.gland_z !== '' },
    ],
  },
  {
    title: 'Drawing',
    fields: [
      { key: 'dxf', label: 'Revolve DXF', kind: 'text', hint: 'path from EngineDesign/, e.g. configs/cad/plate.dxf; blank = none' },
      { key: 'dxf_mode', label: 'Use it as', kind: 'select', options: opt(['check', 'a check on the model'], ['geometry', 'the geometry']), show: (d) => d.dxf !== '' },
    ],
  },
];

/** One back-face groove as the form edits it: [r inner, r outer, depth, corner radius], mm. */
export type GrooveRow = [string, string, string, string];

export function groovesFromDraft(d: Draft): GrooveRow[] {
  try {
    const v = JSON.parse(d.grooves || '[]');
    return Array.isArray(v) ? (v as GrooveRow[]) : [];
  } catch {
    return [];
  }
}

const s = (v: unknown, k = 1) => (v === null || v === undefined || v === '' ? '' : String(+(Number(v) * k).toPrecision(8)));

export function draftFromConfig(c: EngineConfig): Draft {
  const req = (c.design_requirements ?? {}) as Record<string, unknown>;
  const inj = (c.injector ?? {}) as Record<string, Record<string, unknown> | null>;
  const ig = inj.igniter ?? {};
  const pl = inj.plate ?? {};
  const dis = (c.discharge ?? {}) as Record<string, Record<string, unknown>>;
  const gl = (pl.rim_gland ?? null) as Record<string, unknown> | null;
  const grooves = ((pl.back_grooves ?? []) as Record<string, unknown>[]).map(
    (g) => [s(g.r_inner, MM), s(g.r_outer, MM), s(g.depth, MM), s(g.corner_radius, MM)] as GrooveRow);
  return {
    spot: s(pl.channel_spot_length, MM),
    ports: s(pl.channel_inlets),
    port_thread: String(pl.port_thread ?? ''),
    port_bore: s(pl.port_bore, MM),
    port_clock: s(pl.port_clock_F_deg),
    gland_z: s(gl?.z_start, MM),
    gland_w: s(gl?.width, MM),
    gland_d: s(gl?.depth, MM),
    gland_rc: s(gl?.corner_radius, MM),
    grooves: JSON.stringify(grooves),
    dxf: String(pl.profile_dxf ?? ''),
    dxf_mode: String(pl.profile_dxf_mode ?? 'check'),
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
  const num = (v: string) => (v === '' ? null : Number(v) / MM);
  const plate = {
    face: d.face, groove_bottom: d.groove_bottom, exit_land: m('exit_land'),
    back: d.back, channel_width: m('channel_width'), channel_floor: d.channel_floor,
    channel_spot_length: m('spot'),
    channel_inlets: d.ports === '' ? 1 : Math.max(1, Math.round(Number(d.ports))),
    port_thread: d.port_thread || null,
    port_bore: m('port_bore'),
    port_clock_F_deg: n('port_clock'),
    // Rows missing a radius or depth are not grooves yet: dropped, not sent as zero.
    back_grooves: groovesFromDraft(d)
      .filter(([ri, ro, dep]) => ri !== '' && ro !== '' && dep !== '')
      .map(([ri, ro, dep, rc]) => ({ r_inner: num(ri), r_outer: num(ro), depth: num(dep), corner_radius: num(rc) ?? 0 })),
    rim_gland: d.gland_z === '' || d.gland_w === '' || d.gland_d === '' ? null
      : { z_start: m('gland_z'), width: m('gland_w'), depth: m('gland_d'), corner_radius: m('gland_rc') ?? 0 },
    profile_dxf: d.dxf || null,
    profile_dxf_mode: d.dxf_mode || 'check',
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

/**
 * Only what the form changed: ``updatesFromDraft`` of the draft, less every leaf it shares with
 * ``updatesFromDraft`` of the draft's base. Apply sends this, never the whole form -- the form
 * covers the plate, the igniter and both holes, and writing all of it back put a stale plate
 * over a newer config when only the igniter had been touched (2026-09-28). Arrays and objects
 * that are values (a groove list, the rim gland) go whole when any part of them changed.
 */
export function changedUpdates(base: Draft, draft: Draft): Record<string, unknown> {
  const diff = (a: unknown, b: unknown): unknown => {
    const obj = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (obj(a) && obj(b)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(a as object)) {
        const bv = (b as Record<string, unknown>)[k];
        const av = (a as Record<string, unknown>)[k];
        // A value-object (gland) replaces whole: it has no identity of its own to merge into.
        const d = obj(av) && obj(bv) && !VALUE_OBJECTS.has(k) ? diff(av, bv) : (JSON.stringify(av) === JSON.stringify(bv) ? undefined : av);
        if (d !== undefined && !(obj(d) && Object.keys(d as object).length === 0)) out[k] = d;
      }
      return out;
    }
    return JSON.stringify(a) === JSON.stringify(b) ? undefined : a;
  };
  return (diff(updatesFromDraft(draft), updatesFromDraft(base)) ?? {}) as Record<string, unknown>;
}

const VALUE_OBJECTS = new Set(['rim_gland', 'igniter']);

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
