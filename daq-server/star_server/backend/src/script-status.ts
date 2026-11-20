/**
 * The sequencer's SCRIPTS report, parsed.
 *
 * `scriptStatusReport()` has emitted this since dynamic states shipped and nothing ever asked for
 * it — the C++ comment beside the allowed-state bitmask refers to "the panel" reading reasons over
 * SCRIPTS, and that panel was never built. The bitmask says WHICH states are unavailable; this
 * says WHY, which is the half an operator needs.
 *
 * Wire format, one per line, terminated by `END`:
 *   SCRIPT:<id>:<name>:OK:<statements>:<timeout_ms>
 *   SCRIPT:<id>:<name>:REFUSED:<why>     — script failed to load; fixed for the run
 *   SCRIPT:<id>:<name>:BLOCKED:<why>     — sensor gate unsatisfied right now; clears on its own
 *
 * The sequencer substitutes any colon in a name or reason with a space before sending, so
 * splitting on ':' is safe — but only up to the reason, which is taken as the rest of the line so
 * a future field cannot be silently truncated.
 */

export interface ScriptStatus {
    /** State id -> why it cannot be entered. Both REFUSED and BLOCKED land here. */
    reasons: Record<number, string>;
    /** State ids whose script loaded cleanly, for telling "no script" from "script fine". */
    ok: number[];
}

export function parseScriptStatus(report: string): ScriptStatus {
    const reasons: Record<number, string> = {};
    const ok: number[] = [];

    for (const raw of (report ?? '').split('\n')) {
        const line = raw.trim();
        if (line === '' || line === 'END') continue;
        if (!line.startsWith('SCRIPT:')) continue;

        const parts = line.split(':');
        if (parts.length < 4) continue;

        const id = Number(parts[1]);
        if (!Number.isFinite(id)) continue;
        const verdict = parts[3];

        if (verdict === 'OK') {
            ok.push(id);
            continue;
        }
        if (verdict !== 'REFUSED' && verdict !== 'BLOCKED') continue;

        // Rest of the line, so a reason is never cut short at a separator.
        const why = parts.slice(4).join(':').trim();
        if (why === '') continue;
        // A load refusal outranks a live block: it cannot be fixed by waiting, so if a state has
        // both, the operator should be told the one that needs action.
        if (verdict === 'REFUSED' || reasons[id] === undefined) reasons[id] = why;
    }

    return { reasons, ok };
}
