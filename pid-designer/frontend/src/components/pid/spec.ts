/**
 * What each kind of hardware *has*: its parameters, and its categorical choices.
 *
 * Data, not code -- the same decision `feedtwin/model/components.toml` makes,
 * for the same reason. Giving a component a config is a row in this table, and
 * `ConfigDialog` renders whatever it finds. Nothing below knows how to draw
 * anything, and nothing that draws knows what a regulator has.
 *
 * Names match `components.toml` wherever the same quantity exists on both
 * sides (`setpoint`, `Cv`, `bore`, `cracking_pressure`, `volume`), so the
 * Phase-11 reader is a lookup rather than a translation table. Where this file
 * carries something the physics core does not model yet -- a relief valve's
 * reseat pressure, a QD's side of the umbilical -- it is named for what it is
 * and stays here until there is somewhere for it to go.
 *
 * `description` is not decoration. It is where the trap goes: which diameter
 * `bore` means, which way `supply_coefficient` points. Those cost hours when
 * they are wrong and are invisible in a bare label.
 */

import type { Dimension } from './params';
import type { ComponentType } from './types';

export interface ParamSpec {
  key: string;
  label: string;
  dimension: Dimension;
  description?: string;
  /** Suggested starting value, in `unit`. Stored as source 'default'. */
  suggested?: { value: number; unit: string };
}

/**
 * Sentinel for an option whose choices are *other components on this drawing*.
 *
 * The spec cannot list them -- it does not know what anybody has drawn -- so
 * the dialog fills them in at render time and matches on this identity.
 */
export const PEER_CHOICES: { value: string; label: string }[] = [];

export interface OptionSpec {
  key: string;
  label: string;
  choices: { value: string; label: string }[];
  default: string;
  description?: string;
}

export interface ComponentSpec {
  /** Shown at the top of the dialog. */
  summary?: string;
  params: ParamSpec[];
  options?: OptionSpec[];
}

const P = (key: string, label: string, dimension: Dimension,
           description?: string, suggested?: { value: number; unit: string }): ParamSpec =>
  ({ key, label, dimension, description, suggested });

