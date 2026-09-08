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
    MessageType["CALIBRATION_COMMAND"] = "calibration_command";
    MessageType["RESEND_CONFIG"] = "resend_config";
    // Server → Client
    MessageType["SENSOR_UPDATE"] = "sensor_update";
    MessageType["ACTUATOR_UPDATE"] = "actuator_update";
    MessageType["STATE_UPDATE"] = "state_update";
    MessageType["ERROR"] = "error";
    MessageType["CONNECTION_STATUS"] = "connection_status";
    MessageType["CALIBRATION_STATUS"] = "calibration_status";
    MessageType["CONTROLLER_UPDATE"] = "controller_update";
    MessageType["MISSION_START_TIME"] = "mission_start_time";
    MessageType["ACTUATOR_EXPECTED_POSITIONS_UPDATE"] = "actuator_expected_positions_update";
    MessageType["HISTORICAL_DATA"] = "historical_data";
    MessageType["BOARD_STATUS_UPDATE"] = "board_status_update";
    MessageType["NOTIFICATION"] = "notification";
    MessageType["CONFIG_UPDATED"] = "config_updated";
    MessageType["COUNTDOWN_TARGET_UPDATE"] = "countdown_target_update";
    MessageType["SESSION_UPDATE"] = "session_update";
    MessageType["SESSION_START_BLOCKED"] = "session_start_blocked";
    MessageType["BOARD_LOG"] = "board_log";
    // Engine-control authorization (DAQ operator gate)
    MessageType["CONTROL_STATUS"] = "control_status";
    MessageType["CONTROL_UNLOCK"] = "control_unlock";
    MessageType["CONTROL_UNLOCK_RESULT"] = "control_unlock_result";
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
    SystemState[SystemState["ENGINE_ABORT"] = 17] = "ENGINE_ABORT";
    SystemState[SystemState["GSE_ABORT"] = 18] = "GSE_ABORT";
    SystemState[SystemState["EMERGENCY_ABORT"] = 19] = "EMERGENCY_ABORT";
    SystemState[SystemState["PRESS_STANDBY"] = 20] = "PRESS_STANDBY";
    // Legacy alias for backwards compatibility
    SystemState[SystemState["ABORT"] = 19] = "ABORT";
})(SystemState || (SystemState = {}));
// Actuator IDs — now string-based, driven by config.toml actuator_roles.
// No enum: all references use the config role name (e.g. "LOX Main").
// Actuator states
export var ActuatorState;
(function (ActuatorState) {
    ActuatorState[ActuatorState["CLOSED"] = 0] = "CLOSED";
    ActuatorState[ActuatorState["OPEN"] = 1] = "OPEN";
    ActuatorState[ActuatorState["UNKNOWN"] = 2] = "UNKNOWN";
})(ActuatorState || (ActuatorState = {}));
export function isNotificationOngoing(p) {
    return 'key' in p && 'ongoing' in p;
}
// ── Engine state helpers ─────────────────────────────────────────────────────
/**
 * Map a numeric engine_state code (from SystemState / wire) to a human-readable
 * label. Falls back to 'UNKNOWN' if the code is not recognized.
 */
export function engineStateCodeToLabel(code) {
    if (code === null || code === undefined)
        return 'UNKNOWN';
    // TypeScript enums are bidirectional; indexing with the numeric value
    // returns the string name when it exists.
    const name = SystemState[code];
    if (typeof name === 'string') {
        return name.replace(/_/g, ' ');
    }
    return 'UNKNOWN';
}
// ── Controller PWM actuator assignment ───────────────────────────────────────
/** The two controller_service PWM outputs, as they appear in the 4th element of an
 *  [actuator_roles] entry. Absent from an entry means the sequencer owns that actuator. */
export const PWM_ASSIGNMENTS = ['pwm_fuel', 'pwm_ox'];
/** Which actuator serves each PWM output, from `[actuator_roles]`. */
export function pwmAssignmentMap(config) {
    const out = { pwm_fuel: [], pwm_ox: [] };
    const roles = config?.actuator_roles;
    if (!roles || typeof roles !== 'object')
        return out;
    for (const [name, value] of Object.entries(roles)) {
        const assignment = Array.isArray(value) && typeof value[3] === 'string' ? value[3].trim() : '';
        if (assignment && out[assignment])
            out[assignment].push(name);
    }
    return out;
}
/**
 * Whether the controller's PWM outputs are assigned exactly once each.
 *
 * An [actuator_roles] entry's optional 4th element ("pwm_fuel" / "pwm_ox") is the single statement
 * of which hardware controller_service drives. The same fact makes the sequencer stop commanding
 * that actuator during a burn, so exactly one writer drives it — which is why a duplicate or a
 * missing assignment is worth blocking rather than warning about. The C++ side enforces the same
 * rule in PWMTargets.hpp and refuses to open the PWM fire gate without it.
 *
 * Both outputs unassigned is allowed and means "this rig does not use the PWM controller" — the
 * digital-twin profile is exactly that. Assigning one but not the other is not.
 *
 * Returns one human-readable problem per bad output; empty means valid.
 */
export function validateControllerPwmActuators(config) {
    const roles = config?.actuator_roles;
    // No [actuator_roles] at all is a different (and much louder) misconfiguration; don't pile on.
    if (!roles || typeof roles !== 'object')
        return [];
    const assigned = pwmAssignmentMap(config);
    if (assigned.pwm_fuel.length === 0 && assigned.pwm_ox.length === 0)
        return [];
    const issues = [];
    for (const [key, label] of [['pwm_fuel', 'fuel'], ['pwm_ox', 'ox']]) {
        const names = assigned[key];
        if (names.length === 0) {
            issues.push(`No actuator is assigned "${key}" — the controller has no ${label} PWM output. Assign one, or clear the other assignment if this rig does not use the PWM controller.`);
        }
        else if (names.length > 1) {
            issues.push(`${names.length} actuators are assigned "${key}" (${names.join(', ')}) — exactly one must be.`);
        }
    }
    return issues;
}
//# sourceMappingURL=types.js.map