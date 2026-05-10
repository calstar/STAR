/**
 * Parse state_machine_actuators.csv to get actuator positions for each state.
 * Keyed by actuator name (not channel ID) so that actuators sharing a physical
 * channel can each have independent expected positions per state.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SystemState } from '../../../shared/types.js';
import { readConfig } from '../routes/config.js';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


// ── Config-driven actuator maps (built once at load time) ─────────────────────

/** Build abbreviation → full-name map from config.toml [actuator_abbrev] */
function buildAbbrevMap(): Record<string, string> {
  const map: Record<string, string> = {};
  try {
    const config = readConfig();
    const abbrevSection = config.actuator_abbrev || {};
    for (const [abbrev, fullName] of Object.entries(abbrevSection)) {
      if (typeof fullName === 'string') {
        map[abbrev] = fullName;
      }
    }
  } catch {
    console.warn('⚠️ Could not load actuator_abbrev from config.toml');
  }
  return map;
}

/** Build name → channel map from config.toml actuator_roles */
function buildActuatorChannelMap(): Record<string, number> {
  const byName: Record<string, number> = {};
  try {
    const config = readConfig();
    const roles = config.actuator_roles || {};
    for (const [name, value] of Object.entries(roles)) {
      if (Array.isArray(value) && value.length >= 2 && typeof value[1] === 'number') {
        byName[name] = value[1];
      }
    }
  } catch {
    console.warn('⚠️ Could not load actuator_roles from config.toml for channel maps');
  }
  return byName;
}

/** Build entity name map from config.toml actuator_roles: name → "ACT.Name_With_Underscores" */
function buildActuatorEntityMap(): Record<string, string> {
  const map: Record<string, string> = {};
  try {
    const config = readConfig();
    const roles = config.actuator_roles || {};
    for (const name of Object.keys(roles)) {
      map[name] = `ACT.${name.replace(/\s+/g, '_')}`;
    }
    // Also add abbreviation-expanded names
    const abbrevSection = config.actuator_abbrev || {};
    for (const [, fullName] of Object.entries(abbrevSection)) {
      if (typeof fullName === 'string' && !map[fullName]) {
        map[fullName] = `ACT.${fullName.replace(/\s+/g, '_')}`;
      }
    }
  } catch {
    console.warn('⚠️ Could not load actuator_roles from config.toml for entity map');
  }
  return map;
}

// Initialize config-driven maps at module load time
const ACTUATOR_ABBREV_MAP = buildAbbrevMap();
const ACTUATOR_CHANNEL_BY_NAME = buildActuatorChannelMap();
export const CSV_ACTUATOR_TO_ENTITY = buildActuatorEntityMap();

// CSV_ACTUATOR_TO_ENTITY is now built from config above (exported)

// CSV state name → SystemState enum mapping (new format)
const CSV_STATE_MAP: Record<string, SystemState> = {
  'Debug': SystemState.DEBUG,
  'Idle': SystemState.IDLE,
  'Armed': SystemState.ARMED,
  'Fuel Fill': SystemState.FUEL_FILL,
  'Ox Fill': SystemState.OX_FILL,
  'Press Standby': SystemState.PRESS_STANDBY, // Press Standby is a separate state
  'GN2 Low Press': SystemState.GN2_LOW_PRESS,
  'GN2 Low Vent': SystemState.GN2_VENT,
  'Fuel Press': SystemState.FUEL_PRESS,
  'Fuel Vent': SystemState.FUEL_VENT,
  'Ox Press': SystemState.OX_PRESS,
  'Ox Vent': SystemState.OX_VENT,
  'GN2 High Press': SystemState.GN2_HIGH_PRESS,
  'GN2 High Vent': SystemState.GN2_HIGH_VENT,
  'Calibrate': SystemState.CALIBRATE,
  'Ready': SystemState.READY,
  'Fire': SystemState.FIRE,
  'Vent': SystemState.VENT,
  'Engine Abort': SystemState.ENGINE_ABORT,
  'GSE Abort': SystemState.GSE_ABORT,
  'Emergency Abort': SystemState.EMERGENCY_ABORT,
  // Legacy mappings
  'GN2 Press': SystemState.GN2_LOW_PRESS, // Old name for GN2 Low Press
  'GN2 Vent': SystemState.GN2_VENT, // Old name for GN2 Low Vent
  'Quick Fire': SystemState.READY,
  'High Press': SystemState.GN2_HIGH_PRESS,
  'Abort': SystemState.EMERGENCY_ABORT,
};

/**
 * StateActuatorMap: SystemState → { actuatorName → 0|1 (CLOSED|OPEN) }
 * Keyed by actuator NAME (not channel ID) so actuators sharing a channel
 * can each have independent expected positions per state.
 */
export interface StateActuatorMap {
  [state: number]: { [actuatorName: string]: number }; // 0 = CLOSED, 1 = OPEN
}

