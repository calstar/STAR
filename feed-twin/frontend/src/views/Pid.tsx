/**
 * The drawing, full width, zoomable, live.
 *
 * Values on it are the session's, so a shut valve reads what a shut valve reads
 * and an empty tank reads atmosphere. Clicking a valve takes it by hand.
 */

import { Schematic } from '../components/Schematic';
import { useStand } from '../stand';

export function Pid() {
  const { model, live, toggleValve } = useStand();
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
      </div>
      <div className="min-h-0 flex-1 px-2 pb-2">
        <div className="bg-card h-full rounded-lg border border-gray-800">
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
      </div>
    </div>
  );
}
