/**
 * Banner for parts with no material assigned in Onshape.
 *
 * orkv2.md 7.1 requires this to be impossible to miss, and on real assemblies it
 * matters more than it sounds: Onshape excludes materialless parts from its own
 * mass total, so without this the numbers look clean and are quietly incomplete.
 *
 * The banner is not dismissable while any part is estimated. It shows the
 * measured/estimated split so it is always clear how much of the displayed mass
 * is an assumption.
 */

import { useState } from 'react'

import type { Manifest } from '../../types'
import { formatMass } from '../../lib/cm'

interface Props {
  manifest: Manifest
  density: number
  onDensityChange: (density: number) => void
  estimatedMass: number
  measuredMass: number
}

export function MaterialWarning({
  manifest,
  density,
  onDensityChange,
  estimatedMass,
  measuredMass,
}: Props) {
  const [expanded, setExpanded] = useState(false)
  const estimated = manifest.parts.filter((part) => part.materialDefaulted)

  if (estimated.length === 0) return null

  const total = measuredMass + estimatedMass
  const share = total > 0 ? (estimatedMass / total) * 100 : 0

  return (
    <div className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-semibold text-amber-300">
          {estimated.length} of {manifest.totals.partCount} parts have no material in Onshape
        </span>
        <span className="text-slate-300">
          Their mass is estimated, not measured — {formatMass(estimatedMass)} of{' '}
          {formatMass(total)} ({share.toFixed(0)}% of the total).
        </span>

        <label className="ml-auto flex items-center gap-2 text-slate-300">
          Assumed density
          <input
            type="number"
            min={1}
            step={10}
            value={density}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next) && next > 0) onDensityChange(next)
            }}
            className="w-24 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-right text-slate-100"
          />
          kg/m³
        </label>

        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="rounded border border-amber-500/50 px-2 py-1 text-amber-200 hover:bg-amber-500/20"
        >
          {expanded ? 'Hide' : 'Show'} affected parts
        </button>
      </div>

      {expanded && (
        <ul className="mt-3 grid gap-1 text-xs text-slate-300 sm:grid-cols-2 lg:grid-cols-3">
          {estimated.map((part) => (
            <li key={part.key} className="flex justify-between gap-2 rounded bg-slate-900/50 px-2 py-1">
              <span className="truncate">{part.name}</span>
              <span className="shrink-0 tabular-nums text-amber-300">
                {formatMass(part.volume * density)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
