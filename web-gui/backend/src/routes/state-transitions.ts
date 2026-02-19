/**
 * API route to parse state_transitions.csv and return transitions
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { SystemState } from '../../../shared/types.js';

const CSV_STATE_MAP: Record<string, SystemState> = {
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

interface Transition {
  from: SystemState;
  to: SystemState;
}

export function parseStateTransitionsCSV(csvPath: string): Transition[] {
  try {
    const csvContent = readFileSync(csvPath, 'utf-8');
    const lines = csvContent.trim().split('\n');

    if (lines.length < 2) {
      return [];
    }

    // First line is header: ,Idle,Armed,...
    const headers = lines[0].split(',').slice(1); // Skip first empty cell
    const transitions: Transition[] = [];

    // Parse each row (skip header)
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',');
      const fromStateName = row[0].trim();
      const fromState = CSV_STATE_MAP[fromStateName];

      if (!fromState && fromStateName !== '') {
        continue; // Skip unknown states
      }

      // Check each column for valid transitions (value = 1)
      for (let j = 1; j < row.length && j <= headers.length; j++) {
        if (row[j].trim() === '1') {
          const toStateName = headers[j - 1].trim();
          const toState = CSV_STATE_MAP[toStateName];

          if (toState && fromState) {
            transitions.push({ from: fromState, to: toState });
          }
        }
      }
    }

    return transitions;
  } catch (error) {
    console.error('Failed to parse state transitions CSV:', error);
    return [];
  }
}

export function getStateTransitions(): Transition[] {
  // Try to find the CSV file
  const possiblePaths = [
    join(process.cwd(), '..', 'external', 'DiabloAvionics', 'test_guis', 'state_transitions.csv'),
    join(process.cwd(), '..', '..', 'external', 'DiabloAvionics', 'test_guis', 'state_transitions.csv'),
    '/home/kush-mahajan/sensor_system/external/DiabloAvionics/test_guis/state_transitions.csv',
  ];

  for (const path of possiblePaths) {
    try {
      const transitions = parseStateTransitionsCSV(path);
      if (transitions.length > 0) {
        return transitions;
      }
    } catch (error) {
      // Try next path
      continue;
    }
  }

  return [];
}
