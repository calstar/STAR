/**
 * Golden-master harness for the backend's calibration TypeScript (test-only).
 *
 *   cd diablo_server/backend && npx tsx ../../test/characterization/calibration/ts_harness.mts <fixtures>
 *
 * Freezes calibration-handler.ts, lc-tare.ts, ball-valve-cal.ts and routes/calibration-profiles.ts.
 * Every file they read or write is under a private temp dir (DAQ_CALIBRATIONS_DIR,
 * RUNNING_CONFIG_PATH); nothing touches the live calibration store. The clock and Math.random are
 * pinned, so the output is a function of the inputs alone. (calibration.ts, the backend's legacy PT
 * coefficient store, was deleted with save_coefficients / clear_calibration: C3-2; its section here
 * went with it, since there is nothing left to characterize.)
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const FIX = path.resolve(process.argv[2] ?? '');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'char_cal_ts.'));
const CAL = path.join(TMP, 'calibrations');
fs.mkdirSync(CAL, { recursive: true });
process.env.DAQ_CALIBRATIONS_DIR = CAL;
fs.copyFileSync(path.join(FIX, 'stack_config.toml'), path.join(TMP, 'config.toml'));
fs.copyFileSync(path.join(FIX, 'ts_config_noboards.toml'), path.join(TMP, 'noboards.toml'));
process.env.RUNNING_CONFIG_PATH = path.join(TMP, 'config.toml');

// Pinned clock and a seeded generator (xorshift32), so nothing here can depend on either.
const FIXED_NOW = 1757000000123;
Date.now = () => FIXED_NOW;
let seed = 0x2545f491;
Math.random = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};

// Module chatter goes to stderr; stdout is the golden.
const toErr = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n');
console.log = toErr;
console.warn = toErr;
console.error = toErr;
console.info = toErr;

/** JSON that keeps NaN, +/-Infinity, -0, undefined, bigint and Map distinct. */
function show(v: unknown): string {
  return JSON.stringify(v, function (_k, x) {
    if (typeof x === 'number') {
      if (Number.isNaN(x)) return '<NaN>';
      if (x === Infinity) return '<+Inf>';
      if (x === -Infinity) return '<-Inf>';
      if (Object.is(x, -0)) return '<-0>';
      return x;
    }
    if (x === undefined) return '<undefined>';
    if (typeof x === 'bigint') return `<bigint ${x}>`;
    if (x instanceof Map) return { '<Map>': [...x.entries()] };
    if (x instanceof Set) return { '<Set>': [...x.values()] };
    if (x instanceof Uint8Array) return `<bytes ${Buffer.from(x).toString('hex')}>`;
    return x;
  }) ?? 'undefined';
}
const out: string[] = [];
const p = (label: string, v?: unknown) => out.push(v === undefined ? label : `${label} = ${show(v)}`);
const section = (name: string) => out.push(`\n== ${name} ==`);
const rel = (s: string) => s.split(TMP).join('<TMP>');
const tryCall = (label: string, f: () => unknown) => {
  try {
    p(label, f());
  } catch (e) {
    p(`${label} THREW`, rel(String((e as Error).message)));
  }
};
const listDir = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return ['<absent>'];
  const res: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) res.push(...listDir(full).map((x) => `${e.name}/${x}`));
    else res.push(e.name);
  }
  return res;
};
const dumpFile = (label: string, file: string) => {
  out.push(`--- ${label} ---`);
  out.push(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '<absent>');
  out.push(`--- end ${label} ---`);
};

const handler = await import('../../../diablo_server/backend/src/calibration-handler.ts');
const tare = await import('../../../diablo_server/backend/src/lc-tare.ts');
const bv = await import('../../../diablo_server/backend/src/ball-valve-cal.ts');
const prof = await import('../../../diablo_server/backend/src/routes/calibration-profiles.ts');

