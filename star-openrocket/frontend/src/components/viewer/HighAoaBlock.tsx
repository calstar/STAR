/**
 * Static stability at angle of attack: the critical angle where the body's crossflow
 * lift drags the CP onto the CG, and the crosswind that puts a rocket there as it
 * leaves the rail. Computed by the backend (aero/high_aoa.py); this only renders it.
 */

import type { HighAoaResult } from '../../types'
import { useUnits } from '../../lib/units/unitsContext'
import { Row } from './Row'

/** Rail-exit speeds shown in the narrow panel (the backend reports a few more). */
const SHOWN_SPEEDS = [20, 25, 30]
/** Angles the margin is read out at. */
const SHOWN_ANGLES = [5, 10, 15]

/** Tone for the critical angle. A 5 m/s crosswind at a 30 m/s rail exit is 9.5°, and
 *  fins stall in the high teens, so below 10° is a rocket that wind can tip over and
 *  15° and up is comfortable. */
export function criticalTone(deg: number | null): string {
  if (deg === null) return 'text-emerald-300'
  if (deg < 10) return 'text-rose-400'
  if (deg < 15) return 'text-amber-300'
  return 'text-emerald-300'
}

export function formatCritical(deg: number | null): string {
  if (deg === null) return 'none (stable to 90°)'
  if (deg === 0) return '0° (unstable)'
  return `${deg.toFixed(1)}°`
}

export function HighAoaBlock({ h, liveCgFromNose }: { h: HighAoaResult; liveCgFromNose: number | null }) {
  const { q } = useUnits()
  const stale = liveCgFromNose != null && Math.abs(liveCgFromNose - h.cgFromNose) > 1e-3
  const at = (a: number) => h.curve.find((c) => c.aoa === a)
  return (
    <div className="mt-2 border-t border-[var(--color-border)] pt-2">
      <div
        className="mb-1 flex items-baseline justify-between"
        title="The angle of attack where the body's crossflow lift (growing as sin²α, centred on the body's side area) pulls the CP onto the CG. Above it the rocket turns further instead of righting itself."
      >
        <span className="text-[var(--color-text-muted)]">Critical angle of attack</span>
        <span className={`font-semibold tabular-nums ${criticalTone(h.criticalAoaDeg)}`}>
          {formatCritical(h.criticalAoaDeg)}
        </span>
      </div>
      {SHOWN_ANGLES.map((a) => {
        const c = at(a)
        return c ? <Row key={a} label={`Margin at ${a}°`} value={`${c.margin.toFixed(2)} cal`} small /> : null
      })}
      {h.maxCrosswind
        .filter((w) => SHOWN_SPEEDS.includes(w.railSpeed))
        .map((w) => (
          <Row
            key={w.railSpeed}
            label={`Max crosswind, ${q(w.railSpeed, 'speed')} off rail`}
            value={q(w.maxCrosswind, 'speed')}
            small
          />
        ))}
      <p className="mt-1 text-2xs text-[var(--color-text-muted)]">
        Body side area {h.sideAreaRatio.toFixed(1)}× the reference area, centred {q(h.sideCentroidFromNose, 'length')} from
        the nose
        {h.overturningPerRad2 > 0
          ? `, ${q(h.cgFromNose - h.sideCentroidFromNose, 'length')} ahead of the CG: its lift pushes the angle further.`
          : ', aft of the CG: its lift helps.'}{' '}
        {h.model}.
      </p>
      {stale && (
        <p className="mt-1 text-2xs text-amber-300">
          Computed at CG {q(h.cgFromNose, 'length')}; the mass has changed since. Recompute to update.
        </p>
      )}
    </div>
  )
}
