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

  // Server → Client
  SENSOR_UPDATE = 'sensor_update',
  ACTUATOR_UPDATE = 'actuator_update',
  STATE_UPDATE = 'state_update',
  ERROR = 'error',
  CONNECTION_STATUS = 'connection_status',
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
  ABORT = 17,
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
}

// Command payload
export interface CommandPayload {
  commandType: 'state_transition' | 'actuator' | 'controller_frequency' | 'pwm_actuator';
  data: {
    state?: SystemState;
    actuatorId?: ActuatorId;
    actuatorState?: ActuatorState;
    frequency?: number; // Controller frequency in Hz
    dutyCycle?: number; // PWM duty cycle 0-1
    duration?: number; // Duration in ms
  };
}

// Connection status
export interface ConnectionStatus {
  connected: boolean;
  elodinConnected: boolean;
  latency?: number;
  error?: string;
}
