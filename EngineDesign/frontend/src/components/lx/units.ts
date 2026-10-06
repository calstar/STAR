import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { fmt, LB, PSI } from '../layerx/format';

/**
 * Layer X's one unit system (docs/layerx/GUI-SPEC.md, "Units").
 *
 * Every displayed quantity goes through here: `u.p(psia, 'gauge')`, `u.f(N)`, `u.m(kg)`... Each
 * returns `{ value, unit, digits }`, and `formatQ` turns that into "564 psig" with a no-break
 * space so the unit never orphans. The model's own units do not change: pressures arrive in psia,
 * everything else in SI, and are converted only for display (and back, for a typed Field, with
 * `scale(...).from`).
 *
 * Digits come from the quantity's resolution (RESOLUTION below), never from the raw float: a
 * tank pressure is good to 1 psi whatever the solver printed.
 */

// ------------------------------------------------------------------ constants

/** psi in one bar (1 bar = 1e5 Pa exactly). */
export const PSI_PER_BAR = 1e5 / PSI;
/** Newtons in one pound-force (exact by definition: 0.45359237 kg × 9.80665 m/s²). */
export const N_PER_LBF = LB * 9.80665;
/** Metres in one foot and in one inch (exact). */
export const M_PER_FT = 0.3048;
export const M_PER_IN = 0.0254;
/** The standard atmosphere, psia: the gauge zero when a run does not state its own. */
export const STD_ATM_PSIA = 101325 / PSI;
/** Joins a number to its unit. */
export const NBSP = '\u00a0';
/** The true minus sign: a hyphen is half as wide in the mono face and reads as a dash. */
export const MINUS = '\u2212';

// ------------------------------------------------------------------ the system

export interface UnitSystem {
  pressure: 'psi' | 'bar';
  force: 'N' | 'lbf';
  mass: 'kg' | 'lb';
  /** Also picks altitude (m | ft) and speed (m/s | ft/s). */
  length: 'mm' | 'in';
  temp: 'K';
}

export const DEFAULT_SYSTEM: UnitSystem = { pressure: 'psi', force: 'N', mass: 'kg', length: 'mm', temp: 'K' };

/** The two whole systems, for a one-click choice in the units menu. The default above is the
 * stand's mix: gauges in psi, the engine in newtons. */
export const PRESETS: Record<'stand' | 'si' | 'imperial', UnitSystem> = {
  stand: DEFAULT_SYSTEM,
  si: { pressure: 'bar', force: 'N', mass: 'kg', length: 'mm', temp: 'K' },
  imperial: { pressure: 'psi', force: 'lbf', mass: 'lb', length: 'in', temp: 'K' },
};

const ALLOWED: { [K in keyof UnitSystem]: readonly UnitSystem[K][] } = {
  pressure: ['psi', 'bar'],
  force: ['N', 'lbf'],
  mass: ['kg', 'lb'],
  length: ['mm', 'in'],
  temp: ['K'],
};

/** A stored system, field by field: anything unknown falls back to the default, so a stale or
 * hand-edited entry can never put an impossible unit on the page. */
export function parseSystem(raw: unknown): UnitSystem {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const pick = <K extends keyof UnitSystem>(k: K): UnitSystem[K] =>
    (ALLOWED[k] as readonly unknown[]).includes(o[k]) ? (o[k] as UnitSystem[K]) : DEFAULT_SYSTEM[k];
  return { pressure: pick('pressure'), force: pick('force'), mass: pick('mass'), length: pick('length'), temp: pick('temp') };
}

export const STORAGE_KEY = 'engine-design.lx.units.v1';

export function loadSystem(storage: Pick<Storage, 'getItem'> | null = safeStorage()): UnitSystem {
  try {
    const s = storage?.getItem(STORAGE_KEY);
    return s ? parseSystem(JSON.parse(s)) : DEFAULT_SYSTEM;
  } catch {
    return DEFAULT_SYSTEM; // corrupt JSON, private mode, storage disabled
  }
}

