/**
 * The ASI tabs render with no stand attached (no sensors, no actuators) and
 * their sub-tabs switch without throwing.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('uplot', () => {
  const mockUPlot = vi.fn().mockImplementation(function (this: any) {
    this.setData = vi.fn(); this.setSize = vi.fn(); this.destroy = vi.fn(); this.setScale = vi.fn();
  });
  return { default: mockUPlot, __esModule: true };
});

vi.mock('@/lib/websocket', () => ({
  getWebSocketClient: () => ({
    connect: vi.fn(), isConnected: vi.fn(() => false), on: vi.fn(() => vi.fn()),
    onConnectionStatus: vi.fn(() => vi.fn()), sendCommand: vi.fn(), send: vi.fn(),
  }),
  getApiBaseUrl: () => 'http://localhost:8081',
}));

vi.mock('@/lib/control-mode', () => ({ useControlMode: () => ({ controlEnabled: false }) }));
vi.mock('@/lib/sensor-config', () => ({ useSensorConfig: () => [] }));

// recharts' ResponsiveContainer measures a real layout; jsdom has none.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return { ...actual, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div style={{ width: 400, height: 200 }}>{children}</div> };
});

global.fetch = vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve(null) })) as any;

import AsiTestPage from '@/app/asi/page';
import AsiTwinPage from '@/app/asi-twin/page';

describe('ASI tabs', () => {
  it('ASI Test renders without a stand and says what is unmapped', () => {
    render(<AsiTestPage />);
    expect(screen.getByText('ASI System Test')).toBeTruthy();
    expect(screen.getAllByText('Run valve not mapped').length).toBe(2);
    expect(screen.getAllByText('Vent not mapped').length).toBe(4);
    expect(screen.getByText(/No ASI PTs mapped/)).toBeTruthy();
    // Procedures switch.
    fireEvent.click(screen.getByText('2 · Leak decay'));
    expect(screen.getByText('Start hold')).toBeTruthy();
    fireEvent.click(screen.getByText('4 · Relief crack'));
    expect(screen.getByText('Mark crack now')).toBeTruthy();
  });

  it('ASI Twin renders every sub-tab', () => {
    render(<AsiTwinPage />);
    expect(screen.getByText('Operating point · current hardware')).toBeTruthy();
    fireEvent.click(screen.getByText('Twin · sequence'));
    expect(screen.getByText('Run twin')).toBeTruthy();
    fireEvent.click(screen.getByText('Twin · live'));
    expect(screen.getByText('Drive the twin from the stand')).toBeTruthy();
    fireEvent.click(screen.getByText('Model'));
    expect(screen.getByText('Reset to design point')).toBeTruthy();
  });
});
