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
 *
 * The ⋯ hides valves nobody is watching today. A hidden valve still shows
 * while it is open or held: a valve you cannot see is not a valve you can
 * forget is open. Not the cart's: its valves are put on the console from the
 * Hookup tab, and the ⋯ lists only the ones that are.
 */

import type { ModelView, SessionState, StateMachine } from '../api';
import { groupByPage } from '../lib/pages';
import PanelMenu from './PanelMenu';

interface Props {
  model: ModelView;
  machine: StateMachine | null;
  live: SessionState;
  onSet: (id: string, open: boolean) => void;
  onRelease: () => void;
  locked?: boolean;
  hidden?: string[];
  /** Drawing ids off the vehicle: the cart's valves. */
  ground?: ReadonlySet<string>;
  /** Console names (the hookup's aliases), by drawing id. */
  aliases?: Record<string, string>;
  onToggleHidden?: (id: string) => void;
  onAllHidden?: (show: boolean) => void;
}

export default function ActuatorGrid({
  model,
  machine,
  live,
  onSet,
  onRelease,
  locked = false,
  hidden = [],
  ground = new Set<string>(),
  aliases = {},
  onToggleHidden,
  onAllHidden,
}: Props) {
  const roleOf: Record<string, string> = {};
  for (const [actuator, symbol] of Object.entries(machine?.bound ?? {})) roleOf[symbol] = actuator;
  const urgent = (id: string) => !ground.has(id) && ((live.open[id] ?? false) || live.held.includes(id));
  const drawn = model.actuators.filter((a) => !hidden.includes(a.id) || urgent(a.id));
  // Counted on the grid: "1 open" with nothing open in sight (a cart dump
  // resting open off it) read as a bug. The rest is said, and named on hover.
  const opened = drawn.filter((a) => live.open[a.id]).length;
  const openOff = model.actuators.filter((a) => live.open[a.id] && !drawn.includes(a));
  // The menu lists them by sheet; the grid does not split. The cart's are
  // listed only once put on the console (Hookup tab).
  const offered = model.actuators.filter((a) => !ground.has(a.id) || !hidden.includes(a.id));
  const listed = groupByPage(offered, offered, (a) => a.id, model.pages);

  return (
    <div className="flex min-h-0 flex-col">
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
            {openOff.length > 0 && (
              <span
                className="ml-2 normal-case tracking-normal text-[var(--ink-3)]"
                title={`Open, not on the grid: ${openOff.map((a) => aliases[a.id] || roleOf[a.id] || a.tag).join(', ')}`}
              >
                +{openOff.length} off grid
              </span>
            )}
          </span>
          {onToggleHidden && onAllHidden && (
            <PanelMenu
              title="Actuators"
              items={listed.flatMap((g) =>
                g.items.map((a) => ({
                  id: a.id,
                  label: aliases[a.id] || (roleOf[a.id] ?? a.tag),
                  forced: urgent(a.id) ? 'Open or held, so it shows anyway' : undefined,
                  page: g.page,
                })),
              )}
              hidden={hidden}
              onToggle={onToggleHidden}
              onAll={onAllHidden}
            />
          )}
        </span>
      </div>
      {/* Scrolls when the valves outgrow the space the console gives them;
          the header and its Release stay put. */}
      <div className="grid min-h-0 grid-cols-4 content-start gap-2 overflow-y-auto pr-1">
        {drawn.map((a) => {
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
                <span className="truncate text-[14px] font-semibold text-[var(--ink)]">{aliases[a.id] || (role ?? a.tag)}</span>
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
