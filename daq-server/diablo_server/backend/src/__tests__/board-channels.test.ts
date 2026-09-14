/**
 * A board's channel list lives in exactly one place.
 *
 * There used to be two: `active_connectors` (the list config_broadcast packs into the
 * board's SensorConfigPacket) and a config-only `num_sensors` that meant "expand to
 * 1..N". Nothing reconciled them, so a board could declare `active_connectors = [1, 2, 6]`
 * beside `num_sensors = 4` and the GUI, the calibration tools and the wire each believed a
 * different set. The firmware never had an opinion to settle it: its `num_sensors` byte is
 * just the length of the id list that follows (SensorConfigPacket in lib/daq-protocol;
 * `active_count = stored_config.num_sensors` in the Hotfire firmware), so the config-only
 * field corresponded to nothing on the wire.
 *
 * `num_sensors` is gone. These tests pin that so it cannot drift back in through a hand-
 * edited profile, which is how it would return.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'smol-toml';

const CONFIG_DIR = join(__dirname, '../../../../config');

function trackedConfigs(): string[] {
    // config.toml and sim_config.toml are per-machine and gitignored; the profiles are
    // the ones that travel with the repo and get deployed onto a rig.
    const out: string[] = [];
    const profiles = join(CONFIG_DIR, 'profiles');
    if (existsSync(profiles)) {
        for (const d of readdirSync(profiles)) {
            const p = join(profiles, d, 'config.toml');
            if (existsSync(p)) out.push(p);
        }
    }
    const base = join(CONFIG_DIR, 'config_base.toml');
    if (existsSync(base)) out.push(base);
    return out;
}

type Board = Record<string, unknown>;

function boardsOf(path: string): Array<[string, Board]> {
    const cfg = parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    return Object.entries((cfg.boards ?? {}) as Record<string, Board>);
}

describe('deployed config: active_connectors is the only channel list', () => {
    const files = trackedConfigs();

    it('finds the tracked configs at all (guards against a moved config dir)', () => {
        expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
        const name = file.slice(CONFIG_DIR.length + 1);

        it(`${name}: no board declares num_sensors`, () => {
            const offenders = boardsOf(file)
                .filter(([, b]) => 'num_sensors' in b)
                .map(([k]) => k);
            expect(offenders).toEqual([]);
        });

        it(`${name}: every board declares a non-empty active_connectors`, () => {
            // An empty list is a board that samples nothing. Nothing falls back to a
            // 1..N range any more, so an omission is silent: the board disappears from
            // the boards panel, from Elodin registration and from calibration.
            const offenders = boardsOf(file)
                .filter(([, b]) => !Array.isArray(b.active_connectors) || (b.active_connectors as unknown[]).length === 0)
                .map(([k]) => k);
            expect(offenders).toEqual([]);
        });

        it(`${name}: channels are distinct connector numbers in 1..10`, () => {
            for (const [key, b] of boardsOf(file)) {
                const ch = (b.active_connectors as unknown[]).map(Number);
                expect(ch.every((c) => Number.isInteger(c) && c >= 1 && c <= 10), `${key}: ${ch}`).toBe(true);
                expect(new Set(ch).size, `${key} has duplicates: ${ch}`).toBe(ch.length);
            }
        });
    }
});
