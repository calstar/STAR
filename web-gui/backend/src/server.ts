/**
 * WebSocket Server for Sensor System GUI
 * Bridges Elodin DB to WebSocket clients with <30ms latency
 *
 * This is the orchestrator — heavy logic lives in extracted modules:
 *   server-types.ts       — shared types, interfaces, constants
 *   sensor-config.ts      — sensor role loading, HP PT config, ADC→PSI conversion
 *   actuator-control.ts   — UDP commands, board mapping, NC/NO, continuous commands
 *   controller-loop.ts    — FIRE-state controller / duty sweep
 *   calibration-handler.ts — zero_all, capture_reference, save/clear coefficients
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ElodinClient, ElodinPacketType } from './elodin-client.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { DAQDirectClient, BoardHeartbeatEvent } from './daq-direct-client.js';
import { ElodinQueryClient } from './elodin-query.js';
import { parseElodinPacket } from './elodin-protocol.js';
import { registerVTables } from './elodin-vtable.js';
import { registerControllerVTables } from './elodin-vtable-controller.js';
import { subscribeWithStream } from './elodin-stream.js';
import { ElodinRelayClient } from './elodin-relay-client.js';

import { ElodinPublisherBatched } from './elodin-publisher-batched.js';
import { publishControllerActuation, publishControllerDiagnostics } from './controller-elodin-publisher.js';
import { getStateTransitions, isTransitionAllowed } from './routes/state-transitions.js';
import { getStateActuatorMap, StateActuatorMap, CSV_ACTUATOR_TO_ENTITY, getActuatorChannel } from './routes/state-actuators.js';
import { startAPIServer, type DebugInfo } from './api-server.js';
import { loadPTCalibration, calculatePressure, inversePressureToAdc, CalibrationCoefficients, EnvironmentalState } from './calibration.js';
import { Phase2CalibrationEngine } from './calibration-phase2.js';
import { CalibrationSidecarClient } from './calibration-sidecar.js';
import { DataLogger } from './data-logger.js';
import { readConfig, getConfigPath } from './routes/config.js';
import { ControllerClient, mapSensorDataToMeasurement, ControllerCommand, ControllerDiagnostics } from './controller-client.js';
import { MessageLogger } from './message-logger.js';
import { DemoModeGenerator } from './demo-mode.js';
import {
  MessageType,
  SensorUpdate,
  ActuatorUpdate,
  StateUpdate,
  CommandPayload,
  ConnectionStatus,
  SystemState,
  ActuatorState,
  BoardStatus,
} from './shared-types.js';

// ── Extracted modules ──────────────────────────────────────────────────────────
import { Client, HpPtBoardConfig, WS_PORT, WS_HOST, ELODIN_HOST, ELODIN_PORT, ACTUATOR_CHANNEL_BY_NAME } from './server-types.js';
import { loadSensorRoleMap, loadHpPtConfig, loadActuatorChannelToEntityMap, convertHpPtToPressure } from './sensor-config.js';
import {
  loadActuatorBoardMap,
  getActuatorBoardInfo,
  getActuatorType,
  getActuatorTypeByChannel,
  getActuatorNameByChannel,
  guiStateToHardwareState,
  sendActuatorCommandUDP,
  sendPWMActuatorCommandUDP,
  applyActuatorsForState,
  startContinuousActuatorCommands,
  stopContinuousActuatorCommands,
  sendActuatorExpectedPositionsToClient,
  broadcastActuatorExpectedPositions,
} from './actuator-control.js';
import { startControllerLoop, stopControllerLoop } from './controller-loop.js';
import { handleCalibrationCommand } from './calibration-handler.js';

// ── Expected actuator positions per state (loaded from state_machine_actuators.csv) ─
let STATE_ACTUATOR_MAP: StateActuatorMap = {};

/** Channel → legacy entity names so frontend PRESSURE_SENSORS get values when data comes from relay (raw PT only in DB). */
const RELAY_PT_CHANNEL_TO_LEGACY_ENTITY: Record<number, string> = {
  1: 'PT_Cal.Fuel_Upstream', 2: 'PT_Cal.GSE_Low', 3: 'PT_Cal.Fuel_Downstream', 4: 'PT_Cal.Fuel_Fill_Tank',
  5: 'PT_Cal.Ox_Upstream', 6: 'PT_Cal.GN2_Regulated', 7: 'PT_Cal.Ox_Downstream',
  8: 'PT_Cal.GSE_High', 9: 'PT_Cal.GN2_High', 10: 'PT_Cal.PT_CH10',
};

class SensorSystemServer {
  private wss: WebSocketServer;
  elodin: ElodinClient;
  private elodinRelay: ElodinRelayClient | null = null;
  private queryClient: ElodinQueryClient | null = null;
  private daqDirect: DAQDirectClient | null = null;
  private clients: Map<WebSocket, Client> = new Map();
  sensorCache: Map<string, SensorUpdate> = new Map();
  private updateInterval: NodeJS.Timeout | null = null;
  // When ELODIN_RELAY_WS_URL is set, data comes from relay (DB); otherwise allow direct UDP if set
  private useDirectDAQ: boolean = process.env.USE_DIRECT_DAQ === 'true' && !process.env.ELODIN_RELAY_WS_URL;
  private useQueryPolling: boolean = process.env.ELODIN_USE_QUERY === 'true';
  private streamingDataReceived: boolean = false;
  private streamingCheckTimer: NodeJS.Timeout | null = null;
  ptCalibration: Map<number, CalibrationCoefficients> = new Map();
  /** Absolute path of the calibration file loaded at startup (null = none found). */
  ptCalibrationFilePath: string | null = null;
  /** (ADC, pressure) points per channel for ADC→pressure fit; cleared on clear_calibration. */
  calibrationPoints: Map<number, { adc: number; pressure: number }[]> = new Map();
  phase2Engine: Phase2CalibrationEngine | null = null;

  /** Robust Calibration Python Sidecar */
  calibrationSidecar!: CalibrationSidecarClient;

  /** Robust Calibration Environmental State */
  envState: EnvironmentalState = {
    temperature: 25.0,
    humidity: 50.0,
    vibration: 0.0,
    aging_factor: 1.0,
    mounting_torque: 1.0
  };

  actuatorSocket: dgram.Socket | null = null;
  private actuatorSocketBroadcastReady: boolean = false;
  actuatorIP: string = '192.168.2.201';
  actuatorPort: number = 5005;
  actuatorBoardMap: Map<string, { channel: number; boardIp: string }> = new Map();
  actuatorBoardIPs: Set<string> = new Set();

  /** Throttle Phase 2 monitoring to ~5 Hz per channel */
  private phase2LastMonitor: Map<number, number> = new Map();
  ipToBoardId: Map<string, number> = new Map();
  private readonly PHASE2_MONITOR_INTERVAL_MS = 200;

  /** Per-channel last-known-good PSI for spike rejection */
  lastGoodPsi: Map<number, number> = new Map();
  private lastGoodPsiHp: Map<string, number> = new Map();
  recentPsiReadings: Map<number, number[]> = new Map();
  private readonly PSI_ABSOLUTE_MIN = -200;
  private readonly PSI_ABSOLUTE_MAX = 5000;
  private readonly PSI_MAX_JUMP = 1000;
  private readonly HP_PT_MAX_JUMP = 500;

  /** Throttle WS broadcasts per entity to ~10 Hz */
  private broadcastLastTime: Map<string, number> = new Map();
  private readonly BROADCAST_MIN_INTERVAL_MS = 100;

  /** History cache for plots (last 5 minutes at 10Hz = 3000 points per entity.component) */
  private historyCache: Map<string, { time: number[]; values: number[] }> = new Map();
  private readonly HISTORY_MAX_POINTS = 3000;

  /** Binary data logger for runs */
  private dataLogger = new DataLogger();
  private _lastSensorLog = 0;

  /** Track calibrated PT from Elodin per channel */
  private calibratedPTFromElodin: Map<number, number> = new Map();

  /** Mission T+0 */
  private firstPacketTime: number | null = null;

  /** State & debug */
  currentState: SystemState | null = null;
  private debugMode: boolean = false;
  actuatorCommandInterval: NodeJS.Timeout | null = null;
  readonly ACTUATOR_COMMAND_INTERVAL_MS = 1000;
  manuallyCommandedChannels: Set<string> = new Set();

  /** Server heartbeat (UDP broadcast) configuration */
  private serverHeartbeatIntervalMs: number = 1000; // default 1 Hz
  private _lastDesignatedSurvivorWarn: number = 0;
  private serverBroadcastPort: number = 5005;       // default actuator command port
  private serverBroadcastIP: string = '255.255.255.255';
  private serverHeartbeatTimer: NodeJS.Timeout | null = null;

  /** Abort → AbortDone timer */
  private abortDoneTimer: NodeJS.Timeout | null = null;

  /** Controller */
  readonly USE_CPP_CONTROLLER: boolean;
  controllerClient: ControllerClient | null = null;
  controllerLoopInterval: NodeJS.Timeout | null = null;
  controllerLoopStartTime: number | null = null;
  readonly CONTROLLER_LOOP_INTERVAL_MS: number;
  readonly PWM_DURATION_MS: number;
  readonly PWM_FREQUENCY_HZ: number;
  readonly FALLBACK_FUEL_DUTY: number;
  readonly FALLBACK_OX_DUTY: number;
  readonly DUTY_SWEEP_ENABLED: boolean;
  readonly DUTY_SWEEP_STEPS: [number, number][];
  readonly DUTY_SWEEP_STEP_DURATION_MS: number;
  controllerCommand: ControllerCommand = { command_type: 'THRUST_DESIRED', thrust_desired: 1000 };
  controllerConfigPath: string | undefined;

  /** Sensor maps (from config.toml; used so DB and backend are a replica of config) */
  channelToEntityMap: Record<number, string> = {};
  boardChannelToEntityMaps: Map<string, Record<number, string>> = new Map();
  actuatorChannelToEntityMap: Record<number, string> = {};
  private hpPtBoards: Map<string, HpPtBoardConfig> = new Map();
  private excitationAdcCache: Map<string, number> = new Map();

  /** Cache of recent raw ADC values per sensor for Phase 1 capture */
  lastRawAdc: Map<number, number> = new Map();

  /** Message logger & Elodin publisher */
  private messageLogger!: MessageLogger;
  private elodinPublisher!: ElodinPublisherBatched;

  /** Optional demo generator for hardware-free testing */
  private demoMode: DemoModeGenerator | null = null;

  /** Registry of boards from config.toml, keyed by numeric ID. */
  private boardRegistryById: Map<number, {
    type: string;
    boardNumber: number | null;
    id: number;
    ip: string;
    expected: boolean;
    /** True if this sense board participates in abort logic. */
    necessaryForAbort: boolean;
    /** True if this board is the designated survivor actuator controller. */
    designatedSurvivor: boolean;
    /** Sensor channels (1-based) we want data from on this board. */
    sensorChannels: number[];
    /** 0 = Internal 2.5V, 1 = VDD ratiometric, 2 = 5V absolute. */
    voltageReference: number;
    /** If true, board will enable serial debug printing when config is applied. */
    enableSerialPrinting: boolean;
  }> = new Map();

  /** Aggregated per-board status, keyed by numeric ID. */
  private boardsStatus: Map<number, {
    type: string;
    boardNumber: number | null;
    id: number;
    ip: string;
    expected: boolean;
    connected: boolean;
    lastHeartbeatMs: number | null;
    heartbeatTimes: number[];
    boardState: number | null;
    engineState: number | null;
  }> = new Map();

  /** Per-board configuration state driven by SENSOR_CONFIG packets. */
  private boardConfigState: Map<number, { status: 'pending' | 'sent' | 'error'; lastSentAt?: number; errorMessage?: string }> = new Map();

  /** Designated survivor actuator board (from config.toml). */
  private designatedSurvivorBoardId: number | null = null;
  private designatedSurvivorIP: string | null = null;
  private designatedSurvivorConnected: boolean = false;
  /** Throttle: last time we logged that config is blocked (designated survivor not connected). */
  private lastConfigBlockedLogMs: number = 0;

