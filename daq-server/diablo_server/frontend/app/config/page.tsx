'use client'

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { getWebSocketClient, getApiBaseUrl } from '@/lib/websocket';
import { MessageType } from '@/lib/types';
import { useControlMode } from '@/lib/control-mode';
import { useSensorStore } from '@/lib/store';
import { NAV_ITEMS, navItemById } from '@/lib/nav-items';

interface ConfigData {
  server_heartbeat?: {
    interval_ms?: number;
    broadcast_port?: number;
    broadcast_ip?: string;
  };
  heartbeat_service?: {
    enabled?: boolean;
    backend_url?: string;
    interval_ms?: number;
    broadcast_ip?: string;
    broadcast_port?: number;
  };
  config_broadcast_service?: {
    enabled?: boolean;
    backend_url?: string;
    interval_ms?: number;
  };
  data_logger_service?: {
    enabled?: boolean;
    ws_url?: string;
  };
  system?: {
    mode?: string;
    state?: string;
  };
  network?: {
    bind_ip?: string;
    sensor_port?: number;
    actuator_cmd_port?: number;
    buffer_size?: number;
  };
  database?: {
    host?: string;
    port?: number;
    auto_flush_interval_ms?: number;
    max_buffer_size?: number;
    connection_retry_attempts?: number;
    connection_retry_delay_ms?: number;
  };
  discovery?: {
    enabled?: boolean;
    network_interface?: string;
    mode?: string;
    subnet?: string;
    ip_range_start?: number;
    ip_range_end?: number;
    discovery_timeout_seconds?: number;
  };
  boards?: Record<string, any>;
  sensor_roles?: Record<string, number>; // legacy fallback
  sensor_roles_pt_board?: Record<string, number>;
  sensor_roles_pt_board_2?: Record<string, number>; // HP PT board (was sensor_roles_pt2)
  sensor_roles_rtd_board?: Record<string, number>;
  sensor_roles_tc_board?: Record<string, number>;
  // Per-sensor PT streaming model ('cubic' | 'robust' | 'physics'), role-keyed, parallel to
  // sensor_roles_*. Read/written dynamically as calibration_model_<boardKey>; these fields document
  // the shape. Physics-mode params (full-scale PSI, sense-resistor Ω) live in the parallel
  // calibration_full_scale_<boardKey> / calibration_sense_resistor_<boardKey> role->number maps.
  calibration_model_pt_board?: Record<string, string>;
  calibration_model_pt_board_2?: Record<string, string>;
  calibration_full_scale_pt_board?: Record<string, number>;
  calibration_full_scale_pt_board_2?: Record<string, number>;
  calibration_sense_resistor_pt_board?: Record<string, number>;
  calibration_sense_resistor_pt_board_2?: Record<string, number>;
  abort_pts?: Record<string, number>;
  adc?: { internal_v?: number; vdd_nominal_v?: number; absolute_5v_v?: number };
  fire?: { state?: string; expiry_target?: string; duration_ms?: number; extended_ms?: number };
  states?: Array<{
    id?: number;
    name?: string;
    panel_row?: number;
    panel_col?: number;
    is_abort?: boolean;
    is_boot?: boolean;
  }>;
  actuator_roles?: Record<string, [string, number] | [string, number, number] | [string, number, string]>;
  actuator_abbrev?: Record<string, string>;
  actuator_service?: { port?: number; bind_address?: string };
  controller_service?: { port?: number; fire_duration_ms?: number; fire_extended_ms?: number };
  routing?: Record<string, any>;
  daq_bridge?: { publish?: string[] };
  calibration?: any;
  pressure_limits?: Record<string, any>;
  pressure_mappings?: Record<string, number>;
  display?: Record<string, any>;
  state_machine?: Record<string, string>;
  controller?: {
    pwm_frequency_hz?: number;
    pwm_duration_ms?: number;
    fallback_fuel_duty_cycle?: number;
    fallback_ox_duty_cycle?: number;
    controller_loop_hz?: number;
    command_type?: 'THRUST_DESIRED' | 'ALTITUDE_GOAL' | 'PRESSURE_TARGET' | string;
    thrust_desired?: number;
    altitude_goal?: number;
    pressure_fuel_target?: number;
    pressure_ox_target?: number;
    duty_sweep_enabled?: boolean;
    duty_sweep_step_duration_sec?: number;
    duty_sweep_steps?: [number, number][];
    use_cpp_controller?: boolean;
  };
  phase2?: Record<string, any>;
  gui?: {
    downsample_mode?: string;
    points_per_second?: number;
    tabs?: string[];
    pressure_bars?: Array<{ label?: string; role?: string; avg_roles?: string[]; limits?: string; color?: string }>;
  };
}

// Keep defaults minimal: config.toml is the source of truth.
const DEFAULT_CONFIG: ConfigData = {};

/**
 * Number input that holds a LOCAL value while you type and only commits on blur / Enter. Used for
 * fields the list is sorted by (sensor channel) — committing on every keystroke would re-sort the
 * list mid-edit and yank the row (and your cursor) elsewhere. Syncs down when the prop changes.
 */
/**
 * A titled group of related board fields inside an expanded board card. Renders a small uppercase
 * header with a divider, then the fields in the standard responsive grid. Grouping the ~17 board
 * fields (previously one flat grid) by concern — General / Network / Channels / Signal / Safety —
 * makes a board legible at a glance instead of a wall of inputs.
 */
function FieldSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-text-muted border-b border-gray-700/70 pb-1.5">
        {title}
      </h4>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {children}
      </div>
    </section>
  );
}

