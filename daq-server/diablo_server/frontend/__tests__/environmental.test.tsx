import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentalPage from '@/app/environmental/page';
import { useSensorStore } from '@/lib/store';
import { NAV_ITEMS } from '@/lib/nav-items';
import { boardSlotIssue } from '../../shared/config-validation';

vi.mock('@/components/plots/TimeSeriesPlot', () => ({
  default: ({ entities, component, yLabel }: { entities: string[]; component: string; yLabel: string }) => (
    <div data-testid={`${entities[0]}.${component}`}>{yLabel}</div>
  ),
}));

describe('environmental page', () => {
  beforeEach(() => useSensorStore.setState({ boards: {}, sensorData: {} }));
  afterEach(cleanup);

  it('is navigable and explains how to enable a board', () => {
    expect(NAV_ITEMS.find((item) => item.id === 'environmental')?.path).toBe('/environmental');
    render(<EnvironmentalPage />);
    expect(screen.getByText(/No environmental boards available/)).toBeInTheDocument();
  });

  it('renders three distinct streams and updates readouts through the real store', async () => {
    useSensorStore.getState().updateBoards([
      { id: 25, type: 'ENVIRONMENTAL', boardNumber: 5, ip: '192.168.2.25', expected: true, connected: true,
        lastHeartbeatMs: Date.now(), boardState: 2, engineState: 0 },
      { id: 35, type: 'ENVIRONMENTAL', boardNumber: 5, ip: '192.168.2.35', expected: false, connected: false,
        lastHeartbeatMs: null, boardState: null, engineState: null },
    ]);
    render(<EnvironmentalPage />);
    expect(screen.getAllByText('Waiting for fresh data')).toHaveLength(3);
    expect(screen.queryByRole('region', { name: 'Environmental board 35' })).not.toBeInTheDocument();
    act(() => {
      for (const [component, value] of Object.entries({ temperature_c: -12.5, humidity_rh: 45.25, pressure_pa: 101325 })) {
        useSensorStore.getState().updateSensor({ entity: 'ENV25', component, value, timestamp: Date.now() });
      }
    });
    await waitFor(() => expect(screen.getByText('-12.5')).toBeInTheDocument());
    expect(screen.getByText('45.3')).toBeInTheDocument();
    expect(screen.getByText('101325')).toBeInTheDocument();
    expect(screen.getByTestId('ENV25.temperature_c')).toHaveTextContent('Temperature (°C)');
    expect(screen.getByTestId('ENV25.humidity_rh')).toHaveTextContent('Relative humidity (%RH)');
    expect(screen.getByTestId('ENV25.pressure_pa')).toHaveTextContent('Absolute pressure (Pa)');
  });

  it('does not apply channel-slot collision rules to full environmental board IDs', () => {
    const boards = {
      first: { type: 'ENVIRONMENTAL', board_id: 25 },
      second: { type: 'ENVIRONMENTAL', board_id: 35 },
    };
    expect(boardSlotIssue(boards, 'first')).toBeNull();
    expect(boardSlotIssue(boards, 'second')).toBeNull();
  });
});
