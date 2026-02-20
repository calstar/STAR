/**
 * Demo Mode - Generate fake sensor data for testing GUI without hardware
 * Enable with DEMO_MODE=true environment variable
 */

import { SensorUpdate } from '../../shared/types.js';

export class DemoModeGenerator {
  private enabled: boolean;
  private interval: NodeJS.Timeout | null = null;
  private startTime: number = Date.now();
  private baseValues: Map<number, number> = new Map();
  private noiseAmplitude: number = 50; // ADC noise amplitude

  constructor() {
    this.enabled = process.env.DEMO_MODE === 'true';
    if (this.enabled) {
      console.log('🎭 DEMO MODE ENABLED - Generating fake sensor data');
      this.initializeBaseValues();
    }
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

    this.interval = setInterval(() => {
      // Generate data for all PT channels
      for (let ch = 1; ch <= 10; ch++) {
        // Raw ADC
        const rawUpdate = this.generateSensorData(ch, 'raw_adc_counts');
        if (rawUpdate) callback(rawUpdate);

        // Calibrated PSI
        const calUpdate = this.generateSensorData(ch, 'pressure_psi');
        if (calUpdate) callback(calUpdate);
      }

      // Generate actuator data
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
  }
}

