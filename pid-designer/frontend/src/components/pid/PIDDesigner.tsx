import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlowProvider,
  ReactFlow,
  Background,
  Controls,
  Panel,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useNodesInitialized,
  useStore,
  type Viewport,
  BackgroundVariant,
  SelectionMode,
  ConnectionMode,
  type Connection,
  type FinalConnectionState,
  type HandleType,
  type Node,
  type NodeChange,
  type Edge,
  type EdgeChange,
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
import { manifoldShift } from './nodes/ManifoldNode';
import { BranchableEdge, CARRY_RADIUS } from './BranchableEdge';
import { nextNodeId, seedIdsFrom } from './ids';
import { defFor } from './types';
import type { PIDNodeData } from './types';
import { numberTag } from './tags';
import { migrate } from './migrate';
import { handleCentre, handleEnd } from './ports';
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
import { AttachmentLayer, DrawnRoutes } from './AttachmentLayer';
import { ChecksPanel } from './ChecksPanel';
import { VentLayer } from './VentLayer';
import { PageBar } from './PageBar';
import {
  DEFAULT_PAGE, applyPage, clearSelection, listPages, moveToPage, pageOf, pageOfSubjects, selectOnPage,
} from './pages';
import { useHistory } from './history';
import { translateSubgraph, turnSelected } from './graphOps';
import { clearOfHost, clipAt, isInstrument } from './attach';
import { drawnLines } from './lineHit';
import { J_END, dragging, isJunction, junctionEnd } from './junctions';
import type { Dragging, EndLookup, Face } from './junctions';
import { BranchDragProvider, BranchPreview } from './BranchDrag';
import { ConnectionLine } from './ConnectionLine';
import type { BranchSource } from './BranchDrag';
import { GRID } from './route';
import type { Pt } from './route';
import {
  canJoin, clientOf, commitDrop, connectLine, drawnPoints, lineUnder, partOnLine, plainChanges, reconnectLine,
  reconnectMoving, reconnectableEnds, resolveDrop,
} from './drop';
import type { DropScene, Under } from './drop';
import { snapOnDrop } from './snap';
import type { PortsOf } from './snap';
import { carryBaseline, handleSignature, useReseat } from './reseat';
import { obstaclesByPage } from './routeGrid';
import type { Baseline } from './reseat';
import { afterDelete, applyMoves, carriedWith, followCorners } from './canvasEdits';
import { drawnCorners } from './edgeGeometry';
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
const SNAP: [number, number] = [GRID, GRID];

/**
 * One object for the life of the page. React Flow hands it to every line, and
 * a literal in the JSX was a new object each time the canvas re-rendered --
 * once a second for the checkout clock alone -- so every line re-rendered too.
 */
