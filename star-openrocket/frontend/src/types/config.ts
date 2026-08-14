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
  /** Constant wind speed (m/s) and the bearing it blows from (deg). */
  windSpeed: number
  windDirection: number
  /** Which CP model the stability overlay shows. */
  cpModel: 'ours' | 'rocketpy' | 'both'
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
  return { inclination: 85, heading: 0, windSpeed: 5, windDirection: 270, cpModel: 'both' }
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
