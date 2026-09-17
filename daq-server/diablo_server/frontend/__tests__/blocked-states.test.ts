/**
 * A state the sequencer will not accept is greyed, not offered.
 *
 * The sequencer has always masked refused states out of `allowedBitmask` — the C++ says so
 * explicitly, "the refusal is carried in data the GUI already receives" — and the backend decoded
 * it and dropped it on the floor. So the diagram offered every state the CSV allowed, and an
 * operator discovered a refusal only by pressing the button and watching nothing happen.
 *
 * These pin the store side of that path: the mask survives into state, and an absent mask is not
 * read as "nothing is allowed".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSensorStore } from '@/lib/store';
import { SystemState } from '@/lib/types';

const st = () => useSensorStore.getState();

beforeEach(() => {
    useSensorStore.setState({ allowedStateMask: null, stateRefusalReasons: {} });
});

describe('allowedStateMask', () => {
    it('is kept from a state update instead of discarded', () => {
        st().updateState({
            currentState: SystemState.IDLE, stateName: 'Idle', timestamp: 1,
            allowedBitmask: 0b1010,
        });
        expect(st().allowedStateMask).toBe(0b1010);
    });

    it('carries the per-state reasons alongside it', () => {
        st().updateState({
            currentState: SystemState.IDLE, stateName: 'Idle', timestamp: 1,
            allowedBitmask: 0, stateRefusalReasons: { 15: 'GN2 High has produced no reading yet' },
        });
        expect(st().stateRefusalReasons[15]).toBe('GN2 High has produced no reading yet');
    });

    it('treats a missing mask as "no opinion", not "nothing allowed"', () => {
        // A client that connects before the sequencer's first publish, or an older backend, must
        // not end up with every button greyed out.
        st().updateState({
            currentState: SystemState.IDLE, stateName: 'Idle', timestamp: 1,
            allowedBitmask: 0b0110,
        });
        st().updateState({ currentState: SystemState.IDLE, stateName: 'Idle', timestamp: 2 });
        expect(st().allowedStateMask).toBe(0b0110);
    });

    it('starts with no opinion', () => {
        expect(st().allowedStateMask).toBeNull();
    });

    it('keeps reasons when an update omits them', () => {
        st().updateState({
            currentState: SystemState.IDLE, stateName: 'Idle', timestamp: 1,
            stateRefusalReasons: { 15: 'script rejected at load' },
        });
        st().updateState({ currentState: SystemState.IDLE, stateName: 'Idle', timestamp: 2 });
        expect(st().stateRefusalReasons[15]).toBe('script rejected at load');
    });

    it('lets a state come back when the mask says so', () => {
        // The sensor gate clears on its own, so a greyed button has to un-grey without a reload.
        st().updateState({
            currentState: SystemState.IDLE, stateName: 'Idle', timestamp: 1, allowedBitmask: 0,
        });
        expect(st().allowedStateMask).toBe(0);
        st().updateState({
            currentState: SystemState.IDLE, stateName: 'Idle', timestamp: 2,
            allowedBitmask: 0xffff,
        });
        expect(st().allowedStateMask).toBe(0xffff);
    });
});
