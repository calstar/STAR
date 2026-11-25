/**
 * D-LATE (issue #234): a command whose outcome the sequencer did not report reaches the operator
 * as "state unknown, resyncing" (a warning, plus a state_update from the published state), and a
 * command the sequencer cancelled at its deadline is still a plain failure — it will never run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── The command path, end to end inside the backend ──────────────────────────────────────────────
const sent: any[] = [];
const broadcasts: string[] = [];
let nextReply = { ok: false, reply: 'timeout', timedOut: true };
vi.mock('../sequencer-client.js', async (orig) => ({
  ...(await orig<typeof import('../sequencer-client.js')>()),
  sendToSequencer: async () => nextReply,
}));
vi.mock('../server/ws-clients.js', () => ({ send: (_ws: unknown, m: any) => { sent.push(m); }, broadcast: () => {} }));
vi.mock('../server/engine-state.js', () => ({
  resolveTransitionTarget: () => ({ ok: true, stateName: 'Press Standby', csvName: 'Press Standby' }),
  setDebugMode: () => {},
  broadcastStateUpdate: () => { broadcasts.push('state_update'); },
}));
vi.mock('../session-manager.js', () => ({ sessionManager: {} }));
vi.mock('../calibration-handler.js', () => ({ handleCalibrationCommand: () => {} }));
vi.mock('../server/calibration-state.js', () => ({ calibrationHost: {} }));
vi.mock('../server/elodin-link.js', () => ({ broadcastConnectionStatus: () => {} }));
vi.mock('../server/history.js', () => ({ sendHistoricalData: async () => {} }));
vi.mock('../server/mission-time.js', () => ({ setCountdownTarget: () => {} }));
vi.mock('../state-csv/state-transitions.js', () => ({ getStateTransitions: () => [] }));

describe('state_transition with no reply', () => {
  beforeEach(() => { sent.length = 0; broadcasts.length = 0; });

  const transition = async () => {
    const { handleMessage } = await import('../server/commands.js');
    const ws: any = { __daqControlAuthorized: true };
    handleMessage(ws, { type: 'send_command', payload: { commandType: 'state_transition', data: { state: 20 } } });
    await new Promise((r) => setTimeout(r, 20));
  };

  it('warns "state unknown, resyncing" and re-broadcasts the published state', async () => {
    nextReply = { ok: false, reply: 'timeout', timedOut: true };
    await transition();
    expect(sent.map((m) => m.type)).toEqual(['notification']);
    expect(sent[0].payload.category).toBe('warning');
    expect(sent[0].payload.message).toContain('State transition: no reply from the sequencer within 5 s');
    expect(sent[0].payload.message).toContain('state unknown, resyncing');
    expect(broadcasts).toEqual(['state_update']);
  });

  it('a sequencer-cancelled command is still reported as failed (it will never run)', async () => {
    nextReply = { ok: false, reply: 'ERR:not executed: still queued after 1500 ms (sequencer busy)', timedOut: false };
    await transition();
    expect(sent.map((m) => m.type)).toEqual(['error']);
    expect(sent[0].payload.message).toBe('State transition failed: not executed: still queued after 1500 ms (sequencer busy)');
    expect(broadcasts).toEqual([]);
  });
});