// ── calibration-handler.ts ──────────────────────────────────────────────────────────────────────
section('calibration-handler.ts');
function fakeHost(withElodin: boolean, extra: Record<string, unknown> = {}) {
  const log: string[] = [];
  const host: any = {
    lastRawAdc: new Map<number, number>([[2101, 5]]),
    send: (_ws: unknown, m: unknown) => log.push(`send ${show(m)}`),
    broadcast: (m: unknown) => log.push(`broadcast ${show(m)}`),
    ...extra,
  };
  if (withElodin)
    host.elodin = { publishTable: (id: number[], payload: Buffer) => log.push(`publish [${id.map((x) => x.toString(16)).join(',')}] ${payload.toString('hex')}`) };
  return { host, log };
}
const cmds: Array<[string, any]> = [
  ['capture_reference ok', { commandType: 'capture_reference', sensorId: 1, boardId: 21, referencePressure: 250.5 }],
  ['capture_reference no ref', { commandType: 'capture_reference', sensorId: 1, boardId: 21 }],
  ['capture_reference bad ref', { commandType: 'capture_reference', sensorId: 1, boardId: 21, referencePressure: 'x' }],
  ['capture_reference not active', { commandType: 'capture_reference', sensorId: 9, boardId: 21, referencePressure: 1 }],
  ['capture_reference uid form', { commandType: 'capture_reference', sensorId: 4201, referencePressure: 1 }],
  ['capture_cubic_point', { commandType: 'capture_cubic_point', sensorId: 3, boardId: 22, referencePressure: '1250' }],
  ['capture_cubic_point bad', { commandType: 'capture_cubic_point', sensorId: 3, boardId: 22, referencePressure: null }],
  ['clear_cubic_channel', { commandType: 'clear_cubic_channel', sensorId: 3, boardId: 21 }],
  ['clear_cubic_channel none', { commandType: 'clear_cubic_channel' }],
  ['tare_lc one', { commandType: 'tare_lc', sensorId: 1, boardId: 42 }],
  ['tare_lc all', { commandType: 'tare_lc' }],
  ['clear_tare_lc one', { commandType: 'clear_tare_lc', sensorId: 6, boardId: 42 }],
  ['clear_tare_lc all zero', { commandType: 'clear_tare_lc', sensorId: 0 }],
  ['tare_lc unknown', { commandType: 'tare_lc', sensorId: 5, boardId: 42 }],
  ['tare_lc t7', { commandType: 'tare_lc', sensorId: 4, boardId: 81 }],
  ['capture_point', { commandType: 'capture_point', sensorId: 6, boardId: 81, referencePressure: -3.25 }],
  ['capture_point big ref', { commandType: 'capture_point', sensorId: 1, boardId: 21, referencePressure: 1e40 }],
  ['capture_point not active', { commandType: 'capture_point', sensorId: 2, boardId: 81, referencePressure: 1 }],
  ['new_calibration', { commandType: 'new_calibration', sensorId: 2, boardId: 42 }],
  ['new_calibration none', { commandType: 'new_calibration' }],
  ['enable_phase2', { commandType: 'enable_phase2' }],
  ['disable_phase2', { commandType: 'disable_phase2' }],
  ['reset_channel', { commandType: 'reset_channel' }],
  ['zero_all', { commandType: 'zero_all' }],
  // The legacy store's two commands are gone (C3-2): both are now the unknown-command path.
  ['save_coefficients', { commandType: 'save_coefficients' }],
  ['clear_calibration', { commandType: 'clear_calibration' }],
  ['unknown', { commandType: 'bogus' }],
  ['null payload', null],
];
for (const withElodin of [true, false]) {
  for (const [label, payload] of cmds) {
    const { host, log } = fakeHost(withElodin);
    handler.handleCalibrationCommand(host, {} as any, payload);
    p(`${withElodin ? 'elodin' : 'no-elodin'} ${label}`, log);
    if (label === 'clear_calibration')
      p('  host after clear_calibration', { raw: host.lastRawAdc });
  }
}
{
  const { host, log } = fakeHost(true);
  handler.publishCalibrationReload(host);
  handler.publishClearAllTares(host);
  p('publishCalibrationReload + publishClearAllTares', log);
  const none = fakeHost(false);
  handler.publishCalibrationReload(none.host);
  p('publish without elodin', none.log);
}
// getActiveChannels' fallbacks, with a config that names no PT / LC board.
process.env.RUNNING_CONFIG_PATH = path.join(TMP, 'noboards.toml');
for (const [label, extra] of [
  ['board maps', { boardChannelToEntityMaps: new Map([['127.0.0.21', { 1: 'a', 2: 'b' }], ['127.0.0.9', { 4: 'c' }]]), ipToBoardId: new Map([['127.0.0.21', 21]]) }],
  ['channel map', { channelToEntityMap: { 3: 'x', 7: 'y' } }],
  ['nothing', {}],
] as Array<[string, Record<string, unknown>]>) {
  for (const sid of [1, 3, 4, 7, 10, 11]) {
    const { host, log } = fakeHost(true, extra);
    handler.handleCalibrationCommand(host, {} as any, { commandType: 'capture_point', sensorId: sid, boardId: label === 'board maps' ? 21 : 1, referencePressure: 1 });
    p(`fallback ${label} sensor ${sid}`, log[0]);
  }
}
process.env.RUNNING_CONFIG_PATH = path.join(TMP, 'missing.toml');
{
  const { host, log } = fakeHost(true);
  handler.handleCalibrationCommand(host, {} as any, { commandType: 'capture_point', sensorId: 5, boardId: 1, referencePressure: 1 });
  p('unreadable config, channel 105', log[0]);
}
process.env.RUNNING_CONFIG_PATH = path.join(TMP, 'config.toml');

