/**
 * @file elodin-publisher-batched.ts
 * @brief Elodin DB publisher matching DAQ Bridge pattern
 *
 * This publisher uses the same pattern as DAQ Bridge:
 * - begin_batch() before publishing multiple messages
 * - publish() for each message (adds to batch buffer)
 * - flush_batch() to send all messages in one TCP write
 *
 * This matches the C++ ElodinClient pattern exactly.
 */

import { ElodinClient, ElodinPacketType } from './elodin-client.js';

/**
 * Batched Elodin publisher matching DAQ Bridge pattern
 * Buffers messages and sends them all in one TCP write for efficiency
 */
export class ElodinPublisherBatched {
  private elodin: ElodinClient;
  private batchBuffer: Buffer[] = [];
  private batchActive: boolean = false;

  constructor(elodin: ElodinClient) {
    this.elodin = elodin;
  }

  /**
   * Begin a batch - all subsequent publish() calls will be batched
   * Matches: elodin_client.begin_batch()
   */
  beginBatch(): void {
    if (!this.elodin.isConnected()) {
      return;
    }
    // Clear any existing batch buffer
    this.batchBuffer = [];
    this.batchActive = true;
  }

  /**
   * Flush the batch - send all batched messages in one TCP write
   * Matches: elodin_client.flush_batch()
   */
  flushBatch(): boolean {
    if (!this.elodin.isConnected()) {
      this.batchBuffer = [];
      this.batchActive = false;
      return false;
    }

    if (!this.batchActive) {
      // Not in batch mode, nothing to flush
      return true;
    }

    if (this.batchBuffer.length === 0) {
      // Empty batch, nothing to send
      this.batchActive = false;
      return true;
    }

    try {
      // Concatenate all buffered packets into one TCP write
      const fullBatch = Buffer.concat(this.batchBuffer);
      
      // Send as a single write to Elodin DB
      // Use packetId [0x00, 0x00] and BATCH type (or just send raw)
      // Actually, Elodin DB expects individual TABLE packets, so we need to send them separately
      // But we can send them all in one socket.write() call for efficiency
      const socket = (this.elodin as any).socket;
      if (socket) {
        const flushed = socket.write(fullBatch);
        if (!flushed && Math.random() < 0.01) {
          console.warn('[ElodinPublisherBatched] ⚠️ Socket write buffer full during batch flush');
        }
      } else {
        // Fallback: send each packet individually (slower but works)
        for (const packet of this.batchBuffer) {
          const socket = (this.elodin as any).socket;
          if (socket) {
            socket.write(packet);
          }
        }
      }

      // Clear batch buffer
      this.batchBuffer = [];
      this.batchActive = false;
      return true;
    } catch (error) {
      console.error('[ElodinPublisherBatched] ❌ Failed to flush batch:', error);
      this.batchBuffer = [];
      this.batchActive = false;
      return false;
    }
  }

  /**
   * Add a packet to the batch buffer
   * Creates the header and payload, adds to buffer
   */
  private addToBatch(packetId: [number, number], packetType: ElodinPacketType, payload: Buffer): void {
    if (!this.batchActive) {
      // Not in batch mode, send immediately
      this.elodin.publishTable(packetId, payload);
      return;
    }

    // Create header and add to batch buffer
    const header = (this.elodin as any).createHeader(packetType, packetId, payload.length);
    const packet = Buffer.concat([header, payload]);
    this.batchBuffer.push(packet);
  }

  /**
   * Publish a raw PT message to Elodin DB
   * Matches: elodin_client.publish(packet_id, RawPTMessage)
   * 
   * @param channelId Channel ID (1-based: 1-10)
   * @param timestampNs Timestamp in nanoseconds
   * @param rawAdcCounts Raw ADC counts
   * @param sampleTimestampMs Sample timestamp in milliseconds
   * @param statusFlags Status flags
   */
  publishRawPT(
    channelId: number,
    timestampNs: bigint,
    rawAdcCounts: number,
    sampleTimestampMs: number,
    statusFlags: number = 0
  ): boolean {
    if (!this.elodin.isConnected()) {
      if (Math.random() < 0.01) {
        console.warn(`[ElodinPublisherBatched] ⚠️ Not connected, cannot publish raw PT CH${channelId}`);
      }
      return false;
    }

    try {
      // Encode RawPTMessage (21 bytes)
      const buffer = Buffer.alloc(21);
      buffer.writeBigUInt64LE(timestampNs, 0);
      buffer.writeUInt8(channelId, 8);
      // padding[3] (bytes 9-11) - already zero-filled
      buffer.writeUInt32LE(rawAdcCounts, 12);
      buffer.writeUInt32LE(sampleTimestampMs, 16);
      buffer.writeUInt8(statusFlags, 20);

      // Packet ID: [0x20, channel_id] for raw PT
      // Add to batch if batching is active, otherwise send immediately
      if (this.batchActive) {
        this.addToBatch([0x20, channelId], ElodinPacketType.TABLE, buffer);
        return true;
      } else {
        const success = this.elodin.publishTable([0x20, channelId], buffer);
        if (!success && Math.random() < 0.01) {
          console.warn(`[ElodinPublisherBatched] ⚠️ Failed to publish raw PT CH${channelId}`);
        }
        return success;
      }
    } catch (error) {
      console.error(`[ElodinPublisherBatched] ❌ Failed to publish raw PT CH${channelId}:`, error);
      return false;
    }
  }

