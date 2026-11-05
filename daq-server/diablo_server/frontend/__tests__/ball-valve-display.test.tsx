/**
 * A ball valve on the main panel: in place of an actuator's current it shows where the ball is,
 * read against the command — % OPEN while commanded open, % CLOSED while commanded closed. Its data
 * lives under BV* entities (its own Elodin namespace), reached through the role's ACT.* aliases.
 */
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAliasesFromConfig, useSensorStore } from '@/lib/store';
import { ActuatorState } from '@/lib/types';
import { formatBallValvePosition, BALL_VALVE_STATUS_NO_SIGNAL } from '@/lib/ball-valve';
import { waitForSensorFlush } from './waitForSensorFlush';

vi.mock('@/lib/websocket', () => ({
  getWebSocketClient: () => ({ on: () => () => {}, send: vi.fn(), sendCommand: vi.fn() }),
  getApiBaseUrl: () => 'http://localhost:8081',
}));
vi.mock('@/lib/control-mode', () => ({ useControlMode: () => ({ controlEnabled: false }) }));

const CONFIG = {
  boards: {
    act_11: { type: 'ACTUATOR', board_id: 11, enabled: true, active_connectors: [1] },
    ball_valve_board: { type: 'BALL_VALVE', board_id: 71, enabled: true, active_connectors: [1] },
  },
  actuator_roles: {
    'Main Ball Valve': ['NC', 1, 71],
    'Fuel Main': ['NC', 1, 11],
  },
};

describe('formatBallValvePosition', () => {
  it('reads % open while commanded open, and with no command yet', () => {
    expect(formatBallValvePosition(40, 1, ActuatorState.OPEN)).toBe('40% OPEN');
    expect(formatBallValvePosition(40, 1, null)).toBe('40% OPEN');
  });
  it('reads % closed while commanded closed', () => {
    expect(formatBallValvePosition(40, 1, ActuatorState.CLOSED)).toBe('60% CLOSED');
    expect(formatBallValvePosition(0, 1, ActuatorState.CLOSED)).toBe('100% CLOSED');
  });
  it('says NO SIGNAL on a dead loop and --- with no data', () => {
    expect(formatBallValvePosition(0, BALL_VALVE_STATUS_NO_SIGNAL, ActuatorState.CLOSED)).toBe('NO SIGNAL');
    expect(formatBallValvePosition(null, null, ActuatorState.OPEN)).toBe('--- %');
  });
});

describe('ball valve tile on the main panel', () => {
  beforeEach(() => buildAliasesFromConfig(CONFIG));
  afterEach(() => cleanup());

  const push = async (entity: string, component: string, value: number) => {
    act(() => {
      useSensorStore.getState().updateSensor({ entity, component, value, timestamp: Date.now() });
    });
    await act(async () => { await waitForSensorFlush(); });
  };

  it('shows % OPEN / % CLOSED from BV entities, following the command', async () => {
    const { default: ActuatorControlByName } = await import('@/components/controls/ActuatorControlByName');
    render(<ActuatorControlByName name="Main Ball Valve" channel={1} entity="ACT.Main_Ball_Valve" boardId={71} ballValve />);

    await push('BV1_Cal.CH1', 'position_pct', 40);
    await push('BV1_Cal.CH1', 'cal_status', 1);
    await push('BV_CMD.B1.CH1', 'actuator_state_commanded', 1);
    expect(screen.getByTestId('actuator-reading:Main Ball Valve')).toHaveTextContent('40% OPEN');

    await push('BV_CMD.B1.CH1', 'actuator_state_commanded', 0);
    expect(screen.getByTestId('actuator-reading:Main Ball Valve')).toHaveTextContent('60% CLOSED');
  });

  it('an actuator tile still shows its current', async () => {
    const { default: ActuatorControlByName } = await import('@/components/controls/ActuatorControlByName');
    render(<ActuatorControlByName name="Fuel Main" channel={1} entity="ACT.Fuel_Main" boardId={11} />);
    await push('ACT1_Cal.CH1', 'current_a', 1.25);
    expect(screen.getByTestId('actuator-reading:Fuel Main')).toHaveTextContent('1.25 A');
  });

  it('maps the role to BV entities, not to actuator board 11 on the same slot', async () => {
    await push('BV1_Cal.CH1', 'position_pct', 77);
    await push('ACT1_Cal.CH1', 'position_pct', 5);  // must not be what the ball valve reads
    expect(useSensorStore.getState().getSensorValue('ACT_Cal.Main_Ball_Valve', 'position_pct')).toBe(77);
  });
});
