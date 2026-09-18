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
  useNodesInitialized,
  type Viewport,
  applyNodeChanges,
  BackgroundVariant,
  SelectionMode,
  ConnectionMode,
  type Connection,
  type Node,
  type NodeChange,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { ComponentPalette } from './ComponentPalette';
import { PIDToolbar } from './PIDToolbar';
import { DiagramBar } from './DiagramBar';
import { ChangeModal, ReadOnlyProvider, isLocalHost, useCheckout, useReadOnly } from '@stardesign-ui';
import { Modal } from '../ui';
import { primaryBtn } from '../../lib/ui';
import { applyTheme, getInitialTheme, type Theme } from '../../lib/theme';
import * as api from '../../api/diagrams';
import { designApi, keyOf, refOf } from '../../api/diagrams';
import type { DiagramMeta, DocRef, MicroVersion, ReleaseVersion, Snapshot } from '../../api/diagrams';
import { nodeTypes } from './nodes';
import { BranchableEdge } from './BranchableEdge';
import { nextNodeId, seedIdsFrom } from './ids';
import { defFor } from './types';
import type { PIDNodeData } from './types';
import { numberTag } from './tags';
import { migrate } from './migrate';
import { copySelection, pasteClip } from './clipboard';
import type { Clip } from './clipboard';
import { TitleBlock } from './TitleBlock';
import type { SheetMeta } from './exportImage';
import { ConfigDialog } from './ConfigDialog';
import type { ConfigPatch } from './ConfigDialog';
import { FluidProvider } from './FluidContext';
import { ColorMenu } from './ColorMenu';
import { PaintTool } from './PaintTool';
import { ToolProvider } from './ToolContext';
import type { Tool } from './ToolContext';
import { AttachmentLayer } from './AttachmentLayer';
import { ChecksPanel } from './ChecksPanel';
import { VentLayer } from './VentLayer';
import { PageBar } from './PageBar';
import { DEFAULT_PAGE, applyPage, listPages, moveToPage, pageOf } from './pages';
import { clearOfHost, dragAttached, isInstrument, isTapped, targetAt } from './attach';
import { rejoinAfterDelete, splitEdgeAt } from './splitEdge';
import { drawnLines, lineAt } from './lineHit';
import { alignmentShift } from './snap';
import type { PortPositions } from './snap';
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


/**
 * The placement grid.
 *
 * Ten, not twenty. A symbol is 60 wide and its ports sit at 0, 30 and 60
 * across it, so on a 20 grid a tank's centre port and a valve's side port can
 * never land on the same line -- the offset between them is always an odd
 * multiple of ten. Halving it is what makes stacking two symbols and getting a
 * straight line between them possible at all.
 */
const SNAP: [number, number] = [10, 10];

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
  fitRef:             React.MutableRefObject<() => void>;
  /** Which page is being looked at. Above the canvas, because the canvas
   *  remounts on Take -- and being thrown back to Main by the gesture that
   *  means "let me edit this" is the same papercut as losing the viewport. */
  page:               string;
  setPage:            React.Dispatch<React.SetStateAction<string>>;
  /** Pages somebody made but has not drawn on yet. Everything else is derived
   *  from where the components are, so the two cannot disagree. Up here for
   *  the same reason: an empty page must survive a Take. */
  declaredPages:      string[];
  setDeclaredPages:   React.Dispatch<React.SetStateAction<string[]>>;
  /**
   * Where the reader was looking, per diagram and page.
   *
   * Lives above the canvas because the canvas remounts whenever the checkout
   * changes: without it, the gesture that means "I would like to edit this"
   * dropped them back at the origin at 1:1, moving the drawing out from under
   * the thing they were about to edit.
   *
   * Per *page* because pages are separate sheets. A page nobody has looked at
   * yet has no entry, and that absence is what asks for it to be framed --
   * which is also how a freshly opened diagram gets framed, with no special
   * case for it.
   */
  viewportsRef:       React.MutableRefObject<Map<string, Viewport>>;
  getRef:             React.MutableRefObject<() => Snapshot>;
  loadRef:            React.MutableRefObject<(d: Snapshot) => void>;
  clearRef:           React.MutableRefObject<() => void>;
  clearCountRef:      React.MutableRefObject<() => { page: string; nodes: number; edges: number }>;
  undoRef:            React.MutableRefObject<() => void>;
  redoRef:            React.MutableRefObject<() => void>;
  releaseRef:         React.MutableRefObject<(label: string) => Promise<{ label: string; savedAt: string }>>;
  getHistoryRef:      React.MutableRefObject<() => Promise<MicroVersion[]>>;
  getReleasesRef:     React.MutableRefObject<() => Promise<ReleaseVersion[]>>;
  restoreMicroRef:    React.MutableRefObject<(versionId: string) => Promise<void>>;
  restoreReleaseRef:  React.MutableRefObject<(label: string) => Promise<void>>;
  mode:               InteractionMode;
  /** What the title block says: the drawing's name and its latest release. */
  sheet:              Omit<SheetMeta, 'page'>;
  /** Autosave hit a 403: this diagram was unshared while it was open. */
  onForbidden:        () => void;
  /** Autosave hit a 423: the checkout lapsed or was taken. */
  onLockLost:         () => void;
  /** React Flow themes its own chrome (handles, selection, controls) off
   *  this -- it does not read the CSS variables above on its own. */
  theme:              Theme;
}

