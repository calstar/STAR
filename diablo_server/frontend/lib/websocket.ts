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
const WS_CLIENT_VERSION = 2;

export class WebSocketClient {
  public readonly _version = WS_CLIENT_VERSION;
  private ws: WebSocket | null = null;
  private fallbackUrls: string[];
  private urlIndex = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTime = 0;
  private listeners: Map<string, Set<(payload: unknown) => void>> = new Map();
  private connectionStatusListeners: Set<(status: ConnectionStatus) => void> = new Set();
  private currentConnectionStatus: ConnectionStatus = { connected: false, elodinConnected: false };
  private messageQueue: WSMessage[] = []; // Queue messages until WebSocket is ready
  private static readonly MESSAGE_QUEUE_MAX = 50; // Prevent unbounded growth during disconnect
  private attemptCounter = 0;
  private socketCounter = 0;
  private activeAttemptId: string | null = null;
  private activeSocketId: string | null = null;
  private connectStartMs = 0;
  private lastCloseCode: number | null = null;
  private lastCloseReason = '';

  constructor(urls: string[] = ['ws://localhost:8081']) {
    this.fallbackUrls = urls.length > 0 ? Array.from(new Set(urls)) : ['ws://localhost:8081'];
  }

  connect(caller = 'unknown'): void {
    const readyState = this.ws?.readyState ?? null;
    this.log('connect_called', {
      caller,
      wsReadyState: readyState,
      hasReconnectTimer: !!this.reconnectTimer,
      urlIndex: this.urlIndex,
      queueLen: this.messageQueue.length,
    });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.log('connect_skipped', { caller, reason: 'already_open' });
      return;
    }
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      // Multiple components call connect() on mount; do not flap the socket.
      this.log('connect_skipped', { caller, reason: 'already_connecting' });
      return;
    }

    // Close existing connection if any
    if (this.ws) {
      this.log('socket_replaced', { caller, previousReadyState: this.ws.readyState });
      this.ws.close();
    }

    try {
      const url = this.fallbackUrls[this.urlIndex] ?? this.fallbackUrls[0];
      this.connectStartMs = Date.now();
      this.activeAttemptId = `a${++this.attemptCounter}`;
      this.activeSocketId = `s${++this.socketCounter}`;
      this.log('socket_create', {
        caller,
        url,
        attemptId: this.activeAttemptId,
        socketId: this.activeSocketId,
        fallbackCount: this.fallbackUrls.length,
      });
      const socket = new WebSocket(url);
      this.ws = socket;

      socket.onopen = () => {
        if (this.ws !== socket) return;
        this.lastMessageTime = Date.now();
        this.startStaleCheck();
        this.log('open', {
          url,
          attemptId: this.activeAttemptId,
          socketId: this.activeSocketId,
          queuedBeforeFlush: this.messageQueue.length,
          listenerTypeCount: this.listeners.size,
          connStatusListenerCount: this.connectionStatusListeners.size,
          msSinceConnectCall: Math.max(0, Date.now() - this.connectStartMs),
        });
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

      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        this.lastMessageTime = Date.now();
        try {
          const message: WSMessage = JSON.parse(event.data);
          this.handleMessage(message);
        } catch {
          // silently drop malformed messages
        }
      };

      socket.onerror = (error) => {
        if (this.ws !== socket) return;
        this.log('error', {
          url,
          attemptId: this.activeAttemptId,
          socketId: this.activeSocketId,
          readyState: this.ws?.readyState ?? null,
          message: error instanceof Event ? 'event' : String(error),
        });
        this.notifyConnectionStatus({ connected: false, elodinConnected: false });
      };

      socket.onclose = (event) => {
        if (this.ws !== socket) return;
        this.stopStaleCheck();
        this.lastCloseCode = event.code;
        this.lastCloseReason = event.reason || '';
        this.log('close', {
          attemptId: this.activeAttemptId,
          socketId: this.activeSocketId,
          code: event.code,
          reason: event.reason || '',
          wasClean: event.wasClean,
          readyState: this.ws?.readyState ?? null,
          willScheduleReconnect: true,
          reconnectTimerActive: !!this.reconnectTimer,
          pageVisibility: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
        });
        if (this.fallbackUrls.length > 1) {
          this.urlIndex = (this.urlIndex + 1) % this.fallbackUrls.length;
          const nextUrl = this.fallbackUrls[this.urlIndex];
          this.log('fallback_advance', { nextUrl, urlIndex: this.urlIndex });
        }
        this.notifyConnectionStatus({ connected: false, elodinConnected: false });
        this.scheduleReconnect();
      };
    } catch (error) {
      this.log('create_failed', { message: String(error) });
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
        try { listener(message.payload); } catch (err) { console.error('[WS] listener threw:', err); }
      });
    }
    if (message.type === MessageType.CONNECTION_STATUS) {
      const status = message.payload as ConnectionStatus;
      this.log('connection_status_message', {
        connected: status.connected,
        elodinConnected: status.elodinConnected,
        connId: status.connId ?? null,
      });
      this.notifyConnectionStatus(status);
    }
  }

  on(type: MessageType | string, callback: (payload: unknown) => void): () => void {
    const typeStr = type as string;
    if (!this.listeners.has(typeStr)) {
      this.listeners.set(typeStr, new Set());
    }
    this.listeners.get(typeStr)!.add(callback);
    this.log('listener_added', {
      type: typeStr,
      countForType: this.listeners.get(typeStr)?.size ?? 0,
      connected: this.isConnected(),
    });

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
    this.log('connection_status_listener_added', {
      count: this.connectionStatusListeners.size,
      connected: this.currentConnectionStatus.connected,
      elodinConnected: this.currentConnectionStatus.elodinConnected,
    });
    // Replay latest status so late subscribers don't get stuck "Disconnected".
    callback(this.currentConnectionStatus);
    return () => {
      this.connectionStatusListeners.delete(callback);
    };
  }

  private notifyConnectionStatus(status: ConnectionStatus): void {
    this.currentConnectionStatus = status;
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
      this.log('reconnect_skip', { reason: 'timer_exists' });
      return;
    }
    this.log('reconnect_scheduled', {
      delayMs: 3000,
      attemptId: this.activeAttemptId,
      socketId: this.activeSocketId,
      closeCode: this.lastCloseCode,
      closeReason: this.lastCloseReason,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.log('reconnect_fired', {
        attemptId: this.activeAttemptId,
        socketId: this.activeSocketId,
      });
      this.connect('reconnect_timer');
    }, 3000);
  }

  disconnect(): void {
    this.log('disconnect_called', {
      hasReconnectTimer: !!this.reconnectTimer,
      hasSocket: !!this.ws,
      readyState: this.ws?.readyState ?? null,
    });
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

  private log(event: string, fields: Record<string, unknown>): void {
    console.log(`[WS] ${JSON.stringify({ event, ts: Date.now(), ...fields })}`);
  }
}

