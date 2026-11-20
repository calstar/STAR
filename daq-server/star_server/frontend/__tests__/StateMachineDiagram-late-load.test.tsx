import { it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import * as websocketModule from '@/lib/websocket';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
vi.mock('@/lib/control-mode', () => ({ useControlMode: () => ({ controlEnabled: true }) }));

// The CI flake "ReferenceError: window is not defined" (StateMachineDiagram.tsx, setStatesVersion):
// every render fetches /api/states for real, and a refused connection that settles just after the
// last test's unmount and the file's jsdom teardown reached setState, which reads window.event.
// This forces that order: hold the fetch, unmount, take window away as teardown does, then settle.
it('a states load that settles after unmount and jsdom teardown does not touch React', async () => {
  vi.spyOn(websocketModule, 'getWebSocketClient').mockReturnValue({
    on: vi.fn(() => vi.fn()), isConnected: () => false, send: vi.fn(), onConnectionStatus: vi.fn(() => vi.fn()),
  } as any);
  let settle!: () => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise((_, rej) => { settle = () => rej(new Error('ECONNREFUSED')); })));
  const { unmount } = render(<StateMachineDiagram />);
  unmount();                              // RTL cleanup after the last test
  const saved = (globalThis as any).window;
  delete (globalThis as any).window;      // what jsdom teardown does
  let thrown: unknown = null;
  const onRej = (e: unknown) => { thrown = e; };
  process.on('unhandledRejection', onRej);
  settle();                               // the refused connection lands now
  await new Promise((r) => setTimeout(r, 20));
  process.off('unhandledRejection', onRej);
  (globalThis as any).window = saved;
  vi.unstubAllGlobals();
  expect(String(thrown)).toBe('null');
});
