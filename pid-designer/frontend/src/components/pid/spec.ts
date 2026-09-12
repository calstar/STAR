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
import { INSULATIONS, TANK_MATERIALS, TEMPERATURES, DEFAULT_MATERIAL } from './materials';
import type { Preset } from './materials';

export interface ParamSpec {
  key: string;
  label: string;
  dimension: Dimension;
  /** Starting value, in `unit`. */
  suggested?: { value: number; unit: string };
  /**
   * Real, and not what somebody opened this dialog for.
   *
   * A hardline carries nine numbers, of which two -- how long and how wide --
   * are why anyone is here; the rest feed a wall-thermal model that is off
   * unless a drawing asks for it. Shown flat, the nine read as nine equally
   * expected answers and the two that matter are somewhere in the middle.
   * These fold away instead.
   */
  advanced?: boolean;
  /**
   * Real, read by the solver, and never asked for -- because the drawing
   * already says it somewhere better.
   *
   * `fitting_count` is the case this exists for. The line-wall model needs to
   * know how many fittings' worth of metal is on a run, and the fitting list
   * two panels down knows exactly. Asking for the number as well is the
   * two-ways-to-say-one-thing problem in its purest form: the one somebody
   * forgot to update is the one the solver would have believed. So it is
   * computed on save and never rendered.
   */
  derived?: boolean;
  /**
   * A dropdown of known values, with *custom* at the bottom. A tank's
   * temperature is one of four things nearly always; the number box is for
   * the fifth. Picking a preset writes a `default` with the preset's reference.
   */
  presets?: Preset[];
  /** Shown only while an option has (or lacks) a value. */
  when?: { option: string; is?: string; not?: string };
  /**
   * The regulator's supply effect, as a datasheet prints it: "17 psi rise per
   * 1000 psi of inlet". Two boxes, one number, unit `psi/1000psi`.
   */
  ratio?: boolean;
  /** Filled from another field while untouched: a dewar's temperature from its pressure. */
  auto?: 'saturation';
  /** Dialog heading this field sits under. Absent means the top. */
  section?: string;
  /** The unit a blank field starts in, when the dimension's first is wrong for it. */
  unit?: string;
}

