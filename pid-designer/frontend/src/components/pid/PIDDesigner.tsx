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
import { ChangeModal, ReadOnlyProvider, useCheckout, useReadOnly } from '@stardesign-ui';
import { Modal } from '../ui';
import { primaryBtn } from '../../lib/ui';
import * as api from '../../api/diagrams';
import { designApi, keyOf, refOf } from '../../api/diagrams';
import type { DiagramMeta, DocRef, MicroVersion, ReleaseVersion, Snapshot } from '../../api/diagrams';
import { nodeTypes } from './nodes';
import { BranchableEdge } from './BranchableEdge';
import { FLUID_COLORS, COMPONENT_DEFS } from './types';
import type { PIDNodeData, ComponentType, FluidType } from './types';

export type InteractionMode = 'pan' | 'select';

// The diagram/version types and every server call now live in api/diagrams.ts:
// a diagram is addressed as (owner, id) since diagrams are shared, and an
// `?owner=` query parameter cannot be baked into a URL prefix the way the old
// inline `base` string was. Re-exported so existing importers keep working.
export type { DiagramMeta, MicroVersion, ReleaseVersion } from '../../api/diagrams';
export type { Snapshot } from '../../api/diagrams';

// v2 because the remembered diagram is now (owner, id): a shared diagram is not
// identified by its id alone. A v1 value is a bare id, which was always one of
// your own, so it migrates to {owner: null}.
const ACTIVE_KEY = 'pid.activeDiagram.v2';
const LEGACY_ACTIVE_KEY = 'pid.activeDiagramId';

function readActive(): DocRef | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DocRef;
      if (parsed && typeof parsed.id === 'string') return parsed;
    }
    const legacy = localStorage.getItem(LEGACY_ACTIVE_KEY);
    return legacy ? { id: legacy, owner: null } : null;
  } catch {
    return null;
  }
}

