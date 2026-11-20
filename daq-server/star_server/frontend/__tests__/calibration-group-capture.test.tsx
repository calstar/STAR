/**
 * Group capture on the Calibration page: tick several PTs, type one reference pressure, and each
 * ticked PT gets its own capture_point -- the command it would get captured alone. Unticked PTs
 * get nothing, and no session means no capture.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('@/lib/websocket', () => ({
  getWebSocketClient: () => ({ on: vi.fn(() => vi.fn()), onConnectionStatus: vi.fn(() => vi.fn()), send, sendCommand: vi.fn() }),
  getApiBaseUrl: () => 'http://localhost:8081',
}));

const pt = (id: number, role: string, boardId = 21) => ({
  type: 'PT', id, role, boardId, boardIp: '', isHpPt: false, inCalibrationSequence: true,
  entity: `PT.${role.replace(/ /g, '_')}`, calEntity: `PT_Cal.${role.replace(/ /g, '_')}`,
});
vi.mock('@/lib/sensor-config', () => ({
  useSensorConfig: () => [pt(1, 'Fuel Upstream'), pt(2, 'Ox Upstream'), pt(3, 'Dome Ctrl')],
}));

let sessionActive = true;
global.fetch = vi.fn((url: string) => {
  if (String(url).endsWith('/api/config/profiles')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessionActive }) });
  return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
}) as unknown as typeof fetch;

const captures = () => send.mock.calls
  .map((c) => c[0].payload)
  .filter((p) => p?.commandType === 'capture_point');

async function renderPage() {
  const { default: CalibrationPage } = await import('@/app/calibration/page');
  render(<CalibrationPage />);
}

describe('calibration group capture', () => {
  beforeEach(() => { send.mockClear(); sessionActive = true; });
  afterEach(() => cleanup());

  it('captures one reference pressure on every ticked PT, and only those', async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText('Include Fuel Upstream in the group capture'));
    fireEvent.click(screen.getByLabelText('Include Dome Ctrl in the group capture'));
    const panel = screen.getByTestId('group-capture');
    expect(within(panel).getByText(/Group capture · 2 PTs/)).toBeInTheDocument();

    fireEvent.change(within(panel).getByLabelText('Reference PSI for the group capture'), { target: { value: '500' } });
    const button = within(panel).getByRole('button', { name: 'Capture on 2 PTs' });
    await waitFor(() => expect(button).not.toBeDisabled()); // session state arrives by fetch
    fireEvent.click(button);

    await waitFor(() => expect(captures()).toHaveLength(2));
    expect(captures()).toEqual([
      { commandType: 'capture_point', sensorId: 1, boardId: 21, referencePressure: 500 },
      { commandType: 'capture_point', sensorId: 3, boardId: 21, referencePressure: 500 },
    ]);
    expect(screen.getByTestId('group-capture-sent')).toHaveTextContent('Sent 500 psi to 2 PTs: Fuel Upstream, Dome Ctrl');
  });

  it('All ticks every PT; Clear empties the group and the panel goes away', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText(/Group capture · 3 PTs/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('group-capture')).toBeNull();
  });

  it('ticking a PT does not open it, and clicking a row does not tick it', async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText('Include Ox Upstream in the group capture'));
    expect(screen.queryByRole('heading', { name: 'Ox Upstream' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Fuel Upstream/ }));
    expect(screen.getByRole('heading', { name: 'Fuel Upstream' })).toBeInTheDocument();
    expect(screen.getByLabelText('Include Fuel Upstream in the group capture')).not.toBeChecked();
  });

  it('with no session the group capture is disabled and sends nothing', async () => {
    sessionActive = false;
    await renderPage();
    fireEvent.click(screen.getByLabelText('Include Fuel Upstream in the group capture'));
    const panel = screen.getByTestId('group-capture');
    fireEvent.change(within(panel).getByLabelText('Reference PSI for the group capture'), { target: { value: '100' } });
    expect(within(panel).getByRole('button', { name: 'Capture on 1 PT' })).toBeDisabled();
    fireEvent.keyDown(within(panel).getByLabelText('Reference PSI for the group capture'), { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 100));
    expect(captures()).toHaveLength(0);
  });
});
