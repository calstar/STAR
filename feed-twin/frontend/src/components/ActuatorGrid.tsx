/**
 * The actuators: a compact grid, each cell a valve's name and a switch that
 * says what it is.
 *
 * Named by what the state machine calls it ("LOX Press"), which is how an
 * operator thinks of a valve; the drawing's tag (SV-LOX-PRESS) is the
 * tooltip. A valve the table does not name shows its tag. The switch reads
 * the valve's state and flips it: what it says is what the valve is, and
 * clicking it is the command to make it the other thing.
 *
 * Kept short on purpose -- four across, a row per four valves -- so the plot
 * and the state machine get the height.
 *
 * HELD marks a valve a hand has taken from the state machine -- the one thing
 * a twin knows that a stand does not say -- and the header offers to hand
 * them all back.
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
  const opened = model.actuators.filter((a) => live.open[a.id]).length;

  return (
    <div className="flex flex-col">
      <div className="mb-3 flex flex-shrink-0 items-baseline justify-between gap-3">
        <h2 className="caps">Actuators</h2>
        <span className="flex items-baseline gap-3">
          {live.held.length > 0 && (
            <button
              type="button"
              onClick={onRelease}
              className="ctl h-6 px-2 text-[10px]"
              title="Hand every held valve back to the state machine"
            >
              Release {live.held.length} held → {live.state}
            </button>
          )}
          <span className="font-mono text-[12px] uppercase tracking-[0.12em] text-[var(--ink-2)]">
            {opened} open
          </span>
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {model.actuators.map((a) => {
          const open = live.open[a.id] ?? false;
          const held = live.held.includes(a.id);
          const role = roleOf[a.id];
          return (
            <button
              key={a.id}
              type="button"
              disabled={locked}
              onClick={() => onSet(a.id, !open)}
              aria-pressed={open}
              title={`${a.tag}${role ? ` — ${role}` : ' — not in the table'}: ${open ? 'open, click to close' : 'closed, click to open'}${
                held ? '. Held by hand: the state machine is not commanding it until the next transition.' : ''
              }`}
              className={`flex min-w-0 items-center justify-between gap-2 border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                open
                  ? 'border-[var(--color-success)] bg-[#0b140e] hover:bg-[#10201a]'
                  : 'border-[var(--line-strong)] hover:border-[#5a5a5a] hover:bg-[#111]'
              }`}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[14px] font-semibold text-[var(--ink)]">{role ?? a.tag}</span>
                <span
                  className={`mt-0.5 font-mono text-[10px] uppercase leading-none tracking-[0.14em] ${
                    open ? 'text-[var(--color-success)]' : 'text-[var(--ink-3)]'
                  }`}
                >
                  {open ? 'Open' : 'Closed'}
                  {held && <span className="ml-1.5 text-[var(--color-warning)]">· held</span>}
                </span>
              </span>
              <span
                className="h-2 w-2 flex-shrink-0 rounded-full"
                style={{ background: open ? 'var(--color-success)' : 'var(--ink-4)' }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
