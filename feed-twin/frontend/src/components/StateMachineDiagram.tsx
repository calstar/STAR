/**
 * The Diablo state machine, as a grid of buttons in the DAQ's rows.
 *
 * The rows are the DAQ's (`daq-server/.../components/controls/
 * StateMachineDiagram.tsx`): Idle; Armed and the fills; Press Standby and the
 * presses; Vent and the vents; Calibrate and Ready. An operator who has
 * learned the real panel finds a state where they expect it. Fire is not a
 * square here -- it is the FIRE button in the Command panel -- and neither
 * are the aborts.
 *
 * The reachable set is not a hardcoded table: it is what the backend's
 * machine says from the stand's current state, the same left-aligned reading
 * of `diablo_transitions.csv` the DAQ makes. The current state is filled; a
 * state you can go to is lit and clickable; the rest are dim and say why.
 */

import type { ReactNode } from 'react';
import type { SessionState, StateMachine } from '../api';

const COLS = 5;
const ROW_COUNT = 5;

/** [row, col], the DAQ's layout. States the table has that this map does not
 *  are laid out after the last row so nothing is silently dropped. */
const STATE_POS: Record<string, [number, number]> = {
  Idle: [0, 0],
  Armed: [1, 0],
  'Fuel Fill': [1, 1],
  'Ox Fill': [1, 2],
  'Press Standby': [2, 0],
  'GN2 Low Press': [2, 1],
  'Fuel Press': [2, 2],
  'Ox Press': [2, 3],
  'GN2 High Press': [2, 4],
  Vent: [3, 0],
  'GN2 Low Vent': [3, 1],
  'Fuel Vent': [3, 2],
  'Ox Vent': [3, 3],
  'GN2 High Vent': [3, 4],
  Calibrate: [4, 0],
  Ready: [4, 1],
};

/** Commanded from the Command panel, not from the grid. */
export const OFF_GRID = /^fire$|abort|debug/i;

interface Props {
  machine: StateMachine;
  live: SessionState;
  go: (state: string) => void;
  /** Commands are refused while the stand is tripped. */
  locked?: boolean;
  /** Buttons for the header: the states the grid does not draw. */
  actions?: ReactNode;
}

/** The smallest a row of states gets [px]: two lines of label. */
const ROW_MIN = 40;

export default function StateMachineDiagram({ machine, live, go, locked = false, actions }: Props) {
  const states = machine.states.filter((s) => !OFF_GRID.test(s));
  const extra = states.filter((s) => STATE_POS[s] === undefined);
  const pos = (state: string): [number, number] =>
    STATE_POS[state] ?? [ROW_COUNT + Math.floor(extra.indexOf(state) / COLS), extra.indexOf(state) % COLS];
  const reachable = new Set(live.reachable);
  const rows = Math.max(1, ...states.map((st) => pos(st)[0] + 1));

  return (
    // Never shorter than every row at its smallest; the Console's panel
    // scrolls if the window cannot give it that.
    <div className="flex h-full flex-col">
      <div className="mb-4 flex flex-shrink-0 items-baseline justify-between gap-4">
        <h2 className="caps">State Machine</h2>
        {actions && <span className="ml-auto flex items-center gap-2">{actions}</span>}
        <span className="flex items-baseline gap-4">
          <span className="caps">Current</span>
          <span className="font-mono text-[17px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]">
            {live.state}
          </span>
        </span>
      </div>
      {/* Rows share the panel's height, so the squares grow with the window. */}
      <div
        className="grid flex-1 gap-2.5"
        style={{
          gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(${ROW_MIN}px, 1fr))`,
          minHeight: rows * ROW_MIN + (rows - 1) * 10,
        }}
      >
        {states.map((state) => {
          const [row, col] = pos(state);
          const active = state === live.state;
          const canGo = !locked && reachable.has(state) && !active;
          return (
            <button
              key={state}
              type="button"
              onClick={() => canGo && go(state)}
              aria-disabled={!canGo}
              aria-current={active ? 'step' : undefined}
              title={
                active
                  ? `${state} — current`
                  : canGo
                    ? `Go to ${state}`
                    : locked
                      ? 'The stand is stopped; reset it first'
                      : `${state} is not reachable from ${live.state}`
              }
              style={{ gridRow: row + 1, gridColumn: col + 1 }}
              className={`flex min-h-0 items-center justify-center border px-2 py-2 text-center font-mono text-[13px] font-semibold uppercase leading-snug tracking-[0.14em] transition-colors ${
                active
                  ? 'cursor-default border-[var(--ink)] bg-[var(--ink)] text-black'
                  : canGo
                    ? 'cursor-pointer border-[#3d3d3d] bg-[#0d0d0d] text-[var(--ink)] hover:border-[#8a8a8a] hover:bg-[#1a1a1a]'
                    : 'cursor-not-allowed border-[#1c1c1c] bg-[#080808] text-[#6a6a6a]'
              }`}
            >
              {state}
            </button>
          );
        })}
      </div>
    </div>
  );
}