const DEFAULT_EDGE_OPTIONS = { type: 'smoothstep' } as const;

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
  const disarm = useCallback(() => setTool('none'), []);

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

  // Undo and redo: see history.ts. `resetHistory` makes the drawing as
  // opened the floor; `markCorrection` is how the reseat below says its own
  // change is a correction, not an edit.
  const {
    undo, redo, reset: resetHistory, flush: flushHistory, markCorrection,
  } = useHistory(nodes, edges, setNodes, setEdges);

  /**
   * Where a port is and which way it faces, asked with the node's current
   * position. Read off React Flow's own measured handle bounds rather than a
   * table of where each symbol keeps its ports: it already knows, it stays
   * right when a symbol is turned, and a second copy of that geometry is a
   * second thing to get wrong. A tee's faces are fixed, so they need no
   * measuring; anything else unmeasured falls back to its centre.
   */
  const endOf = useCallback<EndLookup>((node, handleId) => {
    const hb = getInternalNode(node.id)?.internals.handleBounds?.source?.find(h => h.id === handleId);
    // The handle's *outer* edge in the direction it faces, which is where
    // React Flow itself anchors a line (`getHandlePosition`). Its centre is
    // three pixels short of that, and three pixels was a visible kink in
    // every run a tee was put back on. Rid of the screen's measuring noise
    // (`handleEnd`).
    if (hb) return handleEnd(node.position, hb);
    if (isJunction(node) && handleId) return junctionEnd(node.position, handleId as Face);
    return null;
  }, [getInternalNode]);
  // A tee's measured handle is still a tee: routes need only clear the dot.
  const endOfClear = useCallback<EndLookup>((node, handleId) => {
    const e = endOf(node, handleId);
    return e && isJunction(node) && e.clear === undefined ? { ...e, ...J_END } : e;
  }, [endOf]);
  /**
   * What automatic routes go round: every symbol on a line's own page (not
   * tees, section boxes or text). The same boxes every line draws itself
   * round (see lineRoute.ts), so the pipes the reseat routes and the faces it
   * chooses are the routes that are drawn. By page, because the pages share
   * one plane and a symbol on another page is in nobody's way here.
   */
  const obstacles = useMemo(() => obstaclesByPage(nodes), [nodes]);
  // For the handlers, which should not be rebuilt -- and handed to React
  // Flow again -- every time a symbol moves.
  const obstaclesRef = useRef(obstacles);
  obstaclesRef.current = obstacles;

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
  //
  // With it, whether the autosave has sent something since the last flush:
  // the server snapshots a microversion only every few minutes, and what it
  // has not snapshotted is what the flush on hide is for.
  const lastSaved = useRef<string>(''), unsnapped = useRef(false);

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
        // The drawing as opened is where undo stops. Without this the load was
        // recorded as an edit on top of the empty canvas, and one Ctrl+Z too
        // many blanked the drawing -- which the autosave then saved.
        resetHistory(loaded);
        // Seed the guard with what we just loaded, so opening a diagram does not
        // immediately save it straight back.
        lastSaved.current = JSON.stringify(api.toStored(loaded));
        loadedId.current = diagramKey;
      })
      .catch(() => {
        if (cancelled) return;
        // Nothing arrived, so the empty sheet is what was opened: the first
        // thing drawn on it can still be undone.
        resetHistory({ nodes: [], edges: [] });
        loadedId.current = diagramKey;
      });
    return () => { cancelled = true; };
  }, [diagramKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced autosave of the working copy — only once the active diagram has
  // actually loaded, so switching never clobbers a diagram with another's data.
  useEffect(() => {
    // No checkout, no autosave. The canvas is inert in that state anyway;
    // this is the belt to that pair of braces.
    if (loadedId.current !== diagramKey || readOnlyRef.current) return;
    // Written out when the timer fires, not on every change: a drag changes
    // the drawing twice a tick -- the step and the reseat's correction of
    // it -- and serialising the whole drawing for each, to throw all but the
    // last away, was a millisecond a tick on a stand-sized drawing.
    const t = setTimeout(() => {
      const serialized = JSON.stringify(api.toStored({ nodes, edges }));
      if (serialized === lastSaved.current) return;
      lastSaved.current = serialized;
      unsnapped.current = true;
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
  //
  // Only when there is something to snapshot: an edit the autosave has not
  // sent yet, or one it sent that the server has not snapshotted. The drawing
  // as opened is neither -- opening a drawing puts it through `migrate` and
  // the reseat, and what they make of it on this screen is kept off the
  // server until somebody edits it (`lastSaved`, `keepBaseline`) -- and a
  // beacon that did not ask wrote that rewrite, with a microversion, the
  // first time the tab was hidden, and a microversion on every hide after.
  useEffect(() => {
    unsnapped.current = false;
    const flush = () => {
      // A beacon cannot read a rejection, so gate it here instead.
      if (loadedId.current !== diagramKey || readOnlyRef.current) return;
      const text = JSON.stringify(api.toStored(snapshot.current));
      if (text === lastSaved.current && !unsnapped.current) return;
      api.flushDiagram(diagramRef, snapshot.current);
      lastSaved.current = text;
      unsnapped.current = false;
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
   *
   * Copy and duplicate take what is selected on the page being looked at
   * and nothing else; a selection left on another page is not one the reader
   * can see they are copying.
   */
  const clipRef = useRef<Clip | null>(null);
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    };
    // Every paste used to land on the first one, exactly, lines and all, and
    // only dragging revealed the stack. pasteClip lands each copy on the
    // first PASTE_OFFSET step nothing is standing on (see pasteOffset), so
    // laying out eight valves is Cmd+C and seven Cmd+V, and a Cmd+D or an
    // undo in between cannot put two copies in one place: where the copies
    // are is read off the drawing, not counted from the keys.
    const paste = (clip: Clip | null) => {
      if (!clip || readOnlyRef.current) return;
      const { nodes: ns, edges: es } = snapshot.current;
      // The drawing's lines, so no pasted line takes the id of one of them;
      // and the page's lines as drawn, and its ports, so a copy of a bay lands
      // clear of the lines there as well as the symbols, and is drawn there
      // as it was copied (see besideOffset).
      const added = pasteClip(clip, ns, pageRef.current, {
        edges: es, geometry: { drawn: drawnCorners(), endOf: endOfClear },
      });
      // The copy is the selection now, so a drag right after moves the copy.
      commitGraph(
        [...ns.map(n => (n.selected ? { ...n, selected: false } : n)), ...added.nodes],
        [...es.map(e => (e.selected ? { ...e, selected: false } : e)), ...added.edges],
      );
    };
    // What is selected here, with what the copy leaves behind tidied as a
    // delete tidies it (see copySelection): the lines as drawn, so a probe
    // on a pair of lines healed into one stays where on the pipe it was.
    const copy = () => {
      const drawn = drawnCorners();
      return copySelection(snapshot.current.nodes, snapshot.current.edges, pageRef.current, { old: id => drawn.get(id) });
    };
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || typing()) return;
      const key = e.key.toLowerCase();
      if (key === 'c' && !e.shiftKey) {
        const clip = copy();
        if (clip) { clipRef.current = clip; e.preventDefault(); }
      } else if (key === 'v' && !e.shiftKey) {
        if (clipRef.current) { e.preventDefault(); paste(clipRef.current); }
      } else if (key === 'd' && !e.shiftKey) {
        const clip = copy();
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
  }, [commitGraph, setNodes, endOfClear]);

  // R turns what is selected on the page being looked at (see graphOps.ts).
  // Like the clipboard keys it stands down while a field has focus: an R
  // typed into a tag used to turn the symbol whose tag it was.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (readOnlyRef.current) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        setNodes(nds => turnSelected(nds, pageRef.current));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setNodes]);

  // Each of these rewrites the diagram, and each is reached from the toolbar.
  // The toolbar buttons are disabled without the checkout; these guards are the
  // belt to that pair of braces, and they also cover the keyboard shortcuts.
  getRef.current   = useCallback(() => ({ nodes, edges }), [nodes, edges]);
  // An import, like a restore from a version below, is an edit and stays
  // undoable -- only opening a drawing resets the history. What was drawn in
  // the moment before it is recorded first, so undoing the import lands on it.
  // A file exported by an older build is an older drawing, and is brought up
  // to date as opening one is (`migrate`); so is a version restored from
  // before a migration existed.
  loadRef.current  = useCallback((d) => {
    if (readOnlyRef.current) return;
    flushHistory();
    const m = migrate({ nodes: d.nodes, edges: d.edges });
    seedIdsFrom(m.nodes);
    setNodes(m.nodes);
    setEdges(m.edges);
  }, [setNodes, setEdges, flushHistory]);
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
    const data = migrate(await api.getVersion(diagramRef, versionId));
    flushHistory();
    seedIdsFrom(data.nodes);
    setNodes(data.nodes);
    setEdges(data.edges);
  }, [diagramKey, setNodes, setEdges, flushHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  restoreReleaseRef.current = useCallback(async (label: string) => {
    if (readOnlyRef.current) return;
    const data = migrate(await api.getRelease(diagramRef, label));
    flushHistory();
    seedIdsFrom(data.nodes);
    setNodes(data.nodes);
    setEdges(data.edges);
  }, [diagramKey, setNodes, setEdges, flushHistory]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /**
   * Every tee stays on its pipe.
   *
   * After any change to the drawing -- and after any change to the ports as
   * React Flow measured them, which a quarter turn of a square symbol makes
   * without changing the drawing at all -- each pipe is routed once, every
   * tee on it is put on that route where it stands, and every line is
   * pointed at the faces that draw it best. See reseat.ts for when it runs,
   * and pipes.ts for what it does.
   *
   * What it changes is a correction, not an edit: undo amends the entry it
   * corrected (`markCorrection`), and a correction to the drawing as last
   * saved -- the drawing as opened, above all, drawn on the ports as they
   * were measured on this screen -- moves the autosave's baseline with it
   * (`keepBaseline`), so opening a drawing never saves it back on its own. The
   * correction is saved with the next edit, and made again, the same, by
   * every other screen that opens the drawing before then.
   */
  const ports = useStore(s => handleSignature(s.nodeLookup));
  const baseline = useRef<Baseline>({ saved: '', edited: false });
  const keepBaseline = useCallback((before: { nodes: Node[]; edges: Edge[] }, after: { nodes: Node[]; edges: Edge[] }) => {
    if (loadedId.current !== diagramKey || !lastSaved.current) return;
    baseline.current = carryBaseline(
      baseline.current, lastSaved.current, before, after, g => JSON.stringify(api.toStored(g)));
    lastSaved.current = baseline.current.saved;
  }, [diagramKey]);
  // The drag in progress, from the first tick to the drop (`Dragging`).
  const dragRef = useRef<Dragging | null>(null);
  const dragNow = useCallback(() => dragRef.current, []);
  const settleAgain = useReseat({
    nodes, edges, endOf: endOfClear, obstacles, ready: nodesReady, ports, drag: dragNow,
    setNodes, setEdges, markCorrection, onCorrect: keepBaseline,
  });

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
  // A line's end can be carried to another port only where it is on a
  // symbol's port; a tee's end is where its pipe runs through it (see
  // `onReconnectEnd`). Added to the view, never to the drawing: React Flow
  // hands its own objects back, a line changed through
  // `useReactFlow().setEdges` (a segment drag, a hover split) among them, and
  // the drawing takes them without the mark. `onDelete` does the same.
  const viewEdges = useMemo(() => reconnectableEnds(view.nodes, view.edges), [view]);
  const onLinesChange = useCallback((changes: EdgeChange<Edge>[]) => onEdgesChange(plainChanges(changes)), [onEdgesChange]);
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

  /**
   * A port drag let go right on a free port: the line React Flow makes
   * itself (`connectLine`).
   *
   * React Flow calls this only for a port its validator let it join
   * (`canJoin`) -- a free port of another symbol -- and only on a drag,
   * since click-to-connect is off. Everything else a drag can be let go on
   * is `onConnectEnd`'s.
   */
  const onConnect = useCallback((params: Connection) => {
    if (readOnlyRef.current) return;
    setEdges(eds => connectLine(eds, params));
  }, [setEdges]);

  /** What React Flow may join by itself (`canJoin`), against the drawing as last rendered. */
  const isValidConnection = useCallback(
    (c: Connection | Edge) => canJoin(c, snapshot.current.nodes, snapshot.current.edges), []);

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
    // clipped to a component lag behind it and then jump. What moves how --
    // a tee slides along its pipe, or is carried whole with a bay picked up
    // with both ends of its pipe -- is `applyMoves` (canvasEdits.ts).
    //
    // Corners go with a group, by the deltas the nodes updater worked out:
    // it runs first, since React processes the nodes' state before the
    // lines' (the order the two are declared in). See `followCorners`.
    let shifts = new Map<string, Pt>();
    setNodes(current => {
      const moved = applyMoves(current, changes, snapshot.current.edges, endOfClear, obstaclesRef.current);
      shifts = moved.shifts;
      return moved.nodes;
    });
    if (changes.some(c => c.type === 'position')) setEdges(eds => followCorners(eds, shifts));
  }, [setNodes, setEdges, endOfClear]);

  /** Bring one component into view without changing the zoom people chose. */
  const fitViewTo = useCallback(async (node: Node) => {
    await setCenter(
      node.position.x + (node.measured?.width ?? 60) / 2,
      node.position.y + (node.measured?.height ?? 60) / 2,
      { duration: 300, zoom: getZoom() },
    );
  }, [setCenter, getZoom]);

  /**
   * Drawing a line by dragging, and letting go of it.
   *
   * The answer to "must I place a junction for every tap": no. Drag from the
   * relief valve, let go on the line, and the junction appears where you let
   * go. A branch needs a node -- three flows meeting need a mass balance --
   * but needing one is not a reason to make somebody think about one.
   *
   * What a drag becomes is decided in one place, drop.ts, for a drag out of a
   * port, a line pulled out of a line or out of a tee's ring, and a line's end
   * carried to somewhere else alike: the handlers below only ask the page what
   * is under the pointer and hand that over. The Junction tool stays for
   * placing a tee deliberately, on a line nothing is connected to yet.
   *
   * `connectingFrom` is the port a drag started from, and whether the drag is
   * carrying the end of a line rather than drawing a new one. React Flow runs
   * a carried end as a drag out of the end that stays, and says so first
   * (`onReconnectStart`); `onConnectStart` keeps the word only for a drag out
   * of that very port, so a carry whose end never arrived -- let go outside
   * the window -- cannot mark the next drag.
   */
  const connectingFrom = useRef<{ nodeId: string; handleId: string | null; reconnect?: string } | null>(null);

  const onConnectStart = useCallback((
    _e: unknown, params: { nodeId: string | null; handleId: string | null },
  ) => {
    const was = connectingFrom.current;
    const same = !!was && was.nodeId === params.nodeId && was.handleId === params.handleId;
    connectingFrom.current = params.nodeId
      ? { nodeId: params.nodeId, handleId: params.handleId, ...(same && was?.reconnect ? { reconnect: was.reconnect } : {}) }
      : null;
  }, []);

  /**
   * The drawing a drop is resolved against: as last rendered, with the ports
   * as React Flow measured them and the lines as the page draws them.
   */
  const dropScene = useCallback((): DropScene => ({
    nodes: snapshot.current.nodes,
    edges: snapshot.current.edges,
    endOf: endOfClear,
    portsOf: n => getInternalNode(n.id)?.internals.handleBounds?.source?.map(h => h.id ?? '') ?? null,
    lines: drawnPoints(drawnLines()),
    obstacles: obstaclesRef.current,
    zoom: getZoom(),
    page: pageRef.current,
  }), [endOfClear, getInternalNode, getZoom]);

  /**
   * What is under the pointer: the port and the node the page says are
   * there, and the nearest drawn line. `near` is the port React Flow found
   * within its radius, which it still names when its validator refused it.
   */
  const underPointer = useCallback((
    client: Pt, at: Pt, scene: DropScene, near?: { nodeId: string; id?: string | null } | null,
  ): Under => {
    const el = document.elementFromPoint(client.x, client.y) as HTMLElement | null;
    const handleEl = el?.closest<HTMLElement>('.react-flow__handle');
    const nodeId = handleEl?.dataset.nodeid, handleId = handleEl?.dataset.handleid;
    const handle = nodeId && handleId ? { nodeId, handleId } : near?.id ? { nodeId: near.nodeId, handleId: near.id } : null;
    return {
      handle,
      node: el?.closest<HTMLElement>('.react-flow__node')?.dataset.id ?? handle?.nodeId ?? null,
      line: lineUnder(scene.lines ?? [], at, scene.zoom),
    };
  }, []);

  /**
   * A port drag let go anywhere but right on a free port (that is
   * `onConnect`'s).
   *
   * A port that already has a line has the line teed thirty pixels out and
   * joins the tee; a symbol's body joins its best free port; a tee joins on
   * its free face across its run; a line is teed where it was let go on, or
   * level with the port when that is nearly so; empty canvas leaves an open
   * end -- a tee with one line on it, drawn hollow, to be picked up later (see
   * JunctionNode). A drag let go back on its own symbol, or one too short to
   * mean anything, draws nothing, and a drag out of a port that already has a
   * line is a branch pulled out of that line. See drop.ts.
   */
  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const started = connectingFrom.current;
    connectingFrom.current = null;
    if (readOnlyRef.current) return;
    // A carried end is onReconnectEnd's: nothing here may tee, or leave an
    // open end at, the end that stays.
    if (started?.reconnect) return;
    // Joined already, to a port the validator allowed.
    if (state.isValid) return;
    const from = state.fromNode && state.fromHandle?.id
      ? { nodeId: state.fromNode.id, handleId: state.fromHandle.id }
      : started;
    if (!from?.handleId) return;
    const client = clientOf(event);
    const at = screenToFlowPosition(client, { snapToGrid: false });
    const scene = dropScene();
    const plan = resolveDrop(
      { kind: 'port', nodeId: from.nodeId, handle: from.handleId }, at, underPointer(client, at, scene, state.toHandle), scene);
    const made = commitDrop(plan, scene);
    if (made) commitGraph(made.nodes, made.edges);
  }, [screenToFlowPosition, commitGraph, dropScene, underPointer]);

  /**
   * A line pulled out of a line, or out of a tee's ring, let go somewhere.
   *
   * By the same rules as a port drag (drop.ts). The line it was pulled out of
   * is teed where the pull began, or level with where it went when that is
   * nearly so; a tee's ring gives it the tee's free face across its run, or,
   * with that face taken, a new tee on the run beside it.
   */
  const onBranchDrop = useCallback((source: BranchSource, at: Pt, client: { x: number; y: number }) => {
    if (readOnlyRef.current) return;
    const scene = dropScene();
    const made = commitDrop(resolveDrop(source, at, underPointer(client, at, scene), scene), scene);
    if (made) commitGraph(made.nodes, made.edges);
  }, [commitGraph, dropScene, underPointer]);

  /**
   * Carrying a line's end to another port.
   *
   * Grab a line by its end at a symbol's port and drag, and the end goes where
   * it is let go: the same line, keeping its id, its bore, its length, its
   * fittings and its sketch, only re-pointed -- and without its corners, which
   * were drawn to where the end was. Before this the only way to move an end
   * was to delete the line and draw it again, and everything typed into it
   * went too. A tee's ends are not offered (`reconnectableEnds`, on the view):
   * a tee's end is where its pipe runs through it.
   *
   * React Flow runs it as a drag out of the end that stays, and the validator
   * refuses that end, since the carried line is on it -- so where the end
   * lands is always the resolver's, as it is for any drop: a free port takes
   * it, a port that has a line tees that line, a body gives its best free
   * port, a tee its free face, a line a new tee. Let go on nothing, back where
   * it was, or on its own pipe, and the line is left as it was.
   */
  const onReconnectStart = useCallback((_e: unknown, edge: Edge, handleType: HandleType) => {
    // `handleType` is the end that stays: the one React Flow drags from.
    const stays = handleType === 'source'
      ? { nodeId: edge.source, handleId: edge.sourceHandle ?? null }
      : { nodeId: edge.target, handleId: edge.targetHandle ?? null };
    connectingFrom.current = { ...stays, reconnect: edge.id };
  }, []);

  const onReconnect = useCallback((edge: Edge, connection: Connection) => {
    if (readOnlyRef.current) return;
    setEdges(eds => reconnectLine(eds, edge.id, connection));
  }, [setEdges]);

  const onReconnectEnd = useCallback((
    event: MouseEvent | TouchEvent, edge: Edge, handleType: HandleType, state: FinalConnectionState,
  ) => {
    if (readOnlyRef.current || state.isValid) return;
    const stays = state.fromNode && state.fromHandle
      ? { nodeId: state.fromNode.id, handle: state.fromHandle.id ?? null }
      : null;
    const client = clientOf(event);
    const at = screenToFlowPosition(client, { snapToGrid: false });
    const scene = dropScene();
    const plan = resolveDrop(
      { kind: 'reconnect', edgeId: edge.id, moving: reconnectMoving(edge, handleType, stays) },
      at, underPointer(client, at, scene, state.toHandle), scene);
    const made = commitDrop(plan, scene);
    if (made) commitGraph(made.nodes, made.edges);
  }, [screenToFlowPosition, commitGraph, dropScene, underPointer]);

  /**
   * The line whose end is being carried, while one is: what the connection
   * line's preview needs to draw a carry as the carry it is, not as a new
   * line out of the end that stays.
   */
  const carried = useCallback(() => connectingFrom.current?.reconnect ?? null, []);

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
    // No edge, because a probe carries no flow -- see attach.ts. A line is hit
    // as it is drawn, the same test a valve or a transducer dropped on one
    // uses, and the probe keeps how far along the line it landed so its
    // leader lands there too.
    const host = isInstrument(type)
      ? clipAt(flowPos, snapshot.current.nodes, snapshot.current.edges, undefined, pageRef.current, drawnLines())
      : null;
    // Stand the probe clear of what it is measuring. Dropped exactly where the
    // pointer was, it covers the symbol it is attached to -- and the whole
    // point of attaching rather than connecting is that the drawing gets
    // easier to read, not harder.
    if (host) position = clearOfHost(host, position, snapshot.current.nodes, snapshot.current.edges, host.at);

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
          ...(host ? { attachedTo: host.id, ...(host.at !== undefined ? { attachedAt: host.at } : {}) } : {}),
          page,
        } as PIDNodeData;
    // Allocated outside the updater: React invokes updaters twice in
    // development, and an id minted inside one is neither pure nor stable.
    const id = nextNodeId();

    // A valve, a regulator or a disconnect let go on a line goes into it; a
    // transducer or a gauge taps it. It used to land on top of the line,
    // unconnected, and the next four gestures were the ones that made it
    // part of the run. See `partOnLine`.
    const onLine = partOnLine(
      snapshot.current, drawnLines(), flowPos,
      { id, type, position: flowPos, data: nodeData as unknown as Record<string, unknown> },
      { endOf: endOfClear, obstacles: obstaclesRef.current, page: pageRef.current });
    if (onLine) { commitGraph(onLine.nodes, onLine.edges); return; }

    // Through `commitGraph` like a part let go on a line, not a functional
    // updater: this handler's two branches have to agree about how they
    // write, or two drops in one batch see different states and the absolute
    // one wins.
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
  }, [screenToFlowPosition, commitGraph, page, endOfClear]);

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
   * Deleting keeps pipes whole.
   *
   * A tee is a point *in* a pipe, not a component of its own -- so taking one
   * out leaves the pipe, exactly as putting one in left it, and the lines of
   * its branches go with it. Taking a branch away leaves a tee with nothing
   * but its run, which is dissolved back into one line when the two halves
   * agree about what kind of pipe it is (a tee between a half inch and a
   * quarter inch is a real reducer, and stays); a junction left with no
   * lines at all goes. Every healed line gets an id nothing else has, and
   * probes clipped to what it replaces follow it. See `afterDelete`.
   *
   * Built from what React Flow says it deleted, against the drawing as it
   * was: by the time this runs React Flow has already queued the removal of
   * every line on a deleted node, so the lines left in state have nothing to
   * rejoin. What this hands over replaces that removal; when there is nothing
   * to heal, the removal stands as it is.
   */
  const onDelete = useCallback(({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
    if (readOnlyRef.current) return;
    // The old lines as they were drawn, so a probe clipped to one lands on
    // the healed line where it was on the pipe.
    const drawn = drawnCorners();
    // React Flow's own lines carry the view's marks (`viewEdges`); a line
    // healed from one would keep them. The drawing's own, by id.
    const mine = new Map(snapshot.current.edges.map(e => [e.id, e]));
    const gone = edges.map(e => mine.get(e.id) ?? e);
    const after = afterDelete(snapshot.current, { nodes, edges: gone }, { old: id => drawn.get(id) });
    if (after.healed) commitGraph(after.nodes, after.edges);
  }, [commitGraph]);

  /**
   * A drag begins: note where every tee it does not pick up is, so each tick
   * puts them on their pipes from there, and what is dragged is in the way
   * only of what it drags; and the drawing as it is, lines and all, so a
   * pipe it carries whole is put down exactly as it was picked up
   * (`Dragging`).
   */
  const onNodeDragStart = useCallback((_e: MouseEvent | TouchEvent, node: Node, dragged: Node[]) => {
    if (readOnlyRef.current) return;
    dragRef.current = dragging(
      snapshot.current.nodes, (dragged.length ? dragged : [node]).map(n => n.id), snapshot.current.edges);
  }, []);

  /**
   * Letting go of what was dragged lines it up with what it is connected to.
   *
   * The grid cannot do this and never could: a valve is sixty wide so its
   * centre port is thirty from the origin, an engine is seventy-two so its top
   * port is at thirty-six, and both origins snap to ten -- so those two ports
   * were six apart at every position either could be put in. See `snap.ts`,
   * for why only a connection is lined up with, and only a port facing the
   * same way.
   *
   * Read off ReactFlow's own measured handle bounds rather than a table of
   * where each symbol keeps its ports: it already knows, it stays right when a
   * symbol is turned or its port count changes, and a second copy of that
   * geometry is a second thing to get wrong.
   *
   * The shift moves everything that belongs to what moved -- the tees riding
   * a pipe both of whose ends moved, picked up or not (`carriedWith`), the
   * corners of lines both of whose ends moved, and the probes clipped to it
   * -- and then the drawing is reseated once more, whatever happened during
   * the drag, so what is let go of is a settled drawing.
   */
  const onNodeDragStop = useCallback((
    _e: MouseEvent | TouchEvent, node: Node, dragged: Node[],
  ) => {
    // The drag is over, whatever happens next: the drawing let go of is
    // settled whole, round everything on it.
    dragRef.current = null;
    if (readOnlyRef.current) return;
    const portsOf: PortsOf = n => getInternalNode(n.id)?.internals.handleBounds?.source?.map(h => ({
      id: h.id ?? '', ...handleCentre(n.position, h),
    }));
    // Everything that moved, against everything that did not -- so a symbol
    // never lines itself up with one it is being dragged alongside. A tee the
    // selection left out on a pipe it carried whole moved too, and is lined
    // up with the rest of its bay rather than left the shift behind it.
    const picked = (dragged.length ? dragged : [node]).map(n => n.id);
    let moving = new Set(picked);
    const here = pageRef.current;
    // Worked out in the nodes updater, on the positions the drag left, and
    // applied to the lines after it (React runs the nodes' updater first).
    let delta: Pt | null = null;
    setNodes(nds => {
      moving = carriedWith(nds, snapshot.current.edges, picked);
      const snap = snapOnDrop(nds, snapshot.current.edges, moving, portsOf, here);
      delta = snap.shift.dx || snap.shift.dy ? { x: snap.shift.dx, y: snap.shift.dy } : null;
      return snap.nodes;
    });
    setEdges(eds => (delta ? translateSubgraph([], eds, moving, delta).edges : eds));
    settleAgain();
  }, [getInternalNode, setNodes, setEdges, settleAgain]);

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
      setNodes(nds => nds.map(n => {
        if (n.id !== subject.id) return n;
        const data = { ...n.data, ...common, label: patch.label, fluid: patch.fluid };
        // A turned manifold grows from the corner behind its feed, so a new
        // outlet count or direction moves the node to keep the feed and the
        // outlets already wired where they were. See `manifoldShift`.
        const shift = (data as unknown as PIDNodeData).componentType === 'MANIFOLD'
          ? manifoldShift(n.data as unknown as PIDNodeData, data as unknown as PIDNodeData)
          : null;
        return shift
          ? { ...n, data, position: { x: n.position.x + shift.x, y: n.position.y + shift.y } }
          : { ...n, data };
      }));
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
      <ToolProvider tool={tool} onDone={disarm}>
      <FluidProvider nodes={nodes} edges={edges}>
      {/* The drop handlers' own lookups, lent to the previews, so what a drag
          shows is what letting go of it makes. */}
      <BranchDragProvider readOnly={readOnly} onDrop={onBranchDrop} scene={dropScene} under={underPointer} carrying={carried}>
      <ReactFlow
        nodes={view.nodes} edges={viewEdges}
        onNodesChange={handleNodesChange} onEdgesChange={onLinesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart} onConnectEnd={onConnectEnd}
        onReconnectStart={onReconnectStart}
        // React Flow draws a line's carry anchors whenever it has this and the
        // line is marked (`reconnectableEnds`), whatever `edgesReconnectable`
        // says: a viewer gets none.
        onReconnect={readOnly ? undefined : onReconnect}
        onReconnectEnd={onReconnectEnd}
        // The anchor a line's end is carried by, kept to half a grid step: it
        // is given the press by stacking, not by distance, and React Flow's
        // ten reached the next line's centreline (see CARRY_RADIUS).
        reconnectRadius={CARRY_RADIUS}
        // React Flow joins two ports by itself only when the drop is right on
        // a free one of another symbol; the rest is the resolver's (drop.ts).
        // Its own radius took any port within twenty pixels -- the end of the
        // line being let go on, a tee's face, the symbol's own other port --
        // and a stray click armed a connection that the next click on a port
        // completed, with nothing on screen to say it was pending.
        isValidConnection={isValidConnection}
        connectOnClick={false}
        connectionRadius={2}
        // The line a port drag will draw, to where it will go, instead of
        // React Flow's curve to the pointer (ConnectionLine.tsx).
        connectionLineComponent={ConnectionLine}
        onDrop={onDrop} onDragOver={onDragOver}
        onEdgeContextMenu={onEdgeContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onNodeClick={onNodeClick}
        onNodeDragStart={onNodeDragStart}
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
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-border)" />
        {/* The page's view, as VentLayer gets it: another page's leaders are
            hidden with their probes, not drawn over this one. */}
        <DrawnRoutes><AttachmentLayer nodes={view.nodes} edges={view.edges} /></DrawnRoutes>
        <VentLayer nodes={view.nodes} edges={view.edges} />
        <BranchPreview />
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
            Pull from a port or a line to draw · Click a line to reshape it · Drop a valve on a line to put it in · R rotates
          </span>
        </Panel>
      </ReactFlow>
      </BranchDragProvider>
      </FluidProvider>
      </ToolProvider>
      </div>

      <PageBar
        pages={pages}
        current={page}
        count={(p) => nodes.filter(n => pageOf(n.data as unknown as PIDNodeData) === p).length}
        // Leaving a page leaves its selection behind, cleared: what R,
        // Backspace, Cmd+C and Cmd+D act on has to be something on screen.
        onSelect={(p) => {
          if (p !== pageRef.current) {
            setNodes(clearSelection);
            setEdges(clearSelection);
          }
          setPage(p);
        }}
        // Scoped by page, not by the `hidden` flag: that flag lives on the
        // rendered view, so counting it here would offer to move a selection
        // made on a page you have since left.
        selectedCount={selectedHere.length}
        onMoveSelection={(to) => {
          if (readOnlyRef.current || selectedHere.length === 0) return;
          const ids = new Set(selectedHere.map(n => n.id));
          setNodes(nds => moveToPage(nds, ids, to));
        }}
        // A new page is somewhere else too: nothing selected comes along.
        onAdd={(name) => {
          setDeclaredPages(ps => [...ps, name]);
          setNodes(clearSelection);
          setEdges(clearSelection);
          setPage(name);
        }}
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
            ? 'Click a line to put a tee on it, or press Escape'
            : 'Tee: click a line to put a branch point on it (or Alt-click the line)'}
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
          // The checks see every page, so what a check names can be on a
          // page other than this one. Picking it goes there, and selects only
          // what is on that page -- a line no page draws by the component it
          // leaves from there (see selectOnPage).
          const there = pageOfSubjects(nodes, edges, nodeIds, edgeIds) ?? pageRef.current;
          setNodes(nds => selectOnPage(nds, edges, there, nodeIds, edgeIds).nodes);
          setEdges(eds => selectOnPage(nodes, eds, there, nodeIds, edgeIds).edges);
          // What to frame is what was picked on that page, never a named
          // component on another: that one is hidden, and centring on it
          // shows empty canvas.
          const first = selectOnPage(nodes, edges, there, nodeIds, edgeIds).nodes.find(n => n.selected);
          if (there !== pageRef.current) {
            // Arriving on a page puts back the view it was left at, which
            // need not show what was picked; forgetting it frames the whole
            // page on arrival instead, and what was picked is on it.
            // Centring here would race that and lose.
            viewportsRef.current.delete(`${diagramKey}::${there}`);
            setPage(there);
          } else if (first) {
            void fitViewTo(first);
          }
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

