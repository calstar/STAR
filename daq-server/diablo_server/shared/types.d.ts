/**
 * Shared TypeScript types for frontend and backend
 */
export declare enum MessageType {
    SUBSCRIBE_SENSOR = "subscribe_sensor",
    UNSUBSCRIBE_SENSOR = "unsubscribe_sensor",
    SEND_COMMAND = "send_command",
    QUERY_HISTORICAL = "query_historical",
    CALIBRATION_COMMAND = "calibration_command",
    SENSOR_UPDATE = "sensor_update",
    ACTUATOR_UPDATE = "actuator_update",
    STATE_UPDATE = "state_update",
    ERROR = "error",
    CONNECTION_STATUS = "connection_status",
    CALIBRATION_STATUS = "calibration_status",
    CONTROLLER_UPDATE = "controller_update",
    MISSION_START_TIME = "mission_start_time",
    ACTUATOR_EXPECTED_POSITIONS_UPDATE = "actuator_expected_positions_update"
}
export declare enum SensorType {
    PT_CAL = "PT_Cal",
    PT_RAW = "PT",
    ACT = "ACT",
    TC = "TC",
    RTD = "RTD",
    LC = "LC"
}
export declare enum SystemState {
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
    ABORT = 19
}
export declare enum ActuatorId {
    LOX_MAIN = 0,
    FUEL_MAIN = 1,
    LOX_VENT = 2,
    FUEL_VENT = 3,
    LOX_PRESS = 4,
    FUEL_PRESS = 5,
    GSE_LOW_VENT = 6,
    FUEL_FILL_VENT = 7,
    FUEL_FILL_PRESS = 8,
    LOX_FILL = 9,
    LOX_DUMP = 10,
    GSE_HIGH_PRESS_VENT = 11,
    GSE_LOX_FILL_VENT = 12,
    GSE_HIGH_PRESS_CONTROL = 13,
    GSE_MED_PRESS_CONTROL = 14
}
export declare enum ActuatorState {
    CLOSED = 0,
    OPEN = 1,
    UNKNOWN = 2
}
export interface WSMessage {
    type: MessageType;
    timestamp: number;
    payload: unknown;
}
export interface SensorUpdate {
    entity: string;
    component: string;
    value: number;
    timestamp: number;
}
export interface ActuatorUpdate {
    actuatorId?: number;
    name: string;
    state: ActuatorState;
    rawAdcCounts: number;
    timestamp: number;
}
export interface StateUpdate {
    currentState: SystemState;
    stateName: string;
    timestamp: number;
}
export interface CommandPayload {
    commandType: 'state_transition' | 'actuator' | 'controller_frequency' | 'pwm_actuator' | 'controller_command';
    data: {
        state?: SystemState;
        actuatorId?: ActuatorId;
        actuatorState?: ActuatorState;
        frequency?: number;
        dutyCycle?: number;
        duration?: number;
        command_type?: 'THRUST_DESIRED' | 'ALTITUDE_GOAL';
        thrust_desired?: number;
        altitude_goal?: number;
    };
}
export interface ConnectionStatus {
    connected: boolean;
    elodinConnected: boolean;
    latency?: number;
    error?: string;
}
export interface MissionStartTime {
    missionStartTime: number;
}
/** Confidence level derived from RLS update count + drift state */
export type CalibrationConfidence = 'MAXIMUM' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNCALIBRATED';
/** Per-channel status broadcast from the Phase 2 engine */
export interface CalibrationChannelStatus {
    sensorId: number;
    updateCount: number;
    rlsUpdateCount: number;
    lastUpdate: number;
    driftDetected: boolean;
    meanResidual: number;
    glrStat: number;
    confidence: CalibrationConfidence;
    coeffs: {
        A: number;
        B: number;
        C: number;
        D: number;
    };
    phase2Active: boolean;
    covarianceTrace: number;
}
/** Full calibration status payload — one entry per initialized channel */
export interface CalibrationStatusPayload {
    channels: CalibrationChannelStatus[];
    phase2Enabled: boolean;
    timestamp: number;
}
/** Commands the frontend sends to drive the calibration engine */
export type CalibrationCommandType = 'capture_reference' | 'fit_channel' | 'reset_channel' | 'enable_phase2' | 'disable_phase2' | 'zero_all' | 'save_coefficients' | 'clear_calibration';
export interface CalibrationCommand {
    commandType: CalibrationCommandType;
    sensorId?: number;
    referencePressure?: number;
}
//# sourceMappingURL=types.d.ts.map
