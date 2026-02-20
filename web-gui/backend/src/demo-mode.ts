/**
 * Demo Mode - Generate fake sensor data for testing GUI without hardware
 * Enable with DEMO_MODE=true environment variable
 * 
 * Sends UDP packets to port 5006 (DiabloAvionics format) so both DAQ Bridge
 * and backend can receive them via SO_REUSEPORT
 */

import * as dgram from 'dgram';
import { SensorUpdate } from '../../shared/types.js';

// DiabloAvionics packet format constants
const PACKET_TYPE_SENSOR_DATA = 3;
const PROTOCOL_VERSION = 0;
const UDP_PORT = 5006;
const UDP_HOST = '127.0.0.1'; // Send to localhost, DAQ Bridge/backend listen on 0.0.0.0:5006

export class DemoModeGenerator {
  private enabled: boolean;
  private interval: NodeJS.Timeout | null = null;
  private startTime: number = Date.now();
  private baseValues: Map<number, number> = new Map();
  private noiseAmplitude: number = 50; // ADC noise amplitude
  private udpSocket: dgram.Socket | null = null;

  constructor() {
    // Demo mode disabled - use real ethernet data
    this.enabled = false; // process.env.DEMO_MODE === 'true'; // DISABLED - using real ethernet data
    if (this.enabled) {
      console.log('🎭 DEMO MODE ENABLED - Generating fake sensor data');
      console.log(`   📡 Sending UDP packets to ${UDP_HOST}:${UDP_PORT} (DiabloAvionics format)`);
      console.log('   ✅ Both DAQ Bridge and backend will receive packets (SO_REUSEPORT)');
      this.initializeBaseValues();
      this.setupUDPSender();
    }
  }

  private setupUDPSender(): void {
    try {
      this.udpSocket = dgram.createSocket('udp4');
      console.log(`   ✅ UDP sender ready for ${UDP_HOST}:${UDP_PORT}`);
    } catch (error) {
      console.error('❌ Failed to create UDP socket for demo mode:', error);
    }
  }

  /**
   * Create DiabloAvionics SENSOR_DATA packet
   * Format: Header (6) + Body Header (2) + Chunks
   */
  private createSensorDataPacket(
    channelIds: number[],
    adcValues: number[],
    timestampMs: number
  ): Buffer {
    if (channelIds.length !== adcValues.length) {
      throw new Error('Channel IDs and ADC values must have same length');
    }

    const numChunks = 1;
    const numSensors = channelIds.length;

    // Calculate packet size
    // Header: 6 bytes
    // Body Header: 2 bytes
    // Chunk: 4 bytes (timestamp) + (5 bytes per sensor: 1 byte sensor_id + 4 bytes data)
    const packetSize = 6 + 2 + 4 + (numSensors * 5);
    const buffer = Buffer.alloc(packetSize);
    let offset = 0;

    // Packet Header (6 bytes)
    buffer.writeUInt8(PACKET_TYPE_SENSOR_DATA, offset++); // packet_type = SENSOR_DATA (3)
    buffer.writeUInt8(PROTOCOL_VERSION, offset++); // version = 0
    buffer.writeUInt32LE(timestampMs, offset); // timestamp (little-endian)
    offset += 4;

    // Body Header (2 bytes)
    buffer.writeUInt8(numChunks, offset++); // num_chunks
    buffer.writeUInt8(numSensors, offset++); // num_sensors

    // Chunk timestamp (4 bytes)
    buffer.writeUInt32LE(timestampMs, offset);
    offset += 4;

    // Sensor datapoints (5 bytes each: sensor_id + data)
    // sensor_id in packet: 1-based (1-10) matching channel IDs
    // sensor_id 0 is inactive/reserved, so we use 1-10 for channels 1-10
    for (let i = 0; i < numSensors; i++) {
      buffer.writeUInt8(channelIds[i], offset++); // sensor_id (1-based: 1-10)
      buffer.writeUInt32LE(adcValues[i], offset); // data (uint32_t, little-endian)
      offset += 4;
    }

    return buffer;
  }

  /**
   * Send UDP packet to port 5006
   */
  private sendUDPPacket(packet: Buffer): void {
    if (!this.udpSocket) {
      return;
    }

    this.udpSocket.send(packet, UDP_PORT, UDP_HOST, (err) => {
      if (err) {
        // Log occasionally to avoid spam
        if (Math.random() < 0.01) {
          console.error('❌ Failed to send demo mode UDP packet:', err);
        }
      }
    });
  }

