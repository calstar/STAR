import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
import { useSensorStore } from '@/lib/store';
import { SystemState } from '@/lib/types';
import * as websocketModule from '@/lib/websocket';
import React from 'react';

vi.mock('@/lib/control-mode', () => ({
    useControlMode: () => ({ controlEnabled: true })
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

vi.mock('uplot', () => {
    const mockUPlot = vi.fn().mockImplementation(function (this: any) {
        this.setData = vi.fn();
        this.setSize = vi.fn();
        this.destroy = vi.fn();
        this.setScale = vi.fn();
    });
    return { default: mockUPlot, __esModule: true };
});

describe('StateMachineDiagram', () => {
    let mockSendCommand = vi.fn();

    // The backend is the only source of the transition graph now. There used to be a hardcoded
    // STATIC_TRANSITIONS fallback in the component, and this suite leaned on it — it subscribed
    // but never delivered a payload, so the graph the test exercised was the compiled enum's, not
    // one any rig actually runs. Deliver the graph the way the real backend does.
    const BACKEND_TRANSITIONS = [
        { from: SystemState.IDLE, to: SystemState.ARMED },
        { from: SystemState.ARMED, to: SystemState.IDLE },
    ];
    let mockOn = vi.fn((event: string, handler: (payload: unknown) => void) => {
        if (event === 'state_transitions') handler({ transitions: BACKEND_TRANSITIONS });
        return vi.fn(); // unsub
    });

    beforeEach(() => {
        vi.clearAllMocks();

        // Setup WebSocket mock
        const mockWs = {
            connect: vi.fn(),
            isConnected: vi.fn(() => true),
            on: mockOn,
            onConnectionStatus: vi.fn(() => vi.fn()),
            sendCommand: mockSendCommand,
            send: vi.fn(),
        };

        vi.spyOn(websocketModule, 'getWebSocketClient').mockReturnValue(mockWs as any);

        // Reset store
        useSensorStore.setState({
            currentState: SystemState.IDLE,
            debugMode: false,
        });
    });

    it('should send state_transition command when a reachable state is clicked', () => {
        render(<StateMachineDiagram />);

        // IDLE can transition to ARMED
        const armedNode = screen.getByText('ARMED');
        fireEvent.click(armedNode);

        expect(mockSendCommand).toHaveBeenCalledWith({
            commandType: 'state_transition',
            data: { state: SystemState.ARMED }
        });
        // No optimistic update — state arrives via Elodin DB → STATE_UPDATE
    });

    it('should not send command if attempting an invalid transition outside debug mode', () => {
        render(<StateMachineDiagram />);

        // IDLE cannot transition directly to FIRE
        const fireNode = screen.getByText('FIRE');
        // Suppress window.alert for this test
        const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => { });

        fireEvent.click(fireNode);

        expect(mockSendCommand).not.toHaveBeenCalled();
        expect(useSensorStore.getState().currentState).toBe(SystemState.IDLE); // unchanged
        expect(alertMock).toHaveBeenCalled();

        alertMock.mockRestore();
    });

    it('should allow invalid transitions if debug mode is active', () => {
        useSensorStore.setState({ debugMode: true });
        render(<StateMachineDiagram />);

        const fireNode = screen.getByText('FIRE');
        fireEvent.click(fireNode);

        expect(mockSendCommand).toHaveBeenCalledWith({
            commandType: 'state_transition',
            data: { state: SystemState.FIRE }
        });
        // The command goes out, but the display must NOT move on its own: the sequencer is
        // authoritative and reports through _SEQUENCER_STATE. This used to assert the opposite,
        // and that optimistic update is exactly what let a refused transition look successful —
        // the rig stayed in Armed while the GUI showed the state it had refused to enter.
        expect(useSensorStore.getState().currentState).toBe(SystemState.IDLE);
    });
});