// ── lc-tare.ts ──────────────────────────────────────────────────────────────────────────────────
section('lc-tare.ts');
p('tarePath', rel(prof.tarePath()));
p('COMPONENT_TARED', tare.COMPONENT_TARED);
tare.resetTareState();
const runDir = path.join(TMP, 'run');
tare.setRunDir(runDir);
const tp = prof.tarePath();
let mtime = 1757000000;
const writeTare = (text: string) => {
  fs.writeFileSync(tp, text);
  mtime += 10;
  fs.utimesSync(tp, mtime, mtime);
};
const samples = (): any[] => [
  { entity: 'LC2_Cal.CH1', component: 'force_kg', value: 30.5, timestamp: 1 },
  { entity: 'LC2_Cal.CH1', component: 'raw_adc', value: 123, timestamp: 1 },
  { entity: 'LC2_Cal.CH6', component: 'force_kg', value: -2, timestamp: 2 },
  { entity: 'T71_Cal.AIN4', component: 'force_kg', value: 125, timestamp: 3 },
  { entity: 'LC9_Cal.CH9', component: 'force_kg', value: 7, timestamp: 4 },
  { entity: 'LC2_Cal.CH1', component: 'force_kg', value: NaN, timestamp: 5 },
];
p('absent: map', tare.loadTareMap());
p('absent: expand', tare.expandWithTare(samples()));
writeTare(fs.readFileSync(path.join(FIX, 'lc_tare.json'), 'utf8'));
p('fixture: map', tare.loadTareMap());
p('fixture: offsets', ['LC2_Cal.CH1', 'LC2_Cal.CH6', 'T71_Cal.AIN4', 'nope', 'ignored'].map((e) => tare.tareOffsetKg(e)));
p('fixture: expand', tare.expandWithTare(samples()));
p('fixture: current', tare.currentTares());
p('no force rows: expand returns same array', (() => { const s = [{ entity: 'x', component: 'y', value: 1, timestamp: 0 }]; return tare.expandWithTare(s as any) === s; })());
writeTare(JSON.stringify({ tares: [
  { uid: 4201, entity: 'LC2_Cal.CH1', adc_at_tare: 1100000, offset_kg: 20, set_at_ms: 5, curve_fp: 1 },
  { uid: 4206, entity: 'LC2_Cal.CH6', adc_at_tare: 4100000, offset_kg: 1, set_at_ms: 6, curve_fp: 1 },
  { uid: 'x', entity: 'LC3_Cal.CH2', adc_at_tare: 'n', offset_kg: 2.5, set_at_ms: null },
  { uid: 1, entity: '', offset_kg: 1 },
  { uid: 2, entity: 'LC3_Cal.CH3', offset_kg: 'NaN' },
  null,
] }));
p('changed: map', tare.loadTareMap());
writeTare('{"tares": [ {"entity": "LC2_Cal.CH1", "offset_k');
p('torn: map (held)', tare.loadTareMap());
writeTare('{"no": 1}');
p('no tares array: map (held)', tare.loadTareMap());
fs.unlinkSync(tp);
p('removed: map', tare.loadTareMap());
writeTare(fs.readFileSync(path.join(FIX, 'lc_tare.json'), 'utf8'));
p('rewritten: map', tare.loadTareMap());
tare.clearTareFile();
p('clearTareFile: exists', fs.existsSync(tp));
p('after clearTareFile: map', tare.loadTareMap());
tare.clearTareFile();
dumpFile('run lc_tare.jsonl', path.join(runDir, 'lc_tare.jsonl'));
tare.setRunDir(null);
writeTare(fs.readFileSync(path.join(FIX, 'lc_tare.json'), 'utf8'));
p('no run dir: map', tare.loadTareMap());
p('no run dir: jsonl unchanged lines', fs.readFileSync(path.join(runDir, 'lc_tare.jsonl'), 'utf8').split('\n').length);
fs.unlinkSync(tp);
tare.resetTareState();

