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
import { registerControllerVTables, registerActuatorCommandedVTables } from './elodin-vtable-controller.js';
import { registerNavigationVTable } from './elodin-vtable-navigation.js';
import { ElodinRelayClient } from './elodin-relay-client.js';

import { ElodinPublisherBatched } from './elodin-publisher-batched.js';
import { publishControllerActuation, publishControllerDiagnostics, publishControllerStateTransition, publishActuatorStateToElodin } from './controller-elodin-publisher.js';
import { getStateTransitions, isTransitionAllowed } from './routes/state-transitions.js';
import { getStateActuatorMap, StateActuatorMap, CSV_ACTUATOR_TO_ENTITY, getActuatorChannel } from './routes/state-actuators.js';
import { startAPIServer, type DebugInfo } from './api-server.js';
import { loadPTCalibration, type CalibrationCoefficients } from './calibration.js';
import { CalibrationSidecarClient } from './calibration-sidecar.js';
import { handleCalibrationCommand } from './calibration-handler.js';
import { DataLogger } from './data-logger.js';
import { readConfig, getConfigPath } from './routes/config.js';
import { MessageLogger } from './message-logger.js';
import { DemoModeGenerator } from './demo-mode.js';
import { loadCountdownTargetTimeMs, saveCountdownTargetTimeMs } from './countdown-state.js';
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
import { loadSensorRoleMap, loadHpPtConfig, loadActuatorChannelToEntityMap, convertHpPtToPressure, loadTcBoardConfig, loadRtdBoardConfig, loadLcBoardConfig } from './sensor-config.js';
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

  /** PT calibration for fallback raw→psi when C++ calibration_service isn't providing PT_Cal */
  ptCalibration: Map<number, CalibrationCoefficients> = new Map();
  ptCalibrationFilePath: string | null = null;
  /** Accumulated (adc, pressure) points per channel for calibration handler */
  calibrationPoints: Map<number, { adc: number; pressure: number }[]> = new Map();
  /** Last raw ADC per channel (uniqueId) — used by ZERO ALL / capture_reference */
  lastRawAdc: Map<number, number> = new Map();
  /** Robust Calibration Python Sidecar (status + UI only; all fitting lives in Python) */
  calibrationSidecar!: CalibrationSidecarClient;
  /** payloadCh → uniqueId for lastRawAdc population from raw PT packets */
  private payloadChToUniqueId: Map<number, number> = new Map();
  phase2Engine: null = null;

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

  ipToBoardId: Map<string, number> = new Map();

  private readonly PSI_ABSOLUTE_MIN = -50;   // physically impossible below -50 PSI
  private readonly PSI_ABSOLUTE_MAX = 6000;  // max expected sensor range (HP PT up to 5000 PSI)

  /** Throttle broadcast per sensor — 100ms = 10 Hz (reduces browser lag) */
  private broadcastLastTime: Map<string, number> = new Map();
  private readonly BROADCAST_MIN_INTERVAL_MS = 100;

  /** History cache for plots; smaller cap so QUERY_HISTORICAL response doesn't kill connection */
  private historyCache: Map<string, { time: number[]; values: number[] }> = new Map();
  private historyCacheLastUpdate: Map<string, number> = new Map();
  private readonly HISTORY_MAX_POINTS = 6000; // 100 Hz * 60 s
  private readonly HISTORY_MAX_KEYS = 60; // cap keys to prevent lag buildup over long sessions
  private readonly HISTORY_STALE_MS = 5 * 60 * 1000; // prune keys not updated in 5 min
  private historyPruneInterval: ReturnType<typeof setInterval> | null = null;

  /** Server startup time (epoch ms) used as global timebase for all clients/devices. */
  private readonly serverStartTimeMs: number = Date.now();

  /** Binary data logger for runs */
  private dataLogger = new DataLogger();
  private _lastSensorLog = 0;

  /** Mission T+0 */
  private firstPacketTime: number | null = null;

  /** Shared countdown target time (epoch ms). */
  private countdownTargetTimeMs: number | null = null;

  /** State & debug */
  currentState: SystemState | null = null;
  private debugMode: boolean = false;
  actuatorCommandInterval: NodeJS.Timeout | null = null;
  readonly ACTUATOR_COMMAND_INTERVAL_MS = 1000;
  manuallyCommandedChannels: Set<string> = new Set();

  // SERVER_HEARTBEAT sending removed — daq_bridge owns it; keep broadcast addr for ABORT packets
  private serverBroadcastPort: number = 5005;
  private serverBroadcastIP: string = '255.255.255.255';
  /** Abort → AbortDone timer */
  private abortDoneTimer: NodeJS.Timeout | null = null;
  /** FIRE → IDLE auto-end: timer and start time (config-driven) */
  private fireEndTimer: NodeJS.Timeout | null = null;
  private fireStartTimeMs: number | null = null;
  private fireDurationMs: number = 6000;
  private fireExtendedMs: number = 10000;

  /** Controller — always C++ controller_service */
  USE_CPP_CONTROLLER: boolean = true;

  /** Sensor maps (from config.toml; used so DB and backend are a replica of config) */
  channelToEntityMap: Record<number, string> = {};
  boardChannelToEntityMaps: Map<string, Record<number, string>> = new Map();
  actuatorChannelToEntityMap: Record<number, string> = {};
  private hpPtBoards: Map<string, HpPtBoardConfig> = new Map();
  private excitationAdcCache: Map<string, number> = new Map();
  private hpPtExcitationWarnAt: Map<string, number> = new Map();

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
  /** When true, next getConfigPacketsToSend returns forceAll (for RESEND_CONFIG when config_service handles sending) */
  private forceResendConfig: boolean = false;
  private configBroadcastServiceEnabled: boolean = false;
  private dataLoggerServiceEnabled: boolean = false;

  /** Notification system: previous board connected state for transition detection */
  private previousBoardConnected: Map<number, boolean> = new Map();
  /** First time we saw board in SETUP (boardState === 1), for "stuck in setup" detection */
  private boardFirstSeenSetupMs: Map<number, number> = new Map();
  /** Keys for which we have emitted ongoing: true (so we only emit ongoing: false when they clear) */
  private activeNotificationKeys: Set<string> = new Set();
  private readonly SETUP_STUCK_THRESHOLD_MS = 4000;
  private readonly BOARD_STATE_SETUP = 1;

  /** PT_Cal entities that received calibrated data from calibration_service recently — skip raw fallback to avoid chunking. */
  private lastCalibratedPtEntityMs: Map<string, number> = new Map();
  private readonly PT_CAL_SUPERSEDES_RAW_MS = 2500;

  constructor() {
    console.log(`🚀 Starting Sensor System Server...`);
    console.log(`   WebSocket: ${WS_HOST}:${WS_PORT}`);
    console.log(`   Elodin DB: ${ELODIN_HOST}:${ELODIN_PORT}`);

    this.firstPacketTime = null;

    // Countdown target persistence (shared across clients; survives backend restarts).
    // Default matches the old frontend hardcoded target so behavior doesn't change on rollout.
    const DEFAULT_LAUNCH_TARGET_MS = Date.UTC(2026, 2, 8, 2, 0, 0); // month is 0-indexed
    this.countdownTargetTimeMs = loadCountdownTargetTimeMs() ?? DEFAULT_LAUNCH_TARGET_MS;

    // Load config
    const config = readConfig();

    // Initialize Robust Calibration Sidecar (all calibration/fitting lives in Python sidecar)
    this.calibrationSidecar = new CalibrationSidecarClient();
    this.calibrationSidecar.start();
    if (this.calibrationSidecar.enabled) console.log('🤖 Robust Calibration Sidecar initialized');
    else if (process.env.REPLAY_MODE === '1' || process.env.REPLAY_MODE === 'true') console.log('📂 Replay mode: calibration sidecar disabled');

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
    this.applyServerHeartbeatConfig(config);

    // ipToBoardId must be set before payloadChToUniqueId build (used for lastRawAdc key mapping)
    const boards = (config.boards || {}) as Record<string, any>;
    for (const [boardKey, boardRaw] of Object.entries(boards)) {
      const board = boardRaw as any;
      if (board.ip && typeof board.board_id === 'number' && board.enabled !== false) {
        this.ipToBoardId.set(board.ip, board.board_id);
      }
    }

    // Load PT calibration for fallback raw→psi when C++ calibration_service isn't providing PT_Cal
    const ptResult = loadPTCalibration();
    this.ptCalibration = ptResult.map;
    this.ptCalibrationFilePath = ptResult.filePath ?? null;

    // Build payloadCh → uniqueId for lastRawAdc (ZERO ALL / capture_reference)
    for (const payloadCh of Object.keys(this.channelToEntityMap).map(Number)) {
      if (!Number.isInteger(payloadCh) || payloadCh < 1 || payloadCh > 20) continue;
      const entity = this.channelToEntityMap[payloadCh];
      for (const [ip, boardMap] of this.boardChannelToEntityMaps.entries()) {
        const boardId = this.ipToBoardId.get(ip) ?? 1;
        for (const [chStr, mapEntity] of Object.entries(boardMap)) {
          const channelId = Number(chStr);
          if (mapEntity === entity && Number.isInteger(channelId) && channelId >= 1 && channelId <= 10) {
            this.payloadChToUniqueId.set(payloadCh, boardId * 100 + channelId);
            break;
          }
        }
      }
    }
    if (this.payloadChToUniqueId.size === 0) {
      for (let p = 1; p <= 14; p++) this.payloadChToUniqueId.set(p, p <= 10 ? 100 + p : 200 + (p - 10));
    }

    // Backend does not do fitting; it consumes PT_Cal from Elodin when available.
    // Fallback: when we receive raw PT and have calibration, compute psi locally so gauges show data.
    console.log('📐 Backend: PT_Cal from Elodin; fallback raw→psi when calibration_service unavailable');


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
    const dur = typeof ctrlSvc?.fire_duration_ms === 'number' ? ctrlSvc.fire_duration_ms : parseFloat(ctrlSvc?.fire_duration_ms);
    const ext = typeof ctrlSvc?.fire_extended_ms === 'number' ? ctrlSvc.fire_extended_ms : parseFloat(ctrlSvc?.fire_extended_ms);
    this.fireDurationMs = (typeof dur === 'number' && !isNaN(dur) && dur > 0) ? dur : 6000;
    this.fireExtendedMs = (typeof ext === 'number' && !isNaN(ext) && ext > 0) ? ext : 10000;
    if (this.controllerServicePort > 0) {
      console.log(`🎯 Controller service enabled — FIRE gate → TCP :${this.controllerServicePort} (${this.fireDurationMs}ms hotfire)`);
    }

    // Build transition validation map
    const transitions = getStateTransitions();
    if (transitions.length === 0) {
      console.warn('⚠️ No state transitions loaded - all transitions will be allowed');
    } else {
      console.log(`📋 Loaded ${transitions.length} allowed state transitions`);
    }

    // Internal Phase 1/Phase 2 calibration engine removed — Python sidecar owns
    // all calibration, and writes calibrated values back to Elodin directly.

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
        // Send config once socket is ready (relay may connect later)
        setTimeout(() => this.maybeSendConfigPackets({ forceAll: true, includeSensors: true }), 300);
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
    // MessageLogger simply sends JSON blobs in TABLE packets without VTable registrations
    // causing Elodin DB to aggressively throw VTableNotFound errors on every packet. Disabled by default.
    if (process.env.ENABLE_MESSAGE_LOGGING === 'true') this.messageLogger.enable();
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
        const demoRateHz = parseInt(process.env.DEMO_RATE_HZ || '50', 10) || 50;
        console.log(`🎭 DemoModeGenerator active — synthetic PT/ACT data at ${demoRateHz} Hz`);
        this.demoMode.start((update) => this.handleSensorUpdate(update), demoRateHz);
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

      // Broadcast config (for ABORT packets; SERVER_HEARTBEAT from heartbeat_service)
      this.applyServerHeartbeatConfig(config);

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
      const cfgSvc = (config as any).config_broadcast_service || {};
      this.configBroadcastServiceEnabled = !!cfgSvc.enabled;
      const dlSvc = (config as any).data_logger_service || {};
      this.dataLoggerServiceEnabled = !!dlSvc.enabled;
      console.log(`📡 Broadcast config reloaded: ${this.serverBroadcastIP}:${this.serverBroadcastPort} (ABORT)${this.configBroadcastServiceEnabled ? '; config → config_broadcast_service' : ''}${this.dataLoggerServiceEnabled ? '; logging → data_logger_service' : ''}`);
    } catch (err) {
      console.warn('⚠️ Failed to reload server_heartbeat config; keeping existing values:', err);
    }
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
    // Legacy Phase 2 engine has been removed from the backend. Python sidecar +
    // calibration_server.py own all calibration logic now.
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
        if (board.enabled === false) continue; // Only track enabled boards for status/config
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

      const boardIds = [...this.boardRegistryById.keys()].sort((a, b) => a - b);
      console.log(`📋 Loaded ${this.boardRegistryById.size} boards from config.toml (IDs: ${boardIds.join(', ')})`);
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
      // After server restart, boards have no heartbeat state yet; mark all config pending and resend so config goes out once boards are reachable
      this.boardsStatus.forEach((_, id) => this.boardConfigState.set(id, { status: 'pending' }));
      setTimeout(() => this.maybeSendConfigPackets({ forceAll: true, includeSensors: true }), 500);
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
  private heartbeatPacketCount: number = 0;
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
    // All incoming TABLE data arrives via the relay (setupElodinRelay). Replay = elodin-db run --replay (DB streams stored data as live telemetry).
    this.elodin.on('connected', async () => {
      console.log('✅ Elodin connected (send-only: controller VTables + publish; data via relay)');
      await registerControllerVTables(this.elodin);
      await registerActuatorCommandedVTables(this.elodin, this.actuatorChannelToEntityMap);
      await registerNavigationVTable(this.elodin);
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
    const key = `${update.entity}.${update.component}`;

    // Throttle early — skip expensive work when we'd drop the broadcast anyway
    const now = Date.now();
    if (this.BROADCAST_MIN_INTERVAL_MS > 0) {
      const lastBroadcast = this.broadcastLastTime.get(key) ?? 0;
      if (now - lastBroadcast < this.BROADCAST_MIN_INTERVAL_MS) {
        this.sensorCache.set(key, update); // keep latest for client connect
        return;
      }
      this.broadcastLastTime.set(key, now);
    }

    if (update.component === 'pressure_psi') {
      if (update.value < this.PSI_ABSOLUTE_MIN || update.value > this.PSI_ABSOLUTE_MAX) return;
      const series = this.historyCache.get(key);
      if (update.value === 0 && series && series.values.length > 0) {
        const last = series.values[series.values.length - 1];
        if (last > 1) return; // keep previous non-zero, skip this 0
      }
    }

    if (this.firstPacketTime === null && (update.entity.startsWith('PT.') || update.entity.startsWith('PT_Cal.') || update.entity.startsWith('ACT.') || update.entity.startsWith('TC.') || update.entity.startsWith('RTD.') || update.entity.startsWith('RTD_Cal.') || update.entity.startsWith('LC.') || update.entity.startsWith('LC_Cal.'))) {
      this.firstPacketTime = update.timestamp;
      console.log(`🚀 Mission T+0 set: ${new Date(this.firstPacketTime).toISOString()}`);
      this.broadcast({ type: MessageType.MISSION_START_TIME, timestamp: Date.now(), payload: { missionStartTime: this.firstPacketTime } });
    }

    this.sensorCache.set(key, update);
    if (!this.dataLoggerServiceEnabled) this.dataLogger.record(key, update.value);

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
      const excess = series.time.length - this.HISTORY_MAX_POINTS;
      series.time.splice(0, excess);
      series.values.splice(0, excess);
    }
    this.historyCacheLastUpdate.set(key, Date.now());

    this.broadcast({ type: MessageType.SENSOR_UPDATE, timestamp: update.timestamp, payload });
    if (this.clients.size === 0 && update.component === 'pressure_psi' && !this._loggedNoFrontendClients) {
      this._loggedNoFrontendClients = true;
      console.warn('⚠️ Backend has no WebSocket clients (frontend not connected?). Open the dashboard at the backend URL (e.g. http://localhost:8082 or port 8081 for WS).');
    }
  }

  private _loggedNoFrontendClients = false;

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
      if (high === 0x10) {
        if (payload.length < 16) {
          if (this.heartbeatPacketCount < 3 || process.env.HEARTBEAT_DEBUG === '1') {
            console.warn(`[Heartbeat] Malformed: board_id=${low} payloadLen=${payload.length} (need >=16)`);
          }
          return;
        }
        this.heartbeatPacketCount++;
        if (process.env.HEARTBEAT_DEBUG === '1') {
          console.log(`[Heartbeat] #${this.heartbeatPacketCount} board_id=${low} type=${payload.readUInt8(9)} state=${payload.readUInt8(11)}`);
        }
        const boardId = low;
        const boardType = payload.readUInt8(9);
        const engineState = payload.readUInt8(10);
        const boardState = payload.readUInt8(11);

        const now = Date.now();
        let status = this.boardsStatus.get(boardId);
        const prevBoardState = status?.boardState ?? null;
        const wasDisconnected =
          !status ||
          status.lastHeartbeatMs == null ||
          now - status.lastHeartbeatMs > 2500;
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
        // On (re)connect, mark config pending so we resend without user clicking Resend
        if (wasDisconnected) {
          this.boardConfigState.set(boardId, { status: 'pending' });
          this.maybeSendConfigPackets({ includeSensors: true });
          this.broadcastBoardStatus(); // Immediate UI update when board connects
        } else {
          // When board returns from Abort/AbortDone to Setup/Active, resend config
          const returnedToOperational =
            (prevBoardState === 3 || prevBoardState === 4) &&
            (boardState === 1 || boardState === 2);
          if (returnedToOperational) {
            this.boardConfigState.set(boardId, { status: 'pending' });
          }
          this.maybeSendConfigPackets();
        }
        return; // Handled, skip typical sensor parsing
      }

      const parsedList = parseElodinPacket(header.packetId, payload, {
        channelToEntityMap: this.channelToEntityMap,
        actuatorChannelToEntityMap: this.actuatorChannelToEntityMap,
      });

      // Fallback: raw PT → psi when calibration_server.py isn't providing PT_Cal packets yet.
      // If we already received a calibrated PT_Cal packet for this channel (via 0x20, 0x1x) we
      // skip the polynomial fallback to avoid stale/double updates.
      if (high === 0x20 && low >= 0x01 && low <= 0x0E && payload.length >= 21) {
        const payloadCh = payload.readUInt8(8);
        const rawAdc = payload.readInt32LE(12);
        const epochNow = Date.now();
        const connectorId = payloadCh - 10; // board 2 channel_offset

        const uniqueId = this.payloadChToUniqueId.get(payloadCh);
        if (uniqueId != null) this.lastRawAdc.set(uniqueId, rawAdc);

        let handledAsHpPt = false;
        for (const cfg of this.hpPtBoards.values()) {
          if (cfg.hpPtConnectors.has(connectorId)) {
            const calEntity = cfg.channelToEntity[connectorId] || this.channelToEntityMap[payloadCh] || `PT_Cal.HP_PT_${connectorId}`;
            const lastCal = this.lastCalibratedPtEntityMs.get(calEntity) ?? 0;
            if (epochNow - lastCal > this.PT_CAL_SUPERSEDES_RAW_MS) {
              const adcExc = cfg.excitationConnectorId >= 0 ? (this.excitationAdcCache.get(`${cfg.boardIp}:${cfg.excitationConnectorId}`) ?? 0) : 2147483648;
              const psi = convertHpPtToPressure(rawAdc, adcExc, cfg);
              if (Number.isFinite(psi) && psi >= this.PSI_ABSOLUTE_MIN && psi <= this.PSI_ABSOLUTE_MAX) {
                this.handleSensorUpdate({ entity: calEntity, component: 'pressure_psi', value: psi, timestamp: epochNow });
                const tsNs = payload.length >= 8 ? payload.readBigUInt64LE(0) : BigInt(epochNow) * 1_000_000n;
                this.elodinPublisher.publishCalibratedPT(low, tsNs, psi, rawAdc & 0xFFFFFFFF, 1);
              }
            }
            handledAsHpPt = true;
            break;
          }
        }

        // Raw PT → PSI fallback removed: PT_Cal now comes from calibration sidecar (config_packet_builder / calibration stack)
      }

      if (parsedList.length === 0) {
        // Log parse failures: first 5 always, then every 100th, and when ELODIN_DEBUG=1
        if (header.ty === ElodinPacketType.TABLE) {
          this._parseNullCount++;
          if (this._parseNullCount <= 5 || this._parseNullCount % 100 === 0 || process.env.ELODIN_DEBUG === '1') {
            console.warn(`[Relay] TABLE packet not parsed #${this._parseNullCount} (packetId=0x${high.toString(16)},0x${low.toString(16)}, len=${payload.length})`);
          }
        }
        return;
      }

      // CRITICAL: Elodin timestamps are steady_clock (nanoseconds since boot ÷ 1e6 = ms since boot),
      // NOT Unix epoch. We must use Date.now() for ALL updates so firstPacketTime is set to epoch,
      // and all subsequent timeSec calculations (relative to firstPacketTime) stay near 0.
      // Mixing clocks causes timeSec = billions → bad data leaks to frontend as spikes.
      const epochNow = Date.now();
      for (const parsed of parsedList) {
        const isValid = Number.isFinite(parsed.value) && !Number.isNaN(parsed.value) &&
          (parsed.component !== 'pressure_psi' || (parsed.value >= this.PSI_ABSOLUTE_MIN && parsed.value <= this.PSI_ABSOLUTE_MAX));
        if (isValid) {
          if (parsed.entity.startsWith('PT_Cal.') && parsed.component === 'pressure_psi') {
            this.lastCalibratedPtEntityMs.set(parsed.entity, epochNow);
          }
          const update: SensorUpdate = { entity: parsed.entity, component: parsed.component, value: parsed.value, timestamp: epochNow };
          this.handleSensorUpdate(update);
        }
      }
      // Do NOT derive ACTUATOR_UPDATE from raw_adc_counts here: that overwrites the authoritative
      // commanded state at telemetry rate and causes oscillation when ADC hovers near threshold.
      // ACTUATOR_UPDATE is only sent when a command is executed (so actuatorStateByEntity stays stable).
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

      const client: Client = { ws, subscribedSensors: new Set(), lastPing: Date.now(), lastPong: Date.now() };
      this.clients.set(ws, client);

      ws.on('pong', () => { client.lastPong = Date.now(); });

      // Send mission start time so client has correct time base for plots
      if (this.firstPacketTime !== null) {
        try { this.send(ws, { type: MessageType.MISSION_START_TIME, timestamp: Date.now(), payload: { missionStartTime: this.firstPacketTime } }); } catch (_) { }
      }
      // Send countdown target so clients render consistently on connect
      try {
        this.send(ws, {
          type: MessageType.COUNTDOWN_TARGET_UPDATE,
          timestamp: Date.now(),
          payload: { targetTimeMs: this.countdownTargetTimeMs },
        });
      } catch (_) { }

      // Send cached sensor data in small batches so we don't flood the socket on connect
      if (this.sensorCache.size > 0) {
        const entries = Array.from(this.sensorCache.values());
        const BATCH = 15;
        let i = 0;
        const sendBatch = () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const end = Math.min(i + BATCH, entries.length);
          for (; i < end; i++) {
            try { this.send(ws, { type: MessageType.SENSOR_UPDATE, timestamp: entries[i].timestamp, payload: entries[i] }); } catch (_) { }
          }
          if (i < entries.length) setImmediate(sendBatch);
        };
        setImmediate(sendBatch);
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
            this.broadcastBoardStatus(); // Immediate board status so pane shows current state
          } catch (error) { console.error('❌ Failed to send connection status:', error); }
        } else if (attempts < 10) { setTimeout(sendStatus, 100); }
      };
      setTimeout(sendStatus, 10);

      ws.on('message', (data: Buffer) => {
        try { this.handleMessage(ws, JSON.parse(data.toString())); } catch (error) { console.error('❌ Failed to parse message:', error); }
      });

      ws.on('close', () => { clearInterval(pingInterval); this.clients.delete(ws); });
      ws.on('error', () => { clearInterval(pingInterval); this.clients.delete(ws); });

      const pingInterval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) { clearInterval(pingInterval); return; }
        // If no pong since the last ping was sent, the connection is dead
        if (client.lastPing > 0 && Date.now() - client.lastPong > 180000) {
          console.warn(`⚠️ WebSocket client ${clientIP} stale (no pong 180s) — closing`);
          ws.terminate();
          clearInterval(pingInterval);
          return;
        }
        client.lastPing = Date.now();
        ws.ping();
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
        const boardCount = this.boardsStatus.size;
        this.boardsStatus.forEach((_, id) => {
          this.boardConfigState.set(id, { status: 'pending' });
        });
        if (this.configBroadcastServiceEnabled) {
          this.forceResendConfig = true;
          console.log(`[CONFIG] Resend config requested – ${boardCount} board(s) pending; config_broadcast_service will send on next poll`);
        } else {
          console.log(`[CONFIG] Resend config requested – sending now (force all boards, including sensors)`);
          this.maybeSendConfigPackets({ forceAll: true, includeSensors: true });
        }
        break;
      case MessageType.QUERY_HISTORICAL: {
        // Send history in a single message; cap points per series so payload doesn't kill the connection
        const MAX_SEND_POINTS = 3000; // keep first load small so WS stays up
        const historyPayload: Record<string, { time: number[]; values: number[] }> = {};
        for (const [key, series] of this.historyCache.entries()) {
          const len = series.time.length;
          if (len === 0) continue;
          const start = len > MAX_SEND_POINTS ? len - MAX_SEND_POINTS : 0;
          historyPayload[key] = {
            time: series.time.slice(start),
            values: series.values.slice(start),
          };
        }
        this.send(ws, {
          type: MessageType.HISTORICAL_DATA,
          timestamp: Date.now(),
          payload: historyPayload,
        });
        break;
      }
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
    const canPublish = this.elodin.isConnected() || this.elodinRelay?.isConnected();
    if (command.commandType === 'state_transition' && !canPublish && !this.debugMode && this.actuatorServicePort <= 0) {
      console.error(`❌ Cannot send state transition: elodin=${this.elodin.isConnected()} relay=${this.elodinRelay?.isConnected()} (need one for DB publish)`);
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
            console.warn(`Invalid state transition (not broadcast): ${SystemState[currentState]} → ${SystemState[newState]}`);
            return;
          }
        }

        const prevState = this.currentState;
        // Try direct Elodin first; fall back to relay, debug mode, or actuator_service.
        // The relay can forward publish commands to Elodin DB via publishTable().
        // endFireState() already treats sendCommand as fire-and-forget, so local
        // state transitions don't strictly require the direct connection.
        const success = this.elodin.isConnected()
          ? this.elodin.sendCommand('state_transition', { state: newState })
          : (this.debugMode || this.actuatorServicePort > 0 || (this.elodinRelay?.isConnected() ?? false));
        if (success) {
          if (this.currentState === SystemState.FIRE && newState !== SystemState.FIRE) {
            if (this.fireEndTimer) { clearTimeout(this.fireEndTimer); this.fireEndTimer = null; }
            this.fireStartTimeMs = null;
          }
          if (!this.dataLoggerServiceEnabled) {
            if (newState === SystemState.ARMED && !this.dataLogger.running) this.dataLogger.start();
            else if ((newState === SystemState.IDLE || newState === SystemState.EMERGENCY_ABORT) && this.dataLogger.running) {
              const stats = this.dataLogger.stop();
              if (stats) console.log(`📝 Run logged: ${stats.filePath}`);
            }
          }

          this.currentState = newState;
          publishControllerStateTransition(this.elodin, prevState ?? SystemState.IDLE, newState, 0, this.elodinRelay);
          this.broadcast({ type: MessageType.STATE_UPDATE, timestamp: Date.now(), payload: { currentState: newState, stateName: SystemState[newState], timestamp: Date.now(), debugMode: this.debugMode } });

          const useCppActuatorService = this.actuatorServicePort > 0;
          if (this.debugMode && useCppActuatorService) {
            stopContinuousActuatorCommands(this);
            this.manuallyCommandedChannels.clear();
            const enumKey = SystemState[newState] ?? 'IDLE';
            forwardStateToActuatorService(enumKey, this.actuatorServicePort).catch(() => { });
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
                if (newState !== SystemState.IDLE) {
                  startContinuousActuatorCommands(this, newState, STATE_ACTUATOR_MAP);
                }
              }
            });
          } else {
            this.manuallyCommandedChannels.clear();
            console.log(`🎯 State changed to ${SystemState[newState]} – relying on C++ actuator_service`);
          }

          broadcastActuatorExpectedPositions(this, newState, STATE_ACTUATOR_MAP);
          this.publishActuatorStatesForStateToElodin(newState, STATE_ACTUATOR_MAP);

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

        // Fire timer and C++ controller gate
        if (newState === SystemState.FIRE) {
          if (this.controllerServicePort > 0) {
            console.log('🎯 FIRE state entered – sending FIRE_START to C++ controller service');
            forwardFireStateToControllerService(true, this.controllerServicePort).catch(() => { });
          }
          if (this.fireEndTimer) { clearTimeout(this.fireEndTimer); this.fireEndTimer = null; }
          this.fireStartTimeMs = Date.now();
          this.fireEndTimer = setTimeout(() => this.endFireState(), this.fireDurationMs);
        } else if (prevState === SystemState.FIRE) {
          if (this.controllerServicePort > 0) {
            forwardFireStateToControllerService(false, this.controllerServicePort).catch(() => { });
          }
        }

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
                if (boardInfo) {
                  this.manuallyCommandedChannels.add(`${boardInfo.channel}@${boardInfo.boardIp}`);
                  publishActuatorStateToElodin(this.elodin, boardInfo.channel, open ? 1 : 0, this.elodinRelay);
                }
                this.broadcast({ type: MessageType.ACTUATOR_UPDATE, timestamp: Date.now(), payload: { name: commandActuatorName, state: actuatorState, rawAdcCounts: 0, timestamp: Date.now() } as ActuatorUpdate });
              } else {
                const boardInfo = getActuatorBoardInfo(this, commandActuatorName);
                if (boardInfo) {
                  const actuatorType = getActuatorType(commandActuatorName);
                  const hardwareState = guiStateToHardwareState(open ? 1 : 0, actuatorType);
                  this.manuallyCommandedChannels.add(`${boardInfo.channel}@${boardInfo.boardIp}`);
                  const success = sendActuatorCommandUDP(this, boardInfo.channel, hardwareState, boardInfo.boardIp);
                  if (success) {
                    publishActuatorStateToElodin(this.elodin, boardInfo.channel, hardwareState, this.elodinRelay);
                    this.broadcast({ type: MessageType.ACTUATOR_UPDATE, timestamp: Date.now(), payload: { name: commandActuatorName, state: actuatorState, rawAdcCounts: 0, timestamp: Date.now() } as ActuatorUpdate });
                  }
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
              publishActuatorStateToElodin(this.elodin, channelId, hardwareState, this.elodinRelay);
              this.broadcast({ type: MessageType.ACTUATOR_UPDATE, timestamp: Date.now(), payload: { name: commandActuatorName, state: actuatorState, rawAdcCounts: 0, timestamp: Date.now() } as ActuatorUpdate });
            }
          }
        }
      } else if (command.commandType === 'extend_fire') {
        if (this.currentState === SystemState.FIRE && this.fireStartTimeMs != null) {
          if (this.fireEndTimer) { clearTimeout(this.fireEndTimer); this.fireEndTimer = null; }
          const remaining = Math.max(0, this.fireExtendedMs - (Date.now() - this.fireStartTimeMs));
          this.fireEndTimer = setTimeout(() => this.endFireState(), remaining);
          console.log(`🎯 FIRE extended to ${(this.fireExtendedMs / 1000).toFixed(1)}s from start – ${(remaining / 1000).toFixed(1)}s remaining`);
        }
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
            if (this.currentState !== SystemState.IDLE) {
              startContinuousActuatorCommands(this, this.currentState, STATE_ACTUATOR_MAP);
            }
          } else if (this.debugMode) {
            stopContinuousActuatorCommands(this);
            this.manuallyCommandedChannels.clear();
          }
          if (this.currentState !== null) {
            this.broadcast({ type: MessageType.STATE_UPDATE, timestamp: Date.now(), payload: { currentState: this.currentState, stateName: SystemState[this.currentState], timestamp: Date.now(), debugMode: this.debugMode } });
          }
        }
      } else if (command.commandType === 'set_countdown_target') {
        const raw = (command.data as any)?.targetTimeMs as unknown;
        const next = raw === null ? null : (typeof raw === 'number' ? raw : null);
        if (next !== null && (!Number.isFinite(next) || next < 946684800000 || next > 4102444800000)) {
          console.warn('⚠️ set_countdown_target: rejected invalid targetTimeMs:', raw);
          return;
        }
        this.countdownTargetTimeMs = next;
        saveCountdownTargetTimeMs(this.countdownTargetTimeMs);
        this.broadcast({
          type: MessageType.COUNTDOWN_TARGET_UPDATE,
          timestamp: Date.now(),
          payload: { targetTimeMs: this.countdownTargetTimeMs },
        });
      }
    } catch (error) {
      console.error('❌ Command error:', error);
      // Log only; do not broadcast command errors to UI (avoids mismatch/state-definition noise)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Update loop, broadcast, send, shutdown
  // ═══════════════════════════════════════════════════════════════════════════

  /** Prune historyCache to prevent lag buildup over long sessions. */
  private pruneHistoryCache(): void {
    const now = Date.now();
    if (this.historyCache.size <= this.HISTORY_MAX_KEYS) {
      for (const [key, ms] of this.historyCacheLastUpdate) {
        if (now - ms > this.HISTORY_STALE_MS) {
          this.historyCache.delete(key);
          this.historyCacheLastUpdate.delete(key);
        }
      }
    } else {
      const byAge = Array.from(this.historyCacheLastUpdate.entries()).sort((a, b) => a[1] - b[1]);
      const toRemove = this.historyCache.size - this.HISTORY_MAX_KEYS;
      for (let i = 0; i < toRemove && i < byAge.length; i++) {
        const [key] = byAge[i];
        this.historyCache.delete(key);
        this.historyCacheLastUpdate.delete(key);
      }
    }
  }

  /** Current server uptime in milliseconds since this backend process started. */
  private getServerUptimeMs(): number {
    return Date.now() - this.serverStartTimeMs;
  }

  private startUpdateLoop(): void {
    this.updateInterval = setInterval(() => { }, 50);

    // Startup config retry: relay may connect late; retry at 2s, 4s, 6s so config reaches boards
    [2000, 4000, 6000].forEach((ms) => {
      setTimeout(() => this.maybeSendConfigPackets({ forceAll: true, includeSensors: true }), ms);
    });

    // Calibration status: frontend polls GET /api/calibration_status (no backend sync loop)

    // Prune historyCache keys to prevent lag buildup over long sessions (5–10+ min)
    this.historyPruneInterval = setInterval(() => this.pruneHistoryCache(), 60 * 1000);

    // Periodic heartbeat diagnostic (every 15s) — helps debug when boards show DISCONNECTED despite sending
    setInterval(() => {
      if (this.heartbeatPacketCount === 0 && this.relayPacketCount > 0) {
        console.warn(`⚠️ Relay received ${this.relayPacketCount} packets but 0 heartbeats — is daq_bridge running and publishing to Elodin?`);
      }
    }, 15000);

    // Broadcast board heartbeat / connection status to all clients every second
    setInterval(() => {
      // Drive config state machine on a slow loop as well (for late-connecting boards)
      this.maybeSendConfigPackets();

      // SERVER_HEARTBEAT moved to standalone heartbeat_service (scripts/services/heartbeat_service.py)
      // Backend is GUI-only; heartbeat service polls /api/engine_state and broadcasts

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

      const snapshot = this.getBoardStatusSnapshot();
      if (snapshot.length > 0) {
        this.broadcast({
          type: MessageType.BOARD_STATUS_UPDATE,
          timestamp: Date.now(),
          payload: { boards: snapshot },
        });
      }
      if (this.clients.size === 0) return;

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

  /** Publish commanded actuator states to Elodin and broadcast ACTUATOR_UPDATE for DataLogger. */
  private publishActuatorStatesForStateToElodin(state: SystemState, map: StateActuatorMap): void {
    const expected = map[state];
    if (!expected) return;
    const FIRE_PWM_SKIP = new Set<string>(['Fuel Press', 'LOX Press']);
    for (const [actuatorName, guiVal] of Object.entries(expected)) {
      if (state === SystemState.FIRE && FIRE_PWM_SKIP.has(actuatorName)) continue;
      const boardInfo = getActuatorBoardInfo(this, actuatorName);
      if (!boardInfo) continue;
      const actuatorType = getActuatorType(actuatorName);
      const hardwareState = guiStateToHardwareState(guiVal, actuatorType);
      publishActuatorStateToElodin(this.elodin, boardInfo.channel, hardwareState, this.elodinRelay);
      this.broadcast({
        type: MessageType.ACTUATOR_UPDATE,
        timestamp: Date.now(),
        payload: { name: actuatorName, state: guiVal === 1 ? ActuatorState.OPEN : ActuatorState.CLOSED, rawAdcCounts: 0, timestamp: Date.now() } as ActuatorUpdate,
      });
    }
  }

  /**
   * Auto-end FIRE state after 2s (or 5s if extended): transition to ARMED, FIRE_STOP, actuators.
   */
  private endFireState(): void {
    if (this.fireEndTimer) { clearTimeout(this.fireEndTimer); this.fireEndTimer = null; }
    this.fireStartTimeMs = null;
    if (this.currentState !== SystemState.FIRE) return;
    const newState = SystemState.ARMED;
    const prevState = this.currentState as SystemState;
    this.currentState = newState;
    publishControllerStateTransition(this.elodin, prevState, newState, 0, this.elodinRelay);
    this.broadcast({ type: MessageType.STATE_UPDATE, timestamp: Date.now(), payload: { currentState: newState, stateName: SystemState[newState], timestamp: Date.now(), debugMode: this.debugMode } });
    console.log('🎯 FIRE auto-ended – sending FIRE_STOP, transitioning to ARMED');
    if (this.controllerServicePort > 0) forwardFireStateToControllerService(false, this.controllerServicePort).catch(() => { });
    if (this.elodin.isConnected()) this.elodin.sendCommand('state_transition', { state: newState });
    const useCppActuatorService = this.actuatorServicePort > 0;
    this.manuallyCommandedChannels.clear();
    stopContinuousActuatorCommands(this);
    if (useCppActuatorService) forwardStateToActuatorService('ARMED', this.actuatorServicePort).catch(() => { });
    else applyActuatorsForState(this, newState, STATE_ACTUATOR_MAP);
    broadcastActuatorExpectedPositions(this, newState, STATE_ACTUATOR_MAP);
    this.publishActuatorStatesForStateToElodin(newState, STATE_ACTUATOR_MAP);
    console.log('🎯 FIRE state auto-ended – transitioned to ARMED');
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
      const timestamp = Math.floor(this.getServerUptimeMs()) >>> 0;
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
      const operational = isConnected && (status.boardState === 1 || status.boardState === 2);

      result.push({
        type: status.type,
        boardNumber: status.boardNumber,
        id: status.id,
        ip: status.ip,
        expected: status.expected,
        connected: isConnected,
        operational,
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

  /** Broadcast current board status to all clients (and MessageLogger for DB). */
  private broadcastBoardStatus(): void {
    const snapshot = this.getBoardStatusSnapshot();
    if (snapshot.length === 0) return;
    this.broadcast({
      type: MessageType.BOARD_STATUS_UPDATE,
      timestamp: Date.now(),
      payload: { boards: snapshot },
    });
  }

  async getCalibrationStatus(): Promise<any> {
    return this.calibrationSidecar?.getStatus() ?? null;
  }

  getDebugInfo(): DebugInfo {
    return {
      relayConnected: this.elodinRelay?.isConnected() ?? false,
      relayPacketsReceived: this.relayPacketCount,
      heartbeatPacketsReceived: this.heartbeatPacketCount,
      wsClients: this.clients.size,
      sensorCacheSize: this.sensorCache.size,
      useRelay: true,
    };
  }

  broadcast(message: any): void {
    if (message && typeof message === 'object' && typeof message.timestamp === 'number') {
      (message as any).serverTimeMs = this.getServerUptimeMs();
    }
    if (this.messageLogger) this.messageLogger.logMessage(message);
    if (!this.dataLoggerServiceEnabled && this.dataLogger.running) {
      if (message?.type === MessageType.STATE_UPDATE && message?.payload?.currentState != null) {
        this.dataLogger.record('PSM.state', message.payload.currentState as number);
      } else if (message?.type === MessageType.ACTUATOR_UPDATE && message?.payload?.name && message?.payload?.state != null) {
        this.dataLogger.record(`ACT.${(message.payload.name as string).replace(/\s+/g, '_')}.actuator_state`, message.payload.state as number);
      }
    }
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
    if (message && typeof message === 'object' && typeof message.timestamp === 'number') {
      (message as any).serverTimeMs = this.getServerUptimeMs();
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  /**
   * Config packets are now built and sent by config_broadcast_service.py (standalone).
   * This is a no-op.
   */
  private maybeSendConfigPackets(_options?: { forceAll?: boolean; includeSensors?: boolean }): void {
    // No-op: config_broadcast_service.py handles ACTUATOR_CONFIG/SENSOR_CONFIG
  }

  shutdown(): void {
    if (this.updateInterval) clearInterval(this.updateInterval);
    if (this.historyPruneInterval) { clearInterval(this.historyPruneInterval); this.historyPruneInterval = null; }
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
  () => server.reloadConfig(),
  () => (server.currentState ?? 0) as number,  // 0 = IDLE; for heartbeat service
  () => server.getCalibrationStatus()
);

process.on('SIGINT', () => { console.log('\n🛑 Shutting down server...'); server.shutdown(); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n🛑 Shutting down server...'); server.shutdown(); process.exit(0); });

console.log(`🚀 WebSocket server starting on ${WS_HOST}:${WS_PORT}`);
console.log(`📡 Connecting to Elodin DB at ${ELODIN_HOST}:${ELODIN_PORT}`);
console.log(`🌐 External clients can connect via: ws://<your-ip>:${WS_PORT}`);
