/**
 * The drawing, full width, zoomable, live.
 *
 * Drawn by pid-designer's own canvas, from the document pid-designer saved, so
 * it is the same drawing as in the editor: the same symbols, ports, rotation,
 * routing, colours and pages. feed-twin adds only what the stand is doing
 * (`LiveLayer`) and the DAQ box's cables (`HookupOverlay`). Values on it are
 * the session's, so a shut valve reads what a shut valve reads and an empty
 * tank reads atmosphere. Clicking a valve takes it by hand.
 *
 * Beside it, one of two panels on the same hookup (lib/useHookup), so
 * switching between them changes nothing:
 *
 * - Symbols (DrawingPanel): what the console shows and calls each symbol,
 *   every number and the team's overrides of them. Clicking a symbol opens
 *   it there, ringed on the drawing; a valve is operated as well, and its
 *   card says what it is wired to.
 * - DAQ box (DaqBox): the boards of GX12 connectors. Drag an empty one onto a
 *   symbol, or click it and then the symbol, to cable it; clicking a cabled
 *   symbol opens its connector.
 *
 * With either panel open, each cabled symbol carries its connector and, room
 * allowing, its name ("S12·1 LOX Main").
 *
 * `/pid?symbol=<id>` opens on that symbol.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DrawingView } from '@pid/DrawingView';
import { listPages } from '@pid/pages';
import { getDrawing } from '../api';
import type { BoardId, Drawing } from '../api';
import { DaqBox, type Drawn, plugIn } from '../components/DaqBox';
import { DrawingPanel } from '../components/DrawingPanel';
import { HookupSaveBar } from '../components/HookupSaveBar';
import { HookupOverlay } from '../components/HookupOverlay';
import { LiveLayer } from '../components/LiveLayer';
import { BOARD_KEY, DAQ_UI, type DaqUi, createStore } from '../lib/daqDrag';
import { channelOf } from '../lib/hookupDraft';
import { useHookup } from '../lib/useHookup';
import { useStand } from '../stand';

const PANEL_KEY = 'feedtwin.pid.panel';
const MODE_KEY = 'feedtwin.pid.panelMode';

type Mode = 'symbols' | 'daq';

function recall(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function keep(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; the choice still holds for this tab.
  }
}

export function Pid() {
  const { model, live, where, artifacts, toggleValve } = useStand();
  const hookup = useHookup();
  const [params] = useSearchParams();
  // The drawing is shown whether or not the stand runs: one the solver
  // cannot assemble is still a drawing somebody needs to look at.
  const diagram = where.diagram;
  const [drawing, setDrawing] = useState<{ id: string; doc: Drawing } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState(() => recall(PANEL_KEY) !== 'closed');
  const [mode, setModeState] = useState<Mode>(() => (recall(MODE_KEY) === 'daq' ? 'daq' : 'symbols'));
  /** The symbol open in the Symbols panel, ringed on the drawing. */
  const [focus, setFocus] = useState<string | null>(null);
  /** The page shown: the view's own tabs, and the page a symbol is on when
   *  one is opened from the panel. */
  const [page, setPage] = useState('');
  /** What the DAQ box and the drawing share while a cable is drawn. */
  const [ui] = useState(() => createStore<DaqUi>({ ...DAQ_UI, board: recall(BOARD_KEY) as BoardId | null }));
  const canvas = useRef<HTMLDivElement>(null);

  // The twin's guess at a just-plugged cable's name is a guess until the
  // hookup is saved or discarded; after that the name is the user's, and
  // renaming it renames its state-table row like any other.
  const dirty = hookup.dirty;
  useEffect(() => {
    if (!dirty) ui.set({ fresh: null });
  }, [dirty, ui]);

  const openPanel = (open: boolean) => {
    setPanel(open);
    keep(PANEL_KEY, open ? 'open' : 'closed');
    if (!open) ui.set({ armed: null, picked: null, hover: null });
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
  // Every symbol takes a click: a valve is operated, anything else opens in
  // the panel.
  const symbols = useMemo(() => new Set(drawing?.doc.nodes.map((n) => n.id) ?? []), [drawing]);
  const drawn: Drawn = useMemo(
    () =>
      new Map(
        (drawing?.doc.nodes ?? []).map((n) => {
          const d = n.data as { label?: string; componentType?: string; page?: string } | undefined;
          return [n.id, { tag: d?.label || n.id, type: d?.componentType ?? n.type ?? '', page: d?.page || 'Main' }];
        }),
      ),
    [drawing],
  );
  const pages = useMemo(() => listPages(drawing?.doc.nodes ?? []), [drawing]);
  const held = useMemo(() => new Set(live?.held), [live?.held]);
  const lines = useMemo(() => drawing?.doc.edges.map((e) => e.id) ?? [], [drawing]);

  /** Put up the page a symbol is on. */
  const pageOf = useCallback(
    (id: string) => {
      const p = drawn.get(id)?.page;
      if (p) setPage(p);
    },
    [drawn],
  );
  /** ... and bring it into view (HookupOverlay does, once it is drawn). */
  const showSymbol = useCallback(
    (id: string) => {
      pageOf(id);
      ui.set((s) => ({ show: { id, n: (s.show?.n ?? 0) + 1 } }));
    },
    [pageOf, ui],
  );

  /** Open a symbol in the DAQ box: its connector if it has one, else wait
   *  for one to be clicked. False when the box has nothing for it. */
  const toConnector = (id: string): boolean => {
    const ch = hookup.draft ? channelOf(hookup.draft, id) : undefined;
    if (ch) {
      ui.set({ board: ch.board, selected: { board: ch.board, slot: ch.slot }, armed: null, picked: null, note: null });
      return true;
    }
    const sym = hookup.symbol(id);
    if (!sym || hookup.locked) return false;
    ui.set({ board: sym.board, picked: id, selected: null, armed: null, note: null });
    return true;
  };

  /** Switch panels, carrying what is open across: the same hookup, shown the
   *  other way. */
  const setMode = (next: Mode) => {
    setModeState(next);
    keep(MODE_KEY, next);
    const s = ui.get();
    if (next === 'symbols') {
      const open = s.selected && hookup.draft
        ? hookup.draft.channels.find((c) => c.board === s.selected!.board && c.slot === s.selected!.slot)
        : undefined;
      if (open) setFocus(open.symbol);
      // Carried across as focus: left selected, it would ring a second symbol.
      ui.set({ selected: null, armed: null, picked: null, hover: null, drag: null, target: null });
    } else if (focus && hookup.draft && channelOf(hookup.draft, focus)) {
      toConnector(focus);
    }
  };

  const openSymbol = (id: string) => {
    setFocus(id);
    if (!panel) openPanel(true);
  };

  const onSymbol = (id: string) => {
    if (mode === 'daq') {
      const armed = ui.get().armed;
      if (armed && panel) {
        plugIn(hookup, ui, armed, id, drawn);
        return;
      }
      if (toConnector(id)) {
        if (!panel) openPanel(true);
        return;
      }
      if (valves.has(id)) return toggleValve(id);
      // Not on the box: the Symbols panel has it.
      setMode('symbols');
      openSymbol(id);
      return;
    }
    if (!valves.has(id)) return openSymbol(id);
    toggleValve(id);
    // Operated, and its card open beside it: what it is wired to and named.
    if (panel) setFocus(id);
  };
  // The canvas keeps one click handler; it calls the latest.
  const click = useRef(onSymbol);
  useEffect(() => {
    click.current = onSymbol;
  });
  const onSymbolClick = useCallback((id: string) => click.current(id), []);

  // `/pid?symbol=<id>`: open on that symbol, once the drawing (and, for the
  // DAQ box, the hookup) is in.
  const wanted = params.get('symbol');
  const handled = useRef<string | null>(null);
  const ready = Boolean(drawing && drawing.id === diagram && (mode === 'symbols' || hookup.draft));
  useEffect(() => {
    if (!wanted || handled.current === wanted || !ready || !drawn.has(wanted)) return;
    handled.current = wanted;
    if (!panel) openPanel(true);
    if (mode === 'symbols' || !toConnector(wanted)) {
      if (mode === 'daq') setMode('symbols');
      setFocus(wanted);
    }
    showSymbol(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, ready, drawn]);

  if (error) return <p className="p-6 text-sm text-red-400">{error}</p>;
  if (!drawing || drawing.id !== diagram) {
    return <p className="p-6 text-sm text-text-muted">Loading…</p>;
  }
  const title = stand?.title ?? artifacts.find((a) => a.id === diagram)?.name ?? '';
  const running = Boolean(stand && live);
  const daq = panel && mode === 'daq';
  const shownPage = pages.includes(page) ? page : pages[0];

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-baseline gap-3 px-4 py-2">
        <span className="caps">
          {title}
        </span>
        {running && live && <span className="font-mono text-[12px] text-blue-400">{live.state}</span>}
        <span
          className="cursor-help text-[11.5px] text-gray-600"
          title={`Scroll to zoom, drag to pan. ${
            daq
              ? 'Click a symbol for its connector.'
              : running
                ? 'Click a valve to operate it; any other symbol opens in the panel.'
                : 'Click a symbol to open it in the panel.'
          }`}
        >
          {running ? 'psig' : 'not running'}
        </span>
        {live?.setup?.ignore_gse && pages.length > 1 && (
          // The cart's page still draws; nothing on it is simulated.
          <Link
            to="/gse"
            className="rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] text-[var(--ink-2)] hover:text-[var(--ink)]"
            title="Ignore the drawn GSE is on: the stand is the rocket and the cart's vent lines, which stay plugged in until launch. The rest of the cart's page is drawn here but not simulated -- its valves do nothing and its gauges read nothing. Turn it off on GSE Controls."
          >
            GSE not simulated · vents are
          </Link>
        )}
        <button
          type="button"
          onClick={() => openPanel(!panel)}
          aria-expanded={panel}
          title={mode === 'daq' ? 'The DAQ box' : 'Symbols: what each one is wired to, called and set to'}
          className="ml-auto rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ink-2)] hover:text-[var(--ink)]"
        >
          {panel ? 'Hide panel' : 'Show panel'}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        <div
          ref={canvas}
          className="pid-drawing h-full min-w-0 flex-1 overflow-hidden rounded-lg border border-gray-800"
        >
          <DrawingView
            nodes={drawing.doc.nodes}
            edges={drawing.doc.edges}
            onSymbolClick={onSymbolClick}
            clickable={symbols}
            page={shownPage}
            onPageChange={setPage}
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
                focus={panel && mode === 'symbols' ? focus : null}
              />
            )}
            <HookupOverlay
              ui={ui}
              badges={panel}
              readings={running}
              ring={panel && mode === 'symbols' && !running ? focus : null}
            />
          </DrawingView>
        </div>
        {panel && (
          <aside className="bg-card flex h-full w-[400px] max-w-[45%] flex-shrink-0 flex-col overflow-hidden rounded-lg border border-[var(--line)]">
            <div className="flex flex-shrink-0 border-b border-[var(--line)]" role="tablist" aria-label="Panel">
              {(
                [
                  ['symbols', 'Symbols', 'Every symbol on the drawing: where it is wired on the DAQ box, what the console calls it, the states that open it, and the numbers the model uses. Overrides stay in feed-twin and never touch the drawing in pid-designer; they are shared with everyone and follow the drawing when it is re-imported.'],
                  ['daq', 'DAQ box', 'The boards of connectors: which valve or sensor each one is cabled to'],
                ] as const
              ).map(([m, label, hint]) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  title={hint}
                  className={`flex-1 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest ${
                    mode === m
                      ? 'bg-white/[0.05] text-[var(--ink)]'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              {mode === 'symbols' ? (
                <DrawingPanel
                  focus={focus}
                  onFocus={(id) => {
                    setFocus(id);
                    // A card opened from the list shows its symbol's page.
                    if (id) pageOf(id);
                  }}
                  ui={ui}
                />
              ) : (
                <DaqBox ui={ui} canvas={canvas} drawn={drawn} onShow={showSymbol} onPage={pageOf} />
              )}
            </div>
            {/* One bar for both tabs, in one place: they edit one draft. */}
            <div className="flex-shrink-0 px-3 pb-2 empty:hidden">
              <HookupSaveBar compact />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