export const COMPONENT_SPECS: Partial<Record<ComponentType, ComponentSpec>> = {
  TANK: {
    summary: 'Run tank or COPV. Pressure and temperature here are the boundary condition a feed solve starts from.',
    params: [
      P('pressure', 'Operating pressure', 'pressure',
        'Ullage pressure held during the burn. Absolute.'),
      P('temperature', 'Propellant temperature', 'temperature',
        'Bulk liquid temperature. Cryogens sit at their saturation temperature unless subcooled — 90 K for LOX at 1 atm.'),
      P('volume', 'Internal volume', 'volume'),
      P('MAWP', 'Max allowable working pressure', 'pressure',
        'What the vessel is rated to. The relief valve is sized against this, not against the operating pressure.'),
    ],
    options: [
      { key: 'portsTop', label: 'Ports on the top end', default: '1',
        choices: ['1','2','3','4'].map(n => ({ value: n, label: n })),
        description: 'Pressurant in, vent, burst disc, instrumentation — a real tank lid has several, and one port forces them all onto one line.' },
      { key: 'portsBottom', label: 'Ports on the bottom end', default: '1',
        choices: ['1','2','3','4'].map(n => ({ value: n, label: n })) },
    ],
  },

  PR: {
    summary: 'Pressure regulator. Not a restriction — the drop across it is whatever the inlet gives it minus the setpoint it holds.',
    params: [
      P('setpoint', 'Outlet setpoint', 'pressure',
        'Outlet pressure held at the reference inlet and zero flow. Absolute.'),
      P('Cv', 'Seat Cv (wide open)', 'flow_coefficient',
        'Sets capacity — where the regulator runs out of authority — not the gradual droop before that.'),
      P('supply_coefficient', 'Supply-pressure effect', 'dimensionless',
        'Outlet rise per unit of inlet decay. A dome reg quoted "14.7 psi per 1000 psi" is 0.0147. Positive means the outlet climbs as the bottle empties — the usual sign, and the one people guess wrong.'),
      P('inlet_reference', 'Reference inlet pressure', 'pressure',
        'Inlet pressure at which the setpoint was measured. Without it the supply term has no datum and is meaningless.'),
      P('flow_droop', 'Droop at rated flow', 'pressure',
        'Outlet sag at rated flow, relative to the zero-flow setpoint. Separate from the supply effect and not derivable from Cv.'),
      P('lockup_rise', 'Lockup rise', 'pressure',
        'How far above setpoint the outlet creeps once flow stops. This is what the downstream relief and burst disc actually see between firings.'),
      P('min_inlet_differential', 'Dropout differential', 'pressure',
        'Least inlet-to-outlet difference at which it still regulates. Below this it is a hole.'),
    ],
    options: [
      { key: 'domeLoaded', label: 'Dome loaded', default: 'no',
        choices: [{ value: 'no', label: 'No — spring loaded' }, { value: 'yes', label: 'Yes — has a dome/pilot port' }],
        description: 'A dome-loaded regulator carries a third connection. Turning this on adds the control port to the symbol.' },
    ],
  },

  RV: {
    summary: 'Relief valve. Sized against the vessel MAWP, not the operating pressure.',
    params: [
      P('set_pressure', 'Set (cracking) pressure', 'pressure',
        'Where it starts to lift. Absolute.'),
      P('reseat_pressure', 'Reseat pressure', 'pressure',
        'Where it closes again. Always below the set pressure; the gap is the blowdown.'),
      P('Cv', 'Cv when open', 'flow_coefficient'),
      P('bore', 'Orifice diameter', 'length', 'The actual flow diameter, not a nominal port size.'),
    ],
  },

  CV: {
    summary: 'Check valve. Passes flow one way through a flow coefficient once cracked, and leaks a little backwards.',
    params: [
      P('cracking_pressure', 'Cracking pressure', 'pressure',
        'Differential needed to lift the poppet.', { value: 3.0, unit: 'psi' }),
      P('Cv', 'Cv when open', 'flow_coefficient'),
      P('bore', 'Internal bore', 'length'),
    ],
  },

  QD: {
    summary: 'Quick disconnect. A flight half and a ground half that mate; the checks panel watches that every rocket-side half has one.',
    params: [
      P('Cv', 'Cv when mated', 'flow_coefficient'),
      P('bore', 'Internal bore', 'length'),
    ],
    options: [
      { key: 'side', label: 'Side of the umbilical', default: 'ground',
        choices: [
          { value: 'ground', label: 'Ground / GSE half' },
          { value: 'rocket', label: 'Rocket / flight half' },
        ],
        description: 'Which half this symbol is. A rocket half leaves with the vehicle; a ground half stays behind.' },
      { key: 'service', label: 'Service', default: 'fluid',
        choices: [
          { value: 'fluid',     label: 'Fluid — propellant or pressurant' },
          { value: 'hydraulic', label: 'Hydraulic' },
        ],
        description: 'Drawn differently so the two are told apart at a glance. Both behave the same in a solve.' },
      { key: 'pairedWith', label: 'Mates with', default: '',
        choices: PEER_CHOICES,
        description: 'The disconnect on the other side of the umbilical. Pick "no pair needed" for a half that genuinely stands alone — a capped test port, or a fill point with nothing flying away from it — and the checks panel will stop asking.' },
    ],
  },

  MAN: valveSpec('Manual ball valve — handle operated.'),
  ROT: valveSpec('Rotary (pneumatic) ball valve.'),
  SOL: valveSpec('Solenoid valve.'),

  PT: {
    summary: 'Pressure transducer.',
    params: [
      P('range_max', 'Full-scale range', 'pressure',
        'Top of the calibrated range. A transducer reading near its ceiling is the usual reason a trace clips.'),
      P('accuracy', 'Accuracy, % of full scale', 'dimensionless'),
    ],
  },

  PG: {
    summary: 'Pressure gauge.',
    params: [P('range_max', 'Full-scale range', 'pressure')],
  },

  RTD: sensorSpec('Resistance temperature detector.'),
  TC:  sensorSpec('Thermocouple.'),

  LC: {
    summary: 'Load cell.',
    params: [P('capacity', 'Rated capacity', 'dimensionless', 'Full-scale load.')],
  },

  ENGINE: {
    summary: 'Injector and chamber as one item — which is how it is built, tested and replaced. The chamber pressure here is the downstream boundary a feed solve runs against.',
    params: [
      P('chamber_pressure', 'Chamber pressure', 'pressure',
        'Pc at the design point. Absolute. This is the back pressure the whole feed system works against.'),
      P('chamber_temperature', 'Chamber temperature', 'temperature',
        'Combustion temperature at the design point.'),
      P('injector_dp', 'Injector pressure drop', 'pressure',
        'Drop across the injector face at design flow. The stiffness that decouples the chamber from the feed system; usually quoted as a fraction of Pc, and below roughly 15% chug becomes a real risk.'),
      P('mixture_ratio', 'Mixture ratio (O/F)', 'dimensionless'),
      P('throat_diameter', 'Throat diameter', 'length'),
      P('expansion_ratio', 'Expansion ratio', 'dimensionless', 'Exit area over throat area.'),
      P('mdot_total', 'Total mass flow', 'mass_flow'),
    ],
  },

  INJECTOR: {
    summary: 'Injector on its own, where the chamber is drawn separately or is out of scope.',
    params: [
      P('injector_dp', 'Injector pressure drop', 'pressure', 'Drop across the face at design flow.'),
      P('Cd', 'Discharge coefficient', 'dimensionless', undefined, { value: 0.61, unit: '-' }),
      P('orifice_diameter', 'Orifice diameter', 'length'),
      P('orifice_count', 'Number of orifices', 'dimensionless'),
    ],
  },

  MANIFOLD: {
    summary: 'A block with a bore through it and ports tapped into the side: one symbol here, a plenum node plus one branch per port in a solve.',
    params: [
      P('bore', 'Plenum bore', 'length',
        'Flow diameter of the passage itself. A port bored larger than the plenum feeding it is a real mistake and this is what catches it.'),
      P('volume', 'Internal volume', 'volume',
        'Nothing in a steady solve and everything in a transient one — the plenum has to fill before anything downstream sees pressure.'),
    ],
    options: [
      { key: 'outlets', label: 'Outlet ports', default: '4',
        choices: ['1','2','3','4','5','6','7','8'].map(n => ({ value: n, label: n })),
        description: 'How many ports are tapped into the side. The block grows to fit them.' },
      { key: 'orientation', label: 'Run direction', default: 'horizontal',
        choices: [
          { value: 'horizontal', label: 'Horizontal — feed enters at the left' },
          { value: 'vertical',   label: 'Vertical — feed enters at the top' },
        ] },
    ],
  },
};