// ── ball-valve-cal.ts ───────────────────────────────────────────────────────────────────────────
section('ball-valve-cal.ts');
p('constants', [bv.IDEAL_CLOSED_COUNTS, bv.IDEAL_OPEN_COUNTS, bv.MIN_SPAN_COUNTS, bv.CAPTURE_WINDOW_MS, bv.MIN_CAPTURE_SAMPLES]);
p('ballValveCalPath', rel(prof.ballValveCalPath()));
const eps: Array<[string, any]> = [
  ['ideal', {}], ['closed only', { closedCounts: 600 }], ['open only', { openCounts: 2000 }],
  ['both', { closedCounts: 520, openCounts: 2400 }], ['reversed', { closedCounts: 2400, openCounts: 520 }],
  ['narrow', { closedCounts: 1000, openCounts: 1099 }], ['exact span', { closedCounts: 1000, openCounts: 1100 }],
];
for (const [name, ep] of eps)
  p(`percentOpen ${name}`, [0, 247, 496, 520, 1000, 1050, 1489, 2000, 2400, 2482, 4095, -5, NaN, Infinity].map((c) => bv.percentOpen(c, ep)));
p('parseEndpointsFile', bv.parseEndpointsFile(JSON.stringify({ valves: {
  'BV1_Cal.CH1': { closed_counts: 500, open_counts: 2470, closed_at_ms: 1, open_at_ms: 2 },
  'BV1_Cal.CH2': { open_counts: 2400 },
  'BV1_Cal.CH3': { closed_counts: 'x' },
  'BV1_Cal.CH4': null,
  'PT1_Cal.CH1': { closed_counts: 1 },
  'BV2_Cal.CH10': { closed_counts: 480.5, closed_at_ms: 'n' },
} })));
// The message text is V8's and differs between Node versions; the error class is what matters.
try {
  bv.parseEndpointsFile('{');
  p('parseEndpointsFile(garbage) returned');
} catch (e) {
  p('parseEndpointsFile(garbage) THREW', (e as Error).name);
}
p('parseEndpointsFile(empty obj)', bv.parseEndpointsFile('{}'));
bv._resetValveCalForTest();
const bvRows = (entity: string, raw: number, status: number, value: number) => [
  { entity, component: 'position_pct', value, timestamp: 1 },
  { entity, component: 'raw_adc', value: raw, timestamp: 1 },
  { entity, component: 'cal_status', value: status, timestamp: 1 },
];
let t = 1757000000000;
p('apply, no endpoints', bv.applyValveCalibration(bvRows('BV1_Cal.CH1', 600, 1, 6.5), t));
p('capture closed, one sample', bv.captureEndpoint('BV1_Cal.CH1', 'closed', t));
for (let i = 0; i < 5; i++) bv.applyValveCalibration(bvRows('BV1_Cal.CH1', 600 + i, 1, 6.5), (t += 100));
p('capture closed', bv.captureEndpoint('BV1_Cal.CH1', 'closed', t));
p('capture open too close', (() => { for (let i = 0; i < 4; i++) bv.applyValveCalibration(bvRows('BV1_Cal.CH1', 650, 1, 7), (t += 100)); return bv.captureEndpoint('BV1_Cal.CH1', 'open', t); })());
for (let i = 0; i < 12; i++) bv.applyValveCalibration(bvRows('BV1_Cal.CH1', 2390 + (i % 3), 1, 95), (t += 100));
p('capture open', bv.captureEndpoint('BV1_Cal.CH1', 'open', t));
p('apply with endpoints', bv.applyValveCalibration(bvRows('BV1_Cal.CH1', 1500, 1, 50), (t += 100)));
p('apply no signal', bv.applyValveCalibration(bvRows('BV1_Cal.CH1', 10, 2, 0), (t += 100)));
p('capture while no signal in window', bv.captureEndpoint('BV1_Cal.CH1', 'closed', t));
p('apply other entity, raw missing', bv.applyValveCalibration([{ entity: 'BV1_Cal.CH2', component: 'position_pct', value: 3, timestamp: 1 }] as any, t));
p('apply non-BV', bv.applyValveCalibration(bvRows('PT1_Cal.CH1', 1500, 1, 50), t));
p('capture bad entity', bv.captureEndpoint('PT1_Cal.CH1', 'open', t));
p('snapshot', bv.valveCalibrationSnapshot(t));
p('snapshot later (window empty)', bv.valveCalibrationSnapshot(t + 5000));
dumpFile('ball_valve_endpoints.json', prof.ballValveCalPath());
bv.clearEndpoints('BV1_Cal.CH9');
bv.clearEndpoints('BV1_Cal.CH1');
dumpFile('ball_valve_endpoints.json after clear', prof.ballValveCalPath());
p('loadEndpoints', bv.loadEndpoints());

