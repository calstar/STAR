/**
 * WebSocket client for sensor system
 */

import { MessageType, SensorUpdate, ConnectionStatus, CommandPayload } from './types';
import { useSensorStore, buildAliasesFromConfig } from './store';
import { updateServerTimeOffset } from './server-time';

export interface WSMessage {
  type: MessageType;
  timestamp: number;
  payload: unknown;
}

/** If no message received for this long, treat connection as stale and reconnect.
 *  Disabled by default because some hardware runs can have sparse/bursty streams and
 *  aggressive stale-closing causes false frontend disconnect loops.
 *  Enable by setting NEXT_PUBLIC_WS_STALE_MS to a positive integer (ms).
 */
const STALE_CONNECTION_MS = (() => {
  const raw = (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_WS_STALE_MS : undefined) ?? '';
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
})();
const STALE_CHECK_INTERVAL_MS = 30 * 1000; // check every 30s

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTime = 0;
  private listeners: Map<string, Set<(payload: unknown) => void>> = new Map();
  private connectionStatusListeners: Set<(status: ConnectionStatus) => void> = new Set();
  private messageQueue: WSMessage[] = []; // Queue messages until WebSocket is ready
  private static readonly MESSAGE_QUEUE_MAX = 50; // Prevent unbounded growth during disconnect

  constructor(url: string = 'ws://localhost:8081') {
    this.url = url;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Idempotent connect: many components call ws.connect() on mount.
      // Never tear down a healthy socket from a repeated connect request.
      console.log('✅ WebSocket already connected');
      return;
    }
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      // Another caller already initiated connection; let it complete.
      return;
    }

    // If a previous socket is CLOSING/CLOSED, discard reference and create a new one.
    if (this.ws && (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED)) {
      this.ws = null;
    }

    try {
      console.log(`🔌 Connecting to WebSocket: ${this.url}`);
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.lastMessageTime = Date.now();
        this.startStaleCheck();
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
        this.lastMessageTime = Date.now();
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
        this.stopStaleCheck();
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
      sensors.add(`PT_Cal.CH${i}`);
      sensors.add(`PT.CH${i}`);
      sensors.add(`ACT.CH${i}`);
    }

    try {
      const res = await fetch(`${getApiBaseUrl()}/api/sensor-config`);
      if (res.ok) {
        const data = await res.json();
        data.sensors?.forEach((s: any) => {
          if (s.entity) sensors.add(s.entity);
          if (s.calEntity) sensors.add(s.calEntity);
        });
      }

      const cfgRes = await fetch(`${getApiBaseUrl()}/api/config`);
      if (cfgRes.ok) {
        const cfgData = await cfgRes.json();
        // Build dynamic aliases from config so named entities resolve to generic CH<n> keys
        if (cfgData.config) {
          buildAliasesFromConfig(cfgData.config);
        }
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
    if (message.timestamp) {
      updateServerTimeOffset(message.timestamp);
    }

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
        // Queue message for retry (cap to prevent memory bloat during long disconnects)
        if (this.messageQueue.length < WebSocketClient.MESSAGE_QUEUE_MAX) {
          this.messageQueue.push(message);
        }
      }
    } else {
      // Queue message to send when WebSocket is ready (cap to prevent memory bloat)
      if (this.messageQueue.length < WebSocketClient.MESSAGE_QUEUE_MAX) {
        console.warn(`⚠️ WebSocket not ready (state: ${this.ws?.readyState}), queuing message`);
        this.messageQueue.push(message);
      }

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

  private startStaleCheck(): void {
    if (STALE_CONNECTION_MS <= 0) return;
    this.stopStaleCheck();
    this.staleCheckTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      // Ignore stale checks while tab is backgrounded to avoid reconnect churn.
      if (typeof document !== 'undefined' && document.hidden) return;
      if (Date.now() - this.lastMessageTime > STALE_CONNECTION_MS) {
        console.warn(`⚠️ No WebSocket message for ${Math.round(STALE_CONNECTION_MS / 1000)}s — reconnecting (stale connection)`);
        this.stopStaleCheck();
        this.ws.close(1000, 'stale');
      }
    }, STALE_CHECK_INTERVAL_MS);
  }

  private stopStaleCheck(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
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
    this.stopStaleCheck();
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
// In Next.js dev, HMR can re-evaluate modules and reset module-scoped variables.
// Storing the singleton on `globalThis` keeps the connection stable across hot reloads.
const wsClientGlobal = globalThis as unknown as {
  __sensorSystemWsClient?: WebSocketClient;
};

export function getApiBaseUrl(): string {
  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) {
    const envUrl = process.env.NEXT_PUBLIC_API_URL;
    // Guard against common misconfig: hardcoded localhost while viewing UI from another host.
    if (typeof window !== 'undefined') {
      try {
        const parsed = new URL(envUrl);
        const isLocalEnv = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
        const isRemoteClient = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
        if (isLocalEnv && isRemoteClient) {
          const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
          return `${protocol}//${window.location.hostname}:8081`;
        }
      } catch {
        // Fall through to existing behavior.
      }
    }
    return envUrl;
  }
  if (typeof window !== 'undefined' && window.location.hostname) {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    return `${protocol}//${window.location.hostname}:8081`;
  }
  return 'http://localhost:8081';
}

// Auto-detect WebSocket URL based on current hostname
function getWebSocketUrl(): string {
  // Use environment variable if set
  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_WS_URL) {
    const envUrl = process.env.NEXT_PUBLIC_WS_URL;
    // Guard against localhost trap when client is remote (tablet/laptop on network).
    if (typeof window !== 'undefined') {
      try {
        const parsed = new URL(envUrl);
        const isLocalEnv = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
        const isRemoteClient = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
        if (isLocalEnv && isRemoteClient) {
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          return `${protocol}//${window.location.hostname}:8081`;
        }
      } catch {
        // Fall through to existing behavior.
      }
    }
    return envUrl;
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
  if (!wsClientGlobal.__sensorSystemWsClient) {
    const url = getWebSocketUrl();
    console.log(`🔧 Creating WebSocket client singleton with URL: ${url}`);
    wsClientGlobal.__sensorSystemWsClient = new WebSocketClient(url);
  }
  return wsClientGlobal.__sensorSystemWsClient;
}
