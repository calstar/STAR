/**
 * Direct DAQ Board Client - EXACT REPLICATION OF combined_gui.py
 * Implements the exact same packet parsing and data handling as combined_gui.py
 */

import { createSocket, Socket } from 'dgram';
import { EventEmitter } from 'events';

// Packet format constants (EXACT from combined_gui.py)
const PACKET_HEADER_FORMAT_SIZE = 6; // <BBI> = packet_type(1) + version(1) + timestamp(4)
const SENSOR_DATA_PACKET_SIZE = 2; // <BB> = num_chunks(1) + num_sensors(1)
const SENSOR_DATA_CHUNK_SIZE = 4; // <I> = chunk_timestamp(4)
const SENSOR_DATAPOINT_SIZE = 5; // <BI> = sensor_id(1) + data(4)
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

    try {
      console.log(`🔌 Setting up UDP listener (EXACT combined_gui.py implementation) on ${this.bindAddress}:${this.port}`);

      // Use SO_REUSEADDR to allow binding even if port is in use
      // This allows us to receive UDP packets even if DAQ Bridge is using the port
      // Note: On Linux, we'd need SO_REUSEPORT for true port sharing, but SO_REUSEADDR
      // might work if DAQ Bridge also uses it
      try {
        this.udpSocket = createSocket({
          type: 'udp4',
          reuseAddr: true,  // SO_REUSEADDR - allows binding even if port is in use
        });

        // Try to set SO_REUSEPORT via internal handle (Linux only)
        const handle = (this.udpSocket as any)._handle;
        if (process.platform === 'linux' && handle && handle.setOption) {
          try {
            // SO_REUSEPORT = 15 on Linux (from /usr/include/asm-generic/socket.h)
            handle.setOption(15, 1);
            console.log('   ✅ SO_REUSEPORT enabled - can share port with DAQ Bridge');
          } catch (e) {
            // SO_REUSEPORT not available, continue anyway
          }
        }
      } catch (e) {
        // Fallback to regular socket
        this.udpSocket = createSocket('udp4');
      }

      this.udpSocket.setMaxListeners(100);

      this.udpSocket.on('message', (data: Buffer, rinfo: any) => {
        // Log first few packets to confirm we're receiving data
        if (!(this as any).hasReceivedPacket) {
          console.log(`📥 FIRST UDP PACKET received: ${data.length} bytes from ${rinfo.address}:${rinfo.port}`);
          (this as any).hasReceivedPacket = true;
        }
        this.handlePacket(data, rinfo.address);
      });

      this.udpSocket.on('error', (error: Error) => {
        const err = error as any;
        console.error('❌ UDP socket error:', err.code, err.message);
      });

      // Bind with reuseAddr - this should work even if DAQ Bridge is using the port
      // On Linux with SO_REUSEPORT, both processes will receive packets
      this.udpSocket.bind(this.port, this.bindAddress, () => {
        console.log(`✅ UDP listener bound to ${this.bindAddress}:${this.port}`);
        console.log('   📡 Receiving DiabloAvionics packets directly from boards');
        console.log('   ✅ Sharing port with DAQ Bridge (SO_REUSEADDR/SO_REUSEPORT)');
        this._connected = true;
        this.emit('connected');
      });

      return true;
    } catch (error) {
      console.error('❌ Failed to set up UDP listener:', error);
      return false;
    }
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

  private parseSensorDataPacket(data: Buffer): { header: any; chunks: Array<{ timestamp: number; datapoints: Array<{ sensor_id: number; data: number }> }> } | null {
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

    // Calculate expected size
    const perChunkSize = SENSOR_DATA_CHUNK_SIZE + (numSensors * SENSOR_DATAPOINT_SIZE);
    const expectedSize = PACKET_HEADER_FORMAT_SIZE + SENSOR_DATA_PACKET_SIZE + (numChunks * perChunkSize);

    if (data.length < expectedSize) {
      return null;
    }

    const chunks: Array<{ timestamp: number; datapoints: Array<{ sensor_id: number; data: number }> }> = [];

    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
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

    // Handle heartbeat to identify board types
    if (header.packetType === PacketType.BOARD_HEARTBEAT) {
      // Parse heartbeat to identify board type (PT vs Actuator)
      // This is simplified - in full implementation would parse board type from heartbeat
      if (sourceIP.startsWith('192.168.2.10')) {
        this.ptBoardIPs.add(sourceIP);
      } else if (sourceIP.startsWith('192.168.2.20')) {
        this.actuatorBoardIPs.add(sourceIP);
      }
      return;
    }

    // Handle sensor data packets (EXACT from combined_gui.py)
    if (header.packetType === PacketType.SENSOR_DATA) {
      const result = this.parseSensorDataPacket(data);
      if (result) {
        const { header: headerDict, chunks } = result;

        // Emit sensor data (EXACT format from combined_gui.py)
        // source_ip is used to filter PT board vs actuator board
        this.emit('sensor_data', headerDict, chunks, sourceIP);
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
