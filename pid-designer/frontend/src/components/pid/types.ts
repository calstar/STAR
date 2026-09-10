import type { ParamValue } from './params';
import type { LineSegment } from './segments';

export type ComponentType =
  | 'RTD' | 'PT' | 'PG' | 'LC' | 'TC'
  | 'MAN' | 'ROT' | 'SOL'
  | 'PR' | 'RV' | 'CV' | 'QD'
  | 'TANK' | 'INJECTOR' | 'ENGINE' | 'MANIFOLD'
  | 'KBOTTLE' | 'DEWAR'
  | 'TEXT' | 'REGION'
  | 'JUNCTION';

export type FluidType = 'fuel' | 'lox' | 'pressurant' | 'default';

export const FLUID_COLORS: Record<FluidType, string> = {
  fuel:       '#f97316',
  lox:        '#60a5fa',
  pressurant: '#ef4444',
  default:    '#94a3b8',
};

export interface PIDNodeData {
  componentType: ComponentType;
  label: string;
  /**
   * The species this component *declares*, for sources. Everything downstream
   * inherits it -- see `fluids.ts` -- so this is set on tanks and bottles and
   * left alone everywhere else.
   */
  fluid?: string;
  /** Superseded by `fluid`. Read for migration only; see `declaredFluid`. */
  fluidType?: FluidType;
  /**
   * Catalogue part number. When set, the numbers below are overrides on top of
   * what the part already says -- the drawing should not be where a datasheet
   * lives.
   */
  partNumber?: string;
  /** Explicit colour override, `#rrggbb`. Beats the fluid colour when set. */
  color?: string;
  /** Which page of the diagram this lives on. */
  page?: string;
  /** For a sensor: the id of the component or line it is clipped to. */
  attachedTo?: string;
  /**
   * Per-port detail, keyed by port id: what a port is called and what it is
   * for. Only ports that differ from the default appear — a manifold with four
   * plain outlets stores nothing. See `ports.ts`.
   */
  ports?: Record<string, { label?: string; kind?: 'flow' | 'instrument' | 'plug' }>;
  /**
   * For a manifold: the block's size and where each port sits, as a fraction
   * of the way round its perimeter. Absent means the even default.
   */
  geometry?: { width: number; height: number; positions: Record<string, number> };
  notes?: string;
  labelOffset?: { x: number; y: number };
  rotation?: number;
  /**
   * Hardware numbers, keyed by the names in `spec.ts`. Each carries its unit
   * and its provenance -- see `params.ts` -- so a value can cross into
   * feed-twin without being re-typed or re-guessed.
   */
  params?: Record<string, ParamValue>;
  /**
   * Categorical choices, keyed by the names in `spec.ts`: a valve's fail
   * state, which side of the umbilical a QD is on. Strings, because these are
   * enumerations rather than quantities and carry no unit.
   */
  options?: Record<string, string>;
}

/** A line: what the pipe between two components actually is. */
export interface PIDEdgeData {
  /** Which of feed-twin's branch components this run is. */
  lineType?: 'pipe' | 'flex_hose' | 'bend' | 'fitting';
  /**
   * What the run is actually made of: ordered by bore, with an unordered bag
   * of fittings in each. Optional — a line without them behaves as it always
   * has. See `segments.ts`.
   */
  segments?: LineSegment[];
  params?: Record<string, ParamValue>;
  options?: Record<string, string>;
  partNumber?: string;
  color?: string;
  page?: string;
  /** Superseded by fluid propagation; kept so old diagrams still draw. */
  fluidType?: FluidType;
  [key: string]: unknown;
}

export interface ComponentDef {
  /** Palette entry id. Usually the component type, but two entries may drop
   *  the same type with different presets -- see the HP/LP transducers. */
  id: string;
  type: ComponentType;
  label: string;
  fullName: string;
  group: 'Sensors' | 'Valves' | 'Flow Control' | 'Hardware' | 'Supplies' | 'Annotation';
  /** Options stamped onto the node at drop time. */
  preset?: Record<string, string>;
  /**
   * Species stamped on at drop time, for supplies. A K-bottle entry is picked
   * from the palette already knowing what is in it, and everything downstream
   * inherits that -- so the common case needs no trip to the config at all.
   */
  fluid?: string;
}

export const COMPONENT_DEFS: ComponentDef[] = [
  { id: 'RTD',    type: 'RTD', label: 'RTD_#',   fullName: 'RTD', group: 'Sensors' },
  { id: 'TC',     type: 'TC',  label: 'TC_#',    fullName: 'Thermocouple',                    group: 'Sensors' },
  { id: 'PT_HP',  type: 'PT',  label: 'PT-HP_#', fullName: 'Transducer (high press)',        group: 'Sensors' },
  { id: 'PT_LP',  type: 'PT',  label: 'PT-LP_#', fullName: 'Transducer (low press)',          group: 'Sensors' },
  { id: 'PG',     type: 'PG',  label: 'PG_#',    fullName: 'Gauge',                  group: 'Sensors' },
  { id: 'LC',     type: 'LC',  label: 'LC_#',    fullName: 'Load cell',                       group: 'Sensors' },

  { id: 'MAN',    type: 'MAN', label: 'MAN_#',   fullName: 'Ball valve, manual',             group: 'Valves' },
  { id: 'ROT',    type: 'ROT', label: 'ROT_#',   fullName: 'Ball valve, rotary',             group: 'Valves' },
  { id: 'SOL',    type: 'SOL', label: 'SOL_#',   fullName: 'Solenoid valve',                  group: 'Valves' },

  { id: 'PR',     type: 'PR',  label: 'PR_#',    fullName: 'Regulator',              group: 'Flow Control' },
  { id: 'RV',     type: 'RV',  label: 'RV_#',    fullName: 'Relief valve',                    group: 'Flow Control' },
  { id: 'CV',     type: 'CV',  label: 'CV_#',    fullName: 'Check valve',                     group: 'Flow Control' },
  { id: 'QD',     type: 'QD',  label: 'QD_#',    fullName: 'Quick disconnect',    group: 'Flow Control',
    preset: { service: 'fluid' } },
  { id: 'QD_H',   type: 'QD',  label: 'HQD_#',   fullName: 'Hydraulic QD',        group: 'Flow Control',
    preset: { service: 'hydraulic' } },

  { id: 'TANK',     type: 'TANK',     label: 'TANK',  fullName: 'Tank',                group: 'Hardware' },
  { id: 'KBOTTLE',  type: 'KBOTTLE',  label: 'KB_#',  fullName: 'Pressurant bottle',          group: 'Supplies', fluid: 'nitrogen' },
  { id: 'DEWAR',    type: 'DEWAR',    label: 'DW_#',  fullName: 'Dewar',                      group: 'Supplies', fluid: 'nitrogen' },
  { id: 'MANIFOLD', type: 'MANIFOLD', label: 'MAN-F', fullName: 'Manifold',                   group: 'Hardware' },
  { id: 'ENGINE',   type: 'ENGINE',   label: 'ENG',   fullName: 'Injector + chamber',         group: 'Hardware' },
  { id: 'INJECTOR', type: 'INJECTOR', label: 'INJ',   fullName: 'Injector only',           group: 'Hardware' },

  { id: 'REGION', type: 'REGION', label: 'Section', fullName: 'Section box', group: 'Annotation' },
  { id: 'TEXT',   type: 'TEXT',   label: 'Text',    fullName: 'Text',                       group: 'Annotation' },
];

/** The palette entry a node was dropped from, for defaulting its label. */
export function defFor(id: string): ComponentDef | undefined {
  return COMPONENT_DEFS.find(d => d.id === id);
}
