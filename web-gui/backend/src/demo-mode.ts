/**
 * Demo Mode - Generate fake sensor data for testing GUI without hardware
 * Enable with DEMO_MODE=true environment variable
 *
 * Generates pressure sweeps across the full operating range (0 → POP → 0)
 * so that NOP/MEOP threshold visualisation on gauge bars can be verified.
 *
 * Sends UDP packets to port 5006 (DiabloAvionics format) so both DAQ Bridge
 * and backend can receive them via SO_REUSEPORT.
 */

import * as dgram from 'dgram';
import { SensorUpdate } from '../../shared/types.js';
import { readConfig } from './routes/config.js';

// DiabloAvionics packet format constants
const PACKET_TYPE_SENSOR_DATA = 3;
const PROTOCOL_VERSION = 0;
const UDP_PORT = 5006;
const UDP_HOST = '127.0.0.1';

// ── Sweep configuration ────────────────────────────────────────────────────

/** Seconds for a full 0 → POP → 0 triangle wave sweep */
const SWEEP_PERIOD_SEC = 60;

/** Sensor → fluid-system mapping (determines which pressure_limits to use) */
interface SensorSweepDef {
  role: string;
  channelId: number;
  system: string;       // key into config.pressure_limits (GN2, ETH, LOX)
  entity: string;       // calibrated entity name, e.g. "PT_Cal.Fuel_Upstream"
  rawEntity: string;    // raw entity name, e.g. "PT.Fuel_Upstream"
  maxPsi: number;       // POP from config (sweep ceiling)
  nop: number;
  meop: number;
  phaseOffset: number;  // per-channel phase offset (radians) so they don't overlap
  isHpPt: boolean;      // true for board-2 high-pressure PT
}

export class DemoModeGenerator {
  private enabled: boolean;
  private interval: NodeJS.Timeout | null = null;
  private startTime: number = Date.now();
  private udpSocket: dgram.Socket | null = null;
  private sensors: SensorSweepDef[] = [];

  constructor() {
    this.enabled = process.env.DEMO_MODE === 'true';
    if (this.enabled) {
      console.log('🎭 DEMO MODE ENABLED - Generating pressure-sweep data');
      console.log(`   📡 Sending UDP packets to ${UDP_HOST}:${UDP_PORT} (DiabloAvionics format)`);
      this.buildSensorDefs();
      this.setupUDPSender();
    }
  }

  // ── Build sensor definitions from config.toml ─────────────────────────────

  private buildSensorDefs(): void {
    try {
      const config = readConfig();
      const pressureLimits = config.pressure_limits || {};
      const sensorRoles: Record<string, number> =
        (config.sensor_roles_pt_board || config.sensor_roles || {}) as Record<string, number>;
      const sensorRolesPt2: Record<string, number> =
        (config.sensor_roles_pt2 || {}) as Record<string, number>;

      // Default mapping: sensor role → fluid system
      const systemMap: Record<string, string> = {};
      const pressureSystemMapping = (config as any).pressure_system_mapping;
      if (pressureSystemMapping) {
        Object.assign(systemMap, pressureSystemMapping);
      } else {
        // Fallback heuristics
        for (const role of Object.keys(sensorRoles)) {
          const r = role.toLowerCase();
          if (r.includes('fuel') || r.includes('eth')) systemMap[role] = 'ETH';
          else if (r.includes('ox') || r.includes('lox')) systemMap[role] = 'LOX';
          else if (r.includes('gn2') || r.includes('gse')) systemMap[role] = 'GN2';
          else systemMap[role] = 'ETH'; // safe default
        }
        for (const role of Object.keys(sensorRolesPt2)) {
          const r = role.toLowerCase();
          if (r.includes('gn2') || r.includes('gse')) systemMap[role] = 'GN2';
          else systemMap[role] = 'GN2';
        }
      }

      let idx = 0;

      // Board 1: low-pressure PT sensors
      for (const [role, channelId] of Object.entries(sensorRoles)) {
        if (typeof channelId !== 'number') continue;
        const sys = systemMap[role] || 'ETH';
        const limits = pressureLimits[sys] || { NOP: 600, MEOP: 650, POP: 750 };
        const entityBase = role.replace(/\s+/g, '_');
        this.sensors.push({
          role,
          channelId,
          system: sys,
          entity: `PT_Cal.${entityBase}`,
          rawEntity: `PT.${entityBase}`,
          maxPsi: limits.POP || 750,
          nop: limits.NOP || 600,
          meop: limits.MEOP || 650,
          phaseOffset: (idx++ * Math.PI * 2) / 10,
          isHpPt: false,
        });
      }

      // Board 2: high-pressure PT sensors
      for (const [role, channelId] of Object.entries(sensorRolesPt2)) {
        if (typeof channelId !== 'number') continue;
        const sys = systemMap[role] || 'GN2';
        const limits = pressureLimits[sys] || { NOP: 900, MEOP: 950, POP: 1000 };
        const entityBase = role.replace(/\s+/g, '_');
        this.sensors.push({
          role,
          channelId,
          system: sys,
          entity: `PT_Cal.${entityBase}`,
          rawEntity: `PT.${entityBase}`,
          maxPsi: limits.POP || 1000,
          nop: limits.NOP || 900,
          meop: limits.MEOP || 950,
          phaseOffset: (idx++ * Math.PI * 2) / 10,
          isHpPt: true,
        });
      }

      console.log(`   🎯 ${this.sensors.length} sensors configured for sweep:`);
      for (const s of this.sensors) {
        console.log(`      ${s.role} (CH${s.channelId}) → ${s.system} [0–${s.maxPsi} PSI]`);
      }
    } catch (err) {
      console.error('❌ Demo mode: failed to load config, using fallback', err);
      // Create a minimal fallback set
      for (let ch = 1; ch <= 7; ch++) {
        this.sensors.push({
          role: `PT_CH${ch}`,
          channelId: ch,
          system: 'ETH',
          entity: `PT_Cal.PT_CH${ch}`,
          rawEntity: `PT.PT_CH${ch}`,
          maxPsi: 750,
          nop: 600,
          meop: 650,
          phaseOffset: (ch * Math.PI * 2) / 10,
          isHpPt: false,
        });
      }
    }
  }

