/**
 * Parse state_machine_actuators.csv to get actuator positions for each state
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { SystemState, ActuatorId } from '../../../shared/types.js';

// Actuator abbreviation → ActuatorId mapping
const ACTUATOR_ABBREV_MAP: Record<string, ActuatorId> = {
  'FV': ActuatorId.FUEL_VENT,      // Fuel Vent → CH2
  'OV': ActuatorId.LOX_VENT,        // LOX Vent → CH6
  'FP': ActuatorId.FUEL_PRESS,      // Fuel Press → CH3
  'OP': ActuatorId.LOX_PRESS,        // LOX Press → CH8
  'FM': ActuatorId.FUEL_MAIN,       // Fuel Main → CH7
  'OM': ActuatorId.LOX_MAIN,        // LOX Main → CH1
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

// CSV state name → SystemState enum mapping
const CSV_STATE_MAP: Record<string, SystemState> = {
  'Debug': SystemState.DEBUG,
  'Idle': SystemState.IDLE,
  'Armed': SystemState.ARMED,
  'Fuel Fill': SystemState.FUEL_FILL,
  'Ox Fill': SystemState.OX_FILL,
  'Quick Fire': SystemState.READY,
  'GN2 Press': SystemState.GN2_LOW_PRESS,
  'Fuel Press': SystemState.FUEL_PRESS,
  'Fuel Vent': SystemState.FUEL_VENT,
  'Ox Press': SystemState.OX_PRESS,
  'Ox Vent': SystemState.OX_VENT,
  'High Press': SystemState.GN2_HIGH_PRESS,
  'GN2 Vent': SystemState.GN2_VENT,
  'Fire': SystemState.FIRE,
  'Vent': SystemState.VENT,
  'Abort': SystemState.ABORT,
};

export interface StateActuatorMap {
  [state: number]: { [channelId: number]: number }; // SystemState → { channelId → 0|1 (CLOSED|OPEN) }
}

export function parseStateActuatorsCSV(csvPath: string): StateActuatorMap {
  const result: StateActuatorMap = {};

  try {
    const csvContent = readFileSync(csvPath, 'utf-8');
    const lines = csvContent.trim().split('\n');

    if (lines.length < 2) {
      console.warn('⚠️ State actuators CSV has insufficient rows');
      return result;
    }

    // First line is header: ,Debug ,Idle,Armed,...
    const headers = lines[0].split(',').slice(1).map(h => h.trim()); // Skip first empty cell
    const stateNames = headers.filter(h => h && h.toLowerCase() !== 'no change' && h.toLowerCase() !== 'debug');

    // Parse each row (skip header)
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',');
      const abbrev = row[0].trim(); // FV, OV, FP, OP, FM, OM
      
      if (!abbrev || !ACTUATOR_ABBREV_MAP[abbrev]) {
        continue; // Skip unknown actuators
      }

      const actuatorId = ACTUATOR_ABBREV_MAP[abbrev];
      const channelId = ACTUATOR_CHANNEL[actuatorId];
      
      if (!channelId) {
        console.warn(`⚠️ No channel mapping for actuator ${abbrev} (ID: ${actuatorId})`);
        continue;
      }

      // Parse each state column (match combined_gui.py logic)
      // headers[0] = Debug, headers[1] = Idle, etc.
      // row[0] = actuator abbrev, row[1] = Debug value, row[2] = Idle value, etc.
      for (let i = 0; i < headers.length; i++) {
        const stateName = headers[i]?.trim();
        if (!stateName || stateName.toLowerCase() === 'no change' || stateName.toLowerCase() === 'debug') {
          continue; // Skip Debug and "No change" columns
        }

        const systemState = CSV_STATE_MAP[stateName];
        if (!systemState) {
          continue; // Skip unknown states
        }

        // Use row[i + 1] to match Python's row[i + 1] logic (row[0] is actuator abbrev)
        if (i + 1 >= row.length) {
          continue; // Skip if row doesn't have enough columns
        }

        const value = row[i + 1].trim().toUpperCase();
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

    console.log(`📋 Parsed state actuator map: ${Object.keys(result).length} states`);
    return result;
  } catch (error) {
    console.error('❌ Failed to parse state actuators CSV:', error);
    return result;
  }
}

export function getStateActuatorMap(): StateActuatorMap {
  // Try to find the CSV file
  const possiblePaths = [
    join(process.cwd(), '..', 'external', 'DiabloAvionics', 'test_guis', 'state_machine_actuators.csv'),
    join(process.cwd(), '..', '..', 'external', 'DiabloAvionics', 'test_guis', 'state_machine_actuators.csv'),
    '/home/kush-mahajan/sensor_system/external/DiabloAvionics/test_guis/state_machine_actuators.csv',
  ];

  for (const path of possiblePaths) {
    try {
      const map = parseStateActuatorsCSV(path);
      if (Object.keys(map).length > 0) {
        return map;
      }
    } catch (error) {
      // Try next path
      continue;
    }
  }

  console.warn('⚠️ State actuators CSV not found, using empty map');
  return {};
}

