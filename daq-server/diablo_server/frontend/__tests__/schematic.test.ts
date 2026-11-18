import { describe, expect, it } from 'vitest';
import {
  FORMAT,
  entityName,
  frameOf,
  overlayOf,
  parseStandPid,
  pressureEntity,
  psigText,
  type StandPid,
} from '@/lib/schematic';

const PID: StandPid = {
  format: FORMAT,
  drawing: { diagram: 'le4', artifact: null, sha256: 'abc', exported_at: '2026-11-17T12:00:00.000Z' },
  svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  width: 1000,
  height: 500,
  boxes: { pt: [100, 200, 40, 40], main: [300, 200, 60, 40], tank: [500, 100, 80, 200] },
  mates: {},
  symbols: {
    pt: { type: 'PT', tag: 'OU-PT-R', page: 'Rocket', normally: null },
    main: { type: 'SOLENOID_VALVE', tag: 'OU_SOL_R', page: 'Rocket', normally: 'NC' },
    tank: { type: 'TANK', tag: 'LOX', page: 'Rocket', normally: null },
  },
  channels: [
    { board: 'pt_low', slot: 5, name: 'Ox Upstream', symbol: 'pt' },
    { board: 'sol12', slot: 1, name: 'LOX Main', symbol: 'main' },
  ],
};

describe('reading the bundle', () => {
  it('takes one of its own format', () => {
    expect(parseStandPid(PID)).toEqual({ pid: PID });
  });

  it('refuses another format and says to export again', () => {
    const out = parseStandPid({ ...PID, format: 'star.stand-pid/0' });
    expect('error' in out && out.error).toMatch(/Export it again/);
  });

  it('refuses one with no drawing', () => {
    expect('error' in parseStandPid({ ...PID, svg: '' })).toBe(true);
    expect('error' in parseStandPid(null)).toBe(true);
  });
});

describe('where a value is read from', () => {
  it('is the DAQ role name, as every other page reads it', () => {
    expect(entityName(' Ox  Upstream ')).toBe('Ox_Upstream');
    expect(pressureEntity('Ox Upstream')).toBe('PT_Cal.Ox_Upstream');
  });

  it('reads each transducer on the box, and nothing else', () => {
    const asked: string[] = [];
    const frame = frameOf(PID, (entity, component) => {
      asked.push(`${entity}.${component}`);
      return 512.4;
    });
    expect(asked).toEqual(['PT_Cal.Ox_Upstream.pressure_psi']);
    expect(frame).toEqual({ 'Ox Upstream': 512.4 });
  });
});

describe('what is painted', () => {
  it('dims every symbol with no cable, and only those', () => {
    expect(overlayOf(PID, {}).dim).toEqual([PID.boxes.tank]);
  });

  it('puts a transducer reading above its symbol, in psig', () => {
    const [r] = overlayOf(PID, { 'Ox Upstream': 512.4 }).readings;
    expect(r).toEqual({ symbol: 'pt', name: 'Ox Upstream', x: 120, y: 200, text: '512 psig', live: true });
  });

  it('shows a dash, not a number, when there is no fresh value', () => {
    const [r] = overlayOf(PID, { 'Ox Upstream': null }).readings;
    expect(r.text).toBe('— psig');
    expect(r.live).toBe(false);
  });

  it('never writes a bare psi', () => {
    for (const v of [0, 14.7, 4500, null]) expect(psigText(v)).toMatch(/psig$/);
  });
});