function PIDCanvas({
  diagramRef, fitRef, viewportsRef, page, setPage, declaredPages, setDeclaredPages, getRef, loadRef, clearRef, clearCountRef, undoRef, redoRef,
  releaseRef, getHistoryRef, getReleasesRef, restoreMicroRef, restoreReleaseRef, onForbidden, onLockLost,
  mode, sheet, theme,
}: CanvasProps) {
  // `onNodesChange` is deliberately unused: `handleNodesChange` below applies
  // the changes itself so it can move clipped instruments in the same update.
  const [nodes, setNodes] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Which tool is armed, and the paint colour it uses. One at a time: two
  // tools both claiming a click is how junctions ended up scattered across
  // drawings in the first place.
  const [tool, setTool] = useState<Tool>('none');
  const [colour, setColour] = useState<string | null>('#22c55e');
  const paintRef = useRef({ on: false, colour });
  paintRef.current = { on: tool === 'paint', colour };
  const toolRef = useRef(tool);
  toolRef.current = tool;

  // Read inside `clearRef`, which is called through a ref from the toolbar and
  // would otherwise close over whichever page was current when it was built.
  const pageRef = useRef(page);
  pageRef.current = page;
  const [colorMenu, setColorMenu] =
    useState<{ kind: 'node' | 'edge'; id: string; x: number; y: number } | null>(null);
  // Which symbol or line has its config open. Held as an id rather than the
  // object, so the dialog reads live data and a save is never applied to a
  // stale copy.
  const [configFor, setConfigFor] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  const { screenToFlowPosition, setCenter, getZoom, fitView, setViewport, getInternalNode } = useReactFlow();

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
        const loaded = migrate({ nodes: data?.nodes ?? [], edges: data?.edges ?? [] });
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

  /**
   * Write a whole graph, and tell `snapshot` about it.
   *
   * These handlers read `snapshot.current` -- the last *rendered* state -- and
   * write absolute arrays back. Two of them in one batch therefore both read
   * the state before either ran, and the second overwrote the first: drop two
   * transducers on a line without a render in between and only the second one
   * existed. Updating the snapshot here is what makes the second read see the
   * first write.
   */
  const commitGraph = useCallback((nodes: Node[], edges: Edge[]) => {
    snapshot.current = { nodes, edges };
    setNodes(nodes);
    setEdges(edges);
  }, [setNodes, setEdges]);

  /**
   * Cmd+C / Cmd+V / Cmd+D / Cmd+A.
   *
   * A stand has eight solenoid valves that are the same solenoid valve, and
   * there was no way to copy one. Held in a ref rather than the system
   * clipboard, because a paste is a graph -- ids, tags and lines to rewrite,
   * see clipboard.ts -- and the OS clipboard only carries text. Nothing here
   * fires while a field has focus, so typing into a tag stays typing.
   */
  const clipRef = useRef<Clip | null>(null);
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    };
    const paste = (clip: Clip | null) => {
      if (!clip || readOnlyRef.current) return;
      const { nodes: ns, edges: es } = snapshot.current;
      const added = pasteClip(clip, ns, pageRef.current);
      // The copy is the selection now, so a drag right after moves the copy.
      commitGraph(
        [...ns.map(n => (n.selected ? { ...n, selected: false } : n)), ...added.nodes],
        [...es.map(e => (e.selected ? { ...e, selected: false } : e)), ...added.edges],
      );
    };
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || typing()) return;
      const key = e.key.toLowerCase();
      if (key === 'c' && !e.shiftKey) {
        const clip = copySelection(snapshot.current.nodes, snapshot.current.edges);
        if (clip) { clipRef.current = clip; e.preventDefault(); }
      } else if (key === 'v' && !e.shiftKey) {
        if (clipRef.current) { e.preventDefault(); paste(clipRef.current); }
      } else if (key === 'd' && !e.shiftKey) {
        const clip = copySelection(snapshot.current.nodes, snapshot.current.edges);
        if (clip) { e.preventDefault(); paste(clip); }
      } else if (key === 'a' && !e.shiftKey) {
        if (readOnlyRef.current) return;
        e.preventDefault();
        const here = pageRef.current;
        setNodes(nds => nds.map(n => ({ ...n, selected: pageOf(n.data as unknown as PIDNodeData) === here })));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [commitGraph, setNodes]);

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
  /**
   * Empty the page you are looking at, and only that page.
   *
   * It used to empty the whole diagram. With the rocket side and the GSE side
   * living in one document, that turned "start this page over" into losing the
   * other one -- and the only way back was the version history, which somebody
   * has to know exists. What a page shows is what Clear takes.
   *
   * Lines go when either end goes, including a line that reached across to
   * another page: half a pipe is worse than none, and the checks panel already
   * says a cross-page line should not be there.
   */
  clearRef.current = useCallback(() => {
    if (readOnlyRef.current) return;
    const here = pageRef.current;
    // A page exists because components are on it, so emptying one used to
    // delete it and drop the reader on Main -- which is not what "clear this
    // page" says, and not what somebody starting a page over wants. Declaring
    // it keeps the empty sheet.
    setDeclaredPages(ps => ps.includes(here) ? ps : [...ps, here]);
    setNodes(nds => {
      const doomed = new Set(
        nds.filter(n => pageOf(n.data as unknown as PIDNodeData) === here).map(n => n.id));
      setEdges(eds => eds.filter(e => !doomed.has(e.source) && !doomed.has(e.target)));
      return nds.filter(n => !doomed.has(n.id));
    });
  }, [setNodes, setEdges, setDeclaredPages]);

  /** What Clear would take, so the confirmation can say. */
  const clearCount = useCallback(() => {
    const here = pageRef.current;
    const doomed = new Set(
      snapshot.current.nodes
        .filter(n => pageOf(n.data as unknown as PIDNodeData) === here).map(n => n.id));
    return {
      page: here,
      nodes: doomed.size,
      edges: snapshot.current.edges
        .filter(e => doomed.has(e.source) || doomed.has(e.target)).length,
    };
  }, []);
  clearCountRef.current = clearCount;
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

  /**
   * Framing the drawing, from the live store rather than a captured instance.
   *
   * `fitView` used to be called on the ReactFlow instance `onInit` handed up,
   * and that instance belongs to one mount -- so the press right after taking
   * the checkout went to the canvas that had just been replaced and did
   * nothing, and it took a second press to work. Same root cause as the
   * palette dropping nothing right after Take, fixed the same way.
   */
  fitRef.current = useCallback(() => { void fitView({ padding: 0.1 }); }, [fitView]);

  /**
   * Show a page when you arrive on it, and leave it where you left it.
   *
   * Two things that used to be wrong, and are one thing. The `fitView` prop
   * only fits the nodes present at the *first* render and a diagram arrives
   * from the server a moment later, so opening one left the reader at 1:1 on
   * the origin looking at empty canvas. And switching to a page whose contents
   * are drawn somewhere else did the same, which is worse, because a page bar
   * that appears to do nothing reads as broken.
   *
   * Both are "nobody has been here yet": no remembered viewport for this
   * (diagram, page) means frame it, and one means put it back. Waits for
   * `useNodesInitialized`, because fitting before anything is measured frames
   * nothing.
   */
  const nodesReady = useNodesInitialized();
  const viewKey = `${diagramKey}::${page}`;
  useEffect(() => {
    if (!nodesReady) return;
    const seen = viewportsRef.current.get(viewKey);
    if (seen) { setViewport(seen); return; }
    if (!nodes.some(n => pageOf(n.data as unknown as PIDNodeData) === page)) return;
    void fitView({ padding: 0.1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, nodesReady]);

  const rememberViewport = useCallback(
    (_: unknown, vp: Viewport) => { viewportsRef.current.set(viewKey, vp); },
    [viewportsRef, viewKey]);

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
    // Same service only: a hydraulic half does not mate with a fluid one.
    const myService = meData.options?.service ?? 'fluid';
    return nodes
      .filter(n => {
        if (n.id === configFor.id) return false;
        const d = n.data as unknown as PIDNodeData;
        return d?.componentType === 'QD' && (d.options?.service ?? 'fluid') === myService;
      })
      .map(n => {
        const d = n.data as unknown as PIDNodeData;
        return { id: n.id, label: d.label || n.id, hint: pageOf(d) };
      });
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
    // One updater, computing the deltas against the array it is about to
    // change. Reading them from the last rendered snapshot instead was a race:
    // React Flow emits position changes faster than React re-renders during a
    // drag, so several arrive against the same stale base and the instruments
    // clipped to a component lag behind it and then jump.
    setNodes(current => {
      const before = new Map(current.map(n => [n.id, n.position]));
      let next = applyNodeChanges(changes, current);
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          const from = before.get(c.id);
          if (!from) continue;
          const delta = { x: c.position.x - from.x, y: c.position.y - from.y };
          if (delta.x || delta.y) next = dragAttached(next, c.id, delta);
          continue;
        }
        // A resize arrives as a `dimensions` change, and React Flow records it
        // in `measured` -- which `toStored` strips on the way out, correctly,
        // since it is a post-layout measurement recomputed on load. A resized
        // section box therefore looked right until the page was reloaded and
        // then sprang back. `width`/`height` are the authored size, so the
        // resize is copied into them here.
        // A resize arrives as a `dimensions` change, and React Flow records it
        // in `measured` -- which `toStored` strips on the way out, correctly,
        // since it is a post-layout measurement recomputed on load. So a
        // resized section box looked right until the page was reloaded and
        // then sprang back to the size it was dropped at. `width`/`height` are
        // the authored size and do persist, so the measurement is copied into
        // them here.
        //
        // Two conditions, and the second is not redundant: `setAttributes` is
        // React Flow's own marker for "the author resized this", but the last
        // change of a drag arrives without it, so following that flag alone
        // stored the size one step behind what was on screen. A node that
        // already *has* an authored size keeps it in step with every
        // measurement. A node that never had one -- every ordinary symbol --
        // never acquires one, which is what stops the whole diagram filling up
        // with sizes nobody asked for.
        if (c.type === 'dimensions' && c.dimensions) {
          const authored = c.setAttributes
            || next.find(n => n.id === c.id)?.width !== undefined;
          if (authored) {
            const { width, height } = c.dimensions;
            next = next.map(n => (n.id === c.id ? { ...n, width, height } : n));
          }
        }
      }
      return next;
    });
  }, [setNodes]);

  /** Bring one component into view without changing the zoom people chose. */
  const fitViewTo = useCallback(async (node: Node) => {
    await setCenter(
      node.position.x + (node.measured?.width ?? 60) / 2,
      node.position.y + (node.measured?.height ?? 60) / 2,
      { duration: 300, zoom: getZoom() },
    );
  }, [setCenter, getZoom]);

  /**
   * Dropping a connection on a line branches it.
   *
   * The answer to "must I place a junction for every tap": no. Drag from the
   * relief valve, let go on the line, and the junction appears where you let
   * go. A branch needs a node -- three flows meeting need a mass balance --
   * but needing one is not a reason to make somebody think about one.
   *
   * The Junction tool stays for placing one deliberately, on a line you have
   * not connected anything to yet.
   */
  const connectingFrom = useRef<{ nodeId: string; handleId: string | null } | null>(null);

  const onConnectStart = useCallback((
    _e: unknown, params: { nodeId: string | null; handleId: string | null },
  ) => {
    connectingFrom.current = params.nodeId ? { nodeId: params.nodeId, handleId: params.handleId } : null;
  }, []);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent) => {
    const from = connectingFrom.current;
    connectingFrom.current = null;
    if (!from || readOnlyRef.current) return;

    const point = 'clientX' in event
      ? { x: event.clientX, y: event.clientY }
      : { x: event.changedTouches[0]?.clientX ?? 0, y: event.changedTouches[0]?.clientY ?? 0 };
    const flow = screenToFlowPosition(point);

    const { nodes: ns, edges: es } = snapshot.current;
    // Only when it landed on a line. On a component ReactFlow has already made
    // the connection, and `lineAt` will not claim it.
    const hit = lineAt(drawnLines(), flow);
    if (!hit) return;

    // Not onto a line this component is already an end of. That would be two
    // lines from the same port to the same junction, which is a parallel path
    // and not what anybody dragging there meant.
    const line = es.find(e => e.id === hit.id);
    if (!line || line.source === from.nodeId || line.target === from.nodeId) return;

    const split = splitEdgeAt(ns, es, hit.id, hit.at, pageRef.current);
    if (!split) return;

    commitGraph(split.nodes, [
      ...split.edges,
      {
        id: `${from.nodeId}-${split.junctionId}`,
        source: from.nodeId,
        sourceHandle: from.handleId ?? undefined,
        target: split.junctionId,
        targetHandle: undefined,
        type: 'smoothstep',
        data: {},
      },
    ]);
  }, [screenToFlowPosition, commitGraph]);

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
    const nodeH = (type === 'TANK' || type === 'ENGINE') ? 100 : 60;
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
      ? targetAt(flowPos, snapshot.current.nodes, snapshot.current.edges, undefined, pageRef.current)
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
          // `ROT_#` becomes `ROT-3`, or whatever is next. The placeholder used
          // to be stamped on as-is, so every rotary valve was tagged `ROT_#`
          // and the second one tripped the duplicate-tag check.
          label: numberTag(def.label, snapshot.current.nodes
            .map(n => (n.data as unknown as PIDNodeData)?.label ?? '')),
          fluidType: 'default',
          // The palette entry's preset, plus every option's declared default,
          // so a symbol is never drawn in a state its own config disagrees
          // with -- a valve reads NC from the moment it lands, not once
          // somebody opens the dialog.
          options: {
            ...Object.fromEntries((COMPONENT_SPECS[type]?.options ?? []).map(o => [o.key, o.default])),
            ...(def.preset ?? {}),
          },
          // A supply picked from the palette already knows what is in it,
          // and a transducer its range.
          ...(def.fluid ? { fluid: def.fluid } : {}),
          ...(def.params ? { params: structuredClone(def.params) } : {}),
          ...(host ? { attachedTo: host.id } : {}),
          page,
        } as PIDNodeData;
    // Allocated outside the updater: React invokes updaters twice in
    // development, and an id minted inside one is neither pure nor stable.
    const id = nextNodeId();

    /**
     * A transducer dropped on a line taps that line.
     *
     * The same gesture as branching by dropping a connection, from the other
     * end: a gauge or a transducer has exactly one port, so landing one on a
     * pipe can only mean "tap here" -- and the topology that means is a
     * junction with the instrument on its third leg. Making somebody place the
     * junction, then draw the line, then remember which of four ports to use
     * is three steps for one intention.
     */
    if (isTapped(type)) {
      const hit = lineAt(drawnLines(), flowPos);
      if (hit) {
        const at = hit.at;
        const split = splitEdgeAt(
          snapshot.current.nodes, snapshot.current.edges, hit.id, at, pageRef.current);
        if (split) {
          // Standing off the pipe, on the side the pointer was, so the symbol
          // does not sit on top of the line it is reading. Below the line it
          // is turned over, because its one tapping is on its underside and a
          // tap has to point at the pipe -- the lettering stays upright.
          const above = flowPos.y <= at.y;
          commitGraph(
            [...split.nodes, {
              id, type,
              position: { x: at.x - 30, y: above ? at.y - 90 : at.y + 30 },
              data: { ...nodeData, ...(above ? {} : { rotation: 180 }) } as unknown as Record<string, unknown>,
            }],
            [...split.edges, {
              id: `${id}-${split.junctionId}`,
              source: id, sourceHandle: 'b',
              target: split.junctionId,
              type: 'smoothstep',
              data: {},
            }]);
          return;
        }
      }
    }

    // Through `commitGraph` like the tap above, not a functional updater:
    // this handler's two branches have to agree about how they write, or two
    // drops in one batch see different states and the absolute one wins.
    commitGraph([...snapshot.current.nodes, {
      id,
      type,
      position,
      // Behind the components it encloses, so the drawing reads as components
      // in a box rather than a box over components.
      //
      // Size goes in `width`/`height` only. Setting `style.width` as well
      // stored it twice: NodeResizer updates the first pair and leaves the
      // second at whatever it was dropped as, so a resized box saved 200x70
      // alongside a style still claiming 320x220. One of the two would
      // eventually be believed.
      ...(type === 'REGION' ? { width: 320, height: 220, zIndex: -1 } : {}),
      data: nodeData as unknown as Record<string, unknown>,
    }], snapshot.current.edges);
  }, [screenToFlowPosition, commitGraph, page]);

  /** Apply the current paint colour, or fall through to normal selection. */
  const paintIfArmed = useCallback((kind: 'node' | 'edge', id: string): boolean => {
    const p = paintRef.current;
    if (!p.on || readOnlyRef.current) return false;
    const apply = <T extends { id: string; data?: Record<string, unknown> }>(x: T) =>
      x.id === id ? { ...x, data: { ...x.data, color: p.colour ?? undefined } } : x;
    if (kind === 'node') setNodes(nds => nds.map(apply));
    else setEdges(eds => eds.map(apply));
    return true;
  }, [setNodes, setEdges]);

  /**
   * Deleting a junction rejoins the line it was on.
   *
   * A junction is a point *in* a run, not a component of its own -- so removing
   * one should leave the run, exactly as inserting one left it. Letting React
   * Flow take the two edges with it deleted the pipe as well, which is never
   * what somebody meant by "take that junction out".
   *
   * Built from what React Flow says it deleted rather than from the edges that
   * are left: by the time this runs the two halves are already gone from state,
   * so an updater reading the current list finds nothing to rejoin.
   *
   * Only for junctions that are genuinely mid-line -- one edge in, one out. A
   * junction with a third leg on it has no single run to rejoin, so the
   * ordinary behaviour stands and everything attached goes with it.
   */
  const onDelete = useCallback(({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
    if (readOnlyRef.current) return;
    const rejoined = rejoinAfterDelete(nodes, edges);
    if (rejoined.length) setEdges(eds => [...eds, ...rejoined]);
  }, [setEdges]);

  /**
   * Dropping a symbol lines its ports up with what is already there.
   *
   * The grid cannot do this and never could: a valve is sixty wide so its
   * centre port is thirty from the origin, an engine is seventy-two so its top
   * port is at thirty-six, and both origins snap to ten -- so those two ports
   * were six apart at every position either could be put in. See `snap.ts`.
   *
   * Read off ReactFlow's own measured handle bounds rather than a table of
   * where each symbol keeps its ports: it already knows, it stays right when a
   * symbol is turned or its port count changes, and a second copy of that
   * geometry is a second thing to get wrong.
   */
  const onNodeDragStop = useCallback((
    _e: MouseEvent | TouchEvent, node: Node, dragged: Node[],
  ) => {
    if (readOnlyRef.current) return;
    const portsOf = (n: Node): PortPositions | null => {
      const handles = getInternalNode(n.id)?.internals.handleBounds?.source;
      if (!handles?.length) return null;
      return {
        id: n.id,
        xs: handles.map(h => n.position.x + h.x + h.width / 2),
        ys: handles.map(h => n.position.y + h.y + h.height / 2),
      };
    };

    // Everything that moved, against everything that did not -- so a symbol
    // never lines itself up with one it is being dragged alongside.
    const moving = new Set((dragged.length ? dragged : [node]).map(n => n.id));
    const here = pageRef.current;
    const mine = [...moving].map(id => snapshot.current.nodes.find(n => n.id === id))
      .filter((n): n is Node => !!n).map(portsOf).filter((p): p is PortPositions => !!p);
    if (mine.length === 0) return;

    const others = snapshot.current.nodes
      .filter(n => !moving.has(n.id) && pageOf(n.data as unknown as PIDNodeData) === here)
      .map(portsOf).filter((p): p is PortPositions => !!p);
    if (others.length === 0) return;

    // One shift for the whole selection, from whichever of its symbols is
    // nearest an alignment. Shifting them individually would pull a group
    // apart to satisfy each member.
    const shift = mine
      .map(m => alignmentShift(m, others))
      .reduce((best, s) => ({
        dx: best.dx || s.dx,
        dy: best.dy || s.dy,
      }), { dx: 0, dy: 0 });
    if (!shift.dx && !shift.dy) return;

    setNodes(nds => {
      let next = nds.map(n => moving.has(n.id)
        ? { ...n, position: { x: n.position.x + shift.dx, y: n.position.y + shift.dy } }
        : n);
      // Probes clipped to something that moved go with it, exactly as they do
      // during the drag itself.
      const delta = { x: shift.dx, y: shift.dy };
      for (const id of moving) next = dragAttached(next, id, delta);
      return next;
    });
  }, [getInternalNode, setNodes]);

  const onNodeClick = useCallback((e: React.MouseEvent, node: Node) => {
    if (paintIfArmed('node', node.id)) { e.stopPropagation(); e.preventDefault(); }
  }, [paintIfArmed]);

  const onEdgeClick = useCallback((e: React.MouseEvent, edge: Edge) => {
    if (paintIfArmed('edge', edge.id)) { e.stopPropagation(); e.preventDefault(); }
  }, [paintIfArmed]);

  // Escape puts any tool down.
  useEffect(() => {
    if (tool === 'none') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTool('none'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool]);

  const onNodeDoubleClick = useCallback((_e: React.MouseEvent, node: Node) => {
    const type = (node.data as unknown as PIDNodeData)?.componentType;
    // Text and junctions have nothing to configure; opening an empty dialog on
    // them would only teach people that double-click does nothing.
    if (!type || !COMPONENT_SPECS[type] || toolRef.current !== 'none') return;
    setConfigFor({ kind: 'node', id: node.id });
  }, []);

  // A line is configurable too, and that is the gap that mattered most: an
  // edge carried a colour and nothing else, so its length, bore and roughness
  // -- where most of the pressure drop actually is -- had nowhere to live.
  const onEdgeDoubleClick = useCallback((_e: React.MouseEvent, edge: Edge) => {
    if (toolRef.current !== 'none') return;
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
      ...(patch.ports ? { ports: patch.ports } : {}),
      ...(patch.geometry ? { geometry: patch.geometry } : {}),
    };
    if (subject.kind === 'node') {
      setNodes(nds => nds.map(n => (
        n.id === subject.id
          ? { ...n, data: { ...n.data, ...common, label: patch.label, fluid: patch.fluid } }
          : n
      )));
    } else {
      setEdges(eds => eds.map(e => (
        e.id === subject.id
          ? { ...e, data: { ...e.data, ...common, lineType: patch.lineType, segments: patch.segments, sketch: patch.sketch } }
          : e
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
    <div
      className="relative flex h-full flex-1 flex-col"
      style={tool !== 'none' ? { cursor: 'crosshair' } : undefined}
      onClick={() => setColorMenu(null)}
    >
      <div className="relative min-h-0 flex-1">
      <ToolProvider tool={tool}>
      <FluidProvider nodes={nodes} edges={edges}>
      <ReactFlow
        nodes={view.nodes} edges={view.edges}
        onNodesChange={handleNodesChange} onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart} onConnectEnd={onConnectEnd}
        onDrop={onDrop} onDragOver={onDragOver}
        onEdgeContextMenu={onEdgeContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onNodeClick={onNodeClick}
        onNodeDragStop={onNodeDragStop}
        onDelete={onDelete}
        onEdgeClick={onEdgeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeDoubleClick={onEdgeDoubleClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        edgesReconnectable={!readOnly}
        // Both, because a Mac keyboard has no key marked Delete -- it has
        // Backspace, and pressing it did nothing.
        deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
        selectionOnDrag={!readOnly && mode === 'select'}
        panOnDrag={readOnly || mode !== 'select'}
        selectionMode={SelectionMode.Partial}
        connectionMode={ConnectionMode.Loose}
        multiSelectionKeyCode="Meta"
        snapToGrid
        snapGrid={SNAP}
        onMove={rememberViewport}
        defaultViewport={viewportsRef.current.get(viewKey) ?? { x: 0, y: 0, zoom: 1 }}
        colorMode={theme}
        defaultEdgeOptions={{ type: 'smoothstep' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-border)" />
        <AttachmentLayer nodes={nodes} edges={edges} />
        <VentLayer nodes={view.nodes} edges={view.edges} />
        <Controls />
        <TitleBlock meta={{ ...sheet, page }} />
        {/* One line, and only the gestures nothing else on screen mentions.
            It used to list nine, which wrapped to four lines on any canvas
            narrower than a desktop and climbed up through the middle of the
            drawing -- printing the instructions over the thing they are about.
            `nowrap` is what makes that impossible rather than unlikely, and
            it stopped taking clicks meant for the canvas underneath. */}
        <Panel position="bottom-center" className="pointer-events-none max-w-full">
          <span className="block truncate whitespace-nowrap text-[10px] text-[var(--color-text-muted)] select-none">
            Double-click to configure · R rotates · ⌘C ⌘V ⌘D copy, paste, duplicate · Right-click colours
          </span>
        </Panel>
      </ReactFlow>
      </FluidProvider>
      </ToolProvider>
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
      <div className="absolute left-3 top-3 z-20 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/90 px-1.5 py-1 shadow-lg backdrop-blur">
        <PaintTool
          colour={colour}
          active={tool === 'paint'}
          onColour={setColour}
          onToggle={on => setTool(on ? 'paint' : 'none')}
        />
        <span className="h-4 w-px bg-[var(--color-border)]" />
        <button
          disabled={readOnly}
          onClick={() => setTool(t => (t === 'junction' ? 'none' : 'junction'))}
          title={tool === 'junction'
            ? 'Junction on — click a line to branch it, or press Escape'
            : 'Junction: click a line to put a branch point on it'}
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
            tool === 'junction'
              ? 'bg-[var(--color-accent)] text-white'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]'
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 12h7" /><path d="M14 12h7" /><path d="M12 14v7" />
            <circle cx="12" cy="12" r="2.5" fill="currentColor" />
          </svg>
          Junction
        </button>
      </div>

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
  const [mode, setMode] = useState<InteractionMode>('pan');
  // Applied once before mount (main.tsx), so this just mirrors the DOM state
  // rather than deciding it -- re-deriving it here would need the same
  // localStorage read twice and could disagree with what's already applied.
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const toggleTheme = useCallback(() => {
    setTheme(t => {
      const next: Theme = t === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      return next;
    });
  }, []);

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
  const clearCountRef     = useRef<() => { page: string; nodes: number; edges: number }>(
    () => ({ page: '', nodes: 0, edges: 0 }));
  const fitRef            = useRef<() => void>(() => {});
  const viewportsRef      = useRef<Map<string, Viewport>>(new Map());
  const [page, setPage]   = useState<string>(DEFAULT_PAGE);
  const [declaredPages, setDeclaredPages] = useState<string[]>([]);
  const undoRef           = useRef<() => void>(() => {});
  const redoRef           = useRef<() => void>(() => {});
  const releaseRef        = useRef<(label: string) => Promise<{ label: string; savedAt: string }>>(() => Promise.resolve({ label: '', savedAt: '' }));
  const getHistoryRef     = useRef<() => Promise<MicroVersion[]>>(() => Promise.resolve([]));
  const getReleasesRef    = useRef<() => Promise<ReleaseVersion[]>>(() => Promise.resolve([]));
  const restoreMicroRef   = useRef<(versionId: string) => Promise<void>>(() => Promise.resolve());
  const restoreReleaseRef = useRef<(label: string) => Promise<void>>(() => Promise.resolve());


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
    // On a developer's own machine the checkout has no colleague to protect,
    // so it stays out of the way: the diagram is taken on open, held while the
    // tab lives, and taken straight back if it lapses. Deployed, the ordinary
    // model applies -- press Take, and be told when it goes.
    local: isLocalHost(location.hostname),
  });

  // What the title block says. The latest release label is fetched when the
  // diagram changes and again after a release is published, so the corner of
  // the sheet says which revision is being looked at.
  const [latestRelease, setLatestRelease] = useState<string | null>(null);
  useEffect(() => {
    setLatestRelease(null);
    if (!activeRef) return;
    let cancelled = false;
    api.listReleases(activeRef)
      .then(rs => { if (!cancelled && rs.length) setLatestRelease(rs[0].label); })
      .catch(() => { /* offline: the block says working copy */ });
    return () => { cancelled = true; };
  }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const sheet = useMemo<Omit<SheetMeta, 'page'>>(() => ({
    name: diagrams.find(d => keyOf(refOf(d)) === activeKey)?.name ?? 'Untitled',
    release: latestRelease,
  }), [diagrams, activeKey, latestRelease]);

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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <DiagramBar
        diagrams={diagrams}
        activeKey={activeKey}
        onSelect={selectDiagram}
        onOpenChange={() => setShowChange(true)}
        checkout={checkout}
        theme={theme}
        onToggleTheme={toggleTheme}
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
        onFitView={() => fitRef.current()}
        getSnapshot={() => getRef.current()}
        loadSnapshot={d => loadRef.current(d)}
        onClear={() => clearRef.current()}
        clearSummary={() => clearCountRef.current()}
        onUndo={() => undoRef.current()}
        onRedo={() => redoRef.current()}
        onRelease={async label => {
          const made = await releaseRef.current(label);
          setLatestRelease(made.label);
          return made;
        }}
        sheet={{ ...sheet, page }}
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
              fitRef={fitRef}
              viewportsRef={viewportsRef}
              page={page}
              setPage={setPage}
              declaredPages={declaredPages}
              setDeclaredPages={setDeclaredPages}
              getRef={getRef}
              loadRef={loadRef}
              clearRef={clearRef}
              clearCountRef={clearCountRef}
              undoRef={undoRef}
              redoRef={redoRef}
              releaseRef={releaseRef}
              getHistoryRef={getHistoryRef}
              getReleasesRef={getReleasesRef}
              restoreMicroRef={restoreMicroRef}
              restoreReleaseRef={restoreReleaseRef}
              mode={mode}
              sheet={sheet}
              onForbidden={onForbidden}
              onLockLost={checkout.lost}
              theme={theme}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
              {ready ? 'Create a diagram to begin.' : 'Loading…'}
            </div>
          )}
        </ReactFlowProvider>
      </div>
    </div>
    </ReadOnlyProvider>
  );
}

