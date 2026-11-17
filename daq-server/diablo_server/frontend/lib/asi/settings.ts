/**
 * ASI settings shared by the ASI Test and ASI Twin tabs.
 *
 * Two halves:
 *   - `mapping`: which DAQ sensor role / actuator role is which piece of the ASI
 *     (blank = auto-detect by name or P&ID tag, see `autoMapping`).
 *   - `model`: the twin's description of the hardware.
 *
 * Defaults come from the two ASI documents:
 *   [P&ID]  "ASI V1" P&ID (pid-designer export, copy of Cash Arjuna Eden)
 *   [DP]    asi_gox_gch4_17gs_100psia_2026-10-07.yaml (ASI-1 design point)
 * and say which in `MODEL_NOTES`. Anything tagged [assume] is not in either and
 * should be replaced by a measurement. Kept per browser (localStorage); nothing
 * here reaches the backend or the boards.
 */

import { create } from 'zustand';
import { OF_FLAMMABLE } from './physics';

export type LineId = 'gox' | 'ch4';
export type ReliefLocation = 'upstream' | 'downstream';

export interface ReliefConfig {
  /** P&ID tag, e.g. RV-6. */
  name: string;
  /** Which side of the run valve it protects. */
  location: ReliefLocation;
  /** Cracking pressure, psig. */
  setPsig: number;
  /** Effective area when fully lifted, mm^2. */
  fullCdA_mm2: number;
  /** Overpressure above set at which it is fully lifted, % of set. */
  accumulationPct: number;
}

/** An actuated vent solenoid (P&ID SOL-16..19), driven from the ASI's PDB like any valve. */
export interface VentConfig {
  /** P&ID tag, e.g. SOL-18. */
  name: string;
  /** Which side of the run valve it vents. */
  location: ReliefLocation;
  /** PDB connector, for display; the DAQ role carries the real one. */
  connector: number;
  /** Fully open, mm^2. */
  cdA_mm2: number;
  openMs: number;
  closeMs: number;
}

export interface LineTags {
  regulator: string;
  upstreamPt: string;
  downstreamPt: string;
  valve: string;
  qd: string;
}

export interface LineConfig {
  tags: LineTags;
  /** Regulator setting, psig. */
  supplyPsig: number;
  /** Regulator + supply plumbing as one effective orifice, mm^2. */
  supplyCdA_mm2: number;
  /** Gas volume regulator -> run valve (upstream PT node), cm^3. */
  upstreamVolume_cc: number;
  /** Pneumatic run valve fully open, mm^2. */
  valveCdA_mm2: number;
  /** Pneumatic run valve stroke from command (pilot + actuator fill + travel), ms. */
  valveOpenMs: number;
  valveCloseMs: number;
  /** Gas volume run valve -> injector hole, incl. umbilical and QD (downstream PT node), cm^3. */
  downstreamVolume_cc: number;
  /** Injector metering hole diameter, mm. */
  holeDia_mm: number;
  /** Injector hole discharge coefficient. */
  holeCd: number;
  /** Feed gas temperature, K (isothermal lines). */
  gasTempK: number;
  reliefs: [ReliefConfig, ReliefConfig];
  /** [0] before the run valve, [1] after it (operator, 2026-11-16). */
  vents: [VentConfig, VentConfig];
  /** PDB connector driving the run valve's pilot solenoid, for display. */
  valveConnector: number;
}

export interface AsiThermal {
  /** Copper conductivity, W/(m K). */
  wallK: number;
  /** Copper rho*cp, MJ/(m^3 K). */
  rhoCp_MJ: number;
  /** Design total flow the film coefficients are stated at, g/s. */
  mdotRef_gs: number;
  /** Gas-side film coefficient at the TC station (chamber bore) at mdotRef, W/(m^2 K). */
  hChamber: number;
  /** Body wall thickness carrying the TC station's heat (lumped-equivalent), mm. */
  bodyTEff_mm: number;
  /** TC tip depth below the bore surface, mm. */
  tcDepth_mm: number;
  /** TC probe lag in its blind hole, s. */
  tcTauS: number;
  /** Gas-side film coefficient at the throat (lower neck) at mdotRef, W/(m^2 K). */
  hThroat: number;
  /** Lower-neck lumped wall thickness, mm. */
  neckTEff_mm: number;
  /** Neck temperature limit, K. */
  neckLimitK: number;
}

