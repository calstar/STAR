/**
 * Calibration page, Ball valves: one row per ball valve role; "Fully closed" / "Fully open" ask the
 * backend to store the live reading for that valve's channel, and a refusal is shown, not hidden.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BallValveCalPanel, BallValveList, ballValveRoles } from '@/components/calibration/BallValveCalPanel';

vi.mock('@/lib/websocket', () => ({ getApiBaseUrl: () => 'http://localhost:8081', getWebSocketClient: () => ({ on: () => () => {} }) }));

const CONFIG = {
  boards: {
    act_board: { type: 'ACTUATOR', board_id: 12, enabled: true },
    ball_valve_board: { type: 'BALL_VALVE', board_id: 71, enabled: true, active_connectors: [1, 2] },
  },
  actuator_roles: { 'LOX Main': ['NC', 1, 12], 'Ox Vent': ['NC', 1, 71], 'Ox Fill': ['NC', 2, 71] },
};

let posts: any[] = [];
let postUrls: string[] = [];
let trialsNow: any[] = [];
const currents = () => ({
  valves: [{ entity: 'BV1_Cal.CH2', closedMa: 4.2, openMa: 19.6, updatedAtMs: 1 }],
  trials: trialsNow,
  defaults: { closedMa: 4, openMa: 20 },
  limits: { minMa: 3.8, maxMa: 20.475, minSpanMa: 1 },
});
let postReply: { status: number; body: any } = { status: 200, body: { valves: [] } };

beforeEach(() => {
  posts = [];
  postUrls = [];
  trialsNow = [];
  postReply = { status: 200, body: { valves: [] } };
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      postUrls.push(url);
      return Promise.resolve({ ok: postReply.status < 300, status: postReply.status, json: () => Promise.resolve(postReply.body) });
    }
    if (url.endsWith('/api/ball_valve_current'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(currents()) });
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

describe('BallValveList (sidebar)', () => {
  it('lists each valve and reports the clicked one, so the page opens it in the center', () => {
    const onSelect = vi.fn();
    render(<BallValveList config={CONFIG} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('bv-row:Ox Fill'));
    expect(onSelect).toHaveBeenCalledWith('BV1_Cal.CH2');
    // The controls are not in the sidebar any more.
    expect(screen.queryByTestId('bv-current:Ox Fill')).toBeNull();
  });
});

describe('BallValveCalPanel with entity (center pane)', () => {
  it('shows only the selected valve', async () => {
    render(<BallValveCalPanel config={CONFIG} entity="BV1_Cal.CH2" sessionActive />);
    await screen.findByTestId('bv-cal:Ox Fill');
    expect(screen.queryByTestId('bv-cal:Ox Vent')).toBeNull();
  });
});

describe('BallValveCalPanel', () => {
  it('Step 2: Drive closed / open runs a trial at that valve\'s saved current', async () => {
    postReply = { status: 200, body: currents() };  // the backend answers with the snapshot
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    await waitFor(() => expect(inPos('Ox Fill', 'Drive closed (4.20 mA)')).toBeEnabled());
    fireEvent.click(inPos('Ox Fill', 'Drive closed (4.20 mA)'));
    await waitFor(() => expect(posts).toEqual([{ entity: 'BV1_Cal.CH2', action: 'trial', ma: 4.2 }]));
    fireEvent.click(inPos('Ox Fill', 'Drive open (19.60 mA)'));
    await waitFor(() => expect(posts[1]).toEqual({ entity: 'BV1_Cal.CH2', action: 'trial', ma: 19.6 }));
  });

  it('Step 2: Record as 0% / 100% stores the live feedback as fully closed / open', async () => {
    postReply = { status: 200, body: { valves: [{ entity: 'BV1_Cal.CH1', endpoints: { closedCounts: 356 }, liveCounts: 356, noSignal: false }] } };
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    await waitFor(() => expect(inPos('Ox Vent', 'Record as 0%')).toBeEnabled());
    fireEvent.click(inPos('Ox Vent', 'Record as 0%'));
    await waitFor(() => expect(posts).toEqual([{ entity: 'BV1_Cal.CH1', action: 'closed' }]));
    expect(postUrls[0]).toMatch(/\/api\/ball_valve_cal$/);
    fireEvent.click(inPos('Ox Vent', 'Record as 100%'));
    await waitFor(() => expect(posts[1]).toEqual({ entity: 'BV1_Cal.CH1', action: 'open' }));
  });

  it('Step 2: nothing to record from a valve with no live feedback', async () => {
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    await waitFor(() => expect(inPos('Ox Vent', 'Record as 0%')).toBeEnabled());
    // Ox Fill has no live reading in the snapshot.
    expect(inPos('Ox Fill', 'Record as 0%')).toBeDisabled();
  });

  it('shows the live reading', async () => {
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    const row = await screen.findByTestId('bv-cal:Ox Vent');
    await waitFor(() => expect(row.textContent).toMatch(/Raw356/));
  });

  it('shows the feedback loop current in mA', async () => {
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    // 356 counts on the server's ideal 100 ohm / 3.3 V / 12-bit scale = 2.87 mA.
    await waitFor(() => expect(screen.getByTestId('bv-fb:Ox Vent').textContent).toMatch(/2\.87 mA/));
  });

  it('a recorded feedback reading is shown in mA; Clear calibration clears currents and readings', async () => {
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    const card = await screen.findByTestId('bv-position:Ox Vent');
    // 355 counts = 2.86 mA; open not recorded.
    await waitFor(() => expect(card.textContent).toMatch(/feedback 2\.86 mA.*feedback not set/));
    vi.stubGlobal('confirm', () => true);
    const header = screen.getByTestId('bv-cal:Ox Vent');
    fireEvent.click([...header.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Clear calibration')!);
    // Both: the command currents, then the recorded feedback readings.
    await waitFor(() => expect(posts).toEqual([{ entity: 'BV1_Cal.CH1', action: 'clear' }, { entity: 'BV1_Cal.CH1', action: 'clear' }]));
    expect(postUrls[0]).toMatch(/\/api\/ball_valve_current$/);
    expect(postUrls[1]).toMatch(/\/api\/ball_valve_cal$/);
    expect(screen.queryByRole('button', { name: 'Clear position cal' })).toBeNull();
  });


  it('a refusal is shown', async () => {
    postReply = { status: 400, body: { error: 'Open current must be 3.8-20.475 mA' } };
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    fireEvent.click(within('Ox Vent', 'Drive'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/3.8-20.475/);
  });
});

describe('Command current', () => {
  it('shows each valve\'s stored currents, or the ideal 4 / 20', async () => {
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    await waitFor(() => expect(screen.getByTestId('bv-current:Ox Fill').textContent).toMatch(/closed 4\.20 mA · open 19\.60 mA/));
    expect(screen.getByTestId('bv-current:Ox Vent').textContent).toMatch(/closed 4\.00 mA · open 20\.00 mA \(ideal\)/);
  });

  it('Drive sends a trial at the typed current for that valve\'s channel', async () => {
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    fireEvent.change(screen.getByLabelText('Ox Vent trial mA'), { target: { value: '19.75' } });
    fireEvent.click(within('Ox Vent', 'Drive'));
    await waitFor(() => expect(posts).toEqual([{ entity: 'BV1_Cal.CH1', action: 'trial', ma: 19.75 }]));
    expect(postUrls[0]).toMatch(/\/api\/ball_valve_current$/);
  });

  it('without a trial there is nothing to save', async () => {
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    await screen.findByTestId('bv-current:Ox Vent');
    expect(screen.queryByRole('button', { name: 'Save as open' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save as closed' })).toBeNull();
  });

  it('with a trial running: shows it, and Save as open / closed and Stop act on it', async () => {
    trialsNow = [{ entity: 'BV1_Cal.CH1', ma: 19.6, expiresAtMs: Date.now() + 60_000 }];
    postReply = { status: 200, body: currents() };  // the backend answers with the snapshot
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    await waitFor(() => expect(screen.getByTestId('bv-current:Ox Vent').textContent).toMatch(/Driving 19\.60 mA/));
    fireEvent.click(within('Ox Vent', 'Save as open'));
    await waitFor(() => expect(posts).toEqual([{ entity: 'BV1_Cal.CH1', action: 'save', as: 'open' }]));
    fireEvent.click(within('Ox Vent', 'Save as closed'));
    await waitFor(() => expect(posts[1]).toEqual({ entity: 'BV1_Cal.CH1', action: 'save', as: 'closed' }));
    fireEvent.click(within('Ox Vent', 'Stop'));
    await waitFor(() => expect(posts[2]).toEqual({ entity: 'BV1_Cal.CH1', action: 'end_trial' }));
    // Only that valve: the other has no trial and no save buttons.
    expect(screen.getByTestId('bv-current:Ox Fill').textContent).not.toMatch(/Save as/);
  });

  it('Drive works without a session: config_broadcast is always on', () => {
    render(<BallValveCalPanel config={CONFIG} sessionActive={false} />);
    expect(within('Ox Vent', 'Drive')).toBeEnabled();
  });

  it('an out-of-range trial cannot be driven and says why', () => {
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    fireEvent.change(screen.getByLabelText('Ox Vent trial mA'), { target: { value: '3' } });
    expect(within('Ox Vent', 'Drive')).toBeDisabled();
    expect(screen.getByTestId('bv-current:Ox Vent').textContent).toMatch(/Must be 3.8-20.475 mA/);
  });

  it('Reset clears a calibrated valve back to 4 / 20', async () => {
    render(<BallValveCalPanel config={CONFIG} sessionActive />);
    await waitFor(() => expect(within('Ox Fill', 'Reset')).toBeEnabled());
    fireEvent.click(within('Ox Fill', 'Reset'));
    await waitFor(() => expect(posts).toEqual([{ entity: 'BV1_Cal.CH2', action: 'clear' }]));
  });
});

/** The button named `name` in that role's command-current row. */
function within(role: string, name: string): HTMLButtonElement {
  const row = screen.getByTestId(`bv-current:${role}`);
  const b = [...row.querySelectorAll('button')].find((x) => x.textContent === name);
  if (!b) throw new Error(`no ${name} button for ${role}`);
  return b as HTMLButtonElement;
}

/** The button named `name` in that role's step-2 position card. */
function inPos(role: string, name: string): HTMLButtonElement {
  const card = screen.getByTestId(`bv-position:${role}`);
  const b = [...card.querySelectorAll('button')].find((x) => x.textContent === name);
  if (!b) throw new Error(`no ${name} button for ${role}`);
  return b as HTMLButtonElement;
}
