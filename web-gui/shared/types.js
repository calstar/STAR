/**
 * Shared TypeScript types for frontend and backend
 */
// WebSocket message types
export var MessageType;
(function (MessageType) {
    // Client → Server
    MessageType["SUBSCRIBE_SENSOR"] = "subscribe_sensor";
    MessageType["UNSUBSCRIBE_SENSOR"] = "unsubscribe_sensor";
    MessageType["SEND_COMMAND"] = "send_command";
    MessageType["QUERY_HISTORICAL"] = "query_historical";
    // Server → Client
    MessageType["SENSOR_UPDATE"] = "sensor_update";
    MessageType["ACTUATOR_UPDATE"] = "actuator_update";
    MessageType["STATE_UPDATE"] = "state_update";
    MessageType["ERROR"] = "error";
    MessageType["CONNECTION_STATUS"] = "connection_status";
})(MessageType || (MessageType = {}));
// Sensor types
export var SensorType;
(function (SensorType) {
    SensorType["PT_CAL"] = "PT_Cal";
    SensorType["PT_RAW"] = "PT";
    SensorType["ACT"] = "ACT";
    SensorType["TC"] = "TC";
    SensorType["RTD"] = "RTD";
    SensorType["LC"] = "LC";
})(SensorType || (SensorType = {}));
// State machine states
export var SystemState;
(function (SystemState) {
    SystemState[SystemState["DEBUG"] = 0] = "DEBUG";
    SystemState[SystemState["IDLE"] = 1] = "IDLE";
    SystemState[SystemState["ARMED"] = 2] = "ARMED";
    SystemState[SystemState["FUEL_FILL"] = 3] = "FUEL_FILL";
    SystemState[SystemState["OX_FILL"] = 4] = "OX_FILL";
    SystemState[SystemState["GN2_LOW_PRESS"] = 5] = "GN2_LOW_PRESS";
    SystemState[SystemState["GN2_VENT"] = 6] = "GN2_VENT";
    SystemState[SystemState["FUEL_PRESS"] = 7] = "FUEL_PRESS";
    SystemState[SystemState["FUEL_VENT"] = 8] = "FUEL_VENT";
    SystemState[SystemState["OX_PRESS"] = 9] = "OX_PRESS";
    SystemState[SystemState["OX_VENT"] = 10] = "OX_VENT";
    SystemState[SystemState["GN2_HIGH_PRESS"] = 11] = "GN2_HIGH_PRESS";
    SystemState[SystemState["GN2_HIGH_VENT"] = 12] = "GN2_HIGH_VENT";
    SystemState[SystemState["VENT"] = 13] = "VENT";
    SystemState[SystemState["CALIBRATE"] = 14] = "CALIBRATE";
    SystemState[SystemState["READY"] = 15] = "READY";
    SystemState[SystemState["FIRE"] = 16] = "FIRE";
    SystemState[SystemState["ABORT"] = 17] = "ABORT";
})(SystemState || (SystemState = {}));
// Actuator IDs
export var ActuatorId;
(function (ActuatorId) {
    ActuatorId[ActuatorId["LOX_MAIN"] = 0] = "LOX_MAIN";
    ActuatorId[ActuatorId["FUEL_MAIN"] = 1] = "FUEL_MAIN";
    ActuatorId[ActuatorId["LOX_VENT"] = 2] = "LOX_VENT";
    ActuatorId[ActuatorId["FUEL_VENT"] = 3] = "FUEL_VENT";
    ActuatorId[ActuatorId["LOX_PRESS"] = 4] = "LOX_PRESS";
    ActuatorId[ActuatorId["FUEL_PRESS"] = 5] = "FUEL_PRESS";
    ActuatorId[ActuatorId["GSE_LOW_VENT"] = 6] = "GSE_LOW_VENT";
})(ActuatorId || (ActuatorId = {}));
// Actuator states
export var ActuatorState;
(function (ActuatorState) {
    ActuatorState[ActuatorState["CLOSED"] = 0] = "CLOSED";
    ActuatorState[ActuatorState["OPEN"] = 1] = "OPEN";
    ActuatorState[ActuatorState["UNKNOWN"] = 2] = "UNKNOWN";
})(ActuatorState || (ActuatorState = {}));
//# sourceMappingURL=types.js.map