// ── routes/calibration-profiles.ts ──────────────────────────────────────────────────────────────
section('routes/calibration-profiles.ts');
for (const n of ['default', 'restored-sep05', 'a', 'A_b-9', '-x', '_x', '', 'has space', 'x'.repeat(64), 'x'.repeat(65), '../etc', 'é'])
  tryCall(`assertValidProfileName(${JSON.stringify(n)})`, () => prof.assertValidProfileName(n));
p('paths', [prof.livePath(), prof.tarePath(), prof.profilesDir(), prof.ballValveCalPath()].map(rel));
p('list (no profiles dir)', prof.listCalibrationProfiles());
tryCall('save with no live store', () => prof.saveCalibrationProfile('nolive'));
tryCall('newBlankCalibration() with nothing on disk', () => prof.newBlankCalibration());
dumpFile('live after blank-from-nothing', prof.livePath());
fs.copyFileSync(path.join(FIX, 'cubic_calibration.default.json'), path.join(CAL, 'cubic_calibration.default.json'));
fs.unlinkSync(prof.livePath());
tryCall('newBlankCalibration() from default', () => prof.newBlankCalibration());
dumpFile('live after blank-from-default', prof.livePath());
fs.mkdirSync(prof.profilesDir(), { recursive: true });
fs.copyFileSync(path.join(FIX, 'profiles/default.json'), path.join(prof.profilesDir(), 'default.json'));
fs.copyFileSync(path.join(FIX, 'profiles/restored-sep05.json'), path.join(prof.profilesDir(), 'restored-sep05.json'));
fs.writeFileSync(path.join(prof.profilesDir(), 'bad name.json'), '{}');
fs.writeFileSync(path.join(prof.profilesDir(), 'notes.txt'), 'x');
p('list', prof.listCalibrationProfiles());
tryCall('load restored-sep05', () => prof.loadCalibrationProfile('restored-sep05'));
p('live == restored-sep05', fs.readFileSync(prof.livePath(), 'utf8') === fs.readFileSync(path.join(FIX, 'profiles/restored-sep05.json'), 'utf8'));
p('list after load', prof.listCalibrationProfiles());
tryCall('load missing', () => prof.loadCalibrationProfile('missing'));
tryCall('load invalid name', () => prof.loadCalibrationProfile('../x'));
tryCall('save as mine', () => prof.saveCalibrationProfile('mine'));
p('list after save', prof.listCalibrationProfiles());
tryCall('newBlankCalibration("blank1") from live restored-sep05', () => prof.newBlankCalibration('blank1'));
dumpFile('profiles/blank1.json', path.join(prof.profilesDir(), 'blank1.json'));
p('live == blank1', fs.readFileSync(prof.livePath(), 'utf8') === fs.readFileSync(path.join(prof.profilesDir(), 'blank1.json'), 'utf8'));
tryCall('newBlankCalibration("bad name")', () => prof.newBlankCalibration('bad name'));
p('list after blank1', prof.listCalibrationProfiles());
tryCall('create copy2 from default', () => prof.createCalibrationProfile('copy2', 'default'));
tryCall('create blank3', () => prof.createCalibrationProfile('blank3'));
tryCall('create existing', () => prof.createCalibrationProfile('copy2'));
tryCall('create from missing', () => prof.createCalibrationProfile('copy4', 'nope'));
p('copy2 == default', fs.readFileSync(path.join(prof.profilesDir(), 'copy2.json'), 'utf8') === fs.readFileSync(path.join(FIX, 'profiles/default.json'), 'utf8'));
dumpFile('profiles/blank3.json', path.join(prof.profilesDir(), 'blank3.json'));
fs.writeFileSync(prof.livePath(), '{ torn');
tryCall('create blank5 from a torn live store', () => prof.createCalibrationProfile('blank5'));
dumpFile('profiles/blank5.json', path.join(prof.profilesDir(), 'blank5.json'));
fs.writeFileSync(prof.livePath(), JSON.stringify({ cubic_state: { '1': null, '2': { coeffs: { A: 1, Z: 2 }, points: [1], extra: true } }, lc_calibration_polynomials: { '11': [1] }, other: 5 }));
tryCall('create blank6 from an odd store', () => prof.createCalibrationProfile('blank6'));
dumpFile('profiles/blank6.json', path.join(prof.profilesDir(), 'blank6.json'));
tryCall('remove blank3', () => prof.removeCalibrationProfile('blank3'));
tryCall('remove missing', () => prof.removeCalibrationProfile('never'));
tryCall('remove invalid', () => prof.removeCalibrationProfile('../x'));
tryCall('newBlankCalibration() clears active', () => prof.newBlankCalibration());
p('list final', prof.listCalibrationProfiles());
p('files', listDir(CAL));
dumpFile('profiles/.active', path.join(prof.profilesDir(), '.active'));

process.stdout.write(out.join('\n') + '\n');
fs.rmSync(TMP, { recursive: true, force: true });
