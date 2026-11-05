/**
 * A design, as the request bodies its simulations take.
 *
 * A saved design stores what someone chose ("this part is 6061", "this mass is
 * typed in"); the simulation endpoints take what the physics needs (each part's
 * mass in kg, the recovery Config in wire form). This module is that conversion
 * for the browser, and `backend/design_requests.py` is the same conversion on the
 * server (POST /api/design/requests), so a saved design runs the same wherever it
 * is run from -- the design-tools MCP included.
 *
 * Both are held to the cases in `tests/fixtures/design_requests/`: this file by
 * designRequests.test.ts, the Python by tests/test_design_requests.py. Change one
 * without the other and a test fails. Keep the logic here; App.tsx and the tabs
 * call it rather than building bodies inline.
 */

import type { FaceRef, FlightDynamicsRequest, MotorSelection, OrkExportRequest, Part, PartOverride } from '../types'
import type { FlightParams, OrkConfig } from '../types/config'
import type { Config, UiConfig } from '../recovery/types/schema'
import { toWireConfig } from '../recovery/lib/serialise'
import { MATERIALS_BY_KEY } from './materials'

/**
 * The manifest as edited: a typed-in mass wins over everything, then a catalog
 * material (its density times the part's exact volume), then Onshape's own mass.
 */
export function applyOverrides(parts: Part[], overrides: Record<string, PartOverride>): Part[] {
  return parts.map((part) => {
    const override = overrides[part.key]
    if (!override) return part
    if (override.massOverridden) return { ...part, mass: override.mass ?? 0 }
    if (override.material) {
      const material = MATERIALS_BY_KEY[override.material]
      if (material) return { ...part, mass: part.volume * material.density }
    }
    return part
  })
}

/** Each part's effective mass, kg -- every part, hidden or not (hiding is a view choice). */
export function partMasses(parts: Part[], overrides: Record<string, PartOverride>): Record<string, number> {
  return Object.fromEntries(applyOverrides(parts, overrides).map((part) => [part.key, part.mass]))
}

/** The ascent inputs a request is built from: the design's CAD slice, or the live state. */
export interface AscentInputs {
  outerFaces: FaceRef[]
  finFaces: FaceRef[]
  finCount: number
  motor: MotorSelection | null
  railLength: number
  flight: Pick<FlightParams, 'inclination' | 'heading'>
}

/** The 6-DOF body: the ascent plus the shared site and wind the descent uses. */
export function flightDynamicsRequest(
  cad: AscentInputs,
  recovery: UiConfig,
  masses: Record<string, number>,
): FlightDynamicsRequest {
  const wire = toWireConfig(recovery)
  return {
    outerFaces: cad.outerFaces,
    // Nothing picked yet means auto-detect, not "no fins": an empty list is the
    // backend's explicit "this rocket has no fins".
    finFaces: cad.finFaces.length ? cad.finFaces : null,
    nFins: cad.finCount || null,
    overrides: masses,
    motor: cad.motor,
    railLength: cad.railLength,
    inclination: cad.flight.inclination,
    heading: cad.flight.heading,
    site: wire.site,
    wind: wire.wind,
  }
}

/** The .ork body: the flight body plus the recovery devices. */
export function orkRequest(cad: AscentInputs, recovery: UiConfig, masses: Record<string, number>): OrkExportRequest {
  return { ...flightDynamicsRequest(cad, recovery, masses), devices: toWireConfig(recovery).devices }
}

/** Every body for one design, keyed as POST /api/design/requests returns them. */
export function designRequests(
  config: OrkConfig,
  parts: Part[],
): { flightDynamics: FlightDynamicsRequest; ork: OrkExportRequest; recovery: Config } {
  const masses = partMasses(parts, config.cad.overrides)
  return {
    flightDynamics: flightDynamicsRequest(config.cad, config.recovery, masses),
    ork: orkRequest(config.cad, config.recovery, masses),
    recovery: toWireConfig(config.recovery),
  }
}
