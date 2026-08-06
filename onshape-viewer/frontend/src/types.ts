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
  name: string
  sourceDocumentId: string
  sourceElementId: string
  configuration: string
  isStandardContent: boolean
  hidden: boolean
  material: Material | null
  /** True when Onshape had no material for this part and a density was assumed. */
  materialDefaulted: boolean
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
  massMeasured: number
  massDefaulted: number
  assemblyMass: number
  centroid: [number, number, number]
  centroidMeasured: [number, number, number]
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
  defaultDensity: number
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