export function saveSystem(sys: UnitSystem, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(sys));
  } catch {
    /* quota or disabled storage: forgetting a unit choice is not worth a throw */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ resolution

/**
 * The resolution table: what one last digit is worth, per quantity and unit. A number is printed
 * to the decimals its resolution needs and no further. The glossary quotes these, so the hover card
 * and the page always agree.
 *
 * | quantity  | unit         | step    | why                                                         |
 * |-----------|--------------|---------|-------------------------------------------------------------|
 * | pressure  | psia, psig   | 1       | the stand's gauges and the model's tank pressure: 1 psi      |
 * |           | bar(a/g)     | 0.1     | the same resolution, 1.45 psi                                |
 * | dp        | psi          | 0.1     | one element's drop is a few psi; whole psi loses a third     |
 * |           | bar          | 0.01    |   (feed losses, ΔP across the injector, tank sag)            |
 * | pgap      | psi          | 1       | a gap between two levels: bottle over lockup, peak over      |
 * |           | bar          | 0.1     |   ambient; as good as the levels it joins                    |
 * | force     | N / lbf      | 1       | thrust to 1 N; 1 lbf is 4.4 N                                |
 * | impulse   | kN·s         | 0.01    | 10 N·s, 0.1 % of a 10 kN·s burn                              |
 * |           | lbf·s        | 1       | 4.4 N·s                                                      |
 * | mass      | kg / lb      | 0.01    | 10 g: a residual or the bottle's gas                         |
 * | mdot      | kg/s / lb/s  | 0.001   | 1 g/s on a ~3 kg/s engine                                    |
 * | length    | mm           | 0.01    | throat and liner, to 10 µm                                   |
 * |           | in           | 0.001   | a thou                                                       |
 * | altitude  | m / ft       | 1       |                                                              |
 * | temp      | K            | 0.1     | a LOX ullage moves tenths of a kelvin per step               |
 * | velocity  | m/s          | 0.1     | injection and line speeds                                    |
 * |           | ft/s         | 1       |                                                              |
 * | cstar     | m/s / ft/s   | 1       | c* is ~1500 m/s; a tenth means nothing                       |
 * | time      | s            | 0.01    | the burn is stepped at 10 ms                                 |
 * | of        | —            | 0.01    | spec: O/F to 0.01                                            |
 * | isp       | s            | 0.1     | spec: Isp to 0.1 s                                           |
 * | percent   | %            | 0.1     | ΔP/Pc, ηc*, a delta                                          |
 * | ratio     | —            | 0.01    | chug margin, ε, contraction ratio, static margin (cal)       |
 * | frequency | Hz           | 1       | chug frequency                                               |
 */
export type QuantityKind =
  | 'pressure' | 'dp' | 'pgap' | 'force' | 'impulse' | 'mass' | 'mdot' | 'length' | 'altitude' | 'temp'
  | 'velocity' | 'cstar' | 'time' | 'of' | 'isp' | 'percent' | 'ratio' | 'frequency';

export const RESOLUTION: Record<QuantityKind, Record<string, number>> = {
  pressure: { psia: 0, psig: 0, 'bar(a)': 1, 'bar(g)': 1 },
  dp: { psi: 1, bar: 2 },
  pgap: { psi: 0, bar: 1 },
  force: { N: 0, lbf: 0 },
  impulse: { 'kN·s': 2, 'lbf·s': 0 },
  mass: { kg: 2, lb: 2 },
  mdot: { 'kg/s': 3, 'lb/s': 3 },
  length: { mm: 2, in: 3 },
  altitude: { m: 0, ft: 0 },
  temp: { K: 1 },
  velocity: { 'm/s': 1, 'ft/s': 0 },
  cstar: { 'm/s': 0, 'ft/s': 0 },
  time: { s: 2 },
  of: { '': 2 },
  isp: { s: 1 },
  percent: { '%': 1 },
  ratio: { '': 2 },
  frequency: { Hz: 0 },
};

/** "1 psi or 0.1 bar": the glossary's resolution line for a quantity, from the table above. */
export function resolutionText(kind: QuantityKind): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const [unit, digits] of Object.entries(RESOLUTION[kind])) {
    // psia and psig, bar(a) and bar(g) share a resolution: say it once, as psi and bar.
    const base = unit === 'psia' || unit === 'psig' ? 'psi' : unit.replace(/\((a|g)\)$/, '');
    const text = `${fmt(10 ** -digits, digits)}${base ? NBSP + base : ''}`;
    if (!seen.has(text)) { seen.add(text); parts.push(text); }
  }
  return parts.join(' or ');
}

// ------------------------------------------------------------------ conversion

export interface Quantity {
  /** Converted to the display unit, unrounded (charts plot it; `formatQ` rounds it). NaN when
   * there is no value. */
  value: number;
  unit: string;
  /** Decimals to print, from RESOLUTION. */
  digits: number;
}

/** A linear display conversion for one quantity: for chart series and for typed fields. */
export interface Scale {
  kind: QuantityKind;
  unit: string;
  digits: number;
  /** model unit (psia, N, kg, m, K, m/s, s) → display unit */
  to(base: number): number;
  /** display unit → model unit */
  from(display: number): number;
}

export type PressureKind = 'abs' | 'gauge';

export interface ScaleOptions {
  /** Pressure only: absolute or gauge. Default absolute. */
  pressure?: PressureKind;
  /** Pressure only: the gauge zero in psia (the run's ambient). Default the provider's. */
  gaugeZeroPsia?: number;
}