  private initializeBaseValues(): void {
    // Initialize realistic base ADC values for each channel (simulating ~0-100 PSI range)
    // Typical ADC range: 1000000-2000000 for pressure sensors
    this.baseValues.set(1, 1500000); // Fuel Upstream
    this.baseValues.set(2, 1200000); // GSE Low
    this.baseValues.set(3, 1300000); // GSE Mid
    this.baseValues.set(4, 1400000); // Fuel Downstream
    this.baseValues.set(5, 1600000); // Ox Upstream
    this.baseValues.set(6, 1100000); // GN2 Regulated
    this.baseValues.set(7, 1500000); // Ox Downstream
    this.baseValues.set(8, 1000000); // PT_CH8
    this.baseValues.set(9, 1050000); // PT_CH9
    this.baseValues.set(10, 1000000); // PT_CH10
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Generate fake sensor data for a channel
   */
  generateSensorData(channelId: number, component: string): SensorUpdate | null {
    if (!this.enabled) return null;

    const baseValue = this.baseValues.get(channelId) || 1000000;
    const time = (Date.now() - this.startTime) / 1000; // seconds since start
    
    // Add slow sine wave variation (simulating pressure changes)
    const variation = Math.sin(time * 0.1 + channelId) * this.noiseAmplitude;
    // Add random noise
    const noise = (Math.random() - 0.5) * this.noiseAmplitude * 0.5;
    
    let value: number;
    if (component === 'raw_adc_counts') {
      value = Math.round(baseValue + variation + noise);
    } else if (component === 'pressure_psi') {
      // Simulate calibrated pressure (rough conversion: ADC / 20000 ≈ PSI)
      const adcValue = baseValue + variation + noise;
      value = adcValue / 20000;
    } else {
      return null;
    }

    // Determine entity name
    const entityMap: Record<number, string> = {
      1: 'PT_Cal.Fuel_Upstream',
      2: 'PT_Cal.GSE_Low',
      3: 'PT_Cal.GSE_Mid',
      4: 'PT_Cal.Fuel_Downstream',
      5: 'PT_Cal.Ox_Upstream',
      6: 'PT_Cal.GN2_Regulated',
      7: 'PT_Cal.Ox_Downstream',
      8: 'PT_Cal.PT_CH8',
      9: 'PT_Cal.PT_CH9',
      10: 'PT_Cal.PT_CH10',
    };

    const entity = entityMap[channelId] || `PT_Cal.PT_CH${channelId}`;
    const rawEntity = entity.replace('PT_Cal.', 'PT.');

    if (component === 'raw_adc_counts') {
      return {
        entity: rawEntity,
        component: 'raw_adc_counts',
        value,
        timestamp: Date.now(),
      };
    } else {
      return {
        entity,
        component: 'pressure_psi',
        value,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Generate fake actuator data
   */
  generateActuatorData(channelId: number): SensorUpdate | null {
    if (!this.enabled) return null;

    // Simulate actuators being mostly closed (0) or open (1) based on channel
    const isOpen = channelId % 2 === 0; // Even channels open, odd closed
    const adcValue = isOpen ? 1500000 : 500000;

    return {
      entity: `ACT.ACT_CH${channelId}`,
      component: 'raw_adc_counts',
      value: adcValue,
      timestamp: Date.now(),
    };
  }

  /**
   * Start generating demo data at specified rate (Hz)
   */
  start(callback: (update: SensorUpdate) => void, rateHz: number = 10): void {
    if (!this.enabled || this.interval) return;

    const intervalMs = 1000 / rateHz;
    console.log(`🎭 Starting demo mode data generation at ${rateHz} Hz`);
    console.log(`   📡 Sending UDP packets to ${UDP_HOST}:${UDP_PORT} (DiabloAvionics format)`);

    this.interval = setInterval(() => {
      const timestampMs = Date.now();

      // Collect all channel data for UDP packet
      const channelIds: number[] = [];
      const adcValues: number[] = [];

      // Generate data for all PT channels
      for (let ch = 1; ch <= 10; ch++) {
        // Generate raw ADC value
        const baseValue = this.baseValues.get(ch) || 1000000;
        const time = (Date.now() - this.startTime) / 1000;
        const variation = Math.sin(time * 0.1 + ch) * this.noiseAmplitude;
        const noise = (Math.random() - 0.5) * this.noiseAmplitude * 0.5;
        const adcValue = Math.round(baseValue + variation + noise);

        // Collect for UDP packet
        // sensor_id in packet is 1-based (1-10), matching channel ID
        // sensor_id 0 is inactive, so we skip it
        channelIds.push(ch); // Use 1-based channel ID as sensor_id
        adcValues.push(adcValue);

        // Also send to callback for WebSocket (backward compatibility)
        const rawUpdate = this.generateSensorData(ch, 'raw_adc_counts');
        if (rawUpdate) callback(rawUpdate);

        const calUpdate = this.generateSensorData(ch, 'pressure_psi');
        if (calUpdate) callback(calUpdate);
      }

      // Send UDP packet with all PT channels (matches DiabloAvionics format)
      // PT boards typically send all channels in one packet
      try {
        const udpPacket = this.createSensorDataPacket(channelIds, adcValues, timestampMs);
        this.sendUDPPacket(udpPacket);
      } catch (error) {
        if (Math.random() < 0.01) {
          console.error('❌ Failed to create UDP packet:', error);
        }
      }

      // Generate actuator data (send separately as actuator board)
      for (let ch = 1; ch <= 10; ch++) {
        const actUpdate = this.generateActuatorData(ch);
        if (actUpdate) callback(actUpdate);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('🎭 Demo mode stopped');
    }

    if (this.udpSocket) {
      this.udpSocket.close();
      this.udpSocket = null;
    }
  }
}

