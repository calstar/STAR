/**
 * The boundary between UI state and the wire format.
 *
 * `schema.py` sets `extra="forbid"` on every model, so posting a UI bookkeeping
 * field is a 422, not a shrug. This file is the ONLY place allowed to convert
 * `UiConfig` into `Config`, which keeps that rule enforceable by inspection:
 * if a new field appears on `UiDevice` and nobody touches `toWireConfig`, it
 * stays UI-side by default. That is the safe direction to fail.
 */

import type { Config, Device, UiConfig, UiDevice, UiSite, UiStudyAxis } from '../types/schema'
import { REFERENCE_CONFIG } from '../api/fixture'
import { airframeBand } from './units'

let uidCounter = 0
export function nextUid(): string {
  uidCounter += 1
  return `d${uidCounter}`
}

export function toWireDevice(d: UiDevice): Device {
  // Named explicitly rather than destructured-and-spread, so adding a UI field
  // cannot leak it into the payload by accident.
  return {
    name: d.name,
    CdS: d.CdS,
    D0: d.D0,
    m_c: d.m_c,
    j: d.j,
    n: d.n,
    Cx: d.Cx,
    trigger: { kind: d.trigger.kind, value: d.trigger.value },
    delay: d.delay,
    k_eff: d.k_eff,
    v_rel: d.v_rel,
  }
}

export function toWireConfig(ui: UiConfig): Config {
  const site: UiSite = ui.site
  return {
    vehicle: {
      m: ui.vehicle.m,
      h_a: ui.vehicle.h_a,
      d_body: ui.vehicle.d_body,
      l_body: ui.vehicle.l_body,
      // No CdS_body: derived from the two lengths above. Same reason as
      // z_site below -- a field the backend forbids is a 422, not a silent
      // ignore.
      z0: ui.vehicle.z0,
      v0: ui.vehicle.v0,
      v_lat: ui.vehicle.v_lat,
      v_lat_dir: ui.vehicle.v_lat_dir,
    },
    site: {
      // No z_site: pad elevation is a backend constant, and posting it is a
      // 422. This is exactly the drift `extra="forbid"` exists to catch.
      //
      // An ISA source means "let the backend compute it" -- sending a number
      // the UI guessed would hide which default was actually used.
      T_pad: site.source === 'isa' ? null : site.T_pad,
      p_pad: site.source === 'isa' ? null : site.p_pad,
      // Null on the standard profile, so the backend does its own re-fit
      // rather than being handed a number the UI inferred.
      lapse: site.profile === 'measured' ? site.lapse : null,
    },
    devices: ui.devices.map(toWireDevice),
    // The sweep spec rides on the config, so /api/simulate and /api/sweep take
    // one body (§11.7). The presentation fields -- label, unit -- are dropped
    // here rather than sent and ignored: `Config` is extra="forbid", so
    // posting them is a 422.
    //
    // The airframe bounds are recomputed from the vehicle on the way out
    // instead of being read from the stored row. That row is a seed the user
    // cannot edit, and reading it would send stale bounds the moment anyone
    // changed the airframe diameter.
    sweep: ui.sweep.map((p) => {
      const [axial, broadside] = airframeBand(ui.vehicle.d_body, ui.vehicle.l_body)
      const derived = p.key === 'CdS_body'
      return {
        key: p.key,
        enabled: p.enabled,
        low: derived ? axial : p.min,
        high: derived ? broadside : p.max,
      }
    }),
    // Same rule as the sweep above: the presentation field -- `uid`, a React
    // key -- is dropped here rather than sent and ignored, because `Config` is
    // extra="forbid" and posting it is a 422. Named explicitly for the same
    // reason `toWireDevice` is: a new editor-only field must not be able to
    // leak onto the wire by being caught in a spread.
    study: ui.study.map((a) => ({
      key: a.key,
      device: a.device,
      enabled: a.enabled,
      mode: a.mode,
      start: a.start,
      stop: a.stop,
      points: a.points,
      values: a.values,
      canopies: a.canopies,
      pads: a.pads,
    })),
    // Wind rides on the config so the loads and the drift use the same wind.
    wind: ui.wind ?? null,
  }
}

