import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlowProvider,
  ReactFlow,
  Background,
  Controls,
  Panel,
  addEdge,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  SelectionMode,
  ConnectionMode,
  type ReactFlowInstance,
  type Connection,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { ComponentPalette } from './ComponentPalette';
import { PIDToolbar } from './PIDToolbar';
import { DiagramBar } from './DiagramBar';
import { nodeTypes } from './nodes';
import { BranchableEdge } from './BranchableEdge';
import { FLUID_COLORS, COMPONENT_DEFS } from './types';
import type { PIDNodeData, ComponentType, FluidType } from './types';

export type InteractionMode = 'pan' | 'select';

export type Snapshot = { nodes: Node[]; edges: Edge[] };

/** One of the user's diagrams (metadata; the geometry lives in current.json). */
export interface DiagramMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** An automatic point-in-time snapshot in S3 (bucket-versioned). */
export interface MicroVersion {
  versionId: string;
  savedAt: string;
  size: number;
}

/** An explicit, immutable, user-named milestone. */
export interface ReleaseVersion {
  label: string;
  savedAt: string;
  size: number;
}

const ACTIVE_KEY = 'pid.activeDiagramId';

let _idCounter = 1;
const genId = () => `node_${_idCounter++}`;

function defaultLabel(type: ComponentType) {
  return COMPONENT_DEFS.find(d => d.type === type)?.label ?? type;
}

// ── Undo / redo history ──────────────────────────────────────────────────────
const MAX_HISTORY = 100;

function useHistory(
  nodes: Node[],
  edges: Edge[],
  setNodes: (nds: Node[]) => void,
  setEdges: (eds: Edge[]) => void,
) {
  const history   = useRef<Snapshot[]>([{ nodes: [], edges: [] }]);
  const index     = useRef(0);
  const restoring = useRef(false);
  const timer     = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (restoring.current) { restoring.current = false; return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const snap: Snapshot = { nodes: structuredClone(nodes), edges: structuredClone(edges) };
      const prev = history.current[index.current];
      if (JSON.stringify(prev) === JSON.stringify(snap)) return;
      history.current = history.current.slice(0, index.current + 1);
      history.current.push(snap);
      if (history.current.length > MAX_HISTORY) history.current.shift();
      index.current = history.current.length - 1;
    }, 300);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [nodes, edges]);

  const undo = useCallback(() => {
    if (index.current <= 0) return;
    index.current -= 1;
    restoring.current = true;
    const snap = history.current[index.current];
    setNodes(structuredClone(snap.nodes));
    setEdges(structuredClone(snap.edges));
  }, [setNodes, setEdges]);

  const redo = useCallback(() => {
    if (index.current >= history.current.length - 1) return;
    index.current += 1;
    restoring.current = true;
    const snap = history.current[index.current];
    setNodes(structuredClone(snap.nodes));
    setEdges(structuredClone(snap.edges));
  }, [setNodes, setEdges]);

  return { undo, redo };
}

// ── Inner canvas ─────────────────────────────────────────────────────────────
interface CanvasProps {
  diagramId:          string;
  onInstance:         (inst: ReactFlowInstance) => void;
  getRef:             React.MutableRefObject<() => Snapshot>;
  loadRef:            React.MutableRefObject<(d: Snapshot) => void>;
  clearRef:           React.MutableRefObject<() => void>;
  undoRef:            React.MutableRefObject<() => void>;
  redoRef:            React.MutableRefObject<() => void>;
  releaseRef:         React.MutableRefObject<(label: string) => Promise<{ label: string; savedAt: string }>>;
  getHistoryRef:      React.MutableRefObject<() => Promise<MicroVersion[]>>;
  getReleasesRef:     React.MutableRefObject<() => Promise<ReleaseVersion[]>>;
  restoreMicroRef:    React.MutableRefObject<(versionId: string) => Promise<void>>;
  restoreReleaseRef:  React.MutableRefObject<(label: string) => Promise<void>>;
  mode:               InteractionMode;
}

