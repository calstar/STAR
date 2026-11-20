import { describe, expect, it } from 'vitest';
import {
  BALL_VALVE_GRACE_MS,
  COIL_GRACE_MS,
  FORMAT,
  UNMEASURED,
  ageText,
  celsiusText,
  daqNamesOf,
  entityName,
  frameOf,
  lineStyles,
  overlayOf,
  parseStandPid,
  placeLabels,
  pressureEntity,
  psigText,
  shade,
  temperatureEntity,
  valveMismatch,
  valveColour,
  valveStyles,
  VALVE_COLOURS,
  type Ring,
  type Frame,
  type FrameSource,
  type Reading,
  type Sample,
  type StandPid,
  type ValveSample,
} from '@/lib/schematic';

// A small stand: two PTs either side of a solenoid, an NO solenoid, a ball valve, an RTD, a tank.
const PID: StandPid = {
  format: FORMAT,
  drawing: { diagram: 'le4', artifact: null, sha256: 'abc', exported_at: '2026-11-17T12:00:00.000Z' },
  svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  width: 2000,
  height: 1000,
  boxes: {
    pt: [100, 200, 40, 40],
    pt2: [700, 200, 40, 40],
    main: [300, 200, 60, 40],
    press: [400, 600, 60, 40],
    bv: [900, 600, 60, 40],
    rtd: [1200, 200, 40, 40],
    tank: [500, 100, 80, 200],
  },
  mates: {},
  symbols: {
    pt: { type: 'PT', tag: 'OU-PT-R', page: 'Rocket', normally: null },
    pt2: { type: 'PT', tag: 'OD-PT', page: 'Rocket', normally: null },
    main: { type: 'SOL', tag: 'OM-R', page: 'Rocket', normally: 'NC' },
    press: { type: 'SOL', tag: 'OU_SOL_R', page: 'Rocket', normally: 'NC' },
    bv: { type: 'ROT', tag: 'BV-1', page: 'GSE', normally: 'NC' },
    rtd: { type: 'RTD', tag: 'OX-RTD-1', page: 'Rocket', normally: null },
    tank: { type: 'TANK', tag: 'LOX', page: 'Rocket', normally: null },
  },
  channels: [
    { board: 'pt_low', slot: 5, name: 'Ox Upstream', symbol: 'pt' },
    { board: 'pt_low', slot: 7, name: 'Ox Downstream', symbol: 'pt2' },
    { board: 'sol12', slot: 1, name: 'LOX Main', symbol: 'main' },
    { board: 'sol12', slot: 8, name: 'LOX Press', symbol: 'press' },
    { board: 'sol24', slot: 1, name: 'Ball', symbol: 'bv' },
    { board: 'rtd', slot: 2, name: 'LOX Upper', symbol: 'rtd' },
  ],
  sections: {
    s1: { lines: ['a', 'b'], limit: null },
    s2: { lines: ['c'], limit: { psig: 750, vessel: 'LOX', basis: 'burst', burst_psig: 1500, factor: 2 } },
    s3: { lines: ['d'], limit: null },
  },
  sectionOf: { pt: 's1', pt2: 's2' },
};

const CONFIG = {
  boards: {
    pt_board: { type: 'PT', board_id: 21 },
    pt_board_2: { type: 'PT', board_id: 22, hp_pt_full_scale_psi: 5000 },
    actuator_board_2: { type: 'ACTUATOR', board_id: 12 },
    ball_valve_board: { type: 'BALL_VALVE', board_id: 71 },
    rtd_board: { type: 'RTD', board_id: 31 },
  },
  actuator_roles: { 'LOX Main': ['NC', 1, 12], 'LOX Press': ['NO', 8, 12, 'pwm_ox'], Ball: ['NC', 1, 71] },
  sensor_roles_pt_board: { 'Ox Upstream': 5, 'Ox Downstream': 7, 'Chamber Mid PT 1': 4 },
  sensor_roles_pt_board_2: { 'GSE High': 1 },
  calibration_full_scale_pt_board: { 'Ox Downstream': 2000 },
  sensor_roles_rtd_board: { 'LOX Upper': 2 },
};
const NAMES = daqNamesOf(CONFIG);

