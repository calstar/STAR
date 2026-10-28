/**
 * Ball valve boards in the backend: their own Elodin namespace (0x33-0x35), so board 71 — slot 1,
 * the same slot as actuator board 11 — never decodes, subscribes or resolves as ACT1.*; and what
 * the position readback says to the actuator-mismatch check.
 */
import { describe, it, expect, vi } from 'vitest';

const config = {
  boards: {
    act_11: { type: 'ACTUATOR', board_id: 11, enabled: true, active_connectors: [1, 2] },
    ball_valve_board: { type: 'BALL_VALVE', board_id: 71, enabled: true, active_connectors: [1] },
  },
  actuator_roles: {
    'Main Ball Valve': ['NC', 1, 71],
    'Fuel Main': ['NC', 1, 11],
  },
};
vi.mock('../routes/config.js', () => ({ readConfig: () => config, readDeployedConfig: () => config }));

const { parseElodinPacket } = await import('../elodin-protocol.js');
const { buildVTableStreamSubscriptionList } = await import('../elodin-vtable-registry.js');
const { resolveActuatorCmdEntity, resolveActuatorTelemetryEntity } = await import('../legacy/state-actuators.js');
const {
  sensedStateFromPosition, ballValveSensedEntity, BALL_VALVE_STATUS_NO_SIGNAL,
} = await import('../ball-valve.js');

const rawPayload = (counts: number) => {
  const b = Buffer.alloc(21);
  b.writeBigUInt64LE(2_000_000_000n, 0);
  b.writeUInt8(1, 8);
  b.writeUInt32LE(counts, 12);
  return b;
};
const calPayload = (pct: number, raw: number, status: number) => {
  const b = Buffer.alloc(21);
  b.writeBigUInt64LE(2_000_000_000n, 0);
  b.writeUInt8(1, 8);
  b.writeFloatLE(pct, 12);
  b.writeUInt32LE(raw, 16);
  b.writeUInt8(status, 20);
  return b;
};
const cmdPayload = (state: number) => {
  const b = Buffer.alloc(10);
  b.writeBigUInt64LE(2_000_000_000n, 0);
  b.writeUInt8(1, 8);
  b.writeUInt8(state, 9);
  return b;
};

describe('ball valve packets', () => {
  it('decodes raw position [0x33, 0x01] as BV1.CH1', () => {
    const out = parseElodinPacket([0x33, 0x01], rawPayload(1489));
    expect(out).toEqual([expect.objectContaining({ entity: 'BV1.CH1', component: 'raw_adc_counts', value: 1489 })]);
  });

  it('decodes calibrated position [0x34, 0x11] as BV1_Cal.CH1 with % open and status', () => {
    const out = parseElodinPacket([0x34, 0x11], calPayload(50, 1489, 1));
    const by = Object.fromEntries(out.map((p) => [p.component, p]));
    expect(by.position_pct.entity).toBe('BV1_Cal.CH1');
    expect(by.position_pct.value).toBeCloseTo(50);
    expect(by.raw_adc.value).toBe(1489);
    expect(by.cal_status.value).toBe(1);
  });

  it('decodes commanded state [0x35, 0x01] as BV_CMD.B1.CH1', () => {
    expect(parseElodinPacket([0x35, 0x01], cmdPayload(1))).toEqual([
      expect.objectContaining({ entity: 'BV_CMD.B1.CH1', component: 'actuator_state_commanded', value: 1 }),
    ]);
  });

  it('never decodes a ball valve packet as an actuator entity', () => {
    const entities = [
      ...parseElodinPacket([0x33, 0x01], rawPayload(1489)),
      ...parseElodinPacket([0x34, 0x11], calPayload(50, 1489, 1)),
      ...parseElodinPacket([0x35, 0x01], cmdPayload(1)),
    ].map((p) => p.entity);
    expect(entities.some((e) => e.startsWith('ACT'))).toBe(false);
  });
});

describe('ball valve subscriptions', () => {
  const pairs = buildVTableStreamSubscriptionList(config);
  const has = (h: number, l: number) => pairs.some(([a, b]) => a === h && b === l);

  it('subscribes raw, calibrated and commanded for board 71', () => {
    expect(has(0x33, 0x01)).toBe(true);
    expect(has(0x34, 0x11)).toBe(true);
    expect(has(0x35, 0x01)).toBe(true);
  });

  it('subscribes actuator board 11 on its own bytes, and nothing of board 71 under them', () => {
    expect(has(0x30, 0x01) && has(0x30, 0x02) && has(0x32, 0x02)).toBe(true);
    // Only board 11's two channels on the actuator bytes, not a third from the ball valve.
    expect(pairs.filter(([h]) => h === 0x30)).toHaveLength(2);
  });
});

describe('ball valve role resolution', () => {
  it('resolves a ball valve role to BV entities', () => {
    expect(resolveActuatorCmdEntity('Main Ball Valve')).toBe('BV_CMD.B1.CH1');
    expect(resolveActuatorTelemetryEntity('Main Ball Valve')).toBe('BV1.CH1');
  });

  it('still resolves the actuator on the same slot to ACT entities', () => {
    expect(resolveActuatorCmdEntity('Fuel Main')).toBe('ACT_CMD.B1.CH1');
    expect(resolveActuatorTelemetryEntity('Fuel Main')).toBe('ACT1.CH1');
  });
});

describe('sensed state from position', () => {
  it('is open near full travel and closed near none', () => {
    expect(sensedStateFromPosition(100, 1)).toBe(1);
    expect(sensedStateFromPosition(96, 1)).toBe(1);
    expect(sensedStateFromPosition(0, 1)).toBe(0);
    expect(sensedStateFromPosition(4, 1)).toBe(0);
  });

  it('says nothing while the valve travels — a valve mid-stroke is not a mismatch', () => {
    expect(sensedStateFromPosition(50, 1)).toBeUndefined();
    expect(sensedStateFromPosition(90, 1)).toBeUndefined();
    expect(sensedStateFromPosition(10, 1)).toBeUndefined();
  });

  it('says nothing on a dead loop, rather than "closed"', () => {
    expect(sensedStateFromPosition(0, BALL_VALVE_STATUS_NO_SIGNAL)).toBeUndefined();
  });

  it('keys the sensed state the way role resolution does', () => {
    expect(ballValveSensedEntity('BV1_Cal.CH1')).toBe(resolveActuatorTelemetryEntity('Main Ball Valve'));
    expect(ballValveSensedEntity('ACT1_Cal.CH1')).toBeNull();
  });
});