export interface AsiModel {
  gox: LineConfig;
  ch4: LineConfig;
  throatDia_mm: number;
  /** c* efficiency; effective gas temperature is eta^2 * T_ad. */
  cstarEff: number;
  /** Pressure the ASI exhausts into, psia: ambient for a torch-only fire, main Pc in the engine. */
  backPressurePsia: number;
  /** Ignition / sustain window, mass O/F. */
  ofMin: number;
  ofMax: number;
  /** Light gate: ASI Pc must pass this ... */
  gatePcPsia: number;
  /** ... within this long of the valves opening, ms. */
  gateMs: number;
  /** Burn cap from light, s. */
  burnCapS: number;
  thermal: AsiThermal;
}

export interface AsiMapping {
  goxUp: string;
  goxDn: string;
  ch4Up: string;
  ch4Dn: string;
  tc: string;
  goxValve: string;
  ch4Valve: string;
  goxVentUp: string;
  goxVentDn: string;
  ch4VentUp: string;
  ch4VentDn: string;
  spark: string;
}

export interface AsiSettings {
  mapping: AsiMapping;
  model: AsiModel;
}

/** Cv to effective area: CdA[in^2] ~= Cv / 38 (ISA-75.01 gas sizing, rule of thumb). */
export const cvToCdA_mm2 = (cv: number): number => (cv / 38) * 645.16;

const vent = (name: string, location: ReliefLocation, connector: number): VentConfig => ({
  name, location, connector, cdA_mm2: Number(cvToCdA_mm2(0.2).toFixed(2)), openMs: 50, closeMs: 50,
});

const relief = (name: string, location: ReliefLocation, setPsig: number): ReliefConfig => ({
  name, location, setPsig, fullCdA_mm2: 2, accumulationPct: 10,
});

export const DEFAULT_MODEL: AsiModel = {
  gox: {
    tags: { regulator: 'PR-1', upstreamPt: 'PT-LP-5', downstreamPt: 'PT-LP-2', valve: 'GOx run valve', qd: 'HQD-1' },
    supplyPsig: 580, supplyCdA_mm2: 10, upstreamVolume_cc: 30,
    valveCdA_mm2: Number(cvToCdA_mm2(0.2).toFixed(2)), valveOpenMs: 50, valveCloseMs: 50,
    downstreamVolume_cc: 20, holeDia_mm: 1.397, holeCd: 0.8, gasTempK: 293,
    reliefs: [relief('RV-6', 'upstream', 750), relief('RV-8', 'downstream', 725)],
    vents: [vent('SOL-18', 'upstream', 1), vent('SOL-16', 'downstream', 2)],
    valveConnector: 3,
  },
  ch4: {
    tags: { regulator: 'PR-3', upstreamPt: 'PT-LP-6', downstreamPt: 'PT-LP-1', valve: 'CH4 run valve', qd: 'HQD-2' },
    supplyPsig: 603, supplyCdA_mm2: 10, upstreamVolume_cc: 30,
    valveCdA_mm2: Number(cvToCdA_mm2(0.2).toFixed(2)), valveOpenMs: 50, valveCloseMs: 50,
    downstreamVolume_cc: 20, holeDia_mm: 1.041, holeCd: 0.8, gasTempK: 293,
    reliefs: [relief('RV-5', 'upstream', 750), relief('RV-9', 'downstream', 725)],
    vents: [vent('SOL-19', 'upstream', 4), vent('SOL-17', 'downstream', 5)],
    valveConnector: 6,
  },
  throatDia_mm: 7.37,
  cstarEff: 0.9,
  backPressurePsia: 14.696,
  ofMin: Number(OF_FLAMMABLE.min.toFixed(2)),
  ofMax: 8,
  gatePcPsia: 80,
  gateMs: 250,
  burnCapS: 0.85,
  thermal: {
    wallK: 355,
    rhoCp_MJ: 3.43,
    mdotRef_gs: 17.5,
    // Throat: DP Bartz q 14.7 MW/m^2 over (eta^2 Tc - T0) = (0.81*3107 - 293) K.
    hThroat: Math.round(14.7e6 / (0.81 * 3107 - 293)),
    // Chamber bore: the throat q scaled by DP's Bartz D^-1.8 at fixed mdot, (7.37/16.5)^1.8.
    hChamber: Math.round((14.7e6 * Math.pow(7.37 / 16.5, 1.8)) / (0.81 * 3107 - 293)),
    // Ø50 body around the Ø16.5 bore: t_eff = (ro^2 - ri^2) / (2 ri), DP's lumped_wall.
    bodyTEff_mm: Number(((25 ** 2 - 8.25 ** 2) / (2 * 8.25)).toFixed(1)),
    tcDepth_mm: 1.0,
    tcTauS: 0.15,
    neckTEff_mm: 4.62,
    neckLimitK: 1100,
  },
};