function valveSpec(summary: string): ComponentSpec {
  return {
    summary,
    params: [
      P('Cv', 'Cv at full open', 'flow_coefficient'),
      P('bore', 'Internal bore', 'length',
        'The actual bore of the valve body, not the thread size. A 3/8 in. NPT fitting does not have a 3/8 in. bore, and using the thread size under-predicts loss by several times.'),
      P('travel_time', 'Travel time, shut to open', 'time',
        'Measure it — actuation time drives the startup transient.', { value: 0.05, unit: 's' }),
    ],
    options: [
      { key: 'failState', label: 'Position when unpowered', default: 'closed',
        choices: [
          { value: 'closed', label: 'Normally closed (NC)' },
          { value: 'open',   label: 'Normally open (NO)' },
        ],
        description: 'Where the valve sits with no command applied. Drawn on the symbol, because it is the difference between a safe abort and a spill.' },
    ],
  };
}

function sensorSpec(summary: string): ComponentSpec {
  return {
    summary,
    params: [
      P('range_min', 'Range minimum', 'temperature'),
      P('range_max', 'Range maximum', 'temperature'),
    ],
  };
}

/**
 * What a line is.
 *
 * The gap this closes is the one that mattered most: an edge carried a colour
 * and nothing else, so a reader could import the topology and still not
 * compute a single pressure. Most of the drop in a feed system is in the pipe
 * -- length, bore, roughness, and whatever fittings are lumped into the run --
 * and none of it was anywhere.
 *
 * Four kinds, matching `components.toml` rather than inventing a vocabulary:
 * hardline, flex hose, a discrete bend, and a single fitting. A hose is not a
 * rougher pipe; its ends are crimped fittings with their own loss and it has a
 * bend radius that is usually what actually constrains a routing.
 */
