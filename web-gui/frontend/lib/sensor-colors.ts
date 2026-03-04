/**
 * Unified sensor/measurement colors for graphs and panes.
 * Same measurement = same color everywhere.
 */

export const ENTITY_COLORS: Record<string, string> = {
  // Named calibrated PT entities
  'PT_Cal.GN2_High': '#32CD32',   // GN2 HI: lime green
  'PT_Cal.GN2_Regulated': '#3CB371',   // GN2 reg: lime green (slightly deeper)
  'PT_Cal.Fuel_Upstream': '#E67E22',   // Fuel up: orange
  'PT_Cal.Fuel_Downstream': '#C0392B',   // Fuel down: red
  'PT_Cal.Ox_Upstream': '#5DADE2',   // LOX up: lighter blue
  'PT_Cal.Ox_Downstream': '#2471A3',   // LOX down: dark blue (brighter)
  'PT_Cal.GSE_Low': '#D7BDE2',   // GSE LOW: light purple
  'PT_Cal.GSE_Mid': '#9B59B6',   // GSE MID: purple
  'PT_Cal.GSE_High': '#8E44AD',   // GSE HI: darker purple (a little lighter)
  // Channel-to-logical mapping (same color as named role)
  'PT_Cal.PT_CH1': '#E67E22',  // Fuel Upstream
  'PT_Cal.PT_CH2': '#D7BDE2',  // GSE Low
  'PT_Cal.PT_CH4': '#C0392B',  // Fuel Downstream
  'PT_Cal.PT_CH5': '#5DADE2',  // Ox Upstream
  'PT_Cal.PT_CH6': '#3CB371',  // GN2 Regulated
  'PT_Cal.PT_CH7': '#2471A3',  // Ox Downstream
  'PT_Cal.PT_CH8': '#8E44AD',  // GSE High
  'PT_Cal.PT_CH9': '#32CD32',  // GN2 High
  'PT_Cal.PT_CH10': '#16A085',
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
  // Deterministic fallback for config-driven / unknown entities.
  // Stable across sessions so the same entity keeps the same color.
  let h = 0;
  for (let i = 0; i < entity.length; i++) {
    h = (h * 31 + entity.charCodeAt(i)) % 360;
  }
  return `hsl(${h}, 70%, 60%)`;
}

export const PRESSURE_SENSORS = [
  { label: 'GN2 High', entity: 'PT_Cal.GN2_High', component: 'pressure_psi' as const, color: '#32CD32', nop: 900, meop: 950 },
  { label: 'GN2 Regulated', entity: 'PT_Cal.GN2_Regulated', component: 'pressure_psi' as const, color: '#3CB371', nop: 900, meop: 950 },
  { label: 'Fuel Upstream', entity: 'PT_Cal.Fuel_Upstream', component: 'pressure_psi' as const, color: '#E67E22', nop: 600, meop: 650 },
  { label: 'Fuel Downstream', entity: 'PT_Cal.Fuel_Downstream', component: 'pressure_psi' as const, color: '#C0392B', nop: 600, meop: 650 },
  { label: 'LOX Upstream', entity: 'PT_Cal.Ox_Upstream', component: 'pressure_psi' as const, color: '#5DADE2', nop: 600, meop: 650 },
  { label: 'LOX Downstream', entity: 'PT_Cal.Ox_Downstream', component: 'pressure_psi' as const, color: '#2471A3', nop: 600, meop: 650 },
  { label: 'GSE Low', entity: 'PT_Cal.GSE_Low', component: 'pressure_psi' as const, color: '#D7BDE2', nop: 500, meop: 700 },
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
  let h = 0;
  for (let i = 0; i < entity.length; i++) {
    h = (h * 31 + entity.charCodeAt(i)) % 360;
  }
  return `hsl(${h}, 70%, 60%)`;
}