  // ── UDP ────────────────────────────────────────────────────────────────────

  private setupUDPSender(): void {
    try {
      this.udpSocket = dgram.createSocket('udp4');
      console.log(`   ✅ UDP sender ready for ${UDP_HOST}:${UDP_PORT}`);
    } catch (error) {
      console.error('❌ Failed to create UDP socket for demo mode:', error);
    }
  }

  /**
   * Create DiabloAvionics SENSOR_DATA packet.
   * Format: Header (6) + Body Header (2) + Chunks
   */
  private createSensorDataPacket(
    channelIds: number[],
    adcValues: number[],
    timestampMs: number,
  ): Buffer {
    if (channelIds.length !== adcValues.length) {
      throw new Error('Channel IDs and ADC values must have same length');
    }

    const numSensors = channelIds.length;
    const packetSize = 6 + 2 + 4 + numSensors * 5;
    const buffer = Buffer.alloc(packetSize);
    let offset = 0;

    // Demo packets use a 32-bit millisecond timestamp just like the boards.
    // Wrap the wall-clock `Date.now()` value into the valid uint32 range.
    const ts32 = (timestampMs >>> 0);

    // Packet Header (6 bytes)
    buffer.writeUInt8(PACKET_TYPE_SENSOR_DATA, offset++);
    buffer.writeUInt8(PROTOCOL_VERSION, offset++);
    buffer.writeUInt32LE(ts32, offset);
    offset += 4;

    // Body Header (2 bytes)
    buffer.writeUInt8(1, offset++);           // num_chunks
    buffer.writeUInt8(numSensors, offset++);  // num_sensors

    // Chunk timestamp (4 bytes)
    buffer.writeUInt32LE(ts32, offset);
    offset += 4;

    // Sensor datapoints (5 bytes each: sensor_id + data)
    for (let i = 0; i < numSensors; i++) {
      buffer.writeUInt8(channelIds[i], offset++);
      buffer.writeUInt32LE(adcValues[i], offset);
      offset += 4;
    }

    return buffer;
  }

  private sendUDPPacket(packet: Buffer): void {
    if (!this.udpSocket) return;
    this.udpSocket.send(packet, UDP_PORT, UDP_HOST, (err) => {
      if (err && Math.random() < 0.01) {
        console.error('❌ Failed to send demo mode UDP packet:', err);
      }
    });
  }

  // ── Sweep math ─────────────────────────────────────────────────────────────

  /**
   * Triangle wave: 0 → 1 → 0 over one period, with per-sensor phase offset.
   * Adds a small amount of noise to look realistic.
   */
  private sweepValue(sensor: SensorSweepDef, timeSec: number): number {
    const t = ((timeSec + sensor.phaseOffset * SWEEP_PERIOD_SEC / (2 * Math.PI)) % SWEEP_PERIOD_SEC) / SWEEP_PERIOD_SEC;
    // Triangle wave: 0 → 1 → 0
    const triangle = t < 0.5 ? t * 2 : 2 - t * 2;
    // Scale to 0 → maxPsi
    const basePsi = triangle * sensor.maxPsi;
    // Add ±1% noise for realism
    const noise = (Math.random() - 0.5) * sensor.maxPsi * 0.02;
    return Math.max(0, basePsi + noise);
  }

