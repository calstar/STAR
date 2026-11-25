/**
 * Issue #234: the backend raises the keyed alert `sequencer_wedged` when the sequencer's HEALTH
 * query reports its command worker wedged, and clears it when the worker recovers (or the
 * sequencer is gone). A missed reply changes nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: any[] = [];
vi.mock('../server/ws-clients.js', () => ({ broadcast: (m: any) => { sent.push(m); } }));

const health = await import('../server/sequencer-health.js');
const { isAlertRaised } = await import('../server/notifications.js');
const KEY = health.SEQUENCER_WEDGED_ALERT_KEY;
const edges = () => sent.filter((m) => m.payload?.key === KEY).map((m) => m.payload.ongoing);
const reply = (r: string, timedOut = false) => ({ ok: false, reply: r, timedOut });

beforeEach(() => {
  if (isAlertRaised(KEY)) health.noteSequencerHealth(reply('HEALTH:OK'));
  sent.length = 0;
});

describe('sequencer health watch', () => {
  it('raises once on WEDGED and clears once on OK', () => {
    health.noteSequencerHealth(reply('HEALTH:WEDGED:3200'));
    health.noteSequencerHealth(reply('HEALTH:WEDGED:4300'));
    expect(isAlertRaised(KEY)).toBe(true);
    health.noteSequencerHealth(reply('HEALTH:OK'));
    health.noteSequencerHealth(reply('HEALTH:OK'));
    expect(edges()).toEqual([true, false]);
    expect(isAlertRaised(KEY)).toBe(false);
    const raised = sent.find((m) => m.payload?.key === KEY && m.payload.ongoing);
    expect(raised.payload.category).toBe('error');
    expect(raised.payload.message).toContain('Sequencer wedged');
    expect(raised.payload.message).toContain('3.2 s');
  });

  it('no reply in time leaves it as it is; a refused connection clears it', () => {
    health.noteSequencerHealth(reply('HEALTH:WEDGED:3000'));
    health.noteSequencerHealth(reply('timeout', true));
    expect(isAlertRaised(KEY)).toBe(true);
    health.noteSequencerHealth(reply('connect ECONNREFUSED 127.0.0.1:9998'));
    expect(isAlertRaised(KEY)).toBe(false);
    expect(edges()).toEqual([true, false]);
  });

  it('polls HEALTH quietly, one at a time, only while the pipeline is expected', async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    let expected = false;
    let release: () => void = () => {};
    const ask = vi.fn((line: string, opts: { quiet: boolean }) => {
      asked.push(`${line.trim()} quiet=${opts.quiet}`);
      return new Promise<any>((res) => { release = () => res(reply('HEALTH:WEDGED:5000')); });
    });
    const timer = health.startSequencerHealthWatch(() => expected, ask);
    await vi.advanceTimersByTimeAsync(3 * health.SEQUENCER_HEALTH_POLL_MS);
    expect(asked).toEqual([]);
    expected = true;
    await vi.advanceTimersByTimeAsync(3 * health.SEQUENCER_HEALTH_POLL_MS);
    expect(asked).toEqual(['HEALTH quiet=true']); // still in flight: no pile-up
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(isAlertRaised(KEY)).toBe(true);
    clearInterval(timer);
    vi.useRealTimers();
  });
});
