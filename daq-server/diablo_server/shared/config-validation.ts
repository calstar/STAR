/**
 * Config validation rules — the single statement of what makes a config unfit to run.
 *
 * These rules used to exist only inside the config editor, as JSX rendered next to the field they
 * complained about. That made them advisory: an operator could see a red box on the Boards tab,
 * navigate away, and start a run on exactly that config. Only three of them (duplicate roles, the
 * state-machine consistency block, and the PWM assignment) ever stopped anything, and only at the
 * moment of pressing Save in the editor — never at the moment that matters, which is session start,
 * where the profile is deployed and the C++ services read it.
 *
 * So the rules live here, in the compiled `shared` package, and are evaluated in two places:
 *
 *   - the BACKEND, in SessionManager.start(), which refuses to start a run when any issue is
 *     found unless the caller explicitly overrides. That is the enforcement point, and it is the
 *     only one — a browser cannot skip it by not asking.
 *   - the config EDITOR, which renders the same issues inline as you type. Presentation only.
 *
 * Everything here is pure: config object in, plain-text issues out. No fetch, no fs, no DOM. The
 * backend reads the files (the ACTIVE PROFILE, which is what session start deploys) and calls in.
 *
 * `error` = will break the running config. `warn` = a mismatch worth fixing before a run. Both
 * block the first press of Start, because an operator who wanted neither would not have configured
 * it that way; the second press runs anyway, and that decision is theirs to make at the pad.
 */

import { validateControllerPwmActuators } from './types.js';
import { isValidScriptFilename } from './state-script-names.js';

/** Ceiling on a dynamic state's script timeout. Mirrors sequencer::kMaxScriptTimeoutMs. */
const MAX_SCRIPT_TIMEOUT_MS = 600000;

/** Ids match the config editor's tab ids, so an issue can name the page that fixes it. */
export type ConfigPageId =
  | 'boards' | 'roles' | 'gui' | 'controller' | 'state' | 'calibration' | 'system';

export const CONFIG_PAGE_LABELS: Record<ConfigPageId, string> = {
  boards: 'Boards',
  roles: 'Roles',
  gui: 'Top Bar & Limits',
  controller: 'Controller',
  state: 'State Machine',
  calibration: 'Calibration',
  system: 'System',
};

export type ConfigIssueLevel = 'error' | 'warn';

export interface ConfigIssue {
  /** The editor tab an operator opens to fix this. */
  page: ConfigPageId;
  level: ConfigIssueLevel;
  /** Plain text — rendered by the editor and by the session page, so no markup. */
  message: string;
}

/** The three state-machine CSVs, as raw file text. An absent file is ''. */
export interface StateCsvSet {
  actuators: string;
  delays: string;
  transitions: string;
}

// ── State-machine CSV grids ──────────────────────────────────────────────────
// All three CSVs share one shape: the first row is state names (leading cell blank) and the first
// column is the row key.

export type CsvGrid = { states: string[]; rows: { key: string; cells: string[] }[] };

export const parseCsvGrid = (text: string): CsvGrid => {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { states: [], rows: [] };
  const states = lines[0].split(',').slice(1).map((s) => s.trim());
  const rows = lines
    .slice(1)
    .map((line) => {
      const cells = line.split(',').map((c) => c.trim());
      // Pad short rows rather than dropping them — several shipped CSVs are ragged, and silently
      // losing the row would silently drop an actuator from every state.
      return { key: cells[0], cells: states.map((_, i) => cells[i + 1] ?? '') };
    })
    .filter((r) => r.key !== '');
  return { states, rows };
};

export const serializeCsvGrid = (g: CsvGrid): string =>
  [
    ',' + g.states.join(','),
    ...g.rows.map((r) => [r.key, ...g.states.map((_, i) => r.cells[i] ?? '')].join(',')),
  ].join('\n') + '\n';

/** Rows/columns present in `have` but not `want`, and vice versa — the orphan/missing warnings. */
export const diffKeys = (have: string[], want: string[]) => ({
  orphan: have.filter((k) => !want.includes(k)),
  missing: want.filter((k) => !have.includes(k)),
});

// ── Boards ───────────────────────────────────────────────────────────────────

const BOARD_TYPE_LABEL: Record<string, string> = {
  PT: 'PT', ACTUATOR: 'Actuator', LC: 'LC', TC: 'TC', RTD: 'RTD', ENCODER: 'Encoder',
  ENVIRONMENTAL: 'Environmental', T7: 'LabJack T7',
};

/**
 * Friendly board name for display: "PT Board #2" rather than the raw `pt_board_2` config key.
 * Numbered by position among boards of the same type, so it tracks what is actually configured
 * instead of parsing digits out of the key.
 */