/** What each model number stands for and where its default came from. */
export const MODEL_NOTES: Record<string, string> = {
  supplyPsig: '[P&ID][DP] PR-1 (GOx) 580 psig, PR-3 (CH4) 603 psig; lockup 645 psig.',
  supplyCdA_mm2: '[assume] Regulator + supply tubing as one orifice, 10 mm² (≈Cv 0.6). Fit from a flow test.',
  upstreamVolume_cc: '[assume] Regulator → run valve, incl. MF-2 / MF-1 manifolds: 30 cm³.',
  valveCdA_mm2: '[DP][assume] Run valve Cv 0.2–0.4 (the DP sized a direct-acting solenoid; the stand uses a pneumatic valve — use its datasheet Cv). Default the low end, Cv 0.2 → 3.4 mm² (CdA[in²] ≈ Cv/38).',
  valveOpenMs: '[assume] Pneumatic run valve, PDB-driven pilot. 50 ms is the DP spec for a direct-acting solenoid, kept as a placeholder: a pneumatic valve adds pilot and actuator fill time. Measure with the Valve response test.',
  valveCloseMs: '[assume] Pneumatic run valve close (actuator exhaust), placeholder 50 ms. Measure with the Valve response test.',
  downstreamVolume_cc: '[assume] Run valve → hole incl. MF-3/MF-4, umbilical, QD: 20 cm³.',
  holeDia_mm: '[DP] GOx #54 drill Ø1.397 mm; CH4 #59 drill Ø1.041 mm (1+1 unlike doublet).',
  holeCd: '[DP][assume] Cd 0.80, to be closed by cold-flowing each insert.',
  gasTempK: '[DP] Feed gas 293 K.',
  throatDia_mm: '[DP] L drill Ø7.37 mm (fallback N drill Ø7.67 if Pc runs high).',
  cstarEff: '[DP][assume] η_c* 0.90; measure on the first torch-only fire.',
  backPressurePsia: 'Ambient (14.7) for a torch-only fire. In the engine the ASI exits flush with the main injector face: set main Pc (378–420 psia [DP]); GOx holes unchoke above ~315 psia.',
  ofMin: 'Richest O/F that lights: CH4 upper flammability limit in O₂, 61 vol% (Bureau of Mines Bull. 503) → O/F 1.28.',
  ofMax: 'Leanest O/F modelled (table edge 8; lean limit in O₂ is O/F ≈ 37).',
  gatePcPsia: '[DP] Sequence gate: ASI Pc > ~80 psia ...',
  gateMs: '[DP] ... within ~250 ms, else abort.',
  burnCapS: '[DP][prop] 0.85 s cap from ASI light (lower-neck lumped limit 0.86 s).',
  wallK: '[lit] C14500 tellurium copper, ~355 W/(m·K) at 20 °C (CDA data sheet).',
  rhoCp_MJ: '[DP] C145 ρ·cp 3.43 MJ/(m³·K).',
  mdotRef_gs: '[DP] Design total 17.5 g/s (12.5 GOx + 5.0 CH4).',
  hChamber: '[calc] Throat h scaled by DP Bartz D^-1.8 to the Ø16.5 bore. Film coefficients scale with ṁ^0.8.',
  bodyTEff_mm: '[calc] Ø50 body around Ø16.5 bore, DP lumped_wall t_eff = (ro²−ri²)/(2 ri).',
  tcDepth_mm: '[DP] TC-1 in a Ø1.7 blind hole to 1.0 mm from the bore: it reads copper, not gas.',
  tcTauS: '[assume] Type K 1/16" probe lag in its blind hole, 0.15 s.',
  hThroat: '[calc] DP Bartz q 14.7 MW/m² over (η²·Tc − T0) at the design point.',
  neckTEff_mm: '[DP] Lower neck t_eff 4.62 mm (the burn-time limiter).',
  neckLimitK: '[DP] Neck limit 1100 K (C145 half-hard: never anneal).',
  setPsig: '[P&ID] RV-5/RV-6 750 psig (after reg), RV-8/RV-9 725 psig (check → QD). The DP lists RV-5/6 at 725: confirm with the tags.',
  fullCdA_mm2: '[assume] Relief flow area fully lifted, 2 mm².',
  ventCdA_mm2: '[assume] Vent solenoid open, Cv 0.2 → 3.4 mm². Use the datasheet Cv.',
  ventMs: '[assume] Vent solenoid stroke 50 ms.',
  vents: '[operator 2026-11-16] ASI PDB connectors: GOx 1 vent before run valve, 2 vent after, 3 run valve (pneumatic, its pilot); CH4 4, 5, 6. All NC.',
  accumulationPct: '[assume] Overpressure to full lift, 10 % of set.',
};

