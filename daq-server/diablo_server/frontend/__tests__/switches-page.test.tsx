import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
let controlEnabled = true;
const sendCommand = vi.fn();
vi.mock('@/lib/control-mode', () => ({ useControlMode: () => ({ controlEnabled }) }));
vi.mock('@/lib/websocket', async (orig) => ({
  ...(await orig<typeof import('@/lib/websocket')>()),
  getWebSocketClient: () => ({ on: () => () => {}, send: vi.fn(), sendCommand }),
}));
import SwitchesPage, { formatMac, SwitchCard, switchRolesFromConfig } from '@/app/switches/page';
import { useSensorStore } from '@/lib/store';
import { NAV_ITEMS } from '@/lib/nav-items';

const CONFIG = {
  switch_service: { enabled: true, env_board: 'environmental_board' },
  switch_roles: {
    backup: { role: 3, name: 'Backup altimeter', mac: '58:cf:79:01:11:22' },
    main: { role: 0, name: 'Main altimeter', mac: '58:cf:79:01:3f:2a' },
  },
};

function feed(role: number, fields: Record<string, number>) {
  act(() => {
    for (const [component, value] of Object.entries(fields)) {
      useSensorStore.getState().updateSensor({ entity: `SW${role}`, component, value, timestamp: Date.now() });
    }
  });
}

