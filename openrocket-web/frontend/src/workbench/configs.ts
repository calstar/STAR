/**
 * Flight-configuration helpers. OpenRocket names an unnamed configuration by
 * its motors, "[C6-5]" (FlightConfiguration.getName / the motor digest list).
 */
import type { Component, MotorChoice, MotorConfig, RocketDocument } from '../types'
import { walk } from '../lib/tree'
import { motorMount } from '../lib/params'
import { fmtNumber } from '../lib/units'

export function motorLabel(m: MotorChoice): string {
  const d = m.delay
  if (d == null) return m.designation
  if (!Number.isFinite(d) || d >= 1000) return `${m.designation}-P`
  return `${m.designation}-${fmtNumber(d, 1)}`
}

/** Motor mounts in tree order. */
export function motorMounts(doc: RocketDocument): Component[] {
  const out: Component[] = []
  walk(doc.rocket, (c) => {
    if (motorMount(c.params)) out.push(c)
  })
  return out
}

export function configLabel(doc: RocketDocument, cfg: MotorConfig): string {
  if (cfg.name) return cfg.name
  const mounts = motorMounts(doc)
  const motors = mounts.map((m) => cfg.motors[m.id]).filter(Boolean) as MotorChoice[]
  if (!motors.length) return '[No motors]'
  return `[${motors.map(motorLabel).join('; ')}]`
}