function PIDCanvas({
  diagramId, onInstance, getRef, loadRef, clearRef, undoRef, redoRef,
  releaseRef, getHistoryRef, getReleasesRef, restoreMicroRef, restoreReleaseRef,
  mode,
}: CanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [edgeMenu, setEdgeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [rfInst, setRfInst] = useState<ReactFlowInstance | null>(null);

  const { undo, redo } = useHistory(nodes, edges, setNodes, setEdges);

  // Which diagram the current nodes/edges belong to. Guards autosave from writing
  // the previous diagram's geometry into the newly-selected one before it loads.
  const loadedId  = useRef<string | null>(null);
  const snapshot  = useRef<Snapshot>({ nodes: [], edges: [] });
  snapshot.current = { nodes, edges };

  const base = `/api/pid/diagrams/${encodeURIComponent(diagramId)}`;

  // Load the selected diagram's working copy whenever the selection changes.
  useEffect(() => {
    loadedId.current = null;
    let cancelled = false;
    fetch(`${base}/load`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled) return;
        setNodes(data?.nodes ?? []);
        setEdges(data?.edges ?? []);
        loadedId.current = diagramId;
      })
      .catch(() => { if (!cancelled) loadedId.current = diagramId; });
    return () => { cancelled = true; };
  }, [diagramId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced autosave of the working copy — only once the active diagram has
  // actually loaded, so switching never clobbers a diagram with another's data.
  useEffect(() => {
    if (loadedId.current !== diagramId) return;
    const t = setTimeout(() => {
      fetch(`${base}/autosave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodes, edges }),
      }).catch(() => {});
    }, 1000);
    return () => clearTimeout(t);
  }, [nodes, edges, diagramId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Best-effort flush to S3 on tab close / hide, so the last few edits land even
  // between the periodic (server-throttled) microversions.
  useEffect(() => {
    const flush = () => {
      if (loadedId.current !== diagramId) return;
      const body = JSON.stringify(snapshot.current);
      navigator.sendBeacon(`${base}/flush`, new Blob([body], { type: 'application/json' }));
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [diagramId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        setNodes(nds => nds.map(n =>
          n.selected
            ? { ...n, data: { ...n.data, rotation: (((n.data as Record<string, unknown>).rotation as number ?? 0) + 90) % 360 } }
            : n,
        ));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setNodes]);

  getRef.current   = useCallback(() => ({ nodes, edges }), [nodes, edges]);
  loadRef.current  = useCallback((d) => { setNodes(d.nodes); setEdges(d.edges); }, [setNodes, setEdges]);
  clearRef.current = useCallback(() => { setNodes([]); setEdges([]); }, [setNodes, setEdges]);
  undoRef.current  = undo;
  redoRef.current  = redo;

  releaseRef.current = useCallback(async (label: string) => {
    const res = await fetch(`${base}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, nodes, edges }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { detail?: string }).detail || 'Release failed');
    }
    return res.json() as Promise<{ label: string; savedAt: string }>;
  }, [nodes, edges, base]);

  getHistoryRef.current = useCallback(async () => {
    const res = await fetch(`${base}/history`);
    if (!res.ok) throw new Error('Failed to load history');
    return res.json() as Promise<MicroVersion[]>;
  }, [base]);

  getReleasesRef.current = useCallback(async () => {
    const res = await fetch(`${base}/releases`);
    if (!res.ok) throw new Error('Failed to load releases');
    return res.json() as Promise<ReleaseVersion[]>;
  }, [base]);

  restoreMicroRef.current = useCallback(async (versionId: string) => {
    const res = await fetch(`${base}/version/${encodeURIComponent(versionId)}`);
    if (!res.ok) throw new Error('Version not found');
    const data = await res.json() as Snapshot;
    setNodes(data.nodes);
    setEdges(data.edges);
  }, [base, setNodes, setEdges]);

  restoreReleaseRef.current = useCallback(async (label: string) => {
    const res = await fetch(`${base}/release/${encodeURIComponent(label)}`);
    if (!res.ok) throw new Error('Release not found');
    const data = await res.json() as Snapshot;
    setNodes(data.nodes);
    setEdges(data.edges);
  }, [base, setNodes, setEdges]);

  const onInit = useCallback((inst: ReactFlowInstance) => {
    setRfInst(inst);
    onInstance(inst);
  }, [onInstance]);

  const edgeTypes = useMemo(() => ({ smoothstep: BranchableEdge, default: BranchableEdge }), []);

  const onConnect = useCallback((params: Connection) => {
    setEdges(eds => addEdge({
      ...params,
      type: 'smoothstep',
      style: { stroke: FLUID_COLORS.default, strokeWidth: 2 },
      data: { fluidType: 'default' as FluidType },
    }, eds));
  }, [setEdges]);

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/pid-type') as ComponentType;
    if (!type || !rfInst) return;
    const nodeH = (type === 'TANK' || type === 'INJECTOR') ? 100 : 60;
    const flowPos = rfInst.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const position = { x: flowPos.x - 30, y: flowPos.y - nodeH / 2 };
    const nodeData = type === 'TEXT'
      ? { text: 'Text' }
      : type === 'JUNCTION'
      ? {}
      : { componentType: type, label: defaultLabel(type), fluidType: 'default' } as PIDNodeData;
    setNodes(nds => [...nds, {
      id: genId(),
      type,
      position,
      data: nodeData as unknown as Record<string, unknown>,
    }]);
  }, [rfInst, setNodes]);

  const onEdgeContextMenu = useCallback((e: React.MouseEvent, edge: Edge) => {
    e.preventDefault();
    e.stopPropagation();
    setEdgeMenu({ id: edge.id, x: e.clientX, y: e.clientY });
  }, []);

  const setEdgeFluid = useCallback((edgeId: string, fluid: FluidType) => {
    setEdges(eds => eds.map(e =>
      e.id === edgeId
        ? { ...e, style: { ...e.style, stroke: FLUID_COLORS[fluid], strokeWidth: 2 }, data: { ...e.data, fluidType: fluid } }
        : e,
    ));
    setEdgeMenu(null);
  }, [setEdges]);

  // Suppress unused warning — rfInst used for onInit side-effect
  void rfInst;

  return (
    <div className="flex-1 h-full relative" onClick={() => setEdgeMenu(null)}>
      <ReactFlow
        nodes={nodes} edges={edges}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onConnect={onConnect} onInit={onInit}
        onDrop={onDrop} onDragOver={onDragOver}
        onEdgeContextMenu={onEdgeContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        selectionOnDrag={mode === 'select'}
        panOnDrag={mode !== 'select'}
        selectionMode={SelectionMode.Partial}
        connectionMode={ConnectionMode.Loose}
        multiSelectionKeyCode="Meta"
        deleteKeyCode="Delete"
        snapToGrid
        snapGrid={[20, 20]}
        fitView
        colorMode="dark"
        defaultEdgeOptions={{ type: 'smoothstep', style: { stroke: FLUID_COLORS.default, strokeWidth: 2 } }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1e293b" />
        <Controls />
        <Panel position="bottom-center">
          <span className="text-[10px] text-slate-600 select-none">
            Drag from sidebar · Connect handles · V=Pan  B=Box select · Cmd+click to multi-select · R=Rotate · Right-click pipe for fluid · Delete removes selection
          </span>
        </Panel>
      </ReactFlow>

      {edgeMenu && (
        <div
          style={{ position: 'fixed', left: edgeMenu.x, top: edgeMenu.y, zIndex: 9999 }}
          className="bg-[#1e293b] border border-[#334155] rounded-lg shadow-xl py-1 min-w-[140px]"
          onClick={e => e.stopPropagation()}
        >
          <p className="text-[10px] text-slate-500 px-3 py-1 uppercase tracking-wider">Fluid type</p>
          {(['fuel', 'lox', 'pressurant', 'default'] as FluidType[]).map(f => (
            <button key={f} onClick={() => setEdgeFluid(edgeMenu.id, f)}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-300 hover:bg-[#0f172a] transition-colors">
              <span className="inline-block w-3 h-3 rounded-full" style={{ background: FLUID_COLORS[f] }} />
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Top-level designer ────────────────────────────────────────────────────────
export function PIDDesigner() {
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);
  const [mode, setMode] = useState<InteractionMode>('pan');

  const [diagrams, setDiagrams] = useState<DiagramMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const getRef            = useRef<() => Snapshot>(() => ({ nodes: [], edges: [] }));
  const loadRef           = useRef<(d: Snapshot) => void>(() => {});
  const clearRef          = useRef<() => void>(() => {});
  const undoRef           = useRef<() => void>(() => {});
  const redoRef           = useRef<() => void>(() => {});
  const releaseRef        = useRef<(label: string) => Promise<{ label: string; savedAt: string }>>(() => Promise.resolve({ label: '', savedAt: '' }));
  const getHistoryRef     = useRef<() => Promise<MicroVersion[]>>(() => Promise.resolve([]));
  const getReleasesRef    = useRef<() => Promise<ReleaseVersion[]>>(() => Promise.resolve([]));
  const restoreMicroRef   = useRef<(versionId: string) => Promise<void>>(() => Promise.resolve());
  const restoreReleaseRef = useRef<(label: string) => Promise<void>>(() => Promise.resolve());

  const handleInstance = useCallback((inst: ReactFlowInstance) => setRfInstance(inst), []);

  // Load the user's diagram list once; create a first one if they have none.
  useEffect(() => {
    (async () => {
      let list: DiagramMeta[] = [];
      try {
        const res = await fetch('/api/pid/diagrams');
        if (res.ok) list = await res.json();
      } catch { /* offline — fall through to create */ }
      if (list.length === 0) {
        try {
          const res = await fetch('/api/pid/diagrams', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Untitled' }),
          });
          if (res.ok) list = [await res.json()];
        } catch { /* ignore */ }
      }
      const stored = localStorage.getItem(ACTIVE_KEY);
      const initial = list.find(d => d.id === stored)?.id ?? list[0]?.id ?? null;
      setDiagrams(list);
      setActiveId(initial);
      setReady(true);
    })();
  }, []);

  const selectDiagram = useCallback((id: string) => {
    setActiveId(id);
    localStorage.setItem(ACTIVE_KEY, id);
  }, []);

  const createDiagram = useCallback(async (name: string) => {
    const res = await fetch('/api/pid/diagrams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return;
    const meta = await res.json() as DiagramMeta;
    setDiagrams(ds => [meta, ...ds]);
    selectDiagram(meta.id);
  }, [selectDiagram]);

  const renameDiagram = useCallback(async (id: string, name: string) => {
    const res = await fetch(`/api/pid/diagrams/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return;
    const meta = await res.json() as DiagramMeta;
    setDiagrams(ds => ds.map(d => d.id === id ? meta : d));
  }, []);

  const deleteDiagram = useCallback(async (id: string) => {
    const res = await fetch(`/api/pid/diagrams/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) return;
    setDiagrams(ds => {
      const next = ds.filter(d => d.id !== id);
      if (activeId === id) {
        const fallback = next[0]?.id ?? null;
        setActiveId(fallback);
        if (fallback) localStorage.setItem(ACTIVE_KEY, fallback); else localStorage.removeItem(ACTIVE_KEY);
      }
      return next;
    });
  }, [activeId]);

  return (
    <div className="flex flex-col h-[calc(100vh-56px)] min-h-[600px] rounded-xl overflow-hidden border border-[#1e293b]">
      <DiagramBar
        diagrams={diagrams}
        activeId={activeId}
        onSelect={selectDiagram}
        onCreate={createDiagram}
        onRename={renameDiagram}
        onDelete={deleteDiagram}
      />
      <PIDToolbar
        rfInstance={rfInstance}
        getSnapshot={() => getRef.current()}
        loadSnapshot={d => loadRef.current(d)}
        onClear={() => clearRef.current()}
        onUndo={() => undoRef.current()}
        onRedo={() => redoRef.current()}
        onRelease={label => releaseRef.current(label)}
        onGetHistory={() => getHistoryRef.current()}
        onGetReleases={() => getReleasesRef.current()}
        onRestoreMicro={versionId => restoreMicroRef.current(versionId)}
        onRestoreRelease={label => restoreReleaseRef.current(label)}
        canVersion={!!activeId}
        mode={mode}
        onModeChange={setMode}
      />
      <div className="flex flex-1 overflow-hidden">
        <ComponentPalette />
        <ReactFlowProvider>
          {ready && activeId ? (
            <PIDCanvas
              key={activeId}
              diagramId={activeId}
              onInstance={handleInstance}
              getRef={getRef}
              loadRef={loadRef}
              clearRef={clearRef}
              undoRef={undoRef}
              redoRef={redoRef}
              releaseRef={releaseRef}
              getHistoryRef={getHistoryRef}
              getReleasesRef={getReleasesRef}
              restoreMicroRef={restoreMicroRef}
              restoreReleaseRef={restoreReleaseRef}
              mode={mode}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-600">
              {ready ? 'Create a diagram to begin.' : 'Loading…'}
            </div>
          )}
        </ReactFlowProvider>
      </div>
    </div>
  );
}
