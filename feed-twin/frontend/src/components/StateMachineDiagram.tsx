/**
 * The Diablo state machine, drawn the way the DAQ draws it.
 *
 * A copy of `daq-server/.../components/controls/StateMachineDiagram.tsx`:
 * the same grid of rounded nodes in the same rows -- Idle; Armed and the
 * fills; Press Standby and the presses; Vent and the vents; Calibrate and
 * Ready; Fire -- the same colours (blue where you are, green where you can
 * go, grey where you cannot), the same lanes behind the rows, the same
 * monospace capitals. An operator who has learned the real panel reads this
 * one without translating.
 *
 * One difference, and it is the point of a twin: the reachable set is not a
 * hardcoded table, it is what the backend's machine says from the stand's
 * current state -- the same left-aligned reading of `diablo_transitions.csv`
 * the DAQ makes, ignition bypasses included. Clicking a green node commands
 * the transition. The aborts live in the top bar on the DAQ and here.
 */

import type { SessionState, StateMachine } from '../api';

const NW = 320;
const NH = 115;
const COLS = 5;
const COL_GAP = 360;
const ROW_GAP = 155;
const PAD = 24;
const ROW_COUNT = 6;

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
  Fire: [5, 0],
};

/** The DAQ keeps these off the diagram; they are buttons in the top bar. */
const OFF_DIAGRAM = /abort|debug/i;

interface Props {
  machine: StateMachine;
  live: SessionState;
  go: (state: string) => void;
  /** Commands are refused while the stand is tripped. */
  locked?: boolean;
}

export default function StateMachineDiagram({ machine, live, go, locked = false }: Props) {
  const states = machine.states.filter((s) => !OFF_DIAGRAM.test(s));
  // Anything the table names that the DAQ's layout does not: a row below.
  const extra = states.filter((s) => STATE_POS[s] === undefined);
  const pos = (state: string): [number, number] =>
    STATE_POS[state] ?? [ROW_COUNT, extra.indexOf(state)];
  const rows = ROW_COUNT + (extra.length > 0 ? 1 : 0);
  const nodeX = (state: string) => PAD + pos(state)[1] * COL_GAP;
  const nodeY = (state: string) => PAD + pos(state)[0] * ROW_GAP;
  const reachable = new Set(live.reachable);
  const svgW = PAD * 2 + COLS * COL_GAP;
  const svgH = PAD * 2 + rows * ROW_GAP;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-800 px-3 py-1.5">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
          State Machine
        </h2>
        <span className="font-mono text-[10px]">
          <span className="text-text-muted">CURRENT: </span>
          <span className="font-bold text-blue-400">{live.state.toUpperCase()}</span>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background p-1">
        <svg
          viewBox={`0 0 ${svgW} ${svgH}`}
          className="min-h-0 flex-1"
          style={{ display: 'block', width: '100%', height: '100%' }}
          preserveAspectRatio="xMidYMin meet"
        >
          {Array.from({ length: rows }).map((_, rowIdx) => (
            <rect
              key={`lane-${rowIdx}`}
              x={PAD - 16}
              y={PAD + rowIdx * ROW_GAP - 18}
              width={svgW - 2 * (PAD - 16)}
              height={NH + 36}
              fill="#020617"
              opacity={rowIdx % 2 === 0 ? 0.35 : 0.2}
            />
          ))}
          {states.map((state) => {
            const active = state === live.state;
            const canGo = !locked && reachable.has(state) && !active;
            const fill = active ? '#2563EB' : canGo ? '#059669' : '#1F2937';
            const stroke = active ? '#60A5FA' : canGo ? '#34D399' : '#374151';
            const x = nodeX(state);
            const y = nodeY(state);
            return (
              <g
                key={state}
                onClick={() => canGo && go(state)}
                className={canGo ? 'cursor-pointer' : 'cursor-not-allowed'}
                style={{ opacity: active || canGo ? 1 : 0.45 }}
                role="button"
                aria-disabled={!canGo}
              >
                <title>
                  {active
                    ? `${state} — current`
                    : canGo
                      ? `Go to ${state}`
                      : `${state} is not reachable from ${live.state}`}
                </title>
                <rect
                  x={x}
                  y={y}
                  width={NW}
                  height={NH}
                  rx={12}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={active || canGo ? 2 : 1.5}
                  style={{ transition: 'fill 0.15s, stroke 0.15s' }}
                />
                <text
                  x={x + NW / 2}
                  y={y + NH / 2 + 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="white"
                  fontSize={32}
                  fontWeight={active ? 700 : 600}
                  fontFamily="ui-monospace, monospace"
                  letterSpacing="0.05em"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {state.toUpperCase()}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
