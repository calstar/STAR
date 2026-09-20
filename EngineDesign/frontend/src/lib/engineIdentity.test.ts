import { describe, it, expect } from 'vitest';
import { engineIdentity } from './engineIdentity';
import type { EngineConfig } from '../api/client';

const base = {
  propellant_preset: 'methalox',
  injector: { type: 'impinging' },
  fluids: { oxidizer: { name: 'LOX' }, fuel: { name: 'Methane' } },
  chamber: { length: 0.18 },
  lox_tank: { initial_pressure_psi: 500 },
} as unknown as EngineConfig;

const withPatch = (patch: Record<string, unknown>) =>
  ({ ...base, ...patch }) as unknown as EngineConfig;

describe('engineIdentity', () => {
  it('changes when the propellant preset changes', () => {
    expect(engineIdentity(withPatch({ propellant_preset: 'ethalox' }))).not.toBe(
      engineIdentity(base),
    );
  });

  it('changes when the fuel changes even if the preset name does not', () => {
    // A custom config can swap fluids without touching propellant_preset.
    expect(
      engineIdentity(
        withPatch({ fluids: { oxidizer: { name: 'LOX' }, fuel: { name: 'Ethanol' } } }),
      ),
    ).not.toBe(engineIdentity(base));
  });

  it('changes when the oxidizer changes', () => {
    expect(
      engineIdentity(
        withPatch({ fluids: { oxidizer: { name: 'N2O' }, fuel: { name: 'Methane' } } }),
      ),
    ).not.toBe(engineIdentity(base));
  });

  it('changes when the injector type changes', () => {
    expect(engineIdentity(withPatch({ injector: { type: 'pintle' } }))).not.toBe(
      engineIdentity(base),
    );
  });

  it('does NOT change for edits that leave the same engine', () => {
    // The whole point of keying on identity rather than object reference: these must not wipe
    // a result the user is still reading.
    expect(engineIdentity(withPatch({ chamber: { length: 0.22 } }))).toBe(engineIdentity(base));
    expect(engineIdentity(withPatch({ lox_tank: { initial_pressure_psi: 650 } }))).toBe(
      engineIdentity(base),
    );
  });

  it('is stable across a fresh object with the same contents', () => {
    expect(engineIdentity(withPatch({}))).toBe(engineIdentity(base));
  });

  it('handles a null config', () => {
    expect(engineIdentity(null)).toBe('');
    expect(engineIdentity(undefined)).toBe('');
  });
});
