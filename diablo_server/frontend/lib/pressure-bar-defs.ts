/**
 * Single source of truth for primary dashboard pressure bars / live cards.
 * Maps config.toml roles → calEntity so TopBar and home "Live Pressures" stay aligned.
 */

import type { SensorConfig } from '@/lib/sensor-config';
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

function pickCalEntity(byRole: Map<string, string>, roles: string[], fallbackEntity: string): string {
  for (const r of roles) {
    const e = byRole.get(r);
    if (e) return e;
  }
  return fallbackEntity;
}

/** Build the standard DAQ PT strip from /api/sensor-config (same mapping as TopBar). */
export function buildPressureBarDefsFromSensorConfig(sensors: SensorConfig[]): PressureBarDef[] {
  const byRole = new Map<string, string>();
  for (const s of sensors) byRole.set(String(s.role || ''), String(s.calEntity || ''));

  const chamberMid1 = pickCalEntity(byRole, ['Chamber Mid PT 1'], 'PT_Cal.Chamber_Mid_PT_1');
  const chamberMid2 = pickCalEntity(byRole, ['Chamber Mid PT 2'], 'PT_Cal.Chamber_Mid_PT_2');

  const rows: Omit<PressureBarDef, 'color'>[] = [
    { label: 'GN2 HI', entity: pickCalEntity(byRole, ['GN2 High'], 'PT_Cal.GN2_High'), nop: 900, meop: 950 },
    { label: 'GN2 REG', entity: pickCalEntity(byRole, ['GN2 Regulated'], 'PT_Cal.GN2_Regulated'), nop: 900, meop: 950 },
    { label: 'FUEL UP', entity: pickCalEntity(byRole, ['Fuel Upstream'], 'PT_Cal.Fuel_Upstream'), nop: 600, meop: 650 },
    { label: 'FUEL DN', entity: pickCalEntity(byRole, ['Fuel Downstream'], 'PT_Cal.Fuel_Downstream'), nop: 600, meop: 650 },
    { label: 'LOX UP', entity: pickCalEntity(byRole, ['Ox Upstream', 'LOX Upstream'], 'PT_Cal.Ox_Upstream'), nop: 600, meop: 650 },
    { label: 'LOX DN', entity: pickCalEntity(byRole, ['Ox Downstream', 'LOX Downstream'], 'PT_Cal.Ox_Downstream'), nop: 600, meop: 650 },
    { label: 'GSE LO', entity: pickCalEntity(byRole, ['GSE Low'], 'PT_Cal.GSE_Low'), nop: 500, meop: 700 },
    { label: 'GSE MID', entity: pickCalEntity(byRole, ['GSE Mid'], 'PT_Cal.GSE_Mid'), nop: 4000, meop: 4500 },
    { label: 'GSE HI', entity: pickCalEntity(byRole, ['GSE High'], 'PT_Cal.GSE_High'), nop: 500, meop: 700 },
    {
      label: 'CHAMBER',
      entity: chamberMid1,
      nop: 500,
      meop: 650,
      avgEntities: [chamberMid1, chamberMid2],
    },
  ];

  return rows.map((r) => ({
    ...r,
    color: STRIP_LABEL_COLORS[r.label] ?? getEntityColor(r.avgEntities?.[0] ?? r.entity),
  }));
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

export function buildPressurePlotSeriesFromSensorList(sensors: SensorConfig[]): PressurePlotSeries[] {
  return pressureBarDefsToPlotSeries(buildPressureBarDefsFromSensorConfig(sensors));
}
