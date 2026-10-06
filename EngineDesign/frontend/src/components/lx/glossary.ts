import { resolutionText } from './units';

/**
 * Every term Layer X puts on a page, explained once. `Term` (lx/ui) reads this for its hover card;
 * no page carries an explanatory paragraph instead.
 *
 *   short       one sentence of intuition, in stand words
 *   equation    plain unicode, read as written ("ṁ = Cd·A·√(2ρΔP)")
 *   source      a real citation, or nothing: an entry with no source is the team's own usage
 *   resolution  what the model resolves, from units.ts's RESOLUTION table so the card and the
 *               page agree
 */
export interface GlossaryEntry {
  term: string;
  short: string;
  equation?: string;
  source?: string;
  resolution?: string;
}

const SUTTON = 'Sutton & Biblarz, Rocket Propulsion Elements, 9th ed. (Wiley, 2017)';
const HUZEL = 'Huzel & Huang, Modern Engineering for Design of Liquid-Propellant Rocket Engines (AIAA, 1992)';
const LEONARDI = 'Leonardi et al., Acta Astronautica 139 (2017): the double-time-lag chug model used here';
const COOLPROP = 'Bell et al., Ind. Eng. Chem. Res. 53(6) (2014): CoolProp, for the fluid properties';
const NURICK = 'Nurick, Orifice Cavitation and Its Effect on Spray Mixing, J. Fluids Eng. 98(4) (1976)';
const HARRJE = 'Harrje & Reardon (eds.), Liquid Propellant Rocket Combustion Instability, NASA SP-194 (1972)';
const OGATA = 'Ogata, Modern Control Engineering, 5th ed. (Prentice Hall, 2010)';

