/**
 * Smoke tests — verify that dashboard panes render without throwing.
 * These catch missing imports, undefined enum references, and broken module
 * initialisation that would otherwise surface as runtime errors in the browser.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

// ── Global mocks ─────────────────────────────────────────────────────────────

vi.mock('uplot', () => {
    const mockUPlot = vi.fn().mockImplementation(function (this: any) {
        this.setData = vi.fn();
        this.setSize = vi.fn();
        this.destroy = vi.fn();
        this.setScale = vi.fn();
    });
    return { default: mockUPlot, __esModule: true };
});

vi.mock('@/lib/websocket', () => ({
    getWebSocketClient: () => ({
        connect: vi.fn(),
        isConnected: vi.fn(() => false),
        on: vi.fn(() => vi.fn()),
        onConnectionStatus: vi.fn(() => vi.fn()),
        sendCommand: vi.fn(),
        send: vi.fn(),
    }),
    getApiBaseUrl: () => 'http://localhost:8081',
}));

vi.mock('@/lib/control-mode', () => ({
    useControlMode: () => ({ controlEnabled: false }),
}));

vi.mock('@/lib/sensor-config', () => ({
    useSensorConfig: () => [],
}));

vi.mock('@/lib/data-cache', () => ({
    startDataCache: vi.fn(),
    getDataCache: vi.fn(() => ({
        subscribe: vi.fn(() => vi.fn()),
        getHistory: vi.fn(() => []),
        onHistoricalData: vi.fn(() => vi.fn()),
        getAlignedHistory: vi.fn(() => null),
        addDataPoint: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
    })),
}));

// Suppress fetch errors — dashboards call /api/config on mount
global.fetch = vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve(null) })) as any;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Dashboard smoke tests', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Element.prototype.getBoundingClientRect = vi.fn(() => ({
            width: 800, height: 600, top: 0, left: 0, bottom: 0, right: 0, x: 0, y: 0,
            toJSON: () => { },
        }));
    });

    it('UnifiedDashboard renders without crashing', async () => {
        const { default: UnifiedDashboard } = await import('@/components/dashboard/UnifiedDashboard');
        expect(() => render(<UnifiedDashboard />)).not.toThrow();
    });

    it('IpadDashboard renders without crashing', async () => {
        const { default: IpadDashboard } = await import('@/components/dashboard/IpadDashboard');
        expect(() => render(<IpadDashboard />)).not.toThrow();
    });

    it('MobileDashboard renders without crashing', async () => {
        const { default: MobileDashboard } = await import('@/components/dashboard/MobileDashboard');
        expect(() => render(<MobileDashboard />)).not.toThrow();
    });

    it('ActuatorControlByName renders without crashing', async () => {
        const { default: ActuatorControlByName } = await import('@/components/controls/ActuatorControlByName');
        expect(() => render(
            <ActuatorControlByName name="LOX Main" channel={1} entity="ACT.LOX_Main" />
        )).not.toThrow();
    });
});
