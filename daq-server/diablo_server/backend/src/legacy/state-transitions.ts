/**
 * API route to parse state_transitions.csv and return transitions
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SystemState } from '../shared-types.js';
import { readConfig } from '../routes/config.js';
import { csvStateMap } from './state-ids.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


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
    const stateMap = csvStateMap();

    // Parse each row (skip header)
    for (let i = 1; i < lines.length; i++) {
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
    if (typeof rel === 'string' && rel.length > 0) {
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

// Build a lookup map for fast validation: fromState -> Set<toState>
let _transitionMap: Map<SystemState, Set<SystemState>> | null = null;

export function buildTransitionMap(): Map<SystemState, Set<SystemState>> {
  if (_transitionMap) {
    return _transitionMap;
  }

  _transitionMap = new Map();
  const transitions = getStateTransitions();

  for (const { from, to } of transitions) {
    if (!_transitionMap.has(from)) {
      _transitionMap.set(from, new Set());
    }
    _transitionMap.get(from)!.add(to);
  }

  console.log(`📋 Built transition map: ${transitions.length} allowed transitions`);
  // Label from the same map the ids came from — SystemState[id] here would name a different
  // state than the row describes, which is the confusion this class of bug creates.
  const nameById: Record<number, string> = {};
  for (const [n, id] of Object.entries(csvStateMap())) nameById[id as number] = n;
  const nm = (id: number) => nameById[id] ?? SystemState[id] ?? `STATE ${id}`;
  // Debug: log all transitions
  for (const [from, allowed] of _transitionMap.entries()) {
    console.log(`   ${nm(from)}: can go to [${Array.from(allowed).map(s => nm(s)).join(', ')}]`);
  }
  return _transitionMap;
}

export function isTransitionAllowed(from: SystemState, to: SystemState): boolean {
  const map = buildTransitionMap();
  const allowed = map.get(from);
  if (!allowed) {
    return false; // No transitions defined for this state
  }
  return allowed.has(to);
}
