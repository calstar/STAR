/**
 * feed-twin: the stand, simulated.
 *
 * The header is always there -- the views, the solver's health, the stand
 * clock, and off the Console the state and an abort -- and below it the route
 * decides what you are looking at. Views are *routes*, not panels in a picker:
 * they get the whole width, they have URLs, and adding one does not make every
 * other view's chrome longer.
 */

import { Route, Routes } from 'react-router-dom';
import { TopBar } from './components/TopBar';
import { StandProvider, useStand } from './stand';
import TripOverlay from './components/TripOverlay';
import { Console } from './views/Console';
import { Gse } from './views/Gse';
import { Config } from './views/Config';
import { Pid } from './views/Pid';
import { Plots } from './views/Plots';
import { Engine } from './views/Engine';
import { Hookup } from './views/Hookup';
import { Solver } from './views/Solver';
import { Runs } from './views/Runs';
import { Study } from './views/Study';
import { Library } from './views/Library';
import { ReportView } from './views/ReportView';

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
  { group: 'Set up', path: '/hookup', label: 'Hookup', hint: 'Which valve each actuator opens, what the console shows and calls things, which knob sets which regulator' },
  { group: 'Set up', path: '/config', label: 'Configuration', hint: 'Every number the twin assumes, explained and editable' },
  { group: 'Set up', path: '/report', label: 'Checks', hint: 'What the twin read from the drawing, what it had to assume, and what looks wrong' },
] as const;

function Shell() {
  const stand = useStand();
  const { live, error } = stand;

  return (
    <div className="flex h-full flex-col">
      <TopBar views={VIEWS} />

      {error && (
        <p className="flex-shrink-0 border-b border-[var(--line)] px-8 py-2 font-mono text-[12px] text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <main className="relative min-h-0 flex-1 overflow-auto">
        {live?.tripped && <TripOverlay message={live.tripped} onReset={stand.restart} />}
        <Routes>
          <Route path="/" element={<Console />} />
          <Route path="/gse" element={<Gse />} />
          <Route path="/hookup" element={<Hookup />} />
          <Route path="/config" element={<Config />} />
          <Route path="/pid" element={<Pid />} />
          <Route path="/plots" element={<Plots />} />
          <Route path="/engine" element={<Engine />} />
          <Route path="/mixture" element={<Engine />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/solver" element={<Solver />} />
          <Route path="/study" element={<Study />} />
          <Route path="/library" element={<Library />} />
          <Route path="/report" element={<ReportView />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <StandProvider>
      <Shell />
    </StandProvider>
  );
}