const live = (value: number): Sample => ({ value, ageMs: 100, staleAfterMs: 1500 });
const valve = (open: boolean | null, extra: Partial<ValveSample> = {}): ValveSample => ({
  open, ageMs: 100, staleAfterMs: 1500, currentA: null, positionPct: null, sinceChangeMs: 5000, ...extra,
});
const frame = (over: Partial<Frame> = {}): Frame => ({
  samples: { 'Ox Upstream': live(512.4), 'Ox Downstream': live(300), 'LOX Upper': live(-183.24) },
  valves: { 'LOX Main': valve(false), 'LOX Press': valve(true), Ball: valve(true, { positionPct: 98 }) },
  offlineBoards: [],
  ...over,
});
const reading = (o: ReturnType<typeof overlayOf>, name: string) => o.readings.find((r) => r.name === name)!;
const ring = (o: ReturnType<typeof overlayOf>, name: string) => o.rings.find((r) => r.name === name)!;

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

describe("the DAQ's names, from its running config", () => {
  it('reads NO/NC and the board of each actuator, and spots a ball valve', () => {
    expect(NAMES.get('lox press')).toMatchObject({ kind: 'valve', normally: 'NO', boardId: 12, ballValve: false });
    expect(NAMES.get('lox main')?.normally).toBe('NC');
    expect(NAMES.get('ball')?.ballValve).toBe(true);
  });

  it("gives each transducer its board's full scale, or its own", () => {
    expect(NAMES.get('ox upstream')).toMatchObject({ kind: 'pressure', boardId: 21, fullScalePsi: 1000 });
    expect(NAMES.get('ox downstream')?.fullScalePsi).toBe(2000);
    expect(NAMES.get('gse high')?.fullScalePsi).toBe(5000);
  });

  it('knows a temperature channel', () => {
    expect(NAMES.get('lox upper')).toMatchObject({ kind: 'temperature', boardId: 31 });
  });
});

describe('where a value is read from', () => {
  it('is the DAQ role name, as every other page reads it', () => {
    expect(entityName(' Ox  Upstream ')).toBe('Ox_Upstream');
    expect(pressureEntity('Ox Upstream')).toBe('PT_Cal.Ox_Upstream');
    expect(temperatureEntity('LOX Upper', 'RTD')).toBe('RTD_Cal.LOX_Upper');
    expect(temperatureEntity('TC 1', 'TC')).toBe('TC_Cal.TC_1');
  });

  it('reads each connector by its kind', () => {
    const asked: string[] = [];
    const src: FrameSource = {
      sample: (e, c) => { asked.push(`${e}.${c}`); return live(1); },
      valve: (e, bv) => { asked.push(`${e}${bv ? ' (ball)' : ''}`); return { open: true, ageMs: 1, staleAfterMs: 1500, currentA: 0.5, positionPct: null }; },
      boardOffline: (id) => id === 31,
      sinceChange: () => 42,
    };
    const f = frameOf(PID, NAMES, src);
    expect(asked).toEqual([
      'PT_Cal.Ox_Upstream.pressure_psi', 'PT_Cal.Ox_Downstream.pressure_psi',
      'ACT.LOX_Main', 'ACT.LOX_Press', 'ACT.Ball (ball)', 'RTD_Cal.LOX_Upper.temperature_c',
    ]);
    expect(f.valves['LOX Main'].sinceChangeMs).toBe(42);
    expect(f.offlineBoards).toEqual([31]);
  });
});

describe('readings (ticket 02, 06)', () => {
  it('dims every symbol with no cable, and only those', () => {
    expect(overlayOf(PID, frame(), NAMES).dim).toEqual([PID.boxes.tank]);
  });

  it('puts a transducer reading above its symbol, as the bare number', () => {
    const r = reading(overlayOf(PID, frame(), NAMES), 'Ox Upstream');
    expect(r).toMatchObject({ symbol: 'pt', x: 120, y: 200, text: '512', state: 'live' });
  });

  it('puts a temperature on an RTD in °C', () => {
    expect(reading(overlayOf(PID, frame(), NAMES), 'LOX Upper').text).toBe('-183.2 °C');
  });

  it('writes a pressure as the bare rounded number, a dash when unknown', () => {
    expect([0, 14.7, 4500, null].map(psigText)).toEqual(['0', '15', '4500', '—']);
    expect(celsiusText(null)).toBe('— °C');
  });
});

