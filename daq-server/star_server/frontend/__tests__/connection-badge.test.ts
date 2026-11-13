import { describe, it, expect } from 'vitest';
import { connectionBadge, type ConnectionBadgeInput } from '@/lib/connection-badge';

const base: ConnectionBadgeInput = {
  connected: true,
  sessionStopped: false,
  dataFresh: true,
  simulated: false,
};

describe('connectionBadge precedence', () => {
  // Precedence is the part most likely to be broken by a later edit, and the
  // failure mode is silent: a badge that hides a dead pipeline behind a
  // reassuring label is exactly the class of bug the outbox work exists to fix.

  it('a dead socket outranks everything, including throttling', () => {
    const b = connectionBadge({ ...base, connected: false, throttled: true, dataFresh: false });
    expect(b.label).toBe('Disconnected');
    expect(b.dotClass).toBe('bg-red-500');
  });

  it('a stopped session outranks throttling', () => {
    expect(connectionBadge({ ...base, sessionStopped: true, throttled: true }).label)
      .toBe('Session Stopped');
  });

  it('a dead pipeline is never masked by throttling', () => {
    const b = connectionBadge({ ...base, dataFresh: false, throttled: true, resolutionPct: 12 });
    expect(b.label).toBe('Data Pipeline Down');
    expect(b.dotClass).toBe('bg-yellow-500');
  });

  it('throttling outranks Connected — a decimated trace must say so', () => {
    const b = connectionBadge({ ...base, throttled: true, resolutionPct: 40, lagMs: 1200 });
    expect(b.label).toBe('Throttled · 40%');
    expect(b.dotClass).toBe('bg-orange-500');
  });

  it('throttling outranks Simulated Data', () => {
    expect(connectionBadge({ ...base, simulated: true, throttled: true, resolutionPct: 40 }).label)
      .toBe('Throttled · 40%');
  });

  it('healthy states are unchanged', () => {
    expect(connectionBadge(base).label).toBe('Connected');
    expect(connectionBadge(base).dotClass).toBe('bg-green-500');
    expect(connectionBadge({ ...base, simulated: true }).label).toBe('Simulated Data');
    expect(connectionBadge({ ...base, simulated: true }).dotClass).toBe('bg-purple-500');
  });

  it('does not read as throttled when the backend says it is not', () => {
    // resolutionPct below 100 without `throttled` (e.g. a stale stat window)
    // must not trip the badge — the backend owns the decision.
    expect(connectionBadge({ ...base, throttled: false, resolutionPct: 40 }).label).toBe('Connected');
  });

  it('never reuses yellow for throttling', () => {
    // Yellow already means "Data Pipeline Down"; the two must not read alike.
    const throttled = connectionBadge({ ...base, throttled: true, resolutionPct: 40 });
    const stale = connectionBadge({ ...base, dataFresh: false });
    expect(throttled.dotClass).not.toBe(stale.dotClass);
  });
});

describe('connectionBadge label formatting', () => {
  it('rounds and clamps the percentage', () => {
    expect(connectionBadge({ ...base, throttled: true, resolutionPct: 39.6 }).label).toBe('Throttled · 40%');
    expect(connectionBadge({ ...base, throttled: true, resolutionPct: 140 }).label).toBe('Throttled · 100%');
    expect(connectionBadge({ ...base, throttled: true, resolutionPct: -5 }).label).toBe('Throttled · 0%');
  });

  it('tolerates missing numbers rather than rendering NaN', () => {
    const b = connectionBadge({ ...base, throttled: true });
    expect(b.label).toBe('Throttled · 0%');
    expect(b.title).not.toMatch(/NaN/);
  });

  it('tells the operator peaks survived — the point of min/max decimation', () => {
    const b = connectionBadge({ ...base, throttled: true, resolutionPct: 40, lagMs: 1200 });
    expect(b.title).toContain('1.2 s behind');
    expect(b.title).toContain('Peaks are preserved');
  });
});
