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
  if (!board || board.enabled === false || typeof board.board_id !== 'number') return null;
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
  }

  // ── Roles vs active_connectors ────────────────────────────────────────────
  // Two facts that are easy to confuse for one, and nothing used to compare them.
  // active_connectors is wire-level: config_broadcast packs it into the packet sent to the
  // board (build_sensor_config), so it decides which channels the hardware samples.
  // sensor_roles_<board> is naming: role -> channel, driving display, calibration keying
  // (cal is filed by role) and abort_pts.
  //
  // So the two ways of "removing a channel" do different things — drop the role and the
  // board keeps sending it unnamed; drop the connector and the role points at a channel
  // that is now silent. Both are warnings rather than errors: either can be a deliberate
  // intermediate state, and a run on a rig with an unnamed channel is not unsafe, just
  // confusing. The point is that nobody discovers it from a blank plot mid-test.
  for (const key of Object.keys(boards)) {
    const b = boards[key] ?? {};
    const declared: number[] = Array.isArray(b.active_connectors)
      ? b.active_connectors.map(Number).filter((n: number) => Number.isFinite(n))
      : [];
    // Empty means "expand to 1..num_sensors" (Config.hpp), not "nothing active".
    if (declared.length === 0) continue;
    const roles: Record<string, any> = (config?.[`sensor_roles_${key}`] ?? {}) as Record<string, any>;
    const roleChannels = Object.values(roles).map(Number).filter((n) => Number.isFinite(n));
    if (roleChannels.length === 0) continue;

    const name = boardDisplayName(boards, key);
    const orphanRoles = Object.entries(roles)
      .filter(([, ch]) => !declared.includes(Number(ch)))
      .map(([role, ch]) => `${role} (ch ${ch})`);
    if (orphanRoles.length > 0) {
      add('boards', 'warn',
        `${name} (${key}): ${orphanRoles.join(', ')} name channel(s) the board is not told to ` +
        'sample — those roles will show no data. Add them to Active Connectors or remove the roles.');
    }

    const unnamed = declared.filter((c) => !roleChannels.includes(c));
    if (unnamed.length > 0) {
      add('boards', 'warn',
        `${name} (${key}): channel ${unnamed.join(', ')} ${unnamed.length > 1 ? 'are' : 'is'} sampled ` +
        'but has no role — that data arrives unnamed and cannot be calibrated (cal is filed by role).');
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
