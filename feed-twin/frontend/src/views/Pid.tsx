/**
 * The drawing, full width, zoomable, live.
 *
 * Drawn by pid-designer's own canvas, from the document pid-designer saved, so
 * it is the same drawing as in the editor: the same symbols, ports, rotation,
 * routing, colours and pages. feed-twin adds only what the stand is doing
 * (`LiveLayer`). Values on it are the session's, so a shut valve reads what a
 * shut valve reads and an empty tank reads atmosphere. Clicking a valve takes
 * it by hand.
 *
 * Beside it, what feed-twin read from the drawing: every number, the team's
 * overrides of them, and what the console shows (DrawingPanel).
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DrawingView } from '@pid/DrawingView';
import { getDrawing } from '../api';
import type { Drawing } from '../api';
import { DrawingPanel } from '../components/DrawingPanel';
import { LiveLayer } from '../components/LiveLayer';
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
  const { model, live, where, artifacts, toggleValve } = useStand();
  // The drawing is shown whether or not the stand runs: one the solver
  // cannot assemble is still a drawing somebody needs to look at.
  const diagram = where.diagram;
  const [drawing, setDrawing] = useState<{ id: string; doc: Drawing } | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!diagram) return;
    let stale = false;
    setError(null);
    getDrawing(diagram)
      .then((doc) => { if (!stale) setDrawing({ id: diagram, doc }); })
      .catch((e: Error) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [diagram]);

  // Only this drawing's stand: the one before it lingers while the next opens.
  const stand = model?.diagram_id === diagram ? model : null;
  const valves = useMemo(() => new Set(stand?.actuators.map((a) => a.id)), [stand]);
  const held = useMemo(() => new Set(live?.held), [live?.held]);
  const lines = useMemo(() => drawing?.doc.edges.map((e) => e.id) ?? [], [drawing]);

  if (error) return <p className="p-6 text-sm text-red-400">{error}</p>;
  if (!drawing || drawing.id !== diagram) {
    return <p className="p-6 text-sm text-text-muted">Loading…</p>;
  }
  const title = stand?.title ?? artifacts.find((a) => a.id === diagram)?.name ?? '';
  const pages = new Set(drawing.doc.nodes.map((n) => String((n.data as { page?: string } | undefined)?.page || 'Main'))).size;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-baseline gap-3 px-4 py-2">
        <span className="caps">
          {title}
        </span>
        {stand && live ? (
          <>
            <span className="font-mono text-[12px] text-blue-400">{live.state}</span>
            <span className="text-[11.5px] text-gray-600">
              psig · scroll to zoom · drag to pan · click a valve to take it by hand
            </span>
          </>
        ) : (
          <span className="text-[11.5px] text-gray-600">not running · scroll to zoom · drag to pan</span>
        )}
        {live?.setup?.ignore_gse && pages > 1 && (
          // The cart's page still draws; nothing on it is simulated.
          <Link
            to="/gse"
            className="rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] text-[var(--ink-2)] hover:text-[var(--ink)]"
            title="Ignore the drawn GSE is on: the stand is the rocket alone. The cart's page is drawn here, but none of it is simulated -- its valves do nothing and its gauges read nothing. Turn it off on GSE Controls."
          >
            Rocket only — the GSE page is not simulated
          </Link>
        )}
        <button
          type="button"
          onClick={togglePanel}
          aria-expanded={panel}
          className="ml-auto rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ink-2)] hover:text-[var(--ink)]"
        >
          {panel ? 'Hide drawing data' : 'Show drawing data'}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        <div className="pid-drawing h-full min-w-0 flex-1 overflow-hidden rounded-lg border border-gray-800">
          <DrawingView
            nodes={drawing.doc.nodes}
            edges={drawing.doc.edges}
            onSymbolClick={(id) => { if (valves.has(id)) toggleValve(id); }}
            clickable={valves}
          >
            {stand && live && (
              <LiveLayer
                frame={{
                  t: live.t,
                  pressure_psi: live.pressure_psi,
                  temperature_K: live.temperature_K,
                  node_psi: live.node_psi,
                  flow_kg_s: live.flow_kg_s,
                  open: live.open,
                  engine: live.engine,
                }}
                lines={lines}
                valves={valves}
                held={held}
              />
            )}
          </DrawingView>
        </div>
        {panel && (
          <aside className="bg-card h-full w-[400px] max-w-[45%] flex-shrink-0 overflow-hidden rounded-lg border border-[var(--line)]">
            <DrawingPanel />
          </aside>
        )}
      </div>
    </div>
  );
}
