import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SwitchesPage, { SwitchCard, switchRolesFromConfig } from '@/app/switches/page';
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
  beforeEach(() => useSensorStore.setState({ boards: {}, sensorData: {} }));
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
    await waitFor(() => expect(screen.getByText(/Not connected/)).toBeInTheDocument());
    expect(screen.getByText(/last known, 9 s old/)).toBeInTheDocument();
  });
});
