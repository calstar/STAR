/**
 * The sequencer's SCRIPTS report, parsed.
 *
 * This channel has existed since dynamic states shipped and nothing ever consumed it — the C++
 * comment beside the allowed-state bitmask points at "the panel" reading reasons over SCRIPTS, and
 * that panel was never built. The bitmask greys a button; this is what lets it explain itself.
 *
 * Two verdicts matter and they behave differently: REFUSED is a load failure, fixed for the run;
 * BLOCKED is the live sensor gate, which appears and clears while the rig is running.
 */
import { describe, it, expect } from 'vitest';
import { parseScriptStatus } from '../script-status.js';

describe('parseScriptStatus', () => {
    it('reads a load refusal', () => {
        const { reasons } = parseScriptStatus(
            'SCRIPT:15:Dynamic Test:REFUSED:loop body never calls delay()\nEND\n');
        expect(reasons[15]).toBe('loop body never calls delay()');
    });

    it('reads a live sensor block', () => {
        const { reasons } = parseScriptStatus(
            'SCRIPT:15:Dynamic Test:BLOCKED:GN2 High has produced no reading yet\nEND\n');
        expect(reasons[15]).toBe('GN2 High has produced no reading yet');
    });

    it('records states whose script loaded cleanly without calling them blocked', () => {
        const { reasons, ok } = parseScriptStatus('SCRIPT:15:Dynamic Test:OK:6:10000\nEND\n');
        expect(ok).toContain(15);
        expect(reasons[15]).toBeUndefined();
    });

    it('prefers a load refusal over a live block for the same state', () => {
        // A script that did not load cannot be fixed by waiting, so that is the reason worth
        // showing even if the sensor gate is also unhappy.
        const { reasons } = parseScriptStatus(
            'SCRIPT:15:Dyn:BLOCKED:GN2 High has produced no reading yet\n' +
            'SCRIPT:15:Dyn:REFUSED:script rejected at load\nEND\n');
        expect(reasons[15]).toBe('script rejected at load');
    });

    it('keeps a reason that still contains a separator', () => {
        // The sequencer substitutes colons before sending, but the parser must not depend on that
        // — taking only one field would silently truncate a reason.
        const { reasons } = parseScriptStatus('SCRIPT:7:S:BLOCKED:stale: 1200 ms old\nEND\n');
        expect(reasons[7]).toBe('stale: 1200 ms old');
    });

    it('ignores junk, blank lines and the terminator', () => {
        const { reasons, ok } = parseScriptStatus(
            '\nEND\nnot a script line\nSCRIPT:bad:X:REFUSED:y\nSCRIPT:2\n');
        expect(Object.keys(reasons)).toHaveLength(0);
        expect(ok).toHaveLength(0);
    });

    it('survives an empty report', () => {
        expect(parseScriptStatus('').reasons).toEqual({});
        expect(parseScriptStatus(undefined as unknown as string).reasons).toEqual({});
    });

    it('handles a whole report with a mix of verdicts', () => {
        const { reasons, ok } = parseScriptStatus(
            'SCRIPT:15:Dynamic Test:OK:6:10000\n' +
            'SCRIPT:16:Other:REFUSED:unknown valve FOO\n' +
            'SCRIPT:17:Third:BLOCKED:High Press is not calibrated\n' +
            'END\n');
        expect(ok).toEqual([15]);
        expect(reasons[16]).toBe('unknown valve FOO');
        expect(reasons[17]).toBe('High Press is not calibrated');
        expect(reasons[15]).toBeUndefined();
    });
});
