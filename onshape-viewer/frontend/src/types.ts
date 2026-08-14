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

/** A single B-rep face of a placed occurrence: the picking/selection unit. */
export interface FaceRef {
  key: string // occurrence key ("occ:<path>")
  faceId: string
}

export interface AxisInfo {
  origin: [number, number, number]
  direction: [number, number, number]
}

/** Auto-detected outer airframe faces, from GET .../outer-surface. */
export interface OuterSurfaceGuess {
  faces: FaceRef[]
  axis: AxisInfo
}

/**
 * A motor's datafile. The UI labels these "Full model" (RockSim) vs "Basic model"
 * (RASP) by `format`: thrustcurve.org serves both with mid-casing CG, so `quality`
 * (real per-time CG vs the length/2 assumption) rarely differs and is not the label.
 */
export interface MotorSimfileRef {
  simfileId: string
  format: 'RASP' | 'RockSim'
  quality: 'full' | 'basic'
}

/** One row in the motor picker (from GET /api/motors). Weights in grams, dims in mm. */
export interface MotorSummary {
  motorId: string
  manufacturer: string
  manufacturerAbbrev: string
  designation: string
  commonName: string
  impulseClass: string
  diameter: number
  length: number
  type: string
  totalWeightG: number | null
  propWeightG: number | null
  delays: string | null
  avgThrustN: number | null
  maxThrustN: number | null
  totImpulseNs: number | null
  burnTimeS: number | null
  simfiles: MotorSimfileRef[]
}

/** One datafile of a motor with its full time-domain curves (from GET /api/motors/{id}). */
export interface MotorSimfileDetail {
  simfileId: string
  format: 'RASP' | 'RockSim'
  quality: 'full' | 'basic'
  designation: string
  manufacturer: string
  length: number
  diameter: number
  wetMass: number
  dryMass: number
  propMass: number
  burnTime: number
  /** Parallel arrays: time (s), thrust (N), CG from the fore end (m), total mass (kg). */
  time: number[]
  thrust: number[]
  cgX: number[]
  mass: number[]
}

export interface MotorDetail {
  meta: { manufacturer?: string; designation?: string } | null
  simfiles: MotorSimfileDetail[]
}

export interface MotorSearchResult {
  items: MotorSummary[]
  /** Total matches before the limit slice, for a "showing N of M" hint. */
  total: number
  fetchedAt: string | null
  available: boolean
}

/** A motor chosen to fold into the CG / static margin. */
export interface MotorSelection {
  motorId: string
  simfileId?: string | null
  /**
   * Offset of the motor's aft end from its datum (m), aft-positive. The datum is the
   * airframe base, or `refFace` when set. 0 = aft-flush with the base / at the face.
   */
  aftOffset?: number
  /** A face to measure the aft end from; must be normal to the rocket axis. */
  refFace?: FaceRef | null
  state: 'launch' | 'burnout'
}

/** The motor block echoed back in a StabilityResult (masses kg, positions m). */
export interface MotorResult {
  motorId: string
  simfileId: string
  name: string
  quality: 'full' | 'basic'
  format: 'RASP' | 'RockSim'
  state: 'launch' | 'burnout'
  wetMass: number
  dryMass: number
  propMass: number
  length: number
  diameter: number
  burnTime: number
  cgFromNose: number | null
  /** Aft-end offset from the datum (base or reference face), m. */
  aftFromBase: number | null
  /** Motor cylinder endpoints (Onshape Z-up frame) and radius (m), for drawing it. */
  aftWorld: [number, number, number] | null
  foreWorld: [number, number, number] | null
  radius: number | null
  /** Motor CG (Onshape Z-up frame) for the chosen state, to fold into the CM marker. */
  cgWorld: [number, number, number] | null
}

export interface StabilityRequest {
  /** Approved outer faces; empty asks the backend to auto-detect them. */
  outerFaces: FaceRef[]
  /** Approved fin faces; null auto-detects, [] means no fins. */
  finFaces?: FaceRef[] | null
  /** Override the detected fin count. */
  nFins?: number | null
  /** Occurrence key -> resolved mass (kg), overriding the manifest mass. */
  overrides: Record<string, number>
  axis?: AxisInfo | null
  /** Optional motor to include in the CG / static margin. */
  motor?: MotorSelection | null
  /** Guided rail length (m) for the flight sim's off-rail velocity. */
  railLength?: number
}

