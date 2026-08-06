/**
 * Centre of mass over an arbitrary subset of parts.
 *
 * This is a plain mass-weighted sum of `centroidWorld`, which the build step
 * already resolved into the root assembly frame. No geometry is touched and no
 * request is made, so toggling parts stays interactive with thousands of them.
 *
 * Never integrate the centre of mass from the mesh instead: tessellation is
 * lossy, the meshes are not guaranteed watertight, and the error is silent
 * (orkv2.md 3.1). The numbers here come from the B-rep via the API.
 */

import type { Part } from '../types'

export interface CMResult {
  /** Mass-weighted centroid in the Onshape Z-up frame, metres. */
  centroid: [number, number, number]
  /** Total mass, kg. */
  mass: number
  /** Portion of `mass` that came from an assumed density rather than a material. */
  massDefaulted: number
  partCount: number
}

const ZERO: CMResult = {
  centroid: [0, 0, 0],
  mass: 0,
  massDefaulted: 0,
  partCount: 0,
}

export function centreOfMass(parts: Part[]): CMResult {
  let mass = 0
  let massDefaulted = 0
  let x = 0
  let y = 0
  let z = 0

  for (const part of parts) {
    const m = part.mass
    if (!(m > 0)) continue
    x += part.centroidWorld[0] * m
    y += part.centroidWorld[1] * m
    z += part.centroidWorld[2] * m
    mass += m
    if (part.materialDefaulted) massDefaulted += m
  }

  if (mass <= 0) return { ...ZERO, partCount: parts.length }

  return {
    centroid: [x / mass, y / mass, z / mass],
    mass,
    massDefaulted,
    partCount: parts.length,
  }
}

/** Format a length in metres, with millimetres for readability. */
export function formatMetres(value: number): string {
  return `${value.toFixed(4)} m`
}

export function formatMass(value: number): string {
  return value < 1 ? `${(value * 1000).toFixed(1)} g` : `${value.toFixed(4)} kg`
}
