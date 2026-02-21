/**
 * Elodin Database TCP Client
 * Connects to Elodin DB on port 2240 and handles protocol communication
 */

import { Socket } from 'net';
import { EventEmitter } from 'events';

export enum ElodinPacketType {
  MSG = 0,      // Message type (for VTableStream, VTableMsg, etc.)
  TABLE = 1,    // Data packets
  COMMAND = 2,  // Commands
  QUERY = 3,    // Queries
}

export interface ElodinPacketHeader {
  len: number;
  ty: ElodinPacketType;
  packetId: [number, number];
  requestId: number;
}

export class ElodinClient extends EventEmitter {
  private socket: Socket | null = null;
  private host: string;
  private port: number;
  private _connected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private hasReceivedData: boolean = false;
  private packetCount: number = 0;

  get connected(): boolean {
    return this._connected;
  }

  // Packet IDs for different message types
  private readonly PACKET_IDS = {
    COMMAND: [0xff, 0x01],
    PT_DATA: [0x01, 0x00],
    TC_DATA: [0x02, 0x00],
    IMU_DATA: [0x03, 0x00],
    STATE_MACHINE: [0x20, 0x00],
  };

  constructor(host: string = 'localhost', port: number = 2240) {
    super();
    this.host = host;
    this.port = port;
  }

