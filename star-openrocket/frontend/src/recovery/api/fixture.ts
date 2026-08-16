/**
 * ============================ STUB, NOT PHYSICS ============================
 *
 * PLAN.md §11.11 item 2: "Stub POST /api/simulate returning a canned Result
 * fixture, so the frontend can build the full figure on day one in parallel
 * with the physics."
 *
 * This file is that canned result. It exists so the layout can be reviewed
 * before `solver.py` exists, and it survives afterwards as the frontend test
 * double (item 3).
 *
 * **Nothing here is a valid engineering number.** The trajectory comes from a
 * two-line constant-density drag integration with instantaneous inflation -- no
 * eq (23), no Pflanz, no snatch, no §6.4 band. It is shaped to look right on an
 * axis and nothing more.
 *
 * The scalar summaries ARE the real §13.2 figures, hand-copied, because a
 * fixture whose numbers are plausible is itself a check on the schema -- if the
 * layout cannot display 27 263 N next to 55 N legibly, that is worth finding
 * now. But they are transcribed constants, not computed here.
 *
 * Every consumer must surface `Result.git_sha === STUB_SHA` in the UI. The one
 * unacceptable outcome for this file is a reviewer mistaking it for output.
 * ===========================================================================
 */

import type {
  CaseId, CaseResult, Config, DeviceLoads, FlightEvent, Result, TrajectorySample,
} from '../types/schema'
import { G0 } from '../lib/units'

/** Sentinel git SHA. The real backend sends a real one; the UI keys its
 *  "stub data" banner off this exact string. */
export const STUB_SHA = 'STUB-NO-PHYSICS'

/** PLAN.md §13.1, the worked example. Every number in the document comes from
 *  this config, which makes it the right default to open the app on. */
export const REFERENCE_CONFIG: Config = {
  vehicle: {
    m: 5.67,
    h_a: 914,
    d_body: 0.1016,
    l_body: 1.44,
    z0: null,
    v0: null,
    v_lat: null,
    v_lat_dir: null,
  },
  site: {
    T_pad: 284.185,
    p_pad: 94209,
    lapse: null,
  },
  devices: [
    {
      name: 'drogue',
      CdS: 0.15, D0: 0.6, m_c: 0.06,
      j: 2, n: 8, Cx: 1.8,
      trigger: { kind: 'TIME', value: 2.0 },
      delay: 0,
      k_eff: 25000,
      v_rel: 10,
    },
    {
      name: 'main',
      CdS: 2.489, D0: 1.601, m_c: 0.213, // Iris Ultra IFC-48
      j: 2, n: 8, Cx: 1.8,
      trigger: { kind: 'ALTITUDE', value: 152 },
      delay: 0,
      k_eff: 17400,
      v_rel: 10,
    },
  ],
  // null, not []: the canonical corner set from cases.default_sweep.
  // An empty list would mean 'sweep nothing', which is a different run.
  sweep: null,
  study: null,
  wind: null,
}

const RHO = 1.16 // constant. The real solver integrates eq (5) down the column.

/**
 * Crude descent integrator. Forward Euler, constant density, canopies that
 * snap fully open the instant they are triggered.
 *
 * This is deliberately the dumbest thing that produces a curve of the right
 * shape. Do not extend it -- when the real endpoint lands, delete it.
 */
function integrate(
  drogueAt: number | null,   // seconds after start, null = never
  mainAtAlt: number | null,  // m AGL, null = never
  cdsBody: number,
): { traj: TrajectorySample[]; events: FlightEvent[] } {
  const m = REFERENCE_CONFIG.vehicle.m
  const drogue = REFERENCE_CONFIG.devices[0]
  const main = REFERENCE_CONFIG.devices[1]

  const dt = 0.05
  let z = REFERENCE_CONFIG.vehicle.h_a
  let v = 0 // positive downward
  let t = 0
  let drogueOut = false
  let mainOut = false

  const traj: TrajectorySample[] = []
  const events: FlightEvent[] = [
    { t: 0, kind: 'start', device: null, z, v: 0, label: 'Apogee' },
  ]

  while (z > 0 && t < 400) {
    if (!drogueOut && drogueAt !== null && t >= drogueAt) {
      drogueOut = true
      events.push({ t, kind: 'inflation_end', device: 'drogue', z, v,
                    label: 'Drogue open' })
    }
    if (!mainOut && mainAtAlt !== null && z <= mainAtAlt) {
      mainOut = true
      events.push({ t, kind: 'inflation_end', device: 'main', z, v,
                    label: 'Main open' })
    }

    const cds = cdsBody
      + (drogueOut ? drogue.CdS : 0)
      + (mainOut ? main.CdS : 0)
    const drag = 0.5 * RHO * cds * v * Math.abs(v)
    const a = G0 - drag / m

    traj.push({
      t: +t.toFixed(2),
      z: +z.toFixed(2),
      v: +v.toFixed(3),
      a: +a.toFixed(3),
      // Tension is the canopy's share of the drag. Not eq (19).
      F_T: +Math.max(0, drag * ((cds - cdsBody) / Math.max(cds, 1e-9))).toFixed(1),
      CdS_tot: +cds.toFixed(4),
    })

    v += a * dt
    z -= v * dt
    t += dt
  }

  const last = traj[traj.length - 1]
  events.push({ t: +t.toFixed(2), kind: 'ground', device: null, z: 0,
                v: last?.v ?? 0, label: 'Ground' })
  return { traj, events }
}

