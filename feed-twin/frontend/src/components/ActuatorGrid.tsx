/**
 * Actuator controls, the DAQ's 4x4 grid.
 *
 * A copy of `daq-server/.../components/controls/ActuatorControlByName.tsx`
 * laid out as `UnifiedDashboard` lays it out: sixteen slots, each a small
 * card with the actuator's name, a state dot, and Open/Close. Where the DAQ
 * shows the coil current, this shows the table's role for the valve and a
 * HELD marker when a hand has overridden the state machine -- the one thing
 * a twin knows that a stand does not say.
 */

import type { ModelView, SessionState, StateMachine } from '../api';

interface Props {
  model: ModelView;
  machine: StateMachine | null;
  live: SessionState;
  onSet: (id: string, open: boolean) => void;
  onRelease: () => void;
  locked?: boolean;
}

export default function ActuatorGrid({ model, machine, live, onSet, onRelease, locked = false }: Props) {
  const roleOf: Record<string, string> = {};
  for (const [actuator, symbol] of Object.entries(machine?.bound ?? {})) roleOf[symbol] = actuator;
  // The DAQ draws sixteen slots because the stand has sixteen channels. The
  // drawing says how many this stand has; the rest of the column goes to the
  // state machine.
  const slots = Math.max(4, Math.ceil(model.actuators.length / 4) * 4);

  return (
    <div className="flex flex-col">
      <div className="mb-1 flex flex-shrink-0 items-center justify-between">
        <h2 className="text-[10px] font-bold uppercase leading-none tracking-widest text-text-muted">
          Actuator Controls
        </h2>
        {live.held.length > 0 && (
          <button
            type="button"
            onClick={onRelease}
            className="rounded border border-blue-800 bg-blue-950/50 px-2 py-0.5 text-[10px] font-semibold text-blue-300 hover:bg-blue-900/60"
          >
            Release {live.held.length} held → {live.state}
          </button>
        )}
      </div>
      <div className="grid grid-cols-4 gap-1">
        {Array.from({ length: slots }, (_, i) => {
          const a = model.actuators[i];
          if (!a) {
            return <div key={`empty-${i}`} className="rounded border border-gray-800/50 bg-gray-900/30" />;
          }
          const open = live.open[a.id] ?? false;
          const held = live.held.includes(a.id);
          const role = roleOf[a.id];
          return (
            <div
              key={a.id}
              className="relative flex flex-col gap-0.5 rounded border border-gray-700 bg-background p-1 transition-colors hover:border-gray-600"
            >
              <div className="absolute right-0.5 top-0.5 flex items-center gap-0.5">
                {held && (
                  <span
                    title="Held by hand — the state machine is not commanding this until the next transition"
                    className="font-mono text-[8px] leading-none text-blue-400"
                  >
                    HELD
                  </span>
                )}
                <div className={`h-2 w-2 flex-shrink-0 rounded-full ${open ? 'bg-green-500' : 'bg-red-500'}`} />
              </div>
              <div className="flex items-center overflow-hidden pr-4">
                <h3 className="truncate text-[9px] font-bold uppercase leading-tight tracking-wider text-text xl:text-[10px]">
                  {a.tag}
                </h3>
              </div>
              <div className="flex items-center overflow-hidden">
                <span className="truncate font-mono text-[9px] text-text-muted">
                  {role ?? 'not in the table'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-0.5">
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => onSet(a.id, true)}
                  className={`rounded py-1 text-[8px] font-bold uppercase leading-none tracking-wider transition-all xl:text-[9px] ${
                    open
                      ? 'bg-green-700 text-white ring-1 ring-green-400'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  Open
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => onSet(a.id, false)}
                  className={`rounded py-1 text-[8px] font-bold uppercase leading-none tracking-wider transition-all xl:text-[9px] ${
                    !open
                      ? 'bg-red-700 text-white ring-1 ring-red-400'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  Close
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