export const EMPTY_MAPPING: AsiMapping = {
  goxUp: '', goxDn: '', ch4Up: '', ch4Dn: '', tc: '', goxValve: '', ch4Valve: '',
  goxVentUp: '', goxVentDn: '', ch4VentUp: '', ch4VentDn: '', spark: '',
};

export const DEFAULT_SETTINGS: AsiSettings = { mapping: EMPTY_MAPPING, model: DEFAULT_MODEL };

const STORAGE_KEY = 'asi.settings.v3';

function load(): AsiSettings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return mergeSettings(JSON.parse(raw) as Partial<AsiSettings>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Fill anything a stored (older) copy lacks from the defaults. */
export function mergeSettings(p: Partial<AsiSettings> | undefined): AsiSettings {
  const m = (p?.model ?? {}) as Partial<AsiModel>;
  const line = (id: LineId): LineConfig => {
    const d = DEFAULT_MODEL[id];
    const s = (m[id] ?? {}) as Partial<LineConfig>;
    const r = Array.isArray(s.reliefs) ? s.reliefs : [];
    const v = Array.isArray(s.vents) ? s.vents : [];
    return {
      ...d, ...s,
      tags: { ...d.tags, ...(s.tags ?? {}) },
      reliefs: [{ ...d.reliefs[0], ...(r[0] ?? {}) }, { ...d.reliefs[1], ...(r[1] ?? {}) }],
      vents: [{ ...d.vents[0], ...(v[0] ?? {}) }, { ...d.vents[1], ...(v[1] ?? {}) }],
    };
  };
  return {
    mapping: { ...EMPTY_MAPPING, ...(p?.mapping ?? {}) },
    model: {
      ...DEFAULT_MODEL, ...m,
      gox: line('gox'), ch4: line('ch4'),
      thermal: { ...DEFAULT_MODEL.thermal, ...(m.thermal ?? {}) },
    },
  };
}

function save(s: AsiSettings): void {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* private window */ }
}

interface AsiSettingsStore {
  settings: AsiSettings;
  setMapping: (patch: Partial<AsiMapping>) => void;
  setModel: (model: AsiModel) => void;
  resetModel: () => void;
}

export const useAsiSettings = create<AsiSettingsStore>((set) => ({
  settings: load(),
  setMapping: (patch) => set((st) => {
    const settings = { ...st.settings, mapping: { ...st.settings.mapping, ...patch } };
    save(settings);
    return { settings };
  }),
  setModel: (model) => set((st) => {
    const settings = { ...st.settings, model };
    save(settings);
    return { settings };
  }),
  resetModel: () => set((st) => {
    const settings = { ...st.settings, model: DEFAULT_MODEL };
    save(settings);
    return { settings };
  }),
}));

// ── Auto-detection of DAQ roles ──────────────────────────────────────────────

