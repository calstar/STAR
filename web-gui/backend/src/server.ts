/**
 * WebSocket Server for Sensor System GUI
 * Bridges Elodin DB to WebSocket clients with <30ms latency
 */

import { WebSocketServer, WebSocket } from 'ws';
import { ElodinClient } from './elodin-client.js';
import { DAQDirectClient } from './daq-direct-client.js';
import { parseElodinPacket } from './elodin-protocol.js';
import { registerVTables } from './elodin-vtable.js';
import { getStateTransitions } from './routes/state-transitions.js';
import { startAPIServer } from './api-server.js';
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
const ELODIN_HOST = process.env.ELODIN_HOST || 'localhost'; // localhost works for both IPv4/IPv6
const ELODIN_PORT = parseInt(process.env.ELODIN_PORT || '2240', 10);

interface Client {
  ws: WebSocket;
  subscribedSensors: Set<string>;
  lastPing: number;
}

class SensorSystemServer {
  private wss: WebSocketServer;
  private elodin: ElodinClient;
  private daqDirect: DAQDirectClient | null = null;
  private clients: Map<WebSocket, Client> = new Map();
  private sensorCache: Map<string, SensorUpdate> = new Map();
  private updateInterval: NodeJS.Timeout | null = null;
  private useDirectDAQ: boolean = false; // Use Elodin DB (DAQ Bridge handles calibration and persistence)