/**
 * The vehicle the app opens on: PLAN.md §13.1's worked example, stated as the
 * round imperial numbers it was written from rather than the rounded metric
 * the document prints.
 *
 * §13.1 quotes 5.67 kg / 914 m / 4 in, which are 12.5 lb, 3000 ft and 4 in
 * converted and then truncated. Storing the truncations means the vehicle card
 * -- which edits in lb, ft and in -- opens on 12.50021 lb and 2998.7 ft. So the
 * SI stored here is the exact conversion of the round imperial value, and the
 * only free choice is the airframe length, which §13.1 gives no imperial for:
 * 56 in is the nearest round inch to its 1.44 m, and lands the fineness ratio
 * on exactly 14.
 */
const DEFAULT_VEHICLE = {
  m: 12.5 * 0.45359237,  // 12.5 lb
  h_a: 3000 * 0.3048,    // 3000 ft AGL
  d_body: 4 * 0.0254,    // 4 in
  l_body: 56 * 0.0254,   // 56 in
  z0: null,
  v0: null,
  v_lat: null,
  v_lat_dir: null,
}

const round5 = (x: number) => Number(x.toFixed(5))

/**
 * The three staleness keys: what each tab's result actually depends on.
 *
 * `UiConfig` carries the inputs for three different computations, and they
 * overlap without being equal. The vehicle, site and devices move all three;
 * the corner bounds move only the Corners tab; the study axes move only the
 * Sweep tab. Comparing the whole serialised config would make editing a study
 * axis fire a `/api/simulate` and badge a finished corner sweep stale, for a
 * result that provably cannot differ.
 *
 * So each consumer gets a key with the OTHER tabs' specs nulled out. Nulled
 * rather than deleted, so every key keeps a fixed shape and a diff between two
 * of them is about values rather than about which fields exist.
 *
 * The shared contract for unit preferences: they are not a parameter and must
 * never become one. A unit is a lens on a number already computed, so changing
 * one must not re-run anything and must not flag a finished sweep or study as
 * stale. Keeping prefs out of `UiConfig` entirely (see `lib/unitsContext`)
 * makes that structural rather than a list of exclusions someone has to
 * remember to extend. It also keeps `Save config` unit-free: a config saved in
 * feet loads identically for someone working in metres.
 */
export function physicsKey(ui: UiConfig): string {
  return JSON.stringify({ ...toWireConfig(ui), sweep: null, study: null })
}

/**
 * The config as it should be *stored* on the server.
 *
 * A third representation, distinct from the two above and needed because they
 * answer different questions:
 *
 * - `toWireConfig` is what the physics backend accepts. It deliberately drops
 *   real design data the solver has no use for -- sweep bounds, study axes,
 *   labels -- so it is far too lossy to store.
 * - The raw `UiConfig` is what localStorage holds, and should stay that way:
 *   which cards you left collapsed is exactly what makes reopening feel like
 *   picking up where you left off (see persist.ts).
 *
 * What the *server document* wants is the middle: everything authored, none of
 * the view state. Collapsing a device card must not count as editing the
 * design -- otherwise merely tidying the panel marks it dirty, and once
 * checkouts land, a save is what holds a checkout open.
 *
 * `uid` goes too, for a different reason: `reviveUiConfig` regenerates uids on
 * every load, so storing them meant opening a design produced a payload that
 * differed from the stored one with no user edit at all.
 */
export function toStoredConfig(ui: UiConfig): UiConfig {
  return {
    ...ui,
    devices: ui.devices.map(({ collapsed: _c, uid: _u, ...device }) => device as UiDevice),
    study: ui.study.map(({ uid: _u, ...axis }) => axis as UiStudyAxis),
  }
}

/** What the Corners tab's result depends on: the vehicle and the corner
 *  bounds, but not the study axes. */
export function cornersKey(ui: UiConfig): string {
  return JSON.stringify({ ...toWireConfig(ui), study: null })
}

/** What the Sweep tab's result depends on: the vehicle and the study axes, but
 *  not the corner bounds. */
export function studyKey(ui: UiConfig): string {
  return JSON.stringify({ ...toWireConfig(ui), sweep: null })
}

/** PLAN.md §13.1, the worked example, as editable UI state. The app opens on
 *  it because every number quoted in the plan came from these inputs, which
 *  makes it the one config a reviewer can check the output against. */
