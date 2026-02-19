/**
 * Elodin DB Query Client
 * Implements query/polling API as fallback when streaming doesn't work
 * Based on Python ground station implementation
 */

import { EventEmitter } from 'events';
import { ElodinClient, ElodinPacketType } from './elodin-client.js';
import { parseElodinPacket } from './elodin-protocol.js';
import type { SensorUpdate } from '../../shared/types.js';

export interface QueryOptions {
  packetId: [number, number];
  startTime?: number; // Unix timestamp in milliseconds
  endTime?: number;   // Unix timestamp in milliseconds
  limit?: number;     // Max number of records
}

export interface QueryResponse {
  packetId: [number, number];
  data: SensorUpdate[];
  timestamp: number;
}

export class ElodinQueryClient extends EventEmitter {
  private elodin: ElodinClient;
  private pollingInterval: NodeJS.Timeout | null = null;
  private pollingRate: number = 100; // 10 Hz (100ms)
  private lastTimestamps: Map<string, number> = new Map();
  private subscribedPacketIds: Set<string> = new Set();
  private isPolling: boolean = false;

  constructor(elodin: ElodinClient) {
    super();
    this.elodin = elodin;

    // Listen for query responses from Elodin DB
    // Note: Elodin DB may send QUERY responses as TABLE packets with special packet IDs
    // For now, we'll parse all TABLE packets and filter by subscribed packet IDs
    this.elodin.on('packet', (header, payload) => {
      if (header.ty === ElodinPacketType.TABLE) {
        const [high, low] = header.packetId;
        const packetIdKey = `${high},${low}`;

        if (this.subscribedPacketIds.has(packetIdKey)) {
          const parsed = parseElodinPacket(header.packetId, payload);
          if (parsed) {
            const update: SensorUpdate = {
              entity: parsed.entity,
              component: parsed.component,
              value: parsed.value,
              timestamp: parsed.timestamp,
            };
            this.emit('sensor_update', update);
          }
        }
      }
    });
  }

  /**
   * Subscribe to a packet ID for polling
   */
  subscribe(packetId: [number, number]): void {
    const [high, low] = packetId;
    const packetIdKey = `${high},${low}`;
    this.subscribedPacketIds.add(packetIdKey);
    this.lastTimestamps.set(packetIdKey, Date.now());
    console.log(`📊 Query client subscribed to packet [0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}]`);
  }

  /**
   * Unsubscribe from a packet ID
   */
  unsubscribe(packetId: [number, number]): void {
    const [high, low] = packetId;
    const packetIdKey = `${high},${low}`;
    this.subscribedPacketIds.delete(packetIdKey);
    this.lastTimestamps.delete(packetIdKey);
  }

  /**
   * Send a QUERY packet to Elodin DB
   */
  async query(options: QueryOptions): Promise<QueryResponse> {
    if (!this.elodin.isConnected()) {
      throw new Error('Elodin DB not connected');
    }

    const { packetId, startTime, endTime, limit = 1000 } = options;
    const [high, low] = packetId;

    // Create query payload
    // Format: JSON with query parameters
    // Note: Elodin DB may use postcard encoding, but JSON is simpler for now
    const queryPayload = {
      packet_id: [high, low],
      start_time: startTime || Date.now() - 60000, // Default: last 60 seconds
      end_time: endTime || Date.now(),
      limit: limit,
    };

    const payloadBuffer = Buffer.from(JSON.stringify(queryPayload), 'utf-8');

    // Send QUERY packet
    // Packet ID [0x00, 0x00] is used for queries
    const queryPacketId: [number, number] = [0x00, 0x00];
    const success = this.elodin.sendRawMessage(
      queryPacketId,
      ElodinPacketType.QUERY,
      payloadBuffer
    );

    if (!success) {
      throw new Error('Failed to send query packet');
    }

    // Note: Elodin DB may respond with QUERY response packets
    // For now, we'll rely on the polling mechanism to collect data
    // In a full implementation, we'd wait for and parse the QUERY response

    return {
      packetId,
      data: [], // Will be populated by polling
      timestamp: Date.now(),
    };
  }

  /**
   * Start polling for subscribed packet IDs
   */
  startPolling(): void {
    if (this.isPolling) {
      return;
    }

    this.isPolling = true;
    console.log(`🔄 Starting query polling at ${1000 / this.pollingRate} Hz`);

    const pollLoop = async () => {
      if (!this.isPolling || !this.elodin.isConnected()) {
        return;
      }

      // Poll each subscribed packet ID
      for (const packetIdKey of this.subscribedPacketIds) {
        const [high, low] = packetIdKey.split(',').map(Number) as [number, number];
        const lastTimestamp = this.lastTimestamps.get(packetIdKey) || Date.now() - 60000;

        try {
          // Query for new data since last timestamp
          await this.query({
            packetId: [high, low],
            startTime: lastTimestamp,
            endTime: Date.now(),
            limit: 100,
          });

          // Update last timestamp
          this.lastTimestamps.set(packetIdKey, Date.now());
        } catch (error: any) {
          // Don't spam errors for ECONNRESET - connection is likely closed
          if (error.code === 'ECONNRESET') {
            console.warn(`⚠️ Query failed: Connection reset (Elodin DB may have closed connection)`);
            this.stopPolling(); // Stop polling if connection is reset
            return;
          }
          // Only log other errors occasionally to avoid spam
          if (Math.random() < 0.1) {
            console.error(`❌ Query error for packet [0x${high.toString(16)}, 0x${low.toString(16)}]:`, error);
          }
        }
      }
    };

    // Start polling loop
    this.pollingInterval = setInterval(pollLoop, this.pollingRate);
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (!this.isPolling) {
      return;
    }

    this.isPolling = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    console.log('🛑 Stopped query polling');
  }

  /**
   * Set polling rate (in milliseconds)
   */
  setPollingRate(rateMs: number): void {
    this.pollingRate = rateMs;
    if (this.isPolling) {
      this.stopPolling();
      this.startPolling();
    }
  }

  /**
   * Get all subscribed packet IDs
   */
  getSubscribedPacketIds(): Array<[number, number]> {
    return Array.from(this.subscribedPacketIds).map((key) => {
      const [high, low] = key.split(',').map(Number);
      return [high, low] as [number, number];
    });
  }
}
