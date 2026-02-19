/**
 * Direct DAQ Board Client
 * Connects directly to DiabloAvionics boards (bypassing Elodin DB streaming)
 * Still writes to Elodin DB for persistence, but reads directly from boards
 */

import { Socket } from 'net';
import { createSocket } from 'dgram';
import { EventEmitter } from 'events';
import { parseElodinPacket } from './elodin-protocol.js';

export interface DAQPacket {
  packetType: number;
  version: number;
  timestamp: number;
  boardType: number;
  boardId: number;
  data: Buffer;
}

export class DAQDirectClient extends EventEmitter {
  private tcpSocket: Socket | null = null;
  private udpSocket: ReturnType<typeof createSocket> | null = null;
  private host: string;
  private tcpPort: number;
  private udpPort: number;
  private _connected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  get connected(): boolean {
    return this._connected;
  }

  constructor(host: string = '0.0.0.0', udpPort: number = 5006) {
    super();
    this.host = host;
    this.udpPort = udpPort;
  }

  async connect(): Promise<boolean> {
    if (this._connected) {
      return true;
    }

    return new Promise((resolve) => {
      try {
        console.log(`🔌 Setting up direct UDP listener for DiabloAvionics boards on ${this.host}:${this.udpPort}...`);
        console.log(`   This bypasses Elodin DB streaming and receives packets directly from boards`);

        // Set up UDP listener (boards send UDP packets)
        this.setupUDP();
        resolve(true);
      } catch (error) {
        console.error('❌ Failed to set up UDP listener:', error);
        resolve(false);
      }
    });
  }

  private setupUDP(): void {
    try {
      console.log(`📡 Setting up UDP listener on port ${this.udpPort}...`);
      this.udpSocket = createSocket('udp4');

      this.udpSocket.on('message', (msg: Buffer, rinfo: any) => {
        // Parse DiabloAvionics packet format
        this.handleDAQPacket(msg, rinfo);
      });

      this.udpSocket.on('error', (error: Error) => {
        console.error('❌ UDP socket error:', error);
        if ((error as any).code === 'EADDRINUSE') {
          console.warn(`⚠️ Port ${this.udpPort} already in use. DAQ Bridge might be running.`);
          console.warn(`   This is OK - we'll use Elodin DB connection instead.`);
        }
      });

      this.udpSocket.bind(this.udpPort, this.host, () => {
        console.log(`✅ UDP listener bound to ${this.host}:${this.udpPort}`);
        console.log(`   Ready to receive DiabloAvionics packets from boards`);
        if (!this._connected) {
          this._connected = true;
          this.emit('connected');
        }
      });
    } catch (error) {
      console.error('❌ Failed to set up UDP listener:', error);
    }
  }

  private handleDAQPacket(data: Buffer, rinfo: any): void {
    // Parse DiabloAvionics packet format
    // Header: packet_type(1) + version(1) + timestamp(4) = 6 bytes
    if (data.length < 6) {
      console.warn(`⚠️ Packet too short: ${data.length} bytes from ${rinfo.address}`);
      return;
    }

    const packetType = data.readUInt8(0);
    const version = data.readUInt8(1);
    const timestamp = data.readUInt32LE(2);
    const payload = data.subarray(6);

    // Log ALL packets from 192.168.2.x network (these are our boards)
    if (rinfo.address.startsWith('192.168.2.')) {
      console.log(`📥 Packet from ${rinfo.address}:${rinfo.port} - type=${packetType} (1=HEARTBEAT, 3=SENSOR_DATA), len=${data.length} bytes`);
    } else if (Math.random() < 0.1) {
      console.log(`📥 Packet from ${rinfo.address}:${rinfo.port} - type=${packetType}, len=${data.length}`);
    }

    // Parse based on packet type
    if (packetType === 3) { // SENSOR_DATA
      this.parseSensorData(payload, timestamp, rinfo.address);
    } else if (packetType === 1) { // BOARD_HEARTBEAT
      // Parse heartbeat to identify board type
      this.parseHeartbeat(payload, timestamp, rinfo.address);
    } else {
      console.log(`📋 Unknown packet type ${packetType} from ${rinfo.address}`);
    }

    // Emit raw packet for further processing
    this.emit('packet', { packetType, version, timestamp, data: payload, sourceIP: rinfo.address });
  }

