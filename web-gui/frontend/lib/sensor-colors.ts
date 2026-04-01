/**
 * Unified sensor/measurement colors for graphs and panes.
 * Same measurement = same color everywhere.
 */

export const ENTITY_COLORS: Record<string, string> = {
  // Named calibrated PT entities (femboy-aligned)
  'PT_Cal.GN2_Regulated': '#228B22',
  'PT_Cal.Fuel_Upstream': '#FF4500',
  'PT_Cal.Fuel_Downstream': '#CC0000',
  'PT_Cal.Ox_Upstream': '#38BDF8',
  'PT_Cal.Ox_Downstream': '#4169E1',
  'PT_Cal.GSE_Low': '#D8B4FE',
  'PT_Cal.GSE_Mid': '#C026D3',
  'PT_Cal.GSE_High': '#7B2FBE',
  'PT_Cal.GN2_High': '#ADFF2F',
  'PT_Cal.Chamber_Mid_PT_1': '#F97316',
  'PT_Cal.Chamber_Mid_PT_2': '#FB923C',
  'PT_Cal.Chamber_Throat_PT_1': '#FDBA74',
  'PT_Cal.Chamber_Throat_PT_2': '#FED7AA',
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
  { label: 'GN2 High', entity: 'PT1_Cal.CH9', component: 'pressure_psi' as const, color: '#ADFF2F', nop: 900, meop: 950 },
  { label: 'GN2 Regulated', entity: 'PT1_Cal.CH6', component: 'pressure_psi' as const, color: '#228B22', nop: 900, meop: 950 },
  { label: 'Fuel Upstream', entity: 'PT1_Cal.CH1', component: 'pressure_psi' as const, color: '#FF4500', nop: 600, meop: 650 },
  { label: 'Fuel Downstream', entity: 'PT1_Cal.CH3', component: 'pressure_psi' as const, color: '#CC0000', nop: 600, meop: 650 },
  { label: 'LOX Upstream', entity: 'PT1_Cal.CH5', component: 'pressure_psi' as const, color: '#38BDF8', nop: 600, meop: 650 },
  { label: 'LOX Downstream', entity: 'PT1_Cal.CH7', component: 'pressure_psi' as const, color: '#4169E1', nop: 600, meop: 650 },
  { label: 'GSE Low', entity: 'PT1_Cal.CH2', component: 'pressure_psi' as const, color: '#D8B4FE', nop: 500, meop: 700 },
  { label: 'GSE MID', entity: 'PT1_Cal.CH8', component: 'pressure_psi' as const, color: '#C026D3', nop: 4000, meop: 4500 },
  { label: 'GSE High', entity: 'PT1_Cal.CH10', component: 'pressure_psi' as const, color: '#7B2FBE', nop: 500, meop: 700 },
  // Fallback strip only — prefer buildPressureBarDefsFromSensorConfig for dashboard alignment.
  { label: 'Chamber', entity: 'PT1_Cal.CH4', component: 'pressure_psi' as const, color: '#F97316', nop: 500, meop: 650 },
] as const;

/** For TopBar fallback only — prefer buildPressureBarDefsFromSensorConfig when sensor-config has loaded. */
export const PRESSURE_BAR_SENSORS = PRESSURE_SENSORS.map((s) => ({
  label: s.label,
  entity: s.entity,
  color: s.color,
  nop: s.nop,
  meop: s.meop,
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
