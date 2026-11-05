/**
 * The Actuator Roles editor on a ball valve board: no NO/NC select and no PWM assignment, because a
 * ball valve has neither (1 opens it on the wire). An ACTUATOR role keeps both controls.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// One client for the whole test: the page's load effect depends on it, so a fresh object per call
// would reload the config on every render.
vi.mock('@/lib/websocket', () => {
  const client = { on: () => () => {}, send: () => {}, onConnectionStatus: () => () => {} };
  return { getWebSocketClient: () => client, getApiBaseUrl: () => 'http://localhost:8081' };
});
vi.mock('@/lib/control-mode', () => ({
  useControlMode: () => ({ isOperator: true, controlEnabled: true }),
}));

const CONFIG = {
  boards: {
    act_board: { type: 'ACTUATOR', board_id: 12, enabled: true, ip: '192.0.2.12' },
    ball_valve_board: { type: 'BALL_VALVE', board_id: 71, enabled: true, ip: '192.0.2.71', active_connectors: [1] },
  },
  actuator_roles: {
    'LOX Main': ['NC', 1, 12],
    'Main Ball Valve': ['NC', 1, 71],
  },
};

describe('Actuator Roles editor — ball valve rows', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(String(url).endsWith('/api/config') ? { config: CONFIG, active: 'default' } : {}),
      text: () => Promise.resolve(''),
    })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('shows "Ball valve" instead of NO/NC and offers no PWM assignment', async () => {
    const { default: ConfigPage } = await import('@/app/config/page');
    render(<MemoryRouter initialEntries={['/config?tab=roles']}><ConfigPage /></MemoryRouter>);

    expect(await screen.findByTestId('ball-valve-kind:Main Ball Valve')).toHaveTextContent('Ball valve');
    // One NO/NC select and one PWM select: both belong to the ACTUATOR role.
    expect(screen.getAllByRole('option', { name: /Normally Open/ })).toHaveLength(1);
    expect(screen.getAllByRole('option', { name: 'Controller: fuel' })).toHaveLength(1);
    expect(screen.queryByTestId('ball-valve-kind:LOX Main')).toBeNull();
  });
});