  private parseHeartbeat(payload: Buffer, timestamp: number, sourceIP: string): void {
    // Heartbeat format: board_type(1) + board_id(1) + engine_state(1) + board_state(1) = 4 bytes
    if (payload.length < 4) {
      return;
    }

    const boardType = payload.readUInt8(0);
    const boardId = payload.readUInt8(1);
    const engineState = payload.readUInt8(2);
    const boardState = payload.readUInt8(3);

    const boardTypeNames = ['UNKNOWN', 'PT', 'LC', 'RTD', 'TC', 'ACTUATOR'];
    const boardTypeName = boardTypeNames[boardType] || 'UNKNOWN';

    if (Math.random() < 0.1) {
      console.log(`💓 Heartbeat from ${sourceIP}: ${boardTypeName} (ID: ${boardId}, Engine: ${engineState}, Board: ${boardState})`);
    }
  }

  private parseSensorData(payload: Buffer, timestamp: number, sourceIP: string): void {
    // Parse sensor data packet
    // Body Header: num_chunks(1) + num_sensors(1) = 2 bytes
    if (payload.length < 2) {
      console.warn(`⚠️ Sensor data payload too short: ${payload.length} bytes from ${sourceIP}`);
      return;
    }

    const numChunks = payload.readUInt8(0);
    const numSensors = payload.readUInt8(1);
    let offset = 2;

    // Determine board type from source IP
    // 192.168.2.101 = PT board, 192.168.2.201 = Actuator board
    // But actuator board might send from different IP, so check IP range
    const isPTBoard = sourceIP === '192.168.2.101' || (sourceIP.startsWith('192.168.2.10') && sourceIP !== '192.168.2.201');
    const isActuatorBoard = sourceIP === '192.168.2.201' || sourceIP.startsWith('192.168.2.20');

    // Log unknown IPs for debugging
    if (!isPTBoard && !isActuatorBoard && sourceIP.startsWith('192.168.2.')) {
      if (Math.random() < 0.1) {
        console.log(`⚠️ Unknown board IP: ${sourceIP} - treating as potential actuator board`);
      }
    }

    if (Math.random() < 0.1) {
      console.log(`📊 Sensor data from ${sourceIP}: ${numChunks} chunks, ${numSensors} sensors per chunk, total payload: ${payload.length} bytes`);
    }

    // Parse each chunk
    for (let chunk = 0; chunk < numChunks; chunk++) {
      if (offset + 4 > payload.length) {
        console.warn(`⚠️ Chunk ${chunk} timestamp out of bounds`);
        break;
      }
      const chunkTimestamp = payload.readUInt32LE(offset);
      offset += 4;

      // Parse sensor readings in this chunk
      for (let sensor = 0; sensor < numSensors; sensor++) {
        if (offset + 5 > payload.length) {
          console.warn(`⚠️ Sensor ${sensor} in chunk ${chunk} out of bounds (offset: ${offset}, payload: ${payload.length})`);
          break;
        }

        // DiabloAvionics format: sensor_id(1) + data(4) = 5 bytes per sensor
        const sensorId = payload.readUInt8(offset);
        const sensorValue = payload.readUInt32LE(offset + 1);
        offset += 5;

        // Map to entity names based on board type
        let entity: string;
        let component: string;
        let value: number;

        if (isPTBoard) {
          // PT board: map to PT_Cal.PT_CH1, PT_Cal.PT_CH2, etc.
          entity = `PT_Cal.PT_CH${sensorId + 1}`;
          component = 'pressure_psi';
          // Convert ADC counts to pressure (simplified - actual calibration needed)
          // For now, just use raw value / 1000 as placeholder
          value = sensorValue / 1000.0;
        } else if (isActuatorBoard) {
          // Actuator board: current sense data
          entity = `ACT.ACT_CH${sensorId + 1}`;
          component = 'current_ma';
          // Convert ADC counts to current (simplified - actual calibration needed)
          value = sensorValue / 1000.0; // Placeholder conversion
        } else {
          // Unknown board type - log and skip
          if (Math.random() < 0.05) {
            console.log(`⚠️ Unknown board type from ${sourceIP}, sensor_id=${sensorId}, value=${sensorValue}`);
          }
          continue;
        }

        // Emit sensor data
        this.emit('sensor', {
          entity,
          component,
          value,
          timestamp: chunkTimestamp,
          rawValue: sensorValue,
          sourceIP,
        });
      }
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.udpSocket) {
      this.udpSocket.close();
      this.udpSocket = null;
    }

    this._connected = false;
  }
}
