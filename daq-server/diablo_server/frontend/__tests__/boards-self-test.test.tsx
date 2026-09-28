import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BoardsPage from '@/app/boards/page';
import { useSensorStore } from '@/lib/store';

vi.mock('@/lib/websocket', () => ({
  getWebSocketClient: () => ({ on: () => () => {}, send: vi.fn() }),
  getApiBaseUrl: () => 'http://localhost:8081',
}));
vi.mock('@/components/dashboard/BoardLogModal', () => ({ default: () => null }));

describe('board self-test capability', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    useSensorStore.setState({ boards: {}, sensorData: {}, selfTestTs: {} });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it.each([{}, { 'SELF_TEST.BOARD_25.sensor_1': 0 }])(
    'shows N/A for environmental even with cached self-test data: %j', sensorData => {
      useSensorStore.setState({ sensorData, selfTestTs: { 25: Date.now() } });
      useSensorStore.getState().updateBoards([
        { id: 25, type: 'ENVIRONMENTAL', boardNumber: 25, ip: '127.0.0.25', expected: true, connected: true,
          lastHeartbeatMs: Date.now(), boardState: 2, engineState: 0 },
      ]);
      render(<MemoryRouter><BoardsPage /></MemoryRouter>);
      const card = within(screen.getByTestId('boards-heartbeat-card'));
      expect(card.getByText('N/A')).toBeInTheDocument();
      expect(card.queryByText('UNTESTED')).not.toBeInTheDocument();
      expect(card.queryByText('FAILED')).not.toBeInTheDocument();
      expect(card.queryByTitle(/When this board last self-tested/)).not.toBeInTheDocument();
    },
  );

  it.each([
    [{}, 'UNTESTED'],
    [{ 'SELF_TEST.BOARD_21.sensor_1': 1 }, 'ALL PASSED'],
    [{ 'SELF_TEST.BOARD_21.sensor_1': 0 }, 'FAILED'],
  ])('preserves supported-board status: %j', (sensorData, expected) => {
    useSensorStore.setState({ sensorData });
    useSensorStore.getState().updateBoards([
      { id: 21, type: 'PT', boardNumber: 1, ip: '127.0.0.21', expected: true, connected: true,
        lastHeartbeatMs: Date.now(), boardState: 2, engineState: 0 },
    ]);
    render(<MemoryRouter><BoardsPage /></MemoryRouter>);
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.queryByText('N/A')).not.toBeInTheDocument();
  });
});