function linear(kind: QuantityKind, unit: string, k: number, offset = 0): Scale {
  return {
    kind, unit, digits: RESOLUTION[kind][unit],
    to: (b) => (b - offset) * k,
    from: (d) => d / k + offset,
  };
}

/** The display scale of a quantity in a system. Pure: the hook below is a thin wrapper. */
export function scaleFor(sys: UnitSystem, kind: QuantityKind, opts: ScaleOptions = {}, defaultGaugeZero = STD_ATM_PSIA): Scale {
  const imperialLen = sys.length === 'in';
  switch (kind) {
    case 'pressure': {
      const gauge = opts.pressure === 'gauge';
      const zero = gauge ? (opts.gaugeZeroPsia ?? defaultGaugeZero) : 0;
      return sys.pressure === 'bar'
        ? linear(kind, gauge ? 'bar(g)' : 'bar(a)', 1 / PSI_PER_BAR, zero)
        : linear(kind, gauge ? 'psig' : 'psia', 1, zero);
    }
    case 'dp':
    case 'pgap': return sys.pressure === 'bar' ? linear(kind, 'bar', 1 / PSI_PER_BAR) : linear(kind, 'psi', 1);
    case 'force': return sys.force === 'lbf' ? linear(kind, 'lbf', 1 / N_PER_LBF) : linear(kind, 'N', 1);
    case 'impulse': return sys.force === 'lbf' ? linear(kind, 'lbf·s', 1 / N_PER_LBF) : linear(kind, 'kN·s', 1e-3);
    case 'mass': return sys.mass === 'lb' ? linear(kind, 'lb', 1 / LB) : linear(kind, 'kg', 1);
    case 'mdot': return sys.mass === 'lb' ? linear(kind, 'lb/s', 1 / LB) : linear(kind, 'kg/s', 1);
    case 'length': return imperialLen ? linear(kind, 'in', 1 / M_PER_IN) : linear(kind, 'mm', 1e3);
    case 'altitude': return imperialLen ? linear(kind, 'ft', 1 / M_PER_FT) : linear(kind, 'm', 1);
    case 'velocity': return imperialLen ? linear(kind, 'ft/s', 1 / M_PER_FT) : linear(kind, 'm/s', 1);
    case 'cstar': return imperialLen ? linear(kind, 'ft/s', 1 / M_PER_FT) : linear(kind, 'm/s', 1);
    case 'temp': return linear(kind, 'K', 1);
    case 'time': return linear(kind, 's', 1);
    case 'isp': return linear(kind, 's', 1);
    case 'of': return linear(kind, '', 1);
    case 'ratio': return linear(kind, '', 1);
    case 'frequency': return linear(kind, 'Hz', 1);
    // A fraction in the model (0.356), a percent on the page.
    case 'percent': return linear(kind, '%', 100);
  }
}

function q(s: Scale, base: number | null | undefined): Quantity {
  const v = base === null || base === undefined || !Number.isFinite(base) ? NaN : s.to(base);
  return { value: v, unit: s.unit, digits: s.digits };
}

// ------------------------------------------------------------------ formatting

/** The number alone, at its digits, with a true minus: "6,804", "−2.9", "—" for no value. */
export function numText(x: Pick<Quantity, 'value' | 'digits'> | null | undefined): string {
  if (!x || !Number.isFinite(x.value)) return '—';
  return fmt(x.value, x.digits).replace(/^-/, MINUS);
}

/** "564 psig", "35.6 %", "2.41" (no unit), or "—". Number and unit joined by a no-break space. */
export function formatQ(x: Quantity | null | undefined): string {
  const n = numText(x);
  return x && n !== '—' && x.unit ? `${n}${NBSP}${x.unit}` : n;
}

/** The parts a figure renders separately: the number in mono, the unit small beside it. */
export function partsQ(x: Quantity | null | undefined): { num: string; unit: string } {
  const num = numText(x);
  return { num, unit: num === '—' || !x ? '' : x.unit };
}

/** A value already in display units, at an explicit number of digits (axis ticks, limits). */
export function withUnit(value: number | null | undefined, digits: number, unit = ''): string {
  return formatQ({ value: value ?? NaN, digits, unit });
}

// ------------------------------------------------------------------ the API

