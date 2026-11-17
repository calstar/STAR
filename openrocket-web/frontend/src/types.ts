/**
 * The wire contract, typed. Mirrors docs/SCHEMA.md and nothing else: the UI is
 * built against this file, so a field the schema does not name does not exist
 * here either. SI on the wire (m, kg, s, rad) except keys that say `Deg`.
 */

export type ComponentType =
  | 'rocket' | 'stage' | 'parallelstage' | 'podset'
  | 'nosecone' | 'bodytube' | 'transition'
  | 'trapezoidfinset' | 'ellipticalfinset' | 'freeformfinset' | 'tubefinset'
  | 'launchlug' | 'railbutton'
  | 'innertube' | 'tubecoupler' | 'centeringring' | 'bulkhead' | 'engineblock'
  | 'masscomponent' | 'shockcord' | 'parachute' | 'streamer'

export type AxialMethod = 'absolute' | 'after' | 'top' | 'middle' | 'bottom'

export interface AutoNumber { auto: boolean; value: number }
export interface Position { method: AxialMethod; value: number }
export type MaterialType = 'bulk' | 'surface' | 'line'
export interface Material { type: MaterialType; density: number; name: string }
export type FinPoints = [number, number][]

export type ParamValue =
  | number | string | boolean | null
  | AutoNumber | Position | Material | FinPoints
  | { [k: string]: unknown }

export type Params = Record<string, ParamValue | undefined>

export interface Component {
  id: string
  type: ComponentType
  name: string
  params: Params
  children: Component[]
}

export interface MotorChoice {
  designation: string
  manufacturer: string
  digest?: string
  delay?: number
  ignitionEvent?: string
  ignitionDelay?: number
}

export interface MotorConfig {
  id: string
  name: string
  default?: boolean
  stages: Record<string, boolean>
  motors: Record<string, MotorChoice>
}

export interface RocketDocument {
  version: number
  rocket: Component
  motorConfigs: MotorConfig[]
  selectedConfig: string | null
}

export interface Conditions {
  mach: number
  aoaDeg: number
  rollRate: number
  theta: number
  configId: string | null
}

export type ShapeKind = 'body' | 'fin' | 'internal' | 'recovery' | 'motor'

export interface FigureShape {
  id: string
  kind: ShapeKind
  points: [number, number][]
  closed: boolean
}

export interface Figure {
  bounds: { xmin: number; xmax: number; ymin: number; ymax: number }
  shapes: FigureShape[]
}

export interface ComponentAnalysis {
  id: string
  name: string
  type: ComponentType
  x: number
  length: number
  mass: number
  cgx: number
  cpx: number
  cna: number
  cd: number
}

export interface Analysis {
  conditions: Conditions
  reference: { length: number; area: number }
  length: number
  maxDiameter: number
  cg: { x: number; mass: number }
  cgEmpty: { x: number; mass: number }
  cp: { x: number; cna: number }
  stability: { calibers: number; percent: number }
  cd: { total: number; friction: number; pressure: number; base: number }
  components: ComponentAnalysis[]
  figure: Figure
  warnings: string[]
}

export interface MaterialEntry { name: string; density: number }
export type MaterialDb = Record<MaterialType, MaterialEntry[]>

export interface MotorSearchResult {
  designation: string
  manufacturer: string
  digest: string
  diameter: number
  length: number
  totalImpulse: number
  burnTime: number
  avgThrust: number
}

export interface Health { ok: boolean; openrocket: string }
export interface ExampleEntry { name: string }