export const boardDisplayName = (boards: Record<string, any>, boardKey: string): string => {
  const type = boards?.[boardKey]?.type;
  if (typeof type !== 'string' || !type) return boardKey;
  const sameType = Object.keys(boards).filter((k) => boards[k]?.type === type);
  const ordinal = sameType.indexOf(boardKey) + 1;
  const label = BOARD_TYPE_LABEL[type] ?? type;
  return sameType.length > 1 ? `${label} Board #${ordinal}` : `${label} Board`;
};

/**
 * Every layer maps a board to an Elodin slot as board_id % 10 (0 → 10), and the packet id low
 * byte is (slot-1) * 0x20 + 0x10 + channel — so only 8 slots fit in a byte, and two enabled
 * boards of the same type on one slot merge into a single entity with no error anywhere.
 *
 * Same-type only: the packet id's high byte already separates the types, so a PT and an actuator
 * board sharing a slot is fine. Mirrors check_board_slots() in
 * lib/src/config/LoadActiveBoards.cpp.
 */
export const boardSlotIssue = (boards: Record<string, any>, boardKey: string): string | null => {
  const board = boards?.[boardKey];
  if (!board || board.enabled === false) return null;
  if (board.type === 'ENVIRONMENTAL') {
    const id = board.board_id ?? board.id;
    if (!Number.isInteger(id) || id < 1 || id > 255) {
      return 'Environmental board ID must be an integer from 1 to 255.';
    }
    const clash = Object.keys(boards).find((k) => k !== boardKey
      && boards[k]?.enabled !== false && boards[k]?.type === 'ENVIRONMENTAL'
      && (boards[k]?.board_id ?? boards[k]?.id) === id);
    return clash ? `Environmental board ID ${id} is also claimed by ${clash} — their readings would merge.` : null;
  }
  if (typeof board.board_id !== 'number') return null;
  const slotOf = (id: number) => (id % 10 === 0 ? 10 : id % 10);
  const slot = slotOf(board.board_id);
  if (slot > 8) {
    return `Board ID ${board.board_id} maps to slot ${slot}, but packet IDs only encode slots 1-8.`;
  }
  const clash = Object.keys(boards).find((k) => k !== boardKey
    && boards[k]?.enabled !== false
    && boards[k]?.type === board.type
    && typeof boards[k]?.board_id === 'number'
    && slotOf(boards[k].board_id) === slot);
  if (clash) {
    return `Slot ${slot} is also claimed by ${boardDisplayName(boards, clash)} (ID ${boards[clash].board_id}) — their channels will merge.`;
  }
  return null;
};

// ── LabJack T7 ───────────────────────────────────────────────────────────────
//
// A T7 is a [boards.<name>] with type = "T7" and one [[boards.<name>.channels]] per analog input.
// t7_bridge streams them and publishes each channel twice (lib/include/t7/T7Stream.hpp):
//   raw         {0x26, (slot-1)*0x20 + ain}          entity T7<slot>.AIN<n>      field volts
//   calibrated  {0x26, (slot-1)*0x20 + 0x10 + ain}   entity T7<slot>_Cal.AIN<n>  pressure_psi |
//                                                                               temperature_c |
//                                                                               force_kg
// PT, TC, LC and RTD channels are named by their `role`, like an ESP32 sensor, and carry the same units
// and field names, which is what lets every GUI page treat them as one more PT / TC / LC.
// The rules below mirror lib/src/config/T7Config.cpp, which t7_bridge refuses to start without.

export type T7Kind = 'PT' | 'TC' | 'LC' | 'RTD' | 'VOLTAGE';

/** The field a calibrated T7 channel publishes, by kind; VOLTAGE has no calibrated table. */
export const T7_CAL_FIELD: Record<string, string | undefined> = {
  PT: 'pressure_psi', TC: 'temperature_c', LC: 'force_kg', RTD: 'temperature_c',
};

export const T7_PT_SIGNALS = ['0-5V', '0.5-4.5V', '1-5V', '0-10V', '4-20mA'] as const;
export const T7_RANGES = [10, 1, 0.1, 0.01] as const;
export const T7_MAX_AIN = 13;
/** AIN14 is the T7's internal temperature sensor, streamed raw for thermocouple CJC. */
export const T7_CJC_AIN = 14;

export interface T7ChannelInfo {
  boardKey: string;
  boardId: number;
  boardIp: string;
  enabled: boolean;
  slot: number;
  ain: number;
  /** 'CJC' is the AIN14 entry a board with a thermocouple streams; it has no role. */
  kind: T7Kind | 'CJC';
  role: string;
  rawLow: number;
  entity: string;
  /** null for VOLTAGE and CJC, which publish volts only. */
  calLow: number | null;
  calEntity: string | null;
  calField: string | null;
}