declare global {
  // Keep singleton stable across Next dev/HMR module reloads.
  // eslint-disable-next-line no-var
  var __DIABLO_WS_CLIENT__: WebSocketClient | undefined;
}

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

export function getWebSocketClient(): WebSocketClient {
  const existing = globalThis.__DIABLO_WS_CLIENT__;
  const isStale = !!existing && (existing as any)._version !== WS_CLIENT_VERSION;
  if (isStale) {
    try {
      existing?.disconnect();
    } catch {
      // ignore stale instance disconnect errors
    }
    globalThis.__DIABLO_WS_CLIENT__ = undefined;
    console.log(`[WS] ${JSON.stringify({ event: 'singleton_replaced_stale', ts: Date.now() })}`);
  }

  if (!globalThis.__DIABLO_WS_CLIENT__) {
    const urls = getWebSocketFallbackUrls();
    console.log(`🔧 Creating WebSocket client singleton with URLs: ${urls.join(', ')}`);
    globalThis.__DIABLO_WS_CLIENT__ = new WebSocketClient(urls);
  } else {
    console.log('[WS] {"event":"singleton_reused","ts":' + Date.now() + '}');
  }
  return globalThis.__DIABLO_WS_CLIENT__;
}

function getWebSocketFallbackUrls(): string[] {
  const urls: string[] = [];
  const add = (u: string) => {
    if (!u) return;
    if (!urls.includes(u)) urls.push(u);
  };

  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_WS_URL) {
    add(process.env.NEXT_PUBLIC_WS_URL);
  }

  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let hostname = window.location.hostname;
    if (hostname === '0.0.0.0' || hostname === '') hostname = 'localhost';
    add(`${protocol}//${hostname}:8081`);
    add(`${protocol}//localhost:8081`);
    add(`${protocol}//127.0.0.1:8081`);
  }

  if (urls.length === 0) add('ws://localhost:8081');
  return urls;
}