export function defaultUiConfig(): UiConfig {
  const ref = REFERENCE_CONFIG
  const { d_body, l_body } = DEFAULT_VEHICLE
  return {
    vehicle: { ...DEFAULT_VEHICLE },
    site: {
      ...ref.site,
      source: 'isa',
      station: 'KNID',
      profile: 'standard',
      month: new Date().getMonth() + 1,
    },
    devices: ref.devices.map((d, i) => ({
      ...d,
      // Altitude triggers are edited in feet and set on an altimeter in feet,
      // so the default is the exact metric equivalent of a round foot value.
      // §13.1's 152 m is 500 ft already, one digit short.
      trigger: d.trigger.kind === 'ALTITUDE'
        ? { ...d.trigger, value: Math.round(d.trigger.value / 0.3048 / 50) * 50 * 0.3048 }
        : { ...d.trigger },
      uid: nextUid(),
      // The reference config uses the unmeasured Cx and n defaults, so it is
      // not "measured" -- see §15.3/§15.4.
      measured: false,
      catalog: i === 1
        ? {
            sku: 'IFC-48-S',
            vendor: 'Fruity Chutes',
            values: { CdS: 2.489, D0: 1.601, m_c: 0.213, j: 2 },
            overridden: [],
          }
        : null,
      collapsed: false,
    })),
    // These bounds mirror `physics/cases.default_sweep` exactly, and the
    // mirroring is checked by `units.test.ts`. They used to differ -- Cx read
    // 1.4-2.2 here against 1.2-1.8 there, and v_rel 5-15 against 5-20 -- which
    // meant the GUI and the CLI answered the same vehicle with different
    // sweeps and neither said so. The bounds are the documented §15.7 band,
    // not a UI preference, so there is one set of them.
    sweep: [
      { key: 'Cx', label: 'Opening force coefficient (Cx)', enabled: true,
        min: 1.2, max: 1.8, unit: '' },
      { key: 'n', label: 'Filling constant (n)', enabled: true,
        min: 6, max: 12, unit: 'diameters' },
      { key: 'delay', label: 'Deployment delay (dt)', enabled: true,
        min: 0, max: 1.0, unit: 's' },
      // The airframe attitude band, eqs (14)/(15). Swept as the two bounds
      // rather than a continuum -- attitude is a binary about which way the
      // vehicle is pointing, not a tolerance (§15.7).
      //
      // min/max here are a seed only. SweepForm renders this row read-only and
      // recomputes the band from the *current* vehicle, and `toWireConfig`
      // does the same before sending, so editing the airframe geometry moves
      // the bounds and a stored copy can never go stale.
      { key: 'CdS_body', label: 'Airframe attitude (axial \u2194 broadside)',
        enabled: true,
        min: round5(airframeBand(d_body, l_body)[0]),
        max: round5(airframeBand(d_body, l_body)[1]),
        kind: 'area', unit: 'm²' },
      { key: 'v_rel', label: 'Separation velocity (v_rel)', enabled: false,
        min: 5, max: 20, kind: 'speed', unit: 'm/s' },
      // Off by default: mass is measurable, so it is a tolerance rather than
      // an unknown, and sweeping it doubles the run count to describe
      // something you can put on a scale.
      { key: 'm', label: 'Descending mass (m)', enabled: false,
        min: round5(DEFAULT_VEHICLE.m * 0.95),
        max: round5(DEFAULT_VEHICLE.m * 1.05), kind: 'mass', unit: 'kg' },
    ],
    // Empty, deliberately -- unlike `sweep`, which opens on the documented
    // §15.7 band. There is no canonical trade study: which designs are worth
    // comparing depends entirely on what the user is trying to decide, and
    // seeding one would put numbers on screen that mean nothing to them.
    study: [],
    // Apogee, mass and lateral velocity default to typed-in (manual). The Recovery
    // tab flips these to read the ascent design once there is a flight run / model.
    sources: { apogeeFromDesign: false, massFromDesign: false, lateralFromDesign: false },
    // Still air by default; the Drift tab's wind selection resolves into this.
    wind: null,
    // Nose-down by default (the structural bound); the Drift tab can switch it, and
    // Full Flight reads it from here.
    airframeBound: 'axial',
  }
}

/** A blank device. CdS/D0/m_c are left at zero deliberately: schema.py needs
 *  them > 0, so an unfilled card fails validation loudly instead of quietly
 *  simulating a canopy that does not exist. */
export function blankDevice(name: string): UiDevice {
  return {
    name,
    CdS: 0, D0: 0, m_c: 0,
    j: 2, n: 8, Cx: 1.8,
    trigger: { kind: 'ALTITUDE', value: 500 * 0.3048 },  // 500 ft AGL
    delay: 0,
    k_eff: null,
    v_rel: 10,
    uid: nextUid(),
    catalog: null,
    collapsed: false,
    // Cx and n start as the unmeasured bands; only flight data unlocks them.
    measured: false,
  }
}
