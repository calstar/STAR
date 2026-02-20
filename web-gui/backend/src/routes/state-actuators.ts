/**
 * Parse state_machine_actuators.csv to get actuator positions for each state
 * Supports both old format (abbreviations) and new format (full names)
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
  'GN2 Vent': ActuatorId.GSE_LOW_VENT,    // CH5 (same as GSE Low Vent)
  'Fuel Fill Vent': ActuatorId.FUEL_FILL_VENT, // CH9
  'Fuel Fill Press': ActuatorId.FUEL_FILL_PRESS, // CH10
  'LOX Fill': ActuatorId.LOX_FILL,        // CH4
  'LOX Dump': ActuatorId.LOX_DUMP,        // CH4
  'GSE High Press Vent': ActuatorId.GSE_HIGH_PRESS_VENT, // CH5
  'GSE LOX Fill Vent': ActuatorId.GSE_LOX_FILL_VENT, // CH5
  'GSE High Press Control': ActuatorId.GSE_HIGH_PRESS_CONTROL, // CH5
  'GSE Med Press Control': ActuatorId.GSE_MED_PRESS_CONTROL, // CH5
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
};

// Additional actuators from CSV (not in enum yet, map to channels directly)
// These are stored by channel ID since they're not in ActuatorId enum
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

// CSV state name → SystemState enum mapping (new format)
const CSV_STATE_MAP: Record<string, SystemState> = {
  'Debug': SystemState.DEBUG,
  'Idle': SystemState.IDLE,
  'Armed': SystemState.ARMED,
  'Fuel Fill': SystemState.FUEL_FILL,
  'Ox Fill': SystemState.OX_FILL,
  'GN2 Press': SystemState.GN2_LOW_PRESS,
  'Fuel Press': SystemState.FUEL_PRESS,
  'Fuel Vent': SystemState.FUEL_VENT,
  'Ox Press': SystemState.OX_PRESS,
  'Ox Vent': SystemState.OX_VENT,
  'GN2 High Press': SystemState.GN2_HIGH_PRESS,
  'GN2 Vent': SystemState.GN2_VENT,
  'Calibrate': SystemState.CALIBRATE,
  'Ready': SystemState.READY,
  'Fire': SystemState.FIRE,
  'Vent': SystemState.VENT,
  'Engine Abort': SystemState.ENGINE_ABORT,
  'GSE Abort': SystemState.GSE_ABORT,
  'Emergency Abort': SystemState.EMERGENCY_ABORT,
  // Legacy mappings
  'Quick Fire': SystemState.READY,
  'High Press': SystemState.GN2_HIGH_PRESS,
  'Abort': SystemState.EMERGENCY_ABORT, // Default to emergency abort for legacy
};

export interface StateActuatorMap {
  [state: number]: { [channelId: number]: number }; // SystemState → { channelId → 0|1 (CLOSED|OPEN) }
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

    // Count actuators dynamically from CSV
    let actuatorCount = 0;

    // Priority for abort states: Emergency Abort > Engine Abort > GSE Abort
    // Collect all abort positions separately, then merge with priority
    const abortPositions: Record<string, Record<number, number>> = {}; // abortType → {channelId → value}

    // Parse each row (skip header)
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',');
      const actuatorName = row[0].trim(); // Full name or abbreviation

      if (!actuatorName) {
        continue; // Skip empty rows
      }

      actuatorCount++; // Count valid actuator rows

      // Try to find channel ID
      let channelId: number | undefined;

      // First try config.toml actuator_roles (most reliable)
      channelId = configActuatorChannels[actuatorName];

      // Then try full name mapping
      if (!channelId) {
        const actuatorId = ACTUATOR_NAME_MAP[actuatorName];
        if (actuatorId !== undefined) {
          channelId = ACTUATOR_CHANNEL[actuatorId];
        }
      }

      // Try abbreviation mapping (legacy)
      if (!channelId) {
        const abbrevId = ACTUATOR_ABBREV_MAP[actuatorName];
        if (abbrevId !== undefined) {
          channelId = ACTUATOR_CHANNEL[abbrevId];
        }
      }

      // Try additional actuators (fallback)
      if (!channelId) {
        channelId = ADDITIONAL_ACTUATOR_CHANNELS[actuatorName];
      }

      if (!channelId) {
        console.warn(`⚠️ No channel mapping for actuator "${actuatorName}" - skipping`);
        console.warn(`   Checked config.toml: ${Object.keys(configActuatorChannels).join(', ')}`);
        console.warn(`   Checked hardcoded: ${Object.keys(ACTUATOR_NAME_MAP).join(', ')}`);
        console.warn(`   Checked additional: ${Object.keys(ADDITIONAL_ACTUATOR_CHANNELS).join(', ')}`);
        continue;
      }

      // Parse each state column
      // row[0] = actuator name, row[1] = first state value, row[2] = second state value, etc.
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

        // Use row[colIdx + 1] (row[0] is actuator name)
        if (colIdx + 1 >= row.length) {
          continue;
        }

        const value = row[colIdx + 1].trim().toUpperCase();

        // For ABORT states, collect all abort types separately, then merge with priority
        if (stateName === 'Emergency Abort' || stateName === 'Engine Abort' || stateName === 'GSE Abort') {
          if (!abortPositions[stateName]) {
            abortPositions[stateName] = {};
          }
          if (value === 'OPEN') {
            abortPositions[stateName][channelId] = 1;
          } else if (value === 'CLOSE' || value === 'CLOSED') {
            abortPositions[stateName][channelId] = 0;
          }
          continue; // Skip adding to result for now - will merge after all rows
        }

        if (value === 'OPEN') {
          if (!result[systemState]) {
            result[systemState] = {};
          }
          result[systemState][channelId] = 1;
        } else if (value === 'CLOSE' || value === 'CLOSED') {
          if (!result[systemState]) {
            result[systemState] = {};
          }
          result[systemState][channelId] = 0;
        }
        // "No change" values are ignored (not stored)
      }
    }

    // Store abort positions in separate states
    if (abortPositions['Engine Abort']) {
      result[SystemState.ENGINE_ABORT] = abortPositions['Engine Abort'];
      console.log(`📋 Engine Abort: ${Object.keys(abortPositions['Engine Abort']).length} actuators`);
    }
    if (abortPositions['GSE Abort']) {
      result[SystemState.GSE_ABORT] = abortPositions['GSE Abort'];
      console.log(`📋 GSE Abort: ${Object.keys(abortPositions['GSE Abort']).length} actuators`);
    }
    if (abortPositions['Emergency Abort']) {
      result[SystemState.EMERGENCY_ABORT] = abortPositions['Emergency Abort'];
      console.log(`📋 Emergency Abort: ${Object.keys(abortPositions['Emergency Abort']).length} actuators`);
    }

    console.log(`📋 Parsed state actuator map: ${Object.keys(result).length} states`);
    console.log(`📋 Found ${actuatorCount} actuators in CSV`);
    let totalActuators = 0;
    for (const [state, actuators] of Object.entries(result)) {
      const count = Object.keys(actuators).length;
      totalActuators += count;
      const actuatorList = Object.entries(actuators)
        .map(([ch, val]) => `CH${ch}=${val ? 'OPEN' : 'CLOSE'}`)
        .join(', ');
      console.log(`   State ${SystemState[Number(state)]}: ${count} actuators (${actuatorList})`);
    }
    console.log(`   Total: ${totalActuators} actuator commands across all states`);
    return result;
  } catch (error) {
    console.error('❌ Failed to parse state actuators CSV:', error);
    return result;
  }
}

export function getNumActuatorsFromCSV(): number {
  /**Get number of actuators dynamically from CSV file.*/
  const possiblePaths = [
    join(process.cwd(), '..', '..', 'external', 'DiabloAvionics', 'test_guis', 'state_machine_actuators.csv'),
    join(process.cwd(), '..', 'external', 'DiabloAvionics', 'test_guis', 'state_machine_actuators.csv'),
    '/home/kush-mahajan/sensor_system/external/DiabloAvionics/test_guis/state_machine_actuators.csv',
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
  // Try to find the CSV file - check multiple possible locations
  const possiblePaths = [
    // From web-gui/backend directory
    join(process.cwd(), '..', '..', 'external', 'DiabloAvionics', 'test_guis', 'state_machine_actuators.csv'),
    // From web-gui directory
    join(process.cwd(), '..', 'external', 'DiabloAvionics', 'test_guis', 'state_machine_actuators.csv'),
    // Absolute path (fallback)
    '/home/kush-mahajan/sensor_system/external/DiabloAvionics/test_guis/state_machine_actuators.csv',
    // From sensor_system root
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
      // Try next path
      continue;
    }
  }

  console.error('❌ State actuators CSV not found in any of these locations:');
  possiblePaths.forEach(p => console.error(`   - ${p}`));
  console.warn('⚠️ Using empty map - actuators will not auto-command');
  return {};
}
