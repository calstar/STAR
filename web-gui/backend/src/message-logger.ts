/**
 * @file message-logger.ts
 * @brief Logs all WebSocket messages to Elodin DB for replay capability
 *
 * This service intercepts all messages sent to WebSocket clients and also
 * writes them to Elodin DB. This enables:
 * - Full event replay for SITL/HITL runs
 * - Post-flight analysis
 * - Debugging and troubleshooting
 */

import { ElodinClient, ElodinPacketType } from './elodin-client.js';
import { MessageType } from './shared-types.js';

/**
 * Message logger that writes WebSocket messages to Elodin DB
 */
export class MessageLogger {
  private elodin: ElodinClient;
  private enabled: boolean = false;
  private packetIdCounter: number = 0;

  // Packet IDs for different message types
  private readonly PACKET_IDS = {
    SENSOR_UPDATE: [0x50, 0x00],
    ACTUATOR_UPDATE: [0x51, 0x00],
    STATE_UPDATE: [0x52, 0x00],
    CONTROLLER_UPDATE: [0x53, 0x00],
    ERROR: [0x54, 0x00],
    CONNECTION_STATUS: [0x55, 0x00],
    CALIBRATION_STATUS: [0x56, 0x00],
    BOARD_STATUS_UPDATE: [0x57, 0x00],
    MISSION_START_TIME: [0x58, 0x00],
    NOTIFICATION: [0x59, 0x00],
  };

  constructor(elodin: ElodinClient) {
    this.elodin = elodin;
  }

  /**
   * Enable message logging to Elodin DB
   */
  enable(): void {
    this.enabled = true;
    console.log('[MessageLogger] ✅ Message logging to Elodin DB enabled');
  }

  /**
   * Disable message logging
   */
  disable(): void {
    this.enabled = false;
    console.log('[MessageLogger] 🛑 Message logging disabled');
  }

  /**
   * Log a WebSocket message to Elodin DB
   * @param message The message to log (any type)
   */
  logMessage(message: any): void {
    if (!this.enabled || !this.elodin.connected) {
      return;
    }

    try {
      // Determine packet ID based on message type
      let packetId: [number, number] = [0x5f, 0x00]; // Default: unknown message type

      switch (message.type) {
        case MessageType.SENSOR_UPDATE:
          packetId = this.PACKET_IDS.SENSOR_UPDATE as [number, number];
          break;
        case MessageType.ACTUATOR_UPDATE:
          packetId = this.PACKET_IDS.ACTUATOR_UPDATE as [number, number];
          break;
        case MessageType.STATE_UPDATE:
          packetId = this.PACKET_IDS.STATE_UPDATE as [number, number];
          break;
        case MessageType.CONTROLLER_UPDATE:
          packetId = this.PACKET_IDS.CONTROLLER_UPDATE as [number, number];
          break;
        case MessageType.ERROR:
          packetId = this.PACKET_IDS.ERROR as [number, number];
          break;
        case MessageType.CONNECTION_STATUS:
          packetId = this.PACKET_IDS.CONNECTION_STATUS as [number, number];
          break;
        case MessageType.CALIBRATION_STATUS:
          packetId = this.PACKET_IDS.CALIBRATION_STATUS as [number, number];
          break;
        case MessageType.BOARD_STATUS_UPDATE:
          packetId = this.PACKET_IDS.BOARD_STATUS_UPDATE as [number, number];
          break;
        case MessageType.MISSION_START_TIME:
          packetId = this.PACKET_IDS.MISSION_START_TIME as [number, number];
          break;
        case MessageType.NOTIFICATION:
          packetId = this.PACKET_IDS.NOTIFICATION as [number, number];
          break;
        default:
          return; // Ignore uncharted message types
      }

      // Serialize message to JSON
      const payload = Buffer.from(JSON.stringify(message), 'utf-8');

      // Write to Elodin DB as a TABLE packet
      // Note: This uses a simple JSON encoding. For production, you might want
      // to use a more structured format matching the Elodin VTable schema.
      this.elodin.sendRawMessage(packetId, ElodinPacketType.TABLE, payload);
    } catch (error) {
      // Don't throw - logging failures shouldn't break the system
      console.error('[MessageLogger] ❌ Failed to log message to Elodin DB:', error);
    }
  }

  /**
   * Log a sensor update specifically
   */
  logSensorUpdate(update: any): void {
    this.logMessage({
      type: MessageType.SENSOR_UPDATE,
      timestamp: Date.now(),
      payload: update,
    });
  }

  /**
   * Log a controller update specifically
   */
  logControllerUpdate(update: any): void {
    this.logMessage({
      type: MessageType.CONTROLLER_UPDATE,
      timestamp: Date.now(),
      payload: update,
    });
  }

  /**
   * Log a state update specifically
   */
  logStateUpdate(update: any): void {
    this.logMessage({
      type: MessageType.STATE_UPDATE,
      timestamp: Date.now(),
      payload: update,
    });
  }
}