describe('stale data and health (ticket 04)', () => {
  it('greys a stale value and says how old it is, instead of blanking it', () => {
    const r = reading(overlayOf(PID, frame({ samples: { 'Ox Upstream': { value: 480, ageMs: 4200, staleAfterMs: 1500 } } }), NAMES), 'Ox Upstream');
    expect(r.state).toBe('stale');
    expect(r.text).toBe('480 · 4 s');
  });

  it('shows a dash when there has never been a value', () => {
    const r = reading(overlayOf(PID, frame({ samples: {} }), NAMES), 'Ox Upstream');
    expect(r).toMatchObject({ state: 'none', text: '—' });
  });

  it('greys every symbol on a board that has gone offline, values included', () => {
    const o = overlayOf(PID, frame({ offlineBoards: [21] }), NAMES);
    expect(o.offline).toEqual([PID.boxes.pt, PID.boxes.pt2]);
    expect(reading(o, 'Ox Upstream').state).toBe('stale');
    expect(reading(o, 'Ox Upstream').note).toBe('board offline');
  });

  it('flags a name the DAQ config does not have, and lists DAQ names never placed', () => {
    const o = overlayOf(PID, frame(), daqNamesOf({ ...CONFIG, sensor_roles_pt_board: { 'Chamber Mid PT 1': 4, 'Ox Downstream': 7 } }));
    expect(reading(o, 'Ox Upstream')).toMatchObject({ state: 'unknown', text: '—' });
    expect(o.health.unknown).toEqual(['Ox Upstream']);
    expect(o.health.unplaced).toEqual(['Chamber Mid PT 1', 'GSE High']);
  });

  it('says nothing about names before the config has loaded', () => {
    const o = overlayOf(PID, frame());
    expect(o.health).toEqual({ unknown: [], unplaced: [], disagree: [] });
    expect(reading(o, 'Ox Upstream').state).toBe('live');
  });

  it('writes ages people read', () => {
    expect(ageText(4200)).toBe('4 s');
    expect(ageText(150_000)).toBe('3 min');
    expect(ageText(null)).toBe('no data');
  });
});

describe('valve rings (ticket 03)', () => {
  it('rings each valve by its commanded position', () => {
    const o = overlayOf(PID, frame(), NAMES);
    expect(ring(o, 'LOX Main')).toMatchObject({ open: false, stale: false, mismatch: null });
    expect(ring(o, 'LOX Press')).toMatchObject({ open: true });
  });

  it('believes the DAQ over the drawing on NO/NC, and says so', () => {
    // The drawing has OU_SOL_R normally closed; the DAQ has LOX Press NO.
    const o = overlayOf(PID, frame(), NAMES);
    expect(ring(o, 'LOX Press').disagree).toBe('DAQ: NO');
    expect(ring(o, 'LOX Main').disagree).toBeNull();
    expect(o.health.disagree).toEqual(['LOX Press (drawing NC, DAQ NO)']);
  });

  it('expects no coil current on an open NO valve, and current on an open NC one', () => {
    const nc = NAMES.get('lox main');
    const no = NAMES.get('lox press');
    expect(valveMismatch(valve(true, { currentA: 0.6 }), nc)).toBeNull();
    expect(valveMismatch(valve(true, { currentA: 0.01 }), nc)).toMatch(/commanded on/);
    expect(valveMismatch(valve(true, { currentA: 0.01 }), no)).toBeNull();
    expect(valveMismatch(valve(true, { currentA: 0.6 }), no)).toMatch(/commanded off/);
    expect(valveMismatch(valve(false, { currentA: 0.6 }), no)).toBeNull();
  });

  it('waits out the grace period before calling a mismatch', () => {
    const nc = NAMES.get('lox main');
    expect(valveMismatch(valve(true, { currentA: 0, sinceChangeMs: COIL_GRACE_MS - 1 }), nc)).toBeNull();
    expect(valveMismatch(valve(true, { currentA: 0, sinceChangeMs: COIL_GRACE_MS + 1 }), nc)).not.toBeNull();
  });

  it('judges a ball valve on its position, with a travel-length grace', () => {
    const bv = NAMES.get('ball');
    expect(valveMismatch(valve(true, { positionPct: 40, sinceChangeMs: BALL_VALVE_GRACE_MS - 1 }), bv)).toBeNull();
    expect(valveMismatch(valve(true, { positionPct: 40, sinceChangeMs: BALL_VALVE_GRACE_MS + 1 }), bv)).toBe('commanded open, at 40%');
    expect(valveMismatch(valve(false, { positionPct: 3 }), bv)).toBeNull();
    expect(ring(overlayOf(PID, frame(), NAMES), 'Ball').position).toBe('98% open');
  });

  it('dashes the ring and calls no mismatch on stale state', () => {
    const r = ring(overlayOf(PID, frame({ valves: { 'LOX Main': valve(true, { ageMs: 9000, currentA: 0 }) } }), NAMES), 'LOX Main');
    expect(r.stale).toBe(true);
    expect(r.mismatch).toBeNull();
  });
});

