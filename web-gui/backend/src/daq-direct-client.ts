/**
 * Direct DAQ Board Client - EXACT REPLICATION OF combined_gui.py
 * Packet format matches external/DiabloAvionics/ADC_Testing/Stream_ADC_Data
 * and DAQv2-Comms (DiabloPackets.h / DiabloPacketUtils.cpp).
 */

import { createSocket, Socket } from 'dgram';
import { EventEmitter } from 'events';

// Packet format constants (matches DAQv2-Comms: PacketHeader, SensorDataPacket, SensorDataChunk, SensorDatapoint)
const PACKET_HEADER_FORMAT_SIZE = 6; // packet_type(1) + version(1) + timestamp(4 LE)
const SENSOR_DATA_PACKET_SIZE = 2; // num_chunks(1) + num_sensors(1)
const SENSOR_DATA_CHUNK_SIZE = 4; // chunk_timestamp(4 LE)
const SENSOR_DATAPOINT_SIZE = 5; // sensor_id(1) + data(4 LE)
const MAX_PACKET_SIZE = 512;

// Packet types (from combined_gui.py)
enum PacketType {
  BOARD_HEARTBEAT = 1,
  SERVER_HEARTBEAT = 2,
  SENSOR_DATA = 3,
  ACTUATOR_COMMAND = 4,
  ABORT_COMMAND = 5,
  CLEAR_ABORT = 6,
  STATE_TRANSITION = 7,
  PWM_ACTUATOR_COMMAND = 10,
}

// Board heartbeat protocol (mirrors external/DiabloAvionics/test_guis/sense_testing_gui.py)
// Header: <BBI> already handled by parsePacketHeader()
// Body:   <BBBB> = board_type, board_id (legacy board number), engine_state, board_state
// New:    we additionally treat the *board ID* as the numeric ID encoded in the heartbeat,
//         which maps to IP 192.168.2.[id] via config.toml. For now we rely on the board_id
//         field as that ID when building higher‑level status (server will map ID→config).
enum BoardState {
  SETUP = 1,
  ACTIVE = 2,
  ABORT = 3,
  ABORT_DONE = 4,
}

export interface BoardHeartbeatEvent {
  sourceIP: string;
  packetType: number;
  version: number;
  timestamp: number;
  boardType: number;
  /** Numeric board ID from heartbeat body (also used as PCB ID). */
  id: number;
  engineState: number;
  boardState: BoardState | number;
}

export class DAQDirectClient extends EventEmitter {
  private udpSocket: Socket | null = null;
  private bindAddress: string;
  private port: number;
  private _connected: boolean = false;
  private ptBoardIPs: Set<string> = new Set<string>();
  private actuatorBoardIPs: Set<string> = new Set<string>();

  get connected(): boolean {
    return this._connected;
  }

  constructor(bindAddress: string = '0.0.0.0', port: number = 5006) {
    super();
    this.bindAddress = bindAddress;
    this.port = port;
  }

  async connect(): Promise<boolean> {
    if (this._connected) {
      return true;
    }

    return new Promise((resolve) => {
      try {
        console.log(`🔌 Setting up UDP listener on ${this.bindAddress}:${this.port}`);

        this.udpSocket = createSocket({ type: 'udp4', reuseAddr: true });
        this.udpSocket.setMaxListeners(100);

        this.udpSocket.on('message', (data: Buffer, rinfo: any) => {
          if (!(this as any).hasReceivedPacket) {
            console.log(`📥 FIRST UDP PACKET received: ${data.length} bytes from ${rinfo.address}:${rinfo.port}`);
            (this as any).hasReceivedPacket = true;
          }
          this.handlePacket(data, rinfo.address);
        });

        this.udpSocket.on('error', (error: Error) => {
          const err = error as any;
          console.error(`❌ UDP socket error: ${err.code} — ${err.message}`);
          if (err.code === 'EADDRINUSE') {
            console.error('   Port 5006 is in use. Stop DAQ Bridge first: kill $(pgrep -f daq_bridge)');
          }
          this._connected = false;
          resolve(false);
        });

        this.udpSocket.bind(this.port, this.bindAddress, () => {
          console.log(`✅ UDP listener bound to ${this.bindAddress}:${this.port}`);
          console.log('   📡 Receiving DiabloAvionics packets directly from boards');
          this._connected = true;
          this.emit('connected');
          resolve(true);
        });
      } catch (error) {
        console.error('❌ Failed to set up UDP listener:', error);
        resolve(false);
      }
    });
  }

  private parsePacketHeader(data: Buffer): { packetType: number; version: number; timestamp: number } | null {
    // EXACT from combined_gui.py: <BBI> = packet_type(1) + version(1) + timestamp(4)
    if (data.length < PACKET_HEADER_FORMAT_SIZE) {
      return null;
    }

    try {
      const packetType = data.readUInt8(0);
      const version = data.readUInt8(1);
      const timestamp = data.readUInt32LE(2); // Little-endian 32-bit
      return { packetType, version, timestamp };
    } catch (error) {
      return null;
    }
  }