  constructor() {
    console.log(`🚀 Starting Sensor System Server...`);
    console.log(`   WebSocket: ${WS_HOST}:${WS_PORT}`);
    console.log(`   Elodin DB: ${ELODIN_HOST}:${ELODIN_PORT}`);

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
      console.log(`✅ WebSocket server listening on ${WS_HOST}:${WS_PORT}`);
      console.log(`   Ready to accept client connections`);
    });

    this.elodin = new ElodinClient(ELODIN_HOST, ELODIN_PORT);

    // Always set up WebSocket FIRST (critical for frontend connection)
    this.setupWebSocket();

    // Set up Elodin DB connection (for persistence, even if using direct DAQ)
    this.setupElodin();

    // Set up direct DAQ for real-time data (bypasses Elodin streaming)
    if (this.useDirectDAQ) {
      console.log('🚀 Using DIRECT DAQ connection for real-time data');
      console.log('   ⚠️ NOTE: DAQ Bridge should be STOPPED - backend receives packets directly');
      console.log('   ✅ Data flows: Boards → Backend → Frontend (real-time)');
      console.log('   ⚠️ Elodin DB writes not yet implemented (requires TABLE packet format)');
      this.setupDirectDAQ();
    }

    this.startUpdateLoop();
  }

  private setupElodin(): void {
    this.elodin.on('connected', () => {
      console.log('✅ Elodin connected, broadcasting to clients');
      console.log('🔍 Connection status:');
      console.log(`   - Elodin client connected: ${this.elodin.isConnected}`);
      console.log(`   - WebSocket clients: ${this.clients.size}`);
      console.log('⏳ Waiting for data from Elodin DB...');
      console.log('   If no data appears, check:');
      console.log('   1. Is DAQ Bridge running and sending data?');
      console.log('   2. Is Elodin DB receiving data from DAQ Bridge?');
      console.log('   3. Check Elodin DB logs for incoming data');
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
      // Handle incoming packets from Elodin
      // Don't log every packet - too verbose, only log occasionally
      if (Math.random() < 0.01) {
        console.log(`🎯 Server received 'packet' event from Elodin client`);
      }
      this.handleElodinPacket(header, payload);
    });

    // Connect to Elodin (non-blocking, will retry on failure)
    console.log('🔌 Attempting to connect to Elodin DB...');
    console.log('   DAQ Bridge should be running and writing calibrated data to Elodin DB');
    this.elodin.connect().then(async (connected) => {
      if (connected) {
        console.log('✅ Elodin connection established');
        // Register VTables to tell Elodin DB to stream data to us
        console.log('📋 Registering VTables with Elodin DB...');
        console.log('   This subscribes to calibrated sensor data from DAQ Bridge');
        await registerVTables(this.elodin);
        console.log('   ✅ Waiting for calibrated data from DAQ Bridge...');
        console.log('   Make sure DAQ Bridge is running and receiving packets from boards');
      } else {
        console.warn('⚠️ Elodin connection failed, will retry...');
        console.warn('   Make sure Elodin DB is running on port 2240');
      }
    }).catch((error) => {
      // Error already logged by elodin-client, just prevent unhandled rejection
      console.error('❌ Elodin connection error:', error);
      // Connection will be retried automatically
    });

    // Handle Elodin errors gracefully (don't crash)
    this.elodin.on('error', () => {
      // Errors are already logged, just prevent unhandled error crashes
    });
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

    this.daqDirect.on('sensor', (sensorData: any) => {
      // Convert DAQ sensor data to our format
      const update: SensorUpdate = {
        entity: sensorData.entity,
        component: sensorData.component,
        value: sensorData.value,
        timestamp: sensorData.timestamp || Date.now(),
      };

      // Log actuator data more frequently (it's important)
      const isActuator = sensorData.entity?.startsWith('ACT.');
      const logFrequency = isActuator ? 0.3 : 0.1; // Log 30% of actuator messages, 10% of others

      if (Math.random() < logFrequency) {
        console.log(`📥 Direct DAQ sensor: ${update.entity}.${update.component} = ${update.value.toFixed(2)} (from ${sensorData.sourceIP || 'unknown'})`);
      }
      this.handleSensorUpdate(update);
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

  private handleSensorUpdate(update: SensorUpdate): void {
    // Update cache
    const key = `${update.entity}.${update.component}`;
    this.sensorCache.set(key, update);

    // Write to Elodin DB for persistence (if connected)
    if (this.elodin.isConnected()) {
      // TODO: Write to Elodin DB using TABLE packet format
      // For now, Elodin DB will receive data from DAQ Bridge if it's running
      // But since we're bypassing DAQ Bridge, we need to write directly
      // This requires implementing the TABLE packet format
    }

    // Broadcast to ALL clients
    const message = {
      type: MessageType.SENSOR_UPDATE,
      timestamp: update.timestamp,
      payload: update,
    };

    const clientCount = this.clients.size;
    const openClients = Array.from(this.clients.values()).filter(c => c.ws.readyState === WebSocket.OPEN).length;

    if (openClients > 0) {
      if (Math.random() < 0.1) {
        console.log(`📤 Broadcasting: ${update.entity}.${update.component} = ${update.value.toFixed(2)} to ${openClients} client(s)`);
      }
      this.broadcast(message);
    } else if (clientCount > 0) {
      console.warn(`⚠️ ${clientCount} clients connected but none are OPEN - frontend may be disconnected`);
    }
  }

  private handleElodinPacket(header: any, payload: Buffer): void {
    try {
      // ALWAYS log packet info - this is critical for debugging
      const [high, low] = header.packetId;

      // Log ALL packets from Elodin DB - this is critical
      console.log(`📦 Server received packet: type=${header.ty}, packetId=[0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}], payloadLen=${payload.length}`);

      const parsed = parseElodinPacket(header.packetId, payload);

      if (!parsed) {
        console.warn(`⚠️ Failed to parse packet: packetId=[0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}], payloadLen=${payload.length}`);
        // Log hex dump for debugging
        const hexPreview = payload.subarray(0, Math.min(32, payload.length)).toString('hex');
        console.warn(`   Payload hex: ${hexPreview}...`);
        return;
      }

      // Log parsed data
      console.log(`✅ Parsed: ${parsed.entity}.${parsed.component} = ${parsed.value.toFixed(2)}`);

      if (parsed) {
        // Update cache
        const key = `${parsed.entity}.${parsed.component}`;
        const update: SensorUpdate = {
          entity: parsed.entity,
          component: parsed.component,
          value: parsed.value,
          timestamp: parsed.timestamp,
        };
        this.sensorCache.set(key, update);

        // Broadcast to ALL clients (subscription filtering happens on frontend)
        // This ensures all data is available, frontend can filter as needed
        const message = {
          type: MessageType.SENSOR_UPDATE,
          timestamp: parsed.timestamp,
          payload: update,
        };

        // ALWAYS log broadcasts - this is critical for debugging
        const clientCount = this.clients.size;
        const openClients = Array.from(this.clients.values()).filter(c => c.ws.readyState === WebSocket.OPEN).length;

        // Log EVERY broadcast - don't throttle this
        console.log(`📤 Broadcasting: ${parsed.entity}.${parsed.component} = ${parsed.value.toFixed(2)} to ${openClients}/${clientCount} clients`);

        // Log the actual message being sent
        console.log(`   Message: ${JSON.stringify(message).substring(0, 100)}...`);

        this.broadcast(message);

        // Log after broadcast to confirm it was sent
        if (openClients > 0) {
          console.log(`   ✅ Sent to ${openClients} client(s)`);
        } else if (clientCount > 0) {
          console.warn(`   ⚠️ ${clientCount} clients connected but none are OPEN`);
        } else {
          console.warn(`   ⚠️ No clients connected - data is being lost!`);
        }
      } else {
        console.warn(`⚠️ Could not parse packet: type=${header.ty}, packetId=[0x${high.toString(16)}, 0x${low.toString(16)}]`);
      }
    } catch (error) {
      console.error('❌ Error handling Elodin packet:', error);
    }
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      console.log('📱 New WebSocket client connected');
      console.log(`   Total clients now: ${this.clients.size + 1}`);
      console.log(`   Client remote address: ${ws.url || 'unknown'}`);

      const client: Client = {
        ws,
        subscribedSensors: new Set(),
        lastPing: Date.now(),
      };

      this.clients.set(ws, client);

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

      // Send cached sensor data
      this.sensorCache.forEach((update) => {
        this.send(ws, {
          type: MessageType.SENSOR_UPDATE,
          timestamp: update.timestamp,
          payload: update,
        });
      });

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

  private handleCommand(command: CommandPayload): void {
    if (!this.elodin.isConnected()) {
      console.error('❌ Cannot send command: Elodin not connected');
      // Broadcast error to all clients
      this.broadcast({
        type: MessageType.ERROR,
        timestamp: Date.now(),
        payload: { message: 'Elodin DB not connected', command },
      });
      return;
    }

    try {
      if (command.commandType === 'state_transition') {
        const state = command.data.state;
        if (state !== undefined) {
          const success = this.elodin.sendCommand('state_transition', { state });
          if (success) {
            console.log(`🎯 State transition command sent: ${SystemState[state]}`);
            // Broadcast confirmation
            this.broadcast({
              type: MessageType.STATE_UPDATE,
              timestamp: Date.now(),
              payload: { currentState: state, stateName: SystemState[state], timestamp: Date.now() },
            });
          } else {
            throw new Error('Failed to send state transition command');
          }
        }
      } else if (command.commandType === 'actuator') {
        const { actuatorId, actuatorState } = command.data;
        if (actuatorId !== undefined && actuatorState !== undefined) {
          const success = this.elodin.sendCommand('actuator', {
            actuatorId,
            state: actuatorState,
          });
          if (success) {
            console.log(`🎯 Actuator command sent: ${ActuatorId[actuatorId]} -> ${ActuatorState[actuatorState]}`);
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
            throw new Error('Failed to send actuator command');
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
          // TODO: Send PWM actuator command
          // Format: actuator_id, duration_ms, duty_cycle (0-1), frequency (Hz)
          console.log(`🎯 PWM Actuator command: ${ActuatorId[actuatorId]}, Duty: ${dutyCycle}, Freq: ${frequency || 10}Hz`);
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

  private startUpdateLoop(): void {
    // Update loop for broadcasting sensor data
    // In production, this would be driven by Elodin packet events
    // For now, this is a placeholder that simulates updates
    this.updateInterval = setInterval(() => {
      // TODO: Get real sensor data from Elodin
      // For now, we'll implement this when we have the full Elodin protocol parsing
    }, 50); // 20 Hz update rate (50ms)
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
startAPIServer();

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
