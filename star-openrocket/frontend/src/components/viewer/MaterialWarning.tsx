/**
 * Banner for parts with no material assigned in Onshape.
 *
 * orkv2.md 7.1 requires this to be impossible to miss, and on real assemblies it
 * matters more than it sounds: Onshape excludes materialless parts from its own
 * mass total, so without this the numbers look clean and are quietly incomplete.
 *
 * Nothing is assumed on their behalf -- no density is substituted -- so a part
 * in here weighs nothing until someone gives it a mass in the properties panel.
 * The banner stays up while any part is still unaccounted for and turns green
 * once every one of them has a mass. Which parts they are is read straight off
 * the model, where they carry their status colour, so this stays a single line.
 */

import type { Part } from '../../types'

interface Props {
  /** Parts with any user overrides already applied. */
  parts: Part[]
}

export function MaterialWarning({ parts }: Props) {
  const unassigned = parts.filter((part) => part.materialDefaulted)
  if (unassigned.length === 0) return null

  // Red while any of them is still without a mass, green once all are filled in.
  const settled = unassigned.every((part) => part.mass > 0)

  return (
    <div
      className={`border-b px-4 py-2 text-sm font-semibold ${
        settled
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          : 'border-red-500/40 bg-red-500/10 text-red-300'
      }`}
    >
      {unassigned.length} of {parts.length} parts have no material in Onshape
    </div>
  )
}