/**
 * Resolve an actuator CSV name to its board channel ID.
 * All data sourced from config.toml actuator_roles.
 */
/**
 * Map a CSV / role / GUI actuator name to the Elodin [0x32] entity the thin server and parser use.
 * Uses the same board slot rule as FSW: board_id % 10 with 0 → 10.
 */
/** Resolve role / CSV name → { board slot, local channel } from actuator_roles (same rule as FSW). */
export function resolveActuatorBoardSlotAndChannel(actuatorName: string): { bn: number; localCh: number } | null {
  try {
    const config = readConfig();
    const roles = config.actuator_roles as Record<string, unknown[]> | undefined;
    if (!roles) return null;
    let entry = roles[actuatorName];
    if (!entry && ACTUATOR_ABBREV_MAP[actuatorName]) {
      const full = ACTUATOR_ABBREV_MAP[actuatorName];
      entry = roles[full];
    }
    if (!Array.isArray(entry) || entry.length < 2) return null;
    const localCh = typeof entry[1] === 'number' ? entry[1] : Number(entry[1]);
    if (!Number.isFinite(localCh) || localCh < 1) return null;
    const boardId = entry.length >= 3 && typeof entry[2] === 'number' ? entry[2] : 12;
    const mod = boardId % 10;
    const bn = mod === 0 ? 10 : mod;
    return { bn, localCh };
  } catch {
    return null;
  }
}

/** Elodin [0x32] commanded entity — matches sequencer / DatabaseConfig. */
export function resolveActuatorCmdEntity(actuatorName: string): string | null {
  const r = resolveActuatorBoardSlotAndChannel(actuatorName);
  if (!r) return null;
  return `ACT_CMD.B${r.bn}.CH${r.localCh}`;
}

/** Telemetry entity for [0x31] actuator_state — must match elodin-protocol.ts */
export function resolveActuatorTelemetryEntity(actuatorName: string): string | null {
  const r = resolveActuatorBoardSlotAndChannel(actuatorName);
  if (!r) return null;
  return `ACT${r.bn}.CH${r.localCh}`;
}

export function getActuatorChannel(
  actuatorName: string,
  configActuatorChannels: Record<string, number>,
): number | undefined {
  // Explicit caller-provided channels (highest priority)
  const fromCaller = configActuatorChannels[actuatorName];
  if (fromCaller !== undefined) return fromCaller;

  // Config-driven channel-by-name map
  const fromConfig = ACTUATOR_CHANNEL_BY_NAME[actuatorName];
  if (fromConfig !== undefined) return fromConfig;

  // Abbreviation → full name → channel
  const fullName = ACTUATOR_ABBREV_MAP[actuatorName];
  if (fullName) {
    const ch = ACTUATOR_CHANNEL_BY_NAME[fullName];
    if (ch !== undefined) return ch;
  }

  return undefined;
}

export function parseStateActuatorsCSV(csvPath: string): StateActuatorMap {
  const result: StateActuatorMap = {};

  try {
    // Load actuator channel mappings and role names from config.toml (UI is driven by config roles)
    let configActuatorChannels: Record<string, number> = {};
    let configActuatorNames: Set<string> = new Set();
    try {
      const config = readConfig();
      const actuatorRoles = config.actuator_roles || {};
      configActuatorNames = new Set(Object.keys(actuatorRoles));
      for (const [name, value] of Object.entries(actuatorRoles)) {
        if (Array.isArray(value) && value.length >= 2 && typeof value[1] === 'number') {
          configActuatorChannels[name] = value[1];
        }
      }
      console.log(`📋 Loaded ${Object.keys(configActuatorChannels).length} actuator channels from config.toml`);
    } catch (err) {
      console.warn('⚠️ Could not load actuator channels from config.toml, using defaults');
    }

    const csvContent = readFileSync(csvPath, 'utf-8');
    const lines = csvContent.trim().split('\n');

    if (lines.length < 2) {
      console.warn('⚠️ State actuators CSV has insufficient rows');
      return result;
    }

    // First line is header: ,Idle,Armed,Fuel Fill,...
    const headers = lines[0].split(',').slice(1).map(h => h.trim()); // Skip first empty cell

    let actuatorCount = 0;

    // Parse each row (skip header)
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',');
      const actuatorName = row[0].trim(); // Full name or abbreviation

      if (!actuatorName) {
        continue; // Skip empty rows
      }
      if (actuatorName === 'Test Actuator 2') {
        continue; // Skip test row
      }

      actuatorCount++;

      // Config names now match CSV; accept if in config or allow CSV-only for expected positions
      const knownInConfig = actuatorName in CSV_ACTUATOR_TO_ENTITY ||
        actuatorName in ACTUATOR_ABBREV_MAP ||
        actuatorName in ACTUATOR_CHANNEL_BY_NAME ||
        configActuatorNames.has(actuatorName);
      if (!knownInConfig) {
        console.log(`📋 CSV actuator "${actuatorName}" not in config - including for expected positions only`);
      }

      // Parse each state column
      for (let colIdx = 0; colIdx < headers.length; colIdx++) {
        const stateName = headers[colIdx]?.trim();
        if (!stateName || stateName.toLowerCase() === 'no change' || stateName.toLowerCase() === 'debug') {
          continue;
        }

        const systemState = CSV_STATE_MAP[stateName];
        if (systemState === undefined) {
          console.warn(`⚠️ Unknown state name: "${stateName}"`);
          continue;
        }

        if (colIdx + 1 >= row.length) {
          continue;
        }

        const value = row[colIdx + 1].trim().toUpperCase();

        if (value === 'OPEN') {
          if (!result[systemState]) result[systemState] = {};
          result[systemState][actuatorName] = 1;
        } else if (value === 'CLOSE' || value === 'CLOSED') {
          if (!result[systemState]) result[systemState] = {};
          result[systemState][actuatorName] = 0;
        }
      }
    }

    console.log(`📋 Parsed state actuator map: ${Object.keys(result).length} states`);
    console.log(`📋 Found ${actuatorCount} actuators in CSV`);
    for (const [state, actuators] of Object.entries(result)) {
      const count = Object.keys(actuators).length;
      const actuatorList = Object.entries(actuators)
        .map(([name, val]) => `${name}=${val ? 'OPEN' : 'CLOSE'}`)
        .join(', ');
      console.log(`   State ${SystemState[Number(state)]}: ${count} actuators (${actuatorList})`);
    }
    return result;
  } catch (error) {
    console.error('❌ Failed to parse state actuators CSV:', error);
    return result;
  }
}

