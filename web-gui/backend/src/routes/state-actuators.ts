/**
 * Parse state_machine_actuators.csv to get actuator positions for each state
 * Supports both old format (abbreviations) and new format (full names)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { SystemState, ActuatorId } from '../../../shared/types.js';

// Actuator name → ActuatorId mapping (from config.toml actuator_roles)
// Maps full names to our enum
const ACTUATOR_NAME_MAP: Record<string, ActuatorId> = {
  'Fuel Vent': ActuatorId.FUEL_VENT,      // CH2
  'LOX Vent': ActuatorId.LOX_VENT,        // CH6
  'Fuel Press': ActuatorId.FUEL_PRESS,    // CH3
  'LOX Press': ActuatorId.LOX_PRESS,      // CH8
  'Fuel Main': ActuatorId.FUEL_MAIN,      // CH7
  'LOX Main': ActuatorId.LOX_MAIN,        // CH1
  'GSE Low Vent': ActuatorId.GSE_LOW_VENT, // CH5
  'GN2 Vent': ActuatorId.GSE_LOW_VENT,    // CH5 (same as GSE Low Vent)
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
  'LOX Dump': 4,              // CH4 (if exists, may need to verify)
  'LOX Fill': 4,              // CH4 (if exists, may be same as LOX Dump)
  'GSE Low Press Vent': 5,    // CH5 (same as GSE Low Vent/GN2 Vent)
  'GSE High Press Vent': 5,    // CH5 (may need separate channel - verify with hardware)
  'GSE LOX Fill Vent': 5,     // CH5 (may need separate channel - verify with hardware)
  'GSE High Press Control': 5, // CH5 (may need separate channel - verify with hardware)
  'GSE Med Press Control': 5,  // CH5 (may need separate channel - verify with hardware)
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
  'Engine Abort': SystemState.ABORT,      // Map to ABORT
  'GSE Abort': SystemState.ABORT,         // Map to ABORT
  'Emergency Abort': SystemState.ABORT,   // Map to ABORT
  // Legacy mappings
  'Quick Fire': SystemState.READY,
  'High Press': SystemState.GN2_HIGH_PRESS,
  'Abort': SystemState.ABORT,
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
      const { readConfig } = require('./config.js');
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

    // Parse each row (skip header)
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',');
      const actuatorName = row[0].trim(); // Full name or abbreviation
      
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
      const fs = require('fs');
      if (!fs.existsSync(path)) {
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
