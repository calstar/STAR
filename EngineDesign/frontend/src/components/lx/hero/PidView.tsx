import '@xyflow/react/dist/style.css';
import { ConnectionMode, ReactFlow, ReactFlowProvider, useNodes, useReactFlow, useStore, type Edge, type Node } from '@xyflow/react';
import { ReadOnlyProvider } from '@stardesign-ui';
import { AttachmentLayer, DrawnRoutes } from '@pid/AttachmentLayer';
import { BranchableEdge } from '@pid/BranchableEdge';
import { FluidProvider } from '@pid/FluidContext';
import { migrate } from '@pid/migrate';
import { nodeTypes } from '@pid/nodes';
import { applyPage, DEFAULT_PAGE, pageOf } from '@pid/pages';
import { VentLayer } from '@pid/VentLayer';
import { useEffect, useMemo, type CSSProperties } from 'react';
import type { LayerXResult } from '../../../api/layerx';
import { NotComputed } from '../ui';
import { useUnits } from '../units';
import { parseDrawing, type DrawingDocument } from './drawing';
import { useCursorIndexOr, useDrawingDocument } from './hooks';
import { at } from './contract';
import { buildNetView, type NetView } from './network';
import { stateWord, vesselFigure } from './readout';

/**
 * The feed system as the person drew it: pid-designer's own nodes, lines and routing, read-only,
 * with the burn's numbers at the cursor written beside each vessel and valve. Drawing it with the
 * editor's code is the point -- a second renderer here laid the same drawing out again, stacked
 * every symbol in one column and drew nothing like what was drawn.
 */

const EDGE_TYPES = { smoothstep: BranchableEdge, default: BranchableEdge };

/** pid-designer's theme variables, answered from Layer X's tokens so the drawing wears this page. */
const THEME = {
  '--color-bg-primary': 'var(--lx-surface)',
  '--color-bg-secondary': 'var(--lx-surface-2)',
  '--color-bg-tertiary': 'var(--lx-raised)',
  '--color-accent': 'var(--lx-text-2)',
  '--color-accent-hover': 'var(--lx-text)',
  '--color-border': 'var(--lx-line-strong)',
  '--color-text-primary': 'var(--lx-text)',
  '--color-text-secondary': 'var(--lx-text-2)',
  '--color-text-muted': 'var(--lx-text-3)',
  '--color-warning': 'var(--lx-warn)',
  '--color-danger': 'var(--lx-bad)',
} as CSSProperties;

/** The page holding most of the drawing: a multi-page drawing's feed system is on one of them. */
function mainPage(nodes: Node[]): string {
  const count = new Map<string, number>();
  for (const n of nodes) {
    const p = pageOf(n.data as { page?: string });
    count.set(p, (count.get(p) ?? 0) + 1);
  }
  let best = DEFAULT_PAGE;
  for (const [p, c] of count) if (c > (count.get(best) ?? 0)) best = p;
  return best;
}

export function PidView({ result, drawingId, doc, height = 460 }: {
  result: LayerXResult;
  drawingId: string;
  doc?: DrawingDocument | null;
  height?: number;
}) {
  const loaded = useDrawingDocument(drawingId, doc);
  const raw = loaded.state === 'ready' ? loaded.value.document : null;
  const view = useMemo(() => {
    if (!raw) return null;
    const flow = migrate({ nodes: (raw.nodes ?? []) as Node[], edges: (raw.edges ?? []) as Edge[] });
    return applyPage(flow.nodes, flow.edges, mainPage(flow.nodes));
  }, [raw]);
  const net = useMemo(() => (raw ? buildNetView(parseDrawing(raw), result) : null), [raw, result]);

  if (loaded.state === 'error') {
    return <NotComputed height={240}><span title={loaded.error}>The drawing is not available</span></NotComputed>;
  }
  if (!view || !net || !raw) return <NotComputed height={260}>Loading the drawing</NotComputed>;
  return (
    <div className="lx-pid relative min-w-0 overflow-hidden rounded" style={{ ...THEME, height }}>
      <ReadOnlyProvider readOnly>
        <ReactFlowProvider>
          <FluidProvider nodes={view.nodes} edges={view.edges}>
            <ReactFlow
              nodes={view.nodes}
              edges={view.edges}
              nodeTypes={nodeTypes}
              edgeTypes={EDGE_TYPES}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              edgesReconnectable={false}
              // As the editor runs it: every port is a source handle, and a line's far end is
              // one too. In the default strict mode React Flow drops every line on the drawing.
              connectionMode={ConnectionMode.Loose}
              deleteKeyCode={null}
              panOnDrag
              zoomOnScroll={false}
              preventScrolling={false}
              fitView
              fitViewOptions={{ padding: 0.06 }}
              minZoom={0.2}
              proOptions={{ hideAttribution: true }}
              style={{ background: 'transparent' }}
            >
              <DrawnRoutes><AttachmentLayer nodes={view.nodes} edges={view.edges} /></DrawnRoutes>
              <VentLayer nodes={view.nodes} edges={view.edges} />
              <Readouts doc={raw} net={net} />
              <FitOnResize />
            </ReactFlow>
          </FluidProvider>
        </ReactFlowProvider>
      </ReadOnlyProvider>
      {net.source === 'series' && (
        <span className="pointer-events-none absolute left-2 top-2 z-[6] text-[11px] text-[var(--lx-text-3)]"
              title="This run did not record the feed network: the numbers are read from the bottle, regulator and tank series.">
          network not recorded
        </span>
      )}
    </div>
  );
}

/** The whole drawing in view whenever the panel changes size, not only when it first mounts. */
function FitOnResize() {
  const { fitView } = useReactFlow();
  const w = useStore((st) => st.width);
  const h = useStore((st) => st.height);
  const ready = useStore((st) => st.nodeLookup.size > 0);
  useEffect(() => {
    if (w > 0 && h > 0 && ready) void fitView({ padding: 0.06 });
  }, [w, h, ready, fitView]);
  return null;
}

/** Each vessel's figure (pressure, a regulator's use) and each valve's state at the cursor, just
 *  right of its symbol -- placed through the view's pan and zoom but drawn at screen size, so a
 *  whole stand fitted to the panel still has numbers a person can read. */
function Readouts({ doc, net }: { doc: DrawingDocument['document']; net: NetView }) {
  const u = useUnits();
  const i = useCursorIndexOr(net.t.length - 1);
  const nodes = useNodes();
  const [tx, ty, k] = useStore((st) => st.transform);
  const drawing = useMemo(() => parseDrawing(doc), [doc]);
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
      {nodes.map((n) => {
        if (n.hidden) return null;
        const s = drawing.byId.get(n.id);
        const r = net.symbols.get(n.id);
        if (!s || !r) return null;
        const fig = vesselFigure(s, r, i, u);
        const word = fig ? null : stateWord(at(r.state, i));
        if (!fig && !word) return null;
        const w = n.measured?.width ?? 40;
        const x = (n.position.x + w) * k + tx + 4;
        const y = n.position.y * k + ty;
        return (
          <div key={n.id} className="absolute whitespace-nowrap rounded px-1 font-mono text-[11px] leading-[16px]"
               style={{ left: x, top: y, color: 'var(--lx-text)', background: 'color-mix(in srgb, var(--lx-surface) 80%, transparent)' }}>
            {fig ? <>{fig.num}<span style={{ color: 'var(--lx-text-3)' }}>{'\u00a0'}{fig.unit}</span></>
              : <span style={{ color: word === 'Open' ? 'var(--lx-ok)' : 'var(--lx-text-3)' }}>{word}</span>}
          </div>
        );
      })}
    </div>
  );
}