/** One fin's exposed planform outline, in the Onshape Z-up frame. */
export interface FinPlanform {
  lead: [number, number, number][]
  trail: [number, number, number][]
}

export interface FinData {
  count: number
  cna: number
  rootChord: number
  tipChord: number
  sweep: number
  span: number
  area: number
  planforms: FinPlanform[]
  /** Azimuthally symmetric fin set. False (e.g. a fin removed) ⇒ off-axis CP, warn. */
  symmetric: boolean
}

/** Auto-detected fin faces, from GET .../fins. */
export interface FinGuess {
  faces: FaceRef[]
  count: number
  axis: AxisInfo
  bodyRadius: number
  planforms: FinPlanform[]
}

/** CG, CP and static margin from POST .../stability. All backend-computed. */
export interface StabilityResult {
  cg: { world: [number, number, number]; fromNose: number }
  cp: { world: [number, number, number]; fromNose: number }
  /** Unit axis direction (nose→tail), so the client can recompute margin on a mass edit. */
  axisDirection: [number, number, number]
  cna: number
  refDiameter: number
  rMax: number
  staticMargin: number | null
  bodyLength: number
  mass: number
  fins: FinData
  /** Present only when a motor was included in the request. */
  motor?: MotorResult | null
}

/** One time step of the ascent sim. Masses kg, lengths m, times s, margin cal. */
export interface FlightSample {
  t: number
  altitude: number
  velocity: number
  acceleration: number
  thrust: number
  mass: number
  staticMargin: number | null
  /** Mach number at this sample (v / speed of sound), so margin can be read vs Mach. */
  mach: number
}

/** Ascent flight profile from POST .../flight (no drag yet; apogee is an upper bound). */
export interface FlightResult {
  motor: { name: string; format: string }
  samples: FlightSample[]
  apogee: number
  apogeeTime: number
  maxVelocity: number
  maxAcceleration: number
  burnoutTime: number
  burnoutAltitude: number
  burnoutVelocity: number
  liftoffMass: number
  thrustToWeight: number
  liftoff: boolean
  /** Guided rail length (m) and the velocity/time at full departure (rear lug clears). */
  railLength: number
  railExitVelocity: number | null
  railExitTime: number | null
  railCleared: boolean
  /** Minimum static margin over the flight (the transonic dip) and where it occurs. */
  minStaticMargin: number | null
  minMarginTime: number | null
  minMarginMach: number | null
}

// -- Flight dynamics (6-DOF ascent via RocketPy) ------------------------------

export interface FlightDynamicsSample {
  t: number
  altitude: number
  speed: number
  mach: number
  acceleration: number
  dynamicPressure: number
  angleOfAttack: number | null
  angleFromVertical: number
  stabilityMarginRocketpy: number
  stabilityMarginOurs: number | null
  driftX: number
  driftY: number
  bendingMoment: number
  omegaPitch: number
}

export interface FlightDynamicsResult {
  motor: { name: string; format: string }
  samples: FlightDynamicsSample[]
  fft: { frequency: number[]; amplitude: number[] }
  apogee: number
  apogeeTime: number
  maxSpeed: number
  maxMach: number
  maxAcceleration: number
  maxDynamicPressure: number
  maxDynamicPressureTime: number
  outOfRailVelocity: number
  outOfRailStabilityMargin: number
  minStabilityMargin: number
  minStabilityMarginTime: number
  minStabilityMarginOurs: number | null
  maxAngleOfAttack: number
  maxBendingMoment: number
  driftDistance: number
  driftBearing: number
  launchStable: boolean
  approximations: string[]
}

/** Launch conditions for the 6-DOF flight, on top of the geometry/motor request. */
export interface FlightDynamicsRequest extends StabilityRequest {
  inclination?: number
  heading?: number
  windSpeed?: number
  windDirection?: number
  elevation?: number
  latitude?: number
  longitude?: number
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
