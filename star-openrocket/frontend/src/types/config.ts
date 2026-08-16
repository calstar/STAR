/**
 * ViewerConfig — the user inputs that make up one saved "design".
 *
 * A design is a named analysis carrying its own model reference (mirrors the
 * recovery calculator's designs). Everything a session sets that should survive a
 * reload and be versionable lives here: the loaded model, per-part mass/material
 * overrides, the body/fin face selections, the motor and its placement, the rail
 * length, and the Flight Dynamics launch params. Derived results are not stored —
 * they are recomputed from these.
 *
 * Deliberately out: part *visibility* (view state, and an empty set reads as
 * "all hidden"); the axis (auto-detected, not a user input).
 */

import type { FaceRef, MotorSelection, PartOverride } from '../types'

export interface FlightParams {
  /** Rail angle from horizontal (deg); 90 = vertical. */
  inclination: number
  /** Rail heading from north (deg). */
  heading: number
  /** Which CP model the stability overlay shows. */
  cpModel: 'ours' | 'rocketpy' | 'both'
  /** Which series are ticked on the Flight Dynamics compare plot. Persisted (a view
   *  preference, not physics) so the chosen overlay survives reloads and travels in the
   *  save file like everything else. */
  compareSeries: string[]
  /** Same, for the Full Flight compare plot (its own series set: altitude/speed/accel). */
  fullCompareSeries: string[]
}

export interface ViewerConfig {
  /** Bumped only on a breaking shape change so an old blob is ignored, not crashed on. */
  version: 1
  modelId: string | null
  /** Occurrence key → override (material / typed-in mass). Map serialised to an object. */
  overrides: Record<string, PartOverride>
  outerFaces: FaceRef[]
  finFaces: FaceRef[]
  finCount: number
  motor: MotorSelection | null
  railLength: number
  flight: FlightParams
}

export function defaultFlightParams(): FlightParams {
  return {
    inclination: 85, heading: 0, cpModel: 'both',
    compareSeries: ['altitude', 'speed'],
    fullCompareSeries: ['altitude', 'speed'],
  }
}

export function defaultViewerConfig(): ViewerConfig {
  return {
    version: 1,
    modelId: null,
    overrides: {},
    outerFaces: [],
    finFaces: [],
    finCount: 0,
    motor: null,
    railLength: 1.0,
    flight: defaultFlightParams(),
  }
}

// -- Unified design --------------------------------------------------------
//
// One saved design spans the whole app: the CAD/stability/ascent inputs
// (`cad`) and the recovery calculator inputs (`recovery`). Both slices survive
// a reload and are versioned together by the single header design bar.

import type { UiConfig } from '../recovery/types/schema'
import { defaultUiConfig } from '../recovery/lib/serialise'

export interface OrkConfig {
  version: 1
  cad: ViewerConfig
  recovery: UiConfig
}

export function defaultOrkConfig(): OrkConfig {
  return { version: 1, cad: defaultViewerConfig(), recovery: defaultUiConfig() }
}