export function getNumActuatorsFromCSV(): number {
  /**Get number of actuators dynamically from CSV file.*/
  const possiblePaths = buildCSVSearchPaths();

  for (const path of possiblePaths) {
    try {
      if (!existsSync(path)) {
        continue;
      }
      const csvContent = readFileSync(path, 'utf-8');
      const lines = csvContent.trim().split('\n');
      if (lines.length < 2) {
        continue;
      }
      // Count non-empty actuator rows (skip header)
      let count = 0;
      for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(',');
        if (row[0] && row[0].trim()) {
          count++;
        }
      }
      if (count > 0) {
        return count;
      }
    } catch (error) {
      continue;
    }
  }
  return 10; // Fallback default
}

/**
 * Build CSV search paths from config.toml state_machine.actuator_csv,
 * falling back to relative __dirname-based paths.
 */
function buildCSVSearchPaths(): string[] {
  const paths: string[] = [];

  // 1. Config-driven path (highest priority)
  try {
    const config = readConfig();
    const csvRelPath = config.state_machine?.actuator_csv;
    if (typeof csvRelPath === 'string' && csvRelPath.length > 0) {
      // Resolve relative to project root (parent of web-gui)
      paths.push(join(__dirname, '..', '..', '..', '..', csvRelPath));
      paths.push(join(process.cwd(), '..', '..', csvRelPath));
      paths.push(join(process.cwd(), '..', csvRelPath));
    }
  } catch {
    // Config not available, use fallback paths
  }

  // 2. Relative __dirname-based fallback (no absolute/hardcoded paths)
  const relBaseDirs = [
    join(__dirname, '..', '..', '..', '..', 'external', 'DiabloAvionics', 'test_guis'),
    join(process.cwd(), '..', '..', 'external', 'DiabloAvionics', 'test_guis'),
    join(process.cwd(), '..', 'external', 'DiabloAvionics', 'test_guis'),
  ];
  for (const base of relBaseDirs) {
    paths.push(join(base, 'Avionics Board Status - State Machine Actuators.csv'));
    paths.push(join(base, 'state_machine_actuators.csv'));
  }

  return paths;
}


export function getStateActuatorMap(): StateActuatorMap {
  const possiblePaths = buildCSVSearchPaths();

  for (const path of possiblePaths) {
    try {
      if (!existsSync(path)) {
        console.log(`   Trying: ${path} (not found)`);
        continue;
      }
      console.log(`   Trying: ${path} (found)`);
      const map = parseStateActuatorsCSV(path);
      if (Object.keys(map).length > 0) {
        console.log(`✅ Loaded state actuator map from: ${path}`);
        return map;
      } else {
        console.warn(`   ⚠️ File exists but parsed to empty map: ${path}`);
      }
    } catch (error) {
      console.warn(`   ⚠️ Error reading ${path}:`, error);
      continue;
    }
  }

  console.error('❌ State actuators CSV not found in any of these locations:');
  possiblePaths.forEach(p => console.error(`   - ${p}`));
  console.warn('⚠️ Using empty map - actuators will not auto-command');
  return {};
}
