/**
 * Builds the primary dashboard pressure bars / live cards.
 *
 * The bar LIST is config-driven — authored in config.toml [[gui.pressure_bars]]
 * and fetched via useGuiConfig() — so which gauges show, their order, labels and
 * colours change with no rebuild. NOP/MEOP always come from [pressure_limits]
 * (the single source of truth, shared with the plot pages). When no config list
 * is supplied we fall back to DEFAULT_BARS so nothing breaks pre-migration.
 */

import type { SensorConfig } from '@/lib/sensor-config';
import type { PressureBarConfig } from '@/lib/gui-config';
import type { PressureLimitsMap } from '@/lib/pressure-limits';
import { getEntityColor } from '@/lib/sensor-colors';

/** Fixed strip colors (must stay stable; entity strings change with wiring). */
const STRIP_LABEL_COLORS: Record<string, string> = {
  'GN2 HI': '#ADFF2F',
  'GN2 REG': '#228B22',
  'FUEL UP': '#FF4500',
  'FUEL DN': '#CC0000',
  'LOX UP': '#38BDF8',
  'LOX DN': '#4169E1',
  'GSE LO': '#D8B4FE',
  'GSE MID': '#C026D3',
  'GSE HI': '#7B2FBE',
  CHAMBER: '#F97316',
};

export type PressureBarDef = {
  label: string;
  entity: string;
  nop?: number;
  meop?: number;
  color: string;
  /** When set, displayed value = mean of pressure_psi over these entities (matches TopBar chamber). */
  avgEntities?: string[];
};

/** Internal shape both the config list and DEFAULT_BARS normalize to. */
type BarSource = {
  label: string;
  roles: string[];
  avgRoles?: string[];
  limitsKey?: string;
  color?: string;
};

/**
 * Fallback bar list used when config.toml has no [[gui.pressure_bars]].
 * `limitsKey` points each bar at [pressure_limits] so thresholds stay unified
 * even in the fallback path.
 */
const DEFAULT_BARS: BarSource[] = [
  { label: 'GN2 HI', roles: ['GN2 High'], limitsKey: 'GN2_High' },
  { label: 'GN2 REG', roles: ['GN2 Regulated'], limitsKey: 'GN2_Regulated' },
  { label: 'FUEL UP', roles: ['Fuel Upstream'], limitsKey: 'Fuel_Upstream' },
  { label: 'FUEL DN', roles: ['Fuel Downstream'], limitsKey: 'Fuel_Downstream' },
  { label: 'LOX UP', roles: ['Ox Upstream', 'LOX Upstream'], limitsKey: 'Ox_Upstream' },
  { label: 'LOX DN', roles: ['Ox Downstream', 'LOX Downstream'], limitsKey: 'Ox_Downstream' },
  { label: 'GSE LO', roles: ['GSE Low'], limitsKey: 'GSE_Low' },
  { label: 'GSE MID', roles: ['GSE Mid'], limitsKey: 'GSE_Mid' },
  { label: 'GSE HI', roles: ['GSE High'], limitsKey: 'GSE_High' },
  {
    label: 'CHAMBER',
    roles: ['Chamber Mid PT 1'],
    avgRoles: ['Chamber Mid PT 1', 'Chamber Mid PT 2'],
    limitsKey: 'Chamber',
  },
];

/** Role name → conventional calibrated-entity fallback, e.g. "GN2 High" → "PT_Cal.GN2_High". */
function roleToFallbackEntity(role: string): string {
  return `PT_Cal.${role.replace(/\s+/g, '_')}`;
}

function pickCalEntity(byRole: Map<string, string>, roles: string[]): string {
  for (const r of roles) {
    const e = byRole.get(r);
    if (e) return e;
  }
  return roles.length ? roleToFallbackEntity(roles[0]) : '';
}

/** Normalize a config-authored bar into the internal BarSource shape. */
function configBarToSource(bar: PressureBarConfig): BarSource {
  return {
    label: bar.label,
    roles: bar.role ? [bar.role] : (bar.avg_roles ?? []),
    avgRoles: bar.avg_roles,
    limitsKey: bar.limits,
    color: bar.color,
  };
}

/**
 * Build the DAQ PT strip.
 * @param sensors  from /api/sensor-config (role → calEntity)
 * @param bars     config.toml [[gui.pressure_bars]] (via useGuiConfig); falls back to DEFAULT_BARS
 * @param limits   [pressure_limits] map (via usePressureLimits); supplies NOP/MEOP
 */
export function buildPressureBarDefsFromSensorConfig(
  sensors: SensorConfig[],
  bars?: PressureBarConfig[],
  limits?: PressureLimitsMap,
): PressureBarDef[] {
  const byRole = new Map<string, string>();
  for (const s of sensors) byRole.set(String(s.role || ''), String(s.calEntity || ''));

  const sources: BarSource[] = bars && bars.length ? bars.map(configBarToSource) : DEFAULT_BARS;

  return sources.map((src) => {
    const entity = pickCalEntity(byRole, src.roles);
    const avgEntities = src.avgRoles?.map((r) => byRole.get(r) ?? roleToFallbackEntity(r));
    const lim = src.limitsKey ? limits?.[src.limitsKey] : undefined;

    return {
      label: src.label,
      entity,
      nop: lim?.NOP,
      meop: lim?.MEOP,
      color: src.color ?? STRIP_LABEL_COLORS[src.label] ?? getEntityColor(avgEntities?.[0] ?? entity),
      ...(avgEntities && avgEntities.length >= 2 ? { avgEntities } : {}),
    };
  });
}

/** Plot label formatting (matches dashboard cards). */
export function shortPressurePlotLabel(full: string): string {
  return full.replace('Upstream', 'Up').replace('Downstream', 'Down').replace('Regulated', 'Reg');
}

export type PressurePlotSeries = { label: string; entity: string; color: string };

/**
 * Flatten strip defs into TimeSeriesPlot rows — same entities as the top bar / live cards.
 * Chamber with two mids becomes two traces (top bar remains their average).
 */
export function pressureBarDefsToPlotSeries(defs: PressureBarDef[]): PressurePlotSeries[] {
  const out: PressurePlotSeries[] = [];
  for (const d of defs) {
    if (d.avgEntities && d.avgEntities.length >= 2 && d.avgEntities[0] !== d.avgEntities[1]) {
      out.push({ label: `${shortPressurePlotLabel(d.label)}·1`, entity: d.avgEntities[0], color: d.color });
      out.push({ label: `${shortPressurePlotLabel(d.label)}·2`, entity: d.avgEntities[1], color: d.color });
    } else {
      out.push({ label: shortPressurePlotLabel(d.label), entity: d.entity, color: d.color });
    }
  }
  return out;
}

export function buildPressurePlotSeriesFromSensorList(
  sensors: SensorConfig[],
  bars?: PressureBarConfig[],
  limits?: PressureLimitsMap,
): PressurePlotSeries[] {
  return pressureBarDefsToPlotSeries(buildPressureBarDefsFromSensorConfig(sensors, bars, limits));
}
