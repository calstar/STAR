/**
 * Parse state_machine_actuators.csv to get actuator positions for each state.
 * Keyed by actuator name (not channel ID) so that actuators sharing a physical
 * channel can each have independent expected positions per state.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SystemState, ActuatorId } from '../../../shared/types.js';
import { readConfig } from './config.js';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Actuator name → ActuatorId mapping (from config.toml actuator_roles)
// Maps full names to our enum - matches CSV column names
const ACTUATOR_NAME_MAP: Record<string, ActuatorId> = {
  'Fuel Vent': ActuatorId.FUEL_VENT,      // CH2
  'LOX Vent': ActuatorId.LOX_VENT,        // CH6
  'Fuel Press': ActuatorId.FUEL_PRESS,    // CH3
  'LOX Press': ActuatorId.LOX_PRESS,      // CH8
  'Fuel Main': ActuatorId.FUEL_MAIN,      // CH7
  'LOX Main': ActuatorId.LOX_MAIN,        // CH1
  'GSE Low Press Vent': ActuatorId.GSE_LOW_VENT, // CH5
  'GN2 Vent': ActuatorId.GSE_LOW_VENT,    // CH5 (same physical valve as GSE Low Vent)
  'Fuel Fill Vent': ActuatorId.FUEL_FILL_VENT, // CH9
  'Fuel Fill Press': ActuatorId.FUEL_FILL_PRESS, // CH10
  'LOX Fill': ActuatorId.LOX_FILL,        // CH4
  'LOX Dump': ActuatorId.LOX_DUMP,        // CH4
  'GSE High Press Vent': ActuatorId.GSE_HIGH_PRESS_VENT, // CH5
  'GSE LOX Fill Vent': ActuatorId.GSE_LOX_FILL_VENT, // CH5
  'GSE High Press Control': ActuatorId.GSE_HIGH_PRESS_CONTROL, // CH5
  'GSE Med Press Control': ActuatorId.GSE_MED_PRESS_CONTROL, // CH5
  'Test Actuator 2': ActuatorId.TEST_ACTUATOR_2, // CH1 on board 2
};

// Legacy abbreviation mapping (for old CSV format)
const ACTUATOR_ABBREV_MAP: Record<string, ActuatorId> = {
  'FV': ActuatorId.FUEL_VENT,
  'OV': ActuatorId.LOX_VENT,
  'FP': ActuatorId.FUEL_PRESS,
  'OP': ActuatorId.LOX_PRESS,
  'FM': ActuatorId.FUEL_MAIN,
  'OM': ActuatorId.LOX_MAIN,
};

// ActuatorId → board channel mapping (from config.toml actuator_roles)
const ACTUATOR_CHANNEL: Record<number, number> = {
  [ActuatorId.LOX_MAIN]:     1,
  [ActuatorId.FUEL_MAIN]:    7,
  [ActuatorId.LOX_VENT]:     6,
  [ActuatorId.FUEL_VENT]:    2,
  [ActuatorId.LOX_PRESS]:    8,
  [ActuatorId.FUEL_PRESS]:   3,
  [ActuatorId.GSE_LOW_VENT]: 5,
  [ActuatorId.FUEL_FILL_VENT]: 9,
  [ActuatorId.FUEL_FILL_PRESS]: 10,
  [ActuatorId.LOX_FILL]:     4,
  [ActuatorId.LOX_DUMP]:     4,
  [ActuatorId.TEST_ACTUATOR_2]: 1, // Channel 1 on second board (192.168.2.202)
};

// Additional actuators from CSV (not in ACTUATOR_CHANNEL, map to channels directly)
// Channel mappings from config.toml actuator_roles
const ADDITIONAL_ACTUATOR_CHANNELS: Record<string, number> = {
  'Fuel Fill Vent': 9,        // CH9 from config.toml
  'Fuel Fill Press': 10,      // CH10 from config.toml
  'LOX Dump': 4,              // CH4
  'LOX Fill': 4,              // CH4
  'GSE Low Press Vent': 5,    // CH5 (same as GSE Low Vent/GN2 Vent)
  'GSE High Press Vent': 5,    // CH5
  'GSE LOX Fill Vent': 5,     // CH5
  'GSE High Press Control': 5, // CH5
  'GSE Med Press Control': 5,  // CH5
};

// Actuator name → entity name mapping (for frontend display)
// These are the entity names used in the sensor store / ActuatorControl component
export const CSV_ACTUATOR_TO_ENTITY: Record<string, string> = {
  'Fuel Vent': 'ACT.Fuel_Vent',
  'LOX Vent': 'ACT.LOX_Vent',
  'Fuel Press': 'ACT.Fuel_Press',
  'LOX Press': 'ACT.LOX_Press',
  'Fuel Main': 'ACT.Fuel_Main',
  'LOX Main': 'ACT.LOX_Main',
  'GN2 Vent': 'ACT.GSE_Low_Vent',
  'GSE Low Press Vent': 'ACT.GSE_Low_Vent',
  'Fuel Fill Vent': 'ACT.Fuel_Fill_Vent',
  'Fuel Fill Press': 'ACT.Fuel_Fill_Press',
  'LOX Fill': 'ACT.LOX_Fill',
  'LOX Dump': 'ACT.LOX_Dump',
  'GSE High Press Vent': 'ACT.GSE_High_Press_Vent',
  'GSE LOX Fill Vent': 'ACT.GSE_LOX_Fill_Vent',
  'GSE High Press Control': 'ACT.GSE_High_Press_Control',
  'GSE Med Press Control': 'ACT.GSE_Med_Press_Control',
  'Test Actuator 2': 'ACT.Test_Actuator_2',
};

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
 * Checks config.toml first, then hardcoded mappings.
 */
