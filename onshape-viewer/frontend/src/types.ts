/** Shape of manifest.json, emitted by backend/onshape/build.py. */

export interface Material {
  name: string
  density: number
}

export interface Part {
  key: string
  partId: string
  instanceId: string
  occurrencePath: string[]
  /** Assembly instance name: the part's name with Onshape's " <n>" counter on it. */
  name: string
  /** The Part Studio's own name. Absent on manifests built before schema 2. */
  partName?: string | null
  sourceDocumentId: string
  sourceElementId: string
  configuration: string
  isStandardContent: boolean
  hidden: boolean
  material: Material | null
  /** True when Onshape had no material for this part, so it carries no mass. */
  materialDefaulted: boolean
  /** kg, straight from Onshape. Zero whenever `materialDefaulted` is true. */
  mass: number
  volume: number
  centroidLocal: [number, number, number]
  /** Onshape Z-up root assembly frame, precomputed at build time. */
  centroidWorld: [number, number, number]
  transform: number[]
  hasGeometry: boolean
}

export interface Totals {
  mass: number
  assemblyMass: number
  centroid: [number, number, number]
  assemblyCentroid: [number, number, number]
  partCount: number
  partsWithoutMaterial: number
  reconciliationDelta: number
  reconciliationRelative: number
  reconciled: boolean
}

export interface Manifest {
  schemaVersion: number
  source: {
    documentId: string
    documentName: string
    elementId: string
    versionId: string | null
    microversionId: string
    resolvedFrom: string
    assemblyName: string
    builtAt: string
    apiVersion: string
  }
  upAxisHandling: string
  totals: Totals
  parts: Part[]
  build: Record<string, number>
  warnings: string[]
}

export interface ModelSummary {
  id: string
  documentName: string | null
  assemblyName: string | null
  builtAt: string | null
  partCount: number | null
  partsWithoutMaterial: number | null
}

/**
 * A user's edits to one part, held only for the session.
 *
 * Onshape is the source of truth for everything else in `Part`; this is the one
 * place the viewer lets someone say otherwise, for parts the API has no mass
 * for. Nothing is written back to Onshape.
 */
export interface PartOverride {
  /**
   * A material the user picked from the catalog (see lib/materials), by key, or
   * null for Onshape's own. Its density and the part's exact volume give the
   * mass, unless `massOverridden` supersedes it with a typed-in number.
   */
  material: string | null
  /** Whether the user has taken the mass over from the material. */
  massOverridden: boolean
  /** kg. Null while the field is empty, which leaves the part with no mass. */
  mass: number | null
}

export interface OnshapeDocument {
  documentId: string
  name: string
  workspaceId: string
  owner: string | null
  modifiedAt: string | null
}

export interface OnshapeAssembly {
  elementId: string
  name: string
}

/**
 * Browsing results, plus where they came from.
 *
 * The picker is cache-first -- see backend/onshape/browse.py -- so it has to be
 * able to say whether a list is what Onshape holds right now or what it held
 * the last time someone asked, and offer to repull.
 */
export interface Browsed<T> {
  items: T[]
  fromCache: boolean
  /** ISO timestamp of the last refresh, or null if nothing is cached yet. */
  cachedAt: string | null
}

export interface BuildJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'error'
  message: string
  log: string[]
  url: string
  modelId: string | null
  startedAt: string
}
