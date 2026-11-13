import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { useSensorStore } from '@/lib/store';
import uPlot from 'uplot';
import React from 'react';

// Avoid real WebSocket (Node undici vs jsdom Event causes unhandled rejections in Vitest).
vi.mock('@/lib/websocket', () => ({
    getWebSocketClient: () => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        onConnectionStatus: vi.fn(() => vi.fn()),
    }),
}));

// Mock uPlot
vi.mock('uplot', () => {
    const mockUPlot = vi.fn().mockImplementation(function mockUPlot(this: any) {
        this.setData = vi.fn();
        this.setSize = vi.fn();
        this.destroy = vi.fn();
        this.setScale = vi.fn();
    });
    return { default: mockUPlot, __esModule: true };
});

describe('TimeSeriesPlot', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useSensorStore.setState({
            sensorData: {},
        });

        // Mock getBoundingClientRect so getDims() doesn't return null
        Element.prototype.getBoundingClientRect = vi.fn(() => ({
            width: 500,
            height: 300,
            top: 0,
            left: 0,
            bottom: 0,
            right: 0,
            x: 0,
            y: 0,
            toJSON: () => { }
        }));
    });

    it('should render without crashing and instantiate uPlot', async () => {
        render(
            <TimeSeriesPlot
                title="Test Plot"
                entities={['PT_Cal.Fuel_Upstream']}
                component="pressure_psi"
                colors={['#ff0000']}
            />
        );

        await waitFor(() => {
            expect(uPlot).toHaveBeenCalled();
        });
    });
});
