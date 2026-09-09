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
  useReactFlow,
  BackgroundVariant,
  SelectionMode,
  ConnectionMode,
  type ReactFlowInstance,
  type Connection,
  type Node,
  type NodeChange,
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
import { nextNodeId, seedIdsFrom } from './ids';
import { defFor } from './types';
import type { PIDNodeData } from './types';
import { ConfigDialog } from './ConfigDialog';
import type { ConfigPatch } from './ConfigDialog';
import { FluidProvider } from './FluidContext';
import { ColorMenu } from './ColorMenu';
import { AttachmentLayer } from './AttachmentLayer';
import { ChecksPanel } from './ChecksPanel';
import { VentLayer } from './VentLayer';
import { PageBar } from './PageBar';
import { DEFAULT_PAGE, applyPage, listPages, moveToPage, pageOf } from './pages';
import { clearOfHost, dragAttached, isInstrument, targetAt } from './attach';
import { COMPONENT_SPECS } from './spec';

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
  const [page, setPage] = useState<string>(DEFAULT_PAGE);
  // Pages people made but have not drawn on yet. Everything else is derived
  // from where the components actually are, so the two cannot disagree.
  const [declaredPages, setDeclaredPages] = useState<string[]>([]);
  const [colorMenu, setColorMenu] =
    useState<{ kind: 'node' | 'edge'; id: string; x: number; y: number } | null>(null);
  // Which symbol or line has its config open. Held as an id rather than the
  // object, so the dialog reads live data and a save is never applied to a
  // stale copy.
  const [configFor, setConfigFor] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  const { screenToFlowPosition, setCenter, getZoom } = useReactFlow();

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
  // Every *guard* below reads the flag through this ref, never through the
  // closure. Taking the checkout used to be a coin flip because of that
  // difference: `take()` reloads the canvas before it flips `held`, so this
  // component remounts while it is still read-only, and each handler captured
  // `readOnly === true` at that moment. Whether it ever got a corrected copy
  // depended on whether an unrelated dependency happened to change afterwards
  // -- `onDrop` was rebuilt when `onInit` set the ReactFlow instance, and won
  // or lost the race against the state commit. Hence "you have to take, release,
  // then take again", and a palette that dropped nothing on a fresh page.
  //
  // A ref cannot go stale, so the guards cannot disagree with the chip in the
  // diagram bar, and a handler added later inherits that for free.
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
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
        seedIdsFrom(loaded.nodes);
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
    if (loadedId.current !== diagramKey || readOnlyRef.current) return;
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
      if (loadedId.current !== diagramKey || readOnlyRef.current) return;
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
      if (readOnlyRef.current) return;
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
    if (readOnlyRef.current) return;
    seedIdsFrom(d.nodes);
    setNodes(d.nodes);
    setEdges(d.edges);
  }, [setNodes, setEdges]);
  clearRef.current = useCallback(() => {
    if (readOnlyRef.current) return;
    setNodes([]);
    setEdges([]);
  }, [setNodes, setEdges]);
  undoRef.current  = useCallback(() => { if (!readOnlyRef.current) undo(); }, [undo]);
  redoRef.current  = useCallback(() => { if (!readOnlyRef.current) redo(); }, [redo]);

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
    if (readOnlyRef.current) return;
    const data = await api.getVersion(diagramRef, versionId);
    seedIdsFrom(data.nodes);
    setNodes(data.nodes);
    setEdges(data.edges);
  }, [diagramKey, setNodes, setEdges]); // eslint-disable-line react-hooks/exhaustive-deps

  restoreReleaseRef.current = useCallback(async (label: string) => {
    if (readOnlyRef.current) return;
    const data = await api.getRelease(diagramRef, label);
    seedIdsFrom(data.nodes);
    setNodes(data.nodes);
    setEdges(data.edges);
  }, [diagramKey, setNodes, setEdges]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handed up so the toolbar can fitView and export. Nothing in this component
  // needs it -- see `screenToFlowPosition` above.
  const onInit = useCallback((inst: ReactFlowInstance) => onInstance(inst), [onInstance]);

  const edgeTypes = useMemo(() => ({ smoothstep: BranchableEdge, default: BranchableEdge }), []);

  const pages = useMemo(() => listPages(nodes, declaredPages), [nodes, declaredPages]);
  // What React Flow renders. `nodes`/`edges` stay the whole diagram, so the
  // checks panel and the fluid walk below see both sides of the umbilical --
  // a pairing check that only looked at the current page would report every
  // correct pair as broken.
  const view = useMemo(() => applyPage(nodes, edges, page), [nodes, edges, page]);
  const selectedHere = useMemo(
    () => nodes.filter(n => n.selected && pageOf(n.data as unknown as PIDNodeData) === page),
    [nodes, page],
  );

  const configSubject = configFor
    ? configFor.kind === 'node'
      ? nodes.find(n => n.id === configFor.id) ?? null
      : edges.find(e => e.id === configFor.id) ?? null
    : null;

  /**
   * The disconnects this one could mate with: every other QD on the drawing,
   * with the opposite half listed first because that is what a pair is.
   */
  const pairPeers = useMemo(() => {
    if (configFor?.kind !== 'node') return undefined;
    const me = nodes.find(n => n.id === configFor.id);
    const meData = me?.data as unknown as PIDNodeData | undefined;
    if (meData?.componentType !== 'QD') return undefined;
    const mySide = meData.options?.side ?? 'ground';
    return nodes
      .filter(n => n.id !== configFor.id
        && (n.data as unknown as PIDNodeData)?.componentType === 'QD')
      .map(n => {
        const d = n.data as unknown as PIDNodeData;
        const side = d.options?.side ?? 'ground';
        return { id: n.id, label: d.label || n.id, hint: side, opposite: side !== mySide };
      })
      .sort((a, b) => Number(b.opposite) - Number(a.opposite))
      .map(({ id, label, hint }) => ({ id, label, hint: `${hint} half` }));
  }, [configFor, nodes]);

  const onConnect = useCallback((params: Connection) => {
    if (readOnlyRef.current) return;
    setEdges(eds => addEdge({
      ...params,
      type: 'smoothstep',
      // No fluid and no colour: both are inherited from whatever ends up
      // feeding this line, and the edge renderer reads them from context.
      data: {},
    }, eds));
  }, [setEdges]);

  /**
   * Drag a component and its instruments come with it.
   *
   * React Flow reports a position change per node without a delta, so the
   * delta is taken from where the node was -- the alternative is `parentId`,
   * which would change what a saved position *means*. See attach.ts.
   */
  const handleNodesChange = useCallback((changes: NodeChange<Node>[]) => {
    const moves: { id: string; delta: { x: number; y: number } }[] = [];
    for (const c of changes) {
      if (c.type !== 'position' || !c.position) continue;
      const before = snapshot.current.nodes.find(n => n.id === c.id);
      if (!before) continue;
      const delta = { x: c.position.x - before.position.x, y: c.position.y - before.position.y };
      if (delta.x || delta.y) moves.push({ id: c.id, delta });
    }
    onNodesChange(changes);
    if (moves.length) {
      setNodes(nds => moves.reduce((acc, m) => dragAttached(acc, m.id, m.delta), nds));
    }
  }, [onNodesChange, setNodes]);

  /** Bring one component into view without changing the zoom people chose. */
  const fitViewTo = useCallback(async (node: Node) => {
    await setCenter(
      node.position.x + (node.measured?.width ?? 60) / 2,
      node.position.y + (node.measured?.height ?? 60) / 2,
      { duration: 300, zoom: getZoom() },
    );
  }, [setCenter, getZoom]);

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    if (readOnlyRef.current) return;
    e.preventDefault();
    const entry = e.dataTransfer.getData('application/pid-entry');
    const def = defFor(entry);
    if (!def) return;
    const type = def.type;
    const nodeH = (type === 'TANK' || type === 'INJECTOR' || type === 'ENGINE') ? 100 : 60;
    // From the provider, not from the `onInit` instance in state. Taking the
    // checkout remounts this canvas, and for the frame or two before `onInit`
    // has committed, that state is null -- so the palette silently dropped
    // nothing during exactly the moment a user has just enabled editing and is
    // reaching for it. The hook is available from first render.
    const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    let position = { x: flowPos.x - 30, y: flowPos.y - nodeH / 2 };
    // An instrument dropped on top of a component or a line measures *that*.
    // No edge, because a probe carries no flow -- see attach.ts.
    const host = isInstrument(type)
      ? targetAt(flowPos, snapshot.current.nodes, snapshot.current.edges)
      : null;
    // Stand the probe clear of what it is measuring. Dropped exactly where the
    // pointer was, it covers the symbol it is attached to -- and the whole
    // point of attaching rather than connecting is that the drawing gets
    // easier to read, not harder.
    if (host) position = clearOfHost(host, position, snapshot.current.nodes, snapshot.current.edges);

    const nodeData = type === 'REGION'
      ? { componentType: type, label: 'Section', page }
      : type === 'TEXT'
      ? { text: 'Text', page }
      : type === 'JUNCTION'
      ? { page }
      : {
          componentType: type,
          label: def.label,
          fluidType: 'default',
          // The palette entry's preset, plus every option's declared default,
          // so a symbol is never drawn in a state its own config disagrees
          // with -- a valve reads NC from the moment it lands, not once
          // somebody opens the dialog.
          options: {
            ...Object.fromEntries((COMPONENT_SPECS[type]?.options ?? []).map(o => [o.key, o.default])),
            ...(def.preset ?? {}),
          },
          // A supply picked from the palette already knows what is in it.
          ...(def.fluid ? { fluid: def.fluid } : {}),
          ...(host ? { attachedTo: host.id } : {}),
          page,
        } as PIDNodeData;
    // Allocated outside the updater: React invokes updaters twice in
    // development, and an id minted inside one is neither pure nor stable.
    const id = nextNodeId();
    setNodes(nds => [...nds, {
      id,
      type,
      position,
      // Behind the components it encloses, so the drawing reads as components
      // in a box rather than a box over components.
      ...(type === 'REGION'
        ? { width: 320, height: 220, zIndex: -1, style: { width: 320, height: 220 } }
        : {}),
      data: nodeData as unknown as Record<string, unknown>,
    }]);
  }, [screenToFlowPosition, setNodes, page]);

  const onNodeDoubleClick = useCallback((_e: React.MouseEvent, node: Node) => {
    const type = (node.data as unknown as PIDNodeData)?.componentType;
    // Text and junctions have nothing to configure; opening an empty dialog on
    // them would only teach people that double-click does nothing.
    if (!type || !COMPONENT_SPECS[type]) return;
    setConfigFor({ kind: 'node', id: node.id });
  }, []);

  // A line is configurable too, and that is the gap that mattered most: an
  // edge carried a colour and nothing else, so its length, bore and roughness
  // -- where most of the pressure drop actually is -- had nowhere to live.
  const onEdgeDoubleClick = useCallback((_e: React.MouseEvent, edge: Edge) => {
    setConfigFor({ kind: 'edge', id: edge.id });
  }, []);

  const saveConfig = useCallback((subject: { kind: 'node' | 'edge'; id: string }, patch: ConfigPatch) => {
    if (readOnlyRef.current) return;
    // `undefined` clears rather than writes: a part number emptied out should
    // leave, not persist as an empty string somebody later has to explain.
    const common = {
      params: patch.params,
      options: patch.options,
      partNumber: patch.partNumber,
    };
    if (subject.kind === 'node') {
      setNodes(nds => nds.map(n => (
        n.id === subject.id
          ? { ...n, data: { ...n.data, ...common, label: patch.label, fluid: patch.fluid } }
          : n
      )));
    } else {
      setEdges(eds => eds.map(e => (
        e.id === subject.id ? { ...e, data: { ...e.data, ...common, lineType: patch.lineType } } : e
      )));
    }
  }, [setNodes, setEdges]);

  const onEdgeContextMenu = useCallback((e: React.MouseEvent, edge: Edge) => {
    if (readOnlyRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    setColorMenu({ kind: 'edge', id: edge.id, x: e.clientX, y: e.clientY });
  }, []);

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    if (readOnlyRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    setColorMenu({ kind: 'node', id: node.id, x: e.clientX, y: e.clientY });
  }, []);

  const setColor = useCallback((
    subject: { kind: 'node' | 'edge'; id: string },
    color: string | undefined,
  ) => {
    if (readOnlyRef.current) return;
    const apply = <T extends { id: string; data?: Record<string, unknown> }>(x: T) =>
      x.id === subject.id ? { ...x, data: { ...x.data, color } } : x;
    if (subject.kind === 'node') setNodes(nds => nds.map(apply));
    else setEdges(eds => eds.map(apply));
  }, [setNodes, setEdges]);


  return (
    // Column, so the page tabs sit under the canvas rather than over it. The
    // relative is for the checks badge and the colour menu, which are placed
    // against the whole area including the tabs.
    <div className="relative flex h-full flex-1 flex-col" onClick={() => setColorMenu(null)}>
      <div className="relative min-h-0 flex-1">
      <FluidProvider nodes={nodes} edges={edges}>
      <ReactFlow
        nodes={view.nodes} edges={view.edges}
        onNodesChange={handleNodesChange} onEdgesChange={onEdgesChange}
        onConnect={onConnect} onInit={onInit}
        onDrop={onDrop} onDragOver={onDragOver}
        onEdgeContextMenu={onEdgeContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeDoubleClick={onEdgeDoubleClick}
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
        defaultEdgeOptions={{ type: 'smoothstep' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1e293b" />
        <AttachmentLayer nodes={nodes} edges={edges} />
        <VentLayer nodes={view.nodes} edges={view.edges} />
        <Controls />
        <Panel position="bottom-center">
          <span className="text-[10px] text-slate-600 select-none">
            Drag from sidebar · Connect handles · V=Pan  B=Box select · Cmd+click to multi-select · R=Rotate · Double-click to configure · Right-click to colour · Delete removes selection
          </span>
        </Panel>
      </ReactFlow>
      </FluidProvider>
      </div>

      <PageBar
        pages={pages}
        current={page}
        count={(p) => nodes.filter(n => pageOf(n.data as unknown as PIDNodeData) === p).length}
        onSelect={setPage}
        // Scoped by page, not by the `hidden` flag: that flag lives on the
        // rendered view, so counting it here would offer to move a selection
        // made on a page you have since left.
        selectedCount={selectedHere.length}
        onMoveSelection={(to) => {
          if (readOnlyRef.current || selectedHere.length === 0) return;
          const ids = new Set(selectedHere.map(n => n.id));
          setNodes(nds => moveToPage(nds, ids, to));
        }}
        onAdd={(name) => { setDeclaredPages(ps => [...ps, name]); setPage(name); }}
        onRename={(from, to) => {
          if (readOnlyRef.current || pages.includes(to)) return;
          setNodes(nds => nds.map(n =>
            pageOf(n.data as unknown as PIDNodeData) === from
              ? { ...n, data: { ...n.data, page: to } } : n));
          setDeclaredPages(ps => ps.map(x => (x === from ? to : x)));
          setPage(cur => (cur === from ? to : cur));
        }}
      />

      {configSubject && configFor && (
        <ConfigDialog
          open
          kind={configFor.kind}
          data={configSubject.data as unknown as PIDNodeData}
          peers={pairPeers}
          readOnly={readOnly}
          onClose={() => setConfigFor(null)}
          onSave={patch => saveConfig(configFor, patch)}
        />
      )}

      {/* Selecting from a finding is how "PT-4 has no range" becomes useful:
          it puts PT-4 in front of you rather than leaving you to find it. */}
      <ChecksPanel
        nodes={nodes}
        edges={edges}
        onSelect={(nodeIds, edgeIds) => {
          const ns = new Set(nodeIds);
          const es = new Set(edgeIds);
          setNodes(nds => nds.map(n => ({ ...n, selected: ns.has(n.id) })));
          setEdges(eds => eds.map(e => ({ ...e, selected: es.has(e.id) })));
          const first = nodes.find(n => ns.has(n.id));
          if (first) void fitViewTo(first);
        }}
      />

      {colorMenu && (
        <ColorMenu
          x={colorMenu.x}
          y={colorMenu.y}
          current={
            (colorMenu.kind === 'node'
              ? nodes.find(n => n.id === colorMenu.id)?.data
              : edges.find(e => e.id === colorMenu.id)?.data
            )?.color as string | undefined
          }
          onPick={hex => setColor(colorMenu, hex)}
          onClear={() => setColor(colorMenu, undefined)}
          onClose={() => setColorMenu(null)}
        />
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--color-border)]">
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