const GOX_RE = /\b(gox|g-?ox|oxygen|o2)\b|asi.*\box\b/i;
const CH4_RE = /\b(ch4|gch4|methane|lng)\b|asi.*\bfuel\b/i;
const UP_RE = /\b(up|upstream|us|supply|reg)\b/i;
const DN_RE = /\b(dn|down|downstream|ds|inj|injector|manifold)\b/i;
const ASI_RE = /\b(asi|igniter|ignitor|torch)\b/i;
const VENT_RE = /\b(vent|relief|bleed|sol-?1[6-9])\b/i;
const RUN_RE = /\b(run|main|valve|feed|iso)\b/i;

function pickRole(roles: string[], ...tests: RegExp[]): string {
  return roles.find((r) => tests.every((t) => t.test(r))) ?? '';
}

/** Like pickRole, but the role must also NOT match `not`. */
function pickRoleNot(roles: string[], not: RegExp, ...tests: RegExp[]): string {
  return roles.find((r) => !not.test(r) && tests.every((t) => t.test(r))) ?? '';
}

/** A role named by its P&ID tag ("PT-LP-5", "PT LP 5", "PTLP5"). */
function tagRe(tag: string): RegExp {
  const parts = tag.split(/[-\s]+/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b${parts.join('[-_\\s]*')}\\b`, 'i');
}

/**
 * Best guess of the mapping from role names, used for any field left blank. A role
 * named by its P&ID tag (PT-LP-5, PT-LP-2, PT-LP-6, PT-LP-1, TC-1) resolves first;
 * then names like "ASI GOx Upstream", "Methane Dn", "ASI TC", "GOx Valve", "Spark".
 */
export function autoMapping(
  ptRoles: string[], tcRoles: string[], actuatorNames: string[], model: AsiModel = DEFAULT_MODEL,
): AsiMapping {
  const pt = (tag: string, side: RegExp, pos: RegExp) =>
    pickRole(ptRoles, tagRe(tag)) || pickRole(ptRoles, side, pos);
  return {
    goxUp: pt(model.gox.tags.upstreamPt, GOX_RE, UP_RE),
    goxDn: pt(model.gox.tags.downstreamPt, GOX_RE, DN_RE),
    ch4Up: pt(model.ch4.tags.upstreamPt, CH4_RE, UP_RE),
    ch4Dn: pt(model.ch4.tags.downstreamPt, CH4_RE, DN_RE),
    // "TC-1" only as the whole role: the main engine's "Chamber Mid TC 1" must not match.
    tc: pickRole(tcRoles, ASI_RE) || pickRole(tcRoles, /^\s*TC[-_\s]*1\s*$/i),
    // A vent is never the run valve.
    goxValve: pickRoleNot(actuatorNames, VENT_RE, GOX_RE, RUN_RE) || pickRoleNot(actuatorNames, VENT_RE, GOX_RE),
    ch4Valve: pickRoleNot(actuatorNames, VENT_RE, CH4_RE, RUN_RE) || pickRoleNot(actuatorNames, VENT_RE, CH4_RE),
    goxVentUp: pickRole(actuatorNames, tagRe(model.gox.vents[0].name)) || pickRole(actuatorNames, GOX_RE, VENT_RE, UP_RE),
    goxVentDn: pickRole(actuatorNames, tagRe(model.gox.vents[1].name)) || pickRole(actuatorNames, GOX_RE, VENT_RE, DN_RE),
    ch4VentUp: pickRole(actuatorNames, tagRe(model.ch4.vents[0].name)) || pickRole(actuatorNames, CH4_RE, VENT_RE, UP_RE),
    ch4VentDn: pickRole(actuatorNames, tagRe(model.ch4.vents[1].name)) || pickRole(actuatorNames, CH4_RE, VENT_RE, DN_RE),
    spark: pickRole(actuatorNames, /\b(spark|exciter|plug)\b/i),
  };
}

/** Explicit mapping where set, auto-detected otherwise. */
export function resolveMapping(explicit: AsiMapping, auto: AsiMapping): AsiMapping {
  const out = { ...auto };
  (Object.keys(explicit) as (keyof AsiMapping)[]).forEach((k) => { if (explicit[k]) out[k] = explicit[k]; });
  return out;
}

/** Injector hole effective area, mm^2. */
export const holeCdA_mm2 = (l: LineConfig): number => l.holeCd * Math.PI * (l.holeDia_mm / 2) ** 2;
