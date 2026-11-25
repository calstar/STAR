/**
 * The keyed-alert API in server/notifications.ts: raiseAlert / clearAlert / isAlertRaised.
 * Watchers call raiseAlert on every tick a condition holds and clearAlert on every tick it does
 * not; only the edges may reach the operator. Dropping the dedupe in either must go red here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: any[] = [];
vi.mock('../server/ws-clients.js', () => ({ broadcast: (m: any) => { sent.push(m); } }));

const { raiseAlert, clearAlert, isAlertRaised, notificationBuffer, activeNotificationKeys } = await import('../server/notifications.js');

beforeEach(() => { sent.length = 0; });

describe('keyed alerts', () => {
  it('raise is deduped by key: one notification however often it is called', () => {
    expect(raiseAlert('t_dup', 'error', 'thing broke', 1000)).toBe(true);
    expect(raiseAlert('t_dup', 'error', 'thing broke', 1500)).toBe(false);
    expect(raiseAlert('t_dup', 'warning', 'other text', 2000)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({ key: 't_dup', category: 'error', message: 'thing broke', timestampMs: 1000, ongoing: true });
    expect(isAlertRaised('t_dup')).toBe(true);
    expect(activeNotificationKeys.has('t_dup')).toBe(true);
  });

  it('clear re-sends the raised category and message as ongoing:false, once', () => {
    expect(clearAlert('t_dup', 3000)).toBe(true);
    expect(clearAlert('t_dup', 3500)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({ key: 't_dup', category: 'error', message: 'thing broke', timestampMs: 3000, ongoing: false });
    expect(isAlertRaised('t_dup')).toBe(false);
  });

  it('clearing a key that was never raised sends nothing', () => {
    expect(clearAlert('t_never', 1)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('keys are independent, and a cleared key can be raised again', () => {
    raiseAlert('t_a', 'warning', 'a', 1);
    raiseAlert('t_b', 'error', 'b', 2);
    clearAlert('t_a', 3);
    expect(raiseAlert('t_a', 'warning', 'a again', 4)).toBe(true);
    expect(isAlertRaised('t_b')).toBe(true);
    expect(sent.map((m) => [m.payload.key, m.payload.ongoing])).toEqual([
      ['t_a', true], ['t_b', true], ['t_a', false], ['t_a', true],
    ]);
  });

  it('every edge lands in the replay buffer a late browser is sent', () => {
    const keys = notificationBuffer.map((e) => (e.payload as any).key);
    expect(keys).toContain('t_dup');
  });
});
