/**
 * Shared TypeScript types for frontend and backend
 */
export declare enum MessageType {
    SUBSCRIBE_SENSOR = "subscribe_sensor",
    UNSUBSCRIBE_SENSOR = "unsubscribe_sensor",
    SEND_COMMAND = "send_command",
    QUERY_HISTORICAL = "query_historical",
    CALIBRATION_COMMAND = "calibration_command",
    RESEND_CONFIG = "resend_config",
    SENSOR_UPDATE = "sensor_update",
    ACTUATOR_UPDATE = "actuator_update",
    STATE_UPDATE = "state_update",
    ERROR = "error",
    CONNECTION_STATUS = "connection_status",
    CALIBRATION_STATUS = "calibration_status",
    CONTROLLER_UPDATE = "controller_update",
    MISSION_START_TIME = "mission_start_time",
    ACTUATOR_EXPECTED_POSITIONS_UPDATE = "actuator_expected_positions_update",
    HISTORICAL_DATA = "historical_data",
    BOARD_STATUS_UPDATE = "board_status_update",
    NOTIFICATION = "notification",
    CONFIG_UPDATED = "config_updated",
    COUNTDOWN_TARGET_UPDATE = "countdown_target_update",
    SESSION_UPDATE = "session_update",
    BOARD_LOG = "board_log",// Server → Client: { boardId, ts, lines, truncated }
    CONTROL_STATUS = "control_status",// Server → Client: { operator, email }
    CONTROL_UNLOCK = "control_unlock",// Client → Server: {} (arm control; identity-gated)
    CONTROL_UNLOCK_RESULT = "control_unlock_result"
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
    PRESS_STANDBY = 20,// Press Standby state (separate from GN2_LOW_PRESS)
    ABORT = 19
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
    /** Sample time, epoch ms (bridge receipt time forwarded from Elodin). */
    timestamp: number;
}
export interface QueryHistoricalRequest {
    /** Restrict to these entity.component keys. */
    keys?: string[];
    /** Only points strictly newer than this epoch-ms timestamp. */
    sinceMs?: number;
}
export interface HistoricalSeries {
    time: number[];
    values: number[];
}
export type HistoricalDataPayload = Record<string, HistoricalSeries>;
export interface ActuatorUpdate {
    /** Optional numeric id for keyed maps (tests / legacy payloads). */
    actuatorId?: number;
    /** Config role name (e.g. "LOX Main") — primary identifier */
    name: string;
    state: ActuatorState;
    rawAdcCounts: number;
    timestamp: number;
}
export interface StateUpdate {
    currentState: SystemState;
    stateName: string;
    timestamp: number;
    debugMode?: boolean;
}
export interface CommandPayload {
    commandType: 'state_transition' | 'actuator' | 'controller_frequency' | 'pwm_actuator' | 'controller_command' | 'debug_mode' | 'extend_fire' | 'set_countdown_target' | 'session_start' | 'session_stop' | 'session_extend';
    data: {
        state?: SystemState;
        /** Config-driven: actuator role name from config.toml actuator_roles (e.g. "LOX Main") */
        actuatorName?: string;
        actuatorState?: ActuatorState;
        frequency?: number;
        dutyCycle?: number;
        duration?: number;
        command_type?: 'THRUST_DESIRED' | 'ALTITUDE_GOAL' | 'PRESSURE_TARGET';
        thrust_desired?: number;
        altitude_goal?: number;
        pressure_fuel_target?: number;
        pressure_ox_target?: number;
        debugMode?: boolean;
        /** Unix timestamp in milliseconds. null clears/pauses the countdown. */
        targetTimeMs?: number | null;
        /** session_start: Save (true) keeps the run's DB; Discard (false) deletes it on stop. */
        keepData?: boolean;
        /** session_start: auto-stop timeout in milliseconds. */
        durationMs?: number;
        /** session_start: run against the board simulator (true) instead of live hardware. */
        simulated?: boolean;
        /** session_extend: milliseconds to push the auto-stop deadline out by. */
        addMs?: number;
    };
}
/**
 * DAQ run session — a run started/stopped from the session screen with a
 * backend-owned auto-stop timeout. `enabled` is false when SESSION_SERVICE_MODE
 * is off (the launch-site laptop): the UI hides the button and nothing auto-stops.
 */
