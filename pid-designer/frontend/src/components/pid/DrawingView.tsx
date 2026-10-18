import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import '@xyflow/react/dist/style.css';
import {
  Background, BackgroundVariant, ConnectionMode, Controls, ReactFlow, ReactFlowProvider, applyNodeChanges, useNodesInitialized, useReactFlow,
} from '@xyflow/react';
import type { Edge, Node, NodeChange, NodeMouseHandler } from '@xyflow/react';
import { ReadOnlyProvider } from '@stardesign-ui';
import { nodeTypes } from './nodes';
import { BranchableEdge } from './BranchableEdge';
import { BranchDragProvider } from './BranchDrag';
import { FluidProvider } from './FluidContext';
import { ToolProvider } from './ToolContext';
import { AttachmentLayer, DrawnRoutes } from './AttachmentLayer';
import { VentLayer } from './VentLayer';
import { SignalLayer } from './SignalLayer';
import { PageBar } from './PageBar';
import { migrate } from './migrate';
import { applyPage, listPages, pageOf } from './pages';
import type { PIDNodeData } from './types';

/**
 * A drawing, shown and not edited: the editor's own canvas with every way of
 * changing it turned off.
 *
 * For the apps that show a P&ID without owning it -- feed-twin first. They
 * used to redraw the document in their own SVG, and a redrawing is a second
 * set of symbols that is wrong about everything the editor has learned since:
 * ports, rotation, tees, routing, colour, pages. This is the same symbols, the
 * same router and the same fluid colouring, so a drawing looks here exactly as
 * it does in the editor.
 *
 * It takes the document as pid-designer saves it and puts it through
 * `migrate`, as opening it in the editor does. What the host adds -- live
 * values, say -- goes in `children`, drawn inside the canvas so it pans and
 * zooms with the drawing; `useDrawnRoutes` (edgeGeometry.ts) says where each
 * line is drawn.
 */
export interface DrawingViewProps {
  nodes: Node[];
  edges: Edge[];
  /** React Flow themes its own chrome (controls, background) off this. */
  colorMode?: 'dark' | 'light';
  /** A symbol was clicked. */
  onSymbolClick?: (id: string) => void;
  /** Symbols that take a click, given a pointer cursor. */
  clickable?: ReadonlySet<string>;
  /** The page shown, when the host keeps it (to put up the page a symbol
   *  is on). Absent: the view keeps its own, starting on the first. */
  page?: string;
  /** A page tab was picked. */
  onPageChange?: (page: string) => void;
  children?: ReactNode;
}

const EDGE_TYPES = { smoothstep: BranchableEdge, default: BranchableEdge };
const DEFAULT_EDGE_OPTIONS = { type: 'smoothstep' } as const;
const noop = () => {};

export function DrawingView(props: DrawingViewProps) {
  return (
    <ReactFlowProvider>
      <ReadOnlyProvider readOnly>
        <Sheet {...props} />
      </ReadOnlyProvider>
    </ReactFlowProvider>
  );
}

function Sheet({
  nodes: given, edges: givenEdges, colorMode = 'dark', onSymbolClick, clickable, page: hostPage, onPageChange, children,
}: DrawingViewProps) {
  const doc = useMemo(() => migrate({ nodes: given, edges: givenEdges }), [given, givenEdges]);

  // Kept as state only so React Flow's measurements land on the nodes: the
  // vent arrows and instrument leaders are placed from `measured`.
  const [nodes, setNodes] = useState(doc.nodes);
  useEffect(() => setNodes(doc.nodes), [doc.nodes]);
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const sizes = changes.filter(c => c.type === 'dimensions');
    if (sizes.length) setNodes(ns => applyNodeChanges(sizes, ns));
  }, []);

  const pages = useMemo(() => listPages(doc.nodes), [doc.nodes]);
  const [ownPage, setOwnPage] = useState(pages[0]);
  const page = hostPage ?? ownPage;
  const current = pages.includes(page) ? page : pages[0];
  const setPage = useCallback((p: string) => {
    if (hostPage === undefined) setOwnPage(p);
    onPageChange?.(p);
  }, [hostPage, onPageChange]);

  const shown = useMemo(() => {
    const view = applyPage(nodes, doc.edges, current);
    if (!clickable?.size) return view;
    return {
      ...view,
      nodes: view.nodes.map(n => clickable.has(n.id) ? { ...n, style: { ...n.style, cursor: 'pointer' } } : n),
    };
  }, [nodes, doc.edges, current, clickable]);

  const sheetKey = useMemo(() => [doc.nodes, current], [doc.nodes, current]);

  const onNodeClick = useCallback<NodeMouseHandler>((_, n) => onSymbolClick?.(n.id), [onSymbolClick]);
  const count = useCallback(
    (p: string) => doc.nodes.filter(n => pageOf(n.data as unknown as PIDNodeData) === p).length,
    [doc.nodes]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="relative min-h-0 flex-1">
        <ToolProvider tool="none" onDone={noop}>
          <FluidProvider nodes={doc.nodes} edges={doc.edges}>
            <BranchDragProvider readOnly onDrop={noop}>
              <ReactFlow
                nodes={shown.nodes}
                edges={shown.edges}
                onNodesChange={onNodesChange}
                onNodeClick={onSymbolClick ? onNodeClick : undefined}
                nodeTypes={nodeTypes}
                edgeTypes={EDGE_TYPES}
                defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                edgesReconnectable={false}
                deleteKeyCode={null}
                // A symbol's ports are all one kind, so a line names whichever
                // it is on at either end; as on the editor's canvas.
                connectionMode={ConnectionMode.Loose}
                minZoom={0.1}
                colorMode={colorMode}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-border)" />
                <DrawnRoutes><AttachmentLayer nodes={shown.nodes} edges={shown.edges} /></DrawnRoutes>
                <VentLayer nodes={shown.nodes} edges={shown.edges} />
                <SignalLayer nodes={shown.nodes} edges={shown.edges} />
                <Controls showInteractive={false} />
                <FitOnChange sheet={sheetKey} />
                {children}
              </ReactFlow>
            </BranchDragProvider>
          </FluidProvider>
        </ToolProvider>
      </div>
      {pages.length > 1 && (
        <PageBar
          pages={pages}
          current={current}
          onSelect={setPage}
          onAdd={noop}
          onRename={noop}
          onDuplicate={noop}
          count={count}
          selectedCount={0}
          onMoveSelection={noop}
        />
      )}
    </div>
  );
}

/**
 * A new page, or a new drawing, is a new sheet: show the whole of it, once
 * its symbols are measured. React Flow's own `fitView` fits once, on the first
 * render, before a symbol has a size.
 */
function FitOnChange({ sheet }: { sheet: unknown }) {
  const { fitView } = useReactFlow();
  const ready = useNodesInitialized();
  const fitted = useRef<unknown>(null);
  useEffect(() => {
    if (!ready || fitted.current === sheet) return;
    fitted.current = sheet;
    void fitView();
  }, [ready, sheet, fitView]);
  return null;
}
