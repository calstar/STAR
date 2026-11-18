/**
 * G6 (DESIGN-WP6 §7): the slot rules behind uniqueIdFromPtEntity, which no golden streams —
 * no pipeline fixture has a PT board with board_id % 10 == 0, and the T7 slot map is only read
 * for T7<n>_Cal.AIN<m> entities. Hermetic: CONFIG_PATH is a temp-dir config.toml set before the
 * first import (TESTING-NOTES.md), the module is re-imported per case (vi.resetModules()), and
 * nothing here reaches a sender, so ws-clients needs no mock.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'daq-config-caches-'));
const configDir = join(root, 'config');
mkdirSync(configDir, { recursive: true });
process.env.CONFIG_PATH = join(configDir, 'config.toml');
delete process.env.RUNNING_CONFIG_PATH;

writeFileSync(join(configDir, 'config.toml'), `
[boards.pt_board_slot10]
type = "PT"
board_id = 20
ip = "127.0.0.20"

[boards.pt_board_slot1]
type = "PT"
board_id = 21
ip = "127.0.0.21"

[boards.t7_a]
type = "T7"
board_id = 71
ip = "127.0.0.71"
channels = [{ ain = 3, kind = "PT", role = "t7_pt" }]
`);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('config-caches: uniqueId = board_id*100 + channel', () => {
  beforeEach(() => vi.resetModules());

  it('maps a PT entity through the slot → board_id table, with slot 10 for board_id % 10 == 0', async () => {
    const { uniqueIdFromPtEntity } = await import('../server/config-caches.js');
    expect(uniqueIdFromPtEntity('PT10.CH3')).toBe(2003);
    expect(uniqueIdFromPtEntity('PT1_Cal.CH2')).toBe(2102);
  });

  it('falls back to slot*100 + ch for a slot no PT board has', async () => {
    const { uniqueIdFromPtEntity } = await import('../server/config-caches.js');
    expect(uniqueIdFromPtEntity('PT5.CH1')).toBe(501);
  });

  it('maps a T7 calibrated input through the T7 slot map to board_id*100 + AIN', async () => {
    const { uniqueIdFromPtEntity } = await import('../server/config-caches.js');
    expect(uniqueIdFromPtEntity('T71_Cal.AIN3')).toBe(7103);
    expect(uniqueIdFromPtEntity('T72_Cal.AIN3')).toBeNull();
  });

  it('returns null for anything that is not a PT or T7 calibrated entity', async () => {
    const { uniqueIdFromPtEntity } = await import('../server/config-caches.js');
    expect(uniqueIdFromPtEntity('TC1.CH1')).toBeNull();
    expect(uniqueIdFromPtEntity('T71.AIN3')).toBeNull();
  });
});