export interface SessionStatus {
    enabled: boolean;
    active: boolean;
    dbDir: string | null;
    keepData: boolean;
    deadlineMs: number | null;
    remainingMs: number | null;
    freeDiskBytes: number | null;
    /** True when the active run is fed by the board simulator instead of hardware. */
    simulated: boolean;
}
export interface ConnectionStatus {
    connected: boolean;
    elodinConnected: boolean;
    connId?: string;
    latency?: number;
    error?: string;
    /** True when incoming data is synthetic (board simulator running). */
    simulated?: boolean;
    /** Backend-authoritative: an Elodin row was ingested within the freshness window,
     *  i.e. the pipeline is actually delivering data right now (not just "run active"). */
    dataFresh?: boolean;
}
export interface MissionStartTime {
    missionStartTime: number;
}
export interface CountdownTargetUpdate {
    /** Unix timestamp in milliseconds; null = countdown not set */
    targetTimeMs: number | null;
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
    /** Absolute path of the calibration file that was loaded at startup, or null if none. */
    calibrationFilePath?: string | null;
}
/** Commands the frontend sends to drive the calibration engine */
export type CalibrationCommandType = 'capture_reference' | 'fit_channel' | 'reset_channel' | 'enable_phase2' | 'disable_phase2' | 'zero_all' | 'save_coefficients' | 'clear_calibration' | 'capture_cubic_point' | 'clear_cubic_channel' | 'capture_point' | 'new_calibration';
export interface CalibrationCommand {
    commandType: CalibrationCommandType;
    sensorId?: number;
    boardId?: number;
    referencePressure?: number;
}
/** One operator-captured calibration point for a channel's cubic fit. */
export interface CubicCalibrationPoint {
    adc: number;
    psi: number;
    t: number;
}
/**
 * Per-sensor cubic calibration record produced by the calibration service. The frontend renders the
 * captured `points` as a scatter and overlays the curve by evaluating `polyCoeffs` over
 * `((adc - adcNormMin)/adcNormScale)^i` — no fitting in the browser.
 */
export interface CubicCalibrationChannel {
    boardId: number;
    connector: number;
    logicalCh: number;
    role: string;
    active_model: 'cubic' | 'robust' | 'physics';
    numPoints: number;
    status: 'PENDING' | 'OK' | 'ERROR';
    last_error: string;
    rmse: number;
    degree: number;
    updatedAt: number;
    coeffs: {
        A: number;
        B: number;
        C: number;
        D: number;
    };
    polyCoeffs: number[];
    adcNormMin: number;
    adcNormScale: number;
    points: CubicCalibrationPoint[];
    fitCurve?: {
        adc: number;
        psi: number;
    }[];
}
/** Body of GET /api/cubic_calibration: the service's cubic_calibration.json, keyed by uid. */
export interface CubicCalibrationPayload {
    cubic_state?: Record<string, CubicCalibrationChannel>;
    [key: string]: unknown;
}
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
    /** True when connected and board state is Setup or Active; false when in Abort/AbortDone or no heartbeat. */
    operational?: boolean;
    /** Timestamp of the last heartbeat in epoch milliseconds, or null if none yet. */
    lastHeartbeatMs: number | null;
    /** Estimated heartbeat frequency in Hz, or null if not enough data. */
    frequencyHz?: number | null;
    /** Raw numeric board state from heartbeat (protocol-defined). */
    boardState: number | null;
    /** Raw numeric engine state from heartbeat (protocol-defined). */
    engineState: number | null;
    /** True if a SENSOR_CONFIG has been successfully sent for this board. */
    configured?: boolean;
    /** Epoch ms when config was last sent successfully, for display. */
    configLastSentAt?: number;
    /** Optional error message if configuration failed. */
    configError?: string;
    /** True if this sense board is marked as necessary for abort. */
    necessaryForAbort?: boolean;
    /** True if this board is the designated survivor actuator controller. */
    designatedSurvivor?: boolean;
    /** 0 = Internal 2.5V, 1 = VDD ratiometric, 2 = 5V absolute */
    voltageReference?: number;
    /** History of recent heartbeat timestamps for frequency calculation. */
    heartbeatTimes?: number[];
}
export interface BoardStatusPayload {
    boards: BoardStatus[];
}
/** One cached board log line, stamped with server arrival time. */
export interface BoardLogLine {
    boardId: number;
    ts: number;
    line: string;
}
/** Running per-board log counters (cumulative since backend start). */
export interface BoardLogTotals {
    received: number;
    truncated: number;
}
/** MessageType.BOARD_LOG payload: one packet's worth of newline-split lines. */
export interface BoardLogPayload {
    boardId: number;
    ts: number;
    lines: string[];
    truncated: boolean;
    totals: BoardLogTotals;
}
export type NotificationCategory = 'info' | 'warning' | 'error';
/** Ongoing notification (keyed); when ongoing turns false, frontend keeps entry but no longer "current". */
export interface NotificationPayloadOngoing {
    key: string;
    category: NotificationCategory;
    message: string;
    timestampMs: number;
    ongoing: boolean;
}
/** One-shot notification (append-only, no key). */
export interface NotificationPayloadOneShot {
    category: NotificationCategory;
    message: string;
    timestampMs: number;
}
export type NotificationPayload = NotificationPayloadOngoing | NotificationPayloadOneShot;
export declare function isNotificationOngoing(p: NotificationPayload): p is NotificationPayloadOngoing;
/**
 * Map a numeric engine_state code (from SystemState / wire) to a human-readable
 * label. Falls back to 'UNKNOWN' if the code is not recognized.
 */
export declare function engineStateCodeToLabel(code: number | null | undefined): string;
//# sourceMappingURL=types.d.ts.map