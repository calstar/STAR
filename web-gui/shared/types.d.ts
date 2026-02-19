/**
 * Shared TypeScript types for frontend and backend
 */
export declare enum MessageType {
    SUBSCRIBE_SENSOR = "subscribe_sensor",
    UNSUBSCRIBE_SENSOR = "unsubscribe_sensor",
    SEND_COMMAND = "send_command",
    QUERY_HISTORICAL = "query_historical",
    SENSOR_UPDATE = "sensor_update",
    ACTUATOR_UPDATE = "actuator_update",
    STATE_UPDATE = "state_update",
    ERROR = "error",
    CONNECTION_STATUS = "connection_status"
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
    ABORT = 17
}
export declare enum ActuatorId {
    LOX_MAIN = 0,
    FUEL_MAIN = 1,
    LOX_VENT = 2,
    FUEL_VENT = 3,
    LOX_PRESS = 4,
    FUEL_PRESS = 5,
    GSE_LOW_VENT = 6
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
    actuatorId: ActuatorId;
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
    commandType: 'state_transition' | 'actuator' | 'controller_frequency' | 'pwm_actuator';
    data: {
        state?: SystemState;
        actuatorId?: ActuatorId;
        actuatorState?: ActuatorState;
        frequency?: number;
        dutyCycle?: number;
        duration?: number;
    };
}
export interface ConnectionStatus {
    connected: boolean;
    elodinConnected: boolean;
    latency?: number;
    error?: string;
}
//# sourceMappingURL=types.d.ts.map