const t7SlotOf = (id: number) => (id % 10 === 0 ? 10 : id % 10);

/**
 * Every T7 channel in `boards`, in config order, with the tables t7_bridge publishes it to.
 * Disabled boards are included (enabled: false) so an editor can still show them; anything that
 * subscribes or lists live sensors filters them out. Malformed entries (no integer ain, no
 * integer board_id) are skipped — t7BoardIssues() is what reports them.
 */
export function t7Channels(boards: Record<string, any> | undefined | null): T7ChannelInfo[] {
  const out: T7ChannelInfo[] = [];
  for (const [boardKey, b] of Object.entries(boards ?? {})) {
    if (String(b?.type ?? '').toUpperCase() !== 'T7') continue;
    const boardId = Number(b.board_id);
    if (!Number.isInteger(boardId) || boardId < 1 || boardId > 255) continue;
    const slot = t7SlotOf(boardId);
    const base = (slot - 1) * 0x20;
    const channels: any[] = Array.isArray(b.channels) ? b.channels : [];
    const common = { boardKey, boardId, boardIp: String(b.ip ?? ''), enabled: b.enabled !== false, slot };
    let hasTc = false;
    for (const c of channels) {
      const ain = Number(c?.ain);
      if (!Number.isInteger(ain) || ain < 0 || ain > T7_MAX_AIN) continue;
      const kind = String(c?.kind ?? '') as T7Kind;
      if (kind === 'TC') hasTc = true;
      const calField = T7_CAL_FIELD[kind] ?? null;
      out.push({
        ...common, ain, kind, role: String(c?.role ?? ''),
        rawLow: base + ain, entity: `T7${slot}.AIN${ain}`,
        calLow: calField ? base + 0x10 + ain : null,
        calEntity: calField ? `T7${slot}_Cal.AIN${ain}` : null,
        calField,
      });
    }
    if (hasTc) {
      out.push({
        ...common, ain: T7_CJC_AIN, kind: 'CJC', role: '',
        rawLow: base + T7_CJC_AIN, entity: `T7${slot}.AIN${T7_CJC_AIN}`,
        calLow: null, calEntity: null, calField: null,
      });
    }
  }
  return out;
}

/**
 * What is wrong with one T7 board, as plain sentences; [] for a fine one or a non-T7. Mirrors
 * parse_t7_boards() in lib/src/config/T7Config.cpp check for check, so the editor and the session
 * gate refuse exactly what t7_bridge would.
 */
