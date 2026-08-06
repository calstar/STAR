/**
 * Display names.
 *
 * An assembly instance is named after its part with a counter appended --
 * "Bulkhead <1>", "Bulkhead <2>" -- and that counter is noise in a viewer that
 * already groups copies together. Stripping it with a regex alone would be
 * wrong for a part someone genuinely called "Fin <2>", so the suffix only comes
 * off when what is left matches `partName`, the Part Studio's own name for the
 * part. Manifests built before schema 2 carry no `partName`, and there the
 * regex is all there is to go on.
 */

import type { Part } from '../types'

const INSTANCE_SUFFIX = /^(.*?)\s*<(\d+)>$/

export interface DisplayName {
  /** The part's name, without the instance counter. */
  name: string
  /** Which copy this is, or null when the name carried no counter. */
  instance: number | null
}

export function displayName(part: Part): DisplayName {
  const match = INSTANCE_SUFFIX.exec(part.name)
  if (!match) return { name: part.name, instance: null }

  const stripped = match[1]
  // "Fin <2>" as a part name gives an instance named "Fin <2> <1>": the strip
  // leaves "Fin <2>", which matches, so only the counter goes. A part actually
  // named "Fin <2>" with no counter strips to "Fin", which does not match, so
  // the name is left alone.
  if (part.partName && stripped !== part.partName) return { name: part.name, instance: null }

  return { name: stripped, instance: Number(match[2]) }
}