function writeActive(ref: DocRef | null): void {
  try {
    if (ref) localStorage.setItem(ACTIVE_KEY, JSON.stringify({ id: ref.id, owner: ref.owner ?? null }));
    else localStorage.removeItem(ACTIVE_KEY);
    localStorage.removeItem(LEGACY_ACTIVE_KEY);
  } catch {
    /* private mode / storage disabled -- the bar still works, it just forgets */
  }
}

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
      // Compare the *authored* diagram, not the raw ReactFlow state: `selected`
      // and friends change on a plain click, so a bare selection used to push an
      // undo entry and cost the user a press of Ctrl+Z to get past.
      const snap: Snapshot = api.toStored({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
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
  diagramRef:         DocRef;
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
  /** Autosave hit a 403: this diagram was unshared while it was open. */
  onForbidden:        () => void;
  /** Autosave hit a 423: the checkout lapsed or was taken. */
  onLockLost:         () => void;
}

function PIDCanvas({
  diagramRef, onInstance, getRef, loadRef, clearRef, undoRef, redoRef,
  releaseRef, getHistoryRef, getReleasesRef, restoreMicroRef, restoreReleaseRef, onForbidden, onLockLost,
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

  const diagramKey = keyOf(diagramRef);
  // Without the checkout the canvas is inert. Every one of these defaults to
  // true, so they have to be turned off explicitly -- and the node renderers
  // read the same flag through context, because TextNode and DraggableLabel
  // edit via useReactFlow().setNodes and never touch these props.
  const readOnly = useReadOnly();
  // JSON of the last payload actually sent, so a change that survives neither
  // `toStored` nor a content comparison never reaches the server. Without it the
  // debounce fires on every ReactFlow state identity change -- including pure
  // selection -- and once checkouts land, a save is what keeps a checkout alive.
  const lastSaved = useRef<string>('');

  // Load the selected diagram's working copy whenever the selection changes.
  useEffect(() => {
    loadedId.current = null;
    let cancelled = false;
    api.loadDiagram(diagramRef)
      .then(data => {
        if (cancelled) return;
        const loaded = { nodes: data?.nodes ?? [], edges: data?.edges ?? [] };
        setNodes(loaded.nodes);
        setEdges(loaded.edges);
        // Seed the guard with what we just loaded, so opening a diagram does not
        // immediately save it straight back.
        lastSaved.current = JSON.stringify(api.toStored(loaded));
        loadedId.current = diagramKey;
      })
      .catch(() => { if (!cancelled) loadedId.current = diagramKey; });
    return () => { cancelled = true; };
  }, [diagramKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced autosave of the working copy — only once the active diagram has
  // actually loaded, so switching never clobbers a diagram with another's data.
  useEffect(() => {
    // No checkout, no autosave. The canvas is inert in that state anyway;
    // this is the belt to that pair of braces.
    if (loadedId.current !== diagramKey || readOnly) return;
    const serialized = JSON.stringify(api.toStored({ nodes, edges }));
    if (serialized === lastSaved.current) return;
    const t = setTimeout(() => {
      lastSaved.current = serialized;
      api.autosaveDiagram(diagramRef, { nodes, edges }).catch((e: unknown) => {
        lastSaved.current = ''; // failed -- let the next change retry
        // 403 means this diagram was unshared from you while you had it open.
        // Retrying is silent and pointless -- tell the parent so it can stop
        // and fall back to one of your own.
        if (e instanceof api.ApiError && e.status === 403) onForbidden();
        // 423: the checkout lapsed and someone else took it. Drop to read-only
        // rather than retry into a void.
        else if (e instanceof api.ApiError && e.status === 423) onLockLost();
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [nodes, edges, diagramKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Best-effort flush to S3 on tab close / hide, so the last few edits land even
  // between the periodic (server-throttled) microversions.
  useEffect(() => {
    const flush = () => {
      // A beacon cannot read a rejection, so gate it here instead.
      if (loadedId.current !== diagramKey || readOnly) return;
      api.flushDiagram(diagramRef, snapshot.current);
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [diagramKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (readOnly) return;
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

  // Each of these rewrites the diagram, and each is reached from the toolbar.
  // The toolbar buttons are disabled without the checkout; these guards are the
  // belt to that pair of braces, and they also cover the keyboard shortcuts.
  getRef.current   = useCallback(() => ({ nodes, edges }), [nodes, edges]);
  loadRef.current  = useCallback((d) => {
    if (readOnly) return;
    setNodes(d.nodes);
    setEdges(d.edges);
  }, [readOnly, setNodes, setEdges]);
  clearRef.current = useCallback(() => {
    if (readOnly) return;
    setNodes([]);
    setEdges([]);
  }, [readOnly, setNodes, setEdges]);
  undoRef.current  = useCallback(() => { if (!readOnly) undo(); }, [readOnly, undo]);
  redoRef.current  = useCallback(() => { if (!readOnly) redo(); }, [readOnly, redo]);

  releaseRef.current = useCallback(
    (label: string) => api.createRelease(diagramRef, label, { nodes, edges }),
    [nodes, edges, diagramKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  getHistoryRef.current = useCallback(
    () => api.getHistory(diagramRef),
    [diagramKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  getReleasesRef.current = useCallback(
    () => api.listReleases(diagramRef),
    [diagramKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  restoreMicroRef.current = useCallback(async (versionId: string) => {
    if (readOnly) return;
    const data = await api.getVersion(diagramRef, versionId);
    setNodes(data.nodes);
    setEdges(data.edges);
  }, [readOnly, diagramKey, setNodes, setEdges]); // eslint-disable-line react-hooks/exhaustive-deps

  restoreReleaseRef.current = useCallback(async (label: string) => {
    if (readOnly) return;
    const data = await api.getRelease(diagramRef, label);
    setNodes(data.nodes);
    setEdges(data.edges);
  }, [readOnly, diagramKey, setNodes, setEdges]); // eslint-disable-line react-hooks/exhaustive-deps

  const onInit = useCallback((inst: ReactFlowInstance) => {
    setRfInst(inst);
    onInstance(inst);
  }, [onInstance]);

  const edgeTypes = useMemo(() => ({ smoothstep: BranchableEdge, default: BranchableEdge }), []);

  const onConnect = useCallback((params: Connection) => {
    if (readOnly) return;
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
    if (readOnly) return;
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
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    setEdgeMenu({ id: edge.id, x: e.clientX, y: e.clientY });
  }, []);

  const setEdgeFluid = useCallback((edgeId: string, fluid: FluidType) => {
    if (readOnly) return; // recolouring an edge is an edit to the diagram
    setEdges(eds => eds.map(e =>
      e.id === edgeId
        ? { ...e, style: { ...e.style, stroke: FLUID_COLORS[fluid], strokeWidth: 2 }, data: { ...e.data, fluidType: fluid } }
        : e,
    ));
    setEdgeMenu(null);
  }, [readOnly, setEdges]);

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
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        edgesReconnectable={!readOnly}
        deleteKeyCode={readOnly ? null : 'Delete'}
        selectionOnDrag={!readOnly && mode === 'select'}
        panOnDrag={readOnly || mode !== 'select'}
        selectionMode={SelectionMode.Partial}
        connectionMode={ConnectionMode.Loose}
        multiSelectionKeyCode="Meta"
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
            <button key={f} disabled={readOnly} onClick={() => setEdgeFluid(edgeMenu.id, f)}
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
  const [activeRef, setActiveRef] = useState<DocRef | null>(null);
  const activeKey = activeRef ? keyOf(activeRef) : null;
  const [ready, setReady] = useState(false);
  const [showChange, setShowChange] = useState(false);
  // Name of a diagram that was unshared out from under us, or null.
  const [unshared, setUnshared] = useState<string | null>(null);

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
        list = await api.listDiagrams();
      } catch { /* offline - fall through to create */ }
      if (list.length === 0) {
        try {
          list = [await api.createDiagram('Untitled')];
        } catch { /* ignore */ }
      }
      const remembered = readActive();
      // Prefer your own diagrams in the fallback: `list` now includes diagrams
      // shared with you, so list[0] could open someone else's on a machine with
      // no remembered choice.
      const match = remembered
        ? list.find(d => keyOf(refOf(d)) === keyOf(remembered))
        : undefined;
      const pick = match ?? list.find(d => d.mine) ?? list[0];
      setDiagrams(list);
      setActiveRef(pick ? refOf(pick) : null);
      if (pick) writeActive(refOf(pick));
      setReady(true);
    })();
  }, []);

  const selectDiagram = useCallback((ref: DocRef) => {
    setActiveRef(ref);
    writeActive(ref);
  }, []);

  /** Adopt a freshly created/copied diagram: it becomes the active one. */
  const adopt = useCallback((meta: DiagramMeta) => {
    setDiagrams(ds => [meta, ...ds]);
    selectDiagram(refOf(meta));
  }, [selectDiagram]);

  const createDiagram = useCallback(async (name: string) => {
    adopt(await api.createDiagram(name));
  }, [adopt]);

  const renameDiagram = useCallback(async (ref: DocRef, name: string) => {
    const meta = await api.renameDiagram(ref, name);
    setDiagrams(ds => ds.map(d => (keyOf(refOf(d)) === keyOf(ref) ? { ...d, ...meta } : d)));
  }, []);

  const shareDiagram = useCallback(async (ref: DocRef, emails: string[]) => {
    const meta = await api.shareDiagram(ref, emails);
    setDiagrams(ds => ds.map(d => (keyOf(refOf(d)) === keyOf(ref) ? { ...d, ...meta } : d)));
  }, []);

  /** Re-list and land on one of your own diagrams. Used after leaving one, and
   *  after being unshared from the one you had open. */
  const reloadAndFallBack = useCallback(async () => {
    const list = await api.listDiagrams();
    setDiagrams(list);
    const next = list.find(d => d.mine) ?? list[0];
    setActiveRef(next ? refOf(next) : null);
    writeActive(next ? refOf(next) : null);
  }, []);

  const leaveDiagram = useCallback(async (ref: DocRef) => {
    await api.leaveDiagram(ref);
    if (activeKey === keyOf(ref)) await reloadAndFallBack();
    else setDiagrams(ds => ds.filter(d => keyOf(refOf(d)) !== keyOf(ref)));
  }, [activeKey, reloadAndFallBack]);

  /** Take a copy of someone else's diagram and open it. The copy is yours, with
   *  no history and no share list -- see the backend. */
  const copyDiagram = useCallback(async (ref: DocRef) => {
    adopt(await api.copyDiagram(ref));
  }, [adopt]);

  // Taking the checkout re-loads the diagram first: sitting in read-only while
  // the holder saved leaves a stale view, and editing from there would
  // overwrite their work on the first autosave. The canvas remounts on
  // `reloadKey`, which is the simplest way to make it re-fetch.
  const [reloadKey, setReloadKey] = useState(0);
  const checkout = useCheckout({
    api: designApi,
    ref: activeRef,
    reload: useCallback(async () => { setReloadKey((n) => n + 1); }, []),
  });

  const onForbidden = useCallback(() => {
    setUnshared(diagrams.find(d => keyOf(refOf(d)) === activeKey)?.name ?? 'This diagram');
    void reloadAndFallBack();
  }, [diagrams, activeKey, reloadAndFallBack]);

  return (
    // Wraps the toolbar too, not just the canvas. Clear, Undo, Redo, Import and
    // the two Restores all rewrite the diagram, and with the provider around
    // only <PIDCanvas> they stayed live for someone who does not hold it -- a
    // viewer could wipe the canvas they were looking at. The diagram bar inside
    // is unaffected: gating is opt-in, and Take / Release must stay live
    // exactly when you do not hold the diagram.
    <ReadOnlyProvider readOnly={!checkout.held}>
    <div className="flex flex-col h-[calc(100vh-56px)] min-h-[600px] rounded-xl overflow-hidden border border-[var(--color-border)]">
      <DiagramBar
        diagrams={diagrams}
        activeKey={activeKey}
        onSelect={selectDiagram}
        onOpenChange={() => setShowChange(true)}
        checkout={checkout}
      />

      {showChange && (
        <ChangeModal
          open={showChange}
          api={designApi}
          noun="diagram"
          onClose={() => setShowChange(false)}
          documents={diagrams}
          activeKey={activeKey}
          onSelect={selectDiagram}
          onCreate={createDiagram}
          onRename={renameDiagram}
          onShare={shareDiagram}
          onLeave={leaveDiagram}
          onCopy={copyDiagram}
        />
      )}

      {/* Someone removed your access while you had the diagram open. Said
          plainly rather than left as a silently failing autosave. */}
      <Modal
        open={unshared !== null}
        onClose={() => setUnshared(null)}
        title="You no longer have access"
        footer={<button onClick={() => setUnshared(null)} className={primaryBtn}>OK</button>}
      >
        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
          "{unshared}" was unshared from you, so it has stopped saving and you have been
          moved to one of your own diagrams. Nothing was deleted - you can still take a
          copy of it from <b>Change → View only</b>.
        </p>
      </Modal>
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
        canVersion={!!activeRef}
        mode={mode}
        onModeChange={setMode}
      />
      <div className="flex flex-1 overflow-hidden">
        <ComponentPalette />
        <ReactFlowProvider>
          {ready && activeRef ? (
            <PIDCanvas
              // Remount on a diagram switch. Keyed on (owner, id), not id alone:
              // two people can own diagrams with the same id, so switching
              // between them would otherwise reuse one canvas's state.
              key={`${activeKey}:${reloadKey}`}
              diagramRef={activeRef}
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
              onForbidden={onForbidden}
              onLockLost={checkout.lost}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-600">
              {ready ? 'Create a diagram to begin.' : 'Loading…'}
            </div>
          )}
        </ReactFlowProvider>
      </div>
    </div>
    </ReadOnlyProvider>
  );
}
