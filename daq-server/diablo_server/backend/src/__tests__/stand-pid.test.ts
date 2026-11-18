/**
 * The Schematic page's drawing is a file beside config.toml; the server hands it over or says
 * how to make one.
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { STAND_PID_FILE, readStandPid, standPidDir } from '../routes/stand-pid.js';

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
});