export function t7BoardIssues(boards: Record<string, any>, boardKey: string): string[] {
  const b = boards?.[boardKey];
  if (!b || String(b.type ?? '').toUpperCase() !== 'T7') return [];
  const out: string[] = [];
  const num = (v: any, d: number) => (typeof v === 'number' ? v : d);
  const enabled = b.enabled !== false;

  const id = b.board_id;
  if (!Number.isInteger(id) || id < 1 || id > 255) out.push('board_id must be an integer from 1 to 255.');
  if (enabled) {
    if (!b.ip) out.push('ip is required.');
    else if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(String(b.ip))
      || String(b.ip).split('.').some((o) => Number(o) > 255)) out.push(`ip "${b.ip}" is not an IPv4 address.`);
  }
  const rate = num(b.scan_rate_hz, 100);
  if (!(rate > 0)) out.push('scan_rate_hz must be positive.');
  const res = num(b.resolution_index, 0);
  if (!Number.isInteger(res) || res < 0 || res > 8) out.push('resolution_index must be 0-8.');
  if (num(b.settling_us, 0) < 0) out.push('settling_us cannot be negative.');
  if (num(b.scans_per_read, 0) < 0) out.push('scans_per_read cannot be negative.');
  const cjc = num(b.cjc_offset_k, -3.0);
  if (!Number.isFinite(cjc) || Math.abs(cjc) > 20) out.push('cjc_offset_k must be within ±20 K.');

  const channels: any[] = Array.isArray(b.channels) ? b.channels : [];
  if (b.channels !== undefined && !Array.isArray(b.channels)) out.push('channels must be a list of tables.');
  // Roles are unique across every T7 (the GUI keys a sensor by its role).
  const roleOwners = new Map<string, string>();
  for (const [k, ob] of Object.entries(boards)) {
    if (k === boardKey || String(ob?.type ?? '').toUpperCase() !== 'T7') continue;
    for (const c of Array.isArray(ob?.channels) ? ob.channels : [])
      if (c?.role && c?.kind !== 'VOLTAGE' && !roleOwners.has(c.role)) roleOwners.set(c.role, k);
  }
  const ainOwner = new Map<number, number>();
  channels.forEach((c, i) => {
    const p = `channel ${i + 1}: `;
    const kind = String(c?.kind ?? '');
    const ain = c?.ain;
    if (!Number.isInteger(ain) || ain < 0 || ain > T7_MAX_AIN) {
      out.push(`${p}ain must be 0-${T7_MAX_AIN}.`);
    } else {
      const claim = (n: number) => {
        const prev = ainOwner.get(n);
        if (prev !== undefined) out.push(`${p}AIN${n} is already used by channel ${prev + 1}.`);
        else ainOwner.set(n, i);
      };
      claim(ain);
      if (c?.differential === true) {
        if (ain % 2 !== 0) out.push(`${p}a differential input must be an even AIN (it pairs with the odd one above it).`);
        else claim(ain + 1);
      }
    }
    if (!['PT', 'TC', 'LC', 'RTD', 'VOLTAGE'].includes(kind)) out.push(`${p}kind "${kind}" must be one of PT, TC, LC, RTD, VOLTAGE.`);
    const range = num(c?.range, kind === 'TC' ? 0.1 : 10);
    if (!T7_RANGES.some((r) => Math.abs(r - range) < 1e-9)) out.push(`${p}range must be one of 10, 1, 0.1, 0.01 (volts).`);
    if (kind === 'TC' && c?.tc_type !== 'K') out.push(`${p}tc_type "${c?.tc_type ?? ''}": only type K thermocouples are converted so far.`);
    if (kind !== 'TC' && c?.tc_type !== undefined && c?.tc_type !== '') out.push(`${p}tc_type is only meaningful on kind = "TC".`);
    if (kind !== 'VOLTAGE' && kind !== '') {
      if (!c?.role) out.push(`${p}a ${kind} channel needs a role (its name).`);
      else if (roleOwners.has(c.role)) out.push(`${p}role "${c.role}" is already used by [boards.${roleOwners.get(c.role)}].`);
      else roleOwners.set(c.role, boardKey);
    }
    const fs = num(c?.full_scale, 0), shunt = num(c?.shunt_ohms, 0);
    const sens = num(c?.sensitivity_mv_per_v, 0), exc = num(c?.excitation_v, 0);
    const signal = c?.signal ?? '';
    if (kind === 'PT') {
      if (!(fs > 0)) out.push(`${p}a PT needs full_scale (psi at full output).`);
      if (!(T7_PT_SIGNALS as readonly string[]).includes(signal)) out.push(`${p}a PT needs signal, one of ${T7_PT_SIGNALS.join(' ')}.`);
      if (signal === '4-20mA') { if (!(shunt > 0)) out.push(`${p}a 4-20mA PT needs shunt_ohms.`); }
      else if (shunt !== 0) out.push(`${p}shunt_ohms is only meaningful on a 4-20mA PT.`);
    }
    if (kind === 'LC') {
      if (!(fs > 0)) out.push(`${p}an LC needs full_scale (kg at rated output).`);
      if (!(sens > 0)) out.push(`${p}an LC needs sensitivity_mv_per_v.`);
      if (!(exc > 0)) out.push(`${p}an LC needs excitation_v.`);
    }
    // RTD through an LJTick-Resistance: Vout = vref_v * ljtr_ohms / (ljtr_ohms + R_rtd).
    const r0 = num(c?.r0_ohms, 0), ljtr = num(c?.ljtr_ohms, 0);
    const vrefSet = c?.vref_v !== undefined && c?.vref_v !== null && c?.vref_v !== '';
    const vref = num(c?.vref_v, 2.5);
    if (kind === 'RTD') {
      if (!(r0 > 0)) out.push(`${p}an RTD needs r0_ohms (100 for a Pt100, 1000 for a Pt1000).`);
      if (!(ljtr > 0)) out.push(`${p}an RTD needs ljtr_ohms (the LJTick-Resistance's fixed resistor).`);
      if (!(vref > 0 && vref <= 10)) out.push(`${p}vref_v must be within (0, 10] V.`);
      if (!(range >= vref)) out.push(`${p}an RTD's range must cover vref_v (use 10).`);
    } else if (r0 !== 0 || ljtr !== 0 || vrefSet) {
      out.push(`${p}r0_ohms, ljtr_ohms and vref_v are only meaningful on an RTD.`);
    }
    if (kind !== 'PT' && (signal !== '' || shunt !== 0)) out.push(`${p}signal and shunt_ohms are only meaningful on a PT.`);
    if (kind !== 'LC' && (sens !== 0 || exc !== 0)) out.push(`${p}sensitivity_mv_per_v and excitation_v are only meaningful on an LC.`);
    if (kind !== 'PT' && kind !== 'LC' && fs !== 0) out.push(`${p}full_scale is only meaningful on a PT or LC.`);
  });
  if (enabled) {
    if (channels.length === 0) out.push('an enabled T7 needs at least one channel.');
    if (rate * channels.length > 100000) out.push(`scan_rate_hz × channels = ${Math.round(rate * channels.length)} samples/s, beyond the T7's 100000.`);
    out.push(...t7StreamLimitIssues(channels, rate, res, num(b.settling_us, 0)));
  }
  return out;
}

