/**
 * The drawing, zoomable, live, beside what was read from it.
 *
 * Values on it are the session's, so a shut valve reads what a shut valve reads
 * and an empty tank reads atmosphere. Clicking a valve takes it by hand.
 *
 * The side panel lists every number feed-twin pulled from the drawing, lets the
 * team type over one, and decides what the console shows. See DrawingPanel.
 */

import { useState } from 'react';
import { DrawingPanel } from '../components/DrawingPanel';
import { Schematic } from '../components/Schematic';
import { useStand } from '../stand';

const PANEL_KEY = 'feedtwin.pid.panel';

function remembered(): boolean {
  try {
    return window.localStorage.getItem(PANEL_KEY) !== 'closed';
  } catch {
    return true;
  }
}

export function Pid() {
  const { model, live, toggleValve } = useStand();
  const [panel, setPanel] = useState(remembered);
  const togglePanel = () => {
    setPanel((was) => {
      try {
        window.localStorage.setItem(PANEL_KEY, was ? 'closed' : 'open');
      } catch {
        // Storage can be unavailable; the toggle still works for this tab.
      }
      return !was;
    });
  };
  if (!model || !live) return <p className="p-6 text-sm text-text-muted">Loading…</p>;

  const held: Record<string, number> = {};
  for (const id of live.held) held[id] = 1;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-baseline gap-3 px-4 py-2">
        <span className="text-sm font-bold uppercase tracking-wider text-text-muted">
          {model.title}
        </span>
        <span className="font-mono text-[12px] text-blue-400">{live.state}</span>
        <span className="text-[11.5px] text-gray-600">
          Scroll to zoom · drag to pan · double-click to fit · click a valve to
          take it by hand
        </span>
        <button
          type="button"
          onClick={togglePanel}
          aria-expanded={panel}
          className="ml-auto rounded border border-gray-700 px-2 py-0.5 text-[11px] font-semibold text-gray-300 hover:border-blue-500 hover:text-blue-300"
        >
          {panel ? 'Hide drawing data' : 'Show drawing data'}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        <div className="bg-card h-full min-w-0 flex-1 rounded-lg border border-gray-800">
          <Schematic
            diagram={model}
            frame={{
              t: live.t,
              pressure_psi: live.pressure_psi,
              node_psi: live.node_psi,
              flow_kg_s: live.flow_kg_s,
              open: live.open,
              engine: live.engine,
            }}
            onToggle={toggleValve}
            held={held}
          />
        </div>
        {panel && (
          <aside className="bg-card h-full w-[400px] max-w-[45%] flex-shrink-0 overflow-hidden rounded-lg border border-gray-800">
            <DrawingPanel />
          </aside>
        )}
      </div>
    </div>
  );
}