  /**
   * Rough inverse calibration: PSI → ADC counts.
   * For demo purposes, we use a simple linear approximation.
   * Low-pressure PTs: ~20000 ADC / PSI (based on original demo code)
   * High-pressure 4-20mA PTs: scaled proportionally for 0–5000 PSI range
   */
  private psiToAdc(psi: number, sensor: SensorSweepDef): number {
    if (sensor.isHpPt) {
      // For 4-20mA sensors: ADC ~ (psi / fullScale) * ADC_MAX * attenuation
      // Approximate: fraction * ~1 billion range
      const fraction = psi / (sensor.maxPsi > 0 ? sensor.maxPsi : 5000);
      return Math.round(fraction * 800000000 + 200000000); // ~200M–1B range
    }
    // Low-pressure: ADC ≈ PSI * 20000 + 500000 baseline
    return Math.round(psi * 20000 + 500000);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Generate fake sensor data for a channel (WebSocket callback path).
   */
  generateSensorData(channelId: number, component: string): SensorUpdate | null {
    if (!this.enabled) return null;

    const sensor = this.sensors.find((s) => s.channelId === channelId && !s.isHpPt);
    if (!sensor) return null;

    const timeSec = (Date.now() - this.startTime) / 1000;
    const psi = this.sweepValue(sensor, timeSec);

    if (component === 'raw_adc_counts') {
      return {
        entity: sensor.rawEntity,
        component: 'raw_adc_counts',
        value: this.psiToAdc(psi, sensor),
        timestamp: Date.now(),
      };
    } else if (component === 'pressure_psi') {
      return {
        entity: sensor.entity,
        component: 'pressure_psi',
        value: psi,
        timestamp: Date.now(),
      };
    }
    return null;
  }

  /**
   * Generate fake actuator data.
   */
  generateActuatorData(channelId: number): SensorUpdate | null {
    if (!this.enabled) return null;

    const isOpen = channelId % 2 === 0;
    const adcValue = isOpen ? 1500000 : 500000;
    return {
      entity: `ACT.ACT_CH${channelId}`,
      component: 'raw_adc_counts',
      value: adcValue,
      timestamp: Date.now(),
    };
  }

  /**
   * Start generating demo data at specified rate (Hz).
   * Sweeps every sensor through 0 → POP → 0 over SWEEP_PERIOD_SEC seconds.
   */
  start(callback: (update: SensorUpdate) => void, rateHz: number = 10): void {
    if (!this.enabled || this.interval) return;

    const intervalMs = 1000 / rateHz;
    console.log(`🎭 Starting demo mode sweep at ${rateHz} Hz (${SWEEP_PERIOD_SEC}s period)`);
    console.log(`   📡 Sending UDP packets to ${UDP_HOST}:${UDP_PORT}`);

    this.interval = setInterval(() => {
      const timestampMs = Date.now();
      const timeSec = (timestampMs - this.startTime) / 1000;

      // ── Board 1 (low-pressure) sensors via UDP ──
      const board1Sensors = this.sensors.filter((s) => !s.isHpPt);
      if (board1Sensors.length > 0) {
        const channelIds: number[] = [];
        const adcValues: number[] = [];

        for (const sensor of board1Sensors) {
          const psi = this.sweepValue(sensor, timeSec);
          const adc = this.psiToAdc(psi, sensor);

          channelIds.push(sensor.channelId);
          adcValues.push(adc);

          // Send calibrated + raw via WebSocket callback
          callback({
            entity: sensor.rawEntity,
            component: 'raw_adc_counts',
            value: adc,
            timestamp: timestampMs,
          });
          callback({
            entity: sensor.entity,
            component: 'pressure_psi',
            value: psi,
            timestamp: timestampMs,
          });
        }

        try {
          const udpPacket = this.createSensorDataPacket(channelIds, adcValues, timestampMs);
          this.sendUDPPacket(udpPacket);
        } catch (error) {
          if (Math.random() < 0.01) {
            console.error('❌ Failed to create UDP packet:', error);
          }
        }
      }

      // ── Board 2 (HP PT) sensors via WebSocket only ──
      const board2Sensors = this.sensors.filter((s) => s.isHpPt);
      for (const sensor of board2Sensors) {
        const psi = this.sweepValue(sensor, timeSec);
        callback({
          entity: sensor.entity,
          component: 'pressure_psi',
          value: psi,
          timestamp: timestampMs,
        });
        callback({
          entity: sensor.rawEntity,
          component: 'raw_adc_counts',
          value: this.psiToAdc(psi, sensor),
          timestamp: timestampMs,
        });
      }

      // ── Actuator data ──
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
