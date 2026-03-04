/**
 * WebSocket Server for Sensor System GUI
 * Bridges Elodin DB to WebSocket clients with <30ms latency
 *
 * This is the orchestrator — heavy logic lives in extracted modules:
 *   server-types.ts       — shared types, interfaces, constants
 *   sensor-config.ts      — sensor role loading, HP PT config, ADC→PSI conversion
 *   actuator-control.ts   — UDP commands, board mapping, NC/NO, continuous commands
 *   calibration-handler.ts — zero_all, capture_reference, save/clear coefficients
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ElodinClient, ElodinPacketType } from './elodin-client.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { ElodinQueryClient } from './elodin-query.js';
import { parseElodinPacket } from './elodin-protocol.js';
import { registerControllerVTables } from './elodin-vtable-controller.js';
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
  NotificationPayload,
} from './shared-types.js';

// ── Extracted modules ──────────────────────────────────────────────────────────
import { Client, HpPtBoardConfig, WS_PORT, WS_HOST, ELODIN_HOST, ELODIN_PORT, ACTUATOR_CHANNEL_BY_NAME } from './server-types.js';
import { loadSensorRoleMap, loadHpPtConfig, loadActuatorChannelToEntityMap, convertHpPtToPressure, loadTcBoardConfig, loadRtdBoardConfig, loadLcBoardConfig, rawRtdToTemperatureC } from './sensor-config.js';
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
  forwardStateToActuatorService,
  forwardActuatorToActuatorService,
  forwardFireStateToControllerService,
} from './actuator-control.js';
import { handleCalibrationCommand } from './calibration-handler.js';

// ── Expected actuator positions per state (loaded from state_machine_actuators.csv) ─
let STATE_ACTUATOR_MAP: StateActuatorMap = {};

// Legacy entity map removed — now uses this.channelToEntityMap from config.toml

class SensorSystemServer {
  private wss: WebSocketServer;
  elodin: ElodinClient;
  private elodinRelay: ElodinRelayClient | null = null;
  private queryClient: ElodinQueryClient | null = null;
  private clients: Map<WebSocket, Client> = new Map();
  sensorCache: Map<string, SensorUpdate> = new Map();
  private updateInterval: NodeJS.Timeout | null = null;
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
  /** Port of C++ actuator_service (TCP). When set, state transitions are forwarded there instead of sending UDP directly. */
  actuatorServicePort: number = 0;
  controllerServicePort: number = 0;
  actuatorBoardMap: Map<string, { channel: number; boardIp: string }> = new Map();
  actuatorBoardIPs: Set<string> = new Set();
  private tcBoards: Map<string, Set<number>> = new Map();
  private rtdBoards: Map<string, Set<number>> = new Map();
  private lcBoards: Map<string, Set<number>> = new Map();

  /** Throttle Phase 2 monitoring to ~5 Hz per channel */
  private phase2LastMonitor: Map<number, number> = new Map();
  ipToBoardId: Map<string, number> = new Map();
  private readonly PHASE2_MONITOR_INTERVAL_MS = 200;

  private readonly PSI_ABSOLUTE_MIN = -50;   // physically impossible below -50 PSI
  private readonly PSI_ABSOLUTE_MAX = 6000;  // max expected sensor range (HP PT up to 5000 PSI)
  private _psiDebugLogged?: Set<number>;  // temp: track which channels we've logged

  /** Throttle WS broadcasts per entity to ~30 Hz */
  private broadcastLastTime: Map<string, number> = new Map();
  private readonly BROADCAST_MIN_INTERVAL_MS = 33;

  /** History cache for plots (last 5 minutes at 30Hz = 9000 points per entity.component) */
  private historyCache: Map<string, { time: number[]; values: number[] }> = new Map();
  private readonly HISTORY_MAX_POINTS = 9000;

  /** Binary data logger for runs */
  private dataLogger = new DataLogger();
  private _lastSensorLog = 0;

  /** Track calibrated PT from Elodin per channel */
  private calibratedPTFromElodin: Map<number, number> = new Map();

  /** When true: use only calibrated from Elodin (calibration_service); no backend raw→psi */
  private readonly USE_CALIBRATION_SERVICE_CALIBRATED: boolean;

  /** Mission T+0 */
  private firstPacketTime: number | null = null;

  /** State & debug */
  currentState: SystemState | null = null;
  private debugMode: boolean = false;
  actuatorCommandInterval: NodeJS.Timeout | null = null;
  readonly ACTUATOR_COMMAND_INTERVAL_MS = 1000;
  manuallyCommandedChannels: Set<string> = new Set();

  // SERVER_HEARTBEAT sending removed — daq_bridge owns it; keep broadcast addr for ABORT packets
  private serverBroadcastPort: number = 5005;
  private serverBroadcastIP: string = '255.255.255.255';
  private serverHeartbeatIntervalMs: number = 1000;
  private serverHeartbeatTimer: NodeJS.Timeout | null = null;
  /** Abort → AbortDone timer */
  private abortDoneTimer: NodeJS.Timeout | null = null;

  /** Controller — always C++ controller_service */
  USE_CPP_CONTROLLER: boolean = true;

  /** Sensor maps (from config.toml; used so DB and backend are a replica of config) */
  channelToEntityMap: Record<number, string> = {};
  boardChannelToEntityMaps: Map<string, Record<number, string>> = new Map();
  actuatorChannelToEntityMap: Record<number, string> = {};
  private hpPtBoards: Map<string, HpPtBoardConfig> = new Map();
  private excitationAdcCache: Map<string, number> = new Map();
  private hpPtExcitationWarnAt: Map<string, number> = new Map();

  /** Cache of recent raw ADC values per sensor for Phase 1 capture */
  lastRawAdc: Map<number, number> = new Map();
  /** PT raw packet low byte → uniqueId (boardId*100+channelId) for calibration lookup */
  private packetLowToUniqueId: Map<number, number> = new Map();

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
    /** True if this board is the designated survivor actuator controller. */
    designatedSurvivor: boolean;
    /** If true, board will enable serial debug printing when config is applied. */
    enableSerialPrinting: boolean;
    necessaryForAbort: boolean;
    sensorChannels: number[];
    voltageReference: number;
  }> = new Map();
  private _lastDesignatedSurvivorWarn: number = 0;

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

  /** Per-board config state for ACTUATOR_CONFIG tracking. */
  private boardConfigState: Map<number, { status: 'pending' | 'sent' | 'error'; lastSentAt?: number; errorMessage?: string }> = new Map();

  /** Designated survivor actuator board (from config.toml) — for ACTUATOR_CONFIG abort logic. */
  private designatedSurvivorBoardId: number | null = null;
  private designatedSurvivorIP: string | null = null;

  /** Notification system: previous board connected state for transition detection */
  private previousBoardConnected: Map<number, boolean> = new Map();
  /** First time we saw board in SETUP (boardState === 1), for "stuck in setup" detection */
  private boardFirstSeenSetupMs: Map<number, number> = new Map();
  /** Keys for which we have emitted ongoing: true (so we only emit ongoing: false when they clear) */
  private activeNotificationKeys: Set<string> = new Set();
  private readonly SETUP_STUCK_THRESHOLD_MS = 4000;
  private readonly BOARD_STATE_SETUP = 1;

  constructor() {
    console.log(`🚀 Starting Sensor System Server...`);
    console.log(`   WebSocket: ${WS_HOST}:${WS_PORT}`);
    console.log(`   Elodin DB: ${ELODIN_HOST}:${ELODIN_PORT}`);

    this.firstPacketTime = null;

    // Load config
    const config = readConfig();

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

    // Use calibration_service calibrated only when explicitly enabled. Default: backend does raw→psi from ptCalibration.
    // This ensures consistent calibrated values when calibration_service/sidecar differs from expected.
    this.USE_CALIBRATION_SERVICE_CALIBRATED = process.env.USE_CALIBRATION_SERVICE_CALIBRATED === 'true';
    console.log('📐 Backend calibration: raw ADC → PSI via ptCalibration');


    // Load broadcast config from config.toml [server_heartbeat] — used for ABORT/CLEAR_ABORT UDP
    try {
      const hb = (config as any).server_heartbeat || {};
      this.serverBroadcastPort = (typeof hb.broadcast_port === 'number' && hb.broadcast_port > 0)
        ? hb.broadcast_port : this.actuatorPort;
      if (typeof hb.broadcast_ip === 'string' && hb.broadcast_ip.length > 0) {
        this.serverBroadcastIP = hb.broadcast_ip;
      }
    } catch (_) {
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

    // Load TC board configs
    this.tcBoards = loadTcBoardConfig();
    this.rtdBoards = loadRtdBoardConfig();
    this.lcBoards = loadLcBoardConfig();

    console.log('🎯 Using C++ controller service – web backend ControllerClient disabled');

    // Load state actuator map from CSV
    STATE_ACTUATOR_MAP = getStateActuatorMap();
    if (Object.keys(STATE_ACTUATOR_MAP).length === 0) {
      console.warn('⚠️ No state actuator map loaded - actuators will not auto-command');
    } else {
      console.log(`📋 Loaded state actuator map: ${Object.keys(STATE_ACTUATOR_MAP).length} states`);
    }

    // Load actuator board mappings (extracted module)
    loadActuatorBoardMap(config, this);

    // Actuator service (C++) — backend forwards state transitions to it when port is set.
    // Set ACTUATOR_SERVICE_ENABLED=false to force direct UDP even when config has a port.
    const actSvc = (config as any).actuator_service;
    const actSvcEnabled = process.env.ACTUATOR_SERVICE_ENABLED !== 'false';
    if (actSvcEnabled) {
      if (process.env.ACTUATOR_SERVICE_PORT) {
        this.actuatorServicePort = parseInt(process.env.ACTUATOR_SERVICE_PORT, 10) || 0;
      } else if (actSvc?.port && typeof actSvc.port === 'number') {
        this.actuatorServicePort = actSvc.port;
      }
    }
    if (this.actuatorServicePort > 0) {
      console.log(`🔌 Actuator service enabled — state transitions → TCP :${this.actuatorServicePort}`);
    } else {
      console.log(`🎯 Actuator service disabled (ACTUATOR_SERVICE_ENABLED=false or no port) — using direct UDP`);
    }

    // Controller service port (FIRE_START / FIRE_STOP gate for C++ PWM)
    const ctrlSvc = (config as any).controller_service;
    if (process.env.CONTROLLER_SERVICE_PORT) {
      this.controllerServicePort = parseInt(process.env.CONTROLLER_SERVICE_PORT, 10) || 0;
    } else if (ctrlSvc?.port && typeof ctrlSvc.port === 'number') {
      this.controllerServicePort = ctrlSvc.port;
    }
    if (this.controllerServicePort > 0) {
      console.log(`🎯 Controller service enabled — FIRE gate → TCP :${this.controllerServicePort}`);
    }

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
    // Always use relay — it's the only data path. Default to ws://localhost:9090 if env not set.
    this.setupElodinRelay();
    // Direct connection to Elodin DB for send-only: state transitions + controller VTable registration.
    this.setupElodin();

    // Optional DEMO mode: synthesised data + UDP packets for DAQ bridge.
    if (process.env.DEMO_MODE === 'true') {
      this.demoMode = new DemoModeGenerator();
      if (this.demoMode.isEnabled()) {
        console.log('🎭 DemoModeGenerator active — generating synthetic PT/ACT data');
        this.demoMode.start((update) => this.handleSensorUpdate(update), 10);
      }
    }

    this.startUpdateLoop();
  }

  /**
   * Reload config.toml at runtime after a successful save.
   * This updates in-memory mappings (boards, roles, controller settings, heartbeat),
   * without restarting the backend process.
   */
  public reloadConfig(): void {
    const t0 = Date.now();
    console.log('🔄 Reloading config.toml (runtime)...');

    let config: any;
    try {
      config = readConfig();
    } catch (err) {
      console.error('❌ reloadConfig: failed to read config.toml:', err);
      return;
    }

    try {
      // Network ports used for outbound actuator/heartbeat traffic
      const net = config.network || {};
      if (typeof net.actuator_cmd_port === 'number' && net.actuator_cmd_port > 0 && net.actuator_cmd_port <= 65535) {
        this.actuatorPort = net.actuator_cmd_port;
      }

      // Controller settings / targets
      this.applyControllerConfig(config);

      // Sensor roles (PT role names -> entity strings)
      const sensorMaps = loadSensorRoleMap();
      this.channelToEntityMap = sensorMaps.channelToEntityMap;
      this.boardChannelToEntityMaps = sensorMaps.boardChannelToEntityMaps;

      // Board registry + designated survivor, abort flags, etc.
      this.loadBoardRegistry();

      // IP -> board_id mapping used in several places
      this.ipToBoardId.clear();
      const boards = (config.boards || {}) as Record<string, any>;
      for (const [, boardRaw] of Object.entries(boards)) {
        const board = boardRaw as any;
        if (board.ip && typeof board.board_id === 'number' && board.enabled !== false) {
          this.ipToBoardId.set(board.ip, board.board_id);
        }
      }

      // Board-type filters & conversions
      this.hpPtBoards = loadHpPtConfig();
      this.tcBoards = loadTcBoardConfig();
      this.rtdBoards = loadRtdBoardConfig();
      this.lcBoards = loadLcBoardConfig();

      // Actuator routing map (multi-board)
      this.actuatorBoardMap.clear();
      loadActuatorBoardMap(config, this);

      // Heartbeat config (interval + broadcast target)
      this.applyServerHeartbeatConfig(config);
      this.restartServerHeartbeatTimer();

      // Environmental state (used in calibration conversions / sidecar)
      const envCfg = config.calibration?.environmental || {};
      this.envState = {
        temperature: envCfg.temperature ?? 25.0,
        humidity: envCfg.humidity ?? 50.0,
        vibration: envCfg.vibration ?? 0.0,
        aging_factor: envCfg.aging_factor ?? 1.0,
        mounting_torque: envCfg.mounting_torque ?? 1.0,
      } as any;

      // Phase2 tuning knobs (best-effort; doesn't restart engines)
      this.applyPhase2Config(config);

      console.log(`✅ reloadConfig complete in ${Date.now() - t0}ms`);
      this.broadcast({ type: MessageType.CONFIG_UPDATED, timestamp: Date.now(), payload: {} });
    } catch (err) {
      console.error('❌ reloadConfig: failed while applying config:', err);
    }
  }

  private applyServerHeartbeatConfig(config: any): void {
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
        if (this.serverBroadcastIP === '205.255.255.255') {
          this.serverBroadcastIP = '255.255.255.255';
        }
      }
      console.log(
        `📡 Server heartbeat config reloaded: interval=${this.serverHeartbeatIntervalMs} ms, ` +
        `broadcast=${this.serverBroadcastIP}:${this.serverBroadcastPort}`,
      );
    } catch (err) {
      console.warn('⚠️ Failed to reload server_heartbeat config; keeping existing values:', err);
    }
  }

  private restartServerHeartbeatTimer(): void {
    // Only restart if the update loop already created the timer.
    if (!this.serverHeartbeatTimer) return;
    try {
      clearInterval(this.serverHeartbeatTimer);
    } catch { /* ignore */ }
    this.serverHeartbeatTimer = setInterval(() => {
      this.sendServerHeartbeatUDP();
    }, this.serverHeartbeatIntervalMs);
  }

  private applyControllerConfig(config: any): void {
    const controllerConfig = config.controller || {};

    // Re-read controller_service TCP port in case config changed
    const ctrlSvc = (config.controller_service || {}) as { port?: number };
    if (ctrlSvc.port && ctrlSvc.port > 0) {
      this.controllerServicePort = ctrlSvc.port;
    }
    console.log('🎯 Controller config reloaded: using C++ controller service');
  }

  private applyPhase2Config(config: any): void {
    if (!this.phase2Engine) return;
    try {
      const phase2Config = config.phase2;
      if (!phase2Config) return;
      if (phase2Config.drift_threshold !== undefined) this.phase2Engine.setDriftThreshold(phase2Config.drift_threshold);
      if (phase2Config.process_noise !== undefined) this.phase2Engine.setProcessNoise(phase2Config.process_noise);
      if (phase2Config.ema_smoothing_alpha !== undefined) this.phase2Engine.setEMASmoothingAlpha(phase2Config.ema_smoothing_alpha);
      if (phase2Config.consensus_threshold_psi !== undefined) this.phase2Engine.setConsensusThreshold(phase2Config.consensus_threshold_psi);
      if (phase2Config.consensus_update_rate !== undefined) this.phase2Engine.setConsensusUpdateRate(phase2Config.consensus_update_rate);

      // Only enable internal Phase2 if sidecar is not enabled.
      if (!config.calibration?.sidecar?.enabled && phase2Config.enabled !== undefined) {
        this.phase2Engine.setEnabled(!!phase2Config.enabled);
      }
    } catch (err) {
      console.warn('⚠️ Failed to apply Phase2 config during reload; keeping existing values:', err);
    }
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

        const designatedSurvivor: boolean = !!board.designated_survivor && type === 'ACTUATOR';
        const activeConnectors: number[] = Array.isArray(board.active_connectors)
          ? board.active_connectors.filter((c: unknown): c is number => typeof c === 'number')
          : [];

        const entry = {
          type,
          boardNumber,
          id,
          ip,
          expected: true as const,
          designatedSurvivor,
          enableSerialPrinting: !!board.enable_serial_printing,
          necessaryForAbort: !!board.necessary_for_abort,
          sensorChannels: activeConnectors,
          voltageReference: typeof board.voltage_reference === 'number' ? board.voltage_reference : 0,
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
        console.warn('⚠️ No designated survivor actuator board in config.toml; ACTUATOR_CONFIG will not be sent');
      } else {
        console.warn(`⚠️ Multiple designated survivor boards found (${designatedCandidates.length}); ACTUATOR_CONFIG will not be sent`);
      }

      this.packetLowToUniqueId.clear();
      const sensorRolesPt2 = (config as any).sensor_roles_pt2 || {};
      for (const [, raw] of Object.entries(boards)) {
        const board: any = raw;
        if (board.type !== 'PT' || board.enabled === false) continue;
        const boardId = board.board_id ?? board.id;
        if (boardId == null) continue;
        const chOffset = typeof board.channel_offset === 'number' ? board.channel_offset : 0;
        if (chOffset === 0) {
          // packet low byte IS the channel ID (0x01..0x0A) — no +1 offset
          for (let c = 1; c <= 10; c++) this.packetLowToUniqueId.set(c, boardId * 100 + c);
        } else {
          for (const [, conn] of Object.entries(sensorRolesPt2)) {
            const connector = Number(conn);
            if (connector >= 1 && connector <= 10) {
              const packetCh = connector + chOffset;
              this.packetLowToUniqueId.set(packetCh, boardId * 100 + connector);
            }
          }
        }
      }
      console.log(`📋 Loaded ${this.boardRegistryById.size} boards from config.toml`);
    } catch (error) {
      console.warn('⚠️ Failed to load boards from config.toml; heartbeat pane will rely on discovery only:', error);
    }
  }


  private setupElodinRelay(): void {
    const url = process.env.ELODIN_RELAY_WS_URL || 'ws://localhost:9090';
    this.elodinRelay = new ElodinRelayClient(url);
    this.elodinRelay.on('packet', (header, payload) => {
      this.relayPacketCount++;
      if (this.relayPacketCount === 1 || this.relayPacketCount % 500 === 0) {
        console.log(`[Relay] packets received: ${this.relayPacketCount}`);
      }
      if (!this.streamingDataReceived && header.ty === ElodinPacketType.TABLE) {
        this.streamingDataReceived = true;
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
    // Direct Elodin connection is send-only: publishing controller data and registering VTables.
    // All incoming TABLE data arrives via the relay (setupElodinRelay). We must NOT subscribe to
    // the stream here — doing so would steal it from the relay (Elodin DB fans to first TCP subscriber only).
    this.elodin.on('connected', async () => {
      console.log('✅ Elodin connected (send-only: controller VTables + publish; data via relay)');
      await registerControllerVTables(this.elodin);
      this.broadcast({ type: MessageType.CONNECTION_STATUS, timestamp: Date.now(), payload: { connected: true, elodinConnected: true } as ConnectionStatus });
    });

    this.elodin.on('disconnected', () => {
      console.log('❌ Elodin disconnected');
      this.broadcast({ type: MessageType.CONNECTION_STATUS, timestamp: Date.now(), payload: { connected: true, elodinConnected: false } as ConnectionStatus });
    });

    // Discard any packets that arrive on the direct connection — relay is the authoritative stream.
    this.elodin.on('packet', () => { });

    this.elodin.connect().catch((error) => { console.error('❌ Elodin connection error:', error); });
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


  // ═══════════════════════════════════════════════════════════════════════════
  // Sensor update handler
  // ═══════════════════════════════════════════════════════════════════════════

  private handleSensorUpdate(update: SensorUpdate): void {
    if (isNaN(update.value) || !isFinite(update.value)) return;
    if (update.component === 'pressure_psi') {
      if (update.value < this.PSI_ABSOLUTE_MIN || update.value > this.PSI_ABSOLUTE_MAX) return;
    }

    if (this.firstPacketTime === null && (update.entity.startsWith('PT.') || update.entity.startsWith('PT_Cal.') || update.entity.startsWith('ACT.') || update.entity.startsWith('TC.'))) {
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

    // Save to history cache for plots — time relative to mission start (T+0).
    // NOTE: Elodin timestamps are steady_clock (ns since boot ÷ 1e6 = ms since boot, NOT Unix epoch).
    // All sensor updates that reach here should already have epoch-ms timestamps (see normalization above).
    const timeSec = (update.timestamp - (this.firstPacketTime ?? update.timestamp)) / 1000;
    // Guard: silently DROP bad timestamps — DO NOT broadcast to frontend or the plot renders garbage spikes.
    if (timeSec < -300 || timeSec > 86400) {
      return;
    }
    let series = this.historyCache.get(key);
    if (!series) {
      series = { time: [], values: [] };
      this.historyCache.set(key, series);
    }
    let value = update.value;
    const payload = { ...update, value };
    // Enforce monotonic time to prevent uPlot artifacts (spikes from out-of-order packets)
    const lastT = series.time.length > 0 ? series.time[series.time.length - 1] : -Infinity;
    if (timeSec > lastT) {
      series.time.push(timeSec);
      series.values.push(value);
    } else if (timeSec === lastT) {
      series.values[series.values.length - 1] = value;
    }
    // else: out-of-order, skip to keep monotonic
    if (series.time.length > this.HISTORY_MAX_POINTS) {
      series.time = series.time.slice(-this.HISTORY_MAX_POINTS);
      series.values = series.values.slice(-this.HISTORY_MAX_POINTS);
    }

    this.broadcast({ type: MessageType.SENSOR_UPDATE, timestamp: update.timestamp, payload });
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

      // ── Intercept Heartbeat Packets [0x10, board_id] ──
      if (high === 0x10 && payload.length >= 16) {
        const boardId = low;
        const boardType = payload.readUInt8(9);
        const engineState = payload.readUInt8(10);
        const boardState = payload.readUInt8(11);

        const now = Date.now();
        let status = this.boardsStatus.get(boardId);
        if (!status) {
          // Auto-discover unexpected board
          const ip = `192.168.2.${boardId}`;
          let typeStr = 'UNKNOWN';
          if (boardType === 1) typeStr = 'PT';
          else if (boardType === 2) typeStr = 'TC';
          else if (boardType === 3) typeStr = 'RTD';
          else if (boardType === 4) typeStr = 'LC';
          else if (boardType === 5) typeStr = 'ACTUATOR';

          status = {
            type: typeStr,
            boardNumber: null,
            id: boardId,
            ip,
            expected: false,
            connected: true,
            lastHeartbeatMs: now,
            heartbeatTimes: [now],
            boardState,
            engineState,
          };
          this.boardsStatus.set(boardId, status);
        } else {
          status.connected = true;
          status.lastHeartbeatMs = now;
          status.boardState = boardState;
          status.engineState = engineState;
          status.heartbeatTimes.push(now);
          if (status.heartbeatTimes.length > 20) {
            status.heartbeatTimes.shift();
          }
        }
        this.maybeSendConfigPackets();
        return; // Handled, skip typical sensor parsing
      }

      const parsed = parseElodinPacket(header.packetId, payload, {
        channelToEntityMap: this.channelToEntityMap,
        actuatorChannelToEntityMap: this.actuatorChannelToEntityMap,
      });
      if (!parsed) {
        // Log parse failures: first 5 always, then every 100th, and when ELODIN_DEBUG=1
        if (header.ty === ElodinPacketType.TABLE) {
          this._parseNullCount++;
          if (this._parseNullCount <= 5 || this._parseNullCount % 100 === 0 || process.env.ELODIN_DEBUG === '1') {
            console.warn(`[Relay] TABLE packet not parsed #${this._parseNullCount} (packetId=0x${high.toString(16)},0x${low.toString(16)}, len=${payload.length})`);
          }
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
            const chMatch = parsed.entity.match(/[._]CH?(\d+)$/);
            if (chMatch) channelId = parseInt(chMatch[1], 10);
            else {
              const fallbackMap: Record<string, number> = {
                'PT_Cal.Fuel_Upstream': 1, 'PT_Cal.GSE_Low': 2, 'PT_Cal.Fuel_Downstream': 3, 'PT_Cal.PT_CH3': 3,
                'PT_Cal.Fuel_Fill_Tank': 4, 'PT_Cal.PT_CH4': 4, 'PT_Cal.Ox_Upstream': 5, 'PT_Cal.GN2_Regulated': 6, 'PT_Cal.Ox_Downstream': 7,
              };
              channelId = fallbackMap[parsed.entity] ?? null;
            }
          }
        }

        if (channelId) {
          let boardId = 1;
          for (const [ip, bId] of this.ipToBoardId.entries()) {
            const boardMap = this.boardChannelToEntityMaps.get(ip);
            if (boardMap && boardMap[channelId] === parsed.entity) { boardId = bId; break; }
          }
          const uniqueId = boardId * 100 + channelId;
          if (this.USE_CALIBRATION_SERVICE_CALIBRATED) {
            shouldUseElodinValue = true;  // Always use Elodin calibrated (calibration_service)
          } else {
            const phase2State = this.phase2Engine?.getSensorState?.(uniqueId);
            if (phase2State && phase2State.rlsUpdateCount > 0) {
              shouldUseElodinValue = false;
            }
          }
          this.calibratedPTFromElodin.set(uniqueId, Date.now());
        }
      }

      if (shouldUseElodinValue) {
        // CRITICAL: Elodin timestamps are steady_clock (nanoseconds since boot ÷ 1e6 = ms since boot),
        // NOT Unix epoch. We must use Date.now() for ALL updates so firstPacketTime is set to epoch,
        // and all subsequent timeSec calculations (relative to firstPacketTime) stay near 0.
        // Mixing clocks causes timeSec = billions → bad data leaks to frontend as spikes.
        const epochNow = Date.now();
        // Reject corrupted/invalid parsed values to prevent spikes
        const isValid = Number.isFinite(parsed.value) && !Number.isNaN(parsed.value) &&
          (parsed.component !== 'pressure_psi' || (parsed.value >= this.PSI_ABSOLUTE_MIN && parsed.value <= this.PSI_ABSOLUTE_MAX));
        if (isValid) {
          const update: SensorUpdate = { entity: parsed.entity, component: parsed.component, value: parsed.value, timestamp: epochNow };
          this.handleSensorUpdate(update);
          if (channelId) {
            this.handleSensorUpdate({ entity: `PT_Cal.PT_CH${channelId}`, component: 'pressure_psi', value: parsed.value, timestamp: epochNow });
          }
        }
        // Raw PT → pressure_psi: ONLY when not using calibration_service (USE_CALIBRATION_SERVICE_CALIBRATED=false)
        if (!this.USE_CALIBRATION_SERVICE_CALIBRATED &&
          parsed.entity.startsWith('PT.') && parsed.component === 'raw_adc_counts' && payload.length >= 9) {
          const rawCh = payload.readUInt8(8);
          const pktLow = header.packetId[1];
          const uid = this.packetLowToUniqueId.get(pktLow) ?? (100 + rawCh);
          const calEntity = this.channelToEntityMap[rawCh] || `PT_Cal.PT_CH${rawCh}`;
          const adcSensor = Math.round(parsed.value);
          let psi: number = NaN;

          this.lastRawAdc.set(uid, adcSensor);

          // HP PT boards use 4-20 mA conversion, not polynomial calibration
          const ADC_MAX = 2147483648;
          let hpConverted = false;
          for (const cfg of this.hpPtBoards.values()) {
            const hpEntity = Object.values(cfg.channelToEntity).find((e) => e === calEntity);
            if (hpEntity) {
              const adcExc = cfg.excitationConnectorId >= 0
                ? (this.excitationAdcCache.get(`${cfg.boardIp}:${cfg.excitationConnectorId}`) ?? ADC_MAX)
                : ADC_MAX;  // No excitation channel: use dummy so conversion runs
              psi = convertHpPtToPressure(adcSensor, adcExc, cfg);
              hpConverted = true;
              console.log(`[HP-PT-DEBUG] entity=${hpEntity} adcSensor=${adcSensor} adcExc=${adcExc} psi=${psi} board=${cfg.boardIp}`);
              break;
            }
          }

          if (!hpConverted) {
            const coeffs = this.ptCalibration.get(uid) ?? this.ptCalibration.get(rawCh);
            if (coeffs) {
              psi = calculatePressure(parsed.value, coeffs, this.envState);
              if (!isFinite(psi) || isNaN(psi)) psi = (parsed.value / ADC_MAX) * 500;
            } else {
              psi = (parsed.value / ADC_MAX) * 500;
            }
            // TEMP DEBUG: log once per channel so we can see adc→psi in backend terminal
            if (!this._psiDebugLogged) this._psiDebugLogged = new Set<number>();
            if (!this._psiDebugLogged.has(rawCh)) {
              this._psiDebugLogged.add(rawCh);
              console.log(`[PSI Debug] ch=${rawCh} uid=${uid} adc=${parsed.value} psi=${psi.toFixed(2)} coeffs=${coeffs ? 'yes' : 'NO (fallback)'}`);
            }
          }

          if (isFinite(psi) && !isNaN(psi)) {
            // Spike rejection is now handled entirely inside handleSensorUpdate
            this.handleSensorUpdate({ entity: calEntity, component: 'pressure_psi', value: psi, timestamp: epochNow });
            this.handleSensorUpdate({ entity: `PT_Cal.PT_CH${rawCh}`, component: 'pressure_psi', value: psi, timestamp: epochNow });
          }
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

      // Send mission start time so client has correct time base for plots
      if (this.firstPacketTime !== null) {
        try { this.send(ws, { type: MessageType.MISSION_START_TIME, timestamp: Date.now(), payload: { missionStartTime: this.firstPacketTime } }); } catch (_) { }
      }

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
            this.send(ws, { type: MessageType.CONNECTION_STATUS, timestamp: Date.now(), payload: { connected: true, elodinConnected: this.elodinRelay?.isConnected() } as ConnectionStatus });
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
        // Force resend config to all boards by resetting state to pending
        const boardCount = this.boardsStatus.size;
        this.boardsStatus.forEach((_, id) => {
          this.boardConfigState.set(id, { status: 'pending' });
        });
        console.log(`[CONFIG] Resend config requested by client – reset ${boardCount} board(s) to pending, sending now (force all boards, including sensors)`);
        this.maybeSendConfigPackets({ forceAll: true, includeSensors: true });
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
    // Block transition only when Elodin is down AND no actuator_service AND not in debug mode.
    // When actuator_service is running it owns hardware commands, so allow transitions regardless of Elodin.
    if (command.commandType === 'state_transition' && !this.elodin.isConnected() && !this.debugMode && this.actuatorServicePort <= 0) {
      console.error('❌ Cannot send state transition: Elodin not connected and no actuator service');
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

        const success = this.elodin.isConnected()
          ? this.elodin.sendCommand('state_transition', { state: newState })
          : (this.debugMode || this.actuatorServicePort > 0); // actuator_service is hardware authority when Elodin is down
        if (success) {
          if (newState === SystemState.ARMED && !this.dataLogger.running) this.dataLogger.start();
          else if ((newState === SystemState.IDLE || newState === SystemState.EMERGENCY_ABORT) && this.dataLogger.running) {
            const stats = this.dataLogger.stop();
            if (stats) console.log(`📝 Run logged: ${stats.filePath}`);
          }

          this.currentState = newState;
          this.broadcast({ type: MessageType.STATE_UPDATE, timestamp: Date.now(), payload: { currentState: newState, stateName: SystemState[newState], timestamp: Date.now(), debugMode: this.debugMode } });

          const useCppActuatorService = this.actuatorServicePort > 0;
          if (this.debugMode && useCppActuatorService) {
            stopContinuousActuatorCommands(this);
            this.manuallyCommandedChannels.clear();
            const enumKey = SystemState[newState] ?? 'IDLE';
            forwardStateToActuatorService(enumKey, this.actuatorServicePort).catch(() => {});
          } else if (this.debugMode) {
            stopContinuousActuatorCommands(this);
            this.manuallyCommandedChannels.clear();
          } else if (useCppActuatorService) {
            this.manuallyCommandedChannels.clear();
            stopContinuousActuatorCommands(this);
            const enumKey = SystemState[newState] ?? 'IDLE';
            forwardStateToActuatorService(enumKey, this.actuatorServicePort).then((ok) => {
              if (!ok) {
                console.warn('⚠️ actuator_service not reachable – falling back to direct UDP');
                applyActuatorsForState(this, newState, STATE_ACTUATOR_MAP);
                if (newState === SystemState.FIRE) {
                  const fuelInfo = getActuatorBoardInfo(this, 'Fuel Press');
                  const loxInfo = getActuatorBoardInfo(this, 'LOX Press');
                  if (fuelInfo) this.manuallyCommandedChannels.add(`${fuelInfo.channel}@${fuelInfo.boardIp}`);
                  if (loxInfo) this.manuallyCommandedChannels.add(`${loxInfo.channel}@${loxInfo.boardIp}`);
                  startContinuousActuatorCommands(this, newState, STATE_ACTUATOR_MAP);
                } else if (newState !== SystemState.IDLE) {
                  startContinuousActuatorCommands(this, newState, STATE_ACTUATOR_MAP);
                }
              }
            });
          } else {
            this.manuallyCommandedChannels.clear();
            console.log(`🎯 State changed to ${SystemState[newState]} – relying on C++ actuator_service`);
          }

          broadcastActuatorExpectedPositions(this, newState, STATE_ACTUATOR_MAP);
          if (newState === SystemState.FIRE) {
            console.log('🎯 FIRE state entered – sending FIRE_START to C++ controller service');
            if (this.controllerServicePort > 0) {
              forwardFireStateToControllerService(true, this.controllerServicePort).catch(() => {});
            }
          } else if (this.controllerServicePort > 0) {
            forwardFireStateToControllerService(false, this.controllerServicePort).catch(() => {});
          }

          // Abort UDP broadcasts (ABORT / ABORT_DONE)
          const isAbortState =
            newState === SystemState.ENGINE_ABORT ||
            newState === SystemState.GSE_ABORT ||
            newState === SystemState.EMERGENCY_ABORT ||
            newState === SystemState.ABORT;
          if (isAbortState) {
            if (this.controllerServicePort > 0) {
              forwardFireStateToControllerService(false, this.controllerServicePort).catch(() => {});
            }
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
          const useCppActuatorService = this.actuatorServicePort > 0;
          const open = actuatorState === ActuatorState.OPEN;
          if (useCppActuatorService) {
            forwardActuatorToActuatorService(commandActuatorName, open, this.actuatorServicePort).then((ok) => {
              if (ok) {
                const boardInfo = getActuatorBoardInfo(this, commandActuatorName);
                if (boardInfo) this.manuallyCommandedChannels.add(`${boardInfo.channel}@${boardInfo.boardIp}`);
                this.broadcast({ type: MessageType.ACTUATOR_UPDATE, timestamp: Date.now(), payload: { name: commandActuatorName, state: actuatorState, rawAdcCounts: 0, timestamp: Date.now() } as ActuatorUpdate });
              } else {
                const boardInfo = getActuatorBoardInfo(this, commandActuatorName);
                if (boardInfo) {
                  const actuatorType = getActuatorType(commandActuatorName);
                  const hardwareState = guiStateToHardwareState(open ? 1 : 0, actuatorType);
                  this.manuallyCommandedChannels.add(`${boardInfo.channel}@${boardInfo.boardIp}`);
                  const success = sendActuatorCommandUDP(this, boardInfo.channel, hardwareState, boardInfo.boardIp);
                  if (success) this.broadcast({ type: MessageType.ACTUATOR_UPDATE, timestamp: Date.now(), payload: { name: commandActuatorName, state: actuatorState, rawAdcCounts: 0, timestamp: Date.now() } as ActuatorUpdate });
                }
              }
            });
          } else {
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
          broadcastActuatorExpectedPositions(this, abortState, STATE_ACTUATOR_MAP);
        } catch (err) {
          console.error('❌ Failed to broadcast abort actuator positions during clear_abort:', err);
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

      // Send SERVER_HEARTBEAT so boards transition to Active and accept actuator commands
      // (Matches femboy: backend owns heartbeats; engine_state syncs with currentState)
      this.sendServerHeartbeatUDP();

      // Demo mode: simulate heartbeats for configured boards so boards/notifications work without daq_bridge
      if (process.env.DEMO_MODE === 'true' && this.demoMode?.isEnabled()) {
        const now = Date.now();
        const engineState = (this.currentState ?? SystemState.IDLE) as number;
        this.boardsStatus.forEach((status, id) => {
          if (status.expected) {
            status.connected = true;
            status.lastHeartbeatMs = now;
            status.boardState = 2; // Active
            status.engineState = engineState;
            status.heartbeatTimes.push(now);
            if (status.heartbeatTimes.length > 20) status.heartbeatTimes.shift();
          }
        });
      }

      if (this.clients.size === 0) return;
      const snapshot = this.getBoardStatusSnapshot();
      if (snapshot.length === 0) return;
      this.broadcast({
        type: MessageType.BOARD_STATUS_UPDATE,
        timestamp: Date.now(),
        payload: { boards: snapshot },
      });

      // ── Notification logic (same snapshot, so connected/boardState/engineState/expected are current)
      const now = Date.now();

      for (const b of snapshot) {
        const id = b.id;
        const connected = b.connected;
        const prevConnected = this.previousBoardConnected.get(id);
        const label = b.boardNumber != null ? `Board ${b.boardNumber} (${b.type})` : `Board ${id} (${b.type})`;

        // Connection lost (error)
        const boardLostKey = `board_lost_${id}`;
        if (prevConnected === true && !connected) {
          this.broadcastNotification({ key: boardLostKey, category: 'error', message: `${label} connection lost`, timestampMs: now, ongoing: true });
          this.activeNotificationKeys.add(boardLostKey);
        } else if (prevConnected === true && connected && this.activeNotificationKeys.has(boardLostKey)) {
          this.broadcastNotification({ key: boardLostKey, category: 'error', message: `${label} connection lost`, timestampMs: now, ongoing: false });
          this.activeNotificationKeys.delete(boardLostKey);
        }

        // Board connected (info) — one-shot when transitioning to connected
        // prevConnected === undefined means first time we've seen this board in the loop;
        // treat that as "not previously connected" so initial connect fires a notification.
        if ((prevConnected === false || prevConnected === undefined) && connected) {
          this.broadcastNotification({ category: 'info', message: `${label} connected`, timestampMs: now });
        }

        // Board stuck in setup (error)
        const setupStuckKey = `setup_stuck_${id}`;
        const inSetup = connected && b.boardState === this.BOARD_STATE_SETUP;
        if (inSetup) {
          const firstSeen = this.boardFirstSeenSetupMs.get(id);
          if (firstSeen == null) this.boardFirstSeenSetupMs.set(id, now);
          const first = this.boardFirstSeenSetupMs.get(id)!;
          if (now - first > this.SETUP_STUCK_THRESHOLD_MS) {
            if (!this.activeNotificationKeys.has(setupStuckKey)) {
              this.broadcastNotification({ key: setupStuckKey, category: 'error', message: `${label} stuck in setup`, timestampMs: first, ongoing: true });
              this.activeNotificationKeys.add(setupStuckKey);
            }
          }
        } else {
          this.boardFirstSeenSetupMs.delete(id);
          if (this.activeNotificationKeys.has(setupStuckKey)) {
            this.broadcastNotification({ key: setupStuckKey, category: 'error', message: `${label} stuck in setup`, timestampMs: now, ongoing: false });
            this.activeNotificationKeys.delete(setupStuckKey);
          }
        }

        // Unrecognized board (warning)
        const unrecognizedKey = `unrecognized_${id}`;
        if (connected && !b.expected) {
          if (!this.activeNotificationKeys.has(unrecognizedKey)) {
            this.broadcastNotification({ key: unrecognizedKey, category: 'warning', message: `Unrecognized board at ${b.ip}`, timestampMs: now, ongoing: true });
            this.activeNotificationKeys.add(unrecognizedKey);
          }
        } else if (!connected && this.activeNotificationKeys.has(unrecognizedKey)) {
          this.broadcastNotification({ key: unrecognizedKey, category: 'warning', message: `Unrecognized board at ${b.ip}`, timestampMs: now, ongoing: false });
          this.activeNotificationKeys.delete(unrecognizedKey);
        }

      }

      // Persist previous connected state
      for (const b of snapshot) {
        this.previousBoardConnected.set(b.id, b.connected);
      }
    }, 1000);

  }

  /**
   * Send SERVER_HEARTBEAT packet via UDP broadcast.
   * Packet format (DAQv2Comms):
   *   Header: [packet_type(1)=2, version(1)=0, timestamp_ms(4, LE)]
   *   Body:   [engine_state(1)] where engine_state is SystemState numeric code.
   */
  private sendServerHeartbeatUDP(): void {
    if (!this.actuatorSocket || !this.actuatorSocketBroadcastReady) return;
    try {
      const packetType = 2;
      const version = 0;
      const timestamp = Date.now() >>> 0;
      const engineCode = (this.currentState ?? SystemState.IDLE) as number;

      const payload = Buffer.allocUnsafe(7);
      payload.writeUInt8(packetType, 0);
      payload.writeUInt8(version, 1);
      payload.writeUInt32LE(timestamp, 2);
      payload.writeUInt8(engineCode, 6);

      this.actuatorSocket.send(payload, 0, payload.length, this.serverBroadcastPort, this.serverBroadcastIP, (err) => {
        if (err) console.error(`❌ Failed to broadcast SERVER_HEARTBEAT: ${err.message}`);
      });
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

  /** Broadcast a single notification to all clients (for notification panel). */
  private broadcastNotification(payload: NotificationPayload): void {
    if (this.clients.size === 0) return;
    this.broadcast({ type: MessageType.NOTIFICATION, timestamp: Date.now(), payload });
  }

  /**
   * Helper for header-only UDP broadcast packets that share the same format:
   *   [packet_type(1), version(1)=0, timestamp_ms(4, LE)]
   */
  private sendSimpleBroadcastPacket(packetType: number, label: string): void {
    if (!this.actuatorSocket) return;
    try {
      const version = 0;
      const timestamp = Date.now() >>> 0;
      const payload = Buffer.allocUnsafe(6);
      payload.writeUInt8(packetType, 0);
      payload.writeUInt8(version, 1);
      payload.writeUInt32LE(timestamp, 2);

      this.actuatorSocket.send(payload, 0, payload.length, this.serverBroadcastPort, this.serverBroadcastIP, (err) => {
        if (err) console.error(`❌ Failed to broadcast ${label}: ${err.message}`);
      });
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
        designatedSurvivor: registry?.designatedSurvivor ?? false,
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
      useRelay: true,
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
   * Send configuration packets to hardware boards.
   *
   * Default behavior (no options): on first connect / heartbeat loop, send ACTUATOR_CONFIG
   * only to connected actuator boards, relying on a valid designated survivor.
   *
   * When called with { forceAll: true, includeSensors: true } (from RESEND_CONFIG),
   * this will attempt to send both ACTUATOR_CONFIG and SENSOR_CONFIG to *all* boards
   * defined in the registry, regardless of heartbeat status, and will log warnings
   * instead of bailing if designated survivor metadata is missing.
   */
  private maybeSendConfigPackets(options?: { forceAll?: boolean; includeSensors?: boolean }): void {
    const forceAll = !!options?.forceAll;
    const includeSensors = !!options?.includeSensors;

    if (!this.actuatorSocket) return;

    if (!this.designatedSurvivorBoardId || !this.designatedSurvivorIP) {
      if (!forceAll) {
        return;
      }
      console.warn('⚠️ Forcing config send without a valid designated survivor actuator board – abort wiring may be invalid');
    }

    const now = Date.now();
    this.boardsStatus.forEach((status, id) => {
      const isConnected = status.lastHeartbeatMs != null && now - status.lastHeartbeatMs <= 2500;
      if (!forceAll && !isConnected) return;

      let registry = this.boardRegistryById.get(id);
      if (!registry && status.ip) {
        for (const [, reg] of this.boardRegistryById) {
          if (reg.ip === status.ip) {
            registry = reg;
            break;
          }
        }
      }
      if (!registry) return;

      const cfg = this.boardConfigState.get(id) ?? { status: 'pending' as const };
      if (!forceAll && cfg.status === 'sent') return;

      if (registry.type === 'ACTUATOR') {
        // Send ACTUATOR_CONFIG
        if (!this.designatedSurvivorBoardId || !this.designatedSurvivorIP) {
          if (!forceAll) return;
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
          const actuatorHex = packet.toString('hex').match(/.{1,2}/g)?.join(' ') ?? '';
          console.log(
            `[CONFIG] Sending ACTUATOR_CONFIG to board ${id} (${destIP}:${targetPort}) – is_abort_controller=${isAbortController} packet_len=${packet.length} hex=[${actuatorHex}]`
          );
          this.actuatorSocket!.send(packet, 0, packet.length, targetPort, destIP, (err) => {
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

      if (!includeSensors) return;

      // SENSOR_CONFIG for sense boards
      const sensorChannels = registry.sensorChannels || [];
      const necessaryForAbort = registry.necessaryForAbort;

      if (!this.designatedSurvivorIP && necessaryForAbort) {
        if (!this._lastDesignatedSurvivorWarn || Date.now() - this._lastDesignatedSurvivorWarn > 60000) {
          console.warn(`⚠️ skipping SENSOR_CONFIG for board ${id}: no designated survivor actuator board for abort-critical sensor`);
          this._lastDesignatedSurvivorWarn = Date.now();
        }
        return;
      }

      try {
        const targetPortSensor = 5005;
        const destIP = status.ip;
        const packet = this.buildSensorConfigPacket(
          sensorChannels,
          registry.voltageReference ?? 0,
          necessaryForAbort,
          this.designatedSurvivorIP || '0.0.0.0',
          registry.enableSerialPrinting ?? false,
        );
        const sensorHex = packet.toString('hex').match(/.{1,2}/g)?.join(' ') ?? '';
        console.log(
          `[CONFIG] Sending SENSOR_CONFIG to board ${id} (${destIP}:${targetPortSensor}) – channels=[${sensorChannels.join(',')}] necessary_for_abort=${necessaryForAbort} packet_len=${packet.length} hex=[${sensorHex}]`
        );
        this.actuatorSocket!.send(packet, 0, packet.length, targetPortSensor, destIP, (err) => {
          if (err) {
            this.boardConfigState.set(id, { status: 'error', lastSentAt: Date.now(), errorMessage: err.message });
          } else {
            this.boardConfigState.set(id, { status: 'sent', lastSentAt: Date.now() });
          }
          this.broadcastBoardStatus();
        });
      } catch (err: any) {
        this.boardConfigState.set(id, { status: 'error', lastSentAt: Date.now(), errorMessage: String(err?.message || err) });
      }
    });
  }

  /**
   * Build ACTUATOR_CONFIG packet (header + body).
   * Body: is_abort_controller (1B), N (1B), N x AbortActuatorLocation (7B each), X (1B), X x AbortPTLocation (9B each), enable_serial_printing (1B).
   * IPs encoded to match Diablo actuator hotfire firmware `getSelfIP` / `remote_ip32` representation
   * (uint32_t ip0<<24 | ip1<<16 | ip2<<8 | ip3), written little-endian on the wire; threshold_adc_code little-endian.
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
    for (const [actuatorName, value] of Object.entries(actuatorRoles)) {
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
      const ventState = (STATE_ACTUATOR_MAP[SystemState.VENT]?.[actuatorName] ?? 0) ? 1 : 0;
      const abortState = (STATE_ACTUATOR_MAP[SystemState.ENGINE_ABORT]?.[actuatorName] ?? 0) ? 1 : 0;
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
      // IPs must compare equal to getSelfIP()/remote_ip32 (uint32_t ip0<<24 | ...).
      // Those firmware helpers treat the uint32_t value as big-endian logical IP, but it is stored
      // in little-endian memory on the MCU. Writing the value as LE here reproduces that layout.
      buffer.writeUInt32LE(a.ip, offset); offset += 4;
      buffer.writeUInt8(a.actuator_id, offset++);
      buffer.writeUInt8(a.vent_state, offset++);
      buffer.writeUInt8(a.abort_state, offset++);
    }

    buffer.writeUInt8(X, offset++);
    for (let i = 0; i < X; i++) {
      const p = abortPtsList[i];
      // Match actuator IP encoding: store ip0<<24|... as LE bytes on the wire so the hotfire
      // firmware sees a uint32_t equal to remote_ip32 when parsing.
      buffer.writeUInt32LE(p.ip, offset); offset += 4;
      buffer.writeUInt8(p.sensor_id, offset++);
      buffer.writeUInt32LE(p.threshold_adc_code, offset); offset += 4;
    }

    buffer.writeUInt8(enable_serial_printing ? 1 : 0, offset++);

    return buffer;
  }

  /**
   * Construct a DAQv2-Comms SENSOR_CONFIG packet.
   * Layout matches create_sensor_config_packet in DiabloPacketUtils.cpp.
   * Must NOT follow generate_packets.cpp (different/legacy format).
   *
   * Body layout (after 6-byte header):
   *   num_sensors (1 byte)
   *   sensor_ids (N bytes, 1-byte each)
   *   reference_voltage (1 byte: 0=Internal 2.5V, 1=VDD, 2=5V)
   *   necessary_for_abort (1 byte, 0/1)
   *   controller_ip (4 bytes, big-endian) — ONLY when necessary_for_abort is true
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
    const bodyLength = 1 + numSensors + 1 + 1 + (necessaryForAbort ? 4 : 0) + 1;
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

    if (necessaryForAbort) {
      const ipOctets = designatedSurvivorIP.split('.').map((part) => Number(part));
      if (ipOctets.length !== 4 || ipOctets.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
        throw new Error(`Invalid designated survivor IP address: ${designatedSurvivorIP}`);
      }
      const ipInt = ((ipOctets[0] << 24) | (ipOctets[1] << 16) | (ipOctets[2] << 8) | ipOctets[3]) >>> 0;
      buffer.writeUInt32BE(ipInt, offset);
      offset += 4;
    }

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
  () => server.getDebugInfo(),
  () => server.reloadConfig()
);

process.on('SIGINT', () => { console.log('\n🛑 Shutting down server...'); server.shutdown(); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n🛑 Shutting down server...'); server.shutdown(); process.exit(0); });

console.log(`🚀 WebSocket server starting on ${WS_HOST}:${WS_PORT}`);
console.log(`📡 Connecting to Elodin DB at ${ELODIN_HOST}:${ELODIN_PORT}`);
console.log(`🌐 External clients can connect via: ws://<your-ip>:${WS_PORT}`);
