/**
 * What each kind of hardware has: its parameters, its options, its ports.
 *
 * Data, not code -- adding a setting is a row here and `ConfigDialog` renders
 * it. Names match `feedtwin/model/components.toml` where the same quantity
 * exists on both sides, so the reader is a lookup rather than a translation.
 *
 * **Labels only.** An earlier version carried a sentence of explanation on
 * every field. It made the dialogs unreadable, and it was explaining the trade
 * to people who do this for a living. If a label needs a paragraph, the label
 * is wrong.
 */

import type { Dimension } from './params';
import type { ComponentType } from './types';
import type { SpeciesId } from './fluids';

export interface ParamSpec {
  key: string;
  label: string;
  dimension: Dimension;
  /** Starting value, in `unit`. */
  suggested?: { value: number; unit: string };
}

export interface OptionSpec {
  key: string;
  label: string;
  choices: { value: string; label: string }[];
  default: string;
}

/** Ports whose number is an option, and which can then be named. */
export interface PortGroupSpec {
  countOption: string;
  prefix: string;
  label: string;
  fixed?: { id: string; label: string }[];
}

export interface ComponentSpec {
  params: ParamSpec[];
  options?: OptionSpec[];
  portGroups?: PortGroupSpec[];
  /**
   * Species this component may hold. Present only on sources -- a tank, a
   * bottle, a dewar. Everything else inherits, so asking an RTD what fluid it
   * is was a question with no meaning.
   */
  fluids?: SpeciesId[];
  /** Whether a catalogue part number is worth offering. */
  catalogued?: boolean;
}

/** Choices from other components on the drawing; filled in at render time. */
export const PEER_CHOICES: { value: string; label: string }[] = [];

const P = (key: string, label: string, dimension: Dimension,
           suggested?: { value: number; unit: string }): ParamSpec =>
  ({ key, label, dimension, suggested });

const ALL_FLUIDS: SpeciesId[] = ['oxygen', 'ethanol', 'nitrogen', 'helium', 'methane', 'other'];

function valveSpec(): ComponentSpec {
  return {
    catalogued: true,
    params: [
      P('Cv', 'Cv', 'flow_coefficient'),
      P('bore', 'Bore', 'length'),
      P('travel_time', 'Travel time', 'time', { value: 0.05, unit: 's' }),
    ],
    options: [
      { key: 'failState', label: 'Unpowered position', default: 'closed',
        choices: [
          { value: 'closed', label: 'Normally closed' },
          { value: 'open',   label: 'Normally open' },
        ] },
    ],
  };
}

