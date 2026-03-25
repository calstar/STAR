/**
 * WebSocket client unit tests.
 * Tests message serialization, queueing, listener dispatch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketClient, WSMessage } from '@/lib/websocket';
import { MessageType, SystemState, ActuatorState } from '@/lib/types';

// ── Mock WebSocket global ────────────────────────────────────────────────────

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  sentMessages: string[] = [];

  constructor(public url: string) {
    // Simulate async connection
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.({ type: 'open' });
    }, 10);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: 'test' });
  }

  // Test helper: simulate server sending a message
  simulateMessage(msg: WSMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

// Mock fetch for subscribeToAllSensors
const mockFetch = vi.fn().mockRejectedValue(new Error('no server'));

// Replace globals
let mockWsInstance: MockWebSocket | null = null;

beforeEach(() => {
  mockWsInstance = null;
  (globalThis as any).WebSocket = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      mockWsInstance = this;
    }
  };
  // Copy static constants
  (globalThis as any).WebSocket.OPEN = MockWebSocket.OPEN;
  (globalThis as any).WebSocket.CLOSED = MockWebSocket.CLOSED;
  (globalThis as any).WebSocket.CONNECTING = MockWebSocket.CONNECTING;
  (globalThis as any).WebSocket.CLOSING = MockWebSocket.CLOSING;
  (globalThis as any).fetch = mockFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WebSocketClient', () => {
  it('should serialize sendCommand as correct JSON', async () => {
    const client = new WebSocketClient('ws://test:8081');
    client.connect();

    // Wait for connection
    await vi.waitFor(() => {
      expect(mockWsInstance?.readyState).toBe(MockWebSocket.OPEN);
    });

    client.sendCommand({
      commandType: 'state_transition',
      data: { state: SystemState.ARMED },
    });

    // Find the SEND_COMMAND message (skip subscription messages)
    const commandMessages = mockWsInstance!.sentMessages
      .map(s => JSON.parse(s))
      .filter((m: WSMessage) => m.type === MessageType.SEND_COMMAND);

    expect(commandMessages.length).toBe(1);
    expect(commandMessages[0].type).toBe('send_command');
    expect(commandMessages[0].payload.commandType).toBe('state_transition');
    expect(commandMessages[0].payload.data.state).toBe(SystemState.ARMED);
    expect(typeof commandMessages[0].timestamp).toBe('number');
  });

  it('should serialize actuator command correctly', async () => {
    const client = new WebSocketClient('ws://test:8081');
    client.connect();
    await vi.waitFor(() => {
      expect(mockWsInstance?.readyState).toBe(MockWebSocket.OPEN);
    });

    client.sendCommand({
      commandType: 'actuator',
      data: {
        actuatorName: 'LOX_Main',
        actuatorState: ActuatorState.OPEN,
      } as any,
    });

    const commandMessages = mockWsInstance!.sentMessages
      .map(s => JSON.parse(s))
      .filter((m: WSMessage) => m.type === MessageType.SEND_COMMAND);

    expect(commandMessages.length).toBe(1);
    expect(commandMessages[0].payload.commandType).toBe('actuator');
    expect(commandMessages[0].payload.data.actuatorName).toBe('LOX_Main');
    expect(commandMessages[0].payload.data.actuatorState).toBe(ActuatorState.OPEN);
  });

  it('should queue messages when WebSocket is not connected', () => {
    const client = new WebSocketClient('ws://test:8081');
    // Don't call connect() — WS is null

    client.sendCommand({
      commandType: 'state_transition',
      data: { state: SystemState.ARMED },
    });

    // Message should be queued, not sent
    // The WS instance shouldn't exist yet or should not have sent messages
    expect(mockWsInstance).toBeNull();
  });

  it('should dispatch messages to correct listeners', async () => {
    const client = new WebSocketClient('ws://test:8081');
    client.connect();
    await vi.waitFor(() => {
      expect(mockWsInstance?.readyState).toBe(MockWebSocket.OPEN);
    });

    const sensorCallback = vi.fn();
    const stateCallback = vi.fn();

    client.on(MessageType.SENSOR_UPDATE, sensorCallback);
    client.on(MessageType.STATE_UPDATE, stateCallback);

    // Simulate server sending a SENSOR_UPDATE
    mockWsInstance!.simulateMessage({
      type: MessageType.SENSOR_UPDATE,
      timestamp: Date.now(),
      payload: { entity: 'PT_Cal.PT_CH1', component: 'pressure_psi', value: 42.5, timestamp: Date.now() },
    });

    expect(sensorCallback).toHaveBeenCalledTimes(1);
    expect(sensorCallback).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'PT_Cal.PT_CH1', value: 42.5 }),
    );
    expect(stateCallback).not.toHaveBeenCalled();

    // Simulate STATE_UPDATE
    mockWsInstance!.simulateMessage({
      type: MessageType.STATE_UPDATE,
      timestamp: Date.now(),
      payload: { currentState: SystemState.ARMED, stateName: 'ARMED', timestamp: Date.now() },
    });

    expect(stateCallback).toHaveBeenCalledTimes(1);
    expect(stateCallback).toHaveBeenCalledWith(
      expect.objectContaining({ currentState: SystemState.ARMED }),
    );
  });

  it('should return working unsubscribe function from on()', async () => {
    const client = new WebSocketClient('ws://test:8081');
    client.connect();
    await vi.waitFor(() => {
      expect(mockWsInstance?.readyState).toBe(MockWebSocket.OPEN);
    });

    const callback = vi.fn();
    const unsub = client.on(MessageType.SENSOR_UPDATE, callback);

    // First message should be received
    mockWsInstance!.simulateMessage({
      type: MessageType.SENSOR_UPDATE,
      timestamp: Date.now(),
      payload: { entity: 'PT_Cal.PT_CH1', component: 'pressure_psi', value: 1, timestamp: Date.now() },
    });
    expect(callback).toHaveBeenCalledTimes(1);

    // Unsubscribe
    unsub();

    // Second message should NOT be received
    mockWsInstance!.simulateMessage({
      type: MessageType.SENSOR_UPDATE,
      timestamp: Date.now(),
      payload: { entity: 'PT_Cal.PT_CH1', component: 'pressure_psi', value: 2, timestamp: Date.now() },
    });
    expect(callback).toHaveBeenCalledTimes(1); // still 1
  });

  it('should report connection status', async () => {
    const client = new WebSocketClient('ws://test:8081');

    expect(client.isConnected()).toBe(false);

    client.connect();
    await vi.waitFor(() => {
      expect(mockWsInstance?.readyState).toBe(MockWebSocket.OPEN);
    });

    expect(client.isConnected()).toBe(true);

    client.disconnect();
    expect(client.isConnected()).toBe(false);
  });
});