// Datasheet A-1-1 (support.labjack.com/docs/a-1-1-stream-data-rates-t-series-datasheet). Mirrors
// stream_limit_issues() in lib/src/config/T7Config.cpp.
/** Table A.1.7, first column: a single-address stream's max scan rate at resolution 1-8. */
const T7_SINGLE_ADDRESS_MAX_HZ = [100000, 48000, 22000, 11000, 5500, 2500, 1200, 600];
/** Table A.1.8: interchannel delay (µs) by range, resolution 1-8; 0 = not supported in a
 *  multi-channel stream. Summed over a scan it estimates (fast-side) the shortest scan period. */
const T7_INTERCHANNEL_US: Record<string, number[]> = {
  '10': [15, 25, 45, 90, 170, 335, 670, 1335],
  '1': [210, 220, 545, 585, 1200, 2415, 2750, 3415],
  '0.1': [1040, 2105, 0, 0, 0, 0, 0, 0],
  '0.01': [0, 0, 0, 0, 0, 0, 0, 0],
};

function t7StreamLimitIssues(channels: any[], rate: number, res: number, settlingUs: number): string[] {
  const out: string[] = [];
  if (channels.length === 0 || !(rate > 0) || !Number.isInteger(res) || res < 0 || res > 8) return out;
  const eff = res === 0 ? 1 : res;
  const rangeOf = (c: any) => (typeof c?.range === 'number' ? c.range : String(c?.kind) === 'TC' ? 0.1 : 10);
  const key = (r: number) => (['10', '1', '0.1', '0.01'].find((k) => Math.abs(Number(k) - r) < 1e-9));
  const delay = (r: number) => { const k = key(r); return k === undefined ? undefined : T7_INTERCHANNEL_US[k][eff - 1]; };
  const hasTc = channels.some((c) => String(c?.kind) === 'TC');
  const ranges = channels.map(rangeOf);
  if (hasTc) ranges.push(10);
  if (ranges.length === 1) {
    const max = T7_SINGLE_ADDRESS_MAX_HZ[eff - 1];
    if (rate > max) out.push(`one channel at resolution_index ${res} streams at most ${max} scans/s (datasheet A-1-1).`);
    return out;
  }
  let unsupported = false;
  for (const c of channels) {
    const r = rangeOf(c);
    if (delay(r) === 0) {
      unsupported = true;
      out.push(`AIN${c?.ain}: range ${Math.abs(r - 0.01) < 1e-9 ? '0.01' : '0.1'} V is not supported in a multi-channel stream` +
        `${Math.abs(r - 0.1) < 1e-9 ? ' above resolution_index 2' : ' at any resolution'} (datasheet A-1-1, Table A.1.7).`);
    }
  }
  if (unsupported || ranges.some((r) => delay(r) === undefined)) return out;
  const scanUs = ranges.reduce((t, r) => t + Math.max(delay(r) as number, settlingUs), 0);
  const max = 1e6 / scanUs;
  if (rate > max)
    out.push(`scan_rate_hz ${Math.floor(rate)} is beyond what this scan list can do at resolution_index ${res}: ` +
      `about ${Math.floor(max)} scans/s at most (${ranges.length} addresses, datasheet A-1-1 Table A.1.8).`);
  return out;
}

/**
 * Enabled T7 inputs whose role an ESP32 sensor ([sensor_roles_<board>]) already has. The GUI finds
 * a sensor by its role (sensorByRole, [gui.groups], pressure bars) and calibration files it by
 * role, so a shared name would make one of the two unreachable.
 */
