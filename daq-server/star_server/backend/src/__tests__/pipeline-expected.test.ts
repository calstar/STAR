import { afterEach, describe, expect, it, vi } from 'vitest';

// sessionManager reads SESSION_SERVICE_MODE when the module loads, so each mode gets a fresh
// import.
async function managerIn(mode: string | undefined) {
  vi.resetModules();
  if (mode === undefined) delete process.env.SESSION_SERVICE_MODE;
  else process.env.SESSION_SERVICE_MODE = mode;
  const { sessionManager } = await import('../session-manager.js');
  return sessionManager as unknown as { pipelineExpected(): boolean; active: boolean };
}

const saved = process.env.SESSION_SERVICE_MODE;
afterEach(() => {
  if (saved === undefined) delete process.env.SESSION_SERVICE_MODE;
  else process.env.SESSION_SERVICE_MODE = saved;
});

describe('pipelineExpected', () => {
  it('is false between runs in systemd mode, where the units are stopped', async () => {
    const m = await managerIn('systemd');
    expect(m.pipelineExpected()).toBe(false);
    m.active = true;
    expect(m.pipelineExpected()).toBe(true);
  });

  it('is always true where the pipeline outlives sessions (off, mock)', async () => {
    for (const mode of [undefined, 'off', 'mock']) {
      const m = await managerIn(mode);
      expect(m.pipelineExpected(), `mode ${mode}`).toBe(true);
    }
  });
});
