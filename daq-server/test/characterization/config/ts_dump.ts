/**
 * Characterization dump of the TypeScript config loaders (area "config"). Run by check.sh as
 *
 *   cd diablo_server/backend && npx tsx <this file>
 *
 * with CONFIG_PATH / DAQ_CALIBRATIONS_DIR / VIDEO_CONFIG_PATH pointing into a scratch copy of
 * config/, because several of these loaders write (getConfigPath self-heals config.toml, the
 * profile functions write .active_profile). Writes one file per (loader, input) under
 * CHAR_CFG_OUT; check.sh diffs each against golden/ts/.
 *
 * Output is canonical: object keys sorted, Map/Set as sorted arrays, an Error as `name: message`
 * (a stack carries paths and line numbers), and the scratch directory replaced by <WORK>.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';

import {
  CONFIG_PAGE_LABELS,
  ballValveBoardIds,
  boardDisplayName,
  boardGivenName,
  boardSlotIssue,
  countByLevel,
  diffKeys,
  groupIssuesByPage,
  parseCsvGrid,
  recoveryAddress,
  serializeCsvGrid,
  t7BoardIssues,
  t7BoardSettingsIssues,
  t7ChannelIssues,
  t7Channels,
  t7RoleClashes,
  validateConfigForRun,
} from '../../../diablo_server/shared/config-validation.js';
import {
  checkScriptNames,
  isValidScriptFilename,
  isValidSlug,
  renameScriptSlug,
  scanScriptNames,
  slugify,
  type ScriptNameTables,
} from '../../../diablo_server/shared/state-script-names.js';
import { caretContext, tokenize } from '../../../diablo_server/shared/state-script-tokens.js';
import { completionsAt } from '../../../diablo_server/shared/state-script-complete.js';
import {
  applyCalibrationModelDefaults,
  getConfigPath,
  readConfig,
  setRunningConfigPath,
  writeConfig,
} from '../../../diablo_server/backend/src/routes/config.js';
import {
  getActiveProfileName,
  isStateCsvName,
  listProfiles,
  listStateScripts,
  profileDir,
  readActiveProfile,
  readStateCsv,
  readStateScript,
  setActiveProfileName,
  undeployedChanges,
} from '../../../diablo_server/backend/src/routes/config-profiles.js';
import {
  assertValidProfileName,
  listCalibrationProfiles,
} from '../../../diablo_server/backend/src/routes/calibration-profiles.js';
import { validateActiveProfile } from '../../../diablo_server/backend/src/config-validation.js';
import {
  hpBoardNumbers,
  isCurrentLoopBoard,
  loadActuatorChannelToEntityMap,
  loadLcBoardConfig,
  loadRtdBoardConfig,
  loadSensorRoleMap,
  loadTcBoardConfig,
  t7CalFields,
} from '../../../diablo_server/backend/src/sensor-config.js';
import { applyControllerDefaults } from '../../../diablo_server/backend/src/controller-config.js';
import { loadVideoConfig, validateVideoConfig } from '../../../diablo_server/backend/src/video/config.js';

const HERE = process.env.CHAR_CFG_HERE!;
const WORK = process.env.CHAR_CFG_WORK!;
const OUT = process.env.CHAR_CFG_OUT!;
const CFG = join(HERE, '../../../config');
const BAD = join(HERE, 'fixtures/bad');

// ── Canonical text ───────────────────────────────────────────────────────────────────────────────
function scrub(s: string): string {
  return s.split(WORK).join('<WORK>').split(HERE).join('<AREA>');
}
function canon(v: any): any {
  if (v instanceof Error) return `${v.name}: ${scrub(v.message)}`;
  if (v instanceof Map)
    return [...v.entries()].map(([k, x]) => [canon(k), canon(x)]).sort((a, b) =>
      JSON.stringify(a[0]) < JSON.stringify(b[0]) ? -1 : 1);
  if (v instanceof Set) return [...v].map(canon).sort();
  if (Array.isArray(v)) return v.map(canon);
  if (v === undefined) return '<undefined>';
  if (typeof v === 'number' && !Number.isFinite(v)) return `<${v}>`;
  if (typeof v === 'string') return scrub(v);
  if (v && typeof v === 'object') {
    const o: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
const pretty = (v: any) => JSON.stringify(canon(v), null, 2) + '\n';

// Every console line a loader prints, captured into the dump it belongs to.
let logs: string[] = [];
for (const level of ['log', 'warn', 'error', 'info'] as const) {
  (console as any)[level] = (...args: any[]) => {
    logs.push(`${level}: ` + args.map((a) => (typeof a === 'string' ? scrub(a) : JSON.stringify(canon(a)))).join(' '));
  };
}
function capture<T>(fn: () => T): { value?: T; error?: string; logs: string[] } {
  logs = [];
  try {
    const value = fn();
    return { value, logs };
  } catch (e) {
    return { error: canon(e), logs };
  }
}

function emit(rel: string, body: string): void {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

const slug = (p: string) =>
  p.startsWith(CFG + '/') ? p.slice(CFG.length + 1).split('/').join('__')
    : 'bad__' + p.slice(BAD.length + 1).split('/').join('__');

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────
const tracked = [
  'config_base.toml', 'config_flight_daq.toml', 'config_ground_daq.toml', 'config_sitl.toml',
  ...readdirSync(join(CFG, 'profiles')).sort().map((p) => `profiles/${p}/config.toml`),
].map((f) => join(CFG, f));
const bad = [...readdirSync(BAD).filter((f) => f.endsWith('.toml')).sort(), 'does_not_exist.toml'].map((f) => join(BAD, f));
const profiles = readdirSync(join(CFG, 'profiles')).sort();

const csvDirFor = (p: string) =>
  p.startsWith(join(CFG, 'profiles') + '/') ? dirname(p) : join(CFG, 'profiles', 'default');
const readCsvs = (dir: string) => ({
  actuators: readFileSync(join(dir, 'state_machine_actuators.csv'), 'utf-8'),
  delays: readFileSync(join(dir, 'state_machine_actuator_delays.csv'), 'utf-8'),
  transitions: readFileSync(join(dir, 'state_transitions.csv'), 'utf-8'),
});

// ── Per config file ─────────────────────────────────────────────────────────────────────────────
for (const path of [...tracked, ...bad]) {
  const name = slug(path);
  const read = capture(() => readConfig(path));
  emit(`readConfig/${name}.json`, pretty(read));
  const cfg = read.value;
  if (!cfg) continue;

  const csvs = readCsvs(csvDirFor(path));
  const issues = capture(() => validateConfigForRun(structuredClone(cfg), csvs));
  emit(`validateConfigForRun/${name}.json`, pretty({
    ...issues,
    counts: issues.value ? countByLevel(issues.value) : null,
    grouped: issues.value ? groupIssuesByPage(issues.value) : null,
  }));
  // Without the CSVs, which is how the editor validates a TOML-only change.
  emit(`validateConfigForRun/${name}.no_csv.json`, pretty(capture(() => validateConfigForRun(structuredClone(cfg)))));

  // Board helpers the editor renders per board.
  const boards = cfg.boards ?? {};
  const perBoard: Record<string, any> = {};
  for (const key of Object.keys(boards).sort()) {
    perBoard[key] = {
      boardGivenName: capture(() => boardGivenName(boards[key])),
      boardDisplayName: capture(() => boardDisplayName(boards, key)),
      boardSlotIssue: capture(() => boardSlotIssue(boards, key)),
      t7BoardIssues: capture(() => t7BoardIssues(boards, key)),
      t7BoardSettingsIssues: capture(() => t7BoardSettingsIssues(boards, key)),
      t7ChannelIssues: capture(() => t7ChannelIssues(boards, key)),
      isCurrentLoopBoard: capture(() => isCurrentLoopBoard(boards[key])),
      recoveryAddress: capture(() => recoveryAddress(String(boards[key]?.mac ?? ''))),
    };
  }
  emit(`boards/${name}.json`, pretty({
    perBoard,
    ballValveBoardIds: capture(() => ballValveBoardIds(cfg)),
    t7Channels: capture(() => t7Channels(boards)),
    t7RoleClashes: capture(() => t7RoleClashes(cfg)),
  }));

  // sensor-config.ts: everything it derives, read the way the server reads it (running config).
  setRunningConfigPath(path);
  emit(`sensor-config/${name}.json`, pretty({
    hpBoardNumbers: capture(() => hpBoardNumbers()),
    t7CalFields: capture(() => t7CalFields()),
    loadActuatorChannelToEntityMap: capture(() => loadActuatorChannelToEntityMap()),
    loadSensorRoleMap: capture(() => loadSensorRoleMap()),
    loadTcBoardConfig: capture(() => loadTcBoardConfig()),
    loadRtdBoardConfig: capture(() => loadRtdBoardConfig()),
    loadLcBoardConfig: capture(() => loadLcBoardConfig()),
  }));
  setRunningConfigPath(null);

  // The GUI's save path: readConfig -> writeConfig, byte for byte.
  const outToml = join(WORK, 'write', basename(path));
  mkdirSync(dirname(outToml), { recursive: true });
  const w = capture(() => writeConfig(structuredClone(cfg), outToml));
  emit(`writeConfig/${name}.toml`, (w.error ? `ERROR ${w.error}\n` : readFileSync(outToml, 'utf-8')));
  emit(`writeConfig/${name}.log.json`, pretty({ error: w.error, logs: w.logs }));
}

// Defaults applied to configs that carry nothing, on their own.
{
  const bare: any = { boards: { pt: { type: 'PT', pt_type: '4-20 mA absolute' }, pt2: { type: 'PT' } },
    sensor_roles_pt: { A: 1 }, sensor_roles_pt2: { B: 2 } };
  applyCalibrationModelDefaults(bare);
  const ctl: any = {};
  applyControllerDefaults(ctl);
  emit('defaults/applyDefaults.json', pretty({ applyCalibrationModelDefaults: bare, applyControllerDefaults: ctl }));
}

// ── State-machine CSVs: the editor's grid parser, round trip and key diffs ─────────────────────
{
  const csvFiles = [
    ...profiles.flatMap((p) => ['state_transitions.csv', 'state_machine_actuators.csv', 'state_machine_actuator_delays.csv']
      .map((f) => join(CFG, 'profiles', p, f))),
    ...readdirSync(join(BAD, 'csv')).sort().map((f) => join(BAD, 'csv', f)),
  ];
  for (const f of csvFiles) {
    const text = readFileSync(f, 'utf-8');
    const grid = capture(() => parseCsvGrid(text));
    const round = grid.value ? serializeCsvGrid(grid.value) : null;
    emit(`csv/${slug(f)}.json`, pretty({
      grid,
      roundTrip: round,
      roundTripIdentical: round === text,
      diffVsDefaultHeader: grid.value
        ? diffKeys(grid.value.states, parseCsvGrid(readFileSync(join(CFG, 'profiles/default/state_transitions.csv'), 'utf-8')).states)
        : null,
    }));
  }
}

// ── config-profiles.ts against the scratch config dir ──────────────────────────────────────────
{
  const out: Record<string, any> = {
    getConfigPath: capture(() => getConfigPath()),
    listProfiles: capture(() => listProfiles()),
    getActiveProfileName: capture(() => getActiveProfileName()),
    isStateCsvName: ['actuators', 'delays', 'transitions', 'positions', ''].map((n) => [n, isStateCsvName(n)]),
    profileDirRefusals: ['../etc', '', 'a b', 'x'.repeat(65), '-lead', 'ok_name-1'].map((n) =>
      [n, capture(() => profileDir(n)).error ?? 'accepted']),
  };
  for (const p of profiles) {
    setActiveProfileName(p);
    out[p] = {
      getActiveProfileName: capture(() => getActiveProfileName()),
      readActiveProfile: capture(() => readActiveProfile()),
      actuators: capture(() => readStateCsv('actuators')),
      delays: capture(() => readStateCsv('delays')),
      transitions: capture(() => readStateCsv('transitions')),
      listStateScripts: capture(() => listStateScripts()),
      scripts: Object.fromEntries((listStateScripts() ?? []).map((s) => [s, capture(() => readStateScript(s))])),
      readStateScriptRefusals: ['../config.toml', 'x.txt', 'no_such.script'].map((s) =>
        [s, capture(() => readStateScript(s)).error ?? 'accepted']),
      undeployedChanges: capture(() => undeployedChanges()),
      validateActiveProfile: capture(() => validateActiveProfile()),
    };
    emit(`config-profiles/${p}.json`, pretty(out[p]));
    delete out[p];
  }
  emit('config-profiles/_common.json', pretty(out));

  // A profile that fails to parse goes through the run gate as a "profile" issue.
  mkdirSync(join(WORK, 'config/profiles/broken'), { recursive: true });
  copyFileSync(join(BAD, 'malformed.toml'), join(WORK, 'config/profiles/broken/config.toml'));
  setActiveProfileName('broken');
  emit('config-profiles/broken.validateActiveProfile.json', pretty(capture(() => validateActiveProfile())));
  rmSync(join(WORK, 'config/profiles/broken'), { recursive: true });
  setActiveProfileName('default');
}

// ── calibration-profiles.ts: name rule and listing over an empty store ─────────────────────────
emit('calibration-profiles.json', pretty({
  assertValidProfileName: ['default', 'rig_2-a', '', '../x', 'a.b', 'x'.repeat(64), 'x'.repeat(65), '_lead']
    .map((n) => [n, capture(() => assertValidProfileName(n)).error ?? 'accepted']),
  listCalibrationProfiles: capture(() => listCalibrationProfiles()),
}));

// ── video.json ──────────────────────────────────────────────────────────────────────────────────
emit('video.json', pretty({
  loadVideoConfig: capture(() => loadVideoConfig()),
  validate_tracked: capture(() => validateVideoConfig(JSON.parse(readFileSync(join(CFG, 'video.json'), 'utf-8')))),
  validate_bad: capture(() => validateVideoConfig({
    version: 2,
    streams: [
      { id: 'Bad ID', kind: 'rtsp', url: 'rtsp://user:pass@10.0.0.1/s' },
      { id: 'udp-1', kind: 'udp', port: 7000 },
      { id: 'udp-1', kind: 'udp', port: 5601 },
      { kind: 'mystery' },
    ],
    layout: { preset: '4x4', slots: ['nope'] },
    recording: { refuseBelowGB: -1, stopBelowGB: 'x' },
  })),
}));

// ── State scripts: the editor's name scanner, tokenizer and completion ─────────────────────────
{
  const twin = join(CFG, 'profiles/digital-twin');
  const cfg = readConfig(join(twin, 'config.toml'));
  const grid = parseCsvGrid(readFileSync(join(twin, 'state_transitions.csv'), 'utf-8'));
  const sensors = new Set<string>();
  for (const [k, v] of Object.entries<any>(cfg)) {
    if (!k.startsWith('sensor_roles_') || !v || typeof v !== 'object') continue;
    if (cfg.boards?.[k.slice('sensor_roles_'.length)]?.type !== 'PT') continue;
    for (const role of Object.keys(v)) sensors.add(slugify(role));
  }
  const tablesFor = (state: string): ScriptNameTables => {
    const row = grid.rows.find((r) => r.key === state);
    return {
      actuators: new Set(Object.keys(cfg.actuator_roles ?? {}).map(slugify)),
      sensors,
      states: new Set((cfg.states ?? []).map((s: any) => slugify(String(s.name)))),
      allowedTransitions: new Set(grid.states.filter((_, i) => row?.cells[i] === '1').map(slugify)),
    };
  };
  const names: Record<string, any> = {};
  for (const n of [...Object.keys(cfg.actuator_roles ?? {}), ...(cfg.states ?? []).map((s: any) => s.name),
    'Fuel Main', 'fuel-main', '???', '  spaced  out ', 'ÄÖÜ', '1st Valve', 'a__b'])
    names[n] = { slugify: slugify(n), isValidSlug: isValidSlug(slugify(n)) };
  emit('script-names/slugify.json', pretty({
    names,
    isValidScriptFilename: ['dynamic_test.script', '../x.script', 'a b.script', 'x.txt', '.script', 'A-1_b.script']
      .map((f) => [f, isValidScriptFilename(f)]),
  }));

  const scripts = [
    ...readdirSync(join(twin, 'scripts')).sort().map((f) => join(twin, 'scripts', f)),
    ...readdirSync(join(BAD, 'scripts')).sort().map((f) => join(BAD, 'scripts', f)),
  ];
  for (const s of scripts) {
    const src = readFileSync(s, 'utf-8');
    const tables = tablesFor('Dynamic Test');
    // One line per caret offset: the context, the replace range and the offered inserts.
    const carets: string[] = [];
    for (let i = 0; i <= Math.min(src.length, 400); i++) {
      const ctx = caretContext(src, i);
      const c = completionsAt(src, i, tables);
      carets.push(`${i}: ${ctx ? `${ctx.kind} ${JSON.stringify(ctx.prefix)} ${ctx.from}-${ctx.to}` : 'null'} => ` +
        (c ? `${c.from}-${c.to} ` + c.items.map((it) =>
          `${it.text}${it.label && it.label !== it.text ? `[${it.label}]` : ''}${it.caretOffset !== undefined ? `@${it.caretOffset}` : ''}${it.reopen ? '+' : ''}`).join(' | ')
          : 'null'));
    }
    const tok = (ts: ReturnType<typeof tokenize>) =>
      ts.map((t) => `${t.start}-${t.end} ${t.kind}${t.known === undefined ? '' : t.known ? ' known' : ' UNKNOWN'} ${JSON.stringify(t.text)}`);
    emit(`scripts/${slug(s)}.json`, pretty({
      scanScriptNames: scanScriptNames(src),
      checkScriptNames_DynamicTest: checkScriptNames(src, tables),
      checkScriptNames_Idle: checkScriptNames(src, tablesFor('Idle')),
      renameState: renameScriptSlug(src, 'state', 'PRESS_STANDBY', 'STANDBY'),
      renameActuator: renameScriptSlug(src, 'actuator', 'HIGH_PRESS_CTRL', 'HP_CTRL'),
      tokenize: tok(tokenize(src, tables)),
      tokenizeNoTables: tok(tokenize(src)),
      carets,
    }));
  }
}

emit('_labels.json', pretty(CONFIG_PAGE_LABELS));
