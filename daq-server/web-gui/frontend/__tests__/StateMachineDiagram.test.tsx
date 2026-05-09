import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
import { useSensorStore } from '@/lib/store';
import { SystemState } from '@/lib/types';
import * as websocketModule from '@/lib/websocket';
import React from 'react';

// Mock the ControlMode to always be enabled
vi.mock('@/lib/control-mode', () => ({
    useControlMode: () => ({ controlEnabled: true })
}));

describe('StateMachineDiagram', () => {
    let mockSendCommand = vi.fn();
    let mockOn = vi.fn(() => vi.fn()); // returns unsub function

    beforeEach(() => {
        vi.clearAllMocks();

        // Setup WebSocket mock
        const mockWs = {
            connect: vi.fn(),
            isConnected: vi.fn(() => true),
            on: mockOn,
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

        // Store should be optimistically updated
        expect(useSensorStore.getState().currentState).toBe(SystemState.ARMED);
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
        expect(useSensorStore.getState().currentState).toBe(SystemState.FIRE);
    });
});
