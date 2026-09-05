/**
 * The system state list — one place, not six.
 *
 * Labels used to live in six independent maps (StateMachineDiagram, StateMachinePanel, TopBar,
 * MobileDashboard, app/controller, app/status), each a partial hand-written copy keyed by raw
 * numeric ids. They had already drifted: TopBar and MobileDashboard omitted 18 and 19 entirely, so
 * GSE Abort and Emergency Abort rendered as "STATE 18" / "STATE 19"; app/controller stopped at 17
 * and still used older wording.
 *
 * Source of truth is `[[states]]` in the active config profile, served by /api/states. The
 * built-in table below is a COMPLETE fallback, so a failed fetch degrades to correct-but-static
 * labels rather than to `STATE <n>`.
 *
 * Ids are stable keys, not an ordering: they are written into Elodin run history as raw u8 with no
 * name table beside them. Rename and reorder freely; never reuse an id for a different state.
 */

export interface StateDef {
  id: number;
  name: string;
  isAbort: boolean;
  isBoot: boolean;
  /** Position on the State Machine control panel. null = not shown there. */
  panelRow: number | null;
  panelCol: number | null;
}

/**
 * Complete built-in list, matching the config defaults.
 *
 * Id 0 (Debug) is deliberately absent. It was a state in name only: no column in either CSV, so it
 * had no actuator positions and no transitions, and nothing ever transitioned to it — the GUI's
 * debug control maps to Idle (server.ts STATE_TO_CSV_NAME). The real mechanism is the sequencer's
 * `debug_mode_` flag, which bypasses transition validation and enables manual actuator commands.
 * The C++ enumerator still exists so historic run data decodes, but it is not offered as a state.
 */
const BUILT_IN: StateDef[] = [
  { id: 1, name: 'Idle', isAbort: false, isBoot: true , panelRow: 0, panelCol: 0 },
  { id: 2, name: 'Armed', isAbort: false, isBoot: false , panelRow: 1, panelCol: 0 },
  { id: 3, name: 'Fuel Fill', isAbort: false, isBoot: false , panelRow: 1, panelCol: 1 },
  { id: 4, name: 'Ox Fill', isAbort: false, isBoot: false , panelRow: 1, panelCol: 2 },
  { id: 5, name: 'GN2 Low Press', isAbort: false, isBoot: false , panelRow: 2, panelCol: 1 },
  { id: 6, name: 'GN2 Low Vent', isAbort: false, isBoot: false , panelRow: 3, panelCol: 1 },
  { id: 7, name: 'Fuel Press', isAbort: false, isBoot: false , panelRow: 2, panelCol: 2 },
  { id: 8, name: 'Fuel Vent', isAbort: false, isBoot: false , panelRow: 3, panelCol: 2 },
  { id: 9, name: 'Ox Press', isAbort: false, isBoot: false , panelRow: 2, panelCol: 3 },
  { id: 10, name: 'Ox Vent', isAbort: false, isBoot: false , panelRow: 3, panelCol: 3 },
  { id: 11, name: 'GN2 High Press', isAbort: false, isBoot: false , panelRow: 2, panelCol: 4 },
  { id: 12, name: 'GN2 High Vent', isAbort: false, isBoot: false , panelRow: 3, panelCol: 4 },
  { id: 13, name: 'Vent', isAbort: false, isBoot: false , panelRow: 3, panelCol: 0 },
  { id: 14, name: 'Calibrate', isAbort: false, isBoot: false , panelRow: 4, panelCol: 0 },
  { id: 15, name: 'Ready', isAbort: false, isBoot: false , panelRow: 4, panelCol: 1 },
  { id: 16, name: 'Fire', isAbort: false, isBoot: false , panelRow: 5, panelCol: 0 },
  { id: 17, name: 'Engine Abort', isAbort: true, isBoot: false , panelRow: null, panelCol: null },
  { id: 18, name: 'GSE Abort', isAbort: true, isBoot: false , panelRow: null, panelCol: null },
  { id: 19, name: 'Emergency Abort', isAbort: true, isBoot: false , panelRow: null, panelCol: null },
  { id: 20, name: 'Press Standby', isAbort: false, isBoot: false , panelRow: 2, panelCol: 0 },
];

const BUILT_IN_BY_ID = new Map<number, StateDef>(BUILT_IN.map((s) => [s.id, s]));

let states: StateDef[] = BUILT_IN;
let byId = new Map<number, StateDef>(BUILT_IN_BY_ID);
let loaded = false;
let inFlight: Promise<StateDef[]> | null = null;

function adopt(next: StateDef[]): StateDef[] {
  if (next.length === 0) return states;
  // Two different questions, two different answers, which this used to conflate.
  //
  // "What is state 14 called?" is asked of ids read back from Elodin run history, which may name
  // a state the current config no longer declares. That lookup still overlays config onto the
  // built-in table, so an old run decodes to "Calibrate" instead of "STATE 14".
  //
  // "Which states exist?" is asked by the diagram and the panel, and there the overlay was wrong:
  // a config declaring ids 1-12 left built-in 13-20 standing, each keeping its built-in panel
  // position. A rig whose own Ready sits at (4,0) then drew built-in Calibrate in the same cell.
  // The config is the whole list of states that exist; anything it drops is gone.
  const merged = new Map<number, StateDef>(BUILT_IN_BY_ID);
  for (const s of next) merged.set(s.id, s);
  byId = merged;
  states = [...next].sort((a, b) => a.id - b.id);
  loaded = true;
  return states;
}

/** Fetch the config-declared states and cache them. Safe to call repeatedly — cached after the
 *  first success. Pass force=true to refetch (e.g. after a config edit), which rebuilds from the
 *  built-in baseline first so removed/renamed states don't linger from a previous fetch. */
export async function loadStates(apiBase: string, force = false): Promise<StateDef[]> {
  if (loaded && !force) return states;
  if (inFlight && !force) return inFlight;
  inFlight = (async () => {
    try {
      const r = await fetch(`${apiBase}/api/states`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (force) {
        // Clean baseline before overlaying the fresh server list, so a state the config no longer
        // declares reverts to its built-in (or drops) instead of persisting from the last fetch.
        byId = new Map(BUILT_IN_BY_ID);
        states = BUILT_IN;
      }
      return adopt(Array.isArray(body?.states) ? body.states : []);
    } catch {
      // Built-in list stands; labels stay correct, they just stop tracking config.
      return states;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Display name for a state id. Never returns "STATE <n>" for a known state. */
export function stateName(id: number | null | undefined): string {
  if (id === null || id === undefined) return 'UNKNOWN';
  return byId.get(id)?.name ?? `STATE ${id}`;
}

/** Upper-case display name, for the header/top-bar styling. */
export function stateNameUpper(id: number | null | undefined): string {
  return stateName(id).toUpperCase();
}

/** True if the state carries abort semantics (drives the red styling). */
export function isAbortState(id: number | null | undefined): boolean {
  return id !== null && id !== undefined && (byId.get(id)?.isAbort ?? false);
}

/** All known states, ordered by id. */
export function allStates(): StateDef[] {
  return states;
}