export interface Units {
  system: UnitSystem;
  /** Changes and remembers the system (localStorage). */
  setSystem(patch: Partial<UnitSystem>): void;
  /** The gauge zero (psia) a gauge pressure is read against when a call does not give one. */
  gaugeZeroPsia: number;
  scale(kind: QuantityKind, opts?: ScaleOptions): Scale;
  /** A pressure from psia: psia | psig | bar(a) | bar(g). */
  p(psia: number | null | undefined, kind?: PressureKind, gaugeZeroPsia?: number): Quantity;
  /** A pressure drop from psi, to 0.1 psi: a feed element, the injector, tank sag. psi | bar. */
  dp(psi: number | null | undefined): Quantity;
  /** A gap between two pressure levels, to the levels' 1 psi: bottle over lockup, peak over
   * ambient. psi | bar. */
  gap(psi: number | null | undefined): Quantity;
  /** A force from N: N | lbf. */
  f(n: number | null | undefined): Quantity;
  /** A total impulse from N·s: kN·s | lbf·s. */
  impulse(ns: number | null | undefined): Quantity;
  /** A mass from kg: kg | lb. */
  m(kg: number | null | undefined): Quantity;
  /** A mass flow from kg/s: kg/s | lb/s. */
  mdot(kgps: number | null | undefined): Quantity;
  /** A length from m: mm | in. */
  len(m: number | null | undefined): Quantity;
  /** An altitude from m: m | ft (follows the length choice). */
  alt(m: number | null | undefined): Quantity;
  /** A temperature from K: K. */
  temp(k: number | null | undefined): Quantity;
  /** A speed from m/s: m/s | ft/s (follows the length choice). */
  v(mps: number | null | undefined): Quantity;
  /** c* from m/s, to 1 m/s. */
  cstar(mps: number | null | undefined): Quantity;
  /** A time in s. */
  time(s: number | null | undefined): Quantity;
  /** Isp in s. */
  isp(s: number | null | undefined): Quantity;
  /** O/F (no unit). */
  of(x: number | null | undefined): Quantity;
  /** A fraction shown as a percent: 0.356 → 35.6 %. */
  pct(fraction: number | null | undefined): Quantity;
  /** A plain ratio to 0.01: chug margin, ε. */
  ratio(x: number | null | undefined): Quantity;
  /** A frequency in Hz. */
  hz(x: number | null | undefined): Quantity;
  /** `formatQ`, for convenience: "564 psig". */
  fmt(x: Quantity | null | undefined): string;
}

/** The converters for one system. Pure; `useUnits` returns one of these. */
export function makeUnits(system: UnitSystem, gaugeZeroPsia = STD_ATM_PSIA, setSystem: (p: Partial<UnitSystem>) => void = () => {}): Units {
  const s = (kind: QuantityKind, opts?: ScaleOptions) => scaleFor(system, kind, opts, gaugeZeroPsia);
  return {
    system, setSystem, gaugeZeroPsia,
    scale: s,
    p: (psia, kind = 'abs', gz) => q(s('pressure', { pressure: kind, gaugeZeroPsia: gz }), psia),
    dp: (x) => q(s('dp'), x),
    gap: (x) => q(s('pgap'), x),
    f: (x) => q(s('force'), x),
    impulse: (x) => q(s('impulse'), x),
    m: (x) => q(s('mass'), x),
    mdot: (x) => q(s('mdot'), x),
    len: (x) => q(s('length'), x),
    alt: (x) => q(s('altitude'), x),
    temp: (x) => q(s('temp'), x),
    v: (x) => q(s('velocity'), x),
    cstar: (x) => q(s('cstar'), x),
    time: (x) => q(s('time'), x),
    isp: (x) => q(s('isp'), x),
    of: (x) => q(s('of'), x),
    pct: (x) => q(s('percent'), x),
    ratio: (x) => q(s('ratio'), x),
    hz: (x) => q(s('frequency'), x),
    fmt: formatQ,
  };
}

// ------------------------------------------------------------------ React

/** Outside a provider (a unit test, the gallery) the default system, not remembered. */
const UnitsContext = createContext<Units>(makeUnits(DEFAULT_SYSTEM));

/**
 * Holds the system for everything under it and remembers it per browser. `gaugeZeroPsia` is the
 * open run's ambient (its `ambient_psia`), so psig reads what the stand's gauges read.
 */
export function UnitsProvider({ children, gaugeZeroPsia = STD_ATM_PSIA, initial, persist = true }: {
  children?: ReactNode;
  gaugeZeroPsia?: number;
  /** Start from this instead of the stored choice (the gallery; tests). */
  initial?: UnitSystem;
  /** Remember changes in localStorage. Default true. */
  persist?: boolean;
}) {
  const [system, setState] = useState<UnitSystem>(() => initial ?? (persist ? loadSystem() : DEFAULT_SYSTEM));
  const setSystem = useCallback((patch: Partial<UnitSystem>) => {
    setState((prev) => {
      const next = parseSystem({ ...prev, ...patch });
      if (persist) saveSystem(next);
      return next;
    });
  }, [persist]);
  const value = useMemo(() => makeUnits(system, gaugeZeroPsia, setSystem), [system, gaugeZeroPsia, setSystem]);
  return createElement(UnitsContext.Provider, { value }, children);
}

export function useUnits(): Units {
  return useContext(UnitsContext);
}