export interface OptionSpec {
  key: string;
  label: string;
  /** Empty renders a text box; `PEER_CHOICES` renders the component picker. */
  choices: { value: string; label: string }[];
  default: string;
  placeholder?: string;
  section?: string;
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

/** The same, folded away until asked for. See `ParamSpec.advanced`. */
const A = (key: string, label: string, dimension: Dimension,
           suggested?: { value: number; unit: string }): ParamSpec =>
  ({ key, label, dimension, suggested, advanced: true });

/** Declared and fed, never asked for. See `ParamSpec.derived`. */
const D = (key: string, label: string, dimension: Dimension): ParamSpec =>
  ({ key, label, dimension, derived: true });

const ALL_FLUIDS: SpeciesId[] = ['oxygen', 'ethanol', 'nitrogen', 'helium', 'methane', 'other'];

/**
 * Cd or Cv, and which one the team has.
 *
 * A manual valve, a check valve or a disconnect comes with a discharge
 * coefficient more often than a flow coefficient; a regulator comes with a
 * Cv. Whichever is chosen, the other is not asked for. When it is Cd, the
 * drawing also writes the Cv it amounts to (see `derive.ts`), because
 * feed-twin's valves speak Cv until its Cd model lands.
 */
const COEFFICIENT = (def: 'Cd' | 'Cv'): OptionSpec => ({
  key: 'flowCoefficient', label: 'Given as', default: def,
  choices: [{ value: 'Cd', label: 'Cd (discharge coefficient)' }, { value: 'Cv', label: 'Cv (flow coefficient)' }],
});
const CD: ParamSpec = { key: 'Cd', label: 'Cd', dimension: 'dimensionless', when: { option: 'flowCoefficient', is: 'Cd' } };
const CV: ParamSpec = { key: 'Cv', label: 'Cv', dimension: 'flow_coefficient', when: { option: 'flowCoefficient', is: 'Cv' } };

function actuatedValveSpec(): ComponentSpec {
  return {
    catalogued: true,
    params: [CD, CV, P('bore', 'Bore', 'length'), P('travel_time', 'Travel time', 'time', { value: 0.05, unit: 's' })],
    options: [
      COEFFICIENT('Cd'),
      { key: 'failState', label: 'Unpowered position', default: 'closed',
        choices: [
          { value: 'closed', label: 'Normally closed' },
          { value: 'open',   label: 'Normally open' },
        ] },
    ],
  };
}

/** Two ends and a coefficient: what a check valve or a disconnect has. */
function passiveSpec(): ComponentSpec {
  return { catalogued: true, params: [CD, CV, P('bore', 'Bore', 'length')], options: [COEFFICIENT('Cd')] };
}

const materialChoices = TANK_MATERIALS.map(m => ({ value: m.id, label: m.label }));
const insulationChoices = [
  { value: 'none', label: 'None (bare)' },
  ...INSULATIONS.map(i => ({ value: i.id, label: i.label })),
  { value: 'custom', label: 'Custom…' },
];

export const COMPONENT_SPECS: Partial<Record<ComponentType, ComponentSpec>> = {
  TANK: {
    fluids: ALL_FLUIDS,
    params: [
      // Nominal, and drawn on the symbol. feed-twin's initial state comes
      // from the scenario, not from here (see the overhaul plan, Phase 2).
      P('pressure', 'Operating pressure', 'pressure'),
      { key: 'temperature', label: 'Temperature', dimension: 'temperature', presets: TEMPERATURES },
      P('volume', 'Volume', 'volume'),
      // What the tank will take, which is what a team that built it knows.
      // The checks read it: a relief must lift below it, and a tank run past
      // half of it is a factor of safety under two.
      P('burst_pressure', 'Burst pressure', 'pressure'),
      // The wall: what it is made of writes its specific heat; the dry mass
      // is the number on the scale with the tank empty.
      { key: 'wall_mass', label: 'Dry mass', dimension: 'mass', section: 'Material', unit: 'kg' },
      D('wall_capacity', 'Wall specific heat', 'specific_heat'),
      // Estimated by feed-twin from the ullage gas and the vessel; a custom
      // value here wins over the estimate.
      { key: 'wall_conductance', label: 'Gas-to-wall hA (custom)', dimension: 'thermal_conductance', advanced: true, section: 'Material' },
      // What stands between the tank and the room. A bare LOX tank boils
      // several times faster than one under an inch of fiberglass.
      { key: 'insulation_thickness', label: 'Thickness', dimension: 'length', section: 'Insulation',
        when: { option: 'insulation', not: 'none' } },
      { key: 'insulation_conductivity', label: 'Conductivity', dimension: 'conductivity', section: 'Insulation',
        when: { option: 'insulation', is: 'custom' } },
    ],
    options: [
      { key: 'material', label: 'Material', default: DEFAULT_MATERIAL, choices: materialChoices, section: 'Material' },
      { key: 'insulation', label: 'Insulation', default: 'none', choices: insulationChoices, section: 'Insulation' },
      { key: 'portsTop', label: 'Top ports', default: '1', section: 'Ports',
        choices: ['1', '2', '3', '4'].map(n => ({ value: n, label: n })) },
      { key: 'portsBottom', label: 'Bottom ports', default: '1', section: 'Ports',
        choices: ['1', '2', '3', '4'].map(n => ({ value: n, label: n })) },
    ],
    portGroups: [
      { countOption: 'portsTop', prefix: 't', label: 'Top ports' },
      { countOption: 'portsBottom', prefix: 'b', label: 'Bottom ports' },
    ],
  },

  // A bottle is a boundary: what is in it, how full, how big. Nothing else
  // about it is the drawing's to say.
  KBOTTLE: {
    fluids: ['nitrogen', 'helium', 'oxygen'],
    params: [
      P('pressure', 'Supply pressure', 'pressure', { value: 2000, unit: 'psi' }),
      P('volume', 'Water volume', 'volume', { value: 49, unit: 'L' }),
    ],
  },

  // A dewar delivers at a pressure, and its liquid sits on the saturation
  // curve at that pressure -- so the temperature is filled in, not asked.
  DEWAR: {
    fluids: ['nitrogen', 'oxygen'],
    params: [
      P('pressure', 'Delivery pressure', 'pressure', { value: 35, unit: 'psi' }),
      { key: 'temperature', label: 'Temperature', dimension: 'temperature', auto: 'saturation' },
    ],
  },

  PR: {
    catalogued: true,
    params: [
      // One number, two names. The setpoint *is* the dome pressure on a
      // dome-loaded regulator, so the field is relabelled rather than doubled,
      // and saved under the key feed-twin reads for that case.
      { key: 'setpoint', label: 'Setpoint', dimension: 'pressure', when: { option: 'domeLoaded', is: 'no' } },
      { key: 'dome_pressure', label: 'Dome pressure', dimension: 'pressure', when: { option: 'domeLoaded', is: 'yes' } },
      { key: 'dome_bias', label: 'Dome bias (outlet above dome)', dimension: 'pressure', when: { option: 'domeLoaded', is: 'yes' } },
      CV, CD,
      P('bore', 'Orifice', 'length'),
      // Supply-pressure effect the way the datasheet prints it, in one row.
      { key: 'supply_coefficient', label: 'Supply effect', dimension: 'pressure_ratio', ratio: true },
      P('inlet_reference', '  measured at inlet', 'pressure'),
    ],
    options: [
      COEFFICIENT('Cv'),
      { key: 'domeLoaded', label: 'Dome loaded', default: 'no',
        choices: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }] },
    ],
  },

  RV: {
    catalogued: true,
    params: [
      P('set_pressure', 'Set pressure', 'pressure'),
      P('reseat_pressure', 'Reseat pressure', 'pressure'),
      CD, CV,
      P('bore', 'Orifice', 'length'),
    ],
    options: [COEFFICIENT('Cd')],
  },

  CV: passiveSpec(),

  QD: {
    ...passiveSpec(),
    options: [
      COEFFICIENT('Cd'),
      { key: 'pairedWith', label: 'Mates with', default: '', choices: PEER_CHOICES },
    ],
  },

  MAN: { catalogued: true, params: [CD, CV, P('bore', 'Bore', 'length')], options: [COEFFICIENT('Cd')] },
  ROT: actuatedValveSpec(),
  SOL: actuatedValveSpec(),

  // Drawn, not solved: feed-twin's engine is the Layer-1 config named here.
  // The two numbers are what the sheet shows in the chamber.
  ENGINE: {
    options: [
      { key: 'engineConfig', label: 'Layer-1 config', default: '',
        choices: [], placeholder: 'EngineDesign YAML path or id' },
    ],
    params: [
      P('chamber_pressure', 'Chamber pressure', 'pressure'),
      { key: 'chamber_temperature', label: 'Chamber temperature', dimension: 'temperature' },
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
  // solved: a probe reads whatever it is clipped to. Gauges and transducers
  // are plumbed on a tee or a port, and carry their range -- preset from the
  // palette (1000 psi low, 5000 psi high) so it is right on landing.
  RTD: instrumentSpec(),
  TC: instrumentSpec(),
  LC: instrumentSpec(),

  PT: { catalogued: true, params: [P('range_max', 'Range', 'pressure')] },
  PG: { catalogued: true, params: [P('range_max', 'Range', 'pressure')] },

  /**
   * A junction is a tee.
   *
   * It stops being an anonymous dot the moment something flows out of its third
   * leg, because then it is a node in the network with a mass balance and a
   * loss on each path -- and those depend on its bore and which leg is the
   * branch. What it deliberately does *not* carry is a K: a tee's K is a
   * function of how the flow splits, and that is solved, not drawn.
   */
  JUNCTION: {
    params: [
      P('bore', 'Bore', 'length'),
      P('branch_bore', 'Branch bore', 'length'),
    ],
    options: [
      { key: 'teeKind', label: 'Tee', default: 'equal',
        choices: [
          { value: 'equal', label: 'Equal tee' },
          { value: 'reducing', label: 'Reducing tee' },
          { value: 'cross', label: 'Cross' },
          { value: 'weldolet', label: 'Weldolet / branch fitting' },
        ] },
      { key: 'branchPort', label: 'Branch leg', default: 'auto',
        choices: [
          { value: 'auto', label: 'Work it out from the drawing' },
          { value: 't', label: 'Top' },
          { value: 'r', label: 'Right' },
          { value: 'b', label: 'Bottom' },
          { value: 'l', label: 'Left' },
        ] },
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
      P('K_minor', 'Lumped fitting K', 'dimensionless', { value: 0, unit: '-' }),
      A('roughness', 'Roughness', 'length', { value: 1.5e-3, unit: 'mm' }),
      // Static head. Ten metres of LOX is about 1.6 bar, so a tall stand that
      // leaves this unset is wrong by more than most of its line losses.
      A('elevation_change', 'Rise (outlet − inlet)', 'length', { value: 0, unit: 'm' }),
      // Thermal mass. Both feed the line-wall model in feed-twin, which is off
      // unless a drawing declares metal for it -- see docs/thermal/line-walls.md.
      A('wall_thickness', 'Tube wall', 'length', { value: 0.889, unit: 'mm' }),
      // Counted off the fitting list rather than typed -- see `ParamSpec.derived`.
      // The solver needs it for the line-wall model; the drawing already knows.
      D('fitting_count', 'Fittings on this run', 'dimensionless'),
      A('fitting_mass', 'Fitting mass (weighed)', 'mass'),
    ],
  },
  flex_hose: {
    catalogued: true,
    params: [
      P('length', 'Length', 'length'),
      P('bore', 'Bore', 'length'),
      P('installed_bend_radius', 'Installed bend radius', 'length'),
      P('min_bend_radius', 'Min bend radius', 'length'),
      A('end_fitting_K', 'End fittings K', 'dimensionless', { value: 0.5, unit: '-' }),
      A('min_bend_radius_dynamic', 'Min bend radius (flexing)', 'length'),
      A('convolution_factor', 'Convolution friction factor', 'dimensionless', { value: 2, unit: '-' }),
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
