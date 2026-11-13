/**
 * Calibration page, Ball valves: one row per ball valve role; "Fully closed" / "Fully open" ask the
 * backend to store the live reading for that valve's channel, and a refusal is shown, not hidden.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BallValveCalPanel, ballValveRoles } from '@/components/calibration/BallValveCalPanel';

vi.mock('@/lib/websocket', () => ({ getApiBaseUrl: () => 'http://localhost:8081', getWebSocketClient: () => ({ on: () => () => {} }) }));

const CONFIG = {
  boards: {
    act_board: { type: 'ACTUATOR', board_id: 12, enabled: true },
    ball_valve_board: { type: 'BALL_VALVE', board_id: 71, enabled: true, active_connectors: [1, 2] },
  },
  actuator_roles: { 'LOX Main': ['NC', 1, 12], 'Ox Vent': ['NC', 1, 71], 'Ox Fill': ['NC', 2, 71] },
};

let posts: any[] = [];
let postReply: { status: number; body: any } = { status: 200, body: { valves: [] } };

beforeEach(() => {
  posts = [];
  postReply = { status: 200, body: { valves: [] } };
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return Promise.resolve({ ok: postReply.status < 300, status: postReply.status, json: () => Promise.resolve(postReply.body) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ valves: [
      { entity: 'BV1_Cal.CH1', endpoints: { closedCounts: 355 }, liveCounts: 356, noSignal: false },
    ] }) });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ballValveRoles', () => {
  it('lists only roles on ball valve boards, as their calibrated entity', () => {
    expect(ballValveRoles(CONFIG)).toEqual([
      { role: 'Ox Vent', entity: 'BV1_Cal.CH1' },
      { role: 'Ox Fill', entity: 'BV1_Cal.CH2' },
    ]);
  });
});

describe('BallValveCalPanel', () => {
  it('"Fully closed" stores the reading for that valve\'s channel', async () => {
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    const row = await screen.findByTestId('bv-cal:Ox Fill');
    fireEvent.click(row.querySelector('button')!);  // Fully closed
    await waitFor(() => expect(posts).toEqual([{ entity: 'BV1_Cal.CH2', action: 'closed' }]));
  });

  it('shows the stored endpoint and live reading', async () => {
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    const row = await screen.findByTestId('bv-cal:Ox Vent');
    await waitFor(() => expect(row.textContent).toMatch(/raw 356/));
    expect(row.textContent).toMatch(/closed 355/);
    expect(row.textContent).toMatch(/open ideal/);
  });

  it('a refusal is shown', async () => {
    postReply = { status: 409, body: { error: 'The position loop reads below 2 mA (no signal).' } };
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    fireEvent.click(screen.getByTestId('bv-cal:Ox Vent').querySelectorAll('button')[1]);  // Fully open
    expect(await screen.findByRole('alert')).toHaveTextContent(/below 2 mA/);
  });

  it('cannot capture without a session', () => {
    render(<BallValveCalPanel config={CONFIG} sessionActive={false} />);
    const [closed, open] = screen.getByTestId('bv-cal:Ox Vent').querySelectorAll('button');
    expect(closed).toBeDisabled();
    expect(open).toBeDisabled();
  });
});
