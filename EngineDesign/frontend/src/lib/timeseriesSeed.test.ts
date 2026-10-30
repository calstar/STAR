import { describe, expect, it } from 'vitest';
import type { EngineConfig, ProfileParams } from '../api/client';
import { isRegulated, seededProfile } from '../lib/timeseriesSeed';

const prev: ProfileParams = { start_pressure_psi: 750, end_pressure_psi: 500, profile_type: 'exponential', decay_constant: 3 };
const cfg = (model?: string) => ({ design_requirements: model ? { feed_pressure_model: model } : {} }) as unknown as EngineConfig;

describe('the Time-Series profile a design opens with', () => {
  it('holds a regulated design at its tank pressure through the burn', () => {
    expect(isRegulated(cfg('dome_regulated'))).toBe(true);
    expect(isRegulated(cfg())).toBe(true); // the schema's default
    const p = seededProfile(prev, 578.04, true);
    expect([p.start_pressure_psi, p.end_pressure_psi, p.profile_type]).toEqual([578, 578, 'linear']);
  });
  it('lets a blowdown design decay from it', () => {
    expect(isRegulated(cfg('blowdown'))).toBe(false);
    const p = seededProfile({ ...prev, end_pressure_psi: 900 }, 578, false);
    expect([p.start_pressure_psi, p.end_pressure_psi]).toEqual([578, 405]);
  });
});
