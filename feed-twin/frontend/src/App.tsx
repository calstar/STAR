/**
 * Hotbench Twin (feed-twin): the stand, simulated.
 *
 * The header is always there -- the views, the solver's health, the stand
 * clock, and off the Console the state and an abort -- and below it the route
 * decides what you are looking at. Views are *routes*, not panels in a picker:
 * they get the whole width, they have URLs, and adding one does not make every
 * other view's chrome longer.
 */

import { useEffect, useState } from 'react';
import { Navigate, useLocation, useRoutes, type RouteObject } from 'react-router-dom';
import { TopBar } from './components/TopBar';
import { StandProvider, useStand } from './stand';
import { pendingWords } from './lib/standPick';
import { HookupProvider } from './lib/useHookup';
import TripOverlay from './components/TripOverlay';
import { NoStand } from './components/NoStand';
import { Console } from './views/Console';
import { Gse } from './views/Gse';
import { Config } from './views/Config';
import { Pid } from './views/Pid';
import { Plots } from './views/Plots';
import { Engine } from './views/Engine';
import { StateMachineView } from './views/StateMachineView';
import { Solver } from './views/Solver';
import { Runs } from './views/Runs';
import { Study } from './views/Study';
import { Library } from './views/Library';
import { ReportView } from './views/ReportView';
import { askedStand, missedStand } from './lib/standLink';

/** The views, in three groups: running the stand, reading what it did, and
 *  setting it up. Thirteen tabs in one row read as a list to search; three
 *  labelled groups read as a map (the operator, 2026-10-09). */
export const VIEWS = [
  { group: 'Operate', path: '/', label: 'Console', hint: 'Pressures, plot, valves, state machine' },
  { group: 'Operate', path: '/pid', label: 'P&ID', hint: 'The drawing, live — zoom and click' },
  { group: 'Operate', path: '/gse', label: 'GSE Controls', hint: 'The hand-loaded regulators and the cart' },
  { group: 'Operate', path: '/plots', label: 'Plots', hint: 'Every pressure and temperature channel against time' },
  { group: 'Results', path: '/engine', label: 'Engine', hint: 'What the engine did: the burn totalled, its traces, and what set O/F' },
  { group: 'Results', path: '/runs', label: 'Runs', hint: 'Every burn fired, kept with what it ran on: compare two, and see which input moved the answer' },
  { group: 'Results', path: '/study', label: 'Study', hint: 'Your stand, burned from T-0 once per case: change the COPV, a knob, the bottle, the load, or sweep one' },
  { group: 'Results', path: '/solver', label: 'Solver', hint: 'Can these numbers be trusted? Residuals, mass balance and the iteration log' },
  { group: 'Set up', path: '/library', label: 'Library', hint: 'Import drawings and engines' },
  { group: 'Set up', path: '/statemachine', label: 'State machine', hint: 'The DAQ’s state table: what each state opens, and which states can follow which' },
  { group: 'Set up', path: '/config', label: 'Configuration', hint: 'Assumed numbers, editable' },
  { group: 'Set up', path: '/report', label: 'Checks', hint: 'What the twin read from the drawing, what it had to assume, and what looks wrong' },
] as const;

/** Which view each address shows. An address that is no view goes to the
 *  Console: it drew the header over an empty page, and React Router warned
 *  "No routes matched" on every tick. */
export const ROUTES: RouteObject[] = [
  { path: '/', element: <Console /> },
  { path: '/gse', element: <Gse /> },
  // The knobs were a tab; they are at the foot of GSE Controls.
  { path: '/hookup', element: <Navigate to="/gse" replace /> },
  { path: '/statemachine', element: <StateMachineView /> },
  { path: '/config', element: <Config /> },
  { path: '/pid', element: <Pid /> },
  { path: '/plots', element: <Plots /> },
  { path: '/engine', element: <Engine /> },
  { path: '/mixture', element: <Engine /> },
  { path: '/runs', element: <Runs /> },
  { path: '/solver', element: <Solver /> },
  { path: '/study', element: <Study /> },
  { path: '/library', element: <Library /> },
  { path: '/report', element: <ReportView /> },
  { path: '*', element: <Navigate to="/" replace /> },
];

function Routed() {
  return useRoutes(ROUTES);
}

/** A switch of drawing or engine waiting for a yes: the stand on screen is
 *  past Idle and switching throws it away. */
function PendingPickBar() {
  const { pendingPick, confirmPick, cancelPick } = useStand();
  if (!pendingPick) return null;
  const words = pendingWords(pendingPick);
  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--color-warning)] px-8 py-2.5 font-mono text-[12px]">
      <span className="text-[var(--ink)]">{words.ask}</span>
      <span className="text-[var(--ink-3)]">{words.why}</span>
      <span className="ml-auto flex gap-2">
        <button type="button" onClick={confirmPick} className="ctl h-7 px-3 text-[10px]">
          {words.yes}
        </button>
        <button type="button" onClick={cancelPick} className="ctl h-7 px-3 text-[10px]">
          Keep this stand
        </button>
      </span>
    </div>
  );
}

function Shell() {
  const stand = useStand();
  const { live, model, error } = stand;
  const { pathname } = useLocation();
  // Every view but the Library reads a stand. Without one it shows why and
  // the way out, not its own "Loading…" that never ends.
  const standless = (!live || !model) && pathname !== '/library';
  // A link that named a stand (`/?stand=<id>`), read before the provider
  // drops it from the address. Whether it opened is decided once, when the
  // first stand lands -- a stand picked later is not the link missing -- and
  // said until dismissed.
  const [asked] = useState(() => askedStand(window.location.search));
  const [missed, setMissed] = useState<string | null>(asked ? null : '');
  const landed = Boolean(live && model) || Boolean(stand.noStand && stand.noStand.kind !== 'library');
  const opened = stand.standDoc?.ref ?? null;
  useEffect(() => {
    if (missed === null && landed) setMissed(missedStand(asked, opened, true));
  }, [missed, landed, asked, opened]);

  return (
    <div className="flex h-full flex-col">
      <TopBar views={VIEWS} />

      <PendingPickBar />
      {error && (
        <p className="flex flex-shrink-0 items-baseline gap-4 border-b border-[var(--line)] px-8 py-2 font-mono text-[12px] text-[var(--color-danger)]">
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={stand.dismissError}
            aria-label="Dismiss"
            title="Dismiss. It also goes on the next action that goes through."
            className="flex-shrink-0 text-[var(--ink-3)] hover:text-[var(--ink)]"
          >
            ×
          </button>
        </p>
      )}
      {missed && (
        <p className="flex flex-shrink-0 items-baseline gap-4 border-b border-[var(--line)] px-8 py-2 font-mono text-[12px] text-[var(--color-warning)]">
          {missed}
          <button type="button" onClick={() => setMissed('')} className="ml-auto text-[var(--ink-3)] hover:text-[var(--ink)]">
            Dismiss
          </button>
        </p>
      )}

      <main className="relative min-h-0 flex-1 overflow-auto">
        {live?.tripped && <TripOverlay message={live.tripped} onReset={stand.restart} />}
        {standless ? (
          <NoStand />
        ) : (
        <Routed />
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <StandProvider>
      <HookupProvider>
        <Shell />
      </HookupProvider>
    </StandProvider>
  );
}