function CommitOnBlurNumber({
  value, onCommit, allowEmpty, disabled, className, placeholder, title,
}: {
  value: number | undefined;
  onCommit: (n: number | undefined) => void;
  allowEmpty?: boolean;       // true → clearing the field commits `undefined` (optional field)
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  title?: string;
}) {
  const toStr = (v?: number) => (v === undefined || v === null || Number.isNaN(v) ? '' : String(v));
  const [local, setLocal] = useState<string>(toStr(value));
  useEffect(() => { setLocal(toStr(value)); }, [value]);
  const commit = () => {
    if (local.trim() === '') { allowEmpty ? onCommit(undefined) : setLocal(toStr(value)); return; }
    const n = Number(local);   // float-capable (ports, ADC volts, thresholds)
    if (Number.isFinite(n)) onCommit(n);
    else setLocal(toStr(value)); // revert junk
  };
  return (
    <input
      type="number"
      value={local}
      disabled={disabled}
      placeholder={placeholder}
      title={title}
      className={className}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

/**
 * Text input for a map KEY (role name). Names are the object key, so two rows genuinely can't share
 * one in storage — but blocking the rename outright made editing painful. Instead: you can type a
 * duplicate and it STAYS in the box (marked red), it is NOT applied to config (so nothing is merged
 * or lost), and it is reported via onDupChange so the page can refuse to Save until it's unique.
 * On commit: empty → error+revert; unchanged → revert; duplicate → keep (don't apply); unique →
 * apply (onRename). rowKey is a stable per-row id used to track which rows are currently duplicated.
 */
function CommitOnBlurName({
  value, siblings, rowKey, onRename, onDupChange, onError, className,
}: {
  value: string;
  siblings: string[];
  rowKey: string;
  onRename: (newName: string) => void;
  onDupChange: (rowKey: string, isDup: boolean) => void;
  onError: (msg: string) => void;
  className?: string;
}) {
  const [local, setLocal] = useState<string>(value);
  const isDup = (v: string) => {
    const t = v.trim();
    return t !== '' && t !== value && siblings.some((s) => s !== value && s === t);
  };
  // Config was renamed (unique commit succeeded) → resync + clear any duplicate flag.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLocal(value); onDupChange(rowKey, false); }, [value]);
  // Clear this row's duplicate flag if it unmounts (e.g. the row is removed).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => onDupChange(rowKey, false), [rowKey]);
  const dup = isDup(local);
  const commit = () => {
    const next = local.trim();
    if (next === value) { setLocal(value); return; }
    if (next === '') { onError('Name cannot be empty.'); setLocal(value); onDupChange(rowKey, false); return; }
    if (isDup(local)) return;  // keep the duplicate visible; Save stays blocked until it's resolved
    onRename(next);            // unique → apply (value changes, effect above clears the dup flag)
  };
  return (
    <input
      type="text"
      value={local}
      title={dup ? `Duplicate name "${local.trim()}" — make it unique before saving` : undefined}
      className={`${className ?? ''} ${dup ? 'border-red-500 ring-1 ring-red-500' : ''}`}
      onChange={(e) => { setLocal(e.target.value); onDupChange(rowKey, isDup(e.target.value)); }}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

// ── State-machine CSV grids ──────────────────────────────────────────────────
// All three CSVs share one shape: the first row is state names (leading cell blank) and the first
// column is the row key. Actuators and delays have identical rows AND columns, so they are edited
// as ONE grid with two values per cell rather than two spreadsheets kept in sync by hand.

type CsvGrid = { states: string[]; rows: { key: string; cells: string[] }[] };

const parseCsvGrid = (text: string): CsvGrid => {
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

const serializeCsvGrid = (g: CsvGrid): string =>
  [
    ',' + g.states.join(','),
    ...g.rows.map((r) => [r.key, ...g.states.map((_, i) => r.cells[i] ?? '')].join(',')),
  ].join('\n') + '\n';

/** A single string that changes whenever any of the three state tables changes — used to detect
 *  unsaved edits without deep-comparing the grids. */
const csvSignature = (a: CsvGrid | null, d: CsvGrid | null, t: CsvGrid | null): string =>
  [a, d, t].map((g) => (g ? serializeCsvGrid(g) : '')).join(' ');

/** Rows/columns present in `have` but not `want`, and vice versa — the orphan/missing warnings. */
// Roles are edited in file order (so a row stays put while you type) and re-ordered only on Save:
// actuator_roles by board_id then channel, and each sensor_roles_<board> by channel. smol-toml
// preserves object key order, so the sorted order round-trips through config.toml.
function sortRolesForSave(cfg: any): any {
  const out = { ...(cfg || {}) };
  if (out.actuator_roles && typeof out.actuator_roles === 'object') {
    const sorted = Object.entries(out.actuator_roles).sort((a: any, b: any) => {
      const av = Array.isArray(a[1]) ? a[1] : [], bv = Array.isArray(b[1]) ? b[1] : [];
      return (Number(av[2] ?? 0) - Number(bv[2] ?? 0)) || (Number(av[1] ?? 0) - Number(bv[1] ?? 0));
    });
    out.actuator_roles = Object.fromEntries(sorted);
  }
  for (const k of Object.keys(out)) {
    if (k.startsWith('sensor_roles_') && out[k] && typeof out[k] === 'object') {
      const sorted = Object.entries(out[k]).sort((a: any, b: any) => (Number(a[1]) || 0) - (Number(b[1]) || 0));
      out[k] = Object.fromEntries(sorted);
    }
  }
  return out;
}

const diffKeys = (have: string[], want: string[]) => ({
  orphan: have.filter((k) => !want.includes(k)),
  missing: want.filter((k) => !have.includes(k)),
});

/**
 * Friendly board name for display: "PT Board #2" rather than the raw `pt_board_2` config key.
 * Numbered by position among boards of the same type, so it tracks what is actually configured
 * instead of parsing digits out of the key. The key stays the identity everywhere else (it is what
 * `sensor_roles_<key>` binds to), so it is kept in the tooltip.
 */
const BOARD_TYPE_LABEL: Record<string, string> = {
  PT: 'PT', ACTUATOR: 'Actuator', LC: 'LC', TC: 'TC', RTD: 'RTD', ENCODER: 'Encoder',
};

const boardDisplayName = (boards: Record<string, any>, boardKey: string): string => {
  const type = boards?.[boardKey]?.type;
  if (typeof type !== 'string' || !type) return boardKey;
  const sameType = Object.keys(boards).filter((k) => boards[k]?.type === type);
  const ordinal = sameType.indexOf(boardKey) + 1;
  const label = BOARD_TYPE_LABEL[type] ?? type;
  return sameType.length > 1 ? `${label} Board #${ordinal}` : `${label} Board`;
};

/**
 * A PT board's sensor interface, and therefore its ADC reference. The hardware is identical
 * across PT boards; only the interface differs, so this is a per-board field rather than a
 * board `type` value. Must match backend/src/sensor-config.ts and the C++ load_pt_boards().
 */
const PT_TYPE_RATIOMETRIC = '0-5V ratiometric';
const PT_TYPE_CURRENT_LOOP = '4-20 mA absolute';

/**
 * Reads a PT board's declared interface, falling back to the legacy key-presence inference for a
 * config written before pt_type existed — the same fallback the backend and C++ apply.
 */
const ptTypeOf = (board: any): string => {
  if (typeof board?.pt_type === 'string' && board.pt_type) return board.pt_type;
  const legacy = (Array.isArray(board?.hp_pt_connectors) && board.hp_pt_connectors.length > 0)
    || typeof board?.hp_pt_full_scale_psi === 'number';
  return legacy ? PT_TYPE_CURRENT_LOOP : PT_TYPE_RATIOMETRIC;
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
const boardSlotIssue = (boards: Record<string, any>, boardKey: string): string | null => {
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

/**
 * One consistently-styled inline validation message, rendered next to the element it refers to
 * (a board row, a state row, a table) rather than as a scattered banner. `error` = will break the
 * running config; `warn` = a mismatch worth fixing. One look for all of them.
 */
function InlineIssue({ level = 'error', className = '', children }:
  { level?: 'error' | 'warn'; className?: string; children: ReactNode }) {
  const tone = level === 'warn'
    ? 'border-yellow-600/70 bg-yellow-900/25 text-yellow-200'
    : 'border-red-600/70 bg-red-900/25 text-red-200';
  return (
    <div className={`flex items-start gap-2 px-3 py-2 rounded-md border text-sm ${tone} ${className}`}>
      <span aria-hidden className="mt-px leading-none">⚠</span>
      <div className="space-y-1 min-w-0">{children}</div>
    </div>
  );
}

export default function ConfigPage() {
  const [config, setConfig] = useState<ConfigData>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState('boards');
  // Config profiles v2: the editor edits the ACTIVE PROFILE; config.toml is the deployed/running file.
  // When idle, a save/switch deploys to config.toml; during a session config.toml is frozen (draft).
  const [profiles, setProfiles] = useState<{ name: string; active: boolean }[]>([]);
  const [activeProfile, setActiveProfile] = useState('');
  const [sessionActive, setSessionActive] = useState(false);
  const [runningToml, setRunningToml] = useState<string | null>(null); // read-only view of config.toml
  // Calibration profiles: whole-rig calibration snapshots you can Load / Save / blank from here.
  const [calProfiles, setCalProfiles] = useState<{ name: string; active: boolean }[]>([]);
  const [calActive, setCalActive] = useState('');
  const [calMsg, setCalMsg] = useState<string | null>(null);
  // Snapshots of the last-saved config + state CSVs, so we can tell if there are unsaved edits
  // (null until first load, so we never flag "dirty" before anything has loaded).
  const savedConfigRef = useRef<string | null>(null);
  const savedCsvRef = useRef<string | null>(null);
  // The state name as it was when a name field gained focus, so on blur we can rename that exact
  // column across the CSVs (the per-keystroke value would rename on every character).
  const renameOrigRef = useRef<string | null>(null);
  // Row ids whose name is currently a duplicate (allowed while editing, but blocks Save).
  const [dupRoleRows, setDupRoleRows] = useState<Set<string>>(new Set());
  const onRoleDup = (rowKey: string, isDup: boolean) =>
    setDupRoleRows((prev) => {
      if (isDup === prev.has(rowKey)) return prev;
      const n = new Set(prev);
      if (isDup) n.add(rowKey); else n.delete(rowKey);
      return n;
    });
  // Boards start collapsed to a one-line summary — a stand has ~6 of them and
  // each expands to ~18 fields, which is a lot of scrolling to reach the last one.
  const [openBoards, setOpenBoards] = useState<Record<string, boolean>>({});
  // Disabled boards are declared-but-not-running. Hidden by default so the list shows what the
  // pipeline will actually talk to; the hidden count stays visible so nothing disappears silently.
  const [showDisabledBoards, setShowDisabledBoards] = useState(false);
  const [showRunning, setShowRunning] = useState(false);

  const ws = getWebSocketClient();
  // Config editing is gated on operator identity (the DAQ allowlist), enforced
  // server-side too. Non-operators see every field greyed out and read-only.
  const { isOperator } = useControlMode();
  const canEdit = isOperator;

  useEffect(() => {
    loadConfig();
    loadProfiles();
    loadCalProfiles();

    const unsubConn = ws.on(MessageType.CONNECTION_STATUS, () => {});
    const unsubConfig = ws.on(MessageType.CONFIG_UPDATED, () => {
      loadConfig();
      loadProfiles();
      if (showRunning) loadRunningToml();
    });
    // A session freezes config.toml + blocks switching — keep the gate current.
    const unsubSession = ws.on(MessageType.SESSION_UPDATE, (payload: any) => {
      setSessionActive(!!payload?.active);
    });

    return () => {
      unsubConn();
      unsubConfig();
      unsubSession();
    };
  }, [ws, showRunning]);

  const loadConfig = async () => {
    try {
      setLoading(true);
      setError(null);

      // Request config straight from the backend — the Next.js proxy route is gone.
      // getApiBaseUrl() resolves to :8081 directly, or same-origin behind Caddy.
      const response = await fetch(`${getApiBaseUrl()}/api/config`);
      if (!response.ok) {
        throw new Error('Failed to load config');
      }

      const data = await response.json();
      // GET /api/config returns the ACTIVE PROFILE (the draft you edit) + its name.
      const nextConfig = (data.config || {}) as ConfigData;
      setConfig(nextConfig);
      savedConfigRef.current = JSON.stringify(nextConfig);  // mark this as the saved baseline
      if (typeof data.active === 'string') setActiveProfile(data.active);
      const adc = nextConfig.adc;
      if (adc && typeof adc.internal_v === 'number' && typeof adc.absolute_5v_v === 'number') {
        useSensorStore.getState().setVoltageRefNominals({ internalV: adc.internal_v, absolute5vV: adc.absolute_5v_v });
      }
      setLoading(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to load config');
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    if (dupRoleRows.size > 0) {
      setError(`Resolve ${dupRoleRows.size} duplicate role name${dupRoleRows.size === 1 ? '' : 's'} before saving (highlighted in red).`);
      setTimeout(() => setError(null), 5000);
      return;
    }
    // State-machine consistency: the sequencer resolves transitions/actuators by state NAME, so if
    // [[states]] and the CSV columns disagree (a rename that didn't propagate, an uploaded CSV, a
    // stray column) that state is silently dropped on load. Refuse to save until it's clean — the
    // same posture as the duplicate-role guard above.
    {
      const issues: string[] = [];
      if (stateIdDupes.length)
        issues.push(`duplicate state id(s): ${[...new Set(stateIdDupes)].join(', ')}`);
      if (stateNameDupes.length)
        issues.push(`duplicate state name(s): ${[...new Set(stateNameDupes)].join(', ')}`);
      if (stateList.some((s) => !String(s.name ?? '').trim())) issues.push('a state has an empty name');
      const colCheck = (g: CsvGrid | null, label: string) => {
        if (!g) return;
        const d = diffKeys(g.states, stateListNames);
        if (d.orphan.length) issues.push(`${label} has column(s) not in the state list (${d.orphan.join(', ')})`);
        if (d.missing.length) issues.push(`${label} is missing column(s) (${d.missing.join(', ')})`);
      };
      colCheck(csvActuators, 'Actuators');
      colCheck(csvDelays, 'Delays');
      colCheck(csvTransitions, 'Transitions');
      if (csvTransitions) {
        const d = diffKeys(csvTransitions.rows.map((r) => r.key), stateListNames);
        if (d.orphan.length || d.missing.length)
          issues.push('Transitions rows do not match the state list');
      }
      if (issues.length) {
        setError(`Fix the state machine before saving — ${issues.join('; ')}. Use “Regenerate empty” or fix the tables.`);
        setTimeout(() => setError(null), 9000);
        return;
      }
    }
    try {
      setSaving(true);
      setError(null);
      setSuccess(false);

      const response = await fetch(`${getApiBaseUrl()}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Re-sort the role maps (board→channel) at save time only, so editing never moves a row.
        body: JSON.stringify({ config: sortRolesForSave(config) }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to save config');
      }

      // Save the state-machine tables together with the config — there is no separate CSV Save.
      const csvJobs: Array<[string, CsvGrid | null]> = [
        ['actuators', csvActuators], ['delays', csvDelays], ['transitions', csvTransitions],
      ];
      for (const [name, grid] of csvJobs) {
        if (!grid) continue;
        const r = await fetch(`${getApiBaseUrl()}/api/state-csv?name=${name}`, {
          method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: serializeCsvGrid(grid),
        });
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          throw new Error(b.error || `Failed to save the ${name} table (${r.status})`);
        }
      }

      setSuccess(true);
      setSaving(false);
      // Re-fetch canonical config + tables so the UI (and the saved baselines) mirror disk.
      await loadConfig();
      if (csvActuators || csvDelays || csvTransitions) await loadStateCsvs();
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to save config');
      setSaving(false);
    }
  };

  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Download the raw config.toml from the server as a file (named after the active profile).
  const downloadConfig = () => {
    const a = document.createElement('a');
    a.href = `${getApiBaseUrl()}/api/config/export`;
    a.download = `${activeProfile || 'config'}.toml`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // ── Config profiles v2 ───────────────────────────────────────────────────────
  const loadProfiles = async () => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/config/profiles`);
      if (!res.ok) return;
      const data = await res.json();
      setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
      setActiveProfile(data.active || '');
      setSessionActive(!!data.sessionActive);
    } catch { /* non-fatal */ }
  };

  // Read-only view of the deployed/running config.toml (what the pipeline reads).
  const loadRunningToml = async () => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/config/export`);
      setRunningToml(res.ok ? await res.text() : '(failed to load config.toml)');
    } catch { setRunningToml('(failed to load config.toml)'); }
  };
  const toggleRunning = async () => {
    const next = !showRunning;
    setShowRunning(next);
    if (next) await loadRunningToml();
  };

  const profileAction = async (action: string, body: Record<string, unknown>) => {
    setError(null);
    const res = await fetch(`${getApiBaseUrl()}/api/config/profiles/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `${action} failed (${res.status})`);
    }
    return res.json();
  };

  const switchProfile = async (name: string) => {
    if (!name || name === activeProfile) return;
    try {
      await profileAction('switch', { name }); // deploys the profile to config.toml (idle only)
      await loadProfiles();
      await loadConfig();
      if (showRunning) await loadRunningToml();
    } catch (err: any) {
      setError(err.message || 'Failed to switch config');
      await loadProfiles();
    }
  };

  const createProfile = async () => {
    const name = window.prompt('New config name (letters, digits, _ or -):', '')?.trim();
    if (!name) return;
    try {
      await profileAction('create', { name, from: activeProfile || undefined });
      await loadProfiles();
      if (window.confirm(`Created "${name}". Switch to it now?`)) await switchProfile(name);
    } catch (err: any) {
      setError(err.message || 'Failed to create config');
    }
  };

  const renameProfile = async () => {
    if (!activeProfile) return;
    const newName = window.prompt(`Rename "${activeProfile}" to:`, activeProfile)?.trim();
    if (!newName || newName === activeProfile) return;
    try {
      await profileAction('rename', { name: activeProfile, newName });
      await loadProfiles();
    } catch (err: any) {
      setError(err.message || 'Failed to rename config');
    }
  };

  const deleteProfile = async (name: string) => {
    if (!name || name === activeProfile) return;
    if (!window.confirm(`Delete config "${name}"? This cannot be undone.`)) return;
    try {
      await profileAction('delete', { name });
      await loadProfiles();
    } catch (err: any) {
      setError(err.message || 'Failed to delete config');
    }
  };

  // ── Calibration profiles ─────────────────────────────────────────────────────
  // A calibration profile is one file holding EVERY sensor's cal (keyed by uid). Load/New-blank
  // swap the live store and take effect on the running stream immediately when a session is up
  // (else at the next session start); Save-as snapshots the current live cal into a named file.
  const loadCalProfiles = async () => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/calibration_profiles`);
      if (!res.ok) return;
      const data = await res.json();
      setCalProfiles(Array.isArray(data.profiles) ? data.profiles : []);
      setCalActive(data.active || '');
    } catch { /* non-fatal */ }
  };

  const calProfileAction = async (action: string, body: Record<string, unknown>) => {
    const res = await fetch(`${getApiBaseUrl()}/api/calibration_profiles/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${action} failed (${res.status})`);
    setCalProfiles(Array.isArray(data.profiles) ? data.profiles : []);
    setCalActive(data.active || '');
  };

  const flashCalMsg = (m: string) => { setCalMsg(m); setTimeout(() => setCalMsg(null), 4000); };

  const loadCalProfile = async (name: string) => {
    if (!name) return;
    try {
      await calProfileAction('load', { name });
      flashCalMsg(`Loaded calibration "${name}" — live${sessionActive ? '' : ' at next session start'}.`);
    } catch (err: any) { setError(err.message || 'Failed to load calibration'); }
  };

  const saveCalProfileAs = async () => {
    const name = window.prompt('Save current calibration as (letters, digits, _ or -):', calActive || '')?.trim();
    if (!name) return;
    try {
      await calProfileAction('save', { name });
      flashCalMsg(`Saved current calibration as "${name}".`);
    } catch (err: any) { setError(err.message || 'Failed to save calibration'); }
  };

  const newBlankCalibration = async () => {
    if (!window.confirm('Start a blank calibration? Every sensor reads 0 until re-calibrated. (Save the current one first if you want to keep it.)')) return;
    const name = window.prompt('Optional: also save this blank as a named profile (leave empty to skip):', '')?.trim();
    try {
      await calProfileAction('new_blank', name ? { name } : {});
      flashCalMsg(`Started a blank calibration${name ? ` ("${name}")` : ''} — every sensor reads 0.`);
    } catch (err: any) { setError(err.message || 'Failed to create blank calibration'); }
  };

  // Upload a config.toml to replace the current one (operators only, server-validated).
  const importConfig = async (file: File) => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(false);
      const text = await file.text();
      const response = await fetch(`${getApiBaseUrl()}/api/config/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Import failed (${response.status})`);
      }
      setSuccess(true);
      await loadConfig(); // mirror what the server accepted
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to import config');
    } finally {
      setSaving(false);
    }
  };

  const updateField = (section: string, field: string, value: any, subSection?: string) => {
    setConfig((prev) => {
      const next: any = { ...(prev as any) };
      if (subSection) {
        next[section] = { ...(next[section] || {}) };
        next[section][subSection] = { ...(next[section]?.[subSection] || {}) };
        if (value === undefined) {
          delete next[section][subSection][field];
        } else {
          next[section][subSection][field] = value;
        }
      } else {
        next[section] = { ...(next[section] || {}) };
        if (value === undefined) {
          delete next[section][field];
        } else {
          next[section][field] = value;
        }
      }
      return next as ConfigData;
    });
  };

  const updateBoard = (boardKey: string, field: string, value: any) => {
    setConfig((prev) => {
      const next: ConfigData = { ...prev };
      const boards: Record<string, any> = { ...(next.boards || {}) };
      const board: Record<string, any> = { ...(boards[boardKey] || {}) };
      if (value === undefined) {
        delete board[field];
      } else {
        board[field] = value;
      }
      boards[boardKey] = board;
      next.boards = boards;
      return next;
    });
  };

  // ── [gui] helpers: tab list + top-bar pressure bars ──────────────────────────
  const guiTabs: string[] = config.gui?.tabs ?? [];
  const guiBars = config.gui?.pressure_bars ?? [];
  // Pressure-sensor role names ONLY — a top-bar gauge shows a pressure, so it should offer roles from
  // PT boards, not TC/RTD/LC/encoder. Derived from each PT board's own [sensor_roles_<boardKey>] section.
  const pressureRoles: string[] = Array.from(new Set(
    Object.entries(config.boards || {})
      .filter(([, b]) => (b as any)?.type === 'PT')
      .flatMap(([boardKey]) => Object.keys((config as any)[`sensor_roles_${boardKey}`] || {})),
  )).sort();
  const pressureLimitKeys: string[] = Object.keys(config.pressure_limits ?? {}).sort();

  const setGuiTabs = (tabsList: string[]) =>
    setConfig((prev) => ({ ...prev, gui: { ...(prev.gui || {}), tabs: tabsList } }));
  const setGuiBars = (bars: any[]) =>
    setConfig((prev) => ({ ...prev, gui: { ...(prev.gui || {}), pressure_bars: bars } }));

  // ── State Management tab ───────────────────────────────────────────────────
  const [csvActuators, setCsvActuators] = useState<CsvGrid | null>(null);
  const [csvDelays, setCsvDelays] = useState<CsvGrid | null>(null);
  const [csvTransitions, setCsvTransitions] = useState<CsvGrid | null>(null);
  const [csvLoading, setCsvLoading] = useState(false);
  const [showDelays, setShowDelays] = useState(false);

  const loadStateCsvs = async () => {
    setCsvLoading(true);
    try {
      const get = async (name: string) => {
        const r = await fetch(`${getApiBaseUrl()}/api/state-csv?name=${name}`);
        if (!r.ok) throw new Error(`Failed to load ${name}`);
        return parseCsvGrid(await r.text());
      };
      const [a, d, t] = await Promise.all([get('actuators'), get('delays'), get('transitions')]);
      setCsvActuators(a);
      setCsvDelays(d);
      setCsvTransitions(t);
      savedCsvRef.current = csvSignature(a, d, t);  // baseline for the unsaved-changes check
    } catch (e: any) {
      setError(e?.message || 'Failed to load state CSVs');
      setTimeout(() => setError(null), 4000);
    } finally {
      setCsvLoading(false);
    }
  };

  // Load the tables the first time the tab is opened, not on every config page mount — three
  // extra fetches on a page most visits never open that tab.
  useEffect(() => {
    if (activeTab === 'state' && !csvActuators && !csvLoading) void loadStateCsvs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // State tables are saved together with the config via the top Save button (saveConfig), not on
  // their own — so an operator's edits to the tables can never be silently lost by saving only one.

  // Role names are the source of truth for which rows should exist; the CSV is what currently does.
  const roleNames = Object.keys((config.actuator_roles || {}) as Record<string, unknown>);
  const actuatorDiff = csvActuators
    ? diffKeys(csvActuators.rows.map((r) => r.key), roleNames)
    : { orphan: [], missing: [] };
  // The two grids must agree on their state columns or a state exists in one table and not the other.
  const stateColDiff = csvActuators && csvTransitions
    ? diffKeys(csvActuators.states, csvTransitions.states)
    : { orphan: [], missing: [] };
  const delayShapeMismatch = !!(csvActuators && csvDelays &&
    (csvDelays.states.length !== csvActuators.states.length ||
      csvDelays.rows.length !== csvActuators.rows.length));

  // ── [[states]] editor ──────────────────────────────────────────────────────
  const stateList = (config.states || []) as NonNullable<ConfigData['states']>;

  const setState = (idx: number, patch: Record<string, unknown>) =>
    setConfig((prev) => {
      const list = [...((prev.states || []) as any[])];
      list[idx] = { ...list[idx], ...patch };
      // An empty coordinate means "not on the diagram" — drop the key rather than writing null,
      // which is what the loaders treat as absent.
      for (const k of ['panel_row', 'panel_col']) {
        if (list[idx][k] === undefined || list[idx][k] === '' || Number.isNaN(list[idx][k])) delete list[idx][k];
      }
      if (!list[idx].is_abort) delete list[idx].is_abort;
      if (!list[idx].is_boot) delete list[idx].is_boot;
      return { ...prev, states: list } as ConfigData;
    });

  // Rename a state's column (and, in the transitions grid, its from-row key) so the CSVs track a
  // [[states]] rename. addState/removeState/moveState already keep the grids in step; renaming did
  // not, so a renamed state's column kept the OLD name, and on Save the sequencer's name→id
  // resolution silently dropped that state's actuators/transitions. Called on blur (see the name
  // input) with the pre-edit name, not per keystroke.
  const renameCol = (g: CsvGrid | null, from: string, to: string): CsvGrid | null =>
    g && {
      states: g.states.map((s) => (s === from ? to : s)),
      rows: g.rows.map((r) => (r.key === from ? { ...r, key: to } : r)),
    };
  const commitStateRename = (idx: number) => {
    const from = renameOrigRef.current;
    renameOrigRef.current = null;
    const to = (stateList[idx]?.name ?? '').trim();
    // Only a real, non-empty, changed name propagates. An empty name is invalid and blocked at Save;
    // a transient duplicate is allowed (and flagged) like role names, resolved before Save.
    if (from && to && from !== to)
      for (const set of [setCsvActuators, setCsvDelays, setCsvTransitions])
        set((g) => renameCol(g, from, to));
  };

  const addState = () => {
    const used = new Set(stateList.map((s) => s.id));
    // Never reuse an id: old Elodin run history stores the raw number with no name table beside
    // it, so a recycled id silently relabels past runs. Always take the next free one. Ids start at
    // 1 — id 0 is the legacy Debug enumerator (name-only, never a real state), so it's off-limits.
    let next = 1;
    while (used.has(next)) next++;
    const name = `New State ${next}`;
    // Auto-place on the diagram at the first free (row, col) so a new state is visible there right
    // away rather than off-diagram. Coordinates are 0-based (see lib/states.ts).
    const usedCells = new Set(
      stateList
        .filter((s) => typeof s.panel_row === 'number' && typeof s.panel_col === 'number')
        .map((s) => `${s.panel_row}:${s.panel_col}`),
    );
    const WIDTH = 6;
    let pr = 0, pc = 0;
    while (usedCells.has(`${pr}:${pc}`)) { pc += 1; if (pc >= WIDTH) { pc = 0; pr += 1; } }
    setConfig((prev) => ({
      ...prev,
      states: [...((prev.states || []) as any[]), { id: next, name, panel_row: pr, panel_col: pc }],
    } as ConfigData));
    // Keep the tables in step: the new state appears as a column everywhere immediately (and a
    // self-transition-only row in the transitions matrix), so a freshly added state is usable
    // without a manual Regenerate.
    const addCol = (g: CsvGrid | null, fill: string): CsvGrid | null =>
      g && ({ states: [...g.states, name], rows: g.rows.map((r) => ({ ...r, cells: [...r.cells, fill] })) });
    setCsvActuators((g) => addCol(g, 'CLOSE'));
    setCsvDelays((g) => addCol(g, '0'));
    setCsvTransitions((g) => {
      if (!g) return g;
      const states = [...g.states, name];
      const rows = g.rows.map((r) => ({ ...r, cells: [...r.cells, '0'] }));
      rows.push({ key: name, cells: states.map((s) => (s === name ? '1' : '0')) });
      return { states, rows };
    });
  };

  // Swap two state columns in a grid (and, for transitions, the matching from-rows) so the table
  // column order follows the state list order when states are reordered.
  const swapGridCols = (g: CsvGrid | null, a: string, b: string, alsoRows: boolean): CsvGrid | null => {
    if (!g) return g;
    const ia = g.states.indexOf(a), ib = g.states.indexOf(b);
    if (ia < 0 || ib < 0) return g;
    const states = g.states.slice();
    [states[ia], states[ib]] = [states[ib], states[ia]];
    let rows = g.rows.map((r) => {
      const cells = r.cells.slice();
      [cells[ia], cells[ib]] = [cells[ib], cells[ia]];
      return { ...r, cells };
    });
    if (alsoRows) {
      const ra = rows.findIndex((r) => r.key === a), rb = rows.findIndex((r) => r.key === b);
      if (ra >= 0 && rb >= 0) { rows = rows.slice(); [rows[ra], rows[rb]] = [rows[rb], rows[ra]]; }
    }
    return { states, rows };
  };

  const moveState = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= stateList.length) return;
    const a = stateList[idx]?.name, b = stateList[j]?.name;
    setConfig((prev) => ({ ...prev, states: moveInArray((prev.states || []) as any[], idx, dir) } as ConfigData));
    if (a && b && a !== b) {
      setCsvActuators((g) => swapGridCols(g, a, b, false));
      setCsvDelays((g) => swapGridCols(g, a, b, false));
      setCsvTransitions((g) => swapGridCols(g, a, b, true));
    }
  };

  // Unsaved-changes tracking: compare the current config + state tables against the last-saved
  // baselines. Null baseline = nothing loaded yet, so we never flag dirty prematurely.
  const dirty =
    dupRoleRows.size > 0 ||  // a typed-but-unresolved duplicate name is an unsaved edit too
    (savedConfigRef.current !== null && JSON.stringify(config) !== savedConfigRef.current) ||
    (savedCsvRef.current !== null && csvSignature(csvActuators, csvDelays, csvTransitions) !== savedCsvRef.current);

  // Warn before losing unsaved edits: the browser dialog on close/refresh, and a confirm on in-app
  // navigation (Next <Link> renders an <a>, so a capture-phase click handler catches it).
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest?.('a');
      if (!a) return;
      if (a.hasAttribute('download') || a.getAttribute('target') === '_blank') return;
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('http')) return;
      if (href === window.location.pathname) return;  // same page
      if (!window.confirm('You have unsaved config changes. Leave this page and discard them?')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  // Drop a state's column (and, for the transitions grid, its from-row) from a CSV grid. Actuator/
  // delay rows are keyed by role so no row is removed there — only the state column disappears.
  const dropStateFromGrid = (g: CsvGrid | null, stateName: string): CsvGrid | null => {
    if (!g) return g;
    const ci = g.states.indexOf(stateName);
    if (ci < 0) return g;
    return {
      states: g.states.filter((_, i) => i !== ci),
      rows: g.rows
        .filter((r) => r.key !== stateName)
        .map((r) => ({ ...r, cells: r.cells.filter((_, j) => j !== ci) })),
    };
  };

  const removeState = (idx: number) => {
    const name = stateList[idx]?.name;
    setConfig((prev) => ({
      ...prev,
      states: ((prev.states || []) as any[]).filter((_, i) => i !== idx),
    } as ConfigData));
    // A deleted state must also leave both tables (and the delays grid), or it lingers as a column
    // and re-persists on the next Save. Row = state only in the transitions grid, so it's removed
    // there too.
    if (name) {
      setCsvActuators((g) => dropStateFromGrid(g, name));
      setCsvDelays((g) => dropStateFromGrid(g, name));
      setCsvTransitions((g) => dropStateFromGrid(g, name));
    }
  };

  /** Ids must be unique, and so should names — both are lookup keys. */
  const stateIdDupes = stateList
    .map((s) => s.id)
    .filter((id, i, arr) => id !== undefined && arr.indexOf(id) !== i);
  const stateNameDupes = stateList
    .map((s) => s.name)
    .filter((n, i, arr) => n !== undefined && arr.indexOf(n) !== i);
  /** States named in the CSVs but absent from the list, and vice versa. */
  const csvStateNames = csvActuators?.states ?? [];
  const stateListNames = stateList.map((s) => s.name).filter(Boolean) as string[];
  const stateCsvDiff = csvActuators
    ? diffKeys(csvStateNames, stateListNames)
    : { orphan: [], missing: [] };

  const setActuatorCell = (rowIdx: number, colIdx: number, value: string) =>
    setCsvActuators((g) => g && ({
      ...g,
      rows: g.rows.map((r, i) => (i === rowIdx ? { ...r, cells: r.cells.map((c, j) => (j === colIdx ? value : c)) } : r)),
    }));

  const setDelayCell = (rowKey: string, colIdx: number, value: string) =>
    setCsvDelays((g) => g && ({
      ...g,
      rows: g.rows.map((r) => (r.key === rowKey ? { ...r, cells: r.cells.map((c, j) => (j === colIdx ? value : c)) } : r)),
    }));

  const setTransitionCell = (rowIdx: number, colIdx: number, on: boolean) =>
    setCsvTransitions((g) => g && ({
      ...g,
      rows: g.rows.map((r, i) => (i === rowIdx ? { ...r, cells: r.cells.map((c, j) => (j === colIdx ? (on ? '1' : '0') : c)) } : r)),
    }));

  /** Rebuild both actuator grids so rows = [actuator_roles] and columns = the current state list,
   *  preserving any existing (role, state) cell. Reconciling columns too — not just rows — is what
   *  keeps a deleted/renamed state from lingering as a stale column. */
  const syncActuatorRows = () => {
    const states = stateListNames;
    const rebuild = (g: CsvGrid, fill: string): CsvGrid => ({
      states,
      rows: roleNames.map((k) => {
        const existing = g.rows.find((r) => r.key === k);
        return {
          key: k,
          cells: states.map((s) => {
            const oldCi = g.states.indexOf(s);
            return existing && oldCi >= 0 ? (existing.cells[oldCi] ?? fill) : fill;
          }),
        };
      }),
    });
    if (csvActuators) setCsvActuators(rebuild(csvActuators, 'CLOSE'));
    if (csvDelays) setCsvDelays(rebuild(csvDelays, '0'));
  };

  /** A blank table: every configured actuator, every CURRENT state, everything closed. Columns come
   *  from the live state list (not the last-loaded CSV), so deleted states don't reappear. */
  const generateEmptyActuators = () => {
    const states = stateListNames;
    setCsvActuators({ states, rows: roleNames.map((k) => ({ key: k, cells: states.map(() => 'CLOSE') })) });
    setCsvDelays({ states, rows: roleNames.map((k) => ({ key: k, cells: states.map(() => '0') })) });
  };

  /** A blank transitions table: the only allowed move from each state is to itself (the diagonal).
   *  Everything else disallowed. Columns/rows come from the live state list. */
  const generateEmptyTransitions = () => {
    const states = stateListNames;
    setCsvTransitions({ states, rows: states.map((k) => ({ key: k, cells: states.map((s) => (s === k ? '1' : '0')) })) });
  };

  const downloadStateCsv = (name: string) => {
    const a = document.createElement('a');
    a.href = `${getApiBaseUrl()}/api/state-csv?name=${name}`;
    a.download = `${name}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const uploadStateCsv = async (name: string, file: File) => {
    try {
      const text = await file.text();
      const r = await fetch(`${getApiBaseUrl()}/api/state-csv?name=${name}`, {
        method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text,
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `Upload failed (${r.status})`);
      await loadStateCsvs();
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (e: any) {
      setError(e?.message || 'Upload failed');
      setTimeout(() => setError(null), 5000);
    }
  };

  const moveInArray = <T,>(arr: T[], i: number, dir: -1 | 1): T[] => {
    const j = i + dir;
    if (j < 0 || j >= arr.length) return arr;
    const next = arr.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };

  const updateArrayField = (section: string, field: string, value: string) => {
    const array = value.split(',').map(s => s.trim()).filter(s => s).map(s => {
      const num = parseInt(s, 10);
      return isNaN(num) ? s : num;
    });
    updateField(section, field, array);
  };

  const renderField = (
    label: string,
    value: any,
    onChange: (val: any) => void,
    type: 'text' | 'number' | 'select' | 'boolean' | 'array' = 'text',
    options?: string[],
    description?: string,
    // Always disabled, even for operators — for startup-only infra that must not
    // be edited from the live GUI (e.g. network ports the pipeline binds at launch).
    readOnly?: boolean
  ) => {
    const fieldDisabled = !canEdit || readOnly;
    return (
      <div className="space-y-1">
        <label className="block text-sm font-semibold">
          {label}
          {description && <span className="text-xs text-text-muted ml-2">({description})</span>}
        </label>
        {type === 'select' ? (
          <select
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={fieldDisabled}
            className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {options?.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        ) : type === 'boolean' ? (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!value}
              onChange={(e) => onChange(e.target.checked)}
              disabled={fieldDisabled}
              className="w-4 h-4 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <span>{value ? 'Enabled' : 'Disabled'}</span>
          </label>
        ) : type === 'array' ? (
          <input
            type="text"
            value={Array.isArray(value) ? value.join(', ') : ''}
            onChange={(e) => {
              const array = e.target.value.split(',').map(s => s.trim()).filter(s => s).map(s => {
                const num = parseInt(s, 10);
                return isNaN(num) ? s : num;
              });
              onChange(array);
            }}
            disabled={fieldDisabled}
            className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder="Comma-separated values (e.g., 1, 2, 3)"
          />
        ) : type === 'number' ? (
          <CommitOnBlurNumber
            value={value == null || value === '' ? undefined : Number(value)}
            allowEmpty
            onCommit={(n) => onChange(n)}
            disabled={fieldDisabled}
            className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
          />
        ) : (
          <input
            type="text"
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={fieldDisabled}
            className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
          />
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-background text-text p-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center">Loading configuration...</div>
        </div>
      </main>
    );
  }

  // Ordered by usefulness, left to right, and grouped so related config lives on
  // one page instead of behind a round trip between tabs:
  //   Boards      + ADC refs        (a board's voltage_reference indexes them)
  //   Roles       = sensors + actuators (the same channel -> name map, twice)
  //   Top Bar     + Pressure Limits (a gauge's `limits` key names a limits entry)
  //   System      = every read-only page — startup-only binds the C++ services
  //                 read once, plus config managed outside this editor. Last,
  //                 because you open it to read a port, never to edit one.
  const tabs = [
    { id: 'boards', label: 'Boards' },
    { id: 'roles', label: 'Roles' },
    { id: 'gui', label: 'Top Bar & Limits' },
    { id: 'controller', label: 'Controller' },
    { id: 'state', label: 'State Machine' },
    { id: 'calibration', label: 'Calibration' },
    { id: 'system', label: 'System' },
  ];

  return (
    <main className="min-h-screen bg-background text-text p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold">Configuration Editor</h1>
            <p className="text-sm text-text-muted mt-1">
              Config auto-refreshes when saved (yours or another client). Reload to fetch latest from disk.
            </p>
          </div>
          <div className="flex gap-4">
            <button
              onClick={loadConfig}
              disabled={loading || saving}
              className="px-4 py-2 bg-card rounded-lg hover:bg-opacity-80 disabled:opacity-50"
            >
              Reload
            </button>
            <button
              onClick={downloadConfig}
              className="px-4 py-2 bg-card rounded-lg hover:bg-opacity-80"
              title="Download config.toml"
            >
              Download
            </button>
            <button
              onClick={() => uploadInputRef.current?.click()}
              disabled={!canEdit || saving}
              className="px-4 py-2 bg-card rounded-lg hover:bg-opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              title={canEdit ? 'Upload a config.toml to replace the current one' : 'Operators only'}
            >
              Upload
            </button>
            <input
              ref={uploadInputRef}
              type="file"
              accept=".toml,text/plain"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importConfig(f); e.target.value = ''; }}
            />
            <button
              onClick={saveConfig}
              disabled={saving || loading || !canEdit}
              className={`px-4 py-2 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed ${dirty && canEdit ? 'bg-blue-600 hover:bg-blue-700 ring-2 ring-blue-400/60' : 'bg-blue-600 hover:bg-blue-700'}`}
              title={canEdit ? (dirty ? 'You have unsaved changes' : undefined) : 'Operators only: config changes disabled'}
            >
              {saving ? 'Saving...' : canEdit ? (dirty ? 'Save Config •' : 'Save Config') : 'Save Disabled (Read-only)'}
            </button>
          </div>
        </div>

        {/* Config profiles: pick which config is loaded/edited. Selecting deploys it to config.toml
            (the running file) when idle; switching is blocked while a session runs. The editor always
            edits the selected profile — config.toml is view-only below. */}
        <div className="mb-4 p-3 bg-card rounded-lg flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold">Config profile:</span>
          <select
            value={activeProfile}
            onChange={(e) => switchProfile(e.target.value)}
            disabled={!canEdit || sessionActive || saving || loading}
            title={
              !canEdit ? 'Operators only'
                : sessionActive ? 'Stop the session to switch configs'
                : 'Load a config (deploys it to config.toml)'
            }
            className="px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed min-w-[12rem]"
          >
            {profiles.length === 0 && <option value="">{activeProfile || '—'}</option>}
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>{p.name}{p.active ? ' (active)' : ''}</option>
            ))}
          </select>
          <button onClick={createProfile} disabled={!canEdit}
            className="px-3 py-2 bg-card border border-gray-700 rounded-lg hover:bg-opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            title={canEdit ? 'Create a new config from the current one' : 'Operators only'}>New</button>
          <button onClick={renameProfile} disabled={!canEdit || !activeProfile}
            className="px-3 py-2 bg-card border border-gray-700 rounded-lg hover:bg-opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            title={canEdit ? 'Rename the active config' : 'Operators only'}>Rename</button>
          <button
            onClick={() => {
              const inactive = profiles.filter((p) => !p.active).map((p) => p.name);
              if (inactive.length === 0) return;
              const name = window.prompt(`Delete which config? (${inactive.join(', ')})`, inactive[0])?.trim();
              if (name && inactive.includes(name)) deleteProfile(name);
              else if (name) setError(`No inactive config named "${name}"`);
            }}
            disabled={!canEdit || profiles.filter((p) => !p.active).length === 0}
            className="px-3 py-2 bg-card border border-gray-700 rounded-lg hover:bg-opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            title={!canEdit ? 'Operators only' : 'Delete an inactive config'}>Delete…</button>
          <button onClick={toggleRunning}
            className="px-3 py-2 bg-card border border-gray-700 rounded-lg hover:bg-opacity-80"
            title="View the deployed config.toml the pipeline is running (read-only)">
            {showRunning ? 'Hide' : 'View'} running config.toml
          </button>
        </div>

        {sessionActive && (
          <div className="mb-4 p-3 bg-yellow-900/40 border border-yellow-600 rounded-lg text-yellow-200 text-sm">
            Session running — the running <code>config.toml</code> is frozen. Edits save to the
            <strong> {activeProfile || 'active'}</strong> profile as a draft and apply at the next session start.
            Switching configs is disabled until the session stops.
          </div>
        )}

        {showRunning && (
          <div className="mb-4 p-3 bg-background border border-gray-700 rounded-lg">
            <div className="text-xs text-text-muted mb-2">Running <code>config.toml</code> (read-only — deployed to the pipeline)</div>
            <pre className="text-xs font-mono whitespace-pre overflow-auto max-h-96 text-text-muted">{runningToml ?? 'Loading…'}</pre>
          </div>
        )}

        {error && (
          <div className="mb-4 p-4 bg-red-900/30 border border-red-500 rounded-lg text-red-200">
            {error}
          </div>
        )}

        {success && (
          <div className="mb-4 p-4 bg-green-900/30 border border-green-500 rounded-lg text-green-200">
            Configuration saved successfully!
          </div>
        )}

        {!canEdit && (
          <div className="mb-4 p-3 bg-yellow-900/40 border border-yellow-600 rounded-lg text-yellow-200 text-sm">
            Read-only — you are not an approved operator. Fields are disabled and saving/uploading is blocked (also enforced server-side).
          </div>
        )}

        {/* Tabs */}
        <div className="mb-6 border-b border-gray-700">
          <div className="flex gap-2 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-text-muted hover:text-text'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab Content — a disabled fieldset greys out and blocks every control
            inside for non-operators (mirrors the server-side operator gate). */}
        <fieldset disabled={!canEdit} className={`space-y-6 border-0 m-0 p-0 min-w-0${!canEdit ? ' opacity-60' : ''}`}>
          {activeTab === 'boards' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-1">Boards</h2>
              <p className="text-sm text-text-muted mb-4">
                Editable. Board config (roles, active connectors, voltage reference, abort thresholds,
                enable flags) is re-broadcast to the boards live — the config-broadcast service re-reads
                on save, so changes apply without restarting the server or a session. Note: the DAQ
                pipeline (daq_bridge/calibration/controller) picks up routing/identity changes on the
                next session start.
              </p>
              {(() => {
                const hidden = Object.values(config.boards || {})
                  .filter((b: any) => b?.enabled === false).length;
                return (
                  <label className="flex items-center gap-2 mb-3 text-sm text-text-muted select-none w-fit">
                    <input
                      type="checkbox"
                      checked={showDisabledBoards}
                      onChange={(e) => setShowDisabledBoards(e.target.checked)}
                      className="w-4 h-4"
                    />
                    Show boards that are not enabled
                    {hidden > 0 && !showDisabledBoards && (
                      <span className="text-xs">({hidden} hidden)</span>
                    )}
                  </label>
                );
              })()}

              <div className="space-y-3">
                {Object.entries(config.boards || {})
                  .filter(([, board]) => showDisabledBoards || (board as any)?.enabled !== false)
                  .map(([boardKey, board]) => {
                  const b = board as any;
                  const open = !!openBoards[boardKey];
                  const toggle = () => setOpenBoards((prev) => ({ ...prev, [boardKey]: !prev[boardKey] }));
                  const channels = b.type === 'ACTUATOR'
                    ? (b.num_actuators !== undefined ? `${b.num_actuators} act` : null)
                    : (b.num_sensors !== undefined ? `${b.num_sensors} ch` : null);
                  // The board DECLARES its sensor interface via pt_type — the same key the backend
                  // (isCurrentLoopBoard) and the C++ calibration service read, so there is one
                  // source of truth. There is deliberately no type = "HP_PT": the hardware is
                  // identical, only the sensor interface differs.
                  const ptType = ptTypeOf(b);
                  const isHp = ptType === PT_TYPE_CURRENT_LOOP;
                  const slotIssue = boardSlotIssue((config.boards || {}) as Record<string, any>, boardKey);
                  // pt_type drives voltage_reference rather than sitting beside it, so the two
                  // cannot disagree. The 4-20 mA path needs the internal 2.5 V reference; 0-5V
                  // ratiometric needs VDD, where the excitation IS the reference.
                  const setPtType = (next: string) => {
                    updateBoard(boardKey, 'pt_type', next);
                    if (next === PT_TYPE_CURRENT_LOOP) {
                      updateBoard(boardKey, 'voltage_reference', 0);
                      updateBoard(boardKey, 'adc_ref_voltage', b.adc_ref_voltage ?? 2.5);
                      updateBoard(boardKey, 'hp_pt_full_scale_psi', b.hp_pt_full_scale_psi ?? 5000);
                      updateBoard(boardKey, 'hp_pt_sense_resistor_ohms', b.hp_pt_sense_resistor_ohms ?? 120);
                    } else {
                      updateBoard(boardKey, 'voltage_reference', 1);
                      for (const k of ['hp_pt_full_scale_psi', 'hp_pt_sense_resistor_ohms']) {
                        updateBoard(boardKey, k, undefined);
                      }
                    }
                    // Legacy keys the excitation-monitor mechanism used; clearing them on any
                    // pt_type edit stops a stale key outliving the declaration it predates.
                    for (const k of ['hp_pt_connectors', 'excitation_connector_id',
                                     'excitation_divider_attenuation']) {
                      if (b[k] !== undefined) updateBoard(boardKey, k, undefined);
                    }
                  };
                  return (
                  <div key={boardKey} className="border border-gray-700 rounded-lg">
                    {/* Header is a div, not a button: the whole tab sits in a
                        <fieldset disabled> for non-operators, which would disable a
                        real <button> and leave them unable to expand anything. */}
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={open}
                      onClick={toggle}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
                      className={`flex flex-wrap items-center gap-x-3 gap-y-1 p-4 cursor-pointer select-none hover:bg-white/5 rounded-lg${open ? ' rounded-b-none' : ''}`}
                    >
                      <span className="text-text-muted w-3 shrink-0">{open ? '▾' : '▸'}</span>
                      {/* No status dot here. `enabled` is a config declaration, not connectivity —
                          a green dot would read as "online" on a page sitting next to live
                          telemetry, and would stay green for an unplugged board. Disabled boards
                          are dimmed and carry an explicit chip instead; the Boards page is where
                          connection state belongs. */}
                      <h3
                        className={`text-lg font-semibold ${b.enabled ? '' : 'text-text-muted'}`}
                        title={`config key: ${boardKey}`}
                      >
                        {boardDisplayName((config.boards || {}) as Record<string, any>, boardKey)}
                      </h3>
                      <span className="px-2 py-0.5 text-xs rounded bg-gray-700 text-text-muted">{b.type ?? '—'}</span>
                      {isHp && (
                        <span className="px-2 py-0.5 text-xs rounded bg-sky-900/60 text-sky-300" title="High-pressure 4-20 mA current-loop PT board">HP</span>
                      )}
                      {!open && (
                        <span className="text-sm text-text-muted font-mono ml-auto flex flex-wrap gap-x-3 justify-end">
                          {b.board_id !== undefined && <span title="Board ID">ID {b.board_id}</span>}
                          {b.ip && <span title="IP : send port">{b.ip}{b.send_port !== undefined ? `:${b.send_port}` : ''}</span>}
                          {channels && <span title="Channel count">{channels}</span>}
                          {!b.enabled && (
                            <span
                              className="px-2 py-0.5 text-xs rounded bg-gray-700 text-text-muted not-italic"
                              title="Declared in config but not enabled — the pipeline ignores it. Says nothing about whether the hardware is connected."
                            >
                              not enabled
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    {open && (
                    <div className="p-4 pt-0 space-y-6">
                      <FieldSection title="General">
                        {renderField(
                          'Type',
                          (board as any).type,
                          (val) => updateBoard(boardKey, 'type', val),
                          'select',
                          ['PT', 'ACTUATOR', 'LC', 'TC', 'RTD', 'ENCODER']
                        )}
                        <div className="space-y-1">
                          {renderField(
                            'Board ID',
                            (board as any).board_id,
                            (val) => updateBoard(boardKey, 'board_id', val),
                            'number'
                          )}
                          {slotIssue && (
                            <InlineIssue level="error" className="mt-2">{slotIssue}</InlineIssue>
                          )}
                        </div>
                        {renderField(
                          'Enabled',
                          (board as any).enabled,
                          (val) => updateBoard(boardKey, 'enabled', val),
                          'boolean'
                        )}
                      </FieldSection>

                      <FieldSection title="Network">
                        {renderField(
                          'IP',
                          (board as any).ip,
                          (val) => updateBoard(boardKey, 'ip', val)
                        )}
                        {renderField(
                          'Send Port',
                          (board as any).send_port,
                          (val) => updateBoard(boardKey, 'send_port', val),
                          'number'
                        )}
                        {(board as any).listen_port !== undefined && renderField(
                          'Listen Port',
                          (board as any).listen_port,
                          (val) => updateBoard(boardKey, 'listen_port', val),
                          'number'
                        )}
                      </FieldSection>

                      <FieldSection title="Channels">
                        {renderField(
                          'Num Sensors',
                          (board as any).num_sensors,
                          (val) => updateBoard(boardKey, 'num_sensors', val),
                          'number'
                        )}
                        {(board as any).num_actuators !== undefined && renderField(
                          'Num Actuators',
                          (board as any).num_actuators,
                          (val) => updateBoard(boardKey, 'num_actuators', val),
                          'number'
                        )}
                        {renderField(
                          'Active Connectors',
                          (board as any).active_connectors,
                          (val) => updateBoard(boardKey, 'active_connectors', val),
                          'array'
                        )}
                      </FieldSection>

                      <FieldSection title="Signal & ADC">
                        {b.type === 'PT' && (
                          <div className="space-y-1">
                            <label className="block text-sm font-semibold">
                              Sensor type
                              <span className="text-xs text-text-muted ml-2">(sets the ADC reference)</span>
                            </label>
                            <select
                              value={ptType}
                              onChange={(e) => setPtType(e.target.value)}
                              disabled={!canEdit}
                              className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <option value={PT_TYPE_RATIOMETRIC}>0-5V ratiometric</option>
                              <option value={PT_TYPE_CURRENT_LOOP}>4-20 mA absolute</option>
                            </select>
                            <p className="text-xs text-text-muted">
                              {isHp
                                ? 'Current loop across a shunt resistor, measured against the internal 2.5 V reference. Supply-independent, so no excitation monitor is needed.'
                                : 'Excitation is the ADC reference (VDD), so the ratio cancels in hardware.'}
                            </p>
                          </div>
                        )}
                        <div className="space-y-1">
                          <label className="block text-sm font-semibold">
                            Voltage reference
                            {b.type === 'PT' && (
                              <span className="text-xs text-text-muted ml-2">(set by Sensor type)</span>
                            )}
                          </label>
                          <select
                            value={String((board as any).voltage_reference ?? 0)}
                            onChange={(e) => updateBoard(boardKey, 'voltage_reference', parseInt(e.target.value, 10))}
                            // On a PT board the reference follows from the sensor interface, so it is
                            // shown rather than edited — the two cannot be made to disagree.
                            disabled={!canEdit || b.type === 'PT'}
                            className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <option value="0">Internal (2.5V)</option>
                            <option value="1">VDD (ratiometric)</option>
                            <option value="2">5V (absolute)</option>
                          </select>
                        </div>
                        {(board as any).adc_ref_voltage !== undefined && renderField(
                          'ADC Reference Voltage (V)',
                          (board as any).adc_ref_voltage,
                          (val) => updateBoard(boardKey, 'adc_ref_voltage', val),
                          'number'
                        )}
                        {/* 4-20 mA conversion parameters — shown whenever the board declares that
                            interface, not only when the keys already exist, so a board can actually
                            be converted here. There is no per-connector list: the ADC reference is
                            set once per board, so every active connector uses the same path. */}
                        {isHp && renderField(
                          'Full Scale (PSI)',
                          b.hp_pt_full_scale_psi,
                          (val) => updateBoard(boardKey, 'hp_pt_full_scale_psi', val),
                          'number',
                          undefined,
                          'pressure at 20 mA; 4 mA is 0 PSI'
                        )}
                        {isHp && renderField(
                          'Sense Resistor (Ω)',
                          b.hp_pt_sense_resistor_ohms,
                          (val) => updateBoard(boardKey, 'hp_pt_sense_resistor_ohms', val),
                          'number',
                          undefined,
                          'shunt the loop current is measured across'
                        )}
                      </FieldSection>

                      <FieldSection title="Safety & logging">
                        {renderField(
                          'Logging mode',
                          String((board as any).enable_serial_printing ?? 0),
                          (val) => updateBoard(boardKey, 'enable_serial_printing', Number(val)),
                          'select',
                          ['0', '1', '2', '3'],
                          '0 USB only · 1 USB verbose · 2 stream Tier-1 · 3 stream Tier-1+2'
                        )}
                        {(board as any).necessary_for_abort !== undefined && renderField(
                          'Necessary for abort',
                          (board as any).necessary_for_abort,
                          (val) => updateBoard(boardKey, 'necessary_for_abort', val),
                          'boolean'
                        )}
                        {(board as any).designated_survivor !== undefined && renderField(
                          'Designated survivor (actuator only)',
                          (board as any).designated_survivor,
                          (val) => updateBoard(boardKey, 'designated_survivor', val),
                          'boolean'
                        )}
                      </FieldSection>
                    </div>
                    )}
                  </div>
                  );
                })}
                <button
                  onClick={() => {
                    const newKey = `board_${Object.keys(config.boards || {}).length + 1}`;
                    updateBoard(newKey, 'type', 'PT');
                    updateBoard(newKey, 'pt_type', PT_TYPE_RATIOMETRIC);
                    updateBoard(newKey, 'enabled', false);
                    updateBoard(newKey, 'enable_serial_printing', 0);
                    // Matches PT_TYPE_RATIOMETRIC above; the Sensor type selector owns this from here.
                    updateBoard(newKey, 'voltage_reference', 1);
                    // A board you just created is empty — open it so it can be filled in.
                    setOpenBoards((prev) => ({ ...prev, [newKey]: true }));
                  }}
                  className="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600"
                >
                  + Add Board
                </button>
              </div>
            </div>
          )}

          {activeTab === 'boards' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">ADC Voltage References</h2>
              <p className="text-sm text-text-muted mb-4">
                Used when voltage_reference = 0 (internal) or 2 (5V absolute). Ref 1 = VDD ratiometric.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'Internal (V)',
                  config.adc?.internal_v,
                  (val) => updateField('adc', 'internal_v', val),
                  'number',
                  undefined,
                  'Boards with voltage_reference = 0'
                )}
                {renderField(
                  'VDD Nominal (V)',
                  config.adc?.vdd_nominal_v,
                  (val) => updateField('adc', 'vdd_nominal_v', val),
                  'number',
                  undefined,
                  'Display only; ratiometric boards'
                )}
                {renderField(
                  'Absolute 5V (V)',
                  config.adc?.absolute_5v_v,
                  (val) => updateField('adc', 'absolute_5v_v', val),
                  'number',
                  undefined,
                  'Boards with voltage_reference = 2'
                )}
              </div>
            </div>
          )}

          {activeTab === 'roles' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Sensor Roles</h2>
              <div className="space-y-8">
                {/* One role panel per sensor board in config: sensor_roles_<boardKey>. Generalized
                    from a fixed pt_board/pt2/rtd/tc list so any board (incl. a 3rd PT board or an
                    HP board) gets a panel; the HP board is no longer special (was sensor_roles_pt2). */}
                {(Object.entries(((config as any).boards || {}) as Record<string, any>)
                  .filter(([, b]) => ['PT', 'RTD', 'TC', 'ENCODER'].includes(b?.type))
                  .map(([boardKey, b]) => {
                    const isPT = b?.type === 'PT';
                    const isLoop = isPT && !!(b?.hp_pt_connectors || b?.hp_pt_full_scale_psi != null || b?.pt_type === '4-20 mA absolute');
                    return {
                      key: `sensor_roles_${boardKey}`,
                      title: `${b.type} Roles — ${boardKey} (sensor_roles_${boardKey})`,
                      maxCh: typeof b.num_sensors === 'number' && b.num_sensors > 0 ? b.num_sensors : 10,
                      // cubic/robust/physics applies to every PT (cubic/robust fit the raw ADC; physics
                      // is the datasheet conversion). Default: 4-20 mA -> physics, 0-5 V -> cubic.
                      modelKey: `calibration_model_${boardKey}`,
                      fullScaleKey: `calibration_full_scale_${boardKey}`,
                      resistorKey: `calibration_sense_resistor_${boardKey}`,
                      showModel: isPT,
                      isLoop,
                      defaultModel: isLoop ? 'physics' : 'cubic',
                      boardFullScale: isLoop ? (typeof b?.hp_pt_full_scale_psi === 'number' ? b.hp_pt_full_scale_psi : 5000) : 1000,
                      boardResistor: typeof b?.hp_pt_sense_resistor_ohms === 'number' ? b.hp_pt_sense_resistor_ohms : 120,
                    };
                  })
                ).map(({ key, title, maxCh, modelKey, fullScaleKey, resistorKey, showModel, isLoop, defaultModel, boardFullScale, boardResistor }) => {
                  const map = (config as any)[key] as Record<string, number> | undefined;
                  // File (insertion) order so a row stays put while you edit its channel or name —
                  // the map is re-sorted by channel only on Save (see sortRolesForSave), never
                  // mid-edit. Renaming rebuilds the map preserving order, so rows don't jump.
                  const entries = Object.entries(map || {});
                  return (
                    <div key={key} className="space-y-4">
                      <h3 className="text-lg font-semibold">{title}</h3>
                      {entries.length === 0 && (
                        <p className="text-sm text-text-muted">
                          No entries. Add one to create this section in `config.toml`.
                        </p>
                      )}
                      {/* Column headers — the row is a flex of fixed-width cells, so each header
                          span carries the matching width to stay aligned above its input. The
                          physics params (Max PSI / Sense Ω) are always-present columns so the table
                          doesn't reflow when a sensor's model changes; they're only editable in
                          physics mode (see the disabled inputs below). */}
                      {entries.length > 0 && (
                        <div className="flex items-center gap-4 px-1 text-xs font-semibold uppercase tracking-wider text-text-muted">
                          <span className="flex-1">Role</span>
                          <span className="w-4 shrink-0" aria-hidden="true" />
                          <span className="w-28 shrink-0">Channel</span>
                          {showModel && <span className="w-32 shrink-0">Model</span>}
                          {showModel && (
                            <span className="w-24 shrink-0" title="Full-scale pressure (only used in physics-conversion mode)">Max PSI</span>
                          )}
                          {showModel && isLoop && (
                            <span className="w-24 shrink-0" title="Sense resistor for the 4-20 mA shunt (only used in physics-conversion mode)">Sense Ω</span>
                          )}
                          <span className="w-24 shrink-0" aria-hidden="true" />
                        </div>
                      )}
                      <div className="space-y-3">
                        {entries.map(([name, sensorId], idx) => {
                          // model resolves to '' for non-PT boards (showModel false); PT rows show
                          // the configured model with the interface-aware default.
                          const model = showModel
                            ? (((config as any)[modelKey]?.[name] as string) ?? defaultModel)
                            : '';
                          const isPhysics = model === 'physics';
                          return (
                          // Key by index, not name: keying by the (changing) name remounts the input
                          // on every keystroke → focus loss. Renames rebuild the map preserving order
                          // so the row stays in place (delete+re-add would jump it to the end).
                          <div key={`${key}:${idx}`} className="flex items-center gap-4">
                            <CommitOnBlurName
                              value={name}
                              siblings={Object.keys(map || {})}
                              rowKey={`${key}:${name}`}
                              onDupChange={onRoleDup}
                              onRename={(newName) => {
                                const rebuilt: Record<string, any> = {};
                                for (const [k, v] of Object.entries(map || {})) rebuilt[k === name ? newName : k] = v;
                                const patch: any = { ...config, [key]: rebuilt };
                                // Keep the parallel per-sensor maps (model + physics params) in sync.
                                for (const pk of [modelKey, fullScaleKey, resistorKey]) {
                                  const mm = (config as any)[pk];
                                  if (mm && name in mm) {
                                    const rebuiltMap: Record<string, any> = {};
                                    for (const [k, v] of Object.entries(mm)) rebuiltMap[k === name ? newName : k] = v;
                                    patch[pk] = rebuiltMap;
                                  }
                                }
                                // abort_pts is keyed by the sensor role name and feeds the boards'
                                // abort thresholds — rename it too, or that sensor's overpressure gate
                                // silently orphans (the role no longer resolves to a uid).
                                if (config.abort_pts && name in config.abort_pts) {
                                  const rebuiltAbort: Record<string, number> = {};
                                  for (const [k, v] of Object.entries(config.abort_pts))
                                    rebuiltAbort[k === name ? newName : k] = v as number;
                                  patch.abort_pts = rebuiltAbort;
                                }
                                setConfig(patch);
                              }}
                              onError={(msg) => { setError(msg); setTimeout(() => setError(null), 4000); }}
                              className="flex-1 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                            />
                            <span className="w-4 text-center text-text-muted shrink-0">=</span>
                            <CommitOnBlurNumber
                              value={typeof sensorId === 'number' ? sensorId : Number(sensorId)}
                              onCommit={(n) => {
                                if (n === undefined) return;
                                const updated = { ...(map || {}) };
                                updated[name] = n;
                                setConfig({ ...config, [key]: updated } as any);
                              }}
                              className="w-28 shrink-0 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                            />
                            {showModel && (
                              <>
                                <select
                                  value={model}
                                  onChange={(e) => {
                                    const updated = { ...((config as any)[modelKey] || {}) };
                                    updated[name] = e.target.value;
                                    setConfig({ ...config, [modelKey]: updated } as any);
                                  }}
                                  title="Streaming calibration model for this sensor"
                                  className="w-32 shrink-0 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                                >
                                  <option value="cubic">Cubic</option>
                                  <option value="robust">Robust</option>
                                  <option value="physics">Physics ({isLoop ? '4-20 mA' : '0-5 V'})</option>
                                </select>
                                {/* Always rendered so the table structure is stable across model
                                    changes; editable only in physics mode, otherwise it shows the
                                    board default read-only. */}
                                <CommitOnBlurNumber
                                  value={((config as any)[fullScaleKey]?.[name]) ?? boardFullScale}
                                  onCommit={(n) => {
                                    if (n === undefined) return;
                                    const u = { ...((config as any)[fullScaleKey] || {}) };
                                    u[name] = n;
                                    setConfig({ ...config, [fullScaleKey]: u } as any);
                                  }}
                                  disabled={!isPhysics}
                                  title={isPhysics ? 'Full-scale PSI (physics mode)' : 'Full-scale PSI — editable when this sensor is in physics mode'}
                                  className="w-24 shrink-0 px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed"
                                />
                                {isLoop && (
                                  <CommitOnBlurNumber
                                    value={((config as any)[resistorKey]?.[name]) ?? boardResistor}
                                    onCommit={(n) => {
                                      if (n === undefined) return;
                                      const u = { ...((config as any)[resistorKey] || {}) };
                                      u[name] = n;
                                      setConfig({ ...config, [resistorKey]: u } as any);
                                    }}
                                    disabled={!isPhysics}
                                    title={isPhysics ? 'Sense resistor Ω (4-20 mA shunt)' : 'Sense resistor Ω — editable when this sensor is in physics mode'}
                                    className="w-24 shrink-0 px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed"
                                  />
                                )}
                              </>
                            )}
                            <button
                              onClick={() => {
                                const updated = { ...(map || {}) };
                                delete updated[name];
                                const patch: any = { ...config, [key]: updated };
                                // Drop the sensor's parallel per-sensor entries too.
                                for (const pk of [modelKey, fullScaleKey, resistorKey]) {
                                  const mm = (config as any)[pk];
                                  if (mm && name in mm) {
                                    const um = { ...mm };
                                    delete um[name];
                                    patch[pk] = um;
                                  }
                                }
                                // And its abort threshold, or a removed sensor leaves a dangling
                                // abort_pts entry that resolves to no sensor.
                                if (config.abort_pts && name in config.abort_pts) {
                                  const ua = { ...config.abort_pts };
                                  delete ua[name];
                                  patch.abort_pts = ua;
                                }
                                setConfig(patch);
                              }}
                              className="w-24 shrink-0 px-3 py-2 bg-red-600 rounded hover:bg-red-700"
                            >
                              Remove
                            </button>
                          </div>
                          );
                        })}
                      </div>
                      <button
                        onClick={() => {
                          const updated = { ...(map || {}) };
                          // First free channel 1..maxCh (board's num_sensors). Full → don't add.
                          const used = new Set(Object.values(updated).map((v) => Number(v)));
                          let freeCh = 0;
                          for (let c = 1; c <= maxCh; c++) { if (!used.has(c)) { freeCh = c; break; } }
                          if (freeCh === 0) {
                            setError(`All ${maxCh} channels are in use here — remove a role before adding another.`);
                            setTimeout(() => setError(null), 4000);
                            return;
                          }
                          // Unique name so the new row doesn't merge onto an existing one.
                          let newName = `New Sensor ${freeCh}`;
                          let n = 2;
                          while (newName in updated) newName = `New Sensor ${freeCh} (${n++})`;
                          updated[newName] = freeCh;
                          setConfig({ ...config, [key]: updated } as any);
                        }}
                        className="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600"
                      >
                        + Add Role
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'roles' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Actuator Roles</h2>
              <div className="space-y-4">
                {Object.entries(config.actuator_roles || {})
                  // File (insertion) order so editing a channel/board/name doesn't move the row.
                  // Re-sorted by board_id then channel only on Save (sortRolesForSave), not mid-edit.
                  .map(([name, value], idx) => {
                  const arr = Array.isArray(value) ? value : [];
                  const type = (arr[0] as string) || 'NC';
                  const actuatorId = typeof arr[1] === 'number' ? arr[1] : Number(arr[1] || 1);
                  const third = arr.length >= 3 ? arr[2] : undefined;
                  const boardId = typeof third === 'number' ? third : (typeof third === 'string' ? Number(third) : undefined);
                  return (
                  // Key by index, not name — keying by the changing name remounts the row each
                  // keystroke (focus loss). Rename rebuilds preserving order so the row stays put.
                  <div key={`act:${idx}`} className="flex items-center gap-4">
                    <CommitOnBlurName
                      value={name}
                      siblings={Object.keys(config.actuator_roles || {})}
                      rowKey={`act:${name}`}
                      onDupChange={onRoleDup}
                      onRename={(newName) => {
                        const rebuilt: Record<string, any> = {};
                        for (const [k, v] of Object.entries(config.actuator_roles || {})) rebuilt[k === name ? newName : k] = v;
                        setConfig({ ...config, actuator_roles: rebuilt });
                      }}
                      onError={(msg) => { setError(msg); setTimeout(() => setError(null), 4000); }}
                      className="flex-1 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                    />
                    <span className="text-text-muted">=</span>
                    <select
                      value={type}
                      onChange={(e) => {
                        const updated = { ...config.actuator_roles };
                        updated[name] = third !== undefined
                          ? ([e.target.value, actuatorId, third] as any)
                          : ([e.target.value, actuatorId] as any);
                        setConfig({ ...config, actuator_roles: updated });
                      }}
                      className="px-3 py-2 bg-background border border-gray-700 rounded text-white"
                    >
                      <option value="NO">NO (Normally Open)</option>
                      <option value="NC">NC (Normally Closed)</option>
                    </select>
                    <CommitOnBlurNumber
                      value={actuatorId}
                      onCommit={(n) => {
                        if (n === undefined) return;
                        const updated = { ...config.actuator_roles };
                        updated[name] = third !== undefined ? ([type, n, third] as any) : ([type, n] as any);
                        setConfig({ ...config, actuator_roles: updated });
                      }}
                      className="w-24 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                      placeholder="Ch"
                    />
                    <CommitOnBlurNumber
                      value={Number.isFinite(boardId as number) ? (boardId as number) : undefined}
                      allowEmpty
                      onCommit={(n) => {
                        const updated = { ...config.actuator_roles };
                        updated[name] = n === undefined ? ([type, actuatorId] as any) : ([type, actuatorId, n] as any);
                        setConfig({ ...config, actuator_roles: updated });
                      }}
                      className="w-32 px-3 py-2 bg-background border border-gray-700 rounded text-white"
                      placeholder="Board ID"
                    />
                    <button
                      onClick={() => {
                        const updated = { ...config.actuator_roles };
                        delete updated[name];
                        setConfig({ ...config, actuator_roles: updated });
                      }}
                      className="px-3 py-2 bg-red-600 rounded hover:bg-red-700"
                    >
                      Remove
                    </button>
                  </div>
                  );
                })}
                <button
                  onClick={() => {
                    const updated = { ...config.actuator_roles };
                    let name = 'New Actuator';   // unique name so it doesn't merge onto an existing row
                    let n = 2;
                    while (name in updated) name = `New Actuator ${n++}`;
                    updated[name] = ['NC', 1, 12] as any;
                    setConfig({ ...config, actuator_roles: updated });
                  }}
                  className="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600"
                >
                  + Add Actuator Role
                </button>
              </div>
            </div>
          )}

          {activeTab === 'gui' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-1">Pressure Limits</h2>
              <p className="text-sm text-text-muted mb-4">
                NOP/MEOP/POP per system. These are the single source of truth for gauge thresholds —
                each top-bar gauge below points at one of these keys via its <code>limits</code> field, and the plots read them too.
              </p>
              <div className="space-y-4">
                {Object.keys(config.pressure_limits || {}).map((system) => (
                  <div key={system} className="border border-gray-700 rounded-lg p-4">
                    <h3 className="text-lg font-semibold mb-3 font-mono">{system}</h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {renderField('NOP', (config.pressure_limits as any)?.[system]?.NOP, (val) => updateField('pressure_limits', 'NOP', val, system), 'number')}
                      {renderField('MEOP', (config.pressure_limits as any)?.[system]?.MEOP, (val) => updateField('pressure_limits', 'MEOP', val, system), 'number')}
                      {renderField('POP', (config.pressure_limits as any)?.[system]?.POP, (val) => updateField('pressure_limits', 'POP', val, system), 'number')}
                    </div>
                  </div>
                ))}
                {Object.keys(config.pressure_limits || {}).length === 0 && (
                  <p className="text-sm text-text-muted">No pressure limits defined in config.</p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'gui' && (
            <div className="space-y-6">
              {/* ── Tab bar ──────────────────────────────────────────────── */}
              <div className="bg-card rounded-lg p-6">
                <h2 className="text-xl font-bold mb-1">Tab Bar</h2>
                <p className="text-sm text-text-muted mb-4">
                  Which views are pinned to the header, in order. Others stay reachable via “All Views”.
                </p>
                <div className="space-y-2">
                  {guiTabs.map((id, i) => (
                    <div key={`${id}:${i}`} className="flex items-center gap-2">
                      <span className="w-8 text-text-muted text-sm text-right">{i + 1}.</span>
                      <span className="flex-1 px-3 py-2 bg-background border border-gray-700 rounded">
                        {navItemById(id)?.name ?? id}
                        <span className="text-text-muted text-xs ml-2">({id})</span>
                      </span>
                      <button onClick={() => setGuiTabs(moveInArray(guiTabs, i, -1))} className="px-2 py-2 bg-gray-700 rounded hover:bg-gray-600" title="Move up">↑</button>
                      <button onClick={() => setGuiTabs(moveInArray(guiTabs, i, 1))} className="px-2 py-2 bg-gray-700 rounded hover:bg-gray-600" title="Move down">↓</button>
                      <button onClick={() => setGuiTabs(guiTabs.filter((_, k) => k !== i))} className="px-3 py-2 bg-red-600 rounded hover:bg-red-700">Remove</button>
                    </div>
                  ))}
                  {guiTabs.length === 0 && (
                    <p className="text-sm text-text-muted">No tabs configured — the tab bar falls back to built-in defaults.</p>
                  )}
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) setGuiTabs([...guiTabs, e.target.value]); }}
                    className="px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50"
                  >
                    <option value="">+ Add tab…</option>
                    {NAV_ITEMS.filter((v) => !v.deprecated && !guiTabs.includes(v.id)).map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* ── Top-bar pressure gauges ──────────────────────────────── */}
              <div className="bg-card rounded-lg p-6">
                <h2 className="text-xl font-bold mb-1">Top-Bar Pressure Gauges</h2>
                <p className="text-sm text-text-muted mb-4">
                  Ordered gauges in the header. NOP/MEOP come from Pressure Limits above (via the <code>limits</code> key).
                </p>
                {/* Column header so each field is labeled (md+ only; on mobile the fields stack). */}
                <div className="hidden md:grid md:grid-cols-12 gap-2 px-2 mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                  <div className="md:col-span-3">Sensor (PT role)</div>
                  <div className="md:col-span-3">Label on gauge</div>
                  <div className="md:col-span-2">Limits (NOP/MEOP)</div>
                  <div className="md:col-span-2">Color</div>
                  <div className="md:col-span-2 text-right">Order · remove</div>
                </div>
                <div className="space-y-3">
                  {guiBars.map((bar: any, i: number) => {
                    const setBar = (patch: any) => setGuiBars(guiBars.map((b: any, k: number) => (k === i ? { ...b, ...patch } : b)));
                    return (
                      <div key={i} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center border border-gray-800 rounded p-2">
                        {/* Pick the pressure sensor in ONE dropdown; its limits come with it (matched by
                            the space→underscore [pressure_limits] key convention), and the label auto-fills
                            with the sensor name (still editable — shorten it as you like). */}
                        <select
                          value={bar.role ?? ''}
                          onChange={(e) => {
                            const newRole = e.target.value || undefined;
                            const patch: any = { role: newRole };
                            // Auto-fill the label from the sensor name unless the user typed a custom one.
                            // "Uncustomized" = empty, the 'NEW' add-default, or equal to the previous role.
                            if (!bar.label || bar.label === 'NEW' || bar.label === bar.role) patch.label = newRole ?? '';
                            if (newRole) {
                              const conv = newRole.replace(/\s+/g, '_');
                              if (pressureLimitKeys.includes(conv)) patch.limits = conv;
                            }
                            setBar(patch);
                          }}
                          className="md:col-span-3 px-2 py-1.5 bg-background border border-gray-700 rounded text-white"
                        >
                          <option value="">— pressure sensor —</option>
                          {pressureRoles.map((r) => <option key={r} value={r}>{r}</option>)}
                          {bar.role && !pressureRoles.includes(bar.role) && <option value={bar.role}>{bar.role} (not a PT role)</option>}
                        </select>
                        <input value={bar.label ?? ''} onChange={(e) => setBar({ label: e.target.value })} placeholder="Label (shown on gauge)" className="md:col-span-3 px-2 py-1.5 bg-background border border-gray-700 rounded text-white" />
                        <div className="md:col-span-2 text-xs text-text-muted truncate self-center" title="Pressure limits (NOP/MEOP) for this gauge — from Pressure Limits above, matched to the sensor by name. 'default' = no matching limits, so generic thresholds are used.">
                          {bar.limits ? bar.limits : 'default'}
                        </div>
                        <div className="md:col-span-2 flex items-center gap-1">
                          <input type="color" value={bar.color ?? '#888888'} onChange={(e) => setBar({ color: e.target.value })} className="h-8 w-10 bg-background border border-gray-700 rounded" />
                          <input value={bar.color ?? ''} onChange={(e) => setBar({ color: e.target.value })} placeholder="#RRGGBB" className="flex-1 min-w-0 px-2 py-1.5 bg-background border border-gray-700 rounded text-white" />
                        </div>
                        <div className="md:col-span-2 flex items-center justify-end gap-1">
                          <button onClick={() => setGuiBars(moveInArray(guiBars, i, -1))} className="px-2 py-1.5 bg-gray-700 rounded hover:bg-gray-600" title="Move up">↑</button>
                          <button onClick={() => setGuiBars(moveInArray(guiBars, i, 1))} className="px-2 py-1.5 bg-gray-700 rounded hover:bg-gray-600" title="Move down">↓</button>
                          <button onClick={() => setGuiBars(guiBars.filter((_: any, k: number) => k !== i))} className="px-2 py-1.5 bg-red-600 rounded hover:bg-red-700" title="Remove">✕</button>
                        </div>
                        <input value={(bar.avg_roles ?? []).join(', ')} onChange={(e) => { const parts = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); setBar({ avg_roles: parts.length ? parts : undefined }); }} placeholder="Optional — average multiple redundant sensors into this one gauge (comma-separated role names, e.g. two chamber PTs). Leave blank for a single sensor." className="md:col-span-12 px-2 py-1.5 bg-background border border-gray-700 rounded text-white" />
                      </div>
                    );
                  })}
                </div>
                <button
                  onClick={() => setGuiBars([...guiBars, { label: '', role: '', limits: '', color: '#888888' }])}
                  className="mt-4 px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600"
                >
                  + Add Gauge
                </button>
              </div>
            </div>
          )}

          {activeTab === 'controller' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Controller</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'Controller Loop (Hz)',
                  config.controller?.controller_loop_hz,
                  (val) => updateField('controller', 'controller_loop_hz', val),
                  'number'
                )}
                {renderField(
                  'PWM Frequency (Hz)',
                  config.controller?.pwm_frequency_hz,
                  (val) => updateField('controller', 'pwm_frequency_hz', val),
                  'number'
                )}
                {renderField(
                  'PWM Duration (ms)',
                  config.controller?.pwm_duration_ms,
                  (val) => updateField('controller', 'pwm_duration_ms', val),
                  'number'
                )}
                {renderField(
                  'Use C++ Controller',
                  config.controller?.use_cpp_controller,
                  (val) => updateField('controller', 'use_cpp_controller', val),
                  'boolean'
                )}
                {renderField(
                  'Command Type',
                  config.controller?.command_type,
                  (val) => updateField('controller', 'command_type', val),
                  'select',
                  ['THRUST_DESIRED', 'ALTITUDE_GOAL', 'PRESSURE_TARGET']
                )}
                {renderField(
                  'Thrust Desired',
                  config.controller?.thrust_desired,
                  (val) => updateField('controller', 'thrust_desired', val),
                  'number'
                )}
                {renderField(
                  'Altitude Goal',
                  config.controller?.altitude_goal,
                  (val) => updateField('controller', 'altitude_goal', val),
                  'number'
                )}
                {renderField(
                  'Fuel Pressure Target',
                  config.controller?.pressure_fuel_target,
                  (val) => updateField('controller', 'pressure_fuel_target', val),
                  'number'
                )}
                {renderField(
                  'Ox Pressure Target',
                  config.controller?.pressure_ox_target,
                  (val) => updateField('controller', 'pressure_ox_target', val),
                  'number'
                )}
              </div>
            </div>
          )}

          {activeTab === 'state' && (
            <div className="bg-card rounded-lg p-6 space-y-6">
              <div>
                <h2 className="text-xl font-bold mb-1">State Machine</h2>
                <p className="text-sm text-text-muted">
                  Editable. These tables belong to the active config profile and deploy with it, so
                  each profile has its own. The sequencer reads them at pipeline start — change them
                  with the session stopped and the next run picks them up.
                </p>
              </div>

              {/* ── The state list itself ───────────────────────────────────────────── */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold mr-auto">States</h3>
                  <button onClick={addState} disabled={!canEdit} className="px-3 py-1.5 bg-gray-700 rounded hover:bg-gray-600 text-sm disabled:opacity-50">
                    + Add state
                  </button>
                </div>
                <p className="text-sm text-text-muted">
                  Names shown everywhere — logs, the diagram, and the column headers below. Row and
                  column place the state on the state diagram; leave them blank to keep it off the
                  diagram. Ids are a stable key: rename and reorder freely, but never reuse an id,
                  because past runs store the raw number.
                </p>

                {(stateIdDupes.length > 0 || stateNameDupes.length > 0) && (
                  <InlineIssue level="error">
                    {stateIdDupes.length > 0 && <p>Duplicate id(s): <strong>{stateIdDupes.join(', ')}</strong> — the later entry wins and the earlier state disappears.</p>}
                    {stateNameDupes.length > 0 && <p>Duplicate name(s): <strong>{stateNameDupes.join(', ')}</strong> — CSV columns resolve by name, so one of them is unreachable.</p>}
                  </InlineIssue>
                )}
                {(stateCsvDiff.orphan.length > 0 || stateCsvDiff.missing.length > 0) && (
                  <InlineIssue level="warn">
                    {stateCsvDiff.orphan.length > 0 && <p>In the tables below but not a state: <strong>{stateCsvDiff.orphan.join(', ')}</strong>.</p>}
                    {stateCsvDiff.missing.length > 0 && <p>A state with no column in the tables below: <strong>{stateCsvDiff.missing.join(', ')}</strong> — entering it commands nothing.</p>}
                  </InlineIssue>
                )}
                {stateList.length > 0 && stateList.every((s) => !s.is_abort) && (
                  <InlineIssue level="warn">
                    <p>
                      No state is flagged <strong>Abort</strong>. Aborts are <em>not</em> disabled — the
                      controller falls back to its built-in aborts (Engine / GSE / Emergency), which may
                      not match your states. Flag the intended abort state(s) explicitly. (Board over-pressure
                      aborts via <code>[abort_pts]</code> are separate and still active.)
                    </p>
                  </InlineIssue>
                )}

                <div className="overflow-x-auto rounded-lg border border-gray-600">
                  <table className="text-sm w-full border-collapse">
                    <thead>
                      <tr className="bg-gray-700 text-white">
                        <th className="px-3 py-2 text-left font-semibold w-20">ID</th>
                        <th className="px-3 py-2 text-left font-semibold">Name</th>
                        <th className="px-3 py-2 text-left font-semibold w-24">Row</th>
                        <th className="px-3 py-2 text-left font-semibold w-24">Col</th>
                        <th className="px-3 py-2 text-left font-semibold w-20">Boot</th>
                        <th className="px-3 py-2 text-left font-semibold w-20">Abort</th>
                        <th className="px-3 py-2 w-20" />
                      </tr>
                    </thead>
                    <tbody>
                      {stateList.map((st, i) => (
                        <tr key={`state:${i}`} className={i % 2 ? 'bg-white/[0.04]' : ''}>
                          <td className="px-3 py-1.5">
                            <CommitOnBlurNumber
                              value={st.id}
                              onCommit={(v) => setState(i, { id: Math.max(1, Math.round(v)) })}
                              className={`w-16 px-2 py-1 bg-gray-800 border rounded text-white ${st.id !== undefined && stateIdDupes.includes(st.id) ? 'border-red-500 ring-1 ring-red-500' : 'border-gray-600'}`}
                            />
                            {st.id !== undefined && stateIdDupes.includes(st.id) && <div className="text-[10px] text-red-400 mt-0.5">duplicate id</div>}
                          </td>
                          <td className="px-3 py-1.5">
                            <input
                              type="text"
                              value={st.name ?? ''}
                              onFocus={() => { renameOrigRef.current = stateList[i]?.name ?? null; }}
                              onChange={(e) => setState(i, { name: e.target.value })}
                              onBlur={() => commitStateRename(i)}
                              disabled={!canEdit}
                              className={`w-full px-2 py-1 bg-gray-800 border rounded text-white disabled:opacity-60 ${st.name && stateNameDupes.includes(st.name) ? 'border-red-500 ring-1 ring-red-500' : 'border-gray-600'}`}
                            />
                            {st.name && stateNameDupes.includes(st.name) && <div className="text-[10px] text-red-400 mt-0.5">duplicate name</div>}
                          </td>
                          <td className="px-3 py-1.5">
                            <CommitOnBlurNumber
                              value={st.panel_row}
                              allowEmpty
                              onCommit={(v) => setState(i, { panel_row: v })}
                              className="w-16 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white"
                            />
                          </td>
                          <td className="px-3 py-1.5">
                            <CommitOnBlurNumber
                              value={st.panel_col}
                              allowEmpty
                              onCommit={(v) => setState(i, { panel_col: v })}
                              className="w-16 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white"
                            />
                          </td>
                          <td className="px-3 py-1.5">
                            <input
                              type="checkbox"
                              checked={st.is_boot === true}
                              onChange={(e) => setState(i, { is_boot: e.target.checked })}
                              disabled={!canEdit}
                              title="The state the sequencer starts in"
                              className="w-4 h-4 accent-blue-400"
                            />
                          </td>
                          <td className="px-3 py-1.5">
                            <input
                              type="checkbox"
                              checked={st.is_abort === true}
                              onChange={(e) => setState(i, { is_abort: e.target.checked })}
                              disabled={!canEdit}
                              title="Triggers the physical abort broadcast, and skips actuator delays"
                              className="w-4 h-4 accent-red-400"
                            />
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap">
                            <button
                              onClick={() => moveState(i, -1)}
                              disabled={!canEdit || i === 0}
                              title="Move up (also reorders the table columns)"
                              className="px-2 py-1 bg-gray-700 rounded hover:bg-gray-600 text-xs disabled:opacity-30 mr-1"
                            >↑</button>
                            <button
                              onClick={() => moveState(i, 1)}
                              disabled={!canEdit || i === stateList.length - 1}
                              title="Move down (also reorders the table columns)"
                              className="px-2 py-1 bg-gray-700 rounded hover:bg-gray-600 text-xs disabled:opacity-30 mr-1"
                            >↓</button>
                            <button
                              onClick={() => removeState(i)}
                              disabled={!canEdit}
                              className="px-2 py-1 bg-red-600 rounded hover:bg-red-700 text-xs disabled:opacity-50"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                      {stateList.length === 0 && (
                        <tr><td colSpan={7} className="px-3 py-3 text-sm text-text-muted">
                          No [[states]] declared — the built-in list is in use. Add one to start overriding it.
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="text-sm text-text-muted">
                  States are saved with the rest of the config — use <strong>Save Config</strong> at the top.
                </p>
              </div>

              {csvLoading && <p className="text-sm text-text-muted">Loading…</p>}
              {!csvLoading && !csvActuators && (
                <button onClick={loadStateCsvs} className="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600">
                  Load state tables
                </button>
              )}

              {csvActuators && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold mr-auto">Actuator positions per state</h3>
                    <label className="flex items-center gap-2 text-sm text-text-muted mr-2">
                      <input type="checkbox" checked={showDelays} onChange={(e) => setShowDelays(e.target.checked)} className="w-4 h-4" />
                      Show delays
                    </label>
                    <button onClick={loadStateCsvs} className="px-3 py-1.5 bg-gray-700 rounded hover:bg-gray-600 text-sm">Reload</button>
                    <button onClick={() => downloadStateCsv('actuators')} className="px-3 py-1.5 bg-gray-700 rounded hover:bg-gray-600 text-sm">Download</button>
                    <label className="px-3 py-1.5 bg-gray-700 rounded hover:bg-gray-600 text-sm cursor-pointer">
                      Upload
                      <input
                        type="file" accept=".csv,text/csv" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadStateCsv('actuators', f); e.target.value = ''; }}
                      />
                    </label>
                    <button onClick={generateEmptyActuators} disabled={!canEdit} className="px-3 py-1.5 bg-gray-700 rounded hover:bg-gray-600 text-sm disabled:opacity-50" title="Every configured actuator, every current state, all CLOSE">
                      Regenerate empty
                    </button>
                  </div>

                  {(actuatorDiff.orphan.length > 0 || actuatorDiff.missing.length > 0 || delayShapeMismatch) && (
                    <InlineIssue level="warn">
                      {actuatorDiff.orphan.length > 0 && (
                        <p>In this table but not in <code>[actuator_roles]</code>: <strong>{actuatorDiff.orphan.join(', ')}</strong> — these rows command nothing.</p>
                      )}
                      {actuatorDiff.missing.length > 0 && (
                        <p>Configured but missing a row: <strong>{actuatorDiff.missing.join(', ')}</strong> — the sequencer will never command these in any state.</p>
                      )}
                      {delayShapeMismatch && <p>The delays table has a different shape — use Sync rows to rebuild both.</p>}
                      <button onClick={syncActuatorRows} className="mt-1 px-3 py-1.5 bg-gray-700 rounded hover:bg-gray-600 text-yellow-100">
                        Sync rows to [actuator_roles]
                      </button>
                    </InlineIssue>
                  )}

                  <div className="overflow-x-auto rounded-lg border border-gray-600">
                    <table className="text-sm min-w-max border-collapse">
                      <thead>
                        {/* Header and row-key column are lifted well above the cell surface — at
                            20 columns wide the grid is unreadable if everything sits at the same
                            near-black level. */}
                        <tr className="bg-gray-700 text-white">
                          <th className="sticky left-0 z-10 bg-gray-700 px-3 py-2 text-left font-semibold border-r border-gray-500">
                            Actuator
                          </th>
                          {csvActuators.states.map((st) => (
                            <th key={st} className="px-2 py-2 text-left font-semibold whitespace-nowrap border-l border-gray-600/60">{st}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {csvActuators.rows.map((row, ri) => (
                          <tr key={`act:${ri}`} className={ri % 2 ? 'bg-white/[0.04]' : 'bg-transparent'}>
                            <td className={`sticky left-0 z-10 px-3 py-1.5 font-mono whitespace-nowrap border-r border-gray-600 ${ri % 2 ? 'bg-[#232a36]' : 'bg-[#1d2430]'}`}>{row.key}</td>
                            {csvActuators.states.map((st, ci) => (
                              <td key={`${ri}:${ci}`} className="px-2 py-1.5 border-l border-gray-700/50">
                                <div className="flex items-center gap-1">
                                  {/* Value-coloured: OPEN is the exception in most tables, so it
                                      is the one that should catch the eye when scanning a state
                                      column. CLOSE stays muted rather than shouting. */}
                                  <select
                                    value={(row.cells[ci] || 'CLOSE').toUpperCase()}
                                    onChange={(e) => setActuatorCell(ri, ci, e.target.value)}
                                    disabled={!canEdit}
                                    // OPEN is filled and light, CLOSE is dark and recessed. The
                                    // difference has to survive being scanned across a 20-column
                                    // grid at a glance, so it is a light/dark flip rather than two
                                    // similar dark tints.
                                    className={`px-2 py-1 rounded border disabled:opacity-60 ${
                                      (row.cells[ci] || 'CLOSE').toUpperCase() === 'OPEN'
                                        ? 'bg-slate-200 border-slate-100 text-slate-900 font-bold'
                                        : 'bg-slate-900 border-slate-700 text-slate-500 font-normal'
                                    }`}
                                  >
                                    <option value="CLOSE">CLOSE</option>
                                    <option value="OPEN">OPEN</option>
                                  </select>
                                  {showDelays && (
                                    <input
                                      type="text" inputMode="decimal"
                                      value={csvDelays?.rows.find((r) => r.key === row.key)?.cells[ci] ?? '0'}
                                      onChange={(e) => setDelayCell(row.key, ci, e.target.value)}
                                      disabled={!canEdit}
                                      title="Delay in seconds after the transition before this actuator moves"
                                      className="w-14 px-1 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs disabled:opacity-60"
                                    />
                                  )}
                                </div>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {showDelays && (
                    <p className="text-sm text-text-muted">
                      Seconds after the transition before that actuator moves. 0 (or blank) is
                      immediate. Delays run on a state change only — the sequencer&apos;s 1 Hz
                      republish holds a delayed actuator at its previous position until its delay
                      elapses, and abort states ignore delays entirely.
                    </p>
                  )}
                </div>
              )}

              {csvTransitions && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold mr-auto">Allowed transitions</h3>
                    <button onClick={() => downloadStateCsv('transitions')} className="px-3 py-1.5 bg-gray-700 rounded hover:bg-gray-600 text-sm">Download</button>
                    <label className="px-3 py-1.5 bg-gray-700 rounded hover:bg-gray-600 text-sm cursor-pointer">
                      Upload
                      <input
                        type="file" accept=".csv,text/csv" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadStateCsv('transitions', f); e.target.value = ''; }}
                      />
                    </label>
                    <button onClick={generateEmptyTransitions} disabled={!canEdit} className="px-3 py-1.5 bg-gray-700 rounded hover:bg-gray-600 text-sm disabled:opacity-50" title="Blank matrix: the only allowed move from each state is to itself (the diagonal)">Regenerate empty</button>
                  </div>

                  {(stateColDiff.orphan.length > 0 || stateColDiff.missing.length > 0) && (
                    <InlineIssue level="warn">
                      <p>
                        The two tables disagree on states
                        {stateColDiff.orphan.length > 0 && <> — only in actuators: <strong>{stateColDiff.orphan.join(', ')}</strong></>}
                        {stateColDiff.missing.length > 0 && <> — only in transitions: <strong>{stateColDiff.missing.join(', ')}</strong></>}.
                        A state missing from the actuator table commands nothing when entered.
                      </p>
                    </InlineIssue>
                  )}

                  <p className="text-sm text-text-muted">Row = state you are in, column = state you may go to.</p>
                  <div className="overflow-x-auto rounded-lg border border-gray-600">
                    <table className="text-sm min-w-max border-collapse">
                      <thead>
                        <tr className="bg-gray-700 text-white">
                          <th className="sticky left-0 z-10 bg-gray-700 px-3 py-2 text-left font-semibold border-r border-gray-500">From \ To</th>
                          {csvTransitions.states.map((st) => (
                            <th key={st} className="px-2 py-2 text-left font-semibold whitespace-nowrap border-l border-gray-600/60">{st}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {csvTransitions.rows.map((row, ri) => (
                          <tr key={`tr:${ri}`} className={ri % 2 ? 'bg-white/[0.04]' : 'bg-transparent'}>
                            <td className={`sticky left-0 z-10 px-3 py-1.5 font-mono whitespace-nowrap border-r border-gray-600 ${ri % 2 ? 'bg-[#232a36]' : 'bg-[#1d2430]'}`}>{row.key}</td>
                            {csvTransitions.states.map((st, ci) => {
                              const on = (row.cells[ci] || '0').trim() === '1';
                              return (
                              // Allowed cells are tinted, not just ticked: a 20x20 matrix of bare
                              // checkboxes is very hard to read a row or column out of.
                              <td
                                key={`${ri}:${ci}`}
                                className={`px-2 py-1.5 text-center border-l border-gray-700/50 ${on ? 'bg-blue-500/25' : ''}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={(e) => setTransitionCell(ri, ci, e.target.checked)}
                                  disabled={!canEdit}
                                  className="w-4 h-4 accent-blue-400 disabled:opacity-60"
                                />
                              </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Fire ───────────────────────────────────────────────────────────── */}
              <div className="space-y-3">
                <h3 className="text-lg font-semibold">Fire</h3>
                <p className="text-sm text-text-muted">
                  Which state is the burn and where its timer lands when it expires. Both are state
                  names, not positions, so renaming a state here is safe as long as both fields
                  still name a state that exists.
                </p>
                {(() => {
                  const names = stateList.map((x) => x.name).filter(Boolean) as string[];
                  const fireState = config.fire?.state ?? '';
                  const target = config.fire?.expiry_target ?? '';
                  const unknownFire = !!fireState && names.length > 0 && !names.includes(fireState);
                  const unknownTarget = !!target && names.length > 0 && !names.includes(target);
                  // The fire state must be able to REACH its expiry target, or the timer expires
                  // into a refused transition and the system sits in fire with a dead timer.
                  let unreachable = false;
                  if (csvTransitions && fireState && target) {
                    const r = csvTransitions.rows.find((x) => x.key === fireState);
                    const ci = csvTransitions.states.indexOf(target);
                    if (r && ci >= 0) unreachable = (r.cells[ci] || '0').trim() !== '1';
                  }
                  return (
                    <>
                      {(unknownFire || unknownTarget || unreachable) && (
                        <InlineIssue level="error">
                          {unknownFire && <p><strong>{fireState}</strong> is not a state in the States list above.</p>}
                          {unknownTarget && <p><strong>{target}</strong> is not a state in the States list above.</p>}
                          {unreachable && (
                            <p>
                              <strong>{fireState} → {target}</strong> is not an allowed transition. The fire timer
                              would expire into a refused transition and the system would stay in fire. Tick that
                              cell in the Allowed transitions table above.
                            </p>
                          )}
                        </InlineIssue>
                      )}
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        <div className="space-y-1">
                          <label className="block text-sm font-semibold">
                            Fire state
                            <span className="text-xs text-text-muted ml-2">
                              ({fireState ? 'the state that starts the burn' : 'none — the fire timer never arms'})
                            </span>
                          </label>
                          <select
                            value={fireState}
                            onChange={(e) => updateField('fire', 'state', e.target.value)}
                            disabled={!canEdit}
                            className="w-full px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <option value="">— none (never fires) —</option>
                            {(names.length ? names : [fireState].filter(Boolean)).map((n) => (
                              <option key={n} value={n}>{n}</option>
                            ))}
                          </select>
                        </div>
                        {renderField('Expires to', target,
                          (v) => updateField('fire', 'expiry_target', v), 'select',
                          names.length ? names : [target].filter(Boolean),
                          fireState ? 'where the timer lands' : 'unused while there is no fire state')}
                        {renderField('Duration (ms)', config.fire?.duration_ms,
                          (v) => updateField('fire', 'duration_ms', v), 'number')}
                        {renderField('Extended (ms)', config.fire?.extended_ms,
                          (v) => updateField('fire', 'extended_ms', v), 'number',
                          undefined, 'window EXTEND FIRE restarts at')}
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* ── Abort thresholds ────────────────────────────────────────────────── */}
              <div className="space-y-3">
                <h3 className="text-lg font-semibold">Abort pressure thresholds</h3>
                <p className="text-sm text-text-muted">
                  PSI limits broadcast to the boards, which abort autonomously when a sensor exceeds
                  them — they do not depend on the server being alive. The name must match a sensor
                  role exactly.
                </p>
                <div className="space-y-2">
                  {Object.entries(config.abort_pts || {}).map(([role, psi], i) => (
                    <div key={`abort:${i}`} className="flex items-center gap-3">
                      <CommitOnBlurName
                        value={role}
                        siblings={Object.keys(config.abort_pts || {})}
                        rowKey={`abort:${role}`}
                        onDupChange={onRoleDup}
                        onRename={(next) => {
                          const rebuilt: Record<string, any> = {};
                          for (const [k, v] of Object.entries(config.abort_pts || {})) rebuilt[k === role ? next : k] = v;
                          setConfig({ ...config, abort_pts: rebuilt } as ConfigData);
                        }}
                        onError={(msg) => { setError(msg); setTimeout(() => setError(null), 4000); }}
                        className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white"
                      />
                      <CommitOnBlurNumber
                        value={psi as number}
                        onCommit={(v) => setConfig({ ...config, abort_pts: { ...(config.abort_pts || {}), [role]: v } } as ConfigData)}
                        className="w-28 px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white"
                      />
                      <span className="text-sm text-text-muted w-10">PSI</span>
                      <button
                        onClick={() => {
                          const next = { ...(config.abort_pts || {}) };
                          delete next[role];
                          setConfig({ ...config, abort_pts: next } as ConfigData);
                        }}
                        disabled={!canEdit}
                        className="px-3 py-2 bg-red-600 rounded hover:bg-red-700 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {Object.keys(config.abort_pts || {}).length === 0 && (
                    <p className="text-sm text-amber-300/90">
                      No abort thresholds configured — the boards will not abort on over-pressure by themselves.
                    </p>
                  )}
                  <button
                    onClick={() => setConfig({ ...config, abort_pts: { ...(config.abort_pts || {}), 'New Abort PT': 0 } } as ConfigData)}
                    disabled={!canEdit}
                    className="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600 disabled:opacity-50"
                  >
                    + Add threshold
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'calibration' && (
            <div className="bg-card rounded-lg p-6 space-y-4">
              <div>
                <h2 className="text-xl font-bold mb-1">Calibration profiles</h2>
                <p className="text-sm text-text-muted">
                  A calibration profile is the whole rig&apos;s cal in one file (every sensor, keyed by
                  channel). Load one to switch the entire rig&apos;s calibration at once — it applies to
                  the running stream immediately during a session, otherwise at the next session start.
                  Capture points per sensor on the Calibration page.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-semibold">Profile:</span>
                <select
                  value={calActive}
                  onChange={(e) => loadCalProfile(e.target.value)}
                  disabled={!canEdit}
                  title={canEdit ? 'Load a saved calibration (swaps the whole rig)' : 'Operators only'}
                  className="px-3 py-2 bg-background border border-gray-700 rounded text-white disabled:opacity-50 disabled:cursor-not-allowed min-w-[14rem]"
                >
                  {calActive === '' && <option value="">{calProfiles.length ? '— unsaved / blank —' : '— none saved —'}</option>}
                  {calProfiles.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}{p.active ? ' (loaded)' : ''}</option>
                  ))}
                </select>
                <button onClick={saveCalProfileAs} disabled={!canEdit}
                  className="px-3 py-2 bg-card border border-gray-700 rounded-lg hover:bg-opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={canEdit ? 'Snapshot the current live calibration as a named profile' : 'Operators only'}>Save as…</button>
                <button onClick={newBlankCalibration} disabled={!canEdit}
                  className="px-3 py-2 bg-card border border-gray-700 rounded-lg hover:bg-opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={canEdit ? 'Start from scratch — every sensor reads 0 until re-calibrated' : 'Operators only'}>New blank</button>
              </div>
              {calMsg && (
                <div className="p-3 bg-blue-900/30 border border-blue-700 rounded-lg text-blue-100 text-sm">{calMsg}</div>
              )}
              <p className="text-xs text-text-muted">
                Profiles live in <code>scripts/calibration/calibrations/profiles</code> and are committed to
                the repo, so a saved calibration travels between computers. New blank resets every sensor to 0.
              </p>
            </div>
          )}

          {activeTab === 'system' && (
            <div className="bg-card rounded-lg p-6 space-y-6">
              <div>
                <h2 className="text-xl font-bold mb-1">Network</h2>
                <p className="text-sm text-amber-300/90 mb-4">
                  Read-only — these are startup-only binds for the pipeline services and must match the
                  board firmware. Changing them requires a deploy/restart, not a live edit.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {renderField(
                    'Bind IP',
                    config.network?.bind_ip,
                    (val) => updateField('network', 'bind_ip', val),
                    'text', undefined, 'DAQ bridge sensor-socket interface', true
                  )}
                  {renderField(
                    'Sensor Port',
                    config.network?.sensor_port,
                    (val) => updateField('network', 'sensor_port', val),
                    'number', undefined, 'UDP port boards send sensor data to', true
                  )}
                  {renderField(
                    'Actuator Command Port',
                    config.network?.actuator_cmd_port,
                    (val) => updateField('network', 'actuator_cmd_port', val),
                    'number', undefined, 'Port boards listen on for actuator commands', true
                  )}
                </div>
              </div>

              <div className="border-t border-gray-700 pt-6">
                <h3 className="text-lg font-semibold mb-1">Board Discovery</h3>
                <p className="text-sm text-amber-300/90 mb-4">
                  Read-only — the discovery service scans this subnet/interface at startup. Editing it
                  live has no effect until the pipeline restarts.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {renderField(
                    'Enabled', config.discovery?.enabled,
                    (val) => updateField('discovery', 'enabled', val),
                    'boolean', undefined, undefined, true
                  )}
                  {renderField(
                    'Network Interface', config.discovery?.network_interface,
                    (val) => updateField('discovery', 'network_interface', val),
                    'text', undefined, '"auto" = interface with a 192.168.2.x IP', true
                  )}
                  {renderField(
                    'Mode', config.discovery?.mode,
                    (val) => updateField('discovery', 'mode', val),
                    'select', ['passive', 'active', 'hybrid'], undefined, true
                  )}
                  {renderField(
                    'Subnet', config.discovery?.subnet,
                    (val) => updateField('discovery', 'subnet', val),
                    'text', undefined, undefined, true
                  )}
                  {renderField(
                    'IP Range Start', config.discovery?.ip_range_start,
                    (val) => updateField('discovery', 'ip_range_start', val),
                    'number', undefined, undefined, true
                  )}
                  {renderField(
                    'IP Range End', config.discovery?.ip_range_end,
                    (val) => updateField('discovery', 'ip_range_end', val),
                    'number', undefined, undefined, true
                  )}
                  {renderField(
                    'Discovery Timeout (seconds)', config.discovery?.discovery_timeout_seconds,
                    (val) => updateField('discovery', 'discovery_timeout_seconds', val),
                    'number', undefined, undefined, true
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'system' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-1">Services</h2>
              <p className="text-sm text-amber-300/90 mb-4">
                Read-only — these are always-on support services (heartbeat, config-broadcast, data-logger).
                They read their config once at their own startup and are <em>not</em> restarted by a session,
                so edits here wouldn&apos;t take effect on a Start. Change them via a deploy/restart.
              </p>
              <div className="space-y-8">
                <div className="border border-gray-700 rounded-lg p-4">
                  <h3 className="text-lg font-semibold mb-3">Heartbeat Service</h3>
                  <p className="text-sm text-text-muted mb-3">
                    Polls backend /api/engine_state, broadcasts SERVER_HEARTBEAT to boards.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {renderField('Enabled', config.heartbeat_service?.enabled, (val) => updateField('heartbeat_service', 'enabled', val), 'boolean', undefined, undefined, true)}
                    {renderField('Backend URL', config.heartbeat_service?.backend_url, (val) => updateField('heartbeat_service', 'backend_url', val), 'text', undefined, undefined, true)}
                    {renderField('Interval (ms)', config.heartbeat_service?.interval_ms, (val) => updateField('heartbeat_service', 'interval_ms', val), 'number', undefined, undefined, true)}
                    {renderField('Broadcast IP', config.heartbeat_service?.broadcast_ip, (val) => updateField('heartbeat_service', 'broadcast_ip', val), 'text', undefined, undefined, true)}
                    {renderField('Broadcast Port', config.heartbeat_service?.broadcast_port, (val) => updateField('heartbeat_service', 'broadcast_port', val), 'number', undefined, undefined, true)}
                  </div>
                </div>
                <div className="border border-gray-700 rounded-lg p-4">
                  <h3 className="text-lg font-semibold mb-3">Config Broadcast Service</h3>
                  <p className="text-sm text-text-muted mb-3">
                    Sends ACTUATOR_CONFIG / SENSOR_CONFIG to boards. (It re-reads board config live each
                    cycle; only these service-level settings need a restart.)
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {renderField('Enabled', config.config_broadcast_service?.enabled, (val) => updateField('config_broadcast_service', 'enabled', val), 'boolean', undefined, undefined, true)}
                    {renderField('Backend URL', config.config_broadcast_service?.backend_url, (val) => updateField('config_broadcast_service', 'backend_url', val), 'text', undefined, undefined, true)}
                    {renderField('Interval (ms)', config.config_broadcast_service?.interval_ms, (val) => updateField('config_broadcast_service', 'interval_ms', val), 'number', undefined, undefined, true)}
                  </div>
                </div>
                <div className="border border-gray-700 rounded-lg p-4">
                  <h3 className="text-lg font-semibold mb-3">Data Logger Service</h3>
                  <p className="text-sm text-text-muted mb-3">
                    Records .sensorlog files; connects to backend WebSocket.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {renderField('Enabled', config.data_logger_service?.enabled, (val) => updateField('data_logger_service', 'enabled', val), 'boolean', undefined, undefined, true)}
                    {renderField('WebSocket URL', config.data_logger_service?.ws_url, (val) => updateField('data_logger_service', 'ws_url', val), 'text', undefined, undefined, true)}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'system' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-1">Database</h2>
              <p className="text-sm text-amber-300/90 mb-4">
                Read-only — the Elodin DB connection is established at startup. Changing host/port live
                would drop the live data link; edit via a deploy/restart, not here.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'Host',
                  config.database?.host,
                  (val) => updateField('database', 'host', val),
                  'text', undefined, undefined, true
                )}
                {renderField(
                  'Port',
                  config.database?.port,
                  (val) => updateField('database', 'port', val),
                  'number', undefined, undefined, true
                )}
                {renderField(
                  'Auto Flush Interval (ms)',
                  config.database?.auto_flush_interval_ms,
                  (val) => updateField('database', 'auto_flush_interval_ms', val),
                  'number', undefined, undefined, true
                )}
                {renderField(
                  'Max Buffer Size',
                  config.database?.max_buffer_size,
                  (val) => updateField('database', 'max_buffer_size', val),
                  'number', undefined, undefined, true
                )}
                {renderField(
                  'Connection Retry Attempts',
                  config.database?.connection_retry_attempts,
                  (val) => updateField('database', 'connection_retry_attempts', val),
                  'number', undefined, undefined, true
                )}
                {renderField(
                  'Connection Retry Delay (ms)',
                  config.database?.connection_retry_delay_ms,
                  (val) => updateField('database', 'connection_retry_delay_ms', val),
                  'number', undefined, undefined, true
                )}
              </div>
            </div>
          )}

          {activeTab === 'system' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-1">Server Heartbeat</h2>
              <p className="text-sm text-amber-300/90 mb-4">
                Read-only — the heartbeat broadcast is set up by the C++ services at startup. Editing it
                live has no effect until the pipeline restarts.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'Interval (ms)',
                  config.server_heartbeat?.interval_ms,
                  (val) => updateField('server_heartbeat', 'interval_ms', val),
                  'number', undefined, undefined, true
                )}
                {renderField(
                  'Broadcast Port',
                  config.server_heartbeat?.broadcast_port,
                  (val) => updateField('server_heartbeat', 'broadcast_port', val),
                  'number', undefined, undefined, true
                )}
                {renderField(
                  'Broadcast IP',
                  config.server_heartbeat?.broadcast_ip,
                  (val) => updateField('server_heartbeat', 'broadcast_ip', val),
                  'text', undefined, undefined, true
                )}
              </div>
            </div>
          )}

          {activeTab === 'system' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-1">Controller Service (C++)</h2>
              <p className="text-sm text-amber-300/90 mb-4">
                Read-only for now — TCP port for FIRE_START / FIRE_STOP, read by the C++ controller
                service at startup. Editing it live has no effect until the pipeline restarts.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField('Port', config.controller_service?.port, (val) => updateField('controller_service', 'port', val), 'number', undefined, undefined, true)}
                {renderField('Fire Duration (ms)', config.controller_service?.fire_duration_ms, (val) => updateField('controller_service', 'fire_duration_ms', val), 'number', undefined, undefined, true)}
                {renderField('Fire Extended (ms)', config.controller_service?.fire_extended_ms, (val) => updateField('controller_service', 'fire_extended_ms', val), 'number', undefined, undefined, true)}
              </div>
            </div>
          )}

          {activeTab === 'system' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-1">Actuator Service (C++)</h2>
              <p className="text-sm text-amber-300/90 mb-4">
                Read-only for now — the port/bind are read at C++ service startup (and the port is
                overridden by an env var the startup script sets). Editing it live has no effect.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField('Port', config.actuator_service?.port, (val) => updateField('actuator_service', 'port', val), 'number', undefined, undefined, true)}
                {renderField('Bind Address', config.actuator_service?.bind_address, (val) => updateField('actuator_service', 'bind_address', val), 'text', undefined, undefined, true)}
              </div>
            </div>
          )}

          {activeTab === 'system' && (
            <div className="bg-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-1">State Machine</h2>
              <p className="text-sm text-amber-300/90 mb-4">
                Read-only — state-machine setup (the actuator/transition CSVs) is managed outside this
                editor. These paths are loaded by the sequencer at pipeline start, not live-editable here.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderField(
                  'Actuator CSV',
                  config.state_machine?.actuator_csv,
                  (val) => updateField('state_machine', 'actuator_csv', val),
                  'text', undefined, 'sequencer actuator sequence', true
                )}
                {renderField(
                  'Transitions CSV',
                  config.state_machine?.transitions_csv,
                  (val) => updateField('state_machine', 'transitions_csv', val),
                  'text', undefined, 'state transition matrix', true
                )}
              </div>
            </div>
          )}

        </fieldset>
      </div>
    </main>
  );
}
