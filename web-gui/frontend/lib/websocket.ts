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
  private listeners: Map<string, Set<(payload: unknown) => void>> = new Map();
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

        // Subscribe immediately - WebSocket is ready when onopen fires
        console.log('📡 Subscribing to all sensors...');
        this.subscribeToAllSensors();
        console.log('✅ Subscription requests sent');

        // Request historical data for plots
        console.log('📊 Requesting historical plot data...');
        this.send({
          type: MessageType.QUERY_HISTORICAL,
          timestamp: Date.now(),
          payload: {},
        });
      };

      this.ws.onmessage = (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data);
          this.handleMessage(message);
        } catch {
          // silently drop malformed messages
        }
      };

      this.ws.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
        console.error(`   URL: ${this.url}`);
        console.error(`   Ready state: ${this.ws?.readyState} (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)`);
        console.error(`   Check: Is backend WebSocket server running on port 8081?`);
        this.notifyConnectionStatus({ connected: false, elodinConnected: false });
      };

      this.ws.onclose = (event) => {
        console.log(`🔌 WebSocket disconnected (code: ${event.code}, reason: ${event.reason || 'none'})`);
        console.log(`   Ready state: ${this.ws?.readyState} (3=CLOSED)`);
        if (event.code !== 1000) {
          console.error(`   Abnormal close - check backend logs`);
        }
        this.notifyConnectionStatus({ connected: false, elodinConnected: false });
        this.scheduleReconnect();
      };
    } catch (error) {
      console.error('❌ Failed to create WebSocket:', error);
      this.scheduleReconnect();
    }
  }

  private async subscribeToAllSensors(): Promise<void> {
    const sensors = new Set<string>();

    // Core channels up to 32 to be safe
    for (let i = 1; i <= 32; i++) {
      sensors.add(`PT_Cal.PT_CH${i}`);
      sensors.add(`PT.PT_CH${i}`);
      sensors.add(`ACT.ACT_CH${i}`);
    }

    try {
      const API_BASE_URL = typeof window !== 'undefined' && window.location.hostname
        ? `${window.location.protocol === 'https:' ? 'https:' : 'http:'}//${window.location.hostname}:8082`
        : 'http://localhost:8082';

      const res = await fetch(`${API_BASE_URL}/api/sensor-config`);
      if (res.ok) {
        const data = await res.json();
        data.sensors?.forEach((s: any) => {
          if (s.entity) sensors.add(s.entity);
          if (s.calEntity) sensors.add(s.calEntity);
        });
      }

      const cfgRes = await fetch(`${API_BASE_URL}/api/config`);
      if (cfgRes.ok) {
        const cfgData = await cfgRes.json();
        const actRoles = cfgData.config?.actuator_roles || {};
        Object.keys(actRoles).forEach(role => {
          sensors.add(`ACT.${role.replace(/\\s+/g, '_')}`);
        });
      }
    } catch (e) {
      console.warn("Could not fetch dynamic sensors, falling back to basic array:", e);
    }

    console.log(`📋 Subscribing to ${sensors.size} sensor entities`);
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
    // Handle both MessageType enum values and custom string types (like 'state_transitions')
    const typeStr = message.type as string;
    const listeners = this.listeners.get(typeStr);
    if (listeners && listeners.size > 0) {
      listeners.forEach(listener => {
        try { listener(message.payload); } catch { /* silent */ }
      });
    }
    if (message.type === MessageType.CONNECTION_STATUS) {
      this.notifyConnectionStatus(message.payload as ConnectionStatus);
    }
  }

  on(type: MessageType | string, callback: (payload: unknown) => void): () => void {
    const typeStr = type as string;
    if (!this.listeners.has(typeStr)) {
      this.listeners.set(typeStr, new Set());
    }
    this.listeners.get(typeStr)!.add(callback);

    // Return unsubscribe function
    return () => {
      const listeners = this.listeners.get(typeStr);
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

  /** Generic message send — used by calibration page etc. */
  send(message: WSMessage): void {
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