  private parseSensorDataPacket(data: Buffer, sourceIP?: string): { header: any; chunks: Array<{ timestamp: number; datapoints: Array<{ sensor_id: number; data: number }> }> } | null {
    // EXACT from combined_gui.py parse_sensor_data_packet()
    if (data.length < PACKET_HEADER_FORMAT_SIZE + SENSOR_DATA_PACKET_SIZE) {
      return null;
    }

    const header = this.parsePacketHeader(data);
    if (!header || header.packetType !== PacketType.SENSOR_DATA) {
      return null;
    }

    let offset = PACKET_HEADER_FORMAT_SIZE;

    // Read num_chunks and num_sensors
    const numChunks = data.readUInt8(offset);
    const numSensors = data.readUInt8(offset + 1);
    offset += SENSOR_DATA_PACKET_SIZE;

    // Throttled detailed logging for HP PT boards (configurable via hpPtBoardIPs)
    const isHpPtBoard = (this as any).hpPtBoardIPs?.has(sourceIP) ?? false;
    let shouldLog = false;
    if (isHpPtBoard) {
      if (!(this as any).hpPtPacketCount) (this as any).hpPtPacketCount = 0;
      (this as any).hpPtPacketCount++;
      shouldLog = (this as any).hpPtPacketCount <= 5 || (this as any).hpPtPacketCount % 50 === 0;

      if (shouldLog) {
        console.log(`\n🔍 HP PT Board (${sourceIP}) Packet #${(this as any).hpPtPacketCount} Analysis:`);
        console.log(`   Packet size: ${data.length} bytes`);
        console.log(`   Header: type=${header.packetType}, version=${header.version}, timestamp=${header.timestamp}`);
        console.log(`   Body header: num_chunks=${numChunks}, num_sensors=${numSensors}`);
        console.log(`   Expected size: ${PACKET_HEADER_FORMAT_SIZE} (header) + ${SENSOR_DATA_PACKET_SIZE} (body header) + ${numChunks} chunks × (${SENSOR_DATA_CHUNK_SIZE} (timestamp) + ${numSensors} sensors × ${SENSOR_DATAPOINT_SIZE} bytes)`);
        const expectedSize = PACKET_HEADER_FORMAT_SIZE + SENSOR_DATA_PACKET_SIZE + (numChunks * (SENSOR_DATA_CHUNK_SIZE + (numSensors * SENSOR_DATAPOINT_SIZE)));
        console.log(`   Expected total: ${expectedSize} bytes, Actual: ${data.length} bytes`);
        if (data.length !== expectedSize) {
          console.warn(`   ⚠️ SIZE MISMATCH! Expected ${expectedSize}, got ${data.length}`);
        }
        // Show first few bytes of body for verification
        const bodyStart = offset;
        const bodyPreview = data.subarray(bodyStart, Math.min(bodyStart + 32, data.length));
        console.log(`   Body start (hex): ${bodyPreview.toString('hex')}`);
      }
    }

    // Calculate expected size
    const perChunkSize = SENSOR_DATA_CHUNK_SIZE + (numSensors * SENSOR_DATAPOINT_SIZE);
    const expectedSize = PACKET_HEADER_FORMAT_SIZE + SENSOR_DATA_PACKET_SIZE + (numChunks * perChunkSize);

    if (data.length < expectedSize) {
      return null;
    }

    const chunks: Array<{ timestamp: number; datapoints: Array<{ sensor_id: number; data: number }> }> = [];

    // Validate num_chunks and num_sensors
    if (numChunks === 0) {
      console.warn(`⚠️ Received packet with num_chunks=0 from ${data.length} byte packet`);
      return null;
    }
    if (numSensors === 0) {
      console.warn(`⚠️ Received packet with num_sensors=0 from ${data.length} byte packet`);
      return null;
    }

    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      // Verify we have enough data for this chunk
      const remainingBytes = data.length - offset;
      const chunkDataSize = SENSOR_DATA_CHUNK_SIZE + (numSensors * SENSOR_DATAPOINT_SIZE);
      if (remainingBytes < chunkDataSize) {
        console.error(`❌ Packet truncated: need ${chunkDataSize} bytes for chunk ${chunkIdx + 1}/${numChunks}, only ${remainingBytes} bytes remaining`);
        return null;
      }

      // Read chunk timestamp
      const chunkTimestamp = data.readUInt32LE(offset);
      offset += SENSOR_DATA_CHUNK_SIZE;

      // Read datapoints
      const datapoints: Array<{ sensor_id: number; data: number }> = [];
      for (let sensorIdx = 0; sensorIdx < numSensors; sensorIdx++) {
        const sensorId = data.readUInt8(offset);
        const sensorData = data.readUInt32LE(offset + 1); // uint32_t
        offset += SENSOR_DATAPOINT_SIZE;

        datapoints.push({
          sensor_id: sensorId,
          data: sensorData, // This is uint32_t from protocol (like combined_gui.py)
        });
      }

      // Detailed logging for HP PT board chunks
      if (isHpPtBoard && shouldLog) {
        console.log(`   Chunk ${chunkIdx + 1}/${numChunks}: timestamp=${chunkTimestamp}, ${datapoints.length} datapoints`);
        console.log(`      Datapoints: ${datapoints.map(dp => `ID=${dp.sensor_id} ADC=${dp.data}`).join(', ')}`);
      }

      chunks.push({
        timestamp: chunkTimestamp,
        datapoints,
      });
    }