describe('pressure shading by section (ticket 05)', () => {
  it('shades a section by its transducer against its limit', () => {
    const o = overlayOf(PID, frame(), NAMES);
    expect(o.lines.a).toEqual({ color: shade(512.4 / 1000), dashed: false });
    expect(o.lines.c).toEqual({ color: shade(300 / 750), dashed: false });
  });

  it('dashes a section no transducer reads, and greys one whose transducers are stale', () => {
    expect(overlayOf(PID, frame(), NAMES).lines.d).toEqual({ color: UNMEASURED, dashed: true });
    const o = overlayOf(PID, frame({ samples: { 'Ox Upstream': { value: 500, ageMs: 9000, staleAfterMs: 1500 } } }), NAMES);
    expect(o.lines.a).toEqual({ color: UNMEASURED, dashed: false });
  });

  it('names the limit each section is drawn against', () => {
    // Only drawn limits are named; full scale is the page's one-line default.
    expect(overlayOf(PID, frame(), NAMES).legend).toEqual([
      { section: 'Ox Downstream', source: '750 psig, LOX burst 1500 psig / 2' },
    ]);
  });

  it('shades by the higher of two transducers and says when they disagree', () => {
    const two = { ...PID, sectionOf: { pt: 's1', pt2: 's1' } };
    const o = overlayOf(two, frame({ samples: { 'Ox Upstream': live(500), 'Ox Downstream': live(400) } }), NAMES);
    expect(o.lines.a.color).toBe(shade(0.5));
    expect(o.splits.map((s) => s.text)).toEqual(['100 psi apart']);
    const close = overlayOf(two, frame({ samples: { 'Ox Upstream': live(500), 'Ox Downstream': live(490) } }), NAMES);
    expect(close.splits).toEqual([]);
  });

  it('runs cool to red, and never through grey', () => {
    expect(shade(0)).toBe('rgb(96, 165, 250)');
    // A third of the limit (GSE Low at 310 of 1000 on LE4) came out olive-grey, like no data.
    for (const f of [0.2, 0.31, 0.45]) {
      const [r, g, b] = shade(f).match(/\d+/g)!.map(Number);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(60);
    }
    expect(shade(1)).toBe('rgb(239, 68, 68)');
    expect(shade(7)).toBe(shade(1));
  });

  it('styles only the drawn stroke of each line, dashed where unmeasured', () => {
    const css = lineStyles({ a: { color: 'red', dashed: false }, d: { color: UNMEASURED, dashed: true } });
    expect(css).toContain('[data-pid-line="a"] path.react-flow__edge-path{stroke:red !important;}');
    expect(css).toMatch(/\[data-pid-line="d"\][^}]*stroke-dasharray/);
  });

  it('widens the lines to the width the view asks for, dashes scaled with them', () => {
    const css = lineStyles({ d: { color: UNMEASURED, dashed: true } }, 5.5);
    expect(css).toContain('stroke-width:5.50px !important;');
    expect(css).toContain('stroke-dasharray:13.75 11.00 !important;');
  });
});

