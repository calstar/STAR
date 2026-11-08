/**
 * The actuator card is the control: one box along the bottom says OPEN or CLOSED (--- before
 * any command is known), and a click on the card asks for the other state. With no state a
 * click closes. The box never repaints itself on click -- it follows [0x32] only.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAliasesFromConfig, useSensorStore } from '@/lib/store';
import { ActuatorState } from '@/lib/types';
import { waitForSensorFlush } from './waitForSensorFlush';

const sendCommand = vi.fn();
let controlEnabled = true;

vi.mock('@/lib/websocket', () => ({
  getWebSocketClient: () => ({ on: () => () => {}, send: vi.fn(), sendCommand }),
  getApiBaseUrl: () => 'http://localhost:8081',
}));
vi.mock('@/lib/control-mode', () => ({ useControlMode: () => ({ controlEnabled }) }));

const CONFIG = {
  boards: { act_11: { type: 'ACTUATOR', board_id: 11, enabled: true, active_connectors: [1] } },
  actuator_roles: { 'Fuel Main': ['NC', 1, 11], 'Fuel Vent': ['NO', 2, 11] },
};

const push = async (value: number) => {
  act(() => {
    useSensorStore.getState().updateSensor({
      entity: 'ACT_CMD.B1.CH1', component: 'actuator_state_commanded', value, timestamp: Date.now(),
    });
  });
  await act(async () => { await waitForSensorFlush(); });
};

const tile = (name = 'Fuel Main') => screen.getByRole('button', { name: new RegExp(`^${name}:`) });
const box = (name = 'Fuel Main') => screen.getByTestId(`actuator-state:${name}`);
const sent = () => sendCommand.mock.calls.map((c) => c[0].data.actuatorState);

describe('actuator card toggles, the box shows its state', () => {
  beforeEach(async () => {
    buildAliasesFromConfig(CONFIG);
    controlEnabled = true;
    act(() => useSensorStore.getState().setDebugMode(true));
    sendCommand.mockClear();
    const { default: ActuatorControlByName } = await import('@/components/controls/ActuatorControlByName');
    render(<ActuatorControlByName name="Fuel Main" channel={1} entity="ACT.Fuel_Main" boardId={11} />);
  });
  afterEach(() => cleanup());

  it('has no Open/Close buttons, only the card', () => {
    expect(screen.queryByText(/^open$/i)).toBeNull();
    expect(screen.queryByText(/^close$/i)).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('commanded open: the box says Open in green, and a click closes', async () => {
    await push(ActuatorState.OPEN);
    expect(tile()).toHaveAttribute('data-state', 'open');
    expect(box()).toHaveTextContent(/^Open$/);
    expect(box().className).toContain('green');
    fireEvent.click(tile());
    expect(sent()).toEqual([ActuatorState.CLOSED]);
    // No optimistic repaint: still open until the stand says otherwise.
    expect(tile()).toHaveAttribute('data-state', 'open');
    expect(box()).toHaveTextContent(/^Open$/);
  });

  it('commanded closed: the box says Closed in red, and a click opens', async () => {
    await push(ActuatorState.CLOSED);
    expect(tile()).toHaveAttribute('data-state', 'closed');
    expect(box()).toHaveTextContent(/^Closed$/);
    expect(box().className).toContain('red');
    fireEvent.click(tile());
    expect(sent()).toEqual([ActuatorState.OPEN]);
  });

  it('no state yet: the box says ---, and a click closes', async () => {
    // Channel 2 has never had a command written; the store outlives each test.
    cleanup();
    const { default: ActuatorControlByName } = await import('@/components/controls/ActuatorControlByName');
    render(<ActuatorControlByName name="Fuel Vent" channel={2} entity="ACT.Fuel_Vent" boardId={11} />);
    expect(tile('Fuel Vent')).toHaveAttribute('data-state', 'no state');
    expect(box('Fuel Vent')).toHaveTextContent(/^---$/);
    expect(box('Fuel Vent').className).not.toMatch(/green|red/);
    fireEvent.click(tile('Fuel Vent'));
    expect(sent()).toEqual([ActuatorState.CLOSED]);
  });

  it('sends nothing without control', async () => {
    cleanup();
    controlEnabled = false;
    const { default: ActuatorControlByName } = await import('@/components/controls/ActuatorControlByName');
    render(<ActuatorControlByName name="Fuel Main" channel={1} entity="ACT.Fuel_Main" boardId={11} />);
    await push(ActuatorState.CLOSED);
    expect(tile()).toBeDisabled();
    fireEvent.click(tile());
    expect(sent()).toEqual([]);
  });
});