export const COMPONENT_SPECS: Partial<Record<ComponentType, ComponentSpec>> = {
  TANK: {
    fluids: ALL_FLUIDS,
    params: [
      P('pressure', 'Operating pressure', 'pressure'),
      P('temperature', 'Temperature', 'temperature'),
      P('volume', 'Volume', 'volume'),
      P('MAWP', 'MAWP', 'pressure'),
    ],
    options: [
      { key: 'portsTop', label: 'Top ports', default: '1',
        choices: ['1', '2', '3', '4'].map(n => ({ value: n, label: n })) },
      { key: 'portsBottom', label: 'Bottom ports', default: '1',
        choices: ['1', '2', '3', '4'].map(n => ({ value: n, label: n })) },
    ],
    portGroups: [
      { countOption: 'portsTop', prefix: 't', label: 'Top ports' },
      { countOption: 'portsBottom', prefix: 'b', label: 'Bottom ports' },
    ],
  },

  KBOTTLE: {
    // What actually turns up on a bottle rack.
    fluids: ['nitrogen', 'helium', 'oxygen'],
    params: [
      P('pressure', 'Supply pressure', 'pressure', { value: 2000, unit: 'psi' }),
      P('temperature', 'Temperature', 'temperature', { value: 293, unit: 'K' }),
      P('volume', 'Water volume', 'volume', { value: 49, unit: 'L' }),
      P('count', 'Bottles', 'dimensionless', { value: 1, unit: '-' }),
    ],
  },

  DEWAR: {
    fluids: ['nitrogen', 'oxygen'],
    params: [
      P('pressure', 'Delivery pressure', 'pressure', { value: 35, unit: 'psi' }),
      P('temperature', 'Temperature', 'temperature'),
      P('volume', 'Capacity', 'volume'),
    ],
  },

  PR: {
    catalogued: true,
    params: [
      P('setpoint', 'Setpoint', 'pressure'),
      P('Cv', 'Cv', 'flow_coefficient'),
      P('bore', 'Orifice', 'length'),
      // Supply-pressure effect as a datasheet states it: outlet rises this
      // much for that much inlet decay. Two pressures rather than the
      // dimensionless ratio the physics core wants, because nobody reads
      // "0.0147" off a spec sheet -- they read "14.7 psi per 1000 psi".
      P('supply_effect_out', 'Outlet rise', 'pressure'),
      P('supply_effect_in', '  per inlet drop', 'pressure'),
    ],
    options: [
      { key: 'domeLoaded', label: 'Dome loaded', default: 'no',
        choices: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }] },
    ],
  },

  RV: {
    catalogued: true,
    params: [
      P('set_pressure', 'Set pressure', 'pressure'),
      P('reseat_pressure', 'Reseat pressure', 'pressure'),
      P('Cv', 'Cv', 'flow_coefficient'),
      P('bore', 'Orifice', 'length'),
    ],
  },

  CV: {
    catalogued: true,
    params: [
      P('cracking_pressure', 'Cracking pressure', 'pressure', { value: 3, unit: 'psi' }),
      P('Cv', 'Cv', 'flow_coefficient'),
      P('bore', 'Bore', 'length'),
    ],
  },

  QD: {
    catalogued: true,
    params: [
      P('Cv', 'Cv', 'flow_coefficient'),
      P('bore', 'Bore', 'length'),
    ],
    options: [
      { key: 'pairedWith', label: 'Mates with', default: '', choices: PEER_CHOICES },
    ],
  },

  MAN: valveSpec(),
  ROT: valveSpec(),
  SOL: valveSpec(),

  ENGINE: {
    params: [
      P('chamber_pressure', 'Chamber pressure', 'pressure'),
      P('chamber_temperature', 'Chamber temperature', 'temperature'),
      P('injector_dp', 'Injector dP', 'pressure'),
      P('mixture_ratio', 'O/F', 'dimensionless'),
      P('throat_diameter', 'Throat', 'length'),
      P('expansion_ratio', 'Expansion ratio', 'dimensionless'),
      P('mdot_total', 'Total mass flow', 'mass_flow'),
    ],
  },

  INJECTOR: {
    params: [
      P('injector_dp', 'Injector dP', 'pressure'),
      P('Cd', 'Cd', 'dimensionless', { value: 0.61, unit: '-' }),
      P('orifice_diameter', 'Orifice', 'length'),
      P('orifice_count', 'Orifices', 'dimensionless'),
    ],
  },

  MANIFOLD: {
    params: [
      P('bore', 'Bore', 'length'),
      P('volume', 'Volume', 'volume'),
    ],
    options: [
      { key: 'outlets', label: 'Outlets', default: '4',
        choices: ['1', '2', '3', '4', '5', '6', '7', '8'].map(n => ({ value: n, label: n })) },
      { key: 'orientation', label: 'Direction', default: 'horizontal',
        choices: [
          { value: 'horizontal', label: 'Horizontal' },
          { value: 'vertical', label: 'Vertical' },
        ] },
    ],
    portGroups: [
      { countOption: 'outlets', prefix: 'p', label: 'Outlets',
        fixed: [{ id: 'in', label: 'Feed in' }] },
    ],
  },

  // Instruments carry a tag and a size and nothing else. They are drawn, not
  // solved: a probe reads whatever it is clipped to, so a range, a fluid and a
  // part number were three questions nobody wanted to answer sixty times.
  // RTDs and thermocouples clip to what they read. Gauges and transducers do
  // not: they are fittings, plumbed into the feed system on a tee or a port,
  // so they connect like anything else and carry the numbers a fitting has.
  RTD: instrumentSpec(),
  TC: instrumentSpec(),
  LC: instrumentSpec(),

  PT: {
    catalogued: true,
    params: [
      P('range_max', 'Range', 'pressure'),
      P('bore', 'Port bore', 'length'),
    ],
  },

  PG: {
    catalogued: true,
    params: [
      P('range_max', 'Range', 'pressure'),
      P('bore', 'Port bore', 'length'),
    ],
  },
};

function instrumentSpec(): ComponentSpec {
  return {
    params: [],
    options: [
      { key: 'size', label: 'Size', default: 'normal',
        choices: [
          { value: 'small', label: 'Small' },
          { value: 'normal', label: 'Normal' },
        ] },
    ],
  };
}

/** What a line is. Names match `components.toml`. */
export const LINE_SPECS: Record<string, ComponentSpec> = {
  pipe: {
    catalogued: true,
    params: [
      P('length', 'Length', 'length'),
      P('bore', 'Bore', 'length'),
      P('roughness', 'Roughness', 'length', { value: 1.5e-3, unit: 'mm' }),
      P('K_minor', 'Lumped fitting K', 'dimensionless', { value: 0, unit: '-' }),
    ],
  },
  flex_hose: {
    catalogued: true,
    params: [
      P('length', 'Length', 'length'),
      P('bore', 'Bore', 'length'),
      P('installed_bend_radius', 'Installed bend radius', 'length'),
      P('min_bend_radius', 'Min bend radius', 'length'),
      P('end_fitting_K', 'End fittings K', 'dimensionless', { value: 0.5, unit: '-' }),
    ],
    options: [
      { key: 'construction', label: 'Construction', default: 'smooth_bore',
        choices: [
          { value: 'smooth_bore', label: 'Smooth bore' },
          { value: 'convoluted', label: 'Convoluted' },
        ] },
    ],
  },
  bend: {
    params: [
      P('bore', 'Bore', 'length'),
      P('bend_radius', 'Bend radius', 'length'),
      P('angle', 'Angle', 'angle', { value: 90, unit: 'deg' }),
    ],
  },
  fitting: {
    catalogued: true,
    params: [P('bore', 'Bore', 'length')],
    options: [
      { key: 'kind', label: 'Kind', default: 'elbow_90',
        choices: [
          'elbow_90', 'elbow_45', 'bend', 'contraction', 'expansion',
          'entrance_sharp', 'exit', 'tee_run', 'tee_branch',
          'ball_valve_full', 'gate_valve_full', 'globe_valve', 'swing_check',
        ].map(k => ({ value: k, label: k.replace(/_/g, ' ') })) },
    ],
  },
};

export const LINE_TYPE_LABELS: Record<string, string> = {
  pipe: 'Hardline',
  flex_hose: 'Flex hose',
  bend: 'Bend',
  fitting: 'Fitting',
};
