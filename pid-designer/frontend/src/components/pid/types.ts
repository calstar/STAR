import type { ParamValue } from './params';

export type ComponentType =
  | 'RTD' | 'PT' | 'PG' | 'LC' | 'TC'
  | 'MAN' | 'ROT' | 'SOL'
  | 'PR' | 'RV' | 'CV' | 'QD'
  | 'TANK' | 'INJECTOR' | 'ENGINE' | 'MANIFOLD'
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
  group: 'Sensors' | 'Valves' | 'Flow Control' | 'Hardware' | 'Annotation';
  /** Options stamped onto the node at drop time. */
  preset?: Record<string, string>;
}

export const COMPONENT_DEFS: ComponentDef[] = [
  { id: 'RTD',    type: 'RTD', label: 'RTD_#',   fullName: 'Resistance Temperature Detector', group: 'Sensors' },
  { id: 'TC',     type: 'TC',  label: 'TC_#',    fullName: 'Thermocouple',                    group: 'Sensors' },
  // Split because a 10 000 psi bottle transducer and a 500 psi tank
  // transducer are different parts, and a drawing that calls both "PT" hides
  // the one mistake that matters -- fitting the low one to the high side.
  { id: 'PT_HP',  type: 'PT',  label: 'PT-HP_#', fullName: 'Pressure Transducer (high press)', group: 'Sensors',
    preset: { pressureClass: 'high' } },
  { id: 'PT_LP',  type: 'PT',  label: 'PT-LP_#', fullName: 'Pressure Transducer (low press)',  group: 'Sensors',
    preset: { pressureClass: 'low' } },
  { id: 'PG',     type: 'PG',  label: 'PG_#',    fullName: 'Pressure Gauge',                  group: 'Sensors' },
  { id: 'LC',     type: 'LC',  label: 'LC_#',    fullName: 'Load Cell',                       group: 'Sensors' },

  { id: 'MAN',    type: 'MAN', label: 'MAN_#',   fullName: 'Ball Valve (Manual)',             group: 'Valves' },
  { id: 'ROT',    type: 'ROT', label: 'ROT_#',   fullName: 'Ball Valve (Rotary)',             group: 'Valves' },
  { id: 'SOL',    type: 'SOL', label: 'SOL_#',   fullName: 'Solenoid Valve',                  group: 'Valves' },

  { id: 'PR',     type: 'PR',  label: 'PR_#',    fullName: 'Pressure Regulator',              group: 'Flow Control' },
  { id: 'RV',     type: 'RV',  label: 'RV_#',    fullName: 'Relief Valve',                    group: 'Flow Control' },
  { id: 'CV',     type: 'CV',  label: 'CV_#',    fullName: 'Check Valve',                     group: 'Flow Control' },
  { id: 'QD_G',   type: 'QD',  label: 'QD-G_#',  fullName: 'Quick Disconnect — ground half',   group: 'Flow Control',
    preset: { side: 'ground', service: 'fluid' } },
  { id: 'QD_R',   type: 'QD',  label: 'QD-R_#',  fullName: 'Quick Disconnect — rocket half',   group: 'Flow Control',
    preset: { side: 'rocket', service: 'fluid' } },
  { id: 'QDH_G',  type: 'QD',  label: 'HQD-G_#', fullName: 'Hydraulic QD — ground half',       group: 'Flow Control',
    preset: { side: 'ground', service: 'hydraulic' } },
  { id: 'QDH_R',  type: 'QD',  label: 'HQD-R_#', fullName: 'Hydraulic QD — rocket half',       group: 'Flow Control',
    preset: { side: 'rocket', service: 'hydraulic' } },

  { id: 'TANK',     type: 'TANK',     label: 'TANK',  fullName: 'Tank / COPV',                group: 'Hardware' },
  { id: 'MANIFOLD', type: 'MANIFOLD', label: 'MAN-F', fullName: 'Manifold (splits one feed)', group: 'Hardware' },
  { id: 'ENGINE',   type: 'ENGINE',   label: 'ENG',   fullName: 'Injector + chamber',         group: 'Hardware' },
  { id: 'INJECTOR', type: 'INJECTOR', label: 'INJ',   fullName: 'Injector (alone)',           group: 'Hardware' },

  { id: 'REGION', type: 'REGION', label: 'Section', fullName: 'Section box — group a skid or a panel', group: 'Annotation' },
  { id: 'TEXT',   type: 'TEXT',   label: 'Text',    fullName: 'Text Annotation',                       group: 'Annotation' },
];

/** The palette entry a node was dropped from, for defaulting its label. */
export function defFor(id: string): ComponentDef | undefined {
  return COMPONENT_DEFS.find(d => d.id === id);
}