export function t7RoleClashes(config: any): Array<{ boardKey: string; ain: number; message: string }> {
  const boards: Record<string, any> = config?.boards ?? {};
  const esp32Roles = new Map<string, string>();
  for (const key of Object.keys(boards)) {
    if (boards[key]?.enabled === false) continue;
    for (const role of Object.keys((config?.[`sensor_roles_${key}`] ?? {}) as Record<string, any>))
      if (!esp32Roles.has(role)) esp32Roles.set(role, key);
  }
  const out: Array<{ boardKey: string; ain: number; message: string }> = [];
  for (const ch of t7Channels(boards)) {
    if (!ch.enabled || !ch.role || ch.calEntity === null) continue;
    const other = esp32Roles.get(ch.role);
    if (other)
      out.push({
        boardKey: ch.boardKey, ain: ch.ain,
        message: `AIN${ch.ain} role "${ch.role}" is also a sensor on ` +
          `${boardDisplayName(boards, other)} (${other}); the GUI shows sensors by role, so one of ` +
          'them would be hidden.',
      });
  }
  return out;
}

// ── The rule set ─────────────────────────────────────────────────────────────

/**
 * Every reason this config is unfit to run, in the order an operator would work through them.
 *
 * `csv` is optional: on a box whose profile predates the state tables, the CSV rules simply do not
 * run rather than reporting every state as missing. A config with no [[states]] at all skips the
 * state-machine rules for the same reason — that is a different and much louder problem, and
 * burying it under fifty derived complaints helps nobody.
 */
