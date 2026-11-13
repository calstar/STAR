/**
 * Moving a role from one board to another — what dragging a row between two board panels on the
 * Roles tab does. Pure config → config, so the rules are testable without the page.
 *
 * Only between boards of the same type: a PT role onto a PT board, an actuator role onto an
 * actuator board, a ball valve onto a ball valve board. A solenoid and a ball valve are different
 * devices (a ball valve has no NO/NC and no PWM output), so a role is never converted by a drag.
 *
 * The role keeps its name — calibration, pressure limits, abort thresholds, gauges and state tables
 * are all keyed by it, so none of them change. What changes is the board, and the channel when the
 * old one is taken or not wired on the new board.
 */

export type MoveResult = { config: any } | { error: string };

const SENSOR_PARALLEL_PREFIXES = [
  'calibration_model_', 'calibration_full_scale_', 'calibration_sense_resistor_',
  'calibration_sensitivity_', 'calibration_pga_',
];

const finiteInts = (xs: unknown): number[] =>
  Array.isArray(xs) ? xs.map(Number).filter((n) => Number.isInteger(n)) : [];

/** A board a role can be dragged between: sensor role panels and actuator role panels. */
export const SENSOR_ROLE_BOARD_TYPES = ['PT', 'RTD', 'TC', 'ENCODER', 'LC'];
export const ACTUATOR_ROLE_BOARD_TYPES = ['ACTUATOR', 'BALL_VALVE'];

/**
 * Move sensor role `name` from [sensor_roles_<fromKey>] to [sensor_roles_<toKey>], carrying its
 * per-sensor calibration settings (model, full scale, sense resistor, mV/V, PGA) with it. Keeps
 * its channel when the target board samples it and no role there uses it; otherwise takes the
 * target's first free active connector; refuses when there is none.
 */
export function moveSensorRole(config: any, name: string, fromKey: string, toKey: string): MoveResult {
  if (fromKey === toKey) return { config };
  const boards = (config?.boards ?? {}) as Record<string, any>;
  const from = boards[fromKey], to = boards[toKey];
  if (!from || !to) return { error: 'That board is no longer in the config.' };
  if (from.type !== to.type) return { error: `A ${from.type} role can only move to another ${from.type} board.` };
  const fromMap = (config[`sensor_roles_${fromKey}`] ?? {}) as Record<string, number>;
  if (!(name in fromMap)) return { error: `"${name}" is not on that board any more.` };
  const toMap = (config[`sensor_roles_${toKey}`] ?? {}) as Record<string, number>;
  if (name in toMap) return { error: `The target board already has a role named "${name}".` };

  const active = finiteInts(to.active_connectors);
  const used = new Set(Object.values(toMap).map(Number));
  const ch = Number(fromMap[name]);
  const channel = active.includes(ch) && !used.has(ch) ? ch : active.find((c) => !used.has(c));
  if (channel === undefined) {
    return {
      error: active.length === 0
        ? 'The target board has no active connectors — add one before moving a role onto it.'
        : `Every active connector on the target board (${active.join(', ')}) already has a role.`,
    };
  }

  const out: any = { ...config };
  const { [name]: _gone, ...restFrom } = fromMap;
  out[`sensor_roles_${fromKey}`] = restFrom;
  out[`sensor_roles_${toKey}`] = { ...toMap, [name]: channel };
  for (const prefix of SENSOR_PARALLEL_PREFIXES) {
    const src = config[`${prefix}${fromKey}`] as Record<string, any> | undefined;
    if (!src || !(name in src)) continue;
    const { [name]: value, ...rest } = src;
    out[`${prefix}${fromKey}`] = rest;
    out[`${prefix}${toKey}`] = { ...(config[`${prefix}${toKey}`] ?? {}), [name]: value };
  }
  return { config: out };
}

/** The channels an actuator / ball valve board drives: 1..num_actuators, else its active
 *  connectors; null when it declares neither (any channel is taken at its word). */
