/** A tile's status (lib/video/tile-state.ts): LIVE needs frames; a frozen picture is STALE. */
import { describe, it, expect } from 'vitest';
import { staleLabel, tileStatus, STALE_MS } from '@/lib/video/tile-state';

const up = { kind: 'live' as const };

describe('tile status', () => {
  it('a connection with no frame yet is still connecting, not live', () => {
    expect(tileStatus(up, null, 1000)).toEqual({ kind: 'connecting' });
  });

  it('is live while frames keep arriving', () => {
    expect(tileStatus(up, 1000, 1000 + STALE_MS)).toEqual({ kind: 'live' });
  });

  it('goes stale when frames stop, while still connected', () => {
    expect(tileStatus(up, 1000, 1000 + STALE_MS + 1)).toEqual({ kind: 'stale', forMs: STALE_MS + 1 });
  });

  it('a failure is offline with its reason, whatever the last frame', () => {
    expect(tileStatus({ kind: 'failed', reason: 'camera unreachable', where: 'gateway' }, 999, 1000)).toEqual({ kind: 'offline', reason: 'camera unreachable' });
  });

  it('labels how long it has been stale', () => {
    expect(staleLabel(4200)).toBe('STALE 4s');
    expect(staleLabel(150_000)).toBe('STALE 2m');
  });
});
