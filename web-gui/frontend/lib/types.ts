/**
 * Shared TypeScript types for frontend and backend
 */

// WebSocket message types
export enum MessageType {
  // Client → Server
  SUBSCRIBE_SENSOR = 'subscribe_sensor',
  UNSUBSCRIBE_SENSOR = 'unsubscribe_sensor',
  SEND_COMMAND = 'send_command',
  QUERY_HISTORICAL = 'query_historical',
  CALIBRATION_COMMAND = 'calibration_command',

  // Server → Client
  SENSOR_UPDATE = 'sensor_update',
  ACTUATOR_UPDATE = 'actuator_update',
  STATE_UPDATE = 'state_update',
  ERROR = 'error',
  CONNECTION_STATUS = 'connection_status',
  CALIBRATION_STATUS = 'calibration_status',
  CONTROLLER_UPDATE = 'controller_update',
  MISSION_START_TIME = 'mission_start_time',
  ACTUATOR_EXPECTED_POSITIONS_UPDATE = 'actuator_expected_positions_update',
  HISTORICAL_DATA = 'historical_data',
  BOARD_STATUS_UPDATE = 'board_status_update',
}

// Sensor types
export enum SensorType {
  PT_CAL = 'PT_Cal',
  PT_RAW = 'PT',
  ACT = 'ACT',
  TC = 'TC',
  RTD = 'RTD',
  LC = 'LC',
}

// State machine states
export enum SystemState {
  DEBUG = 0,
  IDLE = 1,
  ARMED = 2,
  FUEL_FILL = 3,
  OX_FILL = 4,
  GN2_LOW_PRESS = 5,
  GN2_VENT = 6,
  FUEL_PRESS = 7,
  FUEL_VENT = 8,
  OX_PRESS = 9,
  OX_VENT = 10,
  GN2_HIGH_PRESS = 11,
  GN2_HIGH_VENT = 12,
  VENT = 13,
  CALIBRATE = 14,
  READY = 15,
  FIRE = 16,
  ENGINE_ABORT = 17,
  GSE_ABORT = 18,
  EMERGENCY_ABORT = 19,
  PRESS_STANDBY = 20,
  // Legacy alias for backwards compatibility
  ABORT = 19, // Maps to EMERGENCY_ABORT
}

// Actuator IDs
export enum ActuatorId {
  LOX_MAIN = 0,
  FUEL_MAIN = 1,
  LOX_VENT = 2,
  FUEL_VENT = 3,
  LOX_PRESS = 4,
  FUEL_PRESS = 5,
  GSE_LOW_VENT = 6,
  // Extended actuators (non-state-machine, but controllable in DEBUG)
  FUEL_FILL_VENT = 7,
  FUEL_FILL_PRESS = 8,
  LOX_FILL = 9,
  LOX_DUMP = 10,
  GSE_HIGH_PRESS_VENT = 11,
  GSE_LOX_FILL_VENT = 12,
  GSE_HIGH_PRESS_CONTROL = 13,
  GSE_MED_PRESS_CONTROL = 14,
  TEST_ACTUATOR_2 = 15,
}

// Actuator states
export enum ActuatorState {
  CLOSED = 0,
  OPEN = 1,
  UNKNOWN = 2,
}

// WebSocket message structure
export interface WSMessage {
  type: MessageType;
  timestamp: number;
  payload: unknown;
}

// Sensor update payload
export interface SensorUpdate {
  entity: string; // e.g., "PT_Cal.GN2_Regulated"
  component: string; // e.g., "pressure_psi"
  value: number;
  timestamp: number;
}

// Actuator update payload
export interface ActuatorUpdate {
  actuatorId: ActuatorId;
  name: string;
  state: ActuatorState;
  rawAdcCounts: number;
  timestamp: number;
}

// State machine update payload
export interface StateUpdate {
  currentState: SystemState;
  stateName: string;
  timestamp: number;
  debugMode?: boolean; // Debug mode status
}

// Command payload
export interface CommandPayload {
  commandType:
    | 'state_transition'
    | 'actuator'
    | 'controller_frequency'
    | 'pwm_actuator'
    | 'clear_abort'
    | 'debug_mode';
  data: {
    state?: SystemState;
    actuatorId?: ActuatorId;
    /** Config-driven: command by actuator role name (config.toml actuator_roles) */
    actuatorName?: string;
    actuatorState?: ActuatorState;
    frequency?: number; // Controller frequency in Hz
    dutyCycle?: number; // PWM duty cycle 0-1
    duration?: number; // Duration in ms
    debugMode?: boolean; // Debug mode toggle
  };
}

// Connection status
export interface ConnectionStatus {
  connected: boolean;
  elodinConnected: boolean;
  latency?: number;
  error?: string;
}

// Mission start time (T+0 from first packet)
export interface MissionStartTime {
  missionStartTime: number; // Unix timestamp in milliseconds
}

// ── Calibration types ─────────────────────────────────────────────────────────

export type CalibrationConfidence = 'MAXIMUM' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNCALIBRATED';

export interface CalibrationChannelStatus {
  sensorId: number;
  updateCount: number;   // total readings processed (monitoring + RLS)
  rlsUpdateCount: number;   // ground-truth RLS updates only
  lastUpdate: number;
  driftDetected: boolean;
  meanResidual: number;
  glrStat: number;
  confidence: CalibrationConfidence;
  coeffs: { A: number; B: number; C: number; D: number };
  phase2Active: boolean;
  covarianceTrace: number;   // sum of P diagonal — proxy for uncertainty
}

export interface CalibrationStatusPayload {
  channels: CalibrationChannelStatus[];
  phase2Enabled: boolean;
  timestamp: number;
}

export type CalibrationCommandType =
  | 'capture_reference'
  | 'fit_channel'
  | 'reset_channel'
  | 'enable_phase2'
  | 'disable_phase2'
  | 'zero_all'
  | 'save_coefficients'
  | 'clear_calibration';

export interface CalibrationCommand {
  commandType: CalibrationCommandType;
  sensorId?: number;
  boardId?: number;
  referencePressure?: number;
}
// ── Board / heartbeat status ───────────────────────────────────────────────────

export interface BoardStatus {
  type: string;
  boardNumber: number | null;
  id: number;
  ip: string;
  expected: boolean;
  connected: boolean;
  lastHeartbeatMs: number | null;
  frequencyHz: number | null;
  boardState: number | null;
  engineState: number | null;
  configured?: boolean;
  configError?: string;
  necessaryForAbort?: boolean;
  designatedSurvivor?: boolean;
}

export interface BoardStatusPayload {
  boards: BoardStatus[];
}

export function engineStateCodeToLabel(code: number | null | undefined): string {
  if (code === null || code === undefined) return 'UNKNOWN';
  const name = (SystemState as any)[code];
  if (typeof name === 'string') return name.replace(/_/g, ' ');
  return 'UNKNOWN';
}