export function actuatorChannelsOf(board: any): number[] | null {
  if (Number.isInteger(board?.num_actuators) && board.num_actuators > 0)
    return Array.from({ length: board.num_actuators }, (_, i) => i + 1);
  const active = finiteInts(board?.active_connectors);
  return active.length ? active : null;
}

/** Channels the actuator roles on the board with this board_id use (leaving out `except`). */
const channelsInUse = (config: any, boardId: number, except?: string): Set<number> => {
  const used = new Set<number>();
  for (const [n, v] of Object.entries((config?.actuator_roles ?? {}) as Record<string, any>)) {
    if (n === except || !Array.isArray(v)) continue;
    if (Number(v[2]) === boardId) used.add(Number(v[1]));
  }
  return used;
};

/** First channel on `board` no actuator role uses; undefined when it is full. */
export function freeActuatorChannel(config: any, board: any): number | undefined {
  const id = Number(board?.board_id);
  const used = channelsInUse(config, id);
  const chans = actuatorChannelsOf(board);
  if (chans) return chans.find((c) => !used.has(c));
  let c = 1;
  while (used.has(c)) c++;
  return c;
}

/**
 * Move actuator role `name` onto the board whose board_id is `toBoardId`. Polarity and PWM
 * assignment are kept (both boards are the same type). Keeps its channel when that is free and
 * driven on the target; otherwise takes the target's first free channel; refuses when it is full.
 * A role on no board (or on one not in the config) may move onto any actuator or ball valve board
 * — onto a ball valve it becomes NC with no PWM, as a ball valve has neither.
 */
export function moveActuatorRole(config: any, name: string, toBoardId: number): MoveResult {
  const roles = (config?.actuator_roles ?? {}) as Record<string, any>;
  const v = roles[name];
  if (!Array.isArray(v)) return { error: `"${name}" is not an actuator role any more.` };
  const boards = Object.values((config?.boards ?? {}) as Record<string, any>);
  const to = boards.find((b) => Number(b?.board_id) === toBoardId && ACTUATOR_ROLE_BOARD_TYPES.includes(b?.type));
  if (!to) return { error: `No actuator or ball valve board has ID ${toBoardId}.` };
  const fromId = v.length >= 3 ? Number(v[2]) : undefined;
  if (fromId === toBoardId) return { config };
  const from = fromId === undefined ? undefined
    : boards.find((b) => Number(b?.board_id) === fromId && ACTUATOR_ROLE_BOARD_TYPES.includes(b?.type));
  if (from && from.type !== to.type)
    return { error: `${from.type === 'BALL_VALVE' ? 'A ball valve' : 'An actuator'} can only move to another ${from.type === 'BALL_VALVE' ? 'ball valve' : 'actuator'} board.` };

  const used = channelsInUse(config, toBoardId, name);
  const chans = actuatorChannelsOf(to);
  const ch = Number(v[1]);
  let channel: number | undefined;
  if ((chans ? chans.includes(ch) : true) && !used.has(ch)) channel = ch;
  else if (chans) channel = chans.find((c) => !used.has(c));
  else { channel = 1; while (used.has(channel)) channel++; }
  if (channel === undefined) return { error: `Every channel on the target board (${chans!.join(', ')}) already has a role.` };

  const toBv = to.type === 'BALL_VALVE';
  const polarity = toBv ? 'NC' : (typeof v[0] === 'string' ? v[0] : 'NC');
  const assignment = !toBv && typeof v[3] === 'string' && v[3] ? v[3] : '';
  const next: any[] = [polarity, channel, toBoardId];
  if (assignment) next.push(assignment);
  // Rebuilt in place so the row keeps its position in the file until Save re-sorts it.
  const rebuilt: Record<string, any> = {};
  for (const [k, val] of Object.entries(roles)) rebuilt[k] = k === name ? next : val;
  return { config: { ...config, actuator_roles: rebuilt } };
}