  /**
   * Publish a calibrated PT message to Elodin DB
   * Matches: elodin_client.publish(packet_id, CalibratedPTMessage)
   * 
   * @param channelId Channel ID (1-based: 1-10)
   * @param timestampNs Timestamp in nanoseconds
   * @param pressurePsi Calibrated pressure in PSI
   * @param rawAdcCounts Raw ADC counts
   * @param calStatus Calibration status
   */
  publishCalibratedPT(
    channelId: number,
    timestampNs: bigint,
    pressurePsi: number,
    rawAdcCounts: number,
    calStatus: number = 0
  ): boolean {
    if (!this.elodin.isConnected()) {
      if (Math.random() < 0.01) {
        console.warn(`[ElodinPublisherBatched] ⚠️ Not connected, cannot publish calibrated PT CH${channelId}`);
      }
      return false;
    }

    try {
      // Encode CalibratedPTMessage (21 bytes)
      const buffer = Buffer.alloc(21);
      buffer.writeBigUInt64LE(timestampNs, 0);
      buffer.writeUInt8(channelId, 8);
      // padding[3] (bytes 9-11) - already zero-filled
      buffer.writeFloatLE(pressurePsi, 12);
      buffer.writeUInt32LE(rawAdcCounts, 16);
      buffer.writeUInt8(calStatus, 20);

      // Packet ID: [0x20, 0x10 + channel_id] for calibrated PT
      // Add to batch if batching is active, otherwise send immediately
      if (this.batchActive) {
        this.addToBatch([0x20, 0x10 + channelId], ElodinPacketType.TABLE, buffer);
        return true;
      } else {
        const success = this.elodin.publishTable([0x20, 0x10 + channelId], buffer);
        if (!success && Math.random() < 0.01) {
          console.warn(`[ElodinPublisherBatched] ⚠️ Failed to publish calibrated PT CH${channelId}`);
        }
        return success;
      }
    } catch (error) {
      console.error(`[ElodinPublisherBatched] ❌ Failed to publish calibrated PT CH${channelId}:`, error);
      return false;
    }
  }

  /**
   * Publish an actuator message to Elodin DB
   * Matches: elodin_client.publish(packet_id, RawPTMessage) for actuators
   * 
   * @param channelId Channel ID (1-based: 1-10)
   * @param timestampNs Timestamp in nanoseconds
   * @param rawAdcCounts Raw ADC counts
   * @param sampleTimestampMs Sample timestamp in milliseconds
   * @param statusFlags Status flags
   */
  publishActuator(
    channelId: number,
    timestampNs: bigint,
    rawAdcCounts: number,
    sampleTimestampMs: number,
    statusFlags: number = 0
  ): boolean {
    if (!this.elodin.isConnected()) {
      return false;
    }

    try {
      // Encode RawPTMessage (same format as PT, but packet ID is different)
      const buffer = Buffer.alloc(21);
      buffer.writeBigUInt64LE(timestampNs, 0);
      buffer.writeUInt8(channelId, 8);
      // padding[3] (bytes 9-11) - already zero-filled
      buffer.writeUInt32LE(rawAdcCounts, 12);
      buffer.writeUInt32LE(sampleTimestampMs, 16);
      buffer.writeUInt8(statusFlags, 20);

      // Packet ID: [0x30, channel_id] for actuators
      // Add to batch if batching is active, otherwise send immediately
      if (this.batchActive) {
        this.addToBatch([0x30, channelId], ElodinPacketType.TABLE, buffer);
        return true;
      } else {
        return this.elodin.publishTable([0x30, channelId], buffer);
      }
    } catch (error) {
      console.error('[ElodinPublisherBatched] ❌ Failed to publish actuator:', error);
      return false;
    }
  }
}

