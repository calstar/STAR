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
  PRESS_STANDBY = 20,  // Press Standby state (separate from GN2_LOW_PRESS)
  // Legacy alias for backwards compatibility
  ABORT = 19, // Maps to EMERGENCY_ABORT
}

// Actuator IDs — now string-based, driven by config.toml actuator_roles.
// No enum: all references use the config role name (e.g. "LOX Main").

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
  /** Config role name (e.g. "LOX Main") — primary identifier */
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
    | 'controller_command'
    | 'clear_abort'
    | 'debug_mode';
  data: {
    state?: SystemState;
    /** Config-driven: actuator role name from config.toml actuator_roles (e.g. "LOX Main") */
    actuatorName?: string;
    actuatorState?: ActuatorState;
    frequency?: number; // Controller frequency in Hz
    dutyCycle?: number; // PWM duty cycle 0-1
    duration?: number; // Duration in ms
    command_type?: 'THRUST_DESIRED' | 'ALTITUDE_GOAL' | 'PRESSURE_TARGET'; // Controller command type
    thrust_desired?: number; // Thrust desired [N]
    altitude_goal?: number; // Altitude goal [m]
    pressure_fuel_target?: number; // Target fuel pressure [PSI or Pa]
    pressure_ox_target?: number;   // Target ox pressure [PSI or Pa]
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

/** Confidence level derived from RLS update count + drift state */
export type CalibrationConfidence = 'MAXIMUM' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNCALIBRATED';

/** Per-channel status broadcast from the Phase 2 engine */
export interface CalibrationChannelStatus {
  sensorId: number;   // 1-based PT channel
  updateCount: number;   // total readings processed (monitoring + RLS)
  rlsUpdateCount: number;   // ground-truth RLS updates only
  lastUpdate: number;   // epoch ms
  driftDetected: boolean;
  meanResidual: number;   // mean |error| over last 100 samples (PSI)
  glrStat: number;   // GLR statistic (>threshold = drift)
  confidence: CalibrationConfidence;
  coeffs: { A: number; B: number; C: number; D: number };
  phase2Active: boolean;
  covarianceTrace: number;   // sum of P diagonal — proxy for uncertainty
}

/** Full calibration status payload — one entry per initialized channel */
export interface CalibrationStatusPayload {
  channels: CalibrationChannelStatus[];
  phase2Enabled: boolean;
  timestamp: number;
}

/** Commands the frontend sends to drive the calibration engine */
export type CalibrationCommandType =
  | 'capture_reference'   // store current ADC at a known PSI reference
  | 'fit_channel'         // force polynomial re-fit for a channel
  | 'reset_channel'       // clear all points and restart
  | 'enable_phase2'
  | 'disable_phase2'
  | 'zero_all'            // zero-point init: all PTs set current ADC → 0 PSI
  | 'save_coefficients'   // persist current coefficients to disk
  | 'clear_calibration';  // clear all state and start from scratch

export interface CalibrationCommand {
  commandType: CalibrationCommandType;
  sensorId?: number;
  boardId?: number;
  referencePressure?: number;  // PSI ground-truth for capture_reference
}

// ── Board / heartbeat status ───────────────────────────────────────────────────

/** Aggregated status for a single hardware board (PT, ACTUATOR, RTD, LC, TC, etc.). */
export interface BoardStatus {
  /** Board type label, e.g. "PT", "ACTUATOR", "RTD", "LC", "TC". */
  type: string;
  /** Human-friendly board number (from config), distinct from numeric ID. */
  boardNumber: number | null;
  /** Unique numeric ID for the PCB; also the last octet of its IP. */
  id: number;
  /** Derived IP address, typically 192.168.2.[id]. */
  ip: string;
  /** True if this board was defined in config.toml; false if discovered at runtime. */
  expected: boolean;
  /** Whether we consider the board currently connected (recent heartbeat). */
  connected: boolean;
  /** Timestamp of the last heartbeat in epoch milliseconds, or null if none yet. */
  lastHeartbeatMs: number | null;
  /** Estimated heartbeat frequency in Hz, or null if not enough data. */
  frequencyHz: number | null;
  /** Raw numeric board state from heartbeat (protocol-defined). */
  boardState: number | null;
  /** Raw numeric engine state from heartbeat (protocol-defined). */
  engineState: number | null;
  /** True if a SENSOR_CONFIG has been successfully sent for this board. */
  configured?: boolean;
  /** Optional error message if configuration failed. */
  configError?: string;
  /** True if this sense board is marked as necessary for abort. */
  necessaryForAbort?: boolean;
  /** True if this board is the designated survivor actuator controller. */
  designatedSurvivor?: boolean;
  /** 0 = Internal 2.5V, 1 = VDD ratiometric, 2 = 5V absolute */
  voltageReference?: number;
}

export interface BoardStatusPayload {
  boards: BoardStatus[];
}

// ── Engine state helpers ─────────────────────────────────────────────────────

/**
 * Map a numeric engine_state code (from SystemState / wire) to a human-readable
 * label. Falls back to 'UNKNOWN' if the code is not recognized.
 */
export function engineStateCodeToLabel(code: number | null | undefined): string {
  if (code === null || code === undefined) return 'UNKNOWN';
  // TypeScript enums are bidirectional; indexing with the numeric value
  // returns the string name when it exists.
  const name = (SystemState as any)[code];
  if (typeof name === 'string') {
    return name.replace(/_/g, ' ');
  }
  return 'UNKNOWN';
}