/** §13.2, axial bound. Transcribed, not computed. */
const DROGUE_LOADS: DeviceLoads = {
  device: 'drogue', v_s: 19.49, A: 12.4, X1: 0.94,
  F_inf: 55, F_peak: 52, F_num: 50, F_snatch: 1180, t_fill: 0.246,
  below_validity_floor: false,
}

const MAIN_LOADS: DeviceLoads = {
  device: 'main', v_s: 25.02, A: 0.309, X1: 0.266,
  F_inf: 1613, F_peak: 430, F_num: 455, F_snatch: 2090, t_fill: 0.512,
  below_validity_floor: false,
}

/** The §13.1 hardware safety factor, mirroring `physics/loads.SF_DEFAULT`. */
const STUB_SF = 1.5

/** §11.5's table. These are the real published figures for the §13 vehicle at
 *  the axial bound -- the load-conservative choice, stated because §6.4
 *  forbids picking silently. */
const CASE_NUMBERS: Record<CaseId, {
  descent: number; impact: number; ke: number; fmax: number
  status: CaseResult['status']; link: string | null
}> = {
  nominal:      { descent: 55,  impact: 6.00,  ke: 102,  fmax: 1613,
                  status: 'pass', link: 'quick_link' },
  simultaneous: { descent: 146, impact: 6.00,  ke: 102,  fmax: 910,
                  status: 'pass', link: 'quick_link' },
  no_main:      { descent: 38,  impact: 24.8,  ke: 1749, fmax: 55,
                  status: 'fail', link: null },
  no_drogue:    { descent: 35,  impact: 6.18,  ke: 108,  fmax: 27263,
                  status: 'fail', link: 'quick_link' },
}

function buildCase(id: CaseId): CaseResult {
  const cdsAxial = 0.00486
  const drogueTrigger = REFERENCE_CONFIG.devices[0].trigger.value
  const mainAlt = REFERENCE_CONFIG.devices[1].trigger.value

  const shape = {
    nominal:      () => integrate(drogueTrigger, mainAlt, cdsAxial),
    // Main fires at the drogue's trigger time, near apogee.
    simultaneous: () => integrate(drogueTrigger, REFERENCE_CONFIG.vehicle.h_a,
                                  cdsAxial),
    no_main:      () => integrate(drogueTrigger, null, cdsAxial),
    no_drogue:    () => integrate(null, mainAlt, cdsAxial),
  }[id]()

  const nums = CASE_NUMBERS[id]
  const loads: DeviceLoads[] =
    id === 'no_main' ? [DROGUE_LOADS]
    : id === 'no_drogue' ? [{ ...MAIN_LOADS, v_s: 103.0, X1: 0.266,
                              F_inf: 27263, F_peak: 7250 }]
    : [DROGUE_LOADS, MAIN_LOADS]

  return {
    case: id,
    trajectory: shape.traj,
    events: shape.events,
    device_loads: loads,
    descent_time: nums.descent,
    impact_velocity: nums.impact,
    impact_ke: nums.ke,
    h_equiv: (nums.impact * nums.impact) / (2 * G0), // eq (39)
    F_max: nums.fmax,
    // `fmax` is the eq (36) governing value, unfactored -- nominal 1613 N is
    // the main's F_inf. F_design used to be set to it directly, which made the
    // stub disagree with §11.5's published 2420 N. It is fmax * SF.
    F_peak_max: nums.fmax,
    safety_factor: STUB_SF,
    F_design: nums.fmax * STUB_SF,
    status: nums.status,
    governing_link: nums.link,
  }
}

export function stubResult(config: Config = REFERENCE_CONFIG): Result {
  return {
    schema_version: '0.1.0-stub',
    git_sha: STUB_SHA,
    generated: new Date().toISOString(),
    config,
    warnings: [
      'Opening force coefficient is the unmeasured 1.8 default on both '
      + 'devices, a ±20% band and the dominant term in the model.',
    ],
    cases: {
      nominal: buildCase('nominal'),
      simultaneous: buildCase('simultaneous'),
      no_main: buildCase('no_main'),
      no_drogue: buildCase('no_drogue'),
    },
    pad: {
      p_pad: 95461,
      T_pad: 284.9,
      rho_pad: 1.1673,
      source: 'standard column',
      lapse: -0.0065,
    },
    body_drag_band: { axial: 0.00486, broadside: 0.17556 },
  }
}