    return {
      header: {
        packet_type: header.packetType,
        version: header.version,
        timestamp: header.timestamp,
      },
      chunks,
    };
  }

  private parseBoardHeartbeatPacket(data: Buffer): BoardHeartbeatEvent | null {
    // Body format: <BBBB> immediately after 6‑byte header
    if (data.length < PACKET_HEADER_FORMAT_SIZE + 4) {
      return null;
    }
    const header = this.parsePacketHeader(data);
    if (!header || header.packetType !== PacketType.BOARD_HEARTBEAT) {
      return null;
    }
    try {
      const offset = PACKET_HEADER_FORMAT_SIZE;
      const boardType = data.readUInt8(offset);
      const id = data.readUInt8(offset + 1);        // board_id / PCB ID
      const engineState = data.readUInt8(offset + 2);
      const boardState = data.readUInt8(offset + 3);
      return {
        sourceIP: '', // filled in by caller
        packetType: header.packetType,
        version: header.version,
        timestamp: header.timestamp,
        boardType,
        id,
        engineState,
        boardState,
      };
    } catch {
      return null;
    }
  }

  private handlePacket(data: Buffer, sourceIP: string): void {
    // EXACT from combined_gui.py UDPReceiver.run()
    // ALWAYS log packets to see if we're receiving ANY data
    if (!(this as any).packetCount) {
      (this as any).packetCount = 0;
    }
    (this as any).packetCount++;

    // Log ALL packets initially, then reduce frequency
    if ((this as any).packetCount <= 20 || (this as any).packetCount % 100 === 0) {
      console.log(`📥 UDP packet #${(this as any).packetCount}: ${data.length} bytes from ${sourceIP}`);
      console.log(`   First 16 bytes (hex): ${data.subarray(0, Math.min(16, data.length)).toString('hex')}`);
    }

    const header = this.parsePacketHeader(data);
    if (!header) {
      if ((this as any).packetCount <= 5) {
        console.warn(`   ⚠️ Failed to parse packet header`);
      }
      return;
    }

    // Handle heartbeat to identify boards and feed higher‑level status
    if (header.packetType === PacketType.BOARD_HEARTBEAT) {
      const parsed = this.parseBoardHeartbeatPacket(data);
      if (parsed) {
        parsed.sourceIP = sourceIP;
        // Track seen board IPs for simple classification/debug
        if (parsed.boardType === 0 || parsed.boardType === 1) {
          this.ptBoardIPs.add(sourceIP);
        } else {
          this.actuatorBoardIPs.add(sourceIP);
        }
        this.emit('board_heartbeat', parsed);
      }
      return;
    }

    // Handle sensor data packets (EXACT from combined_gui.py)
    if (header.packetType === PacketType.SENSOR_DATA) {
      const result = this.parseSensorDataPacket(data, sourceIP);
      if (result) {
        const { header: headerDict, chunks } = result;

        // Log chunk information for debugging (throttled to avoid spam)
        if ((this as any).packetCount <= 10 || (this as any).packetCount % 100 === 0) {
          const totalDatapoints = chunks.reduce((sum, chunk) => sum + (chunk.datapoints?.length || 0), 0);
          console.log(`   📦 Parsed ${chunks.length} chunk(s) with ${totalDatapoints} total datapoints from ${sourceIP}`);
        }

        // Emit sensor data (EXACT format from combined_gui.py)
        // source_ip is used to filter PT board vs actuator board
        this.emit('sensor_data', headerDict, chunks, sourceIP);
      } else {
        // Log parse failures for debugging
        if ((this as any).packetCount <= 5) {
          console.warn(`   ⚠️ Failed to parse sensor data packet from ${sourceIP} (packet size: ${data.length} bytes)`);
        }
      }
    }
  }

  disconnect(): void {
    if (this.udpSocket) {
      this.udpSocket.close();
      this.udpSocket = null;
    }
    this._connected = false;
  }
}