export function validateConfigForRun(config: any, csv?: Partial<StateCsvSet>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (page: ConfigPageId, level: ConfigIssueLevel, message: string) =>
    issues.push({ page, level, message });

  // ── Boards ────────────────────────────────────────────────────────────────
  const boards: Record<string, any> = (config?.boards && typeof config.boards === 'object')
    ? config.boards : {};
  for (const key of Object.keys(boards)) {
    const msg = boardSlotIssue(boards, key);
    if (msg) add('boards', 'error', `${boardDisplayName(boards, key)} (${key}): ${msg}`);
    // t7_bridge refuses to start on any of these, so the session would run without the T7.
    for (const m of t7BoardIssues(boards, key))
      add('boards', 'error', `${boardDisplayName(boards, key)} (${key}): ${m}`);
  }

  // ── T7 roles vs every other sensor's ──────────────────────────────────────
  for (const { boardKey, message } of t7RoleClashes(config))
    add('boards', 'error', `${boardDisplayName(boards, boardKey)} (${boardKey}): ${message}`);

  // ── Roles vs active_connectors ────────────────────────────────────────────
  // active_connectors is wire-level: config_broadcast packs it into the packet sent to the
  // board (build_sensor_config) and the firmware loops over those ids, so it decides which
  // channels the hardware samples. sensor_roles_<board> is naming: role -> channel, driving
  // the display, calibration keying (cal is filed by role) and abort_pts.
  //
  // Only ONE direction is reported: a role naming a channel the board is not told to sample.
  // That role can never show data, which is a real and confusing fault.
  //
  // The reverse — a sampled channel with no role — is deliberately NOT reported. Spare
  // channels are the normal case: a 10-channel board running four sensors has six unnamed,
  // and on the real rig that rule produced nine warnings, nearly all of them fine. False
  // positives are expensive here, because this list gates session start: an operator warned
  // about things that are not wrong learns to click past the list, and then it stops meaning
  // anything. The config editor still shows unnamed channels inline, where it is context
  // rather than a gate.
  for (const key of Object.keys(boards)) {
    const b = boards[key] ?? {};
    // A disabled board samples nothing, so nothing about its channels can be wrong.
    if (b.enabled === false) continue;
    // An ACTUATOR board names its channels in [actuator_roles], not sensor_roles_<board>.
    if (String(b.type ?? '').toUpperCase() === 'ACTUATOR') continue;

    const declared: number[] = Array.isArray(b.active_connectors)
      ? b.active_connectors.map(Number).filter((n: number) => Number.isFinite(n))
      : [];
    const roles: Record<string, any> = (config?.[`sensor_roles_${key}`] ?? {}) as Record<string, any>;

    const orphans = Object.entries(roles)
      .filter(([, ch]) => !declared.includes(Number(ch)))
      .map(([role, ch]) => `${role} (ch ${ch})`);
    if (orphans.length > 0) {
      add('boards', 'warn',
        `${boardDisplayName(boards, key)} (${key}): ${orphans.join(', ')} name channel(s) the ` +
        'board is not told to sample, so those roles can never show data. Add them to Active ' +
        'Connectors, or remove the roles.');
    }
  }

  // ── Controller PWM assignment ─────────────────────────────────────────────
  // The only statement of which hardware the controller drives. Unresolved means the controller
  // comes up with its fire gate disabled, which an operator otherwise discovers mid-countdown.
  for (const msg of validateControllerPwmActuators(config)) add('controller', 'error', msg);

  // ── State machine ─────────────────────────────────────────────────────────
  const stateList: any[] = Array.isArray(config?.states) ? config.states : [];
  const grid = (text: string | undefined): CsvGrid | null =>
    typeof text === 'string' && text.trim() !== '' ? parseCsvGrid(text) : null;
  const gActuators = grid(csv?.actuators);
  const gDelays = grid(csv?.delays);
  const gTransitions = grid(csv?.transitions);

  if (stateList.length > 0) {
    // Ids and names are both lookup keys: ids are what past runs stored, names are what the CSV
    // columns resolve by. A duplicate of either silently drops a state on load.
    const dupes = (vals: any[]) =>
      [...new Set(vals.filter((v, i, arr) => v !== undefined && v !== '' && arr.indexOf(v) !== i))];
    const idDupes = dupes(stateList.map((s) => s?.id));
    const nameDupes = dupes(stateList.map((s) => s?.name));
    if (idDupes.length)
      add('state', 'error',
        `Duplicate state id(s): ${idDupes.join(', ')} — the later entry wins and the earlier state disappears.`);
    if (nameDupes.length)
      add('state', 'error',
        `Duplicate state name(s): ${nameDupes.join(', ')} — CSV columns resolve by name, so one of them is unreachable.`);
    if (stateList.some((s) => !String(s?.name ?? '').trim()))
      add('state', 'error', 'A state has an empty name — it cannot be referenced by any table.');

    const names = stateList.map((s) => s?.name).filter(Boolean) as string[];

    // The sequencer resolves transitions and actuator commands by state NAME, so a table column
    // that does not match the state list is a state that commands nothing when entered.
    const colCheck = (g: CsvGrid | null, label: string) => {
      if (!g) return;
      const d = diffKeys(g.states, names);
      if (d.orphan.length)
        add('state', 'error', `The ${label} table has column(s) that are not states: ${d.orphan.join(', ')}.`);
      if (d.missing.length)
        add('state', 'error', `The ${label} table is missing column(s) for state(s): ${d.missing.join(', ')} — entering them commands nothing.`);
    };
    colCheck(gActuators, 'Actuators');
    colCheck(gDelays, 'Delays');
    colCheck(gTransitions, 'Transitions');
    if (gTransitions) {
      const d = diffKeys(gTransitions.rows.map((r) => r.key), names);
      if (d.orphan.length || d.missing.length)
        add('state', 'error', 'The Transitions table rows do not match the state list — every state must have a row.');
    }

    // There is no fallback to the compiled Engine/GSE/Emergency ids once [[states]] is declared —
    // StateMachine::isAbort() treats "config declares states but flags none is_abort" as "this rig
    // has no abort states", not as "use 17/18/19". So flagging none does not leave the built-in
    // aborts standing in; it leaves the rig with none at all.
    if (stateList.every((s) => !s?.is_abort))
      add('state', 'warn',
        'No state is flagged Abort, so this rig has no abort states. Nothing falls back to the built-in Engine / GSE / Emergency aborts: entering a state never triggers the sequencer\'s abort broadcast, and any abort control the config declares no state for is disabled in the GUI. The boards\' own independent abort logic is unaffected.');

    // ── Dynamic states ──────────────────────────────────────────────────────
    //
    // Every rule here is gated on the state actually declaring a script_file, so a config with no
    // dynamic states produces no issues at all. Both levels block the first Start press, and an
    // operator blocked by a false positive learns to press Start twice by reflex.
    //
    // This is the same set the sequencer refuses on at load — deliberately duplicated, because the
    // sequencer's refusal is discovered at session start and this one is discovered at the desk.
    // The script's SYNTAX is not checked here; state_script_check does that on save.
    for (const s of stateList) {
      const file = String(s?.script_file ?? '').trim();
      if (!file) continue;
      const name = String(s?.name ?? '(unnamed)');

      if (!isValidScriptFilename(file))
        add('state', 'error',
          `${name}: script file "${file}" must be a bare <name>.script filename (letters, digits, _ and - only). A path here is refused rather than sanitised.`);

      const timeout = Number(s?.script_timeout_ms ?? 0);
      if (!Number.isFinite(timeout) || timeout <= 0)
        add('state', 'error',
          `${name} runs a script but has no timeout. An unbounded script has no safe degraded mode, so the sequencer will refuse to make this state enterable.`);
      else if (timeout > MAX_SCRIPT_TIMEOUT_MS)
        add('state', 'error',
          `${name}: script timeout ${timeout} ms is above the ${MAX_SCRIPT_TIMEOUT_MS} ms ceiling — a typo must not arm a valve-open window measured in hours.`);

      // Both targets, neither defaulting to the other: a runaway may want somewhere more
      // conservative than a clean finish, and a safety landing that appears by default is the
      // kind that is wrong silently.
      for (const [key, label, why] of [
        ['script_return_target', 'end-of-script target', 'where it lands when the script runs off its end'],
        ['script_timeout_target', 'timeout target', 'where it lands when the timeout expires'],
      ] as const) {
        const t = String((s as any)?.[key] ?? '').trim();
        if (!t) {
          add('state', 'error', `${name} runs a script but has no ${label} — ${why} must be stated, not defaulted.`);
          continue;
        }
        if (!names.includes(t)) {
          add('state', 'error', `${name}: ${label} "${t}" is not in the state list.`);
          continue;
        }
        if (t === name) {
          add('state', 'error',
            `${name}: ${label} is this state itself — it would re-arm forever with its valves wherever the script left them.`);
          continue;
        }
        if (gTransitions) {
          const row = gTransitions.rows.find((x) => x.key === name);
          const col = gTransitions.states.indexOf(t);
          if (row && col >= 0 && (row.cells[col] || '0').trim() !== '1')
            add('state', 'error',
              `${name} → ${t} is not an allowed transition, so the ${label} would leave this state with no way out.`);
        }
      }

      if (s?.is_flow)
        add('state', 'error',
          `${name} is both the flow-test state and a scripted state. The characterization hold and the script would both own its timer.`);
      if (s?.is_abort)
        add('state', 'error',
          `${name} is an abort state and cannot run a script — an abort must reach the valves immediately, never behind an interpreter.`);
      if (String(config?.fire?.state ?? '') === name)
        add('state', 'error', `${name} is the fire state and cannot also run a script.`);

      // The column is the defined baseline the script layers onto. Without it, entering the state
      // leaves every valve the script does not name wherever the PREVIOUS state put it.
      if (gActuators && !gActuators.states.includes(name))
        add('state', 'error',
          `${name} runs a script but has no column in the Actuators table. Entry applies that column first, so that every valve starts in a defined position before the script runs.`);
    }

    // The fire timer: on expiry the sequencer commands fire.state → fire.expiry_target. If that
    // move is not allowed, the timer expires into a refused transition and the system stays in fire.
    const fireState = String(config?.fire?.state ?? '');
    const target = String(config?.fire?.expiry_target ?? '');
    if (fireState && !names.includes(fireState))
      add('state', 'error', `The fire state "${fireState}" is not in the state list.`);
    if (target && !names.includes(target))
      add('state', 'error', `The fire expiry target "${target}" is not in the state list.`);
    if (gTransitions && fireState && target) {
      const row = gTransitions.rows.find((x) => x.key === fireState);
      const col = gTransitions.states.indexOf(target);
      if (row && col >= 0 && (row.cells[col] || '0').trim() !== '1')
        add('state', 'error',
          `${fireState} → ${target} is not an allowed transition. The fire timer would expire into a refused transition and the system would stay in fire.`);
    }
  }

  // Actuator rows are driven by [actuator_roles]; the CSV is what currently exists.
  if (gActuators) {
    const roleNames = Object.keys((config?.actuator_roles ?? {}) as Record<string, unknown>);
    const d = diffKeys(gActuators.rows.map((r) => r.key), roleNames);
    if (d.orphan.length)
      add('state', 'warn', `In the Actuators table but not in [actuator_roles]: ${d.orphan.join(', ')} — these rows command nothing.`);
    if (d.missing.length)
      add('state', 'warn', `Configured but missing an Actuators row: ${d.missing.join(', ')} — the sequencer will never command these in any state.`);
  }
  if (gActuators && gDelays &&
      (gDelays.states.length !== gActuators.states.length || gDelays.rows.length !== gActuators.rows.length))
    add('state', 'warn', 'The Delays table has a different shape from the Actuators table — use “Sync rows” to rebuild both.');
  if (gActuators && gTransitions) {
    const d = diffKeys(gActuators.states, gTransitions.states);
    if (d.orphan.length || d.missing.length)
      add('state', 'warn', 'The Actuators and Transitions tables disagree on which states exist.');
  }

  return issues;
}

/** Group issues by the editor page that fixes them, preserving rule order within a page. */
export function groupIssuesByPage(issues: ConfigIssue[]): { page: ConfigPageId; label: string; issues: ConfigIssue[] }[] {
  const order = Object.keys(CONFIG_PAGE_LABELS) as ConfigPageId[];
  return order
    .map((page) => ({ page, label: CONFIG_PAGE_LABELS[page], issues: issues.filter((i) => i.page === page) }))
    .filter((g) => g.issues.length > 0);
}

export const countByLevel = (issues: ConfigIssue[]) => ({
  errors: issues.filter((i) => i.level === 'error').length,
  warnings: issues.filter((i) => i.level === 'warn').length,
});
