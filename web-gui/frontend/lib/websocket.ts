/**
 * WebSocket client for sensor system
 */

import { MessageType, SensorUpdate, ConnectionStatus, CommandPayload } from './types';
import { useSensorStore } from './store';

export interface WSMessage {
  type: MessageType;
  timestamp: number;
  payload: unknown;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private listeners: Map<MessageType, Set<(payload: unknown) => void>> = new Map();
  private connectionStatusListeners: Set<(status: ConnectionStatus) => void> = new Set();
  private messageQueue: WSMessage[] = []; // Queue messages until WebSocket is ready

  constructor(url: string = 'ws://localhost:8081') {
    this.url = url;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log('✅ WebSocket already connected');
      return;
    }

    // Close existing connection if any
    if (this.ws) {
      console.log('🔌 Closing existing WebSocket connection...');
      this.ws.close();
    }

    try {
      console.log(`🔌 Connecting to WebSocket: ${this.url}`);
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('✅ WebSocket connected to backend');
        console.log(`   WebSocket URL: ${this.url}`);
        console.log(`   Ready state: ${this.ws?.readyState} (1=OPEN)`);
        this.notifyConnectionStatus({ connected: true, elodinConnected: false });

        // Flush queued messages
        console.log(`📤 Flushing ${this.messageQueue.length} queued messages...`);
        while (this.messageQueue.length > 0) {
          const msg = this.messageQueue.shift();
          if (msg && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
          }
        }

        // Wait a tiny bit to ensure WebSocket is fully ready, then subscribe
        setTimeout(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            console.log('📡 Subscribing to all sensors...');
            this.subscribeToAllSensors();
            console.log('✅ Subscription requests sent');
          } else {
            console.error('❌ WebSocket not ready when trying to subscribe!');
          }
        }, 50);
      };

      this.ws.onmessage = (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data);
          // ALWAYS log sensor updates - this is critical for debugging
          if (message.type === MessageType.SENSOR_UPDATE) {
            const update = message.payload as SensorUpdate;
            console.log(`📥 Frontend received: ${update.entity}.${update.component} = ${update.value.toFixed(2)}`);
          } else {
            console.log(`📥 Frontend received message type: ${message.type}`);
          }
          this.handleMessage(message);
        } catch (error) {
          console.error('❌ Failed to parse message:', error);
          console.error('   Raw data:', event.data);
        }
      };

      this.ws.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
        console.error(`   URL: ${this.url}`);
        console.error(`   Ready state: ${this.ws?.readyState}`);
        this.notifyConnectionStatus({ connected: false, elodinConnected: false });
      };

      this.ws.onclose = () => {
        console.log('🔌 WebSocket disconnected');
        this.notifyConnectionStatus({ connected: false, elodinConnected: false });
        this.scheduleReconnect();
      };
    } catch (error) {
      console.error('❌ Failed to create WebSocket:', error);
      this.scheduleReconnect();
    }
  }

  private subscribeToAllSensors(): void {
    // Subscribe to all sensor entities we care about
    const sensors = [
      'PT_Cal.GN2_Regulated',
      'PT_Cal.Fuel_Upstream',
      'PT_Cal.Ox_Upstream',
      'PT_Cal.Fuel_Downstream',
      'PT_Cal.Ox_Downstream',
      'PT_Cal.GSE_Low',
      'PT_Cal.GSE_Mid',
      'PT_Cal.GSE_High',
      'PT_Cal.GN2_High',
      'PT_Cal.PT_CH8',
      'PT_Cal.PT_CH9',
      'PT_Cal.PT_CH10',
      'PT.GN2_Regulated',
      'PT.Fuel_Upstream',
      'PT.Ox_Upstream',
      'PT.Fuel_Downstream',
      'PT.Ox_Downstream',
      'PT.GSE_Low',
      'PT.GSE_Mid',
      'ACT.LOX_Main',
      'ACT.Fuel_Main',
      'ACT.LOX_Vent',
      'ACT.Fuel_Vent',
      'ACT.LOX_Press',
      'ACT.Fuel_Press',
      'ACT.GSE_Low_Vent',
    ];

    console.log(`📋 Subscribing to ${sensors.length} sensor entities`);
    sensors.forEach((entity) => {
      this.send({
        type: MessageType.SUBSCRIBE_SENSOR,
        timestamp: Date.now(),
        payload: { entity },
      });
    });
    console.log('✅ All subscription requests sent');
  }

  private handleMessage(message: WSMessage): void {
    const listeners = this.listeners.get(message.type);

    // ALWAYS log if no listeners - this is a critical issue
    if (message.type === MessageType.SENSOR_UPDATE) {
      const update = message.payload as SensorUpdate;
      if (!listeners || listeners.size === 0) {
        console.error(`❌ CRITICAL: No listeners for SENSOR_UPDATE!`);
        console.error(`   Entity: ${update.entity}.${update.component} = ${update.value}`);
        console.error(`   This means components haven't subscribed.`);
        console.error(`   Check that pages call: ws.on(MessageType.SENSOR_UPDATE, ...)`);
      } else {
        console.log(`✅ Calling ${listeners.size} listener(s) for ${update.entity}.${update.component}`);
      }
    }

    if (listeners && listeners.size > 0) {
      listeners.forEach((listener) => {
        try {
          listener(message.payload);
        } catch (error) {
          console.error(`❌ Error in listener for ${message.type}:`, error);
        }
      });
    }

    // Handle connection status updates
    if (message.type === MessageType.CONNECTION_STATUS) {
      this.notifyConnectionStatus(message.payload as ConnectionStatus);
    }
  }

  on(type: MessageType, callback: (payload: unknown) => void): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(callback);

    // Return unsubscribe function
    return () => {
      const listeners = this.listeners.get(type);
      if (listeners) {
        listeners.delete(callback);
      }
    };
  }

  onConnectionStatus(callback: (status: ConnectionStatus) => void): () => void {
    this.connectionStatusListeners.add(callback);
    return () => {
      this.connectionStatusListeners.delete(callback);
    };
  }

  private notifyConnectionStatus(status: ConnectionStatus): void {
    this.connectionStatusListeners.forEach((listener) => listener(status));
  }

  sendCommand(command: CommandPayload): void {
    this.send({
      type: MessageType.SEND_COMMAND,
      timestamp: Date.now(),
      payload: command,
    });
  }

  private send(message: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        console.error('❌ Failed to send WebSocket message:', error);
        // Queue message for retry
        this.messageQueue.push(message);
      }
    } else {
      // Queue message to send when WebSocket is ready
      console.warn(`⚠️ WebSocket not ready (state: ${this.ws?.readyState}), queuing message`);
      this.messageQueue.push(message);

      // If WebSocket is connecting, wait for it
      if (!this.ws || this.ws.readyState === WebSocket.CONNECTING) {
        // Already connecting, message will be sent when ready
      } else if (this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
        // WebSocket is closed, try to reconnect
        console.log('🔄 WebSocket closed, attempting reconnect...');
        this.connect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log('🔄 Attempting to reconnect...');
      this.connect();
    }, 3000);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
let wsClient: WebSocketClient | null = null;

// Auto-detect WebSocket URL based on current hostname
function getWebSocketUrl(): string {
  // Use environment variable if set
  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_WS_URL) {
    return process.env.NEXT_PUBLIC_WS_URL;
  }

  // Auto-detect from current hostname (for network access)
  // Only works in browser, not during SSR
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Always use port 8081 for WebSocket backend
    const port = ':8081';
    const url = `${protocol}//${hostname}${port}`;
    console.log(`🔗 WebSocket URL determined: ${url}`);
    return url;
  }

  // Fallback for server-side rendering (will be replaced when client-side code runs)
  return 'ws://localhost:8081';
}

export function getWebSocketClient(): WebSocketClient {
  if (!wsClient) {
    const url = getWebSocketUrl();
    console.log(`🔧 Creating WebSocket client singleton with URL: ${url}`);
    wsClient = new WebSocketClient(url);
  }
  return wsClient;
}