describe('switches page', () => {
  beforeEach(() => {
    useSensorStore.setState({ boards: {}, sensorData: {} });
    controlEnabled = true;
    sendCommand.mockClear();
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('reads roles from config, sorted, and only while the service is on', () => {
    expect(switchRolesFromConfig(CONFIG).map((r) => r.name)).toEqual(['Main altimeter', 'Backup altimeter']);
    expect(switchRolesFromConfig({ ...CONFIG, switch_service: { enabled: false } })).toEqual([]);
    expect(switchRolesFromConfig({ switch_service: { enabled: true }, switch_roles: { x: { role: 9 } } })).toEqual([]);
  });

  it('is navigable and lists a card per configured switch', async () => {
    expect(NAV_ITEMS.find((i) => i.id === 'switches')?.path).toBe('/switches');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ config: CONFIG }) })));
    render(<SwitchesPage />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Main altimeter' })).toBeInTheDocument());
    expect(screen.getByRole('region', { name: 'Backup altimeter' })).toBeInTheDocument();
    expect(screen.getAllByText('No report from the environmental board')).toHaveLength(2);
  });

  it('shows what the switch reported, and the fault when armed but not live', async () => {
    const sw = { key: 'main', role: 0, name: 'Main altimeter', mac: '58:cf:79:01:3f:2a' };
    render(<SwitchCard sw={sw} />);
    feed(0, { link: 1, rssi: -64, age_ms: 0, status_valid: 1, output: 1, sense: 3, flags: 3,
      supply_mv: 8412, current_ma: 40, uptime_s: 120, reset_reason: 1 });
    await waitFor(() => expect(screen.getByText('ARMED')).toBeInTheDocument());
    expect(screen.getByText('Armed: output live')).toBeInTheDocument();
    expect(screen.getByText(/Connected · -64 dBm/)).toBeInTheDocument();
    expect(screen.getByText('8.41 V')).toBeInTheDocument();

    feed(0, { sense: 2 });
    await waitFor(() => expect(screen.getByText(/Armed, but no power is reaching the output/)).toBeInTheDocument());

    feed(0, { link: 0, age_ms: 9000 });
    await waitFor(() => expect(screen.getByText(/the environmental board is looking for it/)).toBeInTheDocument());
    expect(screen.getByText(/last known, 9 s old/)).toBeInTheDocument();
  });

  const SW = { key: 'main', role: 0, name: 'Main altimeter', mac: '58:cf:79:01:3f:2a' };
  const DISARMED = { link: 1, rssi: -60, age_ms: 0, status_valid: 1, output: 0, sense: 2, flags: 3,
    supply_mv: 8400, current_ma: 10, uptime_s: 5, reset_reason: 1 };

  it('arms only after a confirm, sends one absolute command, and waits for the switch', async () => {
    render(<SwitchCard sw={SW} />);
    feed(0, DISARMED);
    await waitFor(() => expect(screen.getByText('DISARMED')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Arm' }));
    expect(sendCommand).not.toHaveBeenCalled();  // the confirm step first
    fireEvent.click(screen.getByRole('button', { name: 'Arm Main altimeter' }));
    expect(sendCommand).toHaveBeenCalledTimes(1);
    const { data } = sendCommand.mock.calls[0][0];
    expect(data).toMatchObject({ switchRole: 0, switchOutput: 1 });
    expect(screen.getByText('Arming…')).toBeInTheDocument();
    expect(screen.getByText('DISARMED')).toBeInTheDocument();  // nothing optimistic

    feed(0, { cmd_id: data.switchCommandId, cmd_output: 1, cmd_result: 0 });
    expect(screen.getByText('Arming…')).toBeInTheDocument();   // written is not armed
    feed(0, { output: 1, sense: 3 });
    await waitFor(() => expect(screen.getByText('ARMED')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('Arming…')).not.toBeInTheDocument());
  });

  it('shows "not connected" when the env board refuses', async () => {
    render(<SwitchCard sw={SW} />);
    feed(0, DISARMED);
    await waitFor(() => expect(screen.getByText('DISARMED')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Disarm' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disarm Main altimeter' }));
    const { data } = sendCommand.mock.calls[0][0];
    feed(0, { cmd_id: data.switchCommandId, cmd_output: 0, cmd_result: 1 });
    await waitFor(() => expect(screen.getByText('Not sent: switch not connected.')).toBeInTheDocument());
  });

  it('cannot arm with control locked, or with the link down', async () => {
    controlEnabled = false;
    const { unmount } = render(<SwitchCard sw={SW} />);
    feed(0, DISARMED);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Arm' })).toBeDisabled());
    expect(screen.getByText(/Unlock control/)).toBeInTheDocument();
    unmount();
    controlEnabled = true;
    render(<SwitchCard sw={SW} />);
    feed(0, { ...DISARMED, link: 0 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Arm' })).toBeDisabled());
  });

  it('shows five switches, each with its own link', async () => {
    const roles = Object.fromEntries([0, 1, 2, 3, 4].map((r) => [`s${r}`, { role: r, name: `Switch ${r}`, mac: `58:cf:79:01:00:0${r}` }]));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ config: { switch_service: { enabled: true }, switch_roles: roles } }) })));
    render(<SwitchesPage />);
    await waitFor(() => expect(screen.getAllByRole('region', { name: /^Switch \d$/ })).toHaveLength(5));
    for (const r of [0, 1, 2, 4]) feed(r, { ...DISARMED });
    feed(3, { ...DISARMED, link: 0, age_ms: 6000 });
    await waitFor(() => expect(screen.getAllByText(/^Connected/)).toHaveLength(4));
    const lost = screen.getByRole('region', { name: 'Switch 3' });
    expect(lost).toHaveTextContent('the environmental board is looking for it');
    expect(screen.getByRole('region', { name: 'Switch 2' })).not.toHaveTextContent('looking for it');
  });

  it('finds unconfigured switches, without listing configured ones', async () => {
    expect(formatMac(0x58cf7901abcd)).toBe('58:cf:79:01:ab:cd');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ config: CONFIG }) })));
    render(<SwitchesPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Find switches' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Find switches' }));
    expect(sendCommand).toHaveBeenCalledWith({ commandType: 'switch_discover', data: {} });
    expect(screen.getByRole('button', { name: 'Find switches' })).toBeDisabled();
    act(() => {
      const t = Date.now();
      useSensorStore.getState().updateSensor({ entity: 'SWSEEN0', component: 'mac', value: 0x58cf7901abcd, timestamp: t });
      useSensorStore.getState().updateSensor({ entity: 'SWSEEN0', component: 'rssi', value: -80, timestamp: t });
      // a configured one (the env board would not report it; the page drops it anyway)
      useSensorStore.getState().updateSensor({ entity: 'SWSEEN1', component: 'mac', value: 0x58cf79013f2a, timestamp: t });
      useSensorStore.getState().updateSensor({ entity: 'SWSEEN1', component: 'rssi', value: -50, timestamp: t });
    });
    await waitFor(() => expect(screen.getByText('STAR-Switch-ABCD')).toBeInTheDocument());
    expect(screen.getByText('-80 dBm')).toBeInTheDocument();
    expect(screen.queryByText('58:cf:79:01:3f:2a')).not.toBeInTheDocument();
  });
});

