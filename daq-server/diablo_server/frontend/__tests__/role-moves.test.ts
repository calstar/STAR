/** Moving a role between boards (lib/role-moves) — what a drag between two board panels does. */
import { describe, expect, it } from 'vitest';
import { moveSensorRole, moveActuatorRole, freeActuatorChannel } from '@/lib/role-moves';

const SENSORS = {
  boards: {
    pt_a: { type: 'PT', board_id: 1, active_connectors: [1, 2, 3] },
    pt_b: { type: 'PT', board_id: 2, active_connectors: [1, 2] },
    tc_a: { type: 'TC', board_id: 3, active_connectors: [1] },
  },
  sensor_roles_pt_a: { 'LOX Tank': 2, 'Fuel Tank': 3 },
  sensor_roles_pt_b: { 'Chamber': 1 },
  calibration_model_pt_a: { 'LOX Tank': 'physics', 'Fuel Tank': 'cubic' },
  calibration_full_scale_pt_a: { 'LOX Tank': 1500 },
};

describe('moveSensorRole', () => {
  it('moves the role, keeping its channel when free there, and carries its calibration settings', () => {
    const r = moveSensorRole(SENSORS, 'LOX Tank', 'pt_a', 'pt_b');
    if ('error' in r) throw new Error(r.error);
    expect(r.config.sensor_roles_pt_a).toEqual({ 'Fuel Tank': 3 });
    expect(r.config.sensor_roles_pt_b).toEqual({ Chamber: 1, 'LOX Tank': 2 });
    expect(r.config.calibration_model_pt_a).toEqual({ 'Fuel Tank': 'cubic' });
    expect(r.config.calibration_model_pt_b).toEqual({ 'LOX Tank': 'physics' });
    expect(r.config.calibration_full_scale_pt_b).toEqual({ 'LOX Tank': 1500 });
    expect(r.config.calibration_full_scale_pt_a).toEqual({});
  });

  it('takes the first free active connector when its channel is not wired there', () => {
    const r = moveSensorRole(SENSORS, 'Fuel Tank', 'pt_a', 'pt_b');   // ch 3 is not on pt_b
    if ('error' in r) throw new Error(r.error);
    expect(r.config.sensor_roles_pt_b['Fuel Tank']).toBe(2);
  });

  it('refuses a board of another type, a full board, and a name already there', () => {
    expect(moveSensorRole(SENSORS, 'LOX Tank', 'pt_a', 'tc_a')).toHaveProperty('error');
    const full = { ...SENSORS, sensor_roles_pt_b: { Chamber: 1, Other: 2 } };
    expect(moveSensorRole(full, 'LOX Tank', 'pt_a', 'pt_b')).toHaveProperty('error');
    const clash = { ...SENSORS, sensor_roles_pt_b: { 'LOX Tank': 1 } };
    expect(moveSensorRole(clash, 'LOX Tank', 'pt_a', 'pt_b')).toHaveProperty('error');
  });
});

const ACTS = {
  boards: {
    act_a: { type: 'ACTUATOR', board_id: 12, num_actuators: 4 },
    act_b: { type: 'ACTUATOR', board_id: 13, num_actuators: 2 },
    bv: { type: 'BALL_VALVE', board_id: 71, active_connectors: [1, 2] },
  },
  actuator_roles: {
    'LOX Main': ['NO', 3, 12, 'pwm_ox'],
    'Fuel Main': ['NC', 1, 13],
    'Vent': ['NC', 2, 12],
    'Orphan': ['NO', 1, 99, 'pwm_fuel'],
  },
};

describe('moveActuatorRole', () => {
  it('moves the role in place, keeping polarity and PWM, and its channel when free', () => {
    const r = moveActuatorRole(ACTS, 'Vent', 13);
    if ('error' in r) throw new Error(r.error);
    expect(r.config.actuator_roles.Vent).toEqual(['NC', 2, 13]);
    expect(Object.keys(r.config.actuator_roles)).toEqual(['LOX Main', 'Fuel Main', 'Vent', 'Orphan']);
  });

  it('takes the first free channel when its own is taken or out of range', () => {
    const r = moveActuatorRole(ACTS, 'LOX Main', 13);   // ch 3 > num_actuators 2; ch 1 taken
    if ('error' in r) throw new Error(r.error);
    expect(r.config.actuator_roles['LOX Main']).toEqual(['NO', 2, 13, 'pwm_ox']);
  });

  it('refuses a full board and a board of another type', () => {
    const full = { ...ACTS, actuator_roles: { ...ACTS.actuator_roles, X: ['NC', 2, 13] } };
    expect(moveActuatorRole(full, 'LOX Main', 13)).toHaveProperty('error');
    expect(moveActuatorRole(ACTS, 'Vent', 71)).toHaveProperty('error');
  });

  it('an orphan may land on a ball valve, which drops what a ball valve cannot have', () => {
    const r = moveActuatorRole(ACTS, 'Orphan', 71);
    if ('error' in r) throw new Error(r.error);
    expect(r.config.actuator_roles.Orphan).toEqual(['NC', 1, 71]);
  });

  it('freeActuatorChannel finds the first unused channel', () => {
    expect(freeActuatorChannel(ACTS, ACTS.boards.act_a)).toBe(1);
    expect(freeActuatorChannel({ ...ACTS, actuator_roles: { a: ['NC', 1, 13], b: ['NC', 2, 13] } }, ACTS.boards.act_b)).toBeUndefined();
  });
});