export const GLOSSARY = {
  // ---------------------------------------------------------------- the run's opt-in choices (DATA-CONTRACT 7)
  gn2OverLox: {
    term: 'Nitrogen over LOX',
    short: "Nitrogen condenses into LOX above its saturation pressure at the LOX temperature (about 52 psia at 90 K), which the model does not include.",
    source: COOLPROP,
  },
  // ---------------------------------------------------------------- pressurant and tanks
  tankPressure: {
    term: 'Tank pressure',
    short: 'The ullage pressure that pushes propellant to the engine, held by the regulator through the burn.',
    resolution: resolutionText('pressure'),
  },
  lockup: {
    term: 'Lockup',
    short: 'The pressure the regulator settles to with no flow, which is what the tanks read before Fire.',
    resolution: resolutionText('pressure'),
  },
  domeSetting: {
    term: 'Dome setting',
    short: 'The gas pressure loaded on the regulator\'s dome; the outlet follows it, so it is the knob that sets tank pressure.',
    resolution: resolutionText('pressure'),
  },
  bottleFill: {
    term: 'Bottle (COPV) fill',
    short: 'The pressurant bottle\'s pressure and temperature when filled, which with its volume fix how much gas there is to push the propellant out.',
    equation: 'm = ρ(P, T)·V',
    source: COOLPROP,
    resolution: resolutionText('pressure'),
  },
  regulatorDroop: {
    term: 'Regulator droop',
    short: 'The regulator\'s outlet falls as the flow through it rises, because the valve needs travel to open further.',
    equation: 'P_out = P_lockup − D·ṁ',
    resolution: resolutionText('dp'),
  },
  supplyPressureEffect: {
    term: 'Supply-pressure effect',
    short: 'As the bottle empties the regulator\'s outlet shifts by a fixed fraction of the supply change, rising on most single-stage regulators.',
    equation: 'ΔP_out = −SPE·ΔP_supply',
    resolution: resolutionText('dp'),
  },
  cv: {
    term: 'Cv',
    short: 'A valve\'s flow coefficient: the US gallons per minute of water it passes at a 1 psi drop.',
    equation: 'Q = Cv·√(ΔP / SG)',
    source: 'ANSI/ISA-75.01.01, Flow Equations for Sizing Control Valves',
  },
  pressSolenoid: {
    term: 'Press solenoid',
    short: 'The valve between the regulator and a tank: open, the regulator feeds the ullage; shut, the tank is on its own.',
  },
  pressureLadder: {
    term: 'Pressure ladder',
    short: 'Where the pressure goes between the bottle and the chamber: each element\'s drop in flow order, adding up to the whole difference.',
    equation: 'P_bottle − Pc = Σ ΔP_element',
    source: HUZEL,
    resolution: resolutionText('dp'),
  },
  regulatorCapacity: {
    term: 'Regulator capacity and use',
    short: 'Capacity is the most gas the regulator passes wide open at its inlet pressure; use is the burn\'s demand as a share of it.',
    equation: 'use = ṁ / ṁ_max(P_in),  ṁ_max from the regulator\'s Cv',
    source: 'ANSI/ISA-75.01.01, Flow Equations for Sizing Control Valves',
    resolution: resolutionText('percent'),
  },
  choked: {
    term: 'Choked',
    short: 'Gas through a restriction reaches the speed of sound once the outlet falls below about half the inlet, and the flow stops rising.',
    equation: 'P_out / P_in ≤ 0.487 for helium (γ = 5/3), 0.528 for nitrogen (γ = 1.4)',
    source: 'Anderson, Modern Compressible Flow, 3rd ed. (McGraw-Hill, 2003)',
  },
  jouleThomson: {
    term: 'Joule–Thomson effect',
    short: 'Gas throttled through the regulator changes temperature with no work done: nitrogen cools, helium at room temperature warms a little.',
    equation: 'ΔT ≈ μ_JT·ΔP, at constant enthalpy',
    source: `Joule & Thomson, Phil. Trans. R. Soc. Lond. 143 (1853); ${COOLPROP}`,
    resolution: resolutionText('temp'),
  },
  ullage: {
    term: 'Ullage',
    short: 'The gas space above the liquid in a tank, which grows as the propellant leaves.',
  },
  ullageCollapse: {
    term: 'Ullage collapse',
    short: 'Pressurant cooling on cold propellant and tank walls, so the ullage needs more gas than an ideal expansion predicts.',
    source: HUZEL,
  },
  propellantVapour: {
    term: 'Propellant vapour',
    short: 'Propellant evaporating into the ullage adds its own partial pressure, which is most of what pressurises a shut LOX tank.',
    equation: 'P_ullage = P_gas + P_sat(T_surface)',
    source: COOLPROP,
  },
  tankWallHeat: {
    term: 'Tank wall heat',
    short: 'Heat between the liquid and the tank wall it wets: what cools a tank during a load (chilldown) and boils LOX off a warm wall.',
    equation: 'Q̇ = h·A·(T_wall − T_liquid)',
  },
  lineWallHeat: {
    term: 'Line-wall heat',
    short: 'Heat the tubes and fittings give the pressurant as it flows through them, which warms the gas and lifts tank pressure late in a burn.',
    equation: 'Q̇ = h·A·(T_wall − T_gas)',
  },
  mawp: {
    term: 'MAWP',
    short: 'Maximum allowable working pressure: the most a vessel or component is rated to hold, from its drawing or datasheet.',
    source: 'ASME Boiler and Pressure Vessel Code, Section VIII',
    resolution: resolutionText('pressure'),
  },
  meop: {
    term: 'MEOP',
    short: 'Maximum expected operating pressure: the highest a vessel will see in service, lockup and transients included, which must stay under its MAWP.',
    source: 'ANSI/AIAA S-080 (metallic pressure vessels) and S-081 (composite overwrapped pressure vessels)',
    resolution: resolutionText('pressure'),
  },
  gaugePressure: {
    term: 'psig and psia',
    short: 'Gauge pressure is read above the local atmosphere, as the stand\'s transducers read it; absolute adds the atmosphere back.',
    equation: 'psig = psia − P_ambient',
    resolution: resolutionText('pressure'),
  },

  // ---------------------------------------------------------------- feed
  feedLoss: {
    term: 'Feed loss',
    short: 'Pressure lost between the tank and the injector to the lines, valves, filters and fittings.',
    equation: 'ΔP = K·½·ρ·v²',
    source: 'Idelchik, Handbook of Hydraulic Resistance, 3rd ed. (1994)',
    resolution: resolutionText('dp'),
  },
  saturationMargin: {
    term: 'Saturation margin',
    short: 'How far a liquid\'s pressure sits above its boiling pressure at its own temperature; at zero it starts to flash to vapour.',
    equation: 'P − P_sat(T)',
    source: COOLPROP,
    resolution: resolutionText('dp'),
  },
  cavitationNumber: {
    term: 'Cavitation number K',
    short: 'How far an orifice\'s inlet pressure sits above vapour pressure, against its drop; under its critical value the liquid boils in the vena contracta.',
    equation: 'K = (P_in − P_v) / (P_in − P_out),  cavitates below K_crit = (Cd / Cc)²',
    source: NURICK,
    resolution: resolutionText('ratio'),
  },
  hydraulicFlip: {
    term: 'Hydraulic flip',
    short: 'A cavitating orifice\'s jet comes off the whole bore wall, so its Cd drops at once and the stream narrows and straightens.',
    equation: 'cavitating: Cd = Cc·√K,  flipped: Cd ≈ Cc ≈ 0.6',
    source: NURICK,
    resolution: resolutionText('ratio'),
  },
  waterHammer: {
    term: 'Water hammer',
    short: 'The pressure spike when a valve stops a moving liquid quickly, as its momentum turns into a pressure wave.',
    equation: 'ΔP = ρ·a·Δv',
    source: 'Joukowsky, Über den hydraulischen Stoss in Wasserleitungsröhren (1898)',
    resolution: resolutionText('dp'),
  },
  joukowsky: {
    term: 'Joukowsky surge',
    short: 'The pressure rise when a valve shuts faster than a pressure wave can cross the line and back, stopping the whole liquid column at once.',
    equation: 'ΔP = ρ·a·Δv, for a closure shorter than 2L / a',
    source: 'Wylie & Streeter, Fluid Transients in Systems (Prentice Hall, 1993)',
    resolution: resolutionText('dp'),
  },
  priming: {
    term: 'Priming',
    short: 'Filling the lines and injector manifolds downstream of the mains with liquid, before full flow reaches the chamber.',
    resolution: resolutionText('time'),
  },
  hardStart: {
    term: 'Hard start',
    short: 'A pressure spike at ignition when propellant that collected in the chamber before light-off burns all at once.',
    source: SUTTON,
  },
  fuelLead: {
    term: 'Fuel lead',
    short: 'Opening the fuel main before the LOX main, so fuel reaches the injector first and the start is not LOX-rich.',
    resolution: resolutionText('time'),
  },
  unusablePropellant: {
    term: 'Unusable propellant',
    short: 'Propellant that stays behind in the sump and lines, or that cannot be drawn once gas reaches the outlet.',
    resolution: resolutionText('mass'),
  },
  gasIngestion: {
    term: 'Gas ingestion',
    short: 'Pressurant drawn into the tank outlet as the liquid level reaches it, which ends useful flow before the tank is empty.',
  },
  vortex: {
    term: 'Outlet vortex and dip',
    short: 'As the level nears the outlet the surface dips, or swirls into an air core, and draws gas down before the tank is empty.',
    source: 'Lubin & Springer, The formation of a dip on the surface of a liquid draining from a tank, J. Fluid Mech. 29(2) (1967)',
  },
  residual: {
    term: 'Residual',
    short: 'Propellant still in the other tank when the first one runs dry: carried to burnout and never burned.',
    resolution: resolutionText('mass'),
  },

  // ---------------------------------------------------------------- injector and stability
  stiffness: {
    term: 'ΔP/Pc',
    short: 'Injector pressure drop as a fraction of chamber pressure; a stiff injector keeps chamber swings from feeding back into the flow.',
    equation: 'ṁ = Cd·A·√(2ρΔP),  stiffness = ΔP / Pc',
    source: HUZEL,
    resolution: resolutionText('percent'),
  },
  cd: {
    term: 'Cd',
    short: 'Discharge coefficient: the orifice\'s real flow over the ideal flow at the same pressure drop.',
    equation: 'ṁ = Cd·A·√(2ρΔP)',
    source: SUTTON,
    resolution: resolutionText('ratio'),
  },
  chugMargin: {
    term: 'Chug margin',
    short: 'Gain margin of the feed, chamber and combustion loop: how much its gain could grow before low-frequency oscillation sets in, stable above 1.',
    equation: 'GM = 1 / |L(jω₁₈₀)|',
    source: LEONARDI,
    resolution: resolutionText('ratio'),
  },
  chugFrequency: {
    term: 'Chug frequency',
    short: 'The frequency at which the loop\'s phase lag reaches half a cycle, where chug would ring if it started.',
    equation: '∠L(j·2πf) = −180°',
    source: LEONARDI,
    resolution: resolutionText('frequency'),
  },
  timeLag: {
    term: 'Combustion time lag τ',
    short: 'The time from propellant leaving the injector to it burning: atomisation, vaporisation and mixing in series.',
    equation: 'τ = τ_atom + τ_vap + τ_mix',
    source: `${LEONARDI}; Crocco & Cheng, Theory of Combustion Instability in Liquid Propellant Rocket Motors, AGARDograph 8 (1956)`,
  },
  resultantAngle: {
    term: 'Resultant angle',
    short: 'The direction the combined spray leaves an impinging pair, set by the two jets\' momenta; zero points straight down the chamber.',
    equation: 'tan β = (ṁ_O·v_O·sin α_O − ṁ_F·v_F·sin α_F) / (ṁ_O·v_O·cos α_O + ṁ_F·v_F·cos α_F)',
    source: HUZEL,
  },
  nyquist: {
    term: 'Nyquist plot',
    short: 'The loop\'s response traced as frequency rises; the loop is stable while the trace passes to the right of −1 without circling it.',
    equation: 'L(jω), ω from 0 up; stable if it does not encircle −1',
    source: 'Nyquist, Regeneration Theory, Bell System Technical Journal 11(1) (1932)',
  },
  gainMargin: {
    term: 'Gain margin',
    short: 'How many times the loop\'s gain could grow before it rings on its own, read where its phase lag reaches half a cycle.',
    equation: 'GM = 1 / |L(jω₁₈₀)|',
    source: OGATA,
    resolution: resolutionText('ratio'),
  },
  acousticMode: {
    term: 'Feed-line acoustic mode',
    short: 'A line\'s own organ-pipe frequency, set by its length and the liquid\'s sound speed; near the chug frequency the two can couple.',
    equation: 'f = a / 4L (one end closed),  a / 2L (both open or both closed)',
    source: HARRJE,
    resolution: resolutionText('frequency'),
  },
  momentumRatio: {
    term: 'Momentum ratio',
    short: 'How hard the LOX and fuel jets push against each other where they meet, which sets where the spray fan points and how well they mix.',
    equation: 'R = √(ρ_O·v_O² / (ρ_F·v_F²)),  Rupe: M = R²·d_O / d_F, best mixed at M = 1',
    source: 'Rupe, JPL Progress Report 20-195 (1953); Elverum & Morey, JPL Memo 30-5 (1959)',
    resolution: resolutionText('ratio'),
  },

  // ---------------------------------------------------------------- engine
  pc: {
    term: 'Pc',
    short: 'Chamber pressure, at the nozzle inlet.',
    source: SUTTON,
    resolution: resolutionText('pressure'),
  },
  of: {
    term: 'O/F',
    short: 'Mass of LOX burned for each unit mass of fuel.',
    equation: 'O/F = ṁ_O / ṁ_F',
    resolution: resolutionText('of'),
  },
  cstar: {
    term: 'c*',
    short: 'Characteristic velocity: the chamber pressure each kg/s of propellant buys at a given throat, a measure of the combustion alone.',
    equation: 'c* = Pc·At / ṁ',
    source: SUTTON,
    resolution: resolutionText('cstar'),
  },
  etaCstar: {
    term: 'ηc*',
    short: 'Delivered c* over the ideal equilibrium c*: how completely the injector burns the propellant.',
    equation: 'ηc* = c*_delivered / c*_ideal',
    source: SUTTON,
    resolution: resolutionText('percent'),
  },
  isp: {
    term: 'Isp',
    short: 'Specific impulse: thrust per unit weight flow of propellant, in seconds.',
    equation: 'Isp = F / (ṁ·g₀)',
    source: SUTTON,
    resolution: resolutionText('isp'),
  },
  cf: {
    term: 'Cf',
    short: 'Thrust coefficient: how much the nozzle multiplies chamber pressure acting on the throat.',
    equation: 'F = Cf·Pc·At',
    source: SUTTON,
    resolution: resolutionText('ratio'),
  },
  thrust: {
    term: 'Thrust',
    short: 'The force the engine delivers, at the stand\'s ambient pressure unless flown.',
    equation: 'F = ṁ·v_e + (Pe − Pa)·Ae',
    source: SUTTON,
    resolution: resolutionText('force'),
  },
  burnTime: {
    term: 'Burn time',
    short: 'From Fire to the first tank running dry.',
    resolution: resolutionText('time'),
  },
  totalImpulse: {
    term: 'Total impulse',
    short: 'Thrust summed over the whole burn.',
    equation: 'I = ∫F dt',
    source: SUTTON,
    resolution: resolutionText('impulse'),
  },
  lstar: {
    term: 'L*',
    short: 'Characteristic length: chamber volume per throat area, a stand-in for how long the propellant has to burn before it leaves.',
    equation: 'L* = Vc / At',
    source: SUTTON,
  },
  contractionRatio: {
    term: 'Contraction ratio',
    short: 'Chamber cross-section over throat area.',
    equation: 'CR = Ac / At',
    source: HUZEL,
    resolution: resolutionText('ratio'),
  },
  expansionRatio: {
    term: 'Expansion ratio ε',
    short: 'Nozzle exit area over throat area, which sets the exit pressure.',
    equation: 'ε = Ae / At',
    source: SUTTON,
    resolution: resolutionText('ratio'),
  },
  throatRecession: {
    term: 'Throat recession',
    short: 'The throat widening as its liner erodes during the burn, which lowers Pc at the same flow.',
    equation: 'Pc = ṁ·c* / At',
    resolution: resolutionText('length'),
  },
  peOverPa: {
    term: 'Pe/Pa',
    short: 'Nozzle exit pressure over ambient: above 1 the plume keeps expanding outside, below 1 the atmosphere squeezes it.',
    source: SUTTON,
    resolution: resolutionText('ratio'),
  },
  separation: {
    term: 'Flow separation',
    short: 'Far enough over-expanded, the flow leaves the nozzle wall inside the bell, which can side-load the nozzle.',
    equation: 'separates near Pe/Pa ≲ 0.4 (Summerfield criterion)',
    source: 'Summerfield, Foster & Swan, Jet Propulsion 24(5) (1954)',
  },

  summerfield: {
    term: 'Summerfield criterion',
    short: 'A rule of thumb for an over-expanded nozzle: the flow leaves the wall where the wall pressure falls to about 0.4 of ambient.',
    equation: 'separates where P_wall ≈ 0.4·Pa',
    source: 'Summerfield, Foster & Swan, Flow Separation in Overexpanded Supersonic Exhaust Nozzles, Jet Propulsion 24(5) (1954)',
  },
  schmucker: {
    term: 'Schmucker criterion',
    short: 'A separation rule that depends on the Mach number at the wall: the faster the flow there, the lower the pressure it separates at.',
    equation: 'P_sep / Pa = (1.88·M_sep − 1) to the power −0.64',
    source: 'Schmucker, Flow Processes in Overexpanded Chemical Rocket Nozzles, Part 1: Flow Separation, NASA TM-77396 (1984)',
  },
  soakBack: {
    term: 'Soak-back',
    short: 'After shutdown the heat stored in the hot liner flows outward into cooler parts, so they reach their peak after the burn has ended.',
    resolution: resolutionText('temp'),
  },
  conservationCheck: {
    term: 'Conservation check',
    short: 'Mass and energy in, against out plus what is still stored, over the whole burn; a large error means the run is not to be trusted.',
    equation: 'error = (in − out − Δstored) / in',
    source: 'Oberkampf & Roy, Verification and Validation in Scientific Computing (Cambridge University Press, 2010)',
    resolution: resolutionText('percent'),
  },

  // ---------------------------------------------------------------- flight
  specificForce: {
    term: 'Specific force',
    short: 'What an accelerometer on the vehicle reads, acceleration less gravity, which is what settles the propellant in the tanks.',
    equation: 'f = a − g',
  },
  staticMargin: {
    term: 'Static margin',
    short: 'How far the centre of pressure sits behind the centre of gravity, in body diameters; positive is stable.',
    equation: 'SM = (x_cp − x_cg) / d',
    source: 'Barrowman, The Practical Calculation of the Aerodynamic Characteristics of Slender Finned Vehicles, M.S. thesis, Catholic University of America (1967)',
    resolution: resolutionText('ratio'),
  },
  maxQ: {
    term: 'Max-Q',
    short: 'The highest dynamic pressure in flight, when the aerodynamic load on the vehicle peaks.',
    equation: 'q = ½·ρ·v²',
    resolution: resolutionText('pressure'),
  },
  apogee: {
    term: 'Apogee',
    short: 'The highest point of the flight, above ground level.',
    resolution: resolutionText('altitude'),
  },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;

export function glossary(key: GlossaryKey): GlossaryEntry {
  return GLOSSARY[key];
}

export function isGlossaryKey(k: string): k is GlossaryKey {
  return Object.prototype.hasOwnProperty.call(GLOSSARY, k);
}

/** The entry as one line for a screen reader (the hover card is its visual duplicate). */
export function glossaryText(e: GlossaryEntry): string {
  return [e.short, e.equation, e.resolution && `Model resolution ${e.resolution}.`, e.source && `Source: ${e.source}.`]
    .filter(Boolean).join(' ');
}
