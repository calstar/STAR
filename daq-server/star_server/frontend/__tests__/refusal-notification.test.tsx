/**
 * A refused command reaches the notification panel.
 *
 * The gap this closes: the backend has always sent MessageType.ERROR for every rejection the
 * sequencer reports — a refused transition, an actuator command, extend-fire, a bad hold
 * duration, controls locked — and nothing on the dashboard subscribed. websocket.ts's
 * handleMessage looks up listeners by type and silently drops a payload with none, so pressing a
 * button the sequencer refused did *nothing at all*. On 2026-09-16 a state refused for "GN2 High
 * has produced no reading yet" took a journal dive to diagnose.
 *
 * GlobalStateSubscriber now feeds those into the same store the panel renders. These tests pin
 * the store contract that handler depends on, so the panel cannot drift away from it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

// The component only touches these two surfaces of the WS client; capture what it subscribes to.
const listeners = new Map<string, (p: unknown) => void>();
vi.mock('@/lib/websocket', () => ({
    getWebSocketClient: () => ({
        on: (type: string, cb: (p: unknown) => void) => {
            listeners.set(type, cb);
            return () => listeners.delete(type);
        },
        onConnectionStatus: () => () => {},
        connect: () => {},
        sendCommand: () => {},
    }),
    getApiBaseUrl: () => 'http://localhost:8081',
}));
vi.mock('@/lib/data-cache', () => ({
    startDataCache: () => {},
    getDataCache: () => ({ onHistoricalData: () => () => {} }),
}));

import { useSensorStore } from '@/lib/store';
import GlobalStateSubscriber from '@/components/dashboard/GlobalStateSubscriber';

const notifications = () => useSensorStore.getState().notifications;

beforeEach(() => {
    useSensorStore.getState().clearNotifications();
});

describe('a refused command in the notification store', () => {
    it('lands as a one-shot error', () => {
        useSensorStore.getState().updateNotification({
            category: 'error',
            message: 'State transition failed: GN2 High has no fresh calibrated reading',
            timestampMs: 1_700_000_000_000,
        });

        const list = notifications();
        expect(list).toHaveLength(1);
        expect(list[0].category).toBe('error');
        expect(list[0].message).toContain('GN2 High has no fresh calibrated reading');
    });

    it('does not mark it current — a rejected click is an event, not a condition', () => {
        // An `ongoing` entry sorts to the top and wears a "current" badge until something clears
        // it by key. A refusal has nothing to clear it, so it must never claim to be live.
        useSensorStore.getState().updateNotification({
            category: 'error',
            message: 'Actuator command failed: transition rejected',
            timestampMs: 1_700_000_000_000,
        });
        expect(notifications()[0].isCurrent).toBeFalsy();
        expect(notifications()[0].key).toBeUndefined();
    });

    it('keeps every refusal rather than collapsing repeats', () => {
        // Pressing a refused button three times is three events. One-shots carry no key, so they
        // must not dedupe the way keyed board notifications do.
        for (let i = 0; i < 3; i++) {
            useSensorStore.getState().updateNotification({
                category: 'error',
                message: 'State transition failed: transition rejected',
                timestampMs: 1_700_000_000_000 + i,
            });
        }
        expect(notifications()).toHaveLength(3);
    });

    it('shows the newest refusal first', () => {
        useSensorStore.getState().updateNotification({
            category: 'error', message: 'first', timestampMs: 1_700_000_000_000,
        });
        useSensorStore.getState().updateNotification({
            category: 'error', message: 'second', timestampMs: 1_700_000_000_001,
        });
        expect(notifications()[0].message).toBe('second');
    });

    it('sits alongside an ongoing board notification without disturbing it', () => {
        useSensorStore.getState().updateNotification({
            key: 'board_lost_3', category: 'error', message: 'Board 3 (DAQ) connection lost',
            timestampMs: 1_700_000_000_000, ongoing: true,
        });
        useSensorStore.getState().updateNotification({
            category: 'error', message: 'State transition failed: transition rejected',
            timestampMs: 1_700_000_000_001,
        });

        const list = notifications();
        expect(list).toHaveLength(2);
        // The live condition still sorts above the one-off event.
        expect(list[0].key).toBe('board_lost_3');
        expect(list[0].isCurrent).toBe(true);
    });
});

describe('GlobalStateSubscriber wiring', () => {
    it('subscribes to ERROR at all — without this the payload is dropped', () => {
        global.fetch = vi.fn(() => Promise.resolve({ ok: false })) as unknown as typeof fetch;
        render(React.createElement(GlobalStateSubscriber));
        expect(listeners.has('error')).toBe(true);
    });

    it('turns a refused command into a visible notification', () => {
        global.fetch = vi.fn(() => Promise.resolve({ ok: false })) as unknown as typeof fetch;
        render(React.createElement(GlobalStateSubscriber));

        listeners.get('error')?.({
            message: 'State transition failed: GN2 High has no fresh calibrated reading',
        });

        const list = useSensorStore.getState().notifications;
        expect(list).toHaveLength(1);
        expect(list[0].category).toBe('error');
        expect(list[0].message).toContain('GN2 High has no fresh calibrated reading');
    });

    it('ignores an ERROR with no message rather than posting a blank row', () => {
        global.fetch = vi.fn(() => Promise.resolve({ ok: false })) as unknown as typeof fetch;
        render(React.createElement(GlobalStateSubscriber));
        listeners.get('error')?.({});
        expect(useSensorStore.getState().notifications).toHaveLength(0);
    });
});
