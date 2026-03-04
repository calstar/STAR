/**
 * Unified sensor/measurement colors for graphs and panes.
 * Same measurement = same color everywhere.
 */

export const ENTITY_COLORS: Record<string, string> = {
  // Named calibrated PT entities (femboy-aligned)
  'PT_Cal.GN2_Regulated': '#27AE60',
  'PT_Cal.Fuel_Upstream': '#3498DB',
  'PT_Cal.Fuel_Downstream': '#2980B9',
  'PT_Cal.Ox_Upstream': '#E74C3C',
  'PT_Cal.Ox_Downstream': '#C0392B',
  'PT_Cal.GSE_Low': '#F39C12',
  'PT_Cal.GSE_Mid': '#9B59B6',
  'PT_Cal.GSE_High': '#8E44AD',
  'PT_Cal.GN2_High': '#1ABC9C',
  // Channel-to-logical mapping (same color as named role)
  'PT_Cal.PT_CH1': '#3498DB',
  'PT_Cal.PT_CH2': '#F39C12',
  'PT_Cal.PT_CH4': '#2980B9',
  'PT_Cal.PT_CH5': '#E74C3C',
  'PT_Cal.PT_CH6': '#27AE60',
  'PT_Cal.PT_CH7': '#C0392B',
  'PT_Cal.PT_CH8': '#8E44AD',
  'PT_Cal.PT_CH9': '#1ABC9C',
  'PT_Cal.PT_CH10': '#16A085',
  'PT_Cal.HP_PT_1': '#9B59B6',
  'PT_Cal.HP_PT_3': '#8E44AD',
  'PT_Cal.HP_PT_4': '#1ABC9C',
  // Raw PT channels (same color as calibrated role for consistency)
  'PT.PT_CH1': '#E67E22', 'PT.PT_CH2': '#D7BDE2', 'PT.PT_CH3': '#9B59B6', 'PT.PT_CH4': '#C0392B',
  'PT.PT_CH5': '#5DADE2', 'PT.PT_CH6': '#3CB371', 'PT.PT_CH7': '#2471A3', 'PT.PT_CH8': '#8E44AD',
  'PT.PT_CH9': '#32CD32', 'PT.PT_CH10': '#16A085',
  // Controller duty cycle (match Fuel / LOX)
  'CONTROLLER.Fuel': '#E67E22',
  'CONTROLLER.Ox': '#5DADE2',
};

const HASH_PALETTE = ['#3498DB', '#E74C3C', '#27AE60', '#F39C12', '#9B59B6', '#1ABC9C', '#E67E22', '#34495E', '#16A085', '#C0392B', '#8E44AD', '#2980B9', '#D35400', '#F1C40F', '#D35400', '#2C3E50'];

function getConsistentHashColor(entity: string): string {
  let hash = 0;
  for (let i = 0; i < entity.length; i++) {
    hash = entity.charCodeAt(i) + ((hash << 5) - hash);
  }
  return HASH_PALETTE[Math.abs(hash) % HASH_PALETTE.length];
}

export function getEntityColor(entity: string): string {
  if (ENTITY_COLORS[entity]) return ENTITY_COLORS[entity];
  return getConsistentHashColor(entity);
}

// Order and colors aligned with femboy for consistent calibrated values across plots
export const PRESSURE_SENSORS = [
  { label: 'GN2 Regulated', entity: 'PT_Cal.GN2_Regulated', component: 'pressure_psi' as const, color: '#27AE60', nop: 900, meop: 950 },
  { label: 'GN2 High', entity: 'PT_Cal.GN2_High', component: 'pressure_psi' as const, color: '#1ABC9C', nop: 900, meop: 950 },
  { label: 'Fuel Upstream', entity: 'PT_Cal.Fuel_Upstream', component: 'pressure_psi' as const, color: '#3498DB', nop: 600, meop: 650 },
  { label: 'Fuel Downstream', entity: 'PT_Cal.Fuel_Downstream', component: 'pressure_psi' as const, color: '#2980B9', nop: 600, meop: 650 },
  { label: 'LOX Upstream', entity: 'PT_Cal.Ox_Upstream', component: 'pressure_psi' as const, color: '#E74C3C', nop: 600, meop: 650 },
  { label: 'LOX Downstream', entity: 'PT_Cal.Ox_Downstream', component: 'pressure_psi' as const, color: '#C0392B', nop: 600, meop: 650 },
  { label: 'GSE Low', entity: 'PT_Cal.GSE_Low', component: 'pressure_psi' as const, color: '#F39C12', nop: 500, meop: 700 },
  { label: 'GSE MID', entity: 'PT_Cal.GSE_Mid', component: 'pressure_psi' as const, color: '#9B59B6', nop: 4000, meop: 4500 },
  { label: 'GSE High', entity: 'PT_Cal.GSE_High', component: 'pressure_psi' as const, color: '#8E44AD', nop: 500, meop: 700 },
] as const;

/** For TopBar / compact lists: label + entity + color (and nop/meop where needed) */
export const PRESSURE_BAR_SENSORS = PRESSURE_SENSORS.map(({ label, entity, color, nop, meop }) => ({
  label,
  entity,
  color,
  nop,
  meop,
}));

/** Actuator colors (consistent across panes) */
export const ACTUATOR_COLORS: Record<string, string> = {
  'ACT.LOX_Main': '#27AE60',
  'ACT.Fuel_Main': '#27AE60',
  'ACT.LOX_Vent': '#E74C3C',
  'ACT.Fuel_Vent': '#E74C3C',
  'ACT.LOX_Press': '#F39C12',
  'ACT.Fuel_Press': '#F39C12',
  'ACT.GSE_Low_Vent': '#F39C12',
  'ACT.GN2_Vent': '#F39C12',
  'ACT.Fuel_Fill_Vent': '#9B59B6',
  'ACT.Fuel_Fill_Press': '#8E44AD',
  'ACT.ACT_CH4': '#9B59B6',
  'ACT.GSE_High_Press_Vent': '#D35400',
  'ACT.GSE_High_Press_Control': '#1ABC9C',
  'ACT.GSE_Med_Press_Control': '#16A085',
  'ACT.GSE_LOX_Fill_Vent': '#9B59B6',
  'ACT.LOX_Fill': '#9B59B6',
  'ACT.LOX_Dump': '#8E44AD',
};

export function getActuatorColor(entity: string): string {
  if (ACTUATOR_COLORS[entity]) return ACTUATOR_COLORS[entity];
  return getConsistentHashColor(entity);
}