  async connect(): Promise<boolean> {
    if (this._connected) {
      return true;
    }

    return new Promise((resolve) => {
      let connectTimeout: NodeJS.Timeout | null = null;
      try {
        console.log(`🔌 Creating socket for ${this.host}:${this.port}...`);
        this.socket = new Socket();
        this.socket.setNoDelay(true); // Disable Nagle's algorithm for low latency
        this.socket.setKeepAlive(true, 60000); // Keep connection alive

        // CRITICAL: Set up data handler BEFORE connecting
        // Elodin DB may send data immediately upon connection
        this.socket.on('data', (data: Buffer) => {
          // ALWAYS log data chunks - this is critical to see if we're receiving anything
          if (!this.hasReceivedData) {
            console.log(`📥 FIRST DATA CHUNK from Elodin DB: ${data.length} bytes`);
            console.log(`   First 64 bytes (hex): ${data.subarray(0, Math.min(64, data.length)).toString('hex')}`);
            console.log(`   First 64 bytes (ascii): ${data.subarray(0, Math.min(64, data.length)).toString('ascii').replace(/[^\x20-\x7E]/g, '.')}`);
            this.hasReceivedData = true;
          } else {
            // Log every 100th chunk to confirm continuous data flow
            if (Math.random() < 0.01) {
              console.log(`📥 Data chunk: ${data.length} bytes`);
            }
          }
          this.handleData(data);
        });

        // Don't set encoding - we need raw Buffer data, not strings

        // Add connection timeout
        connectTimeout = setTimeout(() => {
          if (!this._connected) {
            console.error(`❌ Connection timeout after 5 seconds to ${this.host}:${this.port}`);
            console.error(`   Check: Is Elodin DB running? Is the address correct?`);
            this.socket?.destroy();
            resolve(false);
          }
        }, 5000);

        this.socket.on('connect', () => {
          if (connectTimeout) {
            clearTimeout(connectTimeout);
          }
          this._connected = true;
          this.emit('connected');
          console.log(`✅ CONNECTED to Elodin DB at ${this.host}:${this.port}`);
          console.log(`   Socket local address: ${this.socket?.localAddress}:${this.socket?.localPort}`);
          console.log(`   Socket remote address: ${this.socket?.remoteAddress}:${this.socket?.remotePort}`);
          console.log(`📡 Ready to receive TABLE packets from Elodin DB`);
          resolve(true);
        });

        this.socket.on('error', (error: Error) => {
          if (connectTimeout) clearTimeout(connectTimeout);
          // Don't crash on connection errors - just log and reconnect
          const err = error as any;
          console.error('❌ Elodin socket error:', error);
          console.error(`   Error code: ${err.code}`);
          console.error(`   Error message: ${err.message}`);
          console.error(`   Error syscall: ${err.syscall}`);
          console.error(`   Error address: ${err.address}`);
          console.error(`   Error port: ${err.port}`);

          if (err.code === 'ECONNREFUSED') {
            console.warn('⚠️ Connection refused - Elodin DB may not be running or wrong address');
            console.warn(`   Trying to connect to: ${this.host}:${this.port}`);
            console.warn(`   Elodin DB should be running: elodin-db run calibration_db '[::]:2240'`);
            console.warn(`   If Elodin DB is on IPv6, try: ::1 or localhost`);
          } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
            console.error('❌ DNS/Address resolution failed');
            console.error(`   Cannot resolve: ${this.host}`);
            console.error(`   Try using: localhost or ::1 or 127.0.0.1`);
          } else if (err.code === 'ETIMEDOUT') {
            console.error('❌ Connection timeout');
            console.error(`   Elodin DB at ${this.host}:${this.port} is not responding`);
          }

          this._connected = false;
          // Don't emit error event to prevent unhandled error crashes
          // Just schedule reconnect - errors are already logged above
          resolve(false);
          this.scheduleReconnect();
        });

        this.socket.on('close', () => {
          console.log('🔌 Elodin connection closed');
          this._connected = false;
          this.emit('disconnected');
          this.scheduleReconnect();
        });

        console.log(`🔌 Attempting TCP connection to ${this.host}:${this.port}...`);
        console.log(`   Socket type: ${this.socket.constructor.name}`);

        // Try connecting - Node.js should handle IPv6 automatically
        try {
          this.socket.connect(this.port, this.host);
          console.log(`   Connection attempt initiated...`);
        } catch (connectError) {
          console.error('❌ Failed to initiate connection:', connectError);
          clearTimeout(connectTimeout);
          resolve(false);
        }
      } catch (error) {
        console.error('❌ Failed to connect to Elodin:', error);
        this._connected = false;
        this.scheduleReconnect();
        resolve(false);
      }
    });
  }

  private handleData(data: Buffer): void {
    // Append to buffer
    this.buffer = Buffer.concat([this.buffer, data]);

    // Process complete packets
    while (this.buffer.length >= 12) {
      // Read packet length (first 4 bytes)
      const packetLen = this.buffer.readUInt32LE(0);

      if (this.buffer.length < packetLen) {
        // Incomplete packet, wait for more data
        break;
      }

      // Extract complete packet
      const packet = this.buffer.subarray(0, packetLen);
      this.buffer = this.buffer.subarray(packetLen);

      // Parse packet header (12 bytes: len(4) + ty(1) + packetId(2) + padding(4) + requestId(1))
      const header: ElodinPacketHeader = {
        len: packet.readUInt32LE(0),
        ty: packet.readUInt8(4) as ElodinPacketType,
        packetId: [packet.readUInt8(5), packet.readUInt8(6)],
        requestId: packet.readUInt8(11),
      };

      // Validate header
      if (header.len < 12 || header.len > 65536) {
        console.error(`❌ Invalid packet length: ${header.len}`);
        continue;
      }

      // Extract payload (skip 12-byte header)
      const payload = packet.subarray(12);

      // ALWAYS log packets - this is critical for debugging
      const [high, low] = header.packetId;

      if (header.ty === ElodinPacketType.TABLE) {
        this.packetCount++;
        if (this.packetCount <= 5 || this.packetCount % 1000 === 0) {
          console.log(`📥 TABLE packet #${this.packetCount}: packetId=[0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}], payloadLen=${payload.length}`);
        }
        this.emit('packet', header, payload);
      } else {
        const packetTypeName = header.ty === ElodinPacketType.MSG ? 'MSG' :
                              header.ty === ElodinPacketType.COMMAND ? 'COMMAND' :
                              header.ty === ElodinPacketType.QUERY ? 'QUERY' : `UNKNOWN(${header.ty})`;
        console.log(`📨 ${packetTypeName} packet: packetId=[0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}], payloadLen=${payload.length}`);
      }
    }
  }

  private sendQueryForData(): void {
    if (!this.connected || !this.socket) {
      console.warn('⚠️ Cannot send query - not connected');
      return;
    }

    try {
      // Try sending a QUERY packet to request data streaming
      // Packet ID [0x00, 0x00] might be a "subscribe to all" query
      // This is a guess based on common protocol patterns
      const queryPacketId: [number, number] = [0x00, 0x00];
      const emptyPayload = Buffer.alloc(0);

      const header = this.createHeader(
        ElodinPacketType.QUERY,
        queryPacketId,
        emptyPayload.length
      );

      const packet = Buffer.concat([header, emptyPayload]);
      this.socket.write(packet);
      console.log(`📤 Sent QUERY packet to Elodin DB (packetId=[0x00, 0x00])`);
      console.log(`   This may trigger data streaming if Elodin DB supports it.`);
    } catch (error) {
      console.error('❌ Failed to send query:', error);
    }
  }

  /**
   * Send raw message to Elodin DB
   * Used for VTable registration and other low-level protocol messages
   */
  sendRawMessage(packetId: [number, number], packetType: ElodinPacketType, payload: Buffer): boolean {
    if (!this.connected || !this.socket) {
      if (Math.random() < 0.01) { // Log occasionally to avoid spam
        console.warn(`⚠️ Cannot send raw message - not connected (packetId=[0x${packetId[0].toString(16).padStart(2, '0')}, 0x${packetId[1].toString(16).padStart(2, '0')}])`);
      }
      return false;
    }

    try {
      const header = this.createHeader(packetType, packetId, payload.length);
      const packet = Buffer.concat([header, payload]);
      
      // Write to socket - Node.js will buffer and flush automatically
      const flushed = this.socket.write(packet);
      
      // If write buffer is full, socket.write returns false
      // In that case, we should wait for 'drain' event, but for now just log
      if (!flushed) {
        if (Math.random() < 0.01) {
          console.warn(`⚠️ Socket write buffer full for packetId=[0x${packetId[0].toString(16).padStart(2, '0')}, 0x${packetId[1].toString(16).padStart(2, '0')}]`);
        }
      }

      // Log first few messages to verify they're being sent
      if (this.packetCount < 10) {
        const [high, low] = packetId;
        const packetTypeName = packetType === ElodinPacketType.MSG ? 'MSG' :
                              packetType === ElodinPacketType.TABLE ? 'TABLE' :
                              packetType === ElodinPacketType.COMMAND ? 'COMMAND' :
                              packetType === ElodinPacketType.QUERY ? 'QUERY' : `UNKNOWN(${packetType})`;
        console.log(`📤 Sent ${packetTypeName} packet: packetId=[0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}], payloadLen=${payload.length}, totalLen=${packet.length}`);
        if (payload.length <= 16) {
          console.log(`   Payload (hex): ${payload.toString('hex')}`);
        }
      }

      // Increment packet count for logging
      this.packetCount++;

      return true;
    } catch (error) {
      console.error('❌ Failed to send raw message:', error);
      return false;
    }
  }

  /**
   * Publish a TABLE packet to Elodin DB
   * This is used to send sensor data to Elodin DB (like DAQ Bridge does)
   *
   * @param packetId Packet ID [high, low] (e.g., [0x20, 0x01] for PT Raw CH1)
   * @param payload Postcard-encoded message payload
   * @returns true if published successfully
   */
  publishTable(packetId: [number, number], payload: Buffer): boolean {
    return this.sendRawMessage(packetId, ElodinPacketType.TABLE, payload);
  }

  sendCommand(commandType: 'state_transition' | 'actuator', data: unknown): boolean {
    if (!this.connected || !this.socket) {
      return false;
    }

    try {
      const commandData = {
        type: commandType,
        data,
        timestamp: Date.now(),
      };

      const payload = JSON.stringify(commandData);
      const payloadBuffer = Buffer.from(payload, 'utf-8');

      const packetId: [number, number] = commandType === 'state_transition'
        ? [this.PACKET_IDS.STATE_MACHINE[0], this.PACKET_IDS.STATE_MACHINE[1]]
        : [this.PACKET_IDS.COMMAND[0], this.PACKET_IDS.COMMAND[1]];

      return this.sendRawMessage(packetId, ElodinPacketType.COMMAND, payloadBuffer);
    } catch (error) {
      console.error('❌ Failed to send command:', error);
      return false;
    }
  }

  private createHeader(
    packetType: ElodinPacketType,
    packetId: [number, number],
    payloadLength: number
  ): Buffer {
    const header = Buffer.alloc(12);
    header.writeUInt32LE(12 + payloadLength, 0); // Total length
    header.writeUInt8(packetType, 4);
    header.writeUInt8(packetId[0], 5);
    header.writeUInt8(packetId[1], 6);
    header.writeUInt32LE(0, 7); // Padding
    header.writeUInt8(0, 11); // Request ID
    return header;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.connected) {
        console.log('🔄 Attempting to reconnect to Elodin DB...');
        console.log(`   Make sure Elodin DB is running: elodin-db run calibration_db '[::]:2240'`);
        this.connect();
      }
    }, 5000); // Reconnect after 5 seconds
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }
}
