/**
 * Banner for parts with no material assigned in Onshape.
 *
 * orkv2.md 7.1 requires this to be impossible to miss, and on real assemblies it
 * matters more than it sounds: Onshape excludes materialless parts from its own
 * mass total, so without this the numbers look clean and are quietly incomplete.
 *
 * Nothing is assumed on their behalf -- no density is substituted -- so a part
 * in here weighs nothing until someone gives it a mass in the properties panel.
 * The banner stays up while any part is still unaccounted for, and counts down
 * as they are filled in.
 */

import { useState } from 'react'

import type { Part } from '../../types'
import { formatMass } from '../../lib/cm'
import { displayName } from '../../lib/names'

interface Props {
  /** Parts with any user overrides already applied. */
  parts: Part[]
}

export function MaterialWarning({ parts }: Props) {
  const [expanded, setExpanded] = useState(false)

  const unassigned = parts.filter((part) => part.materialDefaulted)
  if (unassigned.length === 0) return null

  const missing = unassigned.filter((part) => !(part.mass > 0))
  const assigned = unassigned.length - missing.length

  // The banner takes the colour of what it is reporting: red while any part is
  // still unaccounted for, green once every one of them has a mass.
  const settled = missing.length === 0

  return (
    <div
      className={`border-b px-4 py-3 text-sm ${
        settled ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-red-500/40 bg-red-500/10'
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={`font-semibold ${settled ? 'text-emerald-300' : 'text-red-300'}`}>
          {unassigned.length} of {parts.length} parts have no material in Onshape
        </span>
        {/* A mass on one of these parts can only have come from someone typing
            it in, so the wording says so rather than leaving it ambiguous
            whether the viewer assumed something. */}
        <span className="text-slate-300">
          {missing.length > 0
            ? `${missing.length} have no mass and are left out of the centre of mass — enter one in the properties panel.`
            : 'You have entered a mass for all of them.'}
          {assigned > 0 && missing.length > 0 && ` You have entered a mass for the other ${assigned}.`}
        </span>

        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={`ml-auto rounded border px-2 py-1 ${
            settled
              ? 'border-emerald-500/50 text-emerald-200 hover:bg-emerald-500/20'
              : 'border-red-500/50 text-red-200 hover:bg-red-500/20'
          }`}
        >
          {expanded ? 'Hide' : 'Show'} affected parts
        </button>
      </div>

      {expanded && (
        <ul className="mt-3 grid gap-1 text-xs text-slate-300 sm:grid-cols-2 lg:grid-cols-3">
          {unassigned.map((part) => (
            <li key={part.key} className="flex justify-between gap-2 rounded bg-slate-900/50 px-2 py-1">
              <span className="truncate">{displayName(part).name}</span>
              <span
                className={`shrink-0 tabular-nums ${
                  part.mass > 0 ? 'text-emerald-300' : 'text-red-400'
                }`}
              >
                {part.mass > 0 ? formatMass(part.mass) : 'no mass'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