  constructor() {
    console.log(`🚀 Starting Sensor System Server...`);
    console.log(`   WebSocket: ${WS_HOST}:${WS_PORT}`);
    console.log(`   Elodin DB: ${ELODIN_HOST}:${ELODIN_PORT}`);

    this.firstPacketTime = null;

    // Load config
    const config = readConfig();

    // Controller settings from config
    const controllerConfig = config.controller || {};
    this.USE_CPP_CONTROLLER = !!controllerConfig.use_cpp_controller || process.env.USE_CPP_CONTROLLER === 'true';
    this.CONTROLLER_LOOP_INTERVAL_MS = controllerConfig.controller_loop_hz
      ? Math.round(1000 / controllerConfig.controller_loop_hz) : 100;
    this.PWM_DURATION_MS = controllerConfig.pwm_duration_ms || 10000;
    this.PWM_FREQUENCY_HZ = controllerConfig.pwm_frequency_hz || 10;
    this.FALLBACK_FUEL_DUTY = controllerConfig.fallback_fuel_duty_cycle ?? 0.1;
    this.FALLBACK_OX_DUTY = controllerConfig.fallback_ox_duty_cycle ?? 0.1;
    this.DUTY_SWEEP_ENABLED = !!controllerConfig.duty_sweep_enabled;
    this.DUTY_SWEEP_STEP_DURATION_MS = Math.round((controllerConfig.duty_sweep_step_duration_sec ?? 2) * 1000);
    const rawSteps = controllerConfig.duty_sweep_steps;
    if (Array.isArray(rawSteps) && rawSteps.length > 0) {
      this.DUTY_SWEEP_STEPS = rawSteps.map((s: unknown) => {
        const a = Array.isArray(s) ? s : [0.1, 0.1];
        return [Math.max(0, Math.min(1, Number(a[0]) ?? 0.1)), Math.max(0, Math.min(1, Number(a[1]) ?? 0.1))] as [number, number];
      });
    } else {
      this.DUTY_SWEEP_STEPS = [[0.1, 0.1], [0.3, 0.2], [0.5, 0.4], [0.3, 0.3], [0.1, 0.1]];
    }

    // Load config-driven controller targets
    this.controllerCommand = {
      command_type: (controllerConfig.command_type || 'THRUST_DESIRED') as any,
      thrust_desired: controllerConfig.thrust_desired ?? 1000,
      altitude_goal: controllerConfig.altitude_goal ?? 0,
      P_fuel_target: controllerConfig.pressure_fuel_target ?? 0,
      P_ox_target: controllerConfig.pressure_ox_target ?? 0,
    };

    console.log(`🎯 Controller settings: loop=${1000 / this.CONTROLLER_LOOP_INTERVAL_MS}Hz, PWM=${this.PWM_FREQUENCY_HZ}Hz, duration=${this.PWM_DURATION_MS}ms`);
    console.log(`   Fallback duty cycles: Fuel=${(this.FALLBACK_FUEL_DUTY * 100).toFixed(1)}%, LOX=${(this.FALLBACK_OX_DUTY * 100).toFixed(1)}%`);
    if (this.DUTY_SWEEP_ENABLED) {
      console.log(`   Duty sweep: ${this.DUTY_SWEEP_STEPS.length} steps × ${this.DUTY_SWEEP_STEP_DURATION_MS}ms (${(this.DUTY_SWEEP_STEPS.length * this.DUTY_SWEEP_STEP_DURATION_MS / 1000).toFixed(1)}s fire)`);
    }

    // Load PT calibration (use config.calibration.pt.json_path if set)
    const ptJsonPath = (config as any).calibration?.pt?.json_path;
    const configDir = path.dirname(getConfigPath());
    const repoRoot = path.dirname(configDir); // config.toml lives in config/, so repo root is parent
    const resolvedPtPath = ptJsonPath ? path.join(repoRoot, ptJsonPath) : undefined;
    const ptCalResult = loadPTCalibration(resolvedPtPath);
    this.ptCalibration = ptCalResult.map;
    this.ptCalibrationFilePath = ptCalResult.filePath;

    // Initialize Robust Calibration Sidecar
    this.calibrationSidecar = new CalibrationSidecarClient();
    this.calibrationSidecar.start();
    console.log('🤖 Robust Calibration Sidecar initialized');

    // Load sensor/actuator maps from config.toml (single source of truth; DB and backend replicate this)
    const sensorMaps = loadSensorRoleMap();
    this.channelToEntityMap = sensorMaps.channelToEntityMap;
    this.boardChannelToEntityMaps = sensorMaps.boardChannelToEntityMaps;
    if (Object.keys(this.channelToEntityMap).length === 0 && this.boardChannelToEntityMaps.size > 0) {
      const first = this.boardChannelToEntityMaps.values().next().value;
      if (first) this.channelToEntityMap = { ...first };
    }
    this.actuatorChannelToEntityMap = loadActuatorChannelToEntityMap();

    // Load board registry from config.toml for heartbeat tracking
    this.loadBoardRegistry();

    // Load server heartbeat configuration from config.toml (optional section)
    try {
      const hb = (config as any).server_heartbeat || {};
      if (typeof hb.interval_ms === 'number' && hb.interval_ms > 0) {
        this.serverHeartbeatIntervalMs = hb.interval_ms;
      }
      if (typeof hb.broadcast_port === 'number' && hb.broadcast_port > 0 && hb.broadcast_port <= 65535) {
        this.serverBroadcastPort = hb.broadcast_port;
      } else {
        this.serverBroadcastPort = this.actuatorPort;
      }
      if (typeof hb.broadcast_ip === 'string' && hb.broadcast_ip.length > 0) {
        this.serverBroadcastIP = hb.broadcast_ip;
        // Normalize common typo that causes EADDRS (205 → 255 for limited broadcast)
        if (this.serverBroadcastIP === '205.255.255.255') {
          this.serverBroadcastIP = '255.255.255.255';
        }
      }
      console.log(`📡 Server heartbeat config: interval=${this.serverHeartbeatIntervalMs} ms, ` +
        `broadcast=${this.serverBroadcastIP}:${this.serverBroadcastPort}`);
    } catch (err) {
      console.warn('⚠️ Failed to load server_heartbeat config; using defaults:', err);
      this.serverBroadcastPort = this.actuatorPort;
    }

    const boards = (config.boards || {}) as Record<string, any>;
    for (const [boardKey, boardRaw] of Object.entries(boards)) {
      const board = boardRaw as any;
      if (board.ip && typeof board.board_id === 'number' && board.enabled !== false) {
        // Only map if enabled to prevent collisions (e.g. disabled LC board shadowing active PT)
        this.ipToBoardId.set(board.ip, board.board_id);
      }
    }

    // Load HP PT board configs (extracted module)
    this.hpPtBoards = loadHpPtConfig();

    // Initialize controller client (config > env var > default), unless using C++ controller
    const controllerUrl = process.env.CONTROLLER_URL || controllerConfig.controller_service_url || 'http://localhost:8000';
    if (!this.USE_CPP_CONTROLLER) {
      this.controllerClient = new ControllerClient(controllerUrl);
      this.controllerConfigPath = controllerConfig.controller_config_path || undefined;
      console.log(`🎯 Controller client initialized: ${controllerUrl}` + (this.controllerConfigPath ? ` (config: ${this.controllerConfigPath})` : ''));
    } else {
      this.controllerClient = null;
      this.controllerConfigPath = controllerConfig.controller_config_path || undefined;
      console.log('🎯 Using C++ controller service – web backend ControllerClient disabled');
    }

    // Load state actuator map from CSV
    STATE_ACTUATOR_MAP = getStateActuatorMap();
    if (Object.keys(STATE_ACTUATOR_MAP).length === 0) {
      console.warn('⚠️ No state actuator map loaded - actuators will not auto-command');
    } else {
      console.log(`📋 Loaded state actuator map: ${Object.keys(STATE_ACTUATOR_MAP).length} states`);
    }

    // Load actuator board mappings (extracted module)
    loadActuatorBoardMap(config, this);

    // Build transition validation map
    const transitions = getStateTransitions();
    if (transitions.length === 0) {
      console.warn('⚠️ No state transitions loaded - all transitions will be allowed');
    } else {
      console.log(`📋 Loaded ${transitions.length} allowed state transitions`);
    }

    // Initialize Phase 2 calibration engine (fallback/internal)
    this.phase2Engine = new Phase2CalibrationEngine();

    // Default Phase 2 to disabled if Sidecar is primary
    if (config.calibration?.sidecar?.enabled) {
      this.phase2Engine.setEnabled(false);
      console.log('🤖 Internal Phase 2 disabled - Robust Sidecar is primary');
    }

    try {
      const phase2Config = config.phase2;
      if (phase2Config) {
        if (phase2Config.drift_threshold !== undefined) this.phase2Engine.setDriftThreshold(phase2Config.drift_threshold);
        if (phase2Config.process_noise !== undefined) this.phase2Engine.setProcessNoise(phase2Config.process_noise);
        if (phase2Config.ema_smoothing_alpha !== undefined) this.phase2Engine.setEMASmoothingAlpha(phase2Config.ema_smoothing_alpha);
        // Only override if sidecar is not enabled
        if (!config.calibration?.sidecar?.enabled && phase2Config.enabled !== undefined) {
          this.phase2Engine.setEnabled(phase2Config.enabled);
        }
        if (phase2Config.consensus_threshold_psi !== undefined) this.phase2Engine.setConsensusThreshold(phase2Config.consensus_threshold_psi);
        if (phase2Config.consensus_update_rate !== undefined) this.phase2Engine.setConsensusUpdateRate(phase2Config.consensus_update_rate);
      }
    } catch (err) {
      console.warn('⚠️ Failed to load Phase 2 config, using defaults:', err);
    }
    this.phase2Engine.setEnabled(false);
    this.calibrationSidecar.enabled = false;
    console.log('📐 Phase 1 polynomial calibration only (Phase 2 and sidecar disabled)');

    // Load saved Phase 2/Robust calibration
    let savedCalibration: Map<number, { coeffs: CalibrationCoefficients; rlsUpdateCount: number }> = new Map();
    try { savedCalibration = this.phase2Engine.loadSavedCalibration(); } catch (err) {
      console.warn('⚠️ Failed to load saved calibration, continuing without it:', err);
    }

    this.ptCalibration.forEach((coeffs, sensorId) => {
      try {
        this.phase2Engine!.initializeSensor(sensorId, coeffs);
        const saved = savedCalibration.get(sensorId);
        if (saved) {
          const state = this.phase2Engine!.getSensorState(sensorId);
          if (state) {
            const c = saved.coeffs;
            state.adjustment = {
              A: c.A - coeffs.A,
              B: c.B - coeffs.B,
              C: c.C - coeffs.C,
              D: c.D - coeffs.D
            };
            state.rlsUpdateCount = saved.rlsUpdateCount;
            // Also update our baseline map so conversions are correct before sidecar sync
            this.ptCalibration.set(sensorId, c);
            console.log(`📋 Restored saved calibration for sensor ${sensorId} (RLS updates: ${state.rlsUpdateCount})`);
          }
        }
      } catch (err) { console.error(`❌ Failed to initialize Phase 2 for sensor ${sensorId}:`, err); }
    });

    // Listen to Sidecar for live coefficient updates
    if (this.calibrationSidecar) {
      this.calibrationSidecar.on('message', async (msg: any) => {
        if (msg.type === 'coefficient_update' || msg.type === 'calibration_update') {
          console.log(`🤖 Sidecar notified of calibration update (channel: ${msg.channel})`);
          await this.syncSidecarCoefficients();
        }
      });
      // Initial sync
      this.syncSidecarCoefficients().catch(e => console.warn('⚠️ Initial sidecar sync failed:', e.message));
    }

    // Initialize UDP socket for actuator commands (bind first so setBroadcast works on macOS/Unix)
    this.actuatorSocket = dgram.createSocket('udp4');
    this.actuatorSocket.on('error', (err: Error) => {
      const error = err as any;
      console.error(`❌ Actuator UDP socket error: ${error.code || 'UNKNOWN'} — ${error.message}`);
      try {
        if (this.actuatorSocket) this.actuatorSocket.close();
        this.actuatorSocket = dgram.createSocket('udp4');
        this.actuatorSocket.on('error', (err2: Error) => { console.error(`❌ Failed to recreate actuator socket: ${err2.message}`); });
        this.actuatorSocketBroadcastReady = false;
        this.actuatorSocket.bind({ port: 0, address: '0.0.0.0' }, () => {
          try {
            this.actuatorSocket!.setBroadcast(true);
            this.actuatorSocketBroadcastReady = true;
            console.log('📡 Actuator socket recreated with broadcast enabled');
          } catch (e) { console.warn('⚠️ setBroadcast failed on recreated socket:', e); }
        });
      } catch (recreateError) { console.error(`❌ Failed to recreate actuator socket:`, recreateError); this.actuatorSocket = null; }
    });
    this.actuatorSocket.on('close', () => { console.warn('⚠️ Actuator UDP socket closed'); });
    this.actuatorSocket.bind({ port: 0, address: '0.0.0.0' }, () => {
      try {
        this.actuatorSocket!.setBroadcast(true);
        this.actuatorSocketBroadcastReady = true;
        console.log('📡 UDP socket broadcast enabled for actuator/heartbeat traffic');
      } catch (err) {
        console.warn('⚠️ Failed to enable UDP broadcast on actuator socket:', err);
      }
    });
    console.log(`🎯 Actuator command socket initializing (target: ${this.actuatorIP}:${this.actuatorPort})`);

    this.wss = new WebSocketServer({ port: WS_PORT, host: WS_HOST, perMessageDeflate: false });
    this.wss.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`❌ Port ${WS_PORT} already in use — frontend cannot connect. Free it and restart:`);
        console.error(`   fuser -k ${WS_PORT}/tcp   OR   kill $(lsof -ti:${WS_PORT})`);
        process.exit(1);
      } else { console.error('❌ WebSocket server error:', error); }
    });
    this.wss.on('listening', () => {
      const address = this.wss.address();
      console.log(`✅ WebSocket server listening on ${WS_HOST}:${WS_PORT}`);
      if (address && typeof address === 'object') console.log(`   Server bound to: ${address.address}:${address.port}`);
      console.log(`   Frontend should connect to: ws://localhost:${WS_PORT} or ws://${WS_HOST === '0.0.0.0' ? 'your-ip' : WS_HOST}:${WS_PORT}`);
    });

    this.elodin = new ElodinClient(ELODIN_HOST, ELODIN_PORT);
    this.messageLogger = new MessageLogger(this.elodin);
    if (process.env.ENABLE_MESSAGE_LOGGING !== 'false') this.messageLogger.enable();
    this.elodinPublisher = new ElodinPublisherBatched(this.elodin);

    this.setupWebSocket();
    if (process.env.ELODIN_RELAY_WS_URL) {
      console.log('📡 Using Elodin RELAY for data (DAQ Bridge → Elodin → Relay → Backend → Frontend)');
      this.setupElodinRelay();
    }
    this.setupElodin();

    // Optional DEMO mode: synthesised data + UDP packets for DAQ bridge.
    if (process.env.DEMO_MODE === 'true') {
      this.demoMode = new DemoModeGenerator();
      if (this.demoMode.isEnabled()) {
        console.log('🎭 DemoModeGenerator active — generating synthetic PT/ACT data');
        this.demoMode.start((update) => this.handleSensorUpdate(update), 10);
      }
    }

    if (this.useDirectDAQ) {
      console.log('🚀 Using DIRECT DAQ connection for real-time data');
      // Load environmental state from config
      const envCfg = config.calibration?.environmental || {};
      this.envState = {
        temperature: envCfg.temperature ?? 25.0,
        humidity: envCfg.humidity ?? 50.0,
        vibration: envCfg.vibration ?? 0.0,
        aging_factor: envCfg.aging_factor ?? 1.0,
        mounting_torque: envCfg.mounting_torque ?? 1.0
      };

      this.setupDirectDAQ();
    } else if (!process.env.ELODIN_RELAY_WS_URL) {
      console.log('📡 Using Elodin DB for data (DAQ Bridge → Elodin DB → Backend → Frontend)');
      console.warn('⚠️ Elodin DB streams raw data to only the FIRST subscriber. For multiple clients (e.g. backend + sidecar), run the relay first and set ELODIN_RELAY_WS_URL=ws://localhost:9090');
    }

    this.startUpdateLoop();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Elodin setup
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Initialize board registry from config.toml
   * Each board gets a numeric ID and boardNumber; IP is derived as 192.168.2.[id]
   */
  private loadBoardRegistry(): void {
    try {
      const config = readConfig();
      const boards = config.boards || {};
      this.boardRegistryById.clear();
      this.boardsStatus.clear();
      this.boardConfigState.clear();
      this.designatedSurvivorBoardId = null;
      this.designatedSurvivorIP = null;
      this.designatedSurvivorConnected = false;

      const designatedCandidates: Array<{ id: number; ip: string }> = [];

      for (const [key, raw] of Object.entries(boards)) {
        const board: any = raw;
        const type: string = board.type || 'UNKNOWN';
        // Distinguish between human board number and numeric ID used for IP
        const boardNumber: number | null = typeof board.board_number === 'number'
          ? board.board_number
          : (typeof board.board_id === 'number' ? board.board_id : null);
        const id: number | undefined = typeof board.id === 'number'
          ? board.id
          : (typeof board.board_id === 'number' ? board.board_id : undefined);
        if (id === undefined) {
          console.warn(`⚠️ Board ${key} is missing id/board_id; skipping heartbeat tracking`);
          continue;
        }
        const ipFromConfig: string | undefined = typeof board.ip === 'string' ? board.ip : undefined;
        const ip = ipFromConfig || `192.168.2.${id}`;

        const necessaryForAbort: boolean = !!board.necessary_for_abort && type !== 'ACTUATOR';
        const designatedSurvivor: boolean = !!board.designated_survivor && type === 'ACTUATOR';

        // Determine sensor channels we want from this board
        const numSensors: number | undefined = typeof board.num_sensors === 'number' ? board.num_sensors : undefined;
        const activeConnectors: unknown = board.active_connectors;
        let sensorChannels: number[] = [];
        if (Array.isArray(activeConnectors) && activeConnectors.length > 0) {
          sensorChannels = activeConnectors
            .map((v) => Number(v))
            .filter((v) => Number.isFinite(v) && v >= 1 && v <= 255);
        } else if (numSensors && numSensors > 0) {
          sensorChannels = Array.from({ length: numSensors }, (_v, i) => i + 1);
        }

        const entry = {
          type,
          boardNumber,
          id,
          ip,
          expected: true as const,
          necessaryForAbort,
          designatedSurvivor,
          sensorChannels,
          voltageReference: board.voltage_reference ?? 0,
          enableSerialPrinting: !!board.enable_serial_printing,
        };
        this.boardRegistryById.set(id, entry);
        this.boardsStatus.set(id, {
          ...entry,
          connected: false,
          lastHeartbeatMs: null,
          heartbeatTimes: [],
          boardState: null,
          engineState: null,
        });
        this.boardConfigState.set(id, { status: 'pending' });

        if (designatedSurvivor) {
          designatedCandidates.push({ id, ip });
        }
      }

      if (designatedCandidates.length === 1) {
        this.designatedSurvivorBoardId = designatedCandidates[0].id;
        this.designatedSurvivorIP = designatedCandidates[0].ip;
        console.log(`📋 Designated survivor actuator board: ID ${this.designatedSurvivorBoardId} (${this.designatedSurvivorIP})`);
      } else if (designatedCandidates.length === 0) {
        console.warn('⚠️ No designated survivor actuator board found in config.toml; SENSOR_CONFIG packets will not be sent');
      } else {
        console.warn(`⚠️ Multiple designated survivor boards found (${designatedCandidates.length}); SENSOR_CONFIG packets will not be sent`);
      }

      console.log(`📋 Loaded ${this.boardRegistryById.size} boards from config.toml`);
    } catch (error) {
      console.warn('⚠️ Failed to load boards from config.toml; heartbeat pane will rely on discovery only:', error);
    }
  }


  private setupElodinRelay(): void {
    const url = process.env.ELODIN_RELAY_WS_URL!;
    this.elodinRelay = new ElodinRelayClient(url);
    this.elodinRelay.on('packet', (header, payload) => {
      this.relayPacketCount++;
      if (this.relayPacketCount === 1 || this.relayPacketCount % 500 === 0) {
        console.log(`[Relay] packets received: ${this.relayPacketCount}`);
      }
      if (!this.streamingDataReceived && header.ty === ElodinPacketType.TABLE) {
        this.streamingDataReceived = true;
        if (this.streamingCheckTimer) { clearTimeout(this.streamingCheckTimer); this.streamingCheckTimer = null; }
      }
      this.handleElodinPacket(header, payload);
    });
    this.elodinRelay.on('connected', () => {
      console.log('✅ Elodin relay connected — receiving stream from relay (one publisher, multiple subscribers)');
      this.streamingDataReceived = true;
      this.broadcast({ type: MessageType.CONNECTION_STATUS, timestamp: Date.now(), payload: { connected: true, elodinConnected: true } as ConnectionStatus });
    });
    this.elodinRelay.on('disconnected', () => {
      console.log('❌ Elodin relay disconnected');
      this.broadcast({ type: MessageType.CONNECTION_STATUS, timestamp: Date.now(), payload: { connected: true, elodinConnected: false } as ConnectionStatus });
      this.scheduleRelayReconnect();
    });
    const tryRelay = (): void => {
      this.elodinRelay!.connect().then((ok) => {
        if (ok) {
          console.log('✅ Elodin relay data connection established at ' + url);
          if (this.relayReconnectTimer) { clearInterval(this.relayReconnectTimer); this.relayReconnectTimer = null; }
        } else this.scheduleRelayReconnect();
      }).catch((e) => { console.warn('⚠️ Relay connect error:', e); this.scheduleRelayReconnect(); });
    };
    tryRelay();
  }

  private relayPacketCount: number = 0;
  private relayReconnectTimer: ReturnType<typeof setInterval> | null = null;
  private scheduleRelayReconnect(): void {
    if (this.relayReconnectTimer || !this.elodinRelay) return;
    this.relayReconnectTimer = setInterval(() => {
      if (this.elodinRelay?.isConnected()) {
        if (this.relayReconnectTimer) { clearInterval(this.relayReconnectTimer); this.relayReconnectTimer = null; }
        return;
      }
      console.log('🔄 Retrying relay connection...');
      this.elodinRelay?.connect().then((ok) => {
        if (ok && this.relayReconnectTimer) { clearInterval(this.relayReconnectTimer); this.relayReconnectTimer = null; }
      });
    }, 3000);
  }

  private setupElodin(): void {
    const useRelay = !!process.env.ELODIN_RELAY_WS_URL;

    this.elodin.on('connected', async () => {
      console.log('✅ Elodin connected' + (useRelay ? ' (send-only; data via relay)' : ', broadcasting to clients'));
      if (!useRelay) {
        await subscribeWithStream(this.elodin);
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!this.streamingDataReceived) {
          console.log('⚠️ No data after Stream subscription. Trying MsgStream/VTableStream...');
          await registerVTables(this.elodin);
        } else { console.log('✅ Stream subscription successful!'); }
        if (!this.useDirectDAQ) this.startStreamingCheck();
      }
      await registerControllerVTables(this.elodin);
      this.streamingDataReceived = false;
      this.broadcast({ type: MessageType.CONNECTION_STATUS, timestamp: Date.now(), payload: { connected: true, elodinConnected: true } as ConnectionStatus });
    });

    this.elodin.on('disconnected', () => {
      console.log('❌ Elodin disconnected');
      this.broadcast({ type: MessageType.CONNECTION_STATUS, timestamp: Date.now(), payload: { connected: true, elodinConnected: false } as ConnectionStatus });
    });

    this.elodin.on('packet', (header, payload) => {
      if (useRelay) return;
      if (!this.streamingDataReceived && header.ty === ElodinPacketType.TABLE) {
        this.streamingDataReceived = true;
        if (this.streamingCheckTimer) { clearTimeout(this.streamingCheckTimer); this.streamingCheckTimer = null; }
      }
      if (this.useDirectDAQ) return;
      this.handleElodinPacket(header, payload);
    });

    this.elodin.connect().then(() => {
      console.log('✅ Elodin connection established');
      if (!useRelay) {
        setInterval(() => {
          if (this.elodin.isConnected()) {
            this.elodin.sendRawMessage([0x00, 0x00], ElodinPacketType.MSG, Buffer.alloc(0));
          }
        }, 5000);
      }
    }).catch((error) => { console.error('❌ Elodin connection error:', error); });

    this.elodin.on('error', () => { });
  }

  private startStreamingCheck(): void {
    if (this.streamingCheckTimer) clearTimeout(this.streamingCheckTimer);
    this.streamingCheckTimer = setTimeout(() => {
      if (!this.streamingDataReceived) {
        console.warn('⚠️ No streaming data received from Elodin DB after 10 seconds');
      } else { console.log('✅ Streaming data confirmed'); }
      this.streamingCheckTimer = null;
    }, 10000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Direct DAQ setup  (the largest block — kept inline because it heavily
  //   accesses 15+ private fields and would need a very wide interface)
  // ═══════════════════════════════════════════════════════════════════════════

  private setupDirectDAQ(): void {
    console.log('🔌 Setting up direct UDP listener for DiabloAvionics boards...');
    const sensorPort = readConfig()?.network?.sensor_port ?? 5006;
    this.daqDirect = new DAQDirectClient('0.0.0.0', sensorPort);

    this.daqDirect.on('connected', () => {
      console.log('✅ Direct DAQ connection established');
      this.broadcast({ type: MessageType.CONNECTION_STATUS, timestamp: Date.now(), payload: { connected: true, elodinConnected: false } as ConnectionStatus });
    });

    // Track BOARD_HEARTBEAT packets from DiabloAvionics boards
    this.daqDirect.on('board_heartbeat', (hb: BoardHeartbeatEvent) => {
      const now = Date.now();
      const id = hb.id;
      const sourceIP = hb.sourceIP || '';
      let status = this.boardsStatus.get(id);

      if (!status) {
        const registry = this.boardRegistryById.get(id);
        const type = registry?.type || 'UNKNOWN';
        const boardNumber = registry?.boardNumber ?? null;
        // Use actual source IP from heartbeat so we send config to the right host (PT boards may send id that doesn't match config)
        const ip = sourceIP || registry?.ip || `192.168.2.${id}`;
        status = {
          type,
          boardNumber,
          id,
          ip,
          expected: !!registry,
          connected: false,
          lastHeartbeatMs: null,
          heartbeatTimes: [],
          boardState: null,
          engineState: null,
        };
        this.boardsStatus.set(id, status);
        if (!this.boardConfigState.has(id)) {
          this.boardConfigState.set(id, { status: 'pending' });
        }
      } else {
        // Keep board IP in sync with actual heartbeat source (in case id in packet doesn't match config)
        status.ip = sourceIP || status.ip;
      }

      // Detect disconnected → reconnected transition so we can resend config.
      const HEARTBEAT_TIMEOUT_MS = 2500;
      const wasDisconnected =
        status.lastHeartbeatMs == null || now - status.lastHeartbeatMs > HEARTBEAT_TIMEOUT_MS;

      status.connected = true;
      status.lastHeartbeatMs = now;
      const prevBoardState = status.boardState;
      const prevEngineState = status.engineState;
      status.boardState = hb.boardState;
      status.engineState = hb.engineState;
      if (prevBoardState !== status.boardState || prevEngineState !== status.engineState) {
        const stateNames: Record<number, string> = { 1: 'Setup', 2: 'Active', 3: 'Abort', 4: 'Abort done' };
        console.log(
          `[BOARD] ${id} (${status.ip}) state: ${stateNames[status.boardState as number] ?? status.boardState} (board_state=${status.boardState}) engine_state=${status.engineState}`
        );
      }

      // Gap 1: board reconnected after timeout – resend config.
      if (wasDisconnected) {
        const prevCfg = this.boardConfigState.get(id);
        if (prevCfg?.status === 'sent' || prevCfg?.status === 'error') {
          console.log(`[CONFIG] Board ${id} (${status.ip}) reconnected – resetting config state to pending`);
          this.boardConfigState.set(id, { status: 'pending' });
        }
      }

      // Gap 2: board rebooted while heartbeats stayed continuous – boardState returned to Setup (1).
      const boardJustEnteredSetup = status.boardState === 1 && prevBoardState !== 1;
      if (boardJustEnteredSetup) {
        const prevCfg = this.boardConfigState.get(id);
        if (prevCfg?.status === 'sent' || prevCfg?.status === 'error') {
          console.log(`[CONFIG] Board ${id} (${status.ip}) entered Setup state – resetting config to pending`);
          this.boardConfigState.set(id, { status: 'pending' });
        }
      }

      status.heartbeatTimes.push(now);
      const windowMs = 10000;
      const cutoff = now - windowMs;
      while (status.heartbeatTimes.length > 0 && status.heartbeatTimes[0] < cutoff) {
        status.heartbeatTimes.shift();
      }

      this.maybeSendConfigPackets();
    });

    // ── Regular PT sensor data ──────────────────────────────────────────────
    this.daqDirect.on('sensor_data', (header: any, chunks: Array<any>, sourceIP: string) => {
      if (this.hpPtBoards.has(sourceIP)) return;
      if (this.actuatorBoardIPs.has(sourceIP)) return;

      const now = Date.now();
      if (now - this._lastSensorLog > 5000) {
        this._lastSensorLog = now;
        const totalDatapoints = chunks.reduce((sum, chunk) => sum + (chunk.datapoints?.length || 0), 0);
        console.log(`📥 Regular PT data from ${sourceIP}: ${chunks.length} chunks, ${totalDatapoints} datapoints`);
      }

      const currentTime = Date.now();
      const timestampNs = BigInt(currentTime) * BigInt(1000000);
      const statsStartTime = (this.daqDirect as any).statsStartTime || currentTime;
      if (!(this.daqDirect as any).statsStartTime) (this.daqDirect as any).statsStartTime = currentTime;

      const publishingToElodin = this.elodin.isConnected() && this.elodinPublisher;
      if (publishingToElodin) this.elodinPublisher!.beginBatch();

      const SAMPLE_RATE_HZ = 7200;
      const SAMPLE_PERIOD_MS = 1000.0 / SAMPLE_RATE_HZ;

      for (const chunk of chunks) {
        const chunkTimestampMs = chunk.timestamp;
        const chunkTimeBase = chunkTimestampMs > 0 ? chunkTimestampMs : currentTime;

        for (let sampleIdx = 0; sampleIdx < chunk.datapoints.length; sampleIdx++) {
          const dp = chunk.datapoints[sampleIdx];
          const sampleTimeMs = chunkTimeBase + (sampleIdx * SAMPLE_PERIOD_MS);
          const sampleTime = sampleTimeMs;
          const sensorIdPacket = dp.sensor_id;
          if (sensorIdPacket === 0) continue;

          const channelId = sensorIdPacket;
          const boardId = this.ipToBoardId.get(sourceIP) ?? 1; // Default to board 1
          const uniqueId = boardId * 100 + channelId;
          const codeUint32 = dp.data;

          const boardEntry = this.boardRegistryById.get(boardId);
          const boardType = boardEntry?.type || 'PT';

          let coeffs = this.ptCalibration.get(uniqueId) ?? this.ptCalibration.get(channelId); // Fallback to legacy channel ID if unique not found

          if (publishingToElodin) {
            this.elodinPublisher!.publishRawPT(channelId, timestampNs, codeUint32, chunkTimestampMs, 0);
          }

          const boardMap = this.boardChannelToEntityMaps.get(sourceIP);
          const channelMap = boardMap || this.channelToEntityMap;

          const defaultPrefix = boardType === 'PT' ? 'PT_Cal' : boardType;
          const calEntity = channelMap[channelId] || `${defaultPrefix}.${boardType}_CH${channelId}`;

          let rawPrefix = 'PT';
          if (boardType === 'TC') rawPrefix = 'TC';
          else if (boardType === 'LC') rawPrefix = 'LC';
          else if (boardType === 'RTD') rawPrefix = 'RTD';

          const rawEntity = calEntity.replace(`${defaultPrefix}.`, `${rawPrefix}.`);

          this.handleSensorUpdate({ entity: rawEntity, component: 'raw_adc_counts', value: codeUint32, timestamp: sampleTime });
          this.handleSensorUpdate({ entity: `${rawPrefix}.${boardType}_CH${channelId}`, component: 'raw_adc_counts', value: codeUint32, timestamp: sampleTime });
          this.lastRawAdc.set(uniqueId, codeUint32);

          // Calibrated value logic
          let val: number;
          let component = 'pressure_psi';
          if (boardType === 'TC' || boardType === 'RTD') component = 'temperature_c';
          else if (boardType === 'LC') component = 'force_n';

          if (boardType === 'PT' && coeffs) {
            val = calculatePressure(codeUint32, coeffs, this.envState);
            if (isNaN(val) || !isFinite(val)) continue;
          } else {
            // Default linear scaling for non-PT or uncalibrated PT
            // For TC/RTD/LC, we might need different scaling, but for now 1e8/1000 is a safe placeholder
            val = (codeUint32 / 1e8) * 1000;
          }

          if (boardType === 'PT' && (val < this.PSI_ABSOLUTE_MIN || val > this.PSI_ABSOLUTE_MAX)) continue;
          this.lastGoodPsi.set(uniqueId, val);

          if (publishingToElodin && boardType === 'PT') {
            this.elodinPublisher!.publishCalibratedPT(channelId, timestampNs, val, codeUint32, 0);
          }

          this.handleSensorUpdate({ entity: calEntity, component, value: val, timestamp: sampleTime });
          this.handleSensorUpdate({ entity: `${defaultPrefix}.${boardType}_CH${channelId}`, component, value: val, timestamp: sampleTime });
        }
      }

      if (publishingToElodin) this.elodinPublisher!.flushBatch();
    });

    // ── Actuator board data ─────────────────────────────────────────────────
    this.daqDirect.on('sensor_data', (header: any, chunks: Array<any>, sourceIP: string) => {
      if (!this.actuatorBoardIPs.has(sourceIP)) return;
      const currentTime = Date.now();
      for (const chunk of chunks) {
        for (const dp of chunk.datapoints) {
          const channelId = dp.sensor_id;
          let actuatorName: string | null = null;
          for (const [name, info] of this.actuatorBoardMap.entries()) {
            if (info.boardIp === sourceIP && info.channel === channelId) {
              actuatorName = name;
              break;
            }
          }

          const entity = actuatorName
            ? `ACT.${actuatorName.replace(/\s+/g, '_')}`
            : `ACT.ACT_CH${channelId}_${sourceIP.split('.').pop()}`;

          this.handleSensorUpdate({
            entity,
            component: 'raw_adc_counts',
            value: dp.data,
            timestamp: currentTime
          });

          // Also update the generic ACT_CH for legacy UI components if they still use it
          this.handleSensorUpdate({
            entity: `ACT.ACT_CH${channelId}`,
            component: 'raw_adc_counts',
            value: dp.data,
            timestamp: currentTime
          });
        }
      }
    });

    // ── HP PT board data ────────────────────────────────────────────────────
    this.daqDirect.on('sensor_data', (header: any, chunks: Array<any>, sourceIP: string) => {
      const hpCfg = this.hpPtBoards.get(sourceIP);
      if (!hpCfg) return;

      const currentTime = Date.now();
      const SAMPLE_RATE_HZ = 7200;
      const SAMPLE_PERIOD_MS = 1000.0 / SAMPLE_RATE_HZ;

      for (const chunk of chunks) {
        const chunkTimestampMs = chunk.timestamp;
        const chunkTimeBase = chunkTimestampMs > 0 ? chunkTimestampMs : currentTime;

        let chunkExcitation: number | undefined = undefined;
        for (const dp of chunk.datapoints) {
          if (dp.sensor_id === hpCfg.excitationConnectorId) {
            chunkExcitation = dp.data;
            if (chunkExcitation !== undefined && chunkExcitation > 0) this.excitationAdcCache.set(sourceIP, chunkExcitation);
            break;
          }
        }
        if (chunkExcitation === undefined) chunkExcitation = this.excitationAdcCache.get(sourceIP);
        if (chunkExcitation === undefined || chunkExcitation === 0) continue;

        for (let sampleIdx = 0; sampleIdx < chunk.datapoints.length; sampleIdx++) {
          const dp = chunk.datapoints[sampleIdx];
          const sampleTime = chunkTimeBase + (sampleIdx * SAMPLE_PERIOD_MS);
          const connectorId: number = dp.sensor_id;
          const adcCode: number = dp.data;

          if (connectorId === hpCfg.excitationConnectorId) continue;
          if (!hpCfg.hpPtConnectors.has(connectorId)) continue;

          const psi = convertHpPtToPressure(adcCode, chunkExcitation!, hpCfg);
          if (!isFinite(psi) || isNaN(psi)) continue;

          const entity = hpCfg.channelToEntity[connectorId] ?? `PT_Cal.HP_PT_${connectorId}`;

          // Spike rejection for HP PT
          let psiToEmit = psi;
          const lastHp = this.lastGoodPsiHp.get(entity);
          if (lastHp !== undefined) {
            const jump = Math.abs(psi - lastHp);
            if (jump > this.HP_PT_MAX_JUMP) { psiToEmit = lastHp; }
            else { this.lastGoodPsiHp.set(entity, psi); }
          } else { this.lastGoodPsiHp.set(entity, psi); }

          const ADC_MAX = 2147483648;
          const vSense = (adcCode / ADC_MAX) * hpCfg.adcRefVoltage;
          const iMa = (vSense / hpCfg.senseResistorOhms) * 1000;
          const vExcRaw = (chunkExcitation! / ADC_MAX) * hpCfg.adcRefVoltage;
          const vExc = vExcRaw * hpCfg.excitationDividerRatio;

          this.handleSensorUpdate({ entity, component: 'pressure_psi', value: psiToEmit, timestamp: sampleTime });
          this.handleSensorUpdate({ entity, component: 'raw_adc_counts', value: adcCode, timestamp: sampleTime });
          this.handleSensorUpdate({ entity, component: 'excitation_voltage', value: vExc, timestamp: sampleTime });
          this.handleSensorUpdate({ entity, component: 'sense_voltage', value: vSense, timestamp: sampleTime });
          this.handleSensorUpdate({ entity, component: 'current_ma', value: iMa, timestamp: sampleTime });
        }
      }
    });

    this.daqDirect.connect().then((connected) => {
      if (connected) { console.log('✅ Direct DAQ connection successful'); }
      else { console.warn('⚠️ Direct DAQ connection failed (no Elodin fallback — data path is UDP → Backend only)'); }
    }).catch((error) => { console.error('❌ Direct DAQ connection error:', error); });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Sensor update handler
  // ═══════════════════════════════════════════════════════════════════════════

  private handleSensorUpdate(update: SensorUpdate): void {
    if (isNaN(update.value) || !isFinite(update.value)) return;
    if (update.component === 'pressure_psi') {
      if (update.value < this.PSI_ABSOLUTE_MIN || update.value > this.PSI_ABSOLUTE_MAX) return;
    }

    if (this.firstPacketTime === null && (update.entity.startsWith('PT.') || update.entity.startsWith('PT_Cal.') || update.entity.startsWith('ACT.'))) {
      this.firstPacketTime = update.timestamp;
      console.log(`🚀 Mission T+0 set: ${new Date(this.firstPacketTime).toISOString()}`);
      this.broadcast({ type: MessageType.MISSION_START_TIME, timestamp: Date.now(), payload: { missionStartTime: this.firstPacketTime } });
    }

    const key = `${update.entity}.${update.component}`;
    this.sensorCache.set(key, update);
    this.dataLogger.record(key, update.value);

    const now = Date.now();
    const lastBroadcast = this.broadcastLastTime.get(key) ?? 0;
    if (now - lastBroadcast < this.BROADCAST_MIN_INTERVAL_MS) return;
    this.broadcastLastTime.set(key, now);

    // Save to history cache for plots
    // Using relative time from mission start, or absolute if not set
    const timeSec = (update.timestamp - (this.firstPacketTime ?? update.timestamp)) / 1000;
    let series = this.historyCache.get(key);
    if (!series) {
      series = { time: [], values: [] };
      this.historyCache.set(key, series);
    }
    series.time.push(timeSec);
    series.values.push(update.value);
    if (series.time.length > this.HISTORY_MAX_POINTS) {
      series.time.shift();
      series.values.shift();
    }

    this.broadcast({ type: MessageType.SENSOR_UPDATE, timestamp: update.timestamp, payload: update });
    if (this.clients.size === 0 && update.component === 'pressure_psi' && !this._loggedNoFrontendClients) {
      this._loggedNoFrontendClients = true;
      console.warn('⚠️ Backend has no WebSocket clients (frontend not connected?). Open the dashboard at the backend URL (e.g. http://localhost:8082 or port 8081 for WS).');
    }
  }

  private _loggedNoFrontendClients = false;

  /** Push an immediate pressure_psi update for a channel after calibration so the UI reflects the new fit. */
  pushCalibrationUpdate(uniqueId: number): void {
    const coeffs = this.ptCalibration.get(uniqueId);
    const adc = this.lastRawAdc.get(uniqueId);
    if (coeffs == null || adc == null) return;
    const psi = calculatePressure(adc, coeffs);
    if (!isFinite(psi)) return;
    const boardId = Math.floor(uniqueId / 100);
    const channelId = uniqueId % 100;
    let calEntity: string | undefined;
    for (const [ip, bid] of this.ipToBoardId.entries()) {
      if (bid === boardId) {
        const boardMap = this.boardChannelToEntityMaps.get(ip);
        if (boardMap) calEntity = boardMap[channelId] ?? (boardMap as Record<string, string>)[String(channelId)];
        break;
      }
    }
    if (!calEntity) calEntity = this.channelToEntityMap[channelId];
    if (!calEntity) calEntity = `PT_Cal.PT_CH${channelId}`;
    const t = Date.now();
    this.broadcastLastTime.delete(`${calEntity}.pressure_psi`);
    this.broadcastLastTime.delete(`PT_Cal.PT_CH${channelId}.pressure_psi`);
    this.handleSensorUpdate({ entity: calEntity, component: 'pressure_psi', value: psi, timestamp: t });
    this.handleSensorUpdate({ entity: `PT_Cal.PT_CH${channelId}`, component: 'pressure_psi', value: psi, timestamp: t });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Elodin packet handler
  // ═══════════════════════════════════════════════════════════════════════════

  private republishPTDataToElodin(packetId: [number, number], payload: Buffer, parsed: any): void {
    if (!this.elodin.isConnected()) return;
    try { this.elodin.publishTable(packetId, payload); } catch (error) { }
  }

  private _parseNullCount = 0;
  private handleElodinPacket(header: any, payload: Buffer): void {
    try {
      const [high, low] = header.packetId;
      const parsed = parseElodinPacket(header.packetId, payload, {
        channelToEntityMap: this.channelToEntityMap,
        actuatorChannelToEntityMap: this.actuatorChannelToEntityMap,
      });
      if (!parsed) {
        if (header.ty === ElodinPacketType.TABLE && this._parseNullCount < 3) {
          this._parseNullCount++;
          console.warn(`[Relay] TABLE packet not parsed (packetId=0x${high.toString(16)},0x${low.toString(16)}, len=${payload.length})`);
        }
        return;
      }

      let shouldUseElodinValue = true;
      let channelId: number | null = null;

      if (parsed.entity.startsWith('PT_Cal.') && parsed.component === 'pressure_psi') {
        const channelMatch = parsed.entity.match(/PT_CH(\d+)/);
        if (channelMatch) {
          channelId = parseInt(channelMatch[1], 10);
        } else {
          for (const boardMap of this.boardChannelToEntityMaps.values()) {
            for (const [idStr, mapEntity] of Object.entries(boardMap)) {
              if (mapEntity === parsed.entity || mapEntity.replace('PT_Cal.', 'PT.') === parsed.entity) { channelId = parseInt(idStr, 10); break; }
            }
            if (channelId) break;
          }
          if (!channelId) {
            for (const [idStr, mapEntity] of Object.entries(this.channelToEntityMap)) {
              if (mapEntity === parsed.entity || mapEntity.replace('PT_Cal.', 'PT.') === parsed.entity) { channelId = parseInt(idStr, 10); break; }
            }
          }
          if (!channelId) {
            const fallbackMap: Record<string, number> = {
              'PT_Cal.Fuel_Upstream': 1, 'PT_Cal.GSE_Low': 2, 'PT_Cal.Fuel_Downstream': 3, 'PT_Cal.PT_CH3': 3,
              'PT_Cal.Fuel_Fill_Tank': 4, 'PT_Cal.PT_CH4': 4, 'PT_Cal.Ox_Upstream': 5, 'PT_Cal.GN2_Regulated': 6, 'PT_Cal.Ox_Downstream': 7,
            };
            channelId = fallbackMap[parsed.entity] ?? null;
          }
        }

        if (channelId) {
          // Identify which board this entity belongs to (crude but effective)
          let boardId = 1;
          for (const [ip, bId] of this.ipToBoardId.entries()) {
            const boardMap = this.boardChannelToEntityMaps.get(ip);
            if (boardMap && boardMap[channelId] === parsed.entity) { boardId = bId; break; }
          }
          const uniqueId = boardId * 100 + channelId;
          const phase2State = this.phase2Engine?.getSensorState?.(uniqueId);
          if (phase2State && phase2State.rlsUpdateCount > 0) {
            shouldUseElodinValue = false;
          } else {
            this.calibratedPTFromElodin.set(uniqueId, Date.now());
          }
        }
      }

      if (shouldUseElodinValue) {
        const update: SensorUpdate = { entity: parsed.entity, component: parsed.component, value: parsed.value, timestamp: parsed.timestamp };
        // When using relay, data came from DB — do not write back to Elodin (avoids loop; DB is fed only by daq_bridge).
        if (!process.env.ELODIN_RELAY_WS_URL && (parsed.entity.startsWith('PT.') || parsed.entity.startsWith('PT_Cal.'))) {
          this.republishPTDataToElodin(header.packetId, payload, parsed);
        }
        this.handleSensorUpdate(update);
        if (channelId) {
          this.handleSensorUpdate({ entity: `PT_Cal.PT_CH${channelId}`, component: 'pressure_psi', value: parsed.value, timestamp: parsed.timestamp });
        }
        // DB only has raw PT; convert raw → pressure_psi here so frontend gauges get values
        if (parsed.entity.startsWith('PT.') && parsed.component === 'raw_adc_counts' && payload.length >= 9) {
          const rawCh = payload.readUInt8(8);
          const uid = 100 + rawCh;
          const rawAdc = parsed.value;
          this.lastRawAdc.set(uid, Math.round(rawAdc));
          const ts = typeof parsed.timestamp === 'number' && parsed.timestamp > 1e12 ? parsed.timestamp : Date.now();
          let psi: number;
          const coeffs = this.ptCalibration.get(uid) ?? this.ptCalibration.get(rawCh);
          if (coeffs) {
            psi = calculatePressure(rawAdc, coeffs, this.envState);
            if (!isFinite(psi) || isNaN(psi)) psi = (rawAdc / 2147483648) * 500;  // fallback scale
          } else {
            // No calibration: show linear-scaled value so frontend at least shows data
            psi = (rawAdc / 2147483648) * 500;
          }
          const calEntity = this.channelToEntityMap[rawCh] || `PT_Cal.PT_CH${rawCh}`;
          this.handleSensorUpdate({ entity: calEntity, component: 'pressure_psi', value: psi, timestamp: ts });
          this.handleSensorUpdate({ entity: `PT_Cal.PT_CH${rawCh}`, component: 'pressure_psi', value: psi, timestamp: ts });
          const legacyEntity = RELAY_PT_CHANNEL_TO_LEGACY_ENTITY[rawCh];
          if (legacyEntity) this.handleSensorUpdate({ entity: legacyEntity, component: 'pressure_psi', value: psi, timestamp: ts });
        }
        // Emit ACTUATOR_UPDATE so dashboard actuator panels get state (open/closed from raw ADC threshold).
        if (parsed.entity.startsWith('ACT.') && parsed.component === 'raw_adc_counts') {
          const rawAdc = Math.round(parsed.value);
          const state = rawAdc > 1000 ? 1 : 0; // 1 = OPEN, 0 = CLOSED
          const name = parsed.entity.replace('ACT.', '').replace(/_/g, ' ');
          this.broadcast({
            type: MessageType.ACTUATOR_UPDATE,
            timestamp: parsed.timestamp,
            payload: { actuatorId: 0, name, state, rawAdcCounts: rawAdc, timestamp: parsed.timestamp } as ActuatorUpdate,
          });
        }
      }
    } catch (error) { console.error('❌ Error handling Elodin packet:', error); }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WebSocket setup & message handling
  // ═══════════════════════════════════════════════════════════════════════════

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket, req: any) => {
      const clientIP = req.socket?.remoteAddress || 'unknown';
      console.log(`📱 New WebSocket client connected from ${clientIP}`);

      ws.on('error', (error: Error) => { console.error(`❌ WebSocket client error:`, error); });

      const client: Client = { ws, subscribedSensors: new Set(), lastPing: Date.now() };
      this.clients.set(ws, client);

      // Send cached sensor data immediately
      if (this.sensorCache.size > 0) {
        this.sensorCache.forEach((update) => {
          try { this.send(ws, { type: MessageType.SENSOR_UPDATE, timestamp: update.timestamp, payload: update }); } catch (_) { }
        });
      }

      // Send initial status with retry
      let attempts = 0;
      const sendStatus = () => {
        attempts++;
        if (ws.readyState === WebSocket.OPEN) {
          try {
            this.send(ws, { type: MessageType.CONNECTION_STATUS, timestamp: Date.now(), payload: { connected: true, elodinConnected: this.daqDirect?.connected || this.elodinRelay?.isConnected() || this.elodin.isConnected() } as ConnectionStatus });
            const stateToSend = this.currentState ?? SystemState.IDLE;
            this.send(ws, { type: MessageType.STATE_UPDATE, timestamp: Date.now(), payload: { currentState: stateToSend, stateName: SystemState[stateToSend] ?? 'IDLE', timestamp: Date.now(), debugMode: this.debugMode } as StateUpdate });
            sendActuatorExpectedPositionsToClient(this, ws, stateToSend, STATE_ACTUATOR_MAP);
          } catch (error) { console.error('❌ Failed to send connection status:', error); }
        } else if (attempts < 10) { setTimeout(sendStatus, 100); }
      };
      setTimeout(sendStatus, 10);

      ws.on('message', (data: Buffer) => {
        try { this.handleMessage(ws, JSON.parse(data.toString())); } catch (error) { console.error('❌ Failed to parse message:', error); }
      });

      ws.on('close', () => { this.clients.delete(ws); });
      ws.on('error', () => { this.clients.delete(ws); });

      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) { client.lastPing = Date.now(); ws.ping(); }
        else { clearInterval(pingInterval); }
      }, 30000);
    });
  }

  private handleMessage(ws: WebSocket, message: any): void {
    const client = this.clients.get(ws);
    if (!client) return;

    switch (message.type) {
      case MessageType.SUBSCRIBE_SENSOR:
        if (message.payload?.entity) {
          client.subscribedSensors.add(message.payload.entity);
          const pressureKey = `${message.payload.entity}.pressure_psi`;
          const rawKey = `${message.payload.entity}.raw_adc_counts`;
          const cached = this.sensorCache.get(pressureKey) || this.sensorCache.get(rawKey);
          if (cached) this.send(ws, { type: MessageType.SENSOR_UPDATE, timestamp: cached.timestamp, payload: cached });
        }
        break;
      case MessageType.UNSUBSCRIBE_SENSOR:
        if (message.payload?.entity) client.subscribedSensors.delete(message.payload.entity);
        break;
      case MessageType.SEND_COMMAND:
        this.handleCommand(message.payload as CommandPayload);
        break;
      case MessageType.CALIBRATION_COMMAND:
        handleCalibrationCommand(this, ws, message.payload);
        break;
      case 'get_state_transitions':
        this.send(ws, { type: 'state_transitions', timestamp: Date.now(), payload: { transitions: getStateTransitions() } });
        break;
      case MessageType.RESEND_CONFIG:
        // Force resend config to all connected boards by resetting state to pending
        const boardCount = this.boardsStatus.size;
        this.boardsStatus.forEach((_, id) => {
          this.boardConfigState.set(id, { status: 'pending' });
        });
        console.log(`[CONFIG] Resend config requested by client – reset ${boardCount} board(s) to pending, sending now`);
        this.maybeSendConfigPackets();
        break;
      case MessageType.QUERY_HISTORICAL:
        // Send the entire 5 minute history buffer for all sensors to just this client
        const historyPayload: Record<string, { time: number[]; values: number[] }> = {};
        for (const [key, series] of this.historyCache.entries()) {
          historyPayload[key] = {
            time: series.time,
            values: series.values,
          };
        }
        this.send(ws, {
          type: MessageType.HISTORICAL_DATA,
          timestamp: Date.now(),
          payload: historyPayload,
        });
        break;
      default:
        console.warn('⚠️ Unknown message type:', message.type);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Command handling (state transitions, actuator commands, debug mode, etc.)
  // ═══════════════════════════════════════════════════════════════════════════

  private handleCommand(command: CommandPayload): void {
    if (command.commandType === 'state_transition' && !this.elodin.isConnected()) {
      console.error('❌ Cannot send state transition: Elodin not connected');
      this.broadcast({ type: MessageType.ERROR, timestamp: Date.now(), payload: { message: 'Elodin DB not connected', command } });
      return;
    }

    try {
      if (command.commandType === 'state_transition') {
        const newState = command.data.state;
        if (newState === undefined) throw new Error('State transition command missing state');

        const currentState = this.currentState ?? SystemState.IDLE;
        const isEmergency = newState === SystemState.ENGINE_ABORT || newState === SystemState.GSE_ABORT || newState === SystemState.EMERGENCY_ABORT;

        if (this.debugMode && newState !== SystemState.DEBUG) { /* allow */ }
        else if (isEmergency) { /* allow */ }
        else {
          const isAllowed = isTransitionAllowed(currentState, newState);
          if (!isAllowed) {
            this.broadcast({ type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `❌ Invalid state transition: ${SystemState[currentState]} → ${SystemState[newState]}`, command } });
            return;
          }
        }

        const success = this.elodin.sendCommand('state_transition', { state: newState });
        if (success) {
          if (newState === SystemState.ARMED && !this.dataLogger.running) this.dataLogger.start();
          else if ((newState === SystemState.IDLE || newState === SystemState.EMERGENCY_ABORT) && this.dataLogger.running) {
            const stats = this.dataLogger.stop();
            if (stats) console.log(`📝 Run logged: ${stats.filePath}`);
          }

          this.currentState = newState;
          this.broadcast({ type: MessageType.STATE_UPDATE, timestamp: Date.now(), payload: { currentState: newState, stateName: SystemState[newState], timestamp: Date.now(), debugMode: this.debugMode } });

          if (this.debugMode) {
            stopContinuousActuatorCommands(this);
            this.manuallyCommandedChannels.clear();
          } else {
            this.manuallyCommandedChannels.clear();
            if (!this.USE_CPP_CONTROLLER) {
              applyActuatorsForState(this, newState, STATE_ACTUATOR_MAP);
              if (newState === SystemState.IDLE) { stopContinuousActuatorCommands(this); }
              else if (newState === SystemState.FIRE) {
                const fuelInfo = getActuatorBoardInfo(this, 'Fuel Press');
                const loxInfo = getActuatorBoardInfo(this, 'LOX Press');
                if (fuelInfo) this.manuallyCommandedChannels.add(`${fuelInfo.channel}@${fuelInfo.boardIp}`);
                if (loxInfo) this.manuallyCommandedChannels.add(`${loxInfo.channel}@${loxInfo.boardIp}`);
                startContinuousActuatorCommands(this, newState, STATE_ACTUATOR_MAP);
              } else { startContinuousActuatorCommands(this, newState, STATE_ACTUATOR_MAP); }
            } else {
              console.log(`🎯 State changed to ${SystemState[newState]} – relying on C++ PressureStateMachine for automations`);
            }
          }

          broadcastActuatorExpectedPositions(this, newState, STATE_ACTUATOR_MAP);
          if (newState === SystemState.FIRE) {
            if (!this.USE_CPP_CONTROLLER) {
              startControllerLoop(this);
            } else {
              console.log('🎯 FIRE state entered – using C++ controller service; backend will not run controller loop or send PWM');
            }
          } else {
            stopControllerLoop(this);
          }

          // Abort UDP broadcasts (ABORT / ABORT_DONE)
          const isAbortState =
            newState === SystemState.ENGINE_ABORT ||
            newState === SystemState.GSE_ABORT ||
            newState === SystemState.EMERGENCY_ABORT ||
            newState === SystemState.ABORT;
          if (isAbortState) {
            if (this.abortDoneTimer) {
              clearTimeout(this.abortDoneTimer);
              this.abortDoneTimer = null;
            }
            this.sendAbortBroadcast();
            const ABORT_DONE_DELAY_MS = 3000;
            this.abortDoneTimer = setTimeout(() => {
              this.sendAbortDoneBroadcast();
              this.abortDoneTimer = null;
            }, ABORT_DONE_DELAY_MS);
          }
        } else { throw new Error('Failed to send state transition command'); }

      } else if (command.commandType === 'actuator') {
        const { actuatorName: commandActuatorName, actuatorState } = command.data as { actuatorName?: string; actuatorState?: ActuatorState };
        if (actuatorState === undefined || !commandActuatorName) { /* no-op */ }
        else {
          const boardInfo = getActuatorBoardInfo(this, commandActuatorName);
          if (!boardInfo) { console.warn(`⚠️ Actuator "${commandActuatorName}" not found in config`); return; }
          const { channel: channelId, boardIp } = boardInfo;
          const actuatorType = getActuatorType(commandActuatorName);
          const guiState = actuatorState === ActuatorState.OPEN ? 1 : 0;
          const hardwareState = guiStateToHardwareState(guiState, actuatorType);
          this.manuallyCommandedChannels.add(`${channelId}@${boardIp}`);
          const success = sendActuatorCommandUDP(this, channelId, hardwareState, boardIp);
          if (success) {
            this.broadcast({ type: MessageType.ACTUATOR_UPDATE, timestamp: Date.now(), payload: { name: commandActuatorName, state: actuatorState, rawAdcCounts: 0, timestamp: Date.now() } as ActuatorUpdate });
          }
        }
      } else if (command.commandType === 'clear_abort') {
        const current = this.currentState;
        const isAbortState =
          current === SystemState.ENGINE_ABORT ||
          current === SystemState.GSE_ABORT ||
          current === SystemState.EMERGENCY_ABORT ||
          current === SystemState.ABORT;
        const abortState = isAbortState ? current! : SystemState.EMERGENCY_ABORT;

        console.log(`🎯 CLEAR_ABORT command received – syncing actuators to abort pattern for state ${SystemState[abortState]} and broadcasting CLEAR_ABORT`);
        try {
          if (!this.USE_CPP_CONTROLLER) {
            applyActuatorsForState(this, abortState, STATE_ACTUATOR_MAP);
            broadcastActuatorExpectedPositions(this, abortState, STATE_ACTUATOR_MAP);
          } else {
            console.log(`🎯 Relying on C++ PressureStateMachine for CLEAR_ABORT actuator automations`);
          }
        } catch (err) {
          console.error('❌ Failed to apply abort actuator pattern during clear_abort:', err);
        }
        this.sendClearAbortBroadcast();
      } else if (command.commandType === 'pwm_actuator') {
        if (!this.debugMode && this.currentState !== SystemState.FIRE) {
          console.warn('⚠️ PWM commands are only allowed in FIRE state or Debug mode');
          this.broadcast({
            type: MessageType.ERROR,
            timestamp: Date.now(),
            payload: { message: 'PWM commands are only allowed in FIRE state or Debug mode' }
          });
          return;
        }

        const { actuatorName, dutyCycle, frequency, duration } = command.data as { actuatorName?: string; dutyCycle?: number; frequency?: number; duration?: number };
        if (actuatorName && dutyCycle !== undefined) {
          const boardInfo = getActuatorBoardInfo(this, actuatorName);
          if (boardInfo) {
            sendPWMActuatorCommandUDP(this, boardInfo.channel, dutyCycle, frequency || 10, duration || 1000, boardInfo.boardIp);
          } else {
            console.warn(`⚠️ PWM actuator "${actuatorName}" not found in config`);
          }
        }
      } else if (command.commandType === 'controller_command') {
        const { command_type, thrust_desired, altitude_goal } = command.data;
        if (command_type) {
          this.controllerCommand = { command_type: command_type as 'THRUST_DESIRED' | 'ALTITUDE_GOAL', thrust_desired: thrust_desired ?? this.controllerCommand.thrust_desired, altitude_goal: altitude_goal ?? this.controllerCommand.altitude_goal };
        }
      } else if (command.commandType === 'debug_mode') {
        const { debugMode } = command.data;
        if (debugMode !== undefined) {
          this.debugMode = debugMode;
          console.log(`🔧 Debug mode ${this.debugMode ? 'ENABLED' : 'DISABLED'}`);
          if (!this.debugMode && this.currentState !== null) {
            this.manuallyCommandedChannels.clear();
            applyActuatorsForState(this, this.currentState, STATE_ACTUATOR_MAP);
            startContinuousActuatorCommands(this, this.currentState, STATE_ACTUATOR_MAP);
          } else if (this.debugMode) {
            stopContinuousActuatorCommands(this);
            this.manuallyCommandedChannels.clear();
          }
          if (this.currentState !== null) {
            this.broadcast({ type: MessageType.STATE_UPDATE, timestamp: Date.now(), payload: { currentState: this.currentState, stateName: SystemState[this.currentState], timestamp: Date.now(), debugMode: this.debugMode } });
          }
        }
      }
    } catch (error) {
      console.error('❌ Command error:', error);
      this.broadcast({ type: MessageType.ERROR, timestamp: Date.now(), payload: { message: `Command failed: ${error}`, command } });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Update loop, broadcast, send, shutdown
  // ═══════════════════════════════════════════════════════════════════════════

  private startUpdateLoop(): void {
    this.updateInterval = setInterval(() => { }, 50);

    // Robust Calibration Status Loop (Sync or Sidecar)
    setInterval(async () => {
      if (this.clients.size === 0) return;

      if (this.calibrationSidecar && this.calibrationSidecar.enabled) {
        try {
          const status = await this.calibrationSidecar.getStatus();
          if (status && status.channels) {
            // Update local coefficients map from sidecar status
            for (const ch of status.channels) {
              if (ch.coeffs) this.ptCalibration.set(ch.sensorId, ch.coeffs);
            }
            this.broadcast({ type: MessageType.CALIBRATION_STATUS, timestamp: Date.now(), payload: { ...status, calibrationFilePath: this.ptCalibrationFilePath } });
            return;
          }
        } catch (e: any) {
          console.warn(`⚠️ Sidecar status sync failed: ${e.message}`);
        }
      }

      // Fallback to internal engine status if sidecar fails or is disabled
      if (this.phase2Engine && this.phase2Engine.isEnabled()) {
        const channels = this.phase2Engine.getAllStatus();
        if (channels.length > 0) {
          this.broadcast({ type: MessageType.CALIBRATION_STATUS, timestamp: Date.now(), payload: { channels, phase2Enabled: true, timestamp: Date.now(), calibrationFilePath: this.ptCalibrationFilePath } });
        }
      }
    }, 2000);

    // Broadcast board heartbeat / connection status to all clients every second
    setInterval(() => {
      // Drive config state machine on a slow loop as well (for late-connecting boards)
      this.maybeSendConfigPackets();
      this.broadcastBoardStatus();
    }, 1000);

    // Broadcast server heartbeat to all boards at configured interval
    if (this.serverHeartbeatTimer) {
      clearInterval(this.serverHeartbeatTimer);
    }
    this.serverHeartbeatTimer = setInterval(() => {
      this.sendServerHeartbeatUDP();
    }, this.serverHeartbeatIntervalMs);
  }

  /**
   * Send SERVER_HEARTBEAT packet via UDP broadcast.
   * Packet format (DAQv2Comms):
   *   Header: [packet_type(1)=2, version(1)=0, timestamp_ms(4, LE)]
   *   Body:   [engine_state(1)] where engine_state is SystemState numeric code.
   */
  private sendServerHeartbeatUDP(): void {
    if (!this.actuatorSocket || !this.actuatorSocketBroadcastReady) {
      return;
    }
    try {
      const packetType = 2; // SERVER_HEARTBEAT
      const version = 0;
      const timestamp = Date.now() >>> 0;
      const engineCode = (this.currentState ?? SystemState.IDLE) as number;

      const buffer = Buffer.allocUnsafe(7);
      buffer.writeUInt8(packetType, 0);
      buffer.writeUInt8(version, 1);
      buffer.writeUInt32LE(timestamp, 2);
      buffer.writeUInt8(engineCode, 6);

      this.actuatorSocket.send(
        buffer,
        0,
        buffer.length,
        this.serverBroadcastPort,
        this.serverBroadcastIP,
        (err) => {
          if (err) {
            console.error(
              `❌ Failed to send SERVER_HEARTBEAT to ${this.serverBroadcastIP}:${this.serverBroadcastPort}:`,
              err,
            );
          }
        },
      );
    } catch (err) {
      console.error('❌ Error while constructing/sending SERVER_HEARTBEAT packet:', err);
    }
  }

  /**
   * Broadcast an ABORT packet (header-only) to all boards.
   */
  private sendAbortBroadcast(): void {
    this.sendSimpleBroadcastPacket(7, 'ABORT');
  }

  /**
   * Broadcast an ABORT_DONE packet (header-only) to all boards.
   */
  private sendAbortDoneBroadcast(): void {
    this.sendSimpleBroadcastPacket(8, 'ABORT_DONE');
  }

  /**
   * Broadcast a CLEAR_ABORT packet (header-only) to all boards.
   */
  private sendClearAbortBroadcast(): void {
    this.sendSimpleBroadcastPacket(9, 'CLEAR_ABORT');
  }

  /**
   * Helper for header-only UDP broadcast packets that share the same format:
   *   [packet_type(1), version(1)=0, timestamp_ms(4, LE)]
   */
  private sendSimpleBroadcastPacket(packetType: number, label: string): void {
    if (!this.actuatorSocket || !this.actuatorSocketBroadcastReady) return;
    try {
      const version = 0;
      const timestamp = Date.now() >>> 0;
      const buffer = Buffer.allocUnsafe(6);
      buffer.writeUInt8(packetType, 0);
      buffer.writeUInt8(version, 1);
      buffer.writeUInt32LE(timestamp, 2);

      this.actuatorSocket.send(
        buffer,
        0,
        buffer.length,
        this.serverBroadcastPort,
        this.serverBroadcastIP,
        (err) => {
          if (err) {
            console.error(
              `❌ Failed to send ${label} packet to ${this.serverBroadcastIP}:${this.serverBroadcastPort}:`,
              err,
            );
          }
        },
      );
    } catch (err) {
      console.error(`❌ Error while constructing/sending ${label} packet:`, err);
    }
  }

  /** Build a snapshot of current board status suitable for WebSocket broadcast. */
  private getBoardStatusSnapshot(): BoardStatus[] {
    const now = Date.now();
    const timeoutMs = 2500; // treat as disconnected if no heartbeat for >2.5 s
    const result: BoardStatus[] = [];

    this.boardsStatus.forEach((status) => {
      const last = status.lastHeartbeatMs;
      const isConnected = last != null && now - last <= timeoutMs;

      if (this.designatedSurvivorBoardId !== null && status.id === this.designatedSurvivorBoardId) {
        this.designatedSurvivorConnected = isConnected;
      }

      let frequencyHz: number | null = null;
      if (status.heartbeatTimes.length >= 2) {
        const span = status.heartbeatTimes[status.heartbeatTimes.length - 1] - status.heartbeatTimes[0];
        if (span > 0) {
          const count = status.heartbeatTimes.length - 1;
          frequencyHz = count / (span / 1000);
        }
      }

      const registry = this.boardRegistryById.get(status.id);
      const configState = this.boardConfigState.get(status.id);
      // Show "Config sent" if we sent it, OR if the board reports Setup/Active (firmware only enters these after config)
      const weSentConfig = configState?.status === 'sent';
      const boardReportsConfigured = status.boardState === 1 || status.boardState === 2; // 1=Setup, 2=Active
      const configured = weSentConfig || boardReportsConfigured;

      result.push({
        type: status.type,
        boardNumber: status.boardNumber,
        id: status.id,
        ip: status.ip,
        expected: status.expected,
        connected: isConnected,
        lastHeartbeatMs: last ?? null,
        frequencyHz,
        boardState: status.boardState,
        engineState: status.engineState,
        configured,
        configLastSentAt: configState?.status === 'sent' ? configState.lastSentAt : undefined,
        configError: configState?.status === 'error' ? configState.errorMessage : undefined,
        necessaryForAbort: registry?.necessaryForAbort ?? false,
        designatedSurvivor: registry?.designatedSurvivor ?? false,
        voltageReference: registry?.voltageReference ?? 0,
      });
    });

    // Sort by type, then boardNumber, then id for stable display
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      const an = a.boardNumber ?? Number.MAX_SAFE_INTEGER;
      const bn = b.boardNumber ?? Number.MAX_SAFE_INTEGER;
      if (an !== bn) return an - bn;
      return a.id - b.id;
    });

    return result;
  }

  /** Broadcast current board status to all clients (e.g. right after config is sent so UI and state/engine update). */
  private broadcastBoardStatus(): void {
    if (this.clients.size === 0) return;
    const snapshot = this.getBoardStatusSnapshot();
    if (snapshot.length === 0) return;
    this.broadcast({
      type: MessageType.BOARD_STATUS_UPDATE,
      timestamp: Date.now(),
      payload: { boards: snapshot },
    });
  }

  private async syncSidecarCoefficients(): Promise<void> {
    if (!this.calibrationSidecar || !this.calibrationSidecar.enabled) return;
    try {
      const status = await this.calibrationSidecar.getStatus();
      if (status && status.channels) {
        console.log(`🤖 Syncing ${status.channels.length} robust coefficients from sidecar...`);
        for (const ch of status.channels) {
          const prevCoeffs = this.ptCalibration.get(ch.sensorId);
          // Compare offset (index 0) and linear term (index 1) for significant change
          const coeffsChanged = !prevCoeffs ||
            Math.abs(prevCoeffs.D - ch.coeffs.D) > 0.1 ||
            Math.abs(prevCoeffs.C - ch.coeffs.C) > 1e-10;

          if (ch.coeffs) this.ptCalibration.set(ch.sensorId, ch.coeffs);

          if (coeffsChanged) {
            // Reset glitch filters so the sensor doesn't "freeze" due to the jump rejection
            this.lastGoodPsi.delete(ch.sensorId);
            this.recentPsiReadings.delete(ch.sensorId);
          }
        }
        // Broadcast the new status immediately to update UI (latencies hiding)
        this.broadcast({ type: MessageType.CALIBRATION_STATUS, timestamp: Date.now(), payload: { ...status, calibrationFilePath: this.ptCalibrationFilePath } });
      }
    } catch (e: any) {
      console.warn(`🤖 Sidecar sync error: ${e.message}`);
    }
  }

  getDebugInfo(): DebugInfo {
    return {
      relayConnected: this.elodinRelay?.isConnected() ?? false,
      relayPacketsReceived: this.relayPacketCount,
      wsClients: this.clients.size,
      sensorCacheSize: this.sensorCache.size,
      useRelay: !!process.env.ELODIN_RELAY_WS_URL,
    };
  }

  broadcast(message: any): void {
    if (this.messageLogger) this.messageLogger.logMessage(message);
    if (this.clients.size === 0) return;

    const data = JSON.stringify(message);
    this.clients.forEach((client, ws) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        try { client.ws.send(data); } catch (error) { console.error('❌ Failed to send to client:', error); }
      } else if (client.ws.readyState === WebSocket.CLOSED || client.ws.readyState === WebSocket.CLOSING) {
        this.clients.delete(ws);
      }
    });
  }

  send(ws: WebSocket, message: any): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  /**
   * Build and send SENSOR_CONFIG/ACTUATOR_CONFIG from this server to each board (UDP to board IP:5005).
   * Config is not sent "between boards" – the server sends to every board. Sending is gated on the
   * designated survivor actuator board being connected (heartbeat in last 2.5s).
   */
  private maybeSendConfigPackets(): void {
    if (!this.designatedSurvivorBoardId || !this.designatedSurvivorIP) {
      const now = Date.now();
      if (now - this.lastConfigBlockedLogMs >= 15000) {
        this.lastConfigBlockedLogMs = now;
        console.warn('[CONFIG] Not sending: no designated survivor in config (set designated_survivor = true on one ACTUATOR board in config.toml)');
      }
      return;
    }
    // Config is sent regardless of whether the designated survivor board is currently connected.
    if (!this.actuatorSocket) {
      console.warn('[CONFIG] Cannot send: actuator/config UDP socket not initialized');
      return;
    }
    const now = Date.now();
    const timeoutMs = 2500;
    let pendingCount = 0;
    this.boardsStatus.forEach((status, id) => {
      const last = status.lastHeartbeatMs;
      const isConnected = last != null && now - last <= timeoutMs;
      if (!isConnected) return;

      // Prefer registry by id; PT/sense boards may send a different id in heartbeat, so fall back to lookup by IP
      let registry = this.boardRegistryById.get(id);
      const matchedByIp = !registry && !!status.ip;
      if (!registry && status.ip) {
        for (const [, reg] of this.boardRegistryById) {
          if (reg.ip === status.ip) {
            registry = reg;
            break;
          }
        }
      }
      if (!registry) {
        console.log(`[CONFIG] Skip board id=${id} ip=${status.ip ?? 'unknown'}: no registry (id not in config, IP not in config)`);
        return;
      }
      if (matchedByIp) {
        console.log(`[CONFIG] Board heartbeat id=${id} matched config by IP ${status.ip} → type=${registry.type} (config board_id may differ)`);
      }

      const cfg = this.boardConfigState.get(id) ?? { status: 'pending' as const };
      if (cfg.status === 'sent') return;

      pendingCount++;

      if (registry.type === 'ACTUATOR') {
        // Send ACTUATOR_CONFIG when actuator board connects for the first time
        if (!this.designatedSurvivorBoardId || !this.designatedSurvivorIP) {
          return;
        }
        try {
          const isAbortController = id === this.designatedSurvivorBoardId ? 1 : 0;
          const enableSerialPrinting = registry.enableSerialPrinting ? 1 : 0;
          const targetPort = 5005;
          const destIP = status.ip;
          const packet = this.buildActuatorConfigPacket(isAbortController, enableSerialPrinting);
          if (!packet) {
            console.warn(`[CONFIG] buildActuatorConfigPacket returned null for board ${id}, skipping`);
            return;
          }
          console.log(
            `[CONFIG] Sending ACTUATOR_CONFIG to board ${id} (${destIP}:${targetPort}) – is_abort_controller=${isAbortController} packet_len=${packet.length}`
          );
          this.actuatorSocket!.send(packet, targetPort, destIP, (err) => {
            if (err) {
              console.error(`[CONFIG] Failed ACTUATOR_CONFIG to board ${id} (${destIP}:${targetPort}):`, err.message);
              this.boardConfigState.set(id, {
                status: 'error',
                lastSentAt: Date.now(),
                errorMessage: err.message || 'UDP send error',
              });
            } else {
              console.log(`[CONFIG] ACTUATOR_CONFIG sent OK → board ${id} (${destIP})`);
              this.boardConfigState.set(id, {
                status: 'sent',
                lastSentAt: Date.now(),
              });
            }
            this.broadcastBoardStatus();
          });
        } catch (err: any) {
          console.error(`[CONFIG] Failed to build ACTUATOR_CONFIG for board ${id}:`, err?.message ?? err);
          this.boardConfigState.set(id, {
            status: 'error',
            lastSentAt: Date.now(),
            errorMessage: String(err?.message || err),
          });
        }
        return;
      }

      // SENSOR_CONFIG for sense boards
      const sensorChannels = registry.sensorChannels || [];
      const necessaryForAbort = registry.necessaryForAbort;

      if (!this.designatedSurvivorIP) {
        if (!this._lastDesignatedSurvivorWarn || Date.now() - this._lastDesignatedSurvivorWarn > 60000) {
          console.warn(`⚠️ skipping SENSOR_CONFIG for board ${id}: no designated survivor actuator board`);
          this._lastDesignatedSurvivorWarn = Date.now();
        }
        return;
      }

      try {
        const targetPortSensor = 5005;
        const destIP = status.ip;
        console.log(`[CONFIG] Sending SENSOR_CONFIG to board ${id} (${destIP}:${targetPortSensor}) – channels=[${sensorChannels.join(',')}] necessary_for_abort=${necessaryForAbort}`);
        const packet = this.buildSensorConfigPacket(
          sensorChannels,
          registry.voltageReference ?? 0,
          necessaryForAbort,
          this.designatedSurvivorIP,
          registry.enableSerialPrinting ?? false,
        );

        // DAQ boards listen for config on port 5005 by convention; send to actual heartbeat source IP
        this.actuatorSocket!.send(packet, targetPortSensor, destIP, (err) => {
          if (err) {
            console.error(`[CONFIG] Failed SENSOR_CONFIG to board ${id} (${destIP}:${targetPortSensor}):`, err.message);
            this.boardConfigState.set(id, {
              status: 'error',
              lastSentAt: Date.now(),
              errorMessage: err.message || 'UDP send error',
            });
          } else {
            console.log(
              `[CONFIG] SENSOR_CONFIG sent OK → board ${id} (${destIP}) channels=[${sensorChannels.join(',')}] `
            );
            this.boardConfigState.set(id, {
              status: 'sent',
              lastSentAt: Date.now(),
            });
          }
          this.broadcastBoardStatus();
        });
      } catch (err: any) {
        console.error(`[CONFIG] Failed to build SENSOR_CONFIG for board ${id}:`, err?.message ?? err);
        this.boardConfigState.set(id, {
          status: 'error',
          lastSentAt: Date.now(),
          errorMessage: String(err?.message || err),
        });
      }
    });

    if (pendingCount > 0) {
      this.lastConfigBlockedLogMs = 0; // reset so next time we're blocked we log again
    }
  }

  /**
   * Build ACTUATOR_CONFIG packet (header + body).
   * Body: is_abort_controller (1B), N (1B), N x AbortActuatorLocation (7B each), X (1B), X x AbortPTLocation (9B each), enable_serial_printing (1B).
   * IPs big-endian; threshold_adc_code little-endian.
   */
  private buildActuatorConfigPacket(is_abort_controller: number, enable_serial_printing: number): Buffer | null {
    const config = readConfig();
    const actuatorRoles = (config.actuator_roles || {}) as Record<string, [string, number] | [string, number, number] | [string, number, string]>;
    // Abort PTs use sensor roles from PT board #1 (board_id 21) = sensor_roles_pt_board
    const sensorRoles = (config.sensor_roles_pt_board || config.sensor_roles || {}) as Record<string, number>;
    const abortPts = (config.abort_pts || {}) as Record<string, number>;
    const boards = (config.boards || {}) as Record<string, any>;

    if (!this.designatedSurvivorIP) {
      return null;
    }

    const ipToU32BE = (ip: string): number => {
      const octets = ip.split('.').map((p) => Number(p));
      if (octets.length !== 4 || octets.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
        throw new Error(`Invalid IP: ${ip}`);
      }
      return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    };

    /** Resolve board_id to IP from config.boards (actuators mapped by board_id, not IP). */
    const boardIdToIp = new Map<number, string>();
    for (const [, board] of Object.entries(boards)) {
      const id = typeof board?.id === 'number' ? board.id : (typeof board?.board_id === 'number' ? board.board_id : null);
      const ip = typeof board?.ip === 'string' ? board.ip : (id != null ? `192.168.2.${id}` : '');
      if (id != null && ip) boardIdToIp.set(id, ip);
    }

    // First PT board IP for abort PT blocks (PT board #1 = board_id 21)
    let ptBoardIP: string | null = null;
    for (const [, reg] of this.boardRegistryById) {
      if (reg.type === 'PT') {
        ptBoardIP = reg.ip;
        break;
      }
    }

    // Build N abort actuator blocks (actuator_roles; each actuator's IP from its board_id)
    const abortActuators: Array<{ ip: number; actuator_id: number; vent_state: number; abort_state: number }> = [];
    for (const [_, value] of Object.entries(actuatorRoles)) {
      if (!Array.isArray(value) || value.length < 2) continue;
      const actuatorId = Number(value[1]);
      if (!Number.isFinite(actuatorId) || actuatorId < 1 || actuatorId > 255) continue;
      let actuatorIP = this.designatedSurvivorIP;
      if (value.length >= 3) {
        if (typeof value[2] === 'number') {
          actuatorIP = boardIdToIp.get(value[2]) || actuatorIP;
        } else if (typeof value[2] === 'string') {
          actuatorIP = value[2];
        }
      }
      const ventState = (STATE_ACTUATOR_MAP[SystemState.VENT] && STATE_ACTUATOR_MAP[SystemState.VENT][actuatorId]) ?? 0;
      const abortState = (STATE_ACTUATOR_MAP[SystemState.ENGINE_ABORT] && STATE_ACTUATOR_MAP[SystemState.ENGINE_ABORT][actuatorId]) ?? 0;
      abortActuators.push({
        ip: ipToU32BE(actuatorIP),
        actuator_id: actuatorId,
        vent_state: ventState ? 1 : 0,
        abort_state: abortState ? 1 : 0,
      });
    }

    // Build X abort PT blocks (abort_pts + sensor_roles + calibration inverse)
    const abortPtsList: Array<{ ip: number; sensor_id: number; threshold_adc_code: number }> = [];
    for (const [roleName, thresholdPsi] of Object.entries(abortPts)) {
      const sensorId = sensorRoles[roleName];
      if (sensorId == null || !Number.isFinite(sensorId) || sensorId < 1 || sensorId > 255) {
        console.warn(`⚠️ abort_pts: no sensor_roles entry for "${roleName}", skipping`);
        continue;
      }
      const coeffs = this.ptCalibration.get(sensorId);
      if (!coeffs) {
        console.warn(`⚠️ abort_pts: no calibration for sensor_id ${sensorId} ("${roleName}"), skipping`);
        continue;
      }
      const adcCode = inversePressureToAdc(Number(thresholdPsi), coeffs);
      if (!Number.isFinite(adcCode) || adcCode < 0) {
        console.warn(`⚠️ abort_pts: inversePressureToAdc(${thresholdPsi}, ...) failed for "${roleName}", skipping`);
        continue;
      }
      if (!ptBoardIP) {
        console.warn('⚠️ abort_pts: no PT board in config, skipping abort PT blocks');
        break;
      }
      abortPtsList.push({
        ip: ipToU32BE(ptBoardIP),
        sensor_id: sensorId,
        threshold_adc_code: Math.round(adcCode) >>> 0,
      });
    }

    const N = Math.min(abortActuators.length, 255);
    const X = Math.min(abortPtsList.length, 255);
    const headerSize = 6;
    const bodySize = 1 + 1 + N * 7 + 1 + X * 9 + 1;
    const totalSize = headerSize + bodySize;
    const buffer = Buffer.allocUnsafe(totalSize);

    const timestamp = (Math.floor(Date.now()) >>> 0);
    buffer.writeUInt8(6, 0);   // ACTUATOR_CONFIG
    buffer.writeUInt8(0, 1);   // version
    buffer.writeUInt32LE(timestamp, 2);

    let offset = headerSize;
    buffer.writeUInt8(is_abort_controller, offset++);
    buffer.writeUInt8(N, offset++);

    for (let i = 0; i < N; i++) {
      const a = abortActuators[i];
      buffer.writeUInt32BE(a.ip, offset); offset += 4;
      buffer.writeUInt8(a.actuator_id, offset++);
      buffer.writeUInt8(a.vent_state, offset++);
      buffer.writeUInt8(a.abort_state, offset++);
    }

    buffer.writeUInt8(X, offset++);
    for (let i = 0; i < X; i++) {
      const p = abortPtsList[i];
      buffer.writeUInt32BE(p.ip, offset); offset += 4;
      buffer.writeUInt8(p.sensor_id, offset++);
      buffer.writeUInt32LE(p.threshold_adc_code, offset); offset += 4;
    }

    buffer.writeUInt8(enable_serial_printing ? 1 : 0, offset++);

    return buffer;
  }

  /**
   * Construct a DAQv2 SENSOR_CONFIG packet.
   * Body layout (after 6-byte header):
   *   num_sensors (1 byte)
   *   sensor_ids  (N bytes, 1-byte each)
   *   reference_voltage (1 byte: 0=Internal 2.5V, 1=VDD, 2=5V)
   *   necessary_for_abort (1 byte, 0/1)
   *   designated_survivor_ip (4 bytes, big-endian IPv4)
   *   enable_serial_printing (1 byte, 0/1)
   */
  private buildSensorConfigPacket(
    sensorChannels: number[],
    referenceVoltage: number,
    necessaryForAbort: boolean,
    designatedSurvivorIP: string,
    enableSerialPrinting: boolean,
  ): Buffer {
    const sanitized = sensorChannels
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v >= 1 && v <= 255);

    const numSensors = Math.min(sanitized.length, 255);
    const bodyLength = 1 + numSensors + 1 + 1 + 4 + 1;
    const totalLength = 6 + bodyLength;
    const buffer = Buffer.allocUnsafe(totalLength);

    const timestamp = (Math.floor(Date.now()) >>> 0);

    // Header: packet_type=5 (SENSOR_CONFIG), version=0, timestamp LE
    buffer.writeUInt8(5, 0);
    buffer.writeUInt8(0, 1);
    buffer.writeUInt32LE(timestamp, 2);

    // Body
    let offset = 6;
    buffer.writeUInt8(numSensors, offset++);

    for (let i = 0; i < numSensors; i++) {
      buffer.writeUInt8(sanitized[i], offset++);
    }

    buffer.writeUInt8(Math.min(2, Math.max(0, referenceVoltage)), offset++);
    buffer.writeUInt8(necessaryForAbort ? 1 : 0, offset++);

    const ipOctets = designatedSurvivorIP.split('.').map((part) => Number(part));
    if (ipOctets.length !== 4 || ipOctets.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
      throw new Error(`Invalid designated survivor IP address: ${designatedSurvivorIP}`);
    }
    const ipInt = (((ipOctets[0] ?? 0) << 24) | ((ipOctets[1] ?? 0) << 16) | ((ipOctets[2] ?? 0) << 8) | (ipOctets[3] ?? 0)) >>> 0;
    buffer.writeUInt32BE(ipInt, offset);
    offset += 4;

    buffer.writeUInt8(enableSerialPrinting ? 1 : 0, offset++);

    return buffer;
  }

  shutdown(): void {
    if (this.updateInterval) clearInterval(this.updateInterval);
    if (this.relayReconnectTimer) { clearInterval(this.relayReconnectTimer); this.relayReconnectTimer = null; }
    this.elodinRelay?.disconnect();
    this.elodin.disconnect();
    this.wss.close();
  }
}

// Start servers
const server = new SensorSystemServer();
startAPIServer(
  () => (server as any).queryClient || null,
  () => server.getDebugInfo()
);

process.on('SIGINT', () => { console.log('\n🛑 Shutting down server...'); server.shutdown(); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n🛑 Shutting down server...'); server.shutdown(); process.exit(0); });

console.log(`🚀 WebSocket server starting on ${WS_HOST}:${WS_PORT}`);
console.log(`📡 Connecting to Elodin DB at ${ELODIN_HOST}:${ELODIN_PORT}`);
console.log(`🌐 External clients can connect via: ws://<your-ip>:${WS_PORT}`);