describe('legibility (ticket 07)', () => {
  const r = (name: string, x: number, y: number, text = '512'): Reading =>
    ({ symbol: name, name, kind: 'pressure', x, y, text, state: 'live' });

  it('moves a reading up until it overlaps no other', () => {
    const out = placeLabels([r('a', 100, 500), r('b', 110, 505), r('c', 105, 510)], 30);
    const ys = out.map((o) => o.y).sort((p, q) => q - p);
    for (let i = 1; i < ys.length; i++) expect(ys[i - 1] - ys[i]).toBeGreaterThanOrEqual(30);
  });

  it("keeps a ring's NO/NC note off the reading above the next symbol", () => {
    // LOX Press's ring sits just above a transducer: its "DAQ: NO" below the ring and the
    // transducer's reading above its symbol started on the same line.
    const tight: StandPid = {
      ...PID,
      boxes: { ...PID.boxes, press: [100, 100, 40, 40], pt: [100, 180, 40, 40] },
    };
    const o = overlayOf(tight, frame(), NAMES, { lineHeight: 30 });
    const note = ring(o, 'LOX Press').labelY;
    const r = reading(o, 'Ox Upstream').y;
    expect(Math.abs(note - r)).toBeGreaterThanOrEqual(30);
  });

  it('leaves readings that are apart where they are', () => {
    const out = placeLabels([r('a', 100, 500), r('b', 900, 500)], 30);
    expect(out.map((o) => o.y)).toEqual([500, 500]);
  });
});

describe('valve symbol colours', () => {
  const ring = (over: Partial<Ring>): Ring => ({
    symbol: 'main', name: 'Fuel Main', cx: 0, cy: 0, r: 10, open: true, stale: false,
    mismatch: null, position: null, disagree: null, labelY: 0, ...over,
  });

  it('is green open, red shut, and dashed grey when stale or with no state', () => {
    expect(valveColour(ring({ open: true }))).toEqual({ color: VALVE_COLOURS.open, dashed: false });
    expect(valveColour(ring({ open: false }))).toEqual({ color: VALVE_COLOURS.shut, dashed: false });
    expect(valveColour(ring({ open: true, stale: true }))).toEqual({ color: VALVE_COLOURS.stale, dashed: true });
    expect(valveColour(ring({ open: null }))).toEqual({ color: VALVE_COLOURS.stale, dashed: true });
  });

  it('strokes the shapes inside the valve symbol, never its text, dashing only an unknown state', () => {
    const css = valveStyles([ring({ symbol: 'a', open: false }), ring({ symbol: 'b', open: null })]);
    const rule = (id: string) => css.split('\n').find((l) => l.includes(`[data-pid-symbol="${id}"] path`)) ?? '';
    expect(rule('a')).toContain(`stroke:${VALVE_COLOURS.shut} !important;`);
    expect(rule('a')).not.toContain('stroke-dasharray');
    expect(rule('b')).toContain(`stroke:${VALVE_COLOURS.stale} !important;`);
    expect(rule('b')).toContain('stroke-dasharray');
    expect(css).not.toMatch(/ text[,{]/);
  });

  it('draws the stroke at the width it is given, with the dash scaled to it', () => {
    // 3 screen px at a 27 % fit is 3 / 0.27 stand px, half that in flow units.
    const w = 3 / 0.27 / 2;
    const css = valveStyles([ring({ symbol: 'a', open: true, stale: true })], w);
    expect(css).toContain(`stroke-width:${w.toFixed(2)}px !important;`);
    expect(css).toContain(`stroke-dasharray:${(w * 2).toFixed(2)} ${(w * 1.3).toFixed(2)} !important;`);
    expect(valveStyles([ring({ symbol: 'a' })])).not.toContain('stroke-width');
  });

  it('colours the valves the overlay finds on the stand', () => {
    const o = overlayOf(PID, frame(), NAMES, { lineHeight: 20 });
    const css = valveStyles(o.rings);
    for (const r of o.rings) expect(css).toContain(`[data-pid-symbol="${r.symbol}"]`);
  });
});