export function getActuatorChannel(
  actuatorName: string,
  configActuatorChannels: Record<string, number>,
): number | undefined {
  // Config.toml first (most reliable)
  const fromConfig = configActuatorChannels[actuatorName];
  if (fromConfig !== undefined) return fromConfig;

  // Full name → ActuatorId → channel
  const actuatorId = ACTUATOR_NAME_MAP[actuatorName];
  if (actuatorId !== undefined) {
    const ch = ACTUATOR_CHANNEL[actuatorId];
    if (ch !== undefined) return ch;
  }

  // Abbreviation → ActuatorId → channel
  const abbrevId = ACTUATOR_ABBREV_MAP[actuatorName];
  if (abbrevId !== undefined) {
    const ch = ACTUATOR_CHANNEL[abbrevId];
    if (ch !== undefined) return ch;
  }

  // Additional actuators fallback
  return ADDITIONAL_ACTUATOR_CHANNELS[actuatorName];
}

export function parseStateActuatorsCSV(csvPath: string): StateActuatorMap {
  const result: StateActuatorMap = {};

  try {
    // Load actuator channel mappings from config.toml dynamically
    let configActuatorChannels: Record<string, number> = {};
    try {
      const config = readConfig();
      const actuatorRoles = config.actuator_roles || {};
      // Extract channel IDs from [type, channelId] format
      for (const [name, value] of Object.entries(actuatorRoles)) {
        if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'number') {
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

      actuatorCount++;

      // Validate that this actuator is known
      const hasMapping = actuatorName in CSV_ACTUATOR_TO_ENTITY ||
        actuatorName in ACTUATOR_NAME_MAP ||
        actuatorName in ACTUATOR_ABBREV_MAP ||
        actuatorName in ADDITIONAL_ACTUATOR_CHANNELS;

      if (!hasMapping) {
        console.warn(`⚠️ Unknown actuator "${actuatorName}" in CSV - skipping`);
        continue;
      }

      // Parse each state column
      // row[0] = actuator name, row[1] = first state value, row[2] = second, etc.
      for (let colIdx = 0; colIdx < headers.length; colIdx++) {
        const stateName = headers[colIdx]?.trim();
        if (!stateName || stateName.toLowerCase() === 'no change' || stateName.toLowerCase() === 'debug') {
          continue; // Skip Debug and "No change" columns
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
        // "No change" values are silently ignored
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
  const possiblePaths = [
    // New file name (primary)
    '/home/kush-mahajan/sensor_system/external/DiabloAvionics/test_guis/Avionics Board Status - State Machine Actuators.csv',
    join(process.cwd(), '..', '..', 'external', 'DiabloAvionics', 'test_guis', 'Avionics Board Status - State Machine Actuators.csv'),
    join(process.cwd(), '..', 'external', 'DiabloAvionics', 'test_guis', 'Avionics Board Status - State Machine Actuators.csv'),
    join(__dirname, '..', '..', '..', 'external', 'DiabloAvionics', 'test_guis', 'Avionics Board Status - State Machine Actuators.csv'),
    // Fallback to old filename
    '/home/kush-mahajan/sensor_system/external/DiabloAvionics/test_guis/state_machine_actuators.csv',
    join(process.cwd(), '..', '..', 'external', 'DiabloAvionics', 'test_guis', 'state_machine_actuators.csv'),
    join(process.cwd(), '..', 'external', 'DiabloAvionics', 'test_guis', 'state_machine_actuators.csv'),
    join(__dirname, '..', '..', '..', 'external', 'DiabloAvionics', 'test_guis', 'state_machine_actuators.csv'),
  ];

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

export function getStateActuatorMap(): StateActuatorMap {
  // Try to find the CSV file - prefer the new "Avionics Board Status" file
  const possiblePaths = [
    // New file name (primary)
    '/home/kush-mahajan/sensor_system/external/DiabloAvionics/test_guis/Avionics Board Status - State Machine Actuators.csv',
    join(process.cwd(), '..', '..', 'external', 'DiabloAvionics', 'test_guis', 'Avionics Board Status - State Machine Actuators.csv'),
    join(process.cwd(), '..', 'external', 'DiabloAvionics', 'test_guis', 'Avionics Board Status - State Machine Actuators.csv'),
    join(__dirname, '..', '..', '..', 'external', 'DiabloAvionics', 'test_guis', 'Avionics Board Status - State Machine Actuators.csv'),
    // Fallback to old filename
    '/home/kush-mahajan/sensor_system/external/DiabloAvionics/test_guis/state_machine_actuators.csv',
    join(process.cwd(), '..', '..', 'external', 'DiabloAvionics', 'test_guis', 'state_machine_actuators.csv'),
    join(process.cwd(), '..', 'external', 'DiabloAvionics', 'test_guis', 'state_machine_actuators.csv'),
    join(__dirname, '..', '..', '..', 'external', 'DiabloAvionics', 'test_guis', 'state_machine_actuators.csv'),
  ];

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
