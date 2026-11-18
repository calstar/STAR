/**
 * The Schematic page's drawing is a file beside config.toml; the server hands it over or says
 * how to make one.
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { STAND_PID_FILE, checkoutConfigDir, readStandPid, standPidDir } from '../routes/stand-pid.js';
import { mkdirSync } from 'fs';

const dir = () => mkdtempSync(join(tmpdir(), 'stand-pid-'));

describe('readStandPid', () => {
    it('hands the bundle over as it is', () => {
        const d = dir();
        const text = JSON.stringify({ format: 'star.stand-pid/1', channels: [] });
        writeFileSync(join(d, STAND_PID_FILE), text);
        expect(readStandPid(d)).toEqual({ status: 200, body: text });
    });

    it('says where to get one when there is none', () => {
        const answer = readStandPid(dir());
        expect(answer.status).toBe(404);
        expect(JSON.parse(answer.body).error).toMatch(/Export for DAQ/);
    });

    it('refuses a file that is not JSON rather than handing the page garbage', () => {
        const d = dir();
        writeFileSync(join(d, STAND_PID_FILE), '{ nope');
        expect(readStandPid(d).status).toBe(500);
    });

    it('lives beside config.toml', () => {
        expect(standPidDir('/srv/daq/config/config.toml')).toBe('/srv/daq/config');
    });

    it('takes the first directory that has one: the run\'s config, then the checkout\'s', () => {
        // A sim run reads a config generated under /tmp; the drawing is still the committed one.
        const sim = dir();
        const checkout = dir();
        writeFileSync(join(checkout, STAND_PID_FILE), '{"from":"checkout"}');
        expect(readStandPid(sim, checkout).body).toBe('{"from":"checkout"}');
        writeFileSync(join(sim, STAND_PID_FILE), '{"from":"sim"}');
        expect(readStandPid(sim, checkout).body).toBe('{"from":"sim"}');
    });

    it("finds the checkout's config/ by walking up to config_base.toml", () => {
        const root = dir();
        mkdirSync(join(root, 'config'));
        writeFileSync(join(root, 'config', 'config_base.toml'), '');
        const deep = join(root, 'diablo_server', 'backend', 'dist', 'backend', 'src', 'routes');
        mkdirSync(deep, { recursive: true });
        expect(checkoutConfigDir(deep)).toBe(join(root, 'config'));
    });

    it('finds this checkout\'s from the source tree', () => {
        expect(checkoutConfigDir(__dirname)).toMatch(/daq-server\/config$/);
    });
});
