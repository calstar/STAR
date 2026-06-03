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
import { nodeTypes } from './nodes';
import { BranchableEdge } from './BranchableEdge';
import { FLUID_COLORS, COMPONENT_DEFS } from './types';
import type { PIDNodeData, ComponentType, FluidType } from './types';

export type InteractionMode = 'pan' | 'select';

export interface VersionEntry {
  hash: string;
  title: string;
  timestamp: string;
}

let _idCounter = 1;
const genId = () => `node_${_idCounter++}`;

function defaultLabel(type: ComponentType) {
  return COMPONENT_DEFS.find(d => d.type === type)?.label ?? type;
}

// ── Undo / redo history ──────────────────────────────────────────────────────
const MAX_HISTORY = 100;

type Snapshot = { nodes: Node[]; edges: Edge[] };

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
  onInstance:        (inst: ReactFlowInstance) => void;
  getRef:            React.MutableRefObject<() => Snapshot>;
  loadRef:           React.MutableRefObject<(d: Snapshot) => void>;
  clearRef:          React.MutableRefObject<() => void>;
  undoRef:           React.MutableRefObject<() => void>;
  redoRef:           React.MutableRefObject<() => void>;
  checkpointRef:     React.MutableRefObject<(title: string, desc: string) => Promise<{ ok: boolean; commit: string }>>;
  getLatestRef:      React.MutableRefObject<() => Promise<void>>;
  getHistoryRef:     React.MutableRefObject<() => Promise<VersionEntry[]>>;
  restoreVersionRef: React.MutableRefObject<(hash: string) => Promise<void>>;
  mode:              InteractionMode;
}

function PIDCanvas({
  onInstance, getRef, loadRef, clearRef, undoRef, redoRef,
  checkpointRef, getLatestRef, getHistoryRef, restoreVersionRef,
  mode,
}: CanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [edgeMenu, setEdgeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [rfInst, setRfInst] = useState<ReactFlowInstance | null>(null);

  const { undo, redo } = useHistory(nodes, edges, setNodes, setEdges);

  useEffect(() => {
    fetch('/api/pid/load')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.nodes && data?.edges) {
          setNodes(data.nodes);
          setEdges(data.edges);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(() => {
      fetch('/api/pid/autosave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodes, edges }),
      }).catch(() => {});
    }, 1000);
    return () => clearTimeout(t);
  }, [nodes, edges]);

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

  checkpointRef.current = useCallback(async (title: string, description: string) => {
    const res = await fetch('/api/pid/checkpoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes, edges, title, description }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { detail?: string }).detail || 'Checkpoint failed');
    }
    return res.json() as Promise<{ ok: boolean; commit: string }>;
  }, [nodes, edges]);

  getLatestRef.current = useCallback(async () => {
    const res = await fetch('/api/pid/pull', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { detail?: string }).detail || 'Pull failed');
    }
    const data = await res.json() as { nodes: Node[]; edges: Edge[] };
    setNodes(data.nodes);
    setEdges(data.edges);
  }, [setNodes, setEdges]);

  getHistoryRef.current = useCallback(async () => {
    const res = await fetch('/api/pid/history');
    if (!res.ok) throw new Error('Failed to load history');
    return res.json() as Promise<VersionEntry[]>;
  }, []);

  restoreVersionRef.current = useCallback(async (hash: string) => {
    const res = await fetch(`/api/pid/version/${hash}`);
    if (!res.ok) throw new Error('Version not found');
    const data = await res.json() as { nodes: Node[]; edges: Edge[] };
    setNodes(data.nodes);
    setEdges(data.edges);
  }, [setNodes, setEdges]);

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

  const getRef            = useRef<() => Snapshot>(() => ({ nodes: [], edges: [] }));
  const loadRef           = useRef<(d: Snapshot) => void>(() => {});
  const clearRef          = useRef<() => void>(() => {});
  const undoRef           = useRef<() => void>(() => {});
  const redoRef           = useRef<() => void>(() => {});
  const checkpointRef     = useRef<(title: string, desc: string) => Promise<{ ok: boolean; commit: string }>>(() => Promise.resolve({ ok: false, commit: '' }));
  const getLatestRef      = useRef<() => Promise<void>>(() => Promise.resolve());
  const getHistoryRef     = useRef<() => Promise<VersionEntry[]>>(() => Promise.resolve([]));
  const restoreVersionRef = useRef<(hash: string) => Promise<void>>(() => Promise.resolve());

  const handleInstance = useCallback((inst: ReactFlowInstance) => setRfInstance(inst), []);

  return (
    <div className="flex flex-col h-[calc(100vh-56px)] min-h-[600px] rounded-xl overflow-hidden border border-[#1e293b]">
      <PIDToolbar
        rfInstance={rfInstance}
        getSnapshot={() => getRef.current()}
        loadSnapshot={d => loadRef.current(d)}
        onClear={() => clearRef.current()}
        onUndo={() => undoRef.current()}
        onRedo={() => redoRef.current()}
        onCheckpoint={(title, desc) => checkpointRef.current(title, desc)}
        onGetLatest={() => getLatestRef.current()}
        onGetHistory={() => getHistoryRef.current()}
        onRestoreVersion={hash => restoreVersionRef.current(hash)}
        mode={mode}
        onModeChange={setMode}
      />
      <div className="flex flex-1 overflow-hidden">
        <ComponentPalette />
        <ReactFlowProvider>
          <PIDCanvas
            onInstance={handleInstance}
            getRef={getRef}
            loadRef={loadRef}
            clearRef={clearRef}
            undoRef={undoRef}
            redoRef={redoRef}
            checkpointRef={checkpointRef}
            getLatestRef={getLatestRef}
            getHistoryRef={getHistoryRef}
            restoreVersionRef={restoreVersionRef}
            mode={mode}
          />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
