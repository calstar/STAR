/**
 * Enum regression tests — ensure enum values don't accidentally change.
 * These values are used in WebSocket protocols, UDP packets, and CSV parsing.
 * Changing them would silently break the data pipeline.
 */

import { describe, it, expect } from 'vitest';
import {
  SystemState,
  ActuatorState,
  MessageType,
  SensorType,
} from '@/lib/types';

describe('SystemState enum', () => {
  it('should have correct integer values for state machine', () => {
    expect(SystemState.DEBUG).toBe(0);
    expect(SystemState.IDLE).toBe(1);
    expect(SystemState.ARMED).toBe(2);
    expect(SystemState.FUEL_FILL).toBe(3);
    expect(SystemState.OX_FILL).toBe(4);
    expect(SystemState.GN2_LOW_PRESS).toBe(5);
    expect(SystemState.GN2_VENT).toBe(6);
    expect(SystemState.FUEL_PRESS).toBe(7);
    expect(SystemState.FUEL_VENT).toBe(8);
    expect(SystemState.OX_PRESS).toBe(9);
    expect(SystemState.OX_VENT).toBe(10);
    expect(SystemState.GN2_HIGH_PRESS).toBe(11);
    expect(SystemState.GN2_HIGH_VENT).toBe(12);
    expect(SystemState.VENT).toBe(13);
    expect(SystemState.CALIBRATE).toBe(14);
    expect(SystemState.READY).toBe(15);
    expect(SystemState.FIRE).toBe(16);
    expect(SystemState.ENGINE_ABORT).toBe(17);
    expect(SystemState.GSE_ABORT).toBe(18);
    expect(SystemState.EMERGENCY_ABORT).toBe(19);
    expect(SystemState.PRESS_STANDBY).toBe(20);
  });

  it('should have ABORT alias matching EMERGENCY_ABORT', () => {
    expect(SystemState.ABORT).toBe(SystemState.EMERGENCY_ABORT);
    expect(SystemState.ABORT).toBe(19);
  });
});


describe('ActuatorState enum', () => {
  it('should have correct integer values', () => {
    expect(ActuatorState.CLOSED).toBe(0);
    expect(ActuatorState.OPEN).toBe(1);
    expect(ActuatorState.UNKNOWN).toBe(2);
  });
});

describe('MessageType enum', () => {
  it('should have correct string values for WebSocket protocol', () => {
    expect(MessageType.SUBSCRIBE_SENSOR).toBe('subscribe_sensor');
    expect(MessageType.SEND_COMMAND).toBe('send_command');
    expect(MessageType.SENSOR_UPDATE).toBe('sensor_update');
    expect(MessageType.ACTUATOR_UPDATE).toBe('actuator_update');
    expect(MessageType.STATE_UPDATE).toBe('state_update');
    expect(MessageType.CONNECTION_STATUS).toBe('connection_status');
    expect(MessageType.CALIBRATION_COMMAND).toBe('calibration_command');
    expect(MessageType.CALIBRATION_STATUS).toBe('calibration_status');
    expect(MessageType.ERROR).toBe('error');
  });
});

describe('SensorType enum', () => {
  it('should have correct string prefixes', () => {
    expect(SensorType.PT_CAL).toBe('PT_Cal');
    expect(SensorType.PT_RAW).toBe('PT');
    expect(SensorType.ACT).toBe('ACT');
    expect(SensorType.TC).toBe('TC');
    expect(SensorType.RTD).toBe('RTD');
    expect(SensorType.LC).toBe('LC');
  });
});