export const LINE_SPECS: Record<string, ComponentSpec> = {
  pipe: {
    summary: 'Hardline — a straight run of tube.',
    params: [
      P('length', 'Developed length', 'length', 'Along the centreline, end to end.'),
      P('bore', 'Internal diameter', 'length',
        'The actual bore, not the nominal tube size: 3/8 x 0.035 tube bores 0.305 in, and using 0.375 under-predicts the loss.'),
      P('roughness', 'Wall roughness', 'length',
        'Absolute. Clean drawn stainless is about 1.5 microns; increase it for used or welded line.',
        { value: 1.5e-3, unit: 'mm' }),
      P('K_minor', 'Lumped fitting K', 'dimensionless',
        'A shortcut for fittings in this run that are not drawn. It costs the per-fitting provenance a drawn fitting would keep, so prefer drawing them where you know them.',
        { value: 0, unit: '-' }),
    ],
  },

  flex_hose: {
    summary: 'Flex hose. Rougher than hardline, with crimped ends that dominate the loss on a short run.',
    params: [
      P('length', 'Developed length', 'length', 'End fitting to end fitting.'),
      P('bore', 'Liner internal diameter', 'length'),
      P('installed_bend_radius', 'Installed bend radius', 'length',
        'The radius it is actually routed to. Leave blank for a straight run; when set, friction is computed for curved flow, which is materially higher.'),
      P('min_bend_radius', 'Minimum bend radius (static)', 'length',
        'Manufacturer figure. Bending tighter collapses a smooth-bore liner or fatigues a convoluted one — usually the real constraint on a routing.'),
      P('end_fitting_K', 'Both end fittings, K', 'dimensionless', undefined, { value: 0.5, unit: '-' }),
    ],
    options: [
      { key: 'construction', label: 'Construction', default: 'smooth_bore',
        choices: [
          { value: 'smooth_bore', label: 'Smooth bore (PTFE / elastomer liner)' },
          { value: 'convoluted',  label: 'Convoluted metal' },
        ],
        description: 'Convoluted hose is far rougher — the convolutions are in the flow path, not just the braid — and loses several times what a smooth bore of the same size does.' },
    ],
  },

  bend: {
    summary: 'A discrete bend in hardline — an elbow, or tube bent on a former.',
    params: [
      P('bore', 'Internal diameter', 'length'),
      P('bend_radius', 'Centreline radius', 'length',
        'The number that matters: at r/D = 1 a bend carries about three times the friction of a straight run, and at r/D = 3 still nearly twice.'),
      P('angle', 'Turn angle', 'angle', undefined, { value: 90, unit: 'deg' }),
    ],
  },

  fitting: {
    summary: 'One fitting, with its own K and its own provenance.',
    params: [
      P('bore', 'Bore of the run it sits in', 'length', 'The resistance coefficient is referred to this diameter.'),
    ],
    options: [
      { key: 'kind', label: 'Which fitting', default: 'elbow_90',
        choices: [
          'elbow_90', 'elbow_45', 'bend', 'contraction', 'expansion',
          'entrance_sharp', 'exit', 'tee_run', 'tee_branch',
          'ball_valve_full', 'gate_valve_full', 'globe_valve', 'swing_check',
        ].map(k => ({ value: k, label: k.replace(/_/g, ' ') })),
        description: 'Each maps to a correlation, most of them from Crane TP-410.' },
    ],
  },
};

export const LINE_TYPE_LABELS: Record<string, string> = {
  pipe: 'Hardline',
  flex_hose: 'Flex hose',
  bend: 'Bend',
  fitting: 'Fitting',
};
