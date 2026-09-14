/**
 * feed-twin: the stand, simulated.
 *
 * Laid out the way the DAQ is, because it is the same job. The top bar is
 * always there — pressure bars, state, FIRE — and below it the route decides
 * what you are looking at. Views are *routes*, not panels in a picker: they get
 * the whole width, they have URLs, and adding one does not make every other
 * view's chrome longer.
 */

import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { channelColor } from './api';
import { TopBar } from './components/TopBar';
import { StandProvider, useStand } from './stand';
import TripOverlay from './components/TripOverlay';
import { Console } from './views/Console';
import { Gse } from './views/Gse';
import { Config } from './views/Config';
import { Pid } from './views/Pid';
import { Plots } from './views/Plots';
import { Mixture } from './views/Mixture';
import { Study } from './views/Study';
import { Library } from './views/Library';
import { ReportView } from './views/ReportView';

/** The views, in the order somebody works through them. Accents match the
 *  DAQ's launcher: a colour per view, carried on its left edge. */
export const VIEWS = [
  { path: '/', label: 'Console', hint: 'Pressures, plot, valves, state machine', accent: '#EC4899' },
  { path: '/gse', label: 'GSE Controls', hint: 'The hand-loaded regulators and the cart', accent: '#EAB308' },
  { path: '/config', label: 'Configuration', hint: 'Every number the twin assumes, explained and editable', accent: '#94A3B8' },
  { path: '/pid', label: 'P&ID', hint: 'The drawing, live — zoom and click', accent: '#3498DB' },
  { path: '/plots', label: 'Pressure', hint: 'Channels against time', accent: '#27AE60' },
  { path: '/mixture', label: 'Mixture', hint: 'What sets O/F, and by how much', accent: '#F39C12' },
  { path: '/study', label: 'Study', hint: 'COPV sizing: run it, get the curves', accent: '#22C55E' },
  { path: '/library', label: 'Library', hint: 'Import drawings and engines', accent: '#9B59B6' },
  { path: '/report', label: 'Report', hint: 'What was read, what was assumed', accent: '#22D3EE' },
] as const;

function Nav() {
  const { pathname } = useLocation();
  const { model } = useStand();
  const warnings = model?.report.warnings.length ?? 0;

  return (
    <nav className="flex flex-shrink-0 items-stretch gap-1 border-b border-gray-800 bg-black/30 px-3">
      {VIEWS.map((v) => {
        const active = pathname === v.path;
        return (
          <Link
            key={v.path}
            to={v.path}
            title={v.hint}
            className={`relative px-4 py-2 text-[13px] font-semibold tracking-wide transition-colors ${
              active ? 'text-white' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {v.label}
            {v.path === '/report' && warnings > 0 && (
              <span className="ml-1.5 rounded bg-amber-900/60 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
                {warnings}
              </span>
            )}
            {active && (
              <span
                className="absolute inset-x-2 bottom-0 h-0.5 rounded-full"
                style={{ background: v.accent }}
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function Shell() {
  const stand = useStand();
  const { model, live, history, busy, error, running, speed } = stand;

  const channels = (history?.channels ?? []).map((c) => ({
    ...c,
    color: channelColor(c.tag),
  }));

  return (
    <div className="flex h-full flex-col">
      <TopBar
        live={live}
        onState={stand.go}
        onAbort={() => stand.go('Engine Abort')}
        running={running}
        onRunning={stand.setRunning}
        onRestart={stand.restart}
        busy={busy}
        speed={speed}
        channels={channels}
        hidden={stand.hidden}
        onToggleChannel={stand.toggleChannel}
        title={model ? `${model.title}${model.report.coupled ? ' · coupled' : ''}` : '—'}
      />

      <Nav />

      {error && (
        <p className="flex-shrink-0 border-b border-red-900/60 bg-red-950/40 px-4 py-2 text-[13px] text-red-300">
          {error}
        </p>
      )}


      <main className="relative min-h-0 flex-1 overflow-auto">
        {live?.tripped && <TripOverlay message={live.tripped} onReset={stand.restart} />}
        <Routes>
          <Route path="/" element={<Console />} />
          <Route path="/gse" element={<Gse />} />
          <Route path="/config" element={<Config />} />
          <Route path="/pid" element={<Pid />} />
          <Route path="/plots" element={<Plots />} />
          <Route path="/mixture" element={<Mixture />} />
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
