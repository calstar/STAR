/**
 * What an operator reads when the sequencer refuses a command.
 *
 * The sequencer answers wire-shaped: `ERR:GN2 High has no fresh calibrated reading`
 * (sequencer_main.cpp). The prefix exists so the caller can branch on it, not so a human reads it
 * in a notification — the message used to arrive as
 * "State transition failed: ERR:GN2 High has no fresh calibrated reading".
 *
 * Extracted here because the same shaping applies to transitions, actuator commands and
 * extend-fire, and each of those used to interpolate the raw reply itself.
 */
import { describe, it, expect } from 'vitest';
import { refusalText } from '../refusal-text.js';

describe('refusalText', () => {
    it('strips the wire prefix', () => {
        expect(refusalText('ERR:GN2 High has no fresh calibrated reading'))
            .toBe('GN2 High has no fresh calibrated reading');
    });

    it('keeps a reason that contains its own colon', () => {
        // Hold-duration refusals read "ERR:hold not settable here (5000 ms)"; nothing after the
        // first prefix may be eaten.
        expect(refusalText('ERR:hold exceeds max: 5000 ms')).toBe('hold exceeds max: 5000 ms');
    });

    it('leaves a reply that is not prefixed alone', () => {
        expect(refusalText('connection closed')).toBe('connection closed');
        expect(refusalText('transition rejected')).toBe('transition rejected');
    });

    it('trims surrounding whitespace from the wire', () => {
        expect(refusalText('  ERR:unknown state \n')).toBe('unknown state');
    });

    it('survives an empty or missing reply', () => {
        expect(refusalText('')).toBe('');
        expect(refusalText(undefined as unknown as string)).toBe('');
    });

    it('does not strip a prefix that only looks similar', () => {
        expect(refusalText('ERROR:something')).toBe('ERROR:something');
    });
});
