/**
 * Reading and writing the shapes a param can take (SCHEMA.md, "Param value
 * shapes") without every editor re-checking `typeof`.
 */
import type { AutoNumber, AxialMethod, FinPoints, Material, ParamValue, Params, Position } from '../types'

export function isAuto(v: unknown): v is AutoNumber {
  return !!v && typeof v === 'object' && !Array.isArray(v) && 'auto' in v && 'value' in v
}

export function isPosition(v: unknown): v is Position {
  return !!v && typeof v === 'object' && !Array.isArray(v) && 'method' in v && 'value' in v
}

export function isMaterial(v: unknown): v is Material {
  return !!v && typeof v === 'object' && !Array.isArray(v) && 'density' in v && 'type' in v
}

/** A plain number, or the resolved value of an auto number. */
export function num(p: Params, key: string, fallback = 0): number {
  const v = p[key]
  if (typeof v === 'number') return v
  if (isAuto(v)) return v.value
  if (isPosition(v)) return v.value
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return fallback
}

export function auto(p: Params, key: string, fallback = 0): AutoNumber {
  const v = p[key]
  if (isAuto(v)) return v
  if (typeof v === 'number') return { auto: false, value: v }
  return { auto: false, value: fallback }
}

export function pos(p: Params, key: string, fallbackMethod: AxialMethod = 'top'): Position {
  const v = p[key]
  if (isPosition(v)) return v
  if (typeof v === 'number') return { method: fallbackMethod, value: v }
  return { method: fallbackMethod, value: 0 }
}

export function str(p: Params, key: string, fallback = ''): string {
  const v = p[key]
  return typeof v === 'string' ? v : fallback
}

export function bool(p: Params, key: string, fallback = false): boolean {
  const v = p[key]
  return typeof v === 'boolean' ? v : fallback
}

export function material(p: Params, key = 'material'): Material | null {
  const v = p[key]
  return isMaterial(v) ? v : null
}

export function points(p: Params, key = 'finpoints'): FinPoints {
  const v = p[key]
  if (Array.isArray(v) && v.every((pt) => Array.isArray(pt) && pt.length >= 2)) return v as FinPoints
  return []
}

/** `params` with `key` set; `undefined` deletes it (an absent override is "not overridden"). */
export function setParam(params: Params, key: string, value: ParamValue | undefined): Params {
  const next = { ...params }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

/**
 * The motor-mount block, when this component is one. SCHEMA.md does not spell
 * it out; `.ork` nests <motormount><overhang/><ignitionevent/>... and the
 * "params keys are .ork child names" rule makes it an object under `motormount`.
 */
export interface MotorMountParams { overhang?: number; ignitionevent?: string; ignitiondelay?: number }

export function motorMount(p: Params): MotorMountParams | null {
  const v = p.motormount
  if (v === true) return {}
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as MotorMountParams
  return null
}
