/**
 * API route to parse state_transitions.csv and return transitions
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import type { SystemState } from '../shared-types.js';
import { readConfig } from '../routes/config.js';
import { csvStateMap } from './state-ids.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


interface Transition {
  from: SystemState;
  to: SystemState;
}


/**
 * Rows whose cell count differs from the header's, as "line N: <name> has X cells, the header
 * has Y". A short row used to be read left-aligned, so every cell after a missing one landed on
 * the wrong column: ten rows of the shipped table put a 1 under Fire and none under Emergency
 * Abort (C2-8). The sequencer refuses such a file too.
 */
export function raggedTransitionRows(csvContent: string): string[] {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 1) return [];
  const width = lines[0].split(',').length;
  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const row = lines[i].split(',');
    if (row.length !== width) {
      out.push(`line ${i + 1}: "${row[0].trim()}" has ${row.length} cells, the header has ${width}`);
    }
  }
  return out;
}

export function parseStateTransitionsCSV(csvPath: string): Transition[] {
  try {
    const csvContent = readFileSync(csvPath, 'utf-8');
    const lines = csvContent.trim().split('\n');

    if (lines.length < 2) {
      return [];
    }

    const ragged = raggedTransitionRows(csvContent);
    if (ragged.length > 0) {
      console.error(
        `❌ Refusing ${csvPath}: every row needs one cell per header column.\n  ${ragged.join('\n  ')}`,
      );
      return [];
    }

    // First line is header: ,Idle,Armed,...
    const headers = lines[0].split(',').slice(1); // Skip first empty cell
    const transitions: Transition[] = [];
    const stateMap = csvStateMap();

    // Parse each row (skip header)
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      const row = lines[i].split(',');
      const fromStateName = row[0].trim();
      const fromState = stateMap[fromStateName];

      if (fromState === undefined && fromStateName !== '') {
        continue; // Skip unknown states
      }

      // Check each column for valid transitions (value = 1)
      // headers[0] = Idle, headers[1] = Armed, etc.
      // row[0] = from state name, row[1] = transition to Idle, row[2] = transition to Armed, etc.
      for (let j = 1; j < row.length && j <= headers.length; j++) {
        if (row[j].trim() === '1') {
          const toStateName = headers[j - 1]?.trim();
          if (!toStateName) continue;
          const toState = stateMap[toStateName];

          if (toState !== undefined && fromState !== undefined) {
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

function buildTransitionsCSVSearchPaths(): string[] {
  const paths: string[] = [];
  try {
    const config = readConfig();
    const rel = config.state_machine?.transitions_csv;
    if (typeof rel === 'string' && rel.length > 0 && isAbsolute(rel)) {
      // An absolute path is used as written (C5-4); join() would have glued it onto each root.
      paths.push(rel);
    } else if (typeof rel === 'string' && rel.length > 0) {
      paths.push(join(__dirname, '..', '..', '..', '..', rel));
      paths.push(join(process.cwd(), '..', '..', rel));
      paths.push(join(process.cwd(), '..', rel));
    }
  } catch {
    /* fall through to defaults */
  }
  // Direct config/ fallback (canonical source of truth) if config.toml unreadable.
  const rel = join('config', 'state_transitions.csv');
  paths.push(
    join(process.cwd(), '..', '..', rel),
    join(process.cwd(), '..', rel),
    join(__dirname, '..', '..', '..', '..', rel),
  );
  return paths;
}

export function getStateTransitions(): Transition[] {
  const possiblePaths = buildTransitionsCSVSearchPaths();

  for (const path of possiblePaths) {
    try {
      if (!existsSync(path)) {
        continue;
      }
      // A file that is there but malformed is refused outright, not passed over for the next
      // candidate: falling back would put a table nobody configured in front of the operator.
      if (raggedTransitionRows(readFileSync(path, 'utf-8')).length > 0) {
        parseStateTransitionsCSV(path); // logs the rows
        return [];
      }
      const transitions = parseStateTransitionsCSV(path);
      if (transitions.length > 0) {
        console.log(`✅ Loaded state transitions from: ${path}`);
        return transitions;
      }
    } catch (error) {
      // Try next path
      continue;
    }
  }

  return [];
}
