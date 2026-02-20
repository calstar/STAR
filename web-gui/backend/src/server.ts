/**
 * WebSocket Server for Sensor System GUI
 * Bridges Elodin DB to WebSocket clients with <30ms latency
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as dgram from 'dgram';
import { ElodinClient, ElodinPacketType } from './elodin-client.js';
import { DAQDirectClient } from './daq-direct-client.js';
import { ElodinQueryClient } from './elodin-query.js';
import { parseElodinPacket } from './elodin-protocol.js';
import { registerVTables } from './elodin-vtable.js';
import { subscribeWithStream } from './elodin-stream.js';
import { encodeRawPTMessage, encodeCalibratedPTMessage } from './elodin-publisher.js';
import { getStateTransitions, isTransitionAllowed } from './routes/state-transitions.js';
import { getStateActuatorMap, StateActuatorMap } from './routes/state-actuators.js';
import { startAPIServer } from './api-server.js';
import { loadPTCalibration, calculatePressure, CalibrationCoefficients } from './calibration.js';
import { Phase2CalibrationEngine } from './calibration-phase2.js';
import { DataLogger } from './data-logger.js';
import { readConfig } from './routes/config.js';
import { ControllerClient, mapSensorDataToMeasurement, ControllerCommand } from './controller-client.js';
import { DemoModeGenerator } from './demo-mode.js';
import {
  MessageType,
  SensorUpdate,
  ActuatorUpdate,
  StateUpdate,
  CommandPayload,
  ConnectionStatus,
  SystemState,
  ActuatorId,
  ActuatorState,
} from '../../shared/types.js';

const WS_PORT = parseInt(process.env.WS_PORT || '8081', 10);
const WS_HOST = process.env.WS_HOST || '0.0.0.0'; // Allow external connections
// Elodin DB listens on [::]:2240 (IPv6), try localhost which should work for both
const ELODIN_HOST = process.env.ELODIN_HOST || '::1'; // Use IPv6 to match Elodin DB's [::]:2240 binding
const ELODIN_PORT = parseInt(process.env.ELODIN_PORT || '2240', 10);

interface Client {
  ws: WebSocket;
  subscribedSensors: Set<string>;
  lastPing: number;
}

// ── Actuator ID → board channel (from config.toml actuator_roles) ──────────
const ACTUATOR_CHANNEL: Record<number, number> = {
  [ActuatorId.LOX_MAIN]:     1,
  [ActuatorId.FUEL_MAIN]:    7,
  [ActuatorId.LOX_VENT]:     6,
  [ActuatorId.FUEL_VENT]:    2,
  [ActuatorId.LOX_PRESS]:    8,
  [ActuatorId.FUEL_PRESS]:   3,
  [ActuatorId.GSE_LOW_VENT]: 5,
};

// ── Expected actuator positions per state (loaded from state_machine_actuators.csv) ─
// Maps SystemState → { channelId → 0|1 (CLOSED|OPEN) }
// Loaded dynamically from CSV in constructor
let STATE_ACTUATOR_MAP: StateActuatorMap = {};

class SensorSystemServer {
  private wss: WebSocketServer;
  private elodin: ElodinClient;
  private queryClient: ElodinQueryClient | null = null;
  private daqDirect: DAQDirectClient | null = null;
  private clients: Map<WebSocket, Client> = new Map();
  private sensorCache: Map<string, SensorUpdate> = new Map();
  private updateInterval: NodeJS.Timeout | null = null;
  private useDirectDAQ: boolean = false; // Use Elodin DB for data (DAQ Bridge writes to DB, we read from DB)
  private useQueryPolling: boolean = process.env.ELODIN_USE_QUERY === 'true'; // Fallback to query/polling
  private streamingDataReceived: boolean = false;
  private streamingCheckTimer: NodeJS.Timeout | null = null;
  private ptCalibration: Map<number, CalibrationCoefficients> = new Map();
  private phase2Engine: Phase2CalibrationEngine | null = null;
  private actuatorSocket: dgram.Socket | null = null;
  private actuatorIP: string = '192.168.2.201'; // Default actuator board IP
  private actuatorPort: number = 5005; // Default actuator command port

  /** Throttle Phase 2 monitoring to ~5 Hz per channel */
  private phase2LastMonitor: Map<number, number> = new Map();
  private readonly PHASE2_MONITOR_INTERVAL_MS = 200; // 5 Hz

  /** Throttle WS broadcasts per entity to ~10 Hz (cache is always instant) */
  private broadcastLastTime: Map<string, number> = new Map();
  private readonly BROADCAST_MIN_INTERVAL_MS = 100; // 10 Hz per entity

  /** Binary data logger for runs */
  private dataLogger = new DataLogger();

  /** Logging throttle */
  private _lastSensorLog = 0;
  
  /** Track if we've received calibrated PT from Elodin recently (per channel) */
  private calibratedPTFromElodin: Map<number, number> = new Map(); // channelId -> timestamp

  /** Current system state for continuous actuator command sending */
  private currentState: SystemState | null = null;
  private actuatorCommandInterval: NodeJS.Timeout | null = null;
  private readonly ACTUATOR_COMMAND_INTERVAL_MS = 1000; // Send actuator commands every 1 second while in state

  /** Controller client for DDP controller integration */
  private controllerClient: ControllerClient | null = null;
  private controllerLoopInterval: NodeJS.Timeout | null = null;
  private readonly CONTROLLER_LOOP_INTERVAL_MS = 100; // Controller loop at 10 Hz
  private controllerCommand: ControllerCommand = { command_type: 'THRUST_DESIRED', thrust_desired: 1000 };

  /** Channel ID → entity name map (loaded from config.toml sensor_roles) */
  private channelToEntityMap: Record<number, string> = {};

  /** Demo mode generator for testing without hardware */
  private demoMode: DemoModeGenerator;

  constructor() {
    console.log(`🚀 Starting Sensor System Server...`);
    console.log(`   WebSocket: ${WS_HOST}:${WS_PORT}`);
    console.log(`   Elodin DB: ${ELODIN_HOST}:${ELODIN_PORT}`);
    
    // Initialize demo mode
    this.demoMode = new DemoModeGenerator();

    // Load PT calibration (like combined_fsw_gui.py)
    this.ptCalibration = loadPTCalibration();

    // Load sensor_roles from config.toml (like combined_gui.py)
    this.loadSensorRoleMap();

    // Initialize controller client (connects to FastAPI controller service)
    const controllerUrl = process.env.CONTROLLER_URL || 'http://localhost:8000';
    this.controllerClient = new ControllerClient(controllerUrl);
    console.log(`🎯 Controller client initialized: ${controllerUrl}`);

    // Load state actuator map from CSV (replaces hardcoded map)
    STATE_ACTUATOR_MAP = getStateActuatorMap();
    if (Object.keys(STATE_ACTUATOR_MAP).length === 0) {
      console.warn('⚠️ No state actuator map loaded - actuators will not auto-command');
    } else {
      console.log(`📋 Loaded state actuator map: ${Object.keys(STATE_ACTUATOR_MAP).length} states`);
    }

    // Build transition validation map
    const transitions = getStateTransitions();
    if (transitions.length === 0) {
      console.warn('⚠️ No state transitions loaded - all transitions will be allowed');
    } else {
      console.log(`📋 Loaded ${transitions.length} allowed state transitions`);
    }

    // Initialize Phase 2 autonomous calibration engine
    this.phase2Engine = new Phase2CalibrationEngine();

    // Load saved Phase 2 calibration if it exists (wrap in try-catch to prevent crashes)
    let savedCalibration: Map<number, CalibrationCoefficients> = new Map();
    try {
      savedCalibration = this.phase2Engine.loadSavedCalibration();
    } catch (err) {
      console.warn('⚠️ Failed to load saved Phase 2 calibration, continuing without it:', err);
    }
    
    // Initialize Phase 2 for all sensors with existing calibration
    this.ptCalibration.forEach((coeffs, sensorId) => {
      try {
        this.phase2Engine!.initializeSensor(sensorId, coeffs);
        
        // If we have saved calibration for this sensor, restore it
        const saved = savedCalibration.get(sensorId);
        if (saved) {
          const state = this.phase2Engine!.getSensorState(sensorId);
          if (state) {
            // Restore saved adjustment values (saved = baseline + adjustment)
            state.adjustment = {
              A: saved.A - coeffs.A,
              B: saved.B - coeffs.B,
              C: saved.C - coeffs.C,
              D: saved.D - coeffs.D,
            };
            console.log(`📋 Restored saved Phase 2 calibration for sensor ${sensorId}`);
          }
        }
      } catch (err) {
        console.error(`❌ Failed to initialize Phase 2 for sensor ${sensorId}:`, err);
        // Continue with other sensors
      }
    });
    console.log(`🤖 Phase 2 calibration engine initialized for ${this.ptCalibration.size} sensors`);

    // Initialize UDP socket for actuator commands (like combined_gui.py)
    this.actuatorSocket = dgram.createSocket('udp4');
    console.log(`🎯 Actuator command socket initialized (target: ${this.actuatorIP}:${this.actuatorPort})`);

    this.wss = new WebSocketServer({
      port: WS_PORT,
      host: WS_HOST,
      perMessageDeflate: false, // Disable compression for lower latency
    });

    // Handle WebSocket server errors gracefully
    this.wss.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        console.warn(`⚠️ Port ${WS_PORT} already in use. WebSocket server will not start.`);
        console.warn(`   This is OK if another instance is running.`);
      } else {
        console.error('❌ WebSocket server error:', error);
      }
    });

    this.wss.on('listening', () => {
      const address = this.wss.address();
      console.log(`✅ WebSocket server listening on ${WS_HOST}:${WS_PORT}`);
      if (address && typeof address === 'object') {
        console.log(`   Server bound to: ${address.address}:${address.port}`);
      }
      console.log(`   Ready to accept client connections`);
      console.log(`   Frontend should connect to: ws://localhost:${WS_PORT} or ws://${WS_HOST === '0.0.0.0' ? 'your-ip' : WS_HOST}:${WS_PORT}`);
    });

    this.elodin = new ElodinClient(ELODIN_HOST, ELODIN_PORT);

    // Always set up WebSocket FIRST (critical for frontend connection)
    this.setupWebSocket();

    // Set up Elodin DB connection (primary data source)
    this.setupElodin();

    // Set up direct DAQ ONLY if explicitly enabled (for testing/bypassing Elodin)
    if (this.useDirectDAQ) {
      console.log('🚀 Using DIRECT DAQ connection for real-time data');
      console.log('   ⚠️ NOTE: DAQ Bridge should be STOPPED - backend receives packets directly');
      console.log('   ✅ Data flows: Boards → Backend → Frontend (real-time)');
      console.log('   ⚠️ Elodin DB writes not yet implemented (requires TABLE packet format)');
      this.setupDirectDAQ();
    } else {
      console.log('📡 Using Elodin DB for data (DAQ Bridge → Elodin DB → Backend → Frontend)');
      console.log('   ✅ Data flows: DAQ Bridge → Elodin DB → Backend → Frontend');
      console.log('   ⏳ Waiting for data from Elodin DB...');
      console.log('   Make sure DAQ Bridge is running and sending data to Elodin DB');
    }

    this.startUpdateLoop();
    
    // Start demo mode if enabled
    if (this.demoMode.isEnabled()) {
      console.log('🎭 Starting demo mode data generation...');
      this.demoMode.start((update: SensorUpdate) => {
        // Send demo data to WebSocket clients
        this.handleSensorUpdate(update);
        
        // Also publish to Elodin DB if connected (dual streaming)
        if (this.elodin.isConnected()) {
          try {
            // Extract channel ID from entity name
            const channelMatch = update.entity.match(/PT_CH(\d+)|ACT_CH(\d+)/);
            if (channelMatch) {
              const channelId = parseInt(channelMatch[1] || channelMatch[2], 10);
              if (update.component === 'raw_adc_counts') {
                const timestampNs = BigInt(Date.now()) * BigInt(1000000);
                const rawPayload = encodeRawPTMessage(
                  timestampNs,
                  channelId,
                  Math.round(update.value),
                  Date.now(),
                  0
                );
                this.elodin.publishTable([0x20, channelId], rawPayload);
              }
            }
          } catch (err) {
            // Silently fail - demo mode doesn't require DB
          }
        }
      }, 10); // 10 Hz generation rate
    }
  }

  /**
   * Load sensor_roles from config.toml and build channel ID → entity name map
   * Matches combined_gui.py's CONFIG.get_sensor_role() behavior
   */
  private loadSensorRoleMap(): void {
    try {
      const config = readConfig();
      const sensorRoles = config.sensor_roles || {};
      
      // Build reverse map: channel_id → role_name
      // config.toml format: "Fuel Upstream" = 1 means channel 1 → "Fuel Upstream"
      const reverseMap: Record<number, string> = {};
      for (const [roleName, channelId] of Object.entries(sensorRoles)) {
        if (typeof channelId === 'number' && channelId >= 1 && channelId <= 10) {
          // Convert role name to entity format: "Fuel Upstream" → "PT_Cal.Fuel_Upstream"
          const entityName = roleName.replace(/\s+/g, '_'); // Replace spaces with underscores
          reverseMap[channelId] = `PT_Cal.${entityName}`;
        }
      }
      
      this.channelToEntityMap = reverseMap;
      console.log(`📋 Loaded sensor role map from config.toml:`, this.channelToEntityMap);
    } catch (error) {
      console.warn('⚠️ Failed to load sensor_roles from config.toml, using defaults:', error);
      // Fallback to hardcoded defaults (matches original behavior)
      this.channelToEntityMap = {
        1: 'PT_Cal.Fuel_Upstream',
        2: 'PT_Cal.GSE_Low',
        3: 'PT_Cal.GSE_Mid',
        4: 'PT_Cal.Fuel_Downstream',
        5: 'PT_Cal.Ox_Upstream',
        6: 'PT_Cal.GN2_Regulated',
        7: 'PT_Cal.Ox_Downstream',
        8: 'PT_Cal.PT_CH8',
        9: 'PT_Cal.PT_CH9',
        10: 'PT_Cal.PT_CH10',
      };
    }
  }

  private setupElodin(): void {
    this.elodin.on('connected', async () => {
      console.log('✅ Elodin connected, broadcasting to clients');
      console.log('🔍 Connection status:');
      console.log(`   - Elodin client connected: ${this.elodin.isConnected()}`);
      console.log(`   - WebSocket clients: ${this.clients.size}`);

      // CRITICAL: Try Stream message subscription first (most likely to work)
      console.log('📡 Trying Stream message subscription (with empty filter = all data)...');
      await subscribeWithStream(this.elodin);

      // Wait to see if Stream subscription works
      await new Promise(resolve => setTimeout(resolve, 500));

      if (!this.streamingDataReceived) {
        console.log('⚠️ No data after Stream subscription. Trying MsgStream/VTableStream...');
        await registerVTables(this.elodin);
      } else {
        console.log('✅ Stream subscription successful! Receiving data...');
      }

      // Reset streaming check
      this.streamingDataReceived = false;

      console.log('⏳ Waiting for TABLE packets from Elodin DB...');
      console.log('   If no data appears, check:');
      console.log('   1. Is DAQ Bridge running and sending data?');
      console.log('   2. Are VTables registered (DAQ Bridge should do this)?');
      console.log('   3. Check Elodin DB logs for incoming data');

      // Start streaming check - will warn if no data after 10 seconds
      this.startStreamingCheck();

      this.broadcast({
        type: MessageType.CONNECTION_STATUS,
        timestamp: Date.now(),
        payload: { connected: true, elodinConnected: true } as ConnectionStatus,
      });
    });

    this.elodin.on('disconnected', () => {
      console.log('❌ Elodin disconnected');
      this.broadcast({
        type: MessageType.CONNECTION_STATUS,
        timestamp: Date.now(),
        payload: { connected: true, elodinConnected: false } as ConnectionStatus,
      });
    });

    this.elodin.on('packet', (header, payload) => {
      // Mark that we received streaming data
      if (!this.streamingDataReceived && header.ty === ElodinPacketType.TABLE) {
        this.streamingDataReceived = true;
        if (this.streamingCheckTimer) {
          clearTimeout(this.streamingCheckTimer);
          this.streamingCheckTimer = null;
        }
        const [high, low] = header.packetId;
        console.log(`✅ Streaming data received from Elodin DB!`);
        console.log(`   First TABLE packet: packetId=[0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}], payloadLen=${payload.length}`);
      }
      this.handleElodinPacket(header, payload);
    });

    // Connect to Elodin (non-blocking, will retry on failure)
    // In demo mode, skip Elodin connection
    if (!this.demoMode.isEnabled()) {
      this.elodin.connect().then(() => {
        console.log('✅ Elodin connection established');
        // Send periodic keepalive to ensure connection stays alive
        setInterval(() => {
          if (this.elodin.isConnected()) {
            // Send empty MSG packet as keepalive
            const keepaliveId: [number, number] = [0x00, 0x00];
            this.elodin.sendRawMessage(keepaliveId, ElodinPacketType.MSG, Buffer.alloc(0));
          }
        }, 5000); // Every 5 seconds
      }).catch((error) => {
        console.error('❌ Elodin connection error:', error);
      });
    } else {
      console.log('🎭 Demo mode: Skipping Elodin DB connection');
      // In demo mode, simulate connection
      this.broadcast({
        type: MessageType.CONNECTION_STATUS,
        timestamp: Date.now(),
        payload: { connected: true, elodinConnected: false } as ConnectionStatus,
      });
    }

    // Handle Elodin errors gracefully (don't crash)
    this.elodin.on('error', () => {
      // Errors are already logged, just prevent unhandled error crashes
    });
  }

  /**
   * Start a timer to check if streaming data is received
   * If no data after 5 seconds, fallback to query polling
   */
  private startStreamingCheck(): void {
    if (this.streamingCheckTimer) {
      clearTimeout(this.streamingCheckTimer);
    }

    this.streamingCheckTimer = setTimeout(() => {
      if (!this.streamingDataReceived) {
        console.warn('⚠️ No streaming data received from Elodin DB after 10 seconds');
        console.warn('   Elodin DB requires VTable registration before streaming');
        console.warn('   Falling back to DIRECT DAQ connection (like combined_gui.py)...');
        console.warn('');

        // Fallback to direct DAQ connection
        if (!this.daqDirect) {
          console.log('🔌 Setting up direct UDP connection to DAQ boards...');
          console.log('   This bypasses Elodin DB and receives data directly from boards');
          this.setupDirectDAQ();
        }
      } else {
        console.log('✅ Streaming data confirmed - Elodin DB is sending TABLE packets');
      }
      this.streamingCheckTimer = null;
    }, 4000); // 4 seconds before DAQ fallback
  }

  private setupDirectDAQ(): void {
    console.log('🔌 Setting up direct UDP listener for DiabloAvionics boards...');
    console.log('   This receives packets directly from boards (bypassing Elodin DB streaming)');
    console.log('   ⚠️ CRITICAL: DAQ Bridge must be STOPPED - it also uses port 5006');
    console.log('   Data will still be written to Elodin DB for persistence (if connected)');

    // Create UDP listener on port 5006 (DiabloAvionics default)
    this.daqDirect = new DAQDirectClient('0.0.0.0', 5006);

    this.daqDirect.on('connected', () => {
      console.log('✅ Direct DAQ connection established - listening for board packets on port 5006');
      this.broadcast({
        type: MessageType.CONNECTION_STATUS,
        timestamp: Date.now(),
        payload: { connected: true, elodinConnected: false } as ConnectionStatus,
      });
    });

    // EXACT combined_gui.py implementation: on_sensor_data handler
    this.daqDirect.on('sensor_data', (header: any, chunks: Array<any>, sourceIP: string) => {
      // Log sensor data sparingly to avoid choking the event loop
      const now = Date.now();
      if (now - this._lastSensorLog > 5000) {
        this._lastSensorLog = now;
        console.log(`📥 Sensor data from ${sourceIP}: ${chunks.length} chunks`);
      }

      // EXACT from combined_gui.py: filter by source IP
      // Temporarily accept ALL IPs to see if packets are arriving
      // const filterSourceIP = '192.168.2.101'; // Default PT board IP (from combined_gui.py)
      // if (sourceIP !== filterSourceIP) {
      //   return; // Ignore actuator board data (handled separately in combined_gui.py)
      // }

      const currentTime = Date.now();
      const timestampNs = BigInt(currentTime) * BigInt(1000000); // Convert ms to ns
      const statsStartTime = (this.daqDirect as any).statsStartTime || currentTime;
      if (!(this.daqDirect as any).statsStartTime) {
        (this.daqDirect as any).statsStartTime = currentTime;
      }

      // CRITICAL: Publish to Elodin DB if connected (like DAQ Bridge does)
      const publishingToElodin = this.elodin.isConnected();

      // Process each chunk (EXACT from combined_gui.py on_sensor_data)
      for (const chunk of chunks) {
        const chunkTimestampMs = chunk.timestamp;
        const relativeTime = (currentTime - statsStartTime) / 1000; // Relative time in seconds

        // Process each datapoint (EXACT from combined_gui.py)
        for (const dp of chunk.datapoints) {
          const sensorIdPacket = dp.sensor_id; // From packet (0-9 or 1-10, depending on hardware)
          
          // Skip sensor_id 0 (inactive) - matches combined_gui.py behavior
          if (sensorIdPacket === 0) {
            continue;
          }
          
          // Use sensor_id directly as channel ID (1-based: 1-10)
          // combined_gui.py does: sensor_id = sensor_id_packet (no +1 offset)
          const channelId = sensorIdPacket;
          const codeUint32 = dp.data; // uint32_t from protocol (EXACT from combined_gui.py)

          // Get calibration (channelId is 1-based: 1-10)
          let coeffs = this.ptCalibration.get(channelId);

          // NOTE: Phase 2 is already initialized at startup from ptCalibration.
          // Do NOT re-initialize here — that would reset RLS state on every packet.

          // Publish raw PT message to Elodin DB
          if (publishingToElodin) {
            try {
              const rawPayload = encodeRawPTMessage(
                timestampNs,
                channelId,
                codeUint32,
                chunkTimestampMs,
                0 // status flags
              );
              // Packet ID: [0x20, channel_id] for raw PT
              this.elodin.publishTable([0x20, channelId], rawPayload);
            } catch (error) {
              // Silently fail - publishing is optional
            }
          }

          // Map channel ID to proper raw entity name (PT namespace, from config.toml sensor_roles)
          const calEntity = this.channelToEntityMap[channelId] || `PT_Cal.PT_CH${channelId}`;
          // Convert PT_Cal namespace to PT namespace for raw ADC
          const rawEntity = calEntity.replace('PT_Cal.', 'PT.');

          // Emit raw ADC code with BOTH the nice name and the PT_CH alias
          // Nice name (for top bar / GSE/Fuel/LOX views)
          this.handleSensorUpdate({
            entity: rawEntity,
            component: 'raw_adc_counts',
            value: codeUint32, // uint32_t raw ADC code (2147483647 is valid!)
            timestamp: currentTime,
          });

          // PT_CH alias (for raw plots & status pages which expect PT.PT_CHx)
          this.handleSensorUpdate({
            entity: `PT.PT_CH${channelId}`,
            component: 'raw_adc_counts',
            value: codeUint32,
            timestamp: currentTime,
          });

          // Cache latest raw ADC per channel for Phase 1 calibration capture
          this.lastRawAdc.set(channelId, codeUint32);

          // Feed to Phase 2 for continuous monitoring — throttled to ~10 Hz per
          // channel (DAQ fires at 25 kHz — unthrottled would choke the event loop).
          if (this.phase2Engine) {
            const monitorNow = Date.now();
            const lastMonitor = this.phase2LastMonitor.get(channelId) ?? 0;
            if (monitorNow - lastMonitor >= this.PHASE2_MONITOR_INTERVAL_MS) {
              this.phase2LastMonitor.set(channelId, monitorNow);
              this.phase2Engine.monitorReading(channelId, codeUint32);
            }
          }

          // Check if Phase 2 has manual updates (zero_all, capture_reference)
          // If so, ALWAYS use Phase 2 - don't trust Elodin's old static calibration
          // Once Phase 2 has been manually updated, it should permanently take priority
          const phase2State = this.phase2Engine?.getSensorState?.(channelId);
          const phase2HasManualUpdate = phase2State && 
            phase2State.rlsUpdateCount > 0; // Has at least one manual update (permanent priority)
          
          // Check if we've received calibrated PT from Elodin recently (within last 200ms)
          // Only trust Elodin if Phase 2 hasn't been manually updated
          const lastElodinCal = this.calibratedPTFromElodin.get(channelId) ?? 0;
          const timeSinceElodinCal = Date.now() - lastElodinCal;
          const skipOurCalculation = !phase2HasManualUpdate && timeSinceElodinCal < 200;
          
          if (!skipOurCalculation) {
            // Only calculate if Elodin hasn't sent calibrated PT recently
            // Calculate calibrated PSI — prefer Phase 2 (live-updated) coefficients,
            // fall back to static file coefficients, then raw conversion.
            const liveCoeffs = this.phase2Engine?.getCalibration(channelId);
            const activeCoeffs = liveCoeffs ?? coeffs;
            let psi: number;
            if (activeCoeffs) {
              psi = calculatePressure(codeUint32, activeCoeffs);
            } else {
              psi = codeUint32 / 1000000.0; // No calibration - temporary conversion
            }

            // Publish calibrated PT message to Elodin DB (only if we calculated it)
            if (publishingToElodin) {
              try {
                const calPayload = encodeCalibratedPTMessage(
                  timestampNs,
                  channelId,
                  psi,
                  codeUint32,
                  0 // cal status
                );
                // Packet ID: [0x20, 0x10 + channel_id] for calibrated PT
                this.elodin.publishTable([0x20, 0x10 + channelId], calPayload);
              } catch (error) {
                // Silently fail - publishing is optional
              }
            }

            // Map channel ID to proper calibrated entity name (from config.toml sensor_roles)
            const calEntity = this.channelToEntityMap[channelId] || `PT_Cal.PT_CH${channelId}`;

            // Calibrated value with BOTH the nice name and PT_CH alias
            this.handleSensorUpdate({
              entity: calEntity,
              component: 'pressure_psi',
              value: psi,
              timestamp: currentTime,
            });

            // Also send PT_CH alias for compatibility
            this.handleSensorUpdate({
              entity: `PT_Cal.PT_CH${channelId}`,
              component: 'pressure_psi',
              value: psi,
              timestamp: currentTime,
            });
            
            // Debug log for fuel upstream (channel 1) to verify processing
            if (channelId === 1 && Math.random() < 0.01) { // Log 1% of packets
              console.log(`[CH1/Fuel_Upstream] ADC=${codeUint32}, PSI=${psi.toFixed(2)}, entity=${calEntity}`);
            }
          }
        }
      }
    });

    // Handle actuator board data separately (EXACT from combined_gui.py)
    this.daqDirect.on('sensor_data', (header: any, chunks: Array<any>, sourceIP: string) => {
      const actuatorIP = '192.168.2.201'; // Default actuator board IP
      if (sourceIP !== actuatorIP) {
        return; // Only process actuator board data here
      }

      const currentTime = Date.now();

      // Process actuator board sensor data (current sense)
      for (const chunk of chunks) {
        for (const dp of chunk.datapoints) {
          const sensorId = dp.sensor_id; // 1-based (1-10) - matches combined_gui.py
          const codeUint32 = dp.data; // uint32_t raw ADC

          // Emit actuator current sense data (EXACT from combined_gui.py)
          // combined_gui.py: sensor_id is 1-indexed (1-10), use directly
          this.handleSensorUpdate({
            entity: `ACT.ACT_CH${sensorId}`, // 1-based channel ID (no +1 offset)
            component: 'raw_adc_counts',
            value: codeUint32, // Raw ADC code
            timestamp: currentTime,
          });
        }
      }
    });

    // Connect to DAQ boards
    this.daqDirect.connect().then((connected) => {
      if (connected) {
        console.log('✅ Direct DAQ connection successful - receiving data from boards');
        console.log('   📡 Listening for DiabloAvionics packets on 0.0.0.0:5006');
      } else {
        console.warn('⚠️ Direct DAQ connection failed (port may be in use)');
        console.warn('   Falling back to Elodin DB connection...');
        this.setupElodin();
      }
    }).catch((error) => {
      console.error('❌ Direct DAQ connection error:', error);
      console.warn('   Falling back to Elodin DB connection...');
      this.setupElodin();
    });
  }

  /**
   * Send test data to verify frontend pipeline
   */
  private sendTestData(): void {
    console.log('🧪 Sending test data to verify frontend pipeline...');
    const now = Date.now();

    // Send test PT data for all 10 channels
    for (let ch = 1; ch <= 10; ch++) {
      // Raw PT (PT_CH alias)
      this.handleSensorUpdate({
        entity: `PT.PT_CH${ch}`,
        component: 'raw_adc_counts',
        value: 1000000 + ch * 10000, // Test value
        timestamp: now,
      });

      // Calibrated PT (PT_CH alias)
      this.handleSensorUpdate({
        entity: `PT_Cal.PT_CH${ch}`,
        component: 'pressure_psi',
        value: 10 + ch * 2, // Test pressure
        timestamp: now,
      });
    }

    console.log('✅ Test data sent - check frontend');
  }

  private handleSensorUpdate(update: SensorUpdate): void {
    // Validate update values - reject only truly invalid data (NaN, Infinity)
    if (isNaN(update.value) || !isFinite(update.value)) return;

    // Update cache (always instant)
    const key = `${update.entity}.${update.component}`;
    this.sensorCache.set(key, update);

    // Record to binary log if running
    this.dataLogger.record(key, update.value);
    
    // CRITICAL: Dual streaming - ensure data goes to BOTH DB and WebSocket
    // Data from Elodin already goes to WebSocket via handleElodinPacket
    // Data from DAQ Direct already goes to DB via publishTable
    // This ensures no data is lost regardless of source

    // Throttle WebSocket broadcasts to BROADCAST_MIN_INTERVAL_MS per entity
    const now = Date.now();
    const lastBroadcast = this.broadcastLastTime.get(key) ?? 0;
    if (now - lastBroadcast < this.BROADCAST_MIN_INTERVAL_MS) return;
    this.broadcastLastTime.set(key, now);

    // Broadcast to ALL clients
    const message = {
      type: MessageType.SENSOR_UPDATE,
      timestamp: update.timestamp,
      payload: update,
    };

    const openClients = Array.from(this.clients.values()).filter(c => c.ws.readyState === WebSocket.OPEN).length;

    if (openClients > 0) {
      this.broadcast(message);
    } else if (this.clients.size > 0) {
      if (Math.random() < 0.001) {
        console.warn(`⚠️ ${this.clients.size} clients connected but none are OPEN`);
      }
    } else {
      // No clients at all - this is a problem
      if (Math.random() < 0.05) {
        console.warn(`⚠️ No WebSocket clients connected - data is being lost!`);
      }
    }
  }

  private handleElodinPacket(header: any, payload: Buffer): void {
    try {
      const [high, low] = header.packetId;

      // Minimal logging to avoid choking the event loop
      if (!this.streamingDataReceived) {
        console.log(`📥 Elodin TABLE packet: packetId=[0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}], payloadLen=${payload.length}`);
      }

      // Parse packet - this handles PT, TC, RTD, and Actuator packets
      const parsed = parseElodinPacket(header.packetId, payload);

      if (!parsed) {
        // Log unparseable packets - this is important to see what we're missing
        console.warn(`⚠️ Could not parse packet: packetId=[0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}], payloadLen=${payload.length}`);
        // Log first 32 bytes of payload for debugging
        const hexPreview = payload.subarray(0, Math.min(32, payload.length)).toString('hex');
        console.warn(`   Payload preview (hex): ${hexPreview}`);
        return;
      }

      // Log successful parsing occasionally
      if (Math.random() < 0.01) {
        console.log(`✅ Parsed: ${parsed.entity}.${parsed.component} = ${parsed.value.toFixed(2)}`);
      }

      // For calibrated PT from Elodin, check if Phase 2 has recent manual updates
      // If Phase 2 was manually updated (zero_all, capture_reference), trust Phase 2 over Elodin
      let shouldUseElodinValue = true;
      let channelId: number | null = null;
      
      if (parsed.entity.startsWith('PT_Cal.') && parsed.component === 'pressure_psi') {
        // Extract channel ID from entity name
        const channelMatch = parsed.entity.match(/PT_CH(\d+)/);
        if (channelMatch) {
          channelId = parseInt(channelMatch[1], 10);
        } else {
          // Try to match by name
          const nameMap: Record<string, number> = {
            'PT_Cal.Fuel_Upstream': 1,
            'PT_Cal.GSE_Low': 2,
            'PT_Cal.GSE_Mid': 3,
            'PT_Cal.Fuel_Downstream': 4,
            'PT_Cal.Ox_Upstream': 5,
            'PT_Cal.GN2_Regulated': 6,
            'PT_Cal.Ox_Downstream': 7,
          };
          channelId = nameMap[parsed.entity] ?? null;
        }
        
        if (channelId) {
          // Check if Phase 2 has manual updates - if so, ALWAYS ignore Elodin's value
          // Once Phase 2 has been manually updated (zero_all, etc.), it should permanently take priority
          const phase2State = this.phase2Engine?.getSensorState?.(channelId);
          if (phase2State && phase2State.rlsUpdateCount > 0) {
            // Phase 2 has manual updates - permanently prioritize Phase 2 over Elodin
            shouldUseElodinValue = false;
            // Only log occasionally to avoid spam
            if (Math.random() < 0.001) {
              console.log(`⚠️ Ignoring Elodin calibrated PT for CH${channelId} - Phase 2 has manual updates (rlsUpdateCount: ${phase2State.rlsUpdateCount})`);
            }
          } else {
            // Mark that we received calibrated PT from Elodin for this channel
            this.calibratedPTFromElodin.set(channelId, Date.now());
          }
        }
      }

      // Only use Elodin's value if Phase 2 doesn't have recent manual updates
      if (shouldUseElodinValue) {
        const update: SensorUpdate = {
          entity: parsed.entity,
          component: parsed.component,
          value: parsed.value,
          timestamp: parsed.timestamp,
        };

        // Handle update (updates cache and broadcasts)
        this.handleSensorUpdate(update);
        
        // Also emit PT_CH alias if it's a calibrated PT
        if (channelId) {
          this.handleSensorUpdate({
            entity: `PT_Cal.PT_CH${channelId}`,
            component: 'pressure_psi',
            value: parsed.value,
            timestamp: parsed.timestamp,
          });
        }
      }
    } catch (error) {
      console.error('❌ Error handling Elodin packet:', error);
      console.error('   Packet header:', header);
      console.error('   Payload length:', payload.length);
    }
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket, req: any) => {
      const clientIP = req.socket?.remoteAddress || 'unknown';
      const clientPort = req.socket?.remotePort || 'unknown';
      console.log('📱 New WebSocket client connected');
      console.log(`   Client: ${clientIP}:${clientPort}`);
      console.log(`   Request URL: ${req.url || 'unknown'}`);
      console.log(`   Total clients now: ${this.clients.size + 1}`);

      // Send test data when first client connects to verify pipeline
      if (this.clients.size === 0) {
        setTimeout(() => {
          console.log('🧪 First client connected - sending test data to verify pipeline...');
          this.sendTestData();
        }, 200);
      }

      ws.on('error', (error: Error) => {
        console.error(`❌ WebSocket client error (${clientIP}:${clientPort}):`, error);
      });

      ws.on('close', (code: number, reason: Buffer) => {
        console.log(`🔌 WebSocket client disconnected (${clientIP}:${clientPort})`);
        console.log(`   Close code: ${code}, reason: ${reason.toString() || 'none'}`);
        console.log(`   Remaining clients: ${this.clients.size - 1}`);
      });

      const client: Client = {
        ws,
        subscribedSensors: new Set(),
        lastPing: Date.now(),
      };

      this.clients.set(ws, client);

      // Send cached sensor data IMMEDIATELY (before status) so plots have data on connect
      // This ensures plots show data as soon as they initialize
      if (this.sensorCache.size > 0) {
        console.log(`📤 Sending ${this.sensorCache.size} cached sensor values to new client...`);
        this.sensorCache.forEach((update) => {
          try {
            this.send(ws, {
              type: MessageType.SENSOR_UPDATE,
              timestamp: update.timestamp,
              payload: update,
            });
          } catch (error) {
            // Silently fail - WebSocket might not be ready yet, but we'll retry
          }
        });
      }

      // Send initial connection status (with retry to ensure WebSocket is ready)
      const sendStatus = () => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            this.send(ws, {
              type: MessageType.CONNECTION_STATUS,
              timestamp: Date.now(),
              payload: {
                connected: true,
                elodinConnected: this.daqDirect?.connected || this.elodin.isConnected(),
              } as ConnectionStatus,
            });
            console.log('   ✅ Sent initial connection status to client');

            // ── CRITICAL: Send current state immediately to new client ──
            // This ensures all windows/tabs show the same state even if opened at different times
            if (this.currentState !== null) {
              this.send(ws, {
                type: MessageType.STATE_UPDATE,
                timestamp: Date.now(),
                payload: {
                  currentState: this.currentState,
                  stateName: SystemState[this.currentState] ?? 'UNKNOWN',
                  timestamp: Date.now(),
                } as StateUpdate,
              });
              console.log(`📤 Sent current state to new client: ${SystemState[this.currentState]}`);
            } else {
              // Send IDLE as default if no state set yet
              this.send(ws, {
                type: MessageType.STATE_UPDATE,
                timestamp: Date.now(),
                payload: {
                  currentState: SystemState.IDLE,
                  stateName: 'IDLE',
                  timestamp: Date.now(),
                } as StateUpdate,
              });
            }
          } catch (error) {
            console.error('   ❌ Failed to send connection status:', error);
          }
        } else {
          console.warn(`   ⚠️ WebSocket not ready (state: ${ws.readyState}), will retry...`);
          setTimeout(sendStatus, 100);
        }
      };

      // Try immediately, then retry if needed
      setTimeout(sendStatus, 10);

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(ws, message);
        } catch (error) {
          console.error('❌ Failed to parse message:', error);
        }
      });

      ws.on('close', () => {
        console.log('📱 WebSocket client disconnected');
        this.clients.delete(ws);
      });

      ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
        this.clients.delete(ws);
      });

      // Ping/pong for connection health
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          client.lastPing = Date.now();
          ws.ping();
        } else {
          clearInterval(pingInterval);
        }
      }, 30000); // Ping every 30 seconds
    });
  }

  private handleMessage(ws: WebSocket, message: any): void {
    const client = this.clients.get(ws);
    if (!client) return;

    switch (message.type) {
      case MessageType.SUBSCRIBE_SENSOR:
        if (message.payload?.entity) {
          client.subscribedSensors.add(message.payload.entity);
          console.log(`📊 Client subscribed to: ${message.payload.entity}`);
          // Send current cached value if available (immediate feedback)
          const pressureKey = `${message.payload.entity}.pressure_psi`;
          const rawKey = `${message.payload.entity}.raw_adc_counts`;
          const cached = this.sensorCache.get(pressureKey) || this.sensorCache.get(rawKey);
          if (cached) {
            console.log(`📤 Sending cached value to new subscriber: ${cached.entity}.${cached.component} = ${cached.value}`);
            this.send(ws, {
              type: MessageType.SENSOR_UPDATE,
              timestamp: cached.timestamp,
              payload: cached,
            });
          }
        }
        break;

      case MessageType.UNSUBSCRIBE_SENSOR:
        if (message.payload?.entity) {
          client.subscribedSensors.delete(message.payload.entity);
        }
        break;

      case MessageType.SEND_COMMAND:
        this.handleCommand(message.payload as CommandPayload);
        break;

      case MessageType.CALIBRATION_COMMAND:
        this.handleCalibrationCommand(ws, message.payload);
        break;

      case MessageType.QUERY_HISTORICAL:
        // TODO: Implement historical data query
        break;

      case 'get_state_transitions':
        // Return state transitions from CSV
        const transitions = getStateTransitions();
        this.send(ws, {
          type: 'state_transitions',
          timestamp: Date.now(),
          payload: { transitions },
        });
        break;

      default:
        console.warn('⚠️ Unknown message type:', message.type);
    }
  }

  private sendActuatorCommandUDP(channelId: number, state: number): boolean {
    // Send actuator command via UDP (like combined_gui.py)
    // Packet format: [packet_type(1), version(1), timestamp(4), num_actuators(1), actuator_data...]
    // actuator_data: [actuator_id(1), actuator_state(1)] for each actuator
    // Packet type 3 = ACTUATOR_COMMAND (from combined_gui.py)

    if (!this.actuatorSocket) {
      console.error('❌ Actuator socket not initialized');
      return false;
    }

    try {
      const timestamp = Math.floor(Date.now()); // Timestamp in milliseconds (32-bit)
      const packetType = 4; // ACTUATOR_COMMAND (from combined_gui.py PacketType.ACTUATOR_COMMAND = 4)
      const version = 0;
      const numActuators = 1; // Single actuator command

      // Build packet: [packet_type, version, timestamp(4 bytes LE), num_actuators, actuator_id, actuator_state]
      // Total: 1 + 1 + 4 + 1 + 1 + 1 = 9 bytes
      const buffer = Buffer.allocUnsafe(9);
      buffer.writeUInt8(packetType, 0);
      buffer.writeUInt8(version, 1);
      buffer.writeUInt32LE(timestamp & 0xFFFFFFFF, 2); // 32-bit timestamp
      buffer.writeUInt8(numActuators, 6);
      buffer.writeUInt8(channelId, 7); // 1-based channel ID (1-10)
      buffer.writeUInt8(state, 8); // 0 = CLOSED, 1 = OPEN

      this.actuatorSocket.send(buffer, this.actuatorPort, this.actuatorIP, (err) => {
        if (err) {
          console.error(`❌ Failed to send actuator command: ${err.message}`);
        }
      });

      return true;
    } catch (error) {
      console.error('❌ Error sending actuator command:', error);
      return false;
    }
  }

  private handleCommand(command: CommandPayload): void {
    // Commands can be sent even if Elodin is not connected (UDP direct)
    // Only state transitions require Elodin connection
    if (command.commandType === 'state_transition' && !this.elodin.isConnected()) {
      console.error('❌ Cannot send state transition: Elodin not connected');
      this.broadcast({
        type: MessageType.ERROR,
        timestamp: Date.now(),
        payload: { message: 'Elodin DB not connected', command },
      });
      return;
    }

    try {
      if (command.commandType === 'state_transition') {
        const newState = command.data.state;
        if (newState === undefined) {
          throw new Error('State transition command missing state');
        }

        // Validate transition: check if transition from current state to new state is allowed
        const currentState = this.currentState ?? SystemState.IDLE;
        
        console.log(`🔍 Validating transition: ${SystemState[currentState]} → ${SystemState[newState]}`);
        
        // DEBUG mode: only allow transitions to IDLE, VENT, or ABORT (safety states)
        if (currentState === SystemState.DEBUG) {
          const allowedFromDebug = [SystemState.IDLE, SystemState.VENT, SystemState.ABORT];
          if (!allowedFromDebug.includes(newState)) {
            const errorMsg = `❌ Invalid transition from DEBUG: Only IDLE, VENT, or ABORT allowed`;
            console.error(errorMsg);
            this.broadcast({
              type: MessageType.ERROR,
              timestamp: Date.now(),
              payload: { message: errorMsg, command },
            });
            return;
          }
        } else {
          // Normal mode: validate against CSV
          const isAllowed = isTransitionAllowed(currentState, newState);
          console.log(`   Transition allowed: ${isAllowed}`);
          if (!isAllowed) {
            const errorMsg = `❌ Invalid state transition: ${SystemState[currentState]} → ${SystemState[newState]} (not allowed in CSV)`;
            console.error(errorMsg);
            this.broadcast({
              type: MessageType.ERROR,
              timestamp: Date.now(),
              payload: { message: errorMsg, command },
            });
            return;
          }
        }

        const success = this.elodin.sendCommand('state_transition', { state: newState });
        if (success) {
          console.log(`🎯 State transition command sent: ${SystemState[currentState]} → ${SystemState[newState]}`);

            // ── Auto data-logging: start on ARMED, stop on IDLE/ABORT ──
            if (newState === SystemState.ARMED && !this.dataLogger.running) {
              this.dataLogger.start();
            } else if ((newState === SystemState.IDLE || newState === SystemState.ABORT) && this.dataLogger.running) {
              const stats = this.dataLogger.stop();
              if (stats) {
                console.log(`📝 Run logged: ${stats.filePath} (${stats.records} records, ${stats.channels} channels, ${(stats.durationMs / 1000).toFixed(1)}s)`);
              }
            }

            // Update current state
            this.currentState = newState;

            // Broadcast confirmation
            this.broadcast({
              type: MessageType.STATE_UPDATE,
              timestamp: Date.now(),
              payload: { currentState: newState, stateName: SystemState[newState], timestamp: Date.now() },
            });
            
            // Auto-command actuators to match state (skip DEBUG — manual control)
            if (newState !== SystemState.DEBUG) {
              this.applyActuatorsForState(newState);
              // Start continuous actuator command sending for this state
              this.startContinuousActuatorCommands(newState);
            } else {
              // Stop continuous commands in DEBUG mode
              this.stopContinuousActuatorCommands();
            }

            // ── Controller integration: Start/stop controller loop on FIRE state ──
            if (newState === SystemState.FIRE) {
              this.startControllerLoop();
            } else {
              this.stopControllerLoop();
            }
        } else {
          throw new Error('Failed to send state transition command');
        }
      } else if (command.commandType === 'actuator') {
        const { actuatorId, actuatorState } = command.data;
        if (actuatorId !== undefined && actuatorState !== undefined) {
          // Map actuatorId → real board channel from config.toml actuator_roles
          const channelId = ACTUATOR_CHANNEL[actuatorId] ?? (actuatorId + 1);
          const state = actuatorState === ActuatorState.OPEN ? 1 : 0;

          // Send via direct UDP to actuator board (like combined_gui.py)
          const success = this.sendActuatorCommandUDP(channelId, state);

          if (success) {
            console.log(`🎯 Actuator command sent via UDP: ${ActuatorId[actuatorId]} (CH${channelId}) -> ${ActuatorState[actuatorState]} (${state})`);
            // Broadcast actuator update
            this.broadcast({
              type: MessageType.ACTUATOR_UPDATE,
              timestamp: Date.now(),
              payload: {
                actuatorId,
                name: ActuatorId[actuatorId],
                state: actuatorState,
                rawAdcCounts: 0, // Will be updated by sensor data
                timestamp: Date.now(),
              },
            });
          } else {
            throw new Error('Failed to send actuator command via UDP');
          }
        }
      } else if (command.commandType === 'controller_frequency') {
        const { frequency } = command.data;
        if (frequency !== undefined) {
          // TODO: Send controller frequency command to Elodin
          // This would be a new command type in the Elodin protocol
          console.log(`🎯 Controller frequency command: ${frequency} Hz`);
          // For now, just log it - actual implementation depends on your controller interface
        }
      } else if (command.commandType === 'pwm_actuator') {
        const { actuatorId, dutyCycle, frequency, duration } = command.data;
        if (actuatorId !== undefined && dutyCycle !== undefined) {
          const channelId = ACTUATOR_CHANNEL[actuatorId] ?? (actuatorId + 1);
          const success = this.sendPWMActuatorCommandUDP(
            channelId,
            dutyCycle,
            frequency || 10,
            duration || 1000
          );
          if (success) {
            console.log(`🎯 PWM Actuator command sent: ${ActuatorId[actuatorId]} (CH${channelId}), Duty: ${dutyCycle}, Freq: ${frequency || 10}Hz`);
          } else {
            throw new Error('Failed to send PWM actuator command via UDP');
          }
        }
      } else if (command.commandType === 'controller_command') {
        // Update controller command (thrust desired, altitude goal, etc.)
        const { command_type, thrust_desired, altitude_goal } = command.data;
        if (command_type) {
          this.controllerCommand = {
            command_type: command_type as 'THRUST_DESIRED' | 'ALTITUDE_GOAL',
            thrust_desired: thrust_desired ?? this.controllerCommand.thrust_desired,
            altitude_goal: altitude_goal ?? this.controllerCommand.altitude_goal,
          };
          console.log(`🎯 Controller command updated: ${this.controllerCommand.command_type}, ` +
                     `thrust=${this.controllerCommand.thrust_desired}N, altitude=${this.controllerCommand.altitude_goal}m`);
        }
      }
    } catch (error) {
      console.error('❌ Command error:', error);
      this.broadcast({
        type: MessageType.ERROR,
        timestamp: Date.now(),
        payload: { message: `Command failed: ${error}`, command },
      });
    }
  }

  /**
   * Auto-command actuators to match expected positions for a given state.
   * Reads from STATE_ACTUATOR_MAP (parsed from state_machine_actuators.csv).
   */
  private applyActuatorsForState(state: SystemState): void {
    const expected = STATE_ACTUATOR_MAP[state];
    if (!expected) {
      console.log(`⚠️ No actuator map for state ${SystemState[state]}, skipping auto-command`);
      return;
    }
    console.log(`🔧 Auto-commanding actuators for state ${SystemState[state]}:`);
    // Send commands for all channels specified in the CSV map
    for (const [channelIdStr, val] of Object.entries(expected)) {
      const channelId = Number(channelIdStr);
      if (isNaN(channelId) || channelId < 1 || channelId > 10) {
        console.warn(`⚠️ Invalid channel ID in map: ${channelIdStr}`);
        continue;
      }
      this.sendActuatorCommandUDP(channelId, val);
      console.log(`   CH${channelId} → ${val === 1 ? 'OPEN' : 'CLOSED'}`);
    }
  }

  /**
   * Start continuously sending actuator commands for the current state.
   * Sends commands every ACTUATOR_COMMAND_INTERVAL_MS to ensure actuators stay in correct position.
   */
  private startContinuousActuatorCommands(state: SystemState): void {
    // Stop any existing interval
    this.stopContinuousActuatorCommands();

    const expected = STATE_ACTUATOR_MAP[state];
    if (!expected) {
      return;
    }

    console.log(`🔄 Starting continuous actuator commands for state ${SystemState[state]} (every ${this.ACTUATOR_COMMAND_INTERVAL_MS}ms)`);
    
    this.actuatorCommandInterval = setInterval(() => {
      if (this.currentState === state) {
        // Only send if we're still in the same state
        for (const [ch, val] of Object.entries(expected)) {
          const channelId = Number(ch);
          this.sendActuatorCommandUDP(channelId, val);
        }
      } else {
        // State changed, stop this interval
        this.stopContinuousActuatorCommands();
      }
    }, this.ACTUATOR_COMMAND_INTERVAL_MS);
  }

  /**
   * Stop continuous actuator command sending.
   */
  private stopContinuousActuatorCommands(): void {
    if (this.actuatorCommandInterval) {
      clearInterval(this.actuatorCommandInterval);
      this.actuatorCommandInterval = null;
      console.log('🛑 Stopped continuous actuator commands');
    }
  }

  /**
   * Send PWM actuator command via UDP
   * Format: [packet_type, version, timestamp(4), actuator_id, duration_ms(4), duty_cycle(4), frequency(4)]
   */
  private sendPWMActuatorCommandUDP(channelId: number, dutyCycle: number, frequency: number = 10, durationMs: number = 1000): boolean {
    if (!this.actuatorSocket) {
      console.error('❌ Actuator socket not initialized');
      return false;
    }

    try {
      const timestamp = Math.floor(Date.now());
      const packetType = 10; // PWM_ACTUATOR_COMMAND (from DAQDirectClient)
      const version = 0;

      // Build packet: [packet_type(1), version(1), timestamp(4), actuator_id(1), duration_ms(4), duty_cycle(4), frequency(4)]
      // Total: 1 + 1 + 4 + 1 + 4 + 4 + 4 = 19 bytes
      const buffer = Buffer.allocUnsafe(19);
      buffer.writeUInt8(packetType, 0);
      buffer.writeUInt8(version, 1);
      buffer.writeUInt32LE(timestamp, 2);
      buffer.writeUInt8(channelId, 6);
      buffer.writeUInt32LE(durationMs, 7);
      buffer.writeFloatLE(dutyCycle, 11); // duty_cycle [0-1]
      buffer.writeFloatLE(frequency, 15); // frequency [Hz]

      this.actuatorSocket.send(buffer, 0, buffer.length, this.actuatorPort, this.actuatorIP, (err) => {
        if (err) {
          console.error(`❌ Failed to send PWM command to ${this.actuatorIP}:${this.actuatorPort}:`, err);
        }
      });

      return true;
    } catch (error) {
      console.error('❌ Error sending PWM command:', error);
      return false;
    }
  }

  /**
   * Start controller loop - runs when FIRE state is active
   * Reads sensor data, calls DDP controller, sends PWM commands
   */
  private startControllerLoop(): void {
    if (this.controllerLoopInterval) {
      return; // Already running
    }

    if (!this.controllerClient) {
      console.warn('⚠️ Controller client not initialized - cannot start controller loop');
      return;
    }

    console.log('🎯 Starting controller loop (FIRE state active)');

    // Initialize controller if not already done
    this.controllerClient.initialize().then((success) => {
      if (!success) {
        console.error('❌ Failed to initialize controller - controller loop will not run');
        return;
      }

      // Start controller loop at 10 Hz
      this.controllerLoopInterval = setInterval(async () => {
        if (this.currentState !== SystemState.FIRE) {
          // State changed, stop loop
          this.stopControllerLoop();
          return;
        }

        // Build sensor data map from cache
        const sensorDataMap = new Map<string, number>();
        for (const [key, update] of this.sensorCache.entries()) {
          if (update.component === 'pressure_psi') {
            sensorDataMap.set(key, update.value);
          }
        }

        // Map sensor data to controller measurement format
        const measurement = mapSensorDataToMeasurement(sensorDataMap);
        if (!measurement) {
          // Missing required sensor data - skip this step
          return;
        }

        // Call controller step
        const result = await this.controllerClient!.step(
          measurement,
          {}, // Nav state (can be enhanced later)
          this.controllerCommand
        );

        if (!result) {
          console.warn('⚠️ Controller step returned null - skipping PWM command');
          return;
        }

        const { actuation, diagnostics } = result;

        // Send PWM commands to actuators
        // Fuel Press (CH3) gets duty_F, LOX Press (CH8) gets duty_O
        const fuelPressChannel = ACTUATOR_CHANNEL[ActuatorId.FUEL_PRESS]; // CH3
        const loxPressChannel = ACTUATOR_CHANNEL[ActuatorId.LOX_PRESS];   // CH8

        if (fuelPressChannel) {
          this.sendPWMActuatorCommandUDP(fuelPressChannel, actuation.duty_F, 10, 100);
        }
        if (loxPressChannel) {
          this.sendPWMActuatorCommandUDP(loxPressChannel, actuation.duty_O, 10, 100);
        }

        // Log diagnostics occasionally
        if (Math.random() < 0.1) { // 10% of steps
          console.log(`🎯 Controller: F_ref=${diagnostics.F_ref.toFixed(1)}N, F_est=${diagnostics.F_estimated.toFixed(1)}N, ` +
                     `duty_F=${actuation.duty_F.toFixed(3)}, duty_O=${actuation.duty_O.toFixed(3)}`);
        }

        // Broadcast controller diagnostics to frontend
        this.broadcast({
          type: MessageType.CONTROLLER_UPDATE,
          timestamp: Date.now(),
          payload: {
            actuation,
            diagnostics,
          },
        });
      }, this.CONTROLLER_LOOP_INTERVAL_MS);
    });
  }

  /**
   * Stop controller loop
   */
  private stopControllerLoop(): void {
    if (this.controllerLoopInterval) {
      clearInterval(this.controllerLoopInterval);
      this.controllerLoopInterval = null;
      console.log('🛑 Stopped controller loop');
    }
  }

  /** Cache of recent raw ADC values per sensor for Phase 1 capture */
  private lastRawAdc: Map<number, number> = new Map();

  private handleCalibrationCommand(ws: WebSocket, payload: any): void {
    if (!this.phase2Engine) return;
    const { commandType, sensorId, referencePressure } = payload ?? {};

    switch (commandType) {
      case 'capture_reference': {
        if (sensorId == null || referencePressure == null) {
          this.send(ws, { type: MessageType.ERROR, timestamp: Date.now(),
            payload: { message: 'capture_reference requires sensorId and referencePressure' } });
          return;
        }
        // Apply the reference pressure to trigger an RLS update immediately
        const adc = this.lastRawAdc.get(sensorId) ?? 0;
        const updated = this.phase2Engine.updateCalibration(sensorId, adc, referencePressure);
        console.log(`📐 Calibration capture: CH${sensorId} ADC=${adc} ref=${referencePressure} PSI → updated=${!!updated}`);
        break;
      }
      case 'enable_phase2':
        this.phase2Engine.setEnabled(true);
        break;
      case 'disable_phase2':
        this.phase2Engine.setEnabled(false);
        break;
      case 'reset_channel':
        if (sensorId != null) {
          const existing = this.phase2Engine.getCalibration(sensorId);
          if (existing) {
            this.phase2Engine.initializeSensor(sensorId, existing);
            console.log(`🔄 Calibration reset for CH${sensorId}`);
          }
        }
        break;
      case 'zero_all': {
        // Trust the user: current readings → 0 PSI for ALL channels.
        // DIRECTLY set adjustment D term to force current reading to 0 PSI.
        // This is more aggressive and immediate than RLS update.
        console.log('🎯 ZERO ALL PTs — directly setting adjustment to force 0 PSI');
        for (let ch = 1; ch <= 10; ch++) {
          const currentAdc = this.lastRawAdc.get(ch) ?? 0;
          if (currentAdc === 0) {
            console.log(`   CH${ch}: no ADC data yet, skipping`);
            continue;
          }

          // Get baseline from ptCalibration (or use existing if already initialized)
          const baseline = this.ptCalibration.get(ch);
          if (baseline) {
            // Initialize with baseline if not already initialized
            // (initializeSensor is idempotent — won't overwrite if already exists)
            this.phase2Engine.initializeSensor(ch, baseline);
          } else {
            // No baseline found — check if already initialized
            const existing = this.phase2Engine.getCalibration(ch);
            if (!existing) {
              console.log(`   CH${ch}: no baseline calibration, initializing with zeros`);
              this.phase2Engine.initializeSensor(ch, { A: 0, B: 0, C: 0, D: 0 });
            }
          }

          // Get current state to directly modify adjustment
          const state = this.phase2Engine.getSensorState(ch);
          if (!state) {
            console.log(`   CH${ch}: Phase 2 state not found, skipping`);
            continue;
          }

          // Calculate current reading using baseline + current adjustment
          const currentCoeffs = {
            A: state.baselineCoeffs.A + state.adjustment.A,
            B: state.baselineCoeffs.B + state.adjustment.B,
            C: state.baselineCoeffs.C + state.adjustment.C,
            D: state.baselineCoeffs.D + state.adjustment.D,
          };
          const currentReading = calculatePressure(currentAdc, currentCoeffs);
          const drift = currentReading - 0; // How far off from 0 PSI
          console.log(`   CH${ch}: ADC=${currentAdc}, current=${currentReading.toFixed(2)} PSI, drift=${drift.toFixed(2)} PSI`);

          // DIRECTLY set adjustment D term to compensate for drift
          // This immediately forces the reading to 0 PSI
          state.adjustment.D = state.adjustment.D - drift;
          
          // Update timestamp to mark this as a recent manual update
          state.lastUpdate = Date.now();
          state.rlsUpdateCount++;
          
          // Also do an RLS update to update covariance and statistics
          this.phase2Engine.updateCalibration(ch, currentAdc, 0);
          
          const newCoeffs = this.phase2Engine.getCalibration(ch);
          if (newCoeffs) {
            const newReading = calculatePressure(currentAdc, newCoeffs);
            console.log(`   CH${ch}: adjustment D=${state.adjustment.D.toFixed(4)}, new reading=${newReading.toFixed(2)} PSI ✓`);
          }
        }
        // DO NOT clear ptCalibration — baseline must be preserved
        break;
      }
      default:
        console.warn('⚠️ Unknown calibration command:', commandType);
    }

    // Always immediately broadcast updated status after a command
    const channels = this.phase2Engine.getAllStatus();
    this.broadcast({
      type: MessageType.CALIBRATION_STATUS,
      timestamp: Date.now(),
      payload: { channels, phase2Enabled: this.phase2Engine.isEnabled(), timestamp: Date.now() },
    });
  }

  private startUpdateLoop(): void {
    // Sensor data broadcast driven by Elodin packet events (see handleElodinPacket)
    this.updateInterval = setInterval(() => {
      // placeholder – real updates come from packet events
    }, 50);

    // Broadcast Phase 2 calibration status to all clients every 2 seconds
    setInterval(() => {
      if (!this.phase2Engine || this.clients.size === 0) return;
      const channels = this.phase2Engine.getAllStatus();
      if (channels.length === 0) return;
      this.broadcast({
        type:      MessageType.CALIBRATION_STATUS,
        timestamp: Date.now(),
        payload: {
          channels,
          phase2Enabled: this.phase2Engine.isEnabled(),
          timestamp:     Date.now(),
        },
      });
    }, 2000);
  }

  private broadcast(message: any): void {
    if (this.clients.size === 0) {
      // Log every time if no clients - this is a critical issue
      console.error(`❌ CRITICAL: Broadcasting but no WebSocket clients connected!`);
      console.error(`   Data is being lost! Frontend is not connected.`);
      return;
    }

    const data = JSON.stringify(message);
    let sentCount = 0;
    let closedCount = 0;
    let connectingCount = 0;
    let errorCount = 0;

    this.clients.forEach((client, ws) => {
      const state = client.ws.readyState;
      if (state === WebSocket.OPEN) {
        try {
          client.ws.send(data);
          sentCount++;
        } catch (error) {
          console.error('❌ Failed to send to client:', error);
          errorCount++;
        }
      } else if (state === WebSocket.CLOSED || state === WebSocket.CLOSING) {
        closedCount++;
        // Remove closed clients
        this.clients.delete(ws);
      } else {
        connectingCount++;
      }
    });

    // ALWAYS log if no messages were sent
    if (sentCount === 0 && this.clients.size > 0) {
      console.error(`❌ CRITICAL: Broadcast failed - no clients in OPEN state:`);
      console.error(`   Total clients: ${this.clients.size}`);
      console.error(`   OPEN: ${sentCount}, CLOSED: ${closedCount}, CONNECTING: ${connectingCount}, ERRORS: ${errorCount}`);
    } else if (sentCount > 0) {
      // Log successful sends occasionally to confirm it's working
      if (Math.random() < 0.1) {
        console.log(`   ✅ Successfully sent to ${sentCount} client(s)`);
      }
    }
  }

  private send(ws: WebSocket, message: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  shutdown(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    this.elodin.disconnect();
    this.wss.close();
  }
}

// Start servers
const server = new SensorSystemServer();
// API server will get query client after Elodin connects
// Pass a getter function that returns the query client
startAPIServer(() => (server as any).queryClient || null);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  server.shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down server...');
  server.shutdown();
  process.exit(0);
});

console.log(`🚀 WebSocket server starting on ${WS_HOST}:${WS_PORT}`);
console.log(`📡 Connecting to Elodin DB at ${ELODIN_HOST}:${ELODIN_PORT}`);
console.log(`🌐 External clients can connect via: ws://<your-ip>:${WS_PORT}`);
