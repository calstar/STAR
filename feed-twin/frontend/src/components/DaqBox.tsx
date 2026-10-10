/**
 * The hookup as the DAQ box: one board at a time, its GX12 connectors five to
 * a row, each empty or cabled to a symbol on the drawing.
 *
 * A cable is drawn the way a person would make one: from an empty connector
 * to the thing on the drawing it goes to (or click the connector, then the
 * symbol). The cable's name is asked for straight away -- "LOX Main" -- and on
 * a solenoid board that name is the state table's row, so the valve opens
 * where that row says. Dragging a plugged connector onto another moves the
 * cable (onto a plugged one, the two swap).
 *
 * It edits the same draft as the Symbols panel (lib/useHookup), so switching
 * between the two changes nothing. What the drawing shows of it -- the ring
 * under a cable being drawn, the badges on cabled symbols -- is
 * HookupOverlay's, fed by the small store both share (lib/daqDrag).
 */

import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import type { BoardDef, BoardId, ChannelDef, HookupSymbol, SymbolKind } from '../api';
import {
  BOARD_KEY,
  type DaqUi,
  type Slot,
  type Store,
  badge,
  boardOption,
  canDropRow,
  clashNote,
  connectorUnder,
  dropFreshRow,
  pastClick,
  sameKind,
  sameSlot,
  slotsOf,
  symbolUnder,
  verdict,
} from '../lib/daqDrag';
import {
  type Draft,
  channelAt,
  channelOf,
  freeSlot,
  isValveBoard,
  move,
  nameHint,
  rename,
  rowsOf,
  setRows,
  unwire,
  unwireAll,
  unwiredRows,
  wire,
} from '../lib/hookupDraft';
import { type HookupApi, useHookup } from '../lib/useHookup';
import { useStand } from '../stand';
import { Gx12, type Gx12Mark } from './Gx12';
import { HookupStatus, ReadOnly, confirmReset } from './HookupSaveBar';
import { OpensIn } from './OpensIn';

const FOCUS = '#60A5FA';

/** Every drawn symbol's tag, type and page, read off the drawing itself:
 *  what a refusal names and where "Show" turns to. */
export type Drawn = ReadonlyMap<string, { tag: string; type: string; page: string }>;

/** Read the shared DAQ box state; re-renders only when `pick` changes. */
export function useDaqUi<T>(store: Store<DaqUi>, pick: (s: DaqUi) => T): T {
  return useSyncExternalStore(store.subscribe, () => pick(store.get()));
}

/**
 * Cable symbol `id` to the connector `at` -- from a drag let go on it, or a
 * click on it while a connector waits. A symbol already on the box moves
 * here with its name; a new one takes the name the twin's own matching gives
 * it. Then the connector is opened with its name ready to type over.
 * Refused (with the reason, under the board) when it does not suit the board.
 */
export function plugIn(hookup: HookupApi, ui: Store<DaqUi>, at: Slot, id: string, drawn: Drawn): boolean {
  const draft = hookup.draft;
  if (!draft || hookup.locked) return false;
  const symbol = hookup.symbol(id);
  const v = verdict(hookup.board(at.board), symbol, drawn.get(id));
  if (!v.ok || !symbol) {
    ui.set({ note: { text: v.ok ? 'That does not plug in here' : v.why, bad: true } });
    return false;
  }
  const there = channelAt(draft, at.board, at.slot);
  if (there && there.symbol !== id) {
    ui.set({ note: { text: `${badge(at)} already goes to ${hookup.label(there.symbol)}`, bad: true } });
    return false;
  }
  const before = channelOf(draft, id);
  const name = before ? undefined : hookup.suggestedName(id);
  // A name the table has no row for gets one; remember it, so naming the
  // connector onto an existing row a moment later does not leave it behind.
  const made = wire(draft, symbol, at.board, at.slot, name).machine.actuators.find(
    (a) => !draft.machine.actuators.includes(a),
  );
  hookup.update((d) => wire(d, symbol, at.board, at.slot, name));
  ui.set((s) => ({
    board: at.board,
    selected: at,
    armed: null,
    picked: null,
    drag: null,
    target: null,
    over: null,
    naming: s.naming + 1,
    // Just plugged and named by the twin, not by a person: renaming it now
    // corrects the guess rather than renaming the table's row.
    fresh: before ? (s.fresh?.symbol === id ? s.fresh : null) : { symbol: id, row: made ?? null },
    note:
      before && !sameSlot(before, at) ? { text: `${symbol.label} moved here from ${badge(before)}`, bad: false } : null,
  }));
  return true;
}

const KIND_WORD: Record<SymbolKind, string> = { valve: 'valve', pt: 'PT', rtd: 'RTD', tc: 'TC' };
const KIND_PLURAL: Record<SymbolKind, string> = { valve: 'Valves', pt: 'PTs', rtd: 'RTDs', tc: 'TCs' };

interface Press {
  slot: number;
  filled: boolean;
  x0: number;
  y0: number;
  started: boolean;
}

export function DaqBox({
  ui,
  canvas,
  drawn,
  onShow,
  onPage,
}: {
  ui: Store<DaqUi>;
  /** The drawing: where a cable can be let go. */
  canvas: RefObject<HTMLElement | null>;
  drawn: Drawn;
  /** Put a symbol's page up and bring it into view. */
  onShow: (id: string) => void;
  /** Put up the page a symbol is on. */
  onPage: (id: string) => void;
}) {
  const hookup = useHookup();
  const { live, setup } = useStand();
  const s = useDaqUi(ui, (x) => x);
  const { draft, boards, locked } = hookup;
  const rocketOnly = Boolean(live?.setup?.ignore_gse ?? setup.ignore_gse);
  const boardId: BoardId | undefined = boards.some((b) => b.id === s.board) ? (s.board ?? undefined) : boards[0]?.id;
  const def = boardId ? hookup.board(boardId) : undefined;

  // ------------------------------------------------------------ the drag
  const press = useRef<Press | null>(null);
  const frame = useRef(0);
  const pointer = useRef({ x: 0, y: 0 });
  const band = useRef<SVGLineElement | null>(null);
  const tip = useRef<SVGCircleElement | null>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const latest = useRef({ hookup, drawn, def, boardId });
  useEffect(() => {
    latest.current = { hookup, drawn, def, boardId };
  });

  const onDrawing = (el: unknown) => Boolean(canvas.current && el instanceof Node && canvas.current.contains(el));
  const typeOf = (id: string) => latest.current.drawn.get(id)?.type;

  /** One frame of a drag: the band follows the pointer, and whatever is
   *  under it is reported only when it changes. */
  const track = () => {
    frame.current = 0;
    const p = press.current;
    if (!p?.started) return;
    const { x, y } = pointer.current;
    band.current?.setAttribute('x2', String(x));
    band.current?.setAttribute('y2', String(y));
    tip.current?.setAttribute('cx', String(x));
    tip.current?.setAttribute('cy', String(y));
    const { hookup: h, drawn: dr, def: board, boardId: id } = latest.current;
    if (p.filled) {
      const c = connectorUnder(document, x, y);
      const over = c && c.board === id && c.slot !== p.slot ? c.slot : null;
      ui.set({ over });
      return;
    }
    const sym = symbolUnder(document, x, y, onDrawing, typeOf);
    const now = ui.get().target;
    const ok = sym ? verdict(board, h.symbol(sym), dr.get(sym)).ok : false;
    if (now?.id !== sym || (sym && now?.ok !== ok)) ui.set({ target: sym ? { id: sym, ok } : null });
  };

  const stop = () => {
    press.current = null;
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    setOrigin(null);
    ui.set({ drag: null, target: null, over: null });
  };

  const down = (e: ReactPointerEvent<HTMLDivElement>, slot: number) => {
    if (e.button !== 0 || !draft || !boardId) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = {
      slot,
      filled: Boolean(channelAt(draft, boardId, slot)),
      x0: e.clientX,
      y0: e.clientY,
      started: false,
    };
  };

  const moved = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || !boardId) return;
    if (!p.started) {
      if (locked || !pastClick(e.clientX - p.x0, e.clientY - p.y0)) return;
      p.started = true;
      const glyph = (e.currentTarget.querySelector('svg') ?? e.currentTarget).getBoundingClientRect();
      setOrigin({ x: glyph.left + glyph.width / 2, y: glyph.top + glyph.height / 2 });
      ui.set({ drag: { board: boardId, slot: p.slot, moving: p.filled }, armed: null, note: null, target: null });
    }
    pointer.current = { x: e.clientX, y: e.clientY };
    if (!frame.current) frame.current = requestAnimationFrame(track);
  };

  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p) return;
    if (!p.started) {
      press.current = null;
      click(p.slot);
      return;
    }
    stop();
    if (!boardId) return;
    const from = { board: boardId, slot: p.slot };
    if (p.filled) {
      const to = connectorUnder(document, e.clientX, e.clientY);
      if (!to || sameSlot(to, from)) return;
      if (!sameKind(hookup.board(from.board), hookup.board(to.board))) return;
      hookup.update((d) => move(d, from, to));
      ui.set({ selected: to, board: to.board, note: null });
      return;
    }
    const id = symbolUnder(document, e.clientX, e.clientY, onDrawing, typeOf);
    if (id) plugIn(hookup, ui, from, id, drawn);
  };

  /** A press that did not move. */
  const click = (slot: number) => {
    if (!draft || !boardId) return;
    const at = { board: boardId, slot };
    const now = ui.get();
    const ch = channelAt(draft, boardId, slot);
    if (ch) {
      const again = sameSlot(now.selected, at);
      ui.set({ selected: again ? null : at, armed: null, picked: null, note: null });
      if (!again) onPage(ch.symbol);
      return;
    }
    if (locked) return;
    // A symbol was clicked on the drawing first: this connector takes it.
    if (now.picked) {
      plugIn(hookup, ui, at, now.picked, drawn);
      return;
    }
    ui.set({ armed: sameSlot(now.armed, at) ? null : at, selected: null, note: null });
  };

  // Escape lets go of whatever is waiting -- a drag, a connector, a symbol
  // -- and with nothing waiting, closes the open connector.
  const waiting = Boolean(s.drag || s.armed || s.picked);
  const open = Boolean(s.selected);
  useEffect(() => {
    if (!waiting && !open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!waiting) {
        // A field's own Esc puts its text back; it does not close the card.
        if ((e.target as HTMLElement | null)?.closest('input, select, textarea')) return;
        ui.set({ selected: null });
        return;
      }
      press.current = null;
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      setOrigin(null);
      ui.set({ drag: null, target: null, over: null, armed: null, picked: null });
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [waiting, open, ui]);

  // A note says its piece and goes.
  useEffect(() => {
    if (!s.note) return;
    const note = s.note;
    const t = window.setTimeout(() => {
      if (ui.get().note === note) ui.set({ note: null });
    }, 5000);
    return () => window.clearTimeout(t);
  }, [s.note, ui]);

  // The cursor goes in a new cable's name, once its connector is open.
  const nameInput = useRef<HTMLInputElement | null>(null);
  const named = useRef(s.naming);
  useEffect(() => {
    if (s.naming === named.current || !nameInput.current) return;
    named.current = s.naming;
    nameInput.current.focus();
    nameInput.current.select();
  });

  useEffect(() => {
    if (!boardId) return;
    try {
      window.localStorage.setItem(BOARD_KEY, boardId);
    } catch {
      // The board still shows for this tab.
    }
  }, [boardId]);

  if (!draft || !boardId || !def) {
    return (
      <div className="p-3">
        <p className="text-[12px] text-gray-500">{hookup.error || 'Reading the hookup…'}</p>
      </div>
    );
  }

  const valveBoard = isValveBoard(boardId);
  const selected = s.selected?.board === boardId ? channelAt(draft, boardId, s.selected.slot) : undefined;
  const armed = s.armed?.board === boardId ? s.armed : null;
  const picked = s.picked ? hookup.symbol(s.picked) : undefined;
  const fold = (x: string) => x.trim().toLocaleLowerCase();

  const commitName = (symbol: string, text: string) => {
    const fresh = ui.get().fresh;
    const before = channelOf(draft, symbol)?.name;
    const guessed = fresh?.symbol === symbol;
    hookup.update((d) => {
      const next = rename(d, symbol, text, !guessed);
      return guessed ? dropFreshRow(next, fresh) : next;
    });
    // Named by a person now: the row is theirs.
    if (fresh?.symbol === symbol && before !== undefined && fold(before) !== fold(text)) ui.set({ fresh: null });
  };

  const unplug = (symbol: string) => {
    const fresh = ui.get().fresh;
    hookup.update((d) => {
      const next = unwire(d, symbol);
      return fresh?.symbol === symbol ? dropFreshRow(next, fresh) : next;
    });
    ui.set({ selected: null, hover: null, fresh: fresh?.symbol === symbol ? null : fresh });
  };

  const pickBoard = (id: BoardId) => ui.set({ board: id, selected: null, armed: null, hover: null, note: null });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-shrink-0 border-b border-[var(--line)] px-3 py-2">
        <div className="flex items-center gap-2">
          <select
            value={boardId}
            onChange={(e) => pickBoard(e.target.value as BoardId)}
            aria-label="Board"
            className="min-w-0 flex-1 rounded-md border border-gray-700 bg-black/60 px-2 py-1 text-[12px] text-white focus:border-blue-500 focus:outline-none"
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {boardOption(draft, b)}
              </option>
            ))}
          </select>
          <HookupStatus />
          <ReadOnly />
          <BoxMenu
            disabled={locked}
            saved={Boolean(hookup.data?.saved)}
            onUnplugAll={() => {
              if (!window.confirm('Unplug every connector on every board? The state table stays as it is.')) return;
              hookup.update(unwireAll);
              ui.set({ selected: null, armed: null, picked: null, fresh: null });
            }}
            onReset={() => {
              if (!confirmReset(hookup.onStand)) return;
              hookup.reset();
              ui.set({ selected: null, armed: null, picked: null, fresh: null });
            }}
          />
        </div>
        <p
          className="mt-1.5 text-[11px] leading-snug text-gray-500"
          title={
            'Or click an empty connector, then the symbol. ' +
            'Drag a plugged one onto another connector to move it there (onto a plugged one, the two swap). ' +
            '12 V/24 V and low/high PT are labels only: either board takes either.'
          }
        >
          Drag an empty connector onto a symbol. Click a plugged one to rename or unplug it.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div
          className="relative border border-[var(--line-strong)] bg-[#0d0d0d] px-2 pb-2 pt-3"
          title={def.label}
          onPointerLeave={() => !s.drag && ui.set({ hover: null })}
        >
          {/* The panel's screws, so it reads as the box's face. */}
          {['left-1 top-1', 'right-1 top-1', 'bottom-1 left-1', 'bottom-1 right-1'].map((at) => (
            <span key={at} className={`absolute ${at} h-1.5 w-1.5 rounded-full bg-[#2a2a2a]`} aria-hidden="true" />
          ))}
          <div className="grid grid-cols-5 gap-x-1 gap-y-2">
            {slotsOf(draft, boardId).map((slot) => {
              const ch = channelAt(draft, boardId, slot);
              const sym = ch ? hookup.symbol(ch.symbol) : undefined;
              const at = { board: boardId, slot };
              const isSelected = sameSlot(s.selected, at);
              const isArmed = sameSlot(s.armed, at);
              const dragging = s.drag && sameSlot(s.drag, at);
              const over = s.drag?.moving && s.over === slot;
              const mark: Gx12Mark = over
                ? 'ok'
                : isArmed
                  ? 'armed'
                  : isSelected || dragging
                    ? 'selected'
                    : null;
              const open = Boolean(ch && valveBoard && live?.open?.[ch.symbol]);
              return (
                <div
                  key={slot}
                  role="button"
                  tabIndex={0}
                  data-daq-board={boardId}
                  data-daq-slot={slot}
                  aria-label={ch ? `${badge(at)}: ${ch.name}` : `${badge(at)}: empty`}
                  aria-pressed={isSelected || isArmed}
                  title={
                    ch
                      ? `${ch.name} — ${sym?.label ?? ch.symbol}${sym ? ` (${sym.type})` : ''}. Click to rename or unplug; drag onto another connector to move it.`
                      : `${badge(at)} (${def.label}): empty. Drag it onto a ${KIND_WORD[def.kind]} on the drawing, or click it, then the symbol.`
                  }
                  onPointerDown={(e) => down(e, slot)}
                  onPointerMove={moved}
                  onPointerUp={up}
                  onPointerCancel={stop}
                  onPointerEnter={() => !s.drag && ui.set({ hover: ch?.symbol ?? null })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      click(slot);
                    }
                  }}
                  className={`relative flex min-w-0 touch-none select-none flex-col items-center px-0.5 pb-0.5 pt-2 outline-none focus-visible:bg-white/10 ${
                    isSelected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                  } ${locked ? 'cursor-pointer' : ch ? 'cursor-grab' : 'cursor-crosshair'}`}
                >
                  <span className="absolute left-0.5 top-0 font-mono text-[9px] leading-none text-gray-600">{slot}</span>
                  <Gx12 filled={Boolean(ch)} mark={mark} open={open} dim={locked} />
                  <span
                    className={`mt-0.5 w-full truncate text-center text-[10.5px] leading-tight ${ch ? 'text-gray-200' : 'text-transparent'}`}
                  >
                    {ch?.name ?? '·'}
                  </span>
                  <span
                    className={`w-full truncate text-center font-mono text-[9px] leading-tight ${ch ? 'text-gray-500' : 'text-transparent'}`}
                  >
                    {sym?.label ?? ch?.symbol ?? '·'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-1.5 flex items-center gap-1">
          <button
            type="button"
            disabled={locked}
            onClick={() => hookup.update((d) => setRows(d, boardId, rowsOf(d, boardId) + 1))}
            title="Another row of five connectors"
            className="rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] text-[var(--ink-2)] hover:text-[var(--ink)] disabled:opacity-40"
          >
            + row
          </button>
          <button
            type="button"
            disabled={locked || !canDropRow(draft, boardId)}
            onClick={() => hookup.update((d) => setRows(d, boardId, rowsOf(d, boardId) - 1))}
            title="Take away the last row (only an empty one, and never the first two)"
            className="rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] text-[var(--ink-2)] hover:text-[var(--ink)] disabled:opacity-40"
          >
            − row
          </button>
          {s.note && (
            <span
              className={`ml-1 min-w-0 flex-1 truncate text-[11px] ${s.note.bad ? 'text-red-300' : 'text-gray-400'}`}
              title={s.note.text}
            >
              {s.note.text}
            </span>
          )}
        </div>

        {picked && (
          <Waiting onCancel={() => ui.set({ picked: null })}>
            <span className="font-mono text-gray-200">{picked.label}</span>: click an empty connector to plug it in.
          </Waiting>
        )}
        {armed && !picked && (
          <Waiting onCancel={() => ui.set({ armed: null })}>
            {badge(armed)}: click a {KIND_WORD[def.kind]} on the drawing.
          </Waiting>
        )}

        {!selected && !armed && !picked && !locked && (
          <Unplugged
            symbols={hookup.symbols.filter((x) => x.kind === def.kind && !channelOf(draft, x.id))}
            boardLabel={def.label}
            kind={def.kind}
            onPlug={(id) => plugIn(hookup, ui, { board: boardId, slot: freeSlot(draft, boardId) }, id, drawn)}
          />
        )}

        {selected && (
          <Detail
            key={`${selected.board}:${selected.slot}`}
            channel={selected}
            draft={draft}
            def={def}
            boards={boards}
            hookup={hookup}
            drawn={drawn}
            rocketOnly={rocketOnly}
            inputRef={nameInput}
            carry={s.fresh?.symbol !== selected.symbol}
            onName={(text) => commitName(selected.symbol, text)}
            onShow={() => onShow(selected.symbol)}
            onUnplug={() => unplug(selected.symbol)}
            onMoveTo={(board) => {
              const from = { board: selected.board, slot: selected.slot };
              const to = { board, slot: freeSlot(draft, board) };
              hookup.update((d) => move(d, from, to));
              ui.set({ board, selected: to });
            }}
          />
        )}
      </div>

      {origin && s.drag && <Band origin={origin} ui={ui} line={band} tip={tip} />}
    </div>
  );
}

/** What this board could take and nothing has plugged in: one click puts it
 *  on the next free connector, for a symbol that is hard to find on the
 *  drawing. */
function Unplugged({
  symbols,
  boardLabel,
  kind,
  onPlug,
}: {
  symbols: HookupSymbol[];
  boardLabel: string;
  kind: SymbolKind;
  onPlug: (id: string) => void;
}) {
  if (symbols.length === 0) return null;
  // By page, in the drawing's order: a rocket valve and a cart valve with
  // the same look are told apart by where they are drawn.
  const pages = [...new Set(symbols.map((x) => x.page))];
  return (
    <div className="mt-3 border-t border-[var(--line)] pt-2">
      <div className="caps text-[10px]" title={`Click one to plug it into the next free connector on ${boardLabel}.`}>
        {KIND_PLURAL[kind]} not wired · {symbols.length}
      </div>
      {pages.map((page) => (
        <div key={page} className="mt-1.5">
          {pages.length > 1 && <div className="mb-0.5 text-[10px] text-gray-500">{page}</div>}
          <div className="flex flex-wrap gap-1">
            {symbols
              .filter((x) => x.page === page)
              .map((x) => (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => onPlug(x.id)}
                  title={`${x.label} (${x.type}, ${x.page}): plug into the next free connector`}
                  className="border border-[var(--line-strong)] px-1.5 py-px font-mono text-[10.5px] text-[var(--ink-2)] hover:border-[#5a5a5a] hover:text-[var(--ink)]"
                >
                  {x.label}
                </button>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A connector, or a symbol, waiting for its other end. */
function Waiting({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  return (
    <div className="mt-2 flex items-baseline gap-2 border border-dashed border-[#60A5FA]/50 px-2 py-1.5 text-[11.5px] text-gray-300">
      <span className="min-w-0 flex-1">{children}</span>
      <button type="button" onClick={onCancel} className="text-[11px] text-gray-500 hover:text-white" title="Or press Esc">
        Cancel
      </button>
    </div>
  );
}

/** The cable being drawn, from the connector to the pointer: over the whole
 *  page, so it can cross onto the drawing. Its end follows the pointer by
 *  hand (DaqBox's `track`), not by re-render. */
function Band({
  origin,
  ui,
  line,
  tip,
}: {
  origin: { x: number; y: number };
  ui: Store<DaqUi>;
  line: RefObject<SVGLineElement | null>;
  tip: RefObject<SVGCircleElement | null>;
}) {
  const target = useDaqUi(ui, (s) => s.target);
  const moving = useDaqUi(ui, (s) => s.drag?.moving ?? false);
  const over = useDaqUi(ui, (s) => s.over);
  const tone = moving
    ? over != null
      ? FOCUS
      : 'var(--ink-3)'
    : target
      ? target.ok
        ? FOCUS
        : 'var(--bad)'
      : 'var(--ink-2)';
  return createPortal(
    <svg
      aria-hidden="true"
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 60 }}
    >
      {/* x2/y2 and cx/cy never change as props, so React leaves the values
          `track` writes alone. */}
      <line
        ref={line}
        x1={origin.x}
        y1={origin.y}
        x2={origin.x}
        y2={origin.y}
        stroke={tone}
        strokeWidth={2}
        strokeDasharray="6 4"
        strokeLinecap="round"
      />
      <circle cx={origin.x} cy={origin.y} r={3} fill={tone} />
      <circle ref={tip} cx={origin.x} cy={origin.y} r={5} fill="none" stroke={tone} strokeWidth={2} />
    </svg>,
    document.body,
  );
}

/** The ⋯ at the top: the two things that change the whole box. */
function BoxMenu({
  disabled,
  saved,
  onUnplugAll,
  onReset,
}: {
  disabled: boolean;
  /** Something is saved to go back from. */
  saved: boolean;
  onUnplugAll: () => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const item =
    'block w-full px-3 py-1.5 text-left text-[12px] text-[var(--ink-2)] hover:bg-white/5 hover:text-[var(--ink)] disabled:opacity-40';
  return (
    <div ref={box} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="More"
        title="Unplug everything · Back to suggested"
        aria-expanded={open}
        className={`px-1 font-mono text-[14px] leading-none tracking-[0.1em] hover:text-[var(--ink-2)] ${
          open ? 'text-[var(--ink-2)]' : 'text-[var(--ink-4)]'
        }`}
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 border border-[var(--line-strong)] bg-[var(--color-bg-secondary)] py-1 shadow-[0_8px_24px_rgba(0,0,0,0.6)]">
          <button
            type="button"
            disabled={disabled}
            className={item}
            title="Every board empty; the state table is left as it is"
            onClick={() => {
              setOpen(false);
              onUnplugAll();
            }}
          >
            Unplug everything
          </button>
          <button
            type="button"
            disabled={disabled || !saved}
            className={item}
            title="Forget the whole saved hookup (the box, the edited state table, the knobs): the twin matches valves and sensors by name again"
            onClick={() => {
              setOpen(false);
              onReset();
            }}
          >
            Back to suggested
          </button>
        </div>
      )}
    </div>
  );
}

/** The open connector: its name, where its cable goes, and -- on a solenoid
 *  board -- the states its row opens in. */
function Detail({
  channel,
  draft,
  def,
  boards,
  hookup,
  drawn,
  rocketOnly,
  inputRef,
  carry,
  onName,
  onShow,
  onUnplug,
  onMoveTo,
}: {
  channel: ChannelDef;
  draft: Draft;
  def: BoardDef;
  boards: BoardDef[];
  hookup: HookupApi;
  drawn: Drawn;
  rocketOnly: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  /** A rename takes the row with it (false: the name is the twin's guess). */
  carry: boolean;
  onName: (text: string) => void;
  onShow: () => void;
  onUnplug: () => void;
  onMoveTo: (board: BoardId) => void;
}) {
  const sym = hookup.symbol(channel.symbol);
  const valve = isValveBoard(channel.board);
  const siblings = boards.filter((b) => b.kind === def.kind);
  const pages = new Set([...drawn.values()].map((d) => d.page)).size > 1;
  const page = sym?.page ?? drawn.get(channel.symbol)?.page;
  const locked = hookup.locked;
  const lost = !sym && !drawn.has(channel.symbol);
  return (
    <section className="mt-3 border-t border-[var(--line)] pt-2 text-[11.5px]">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-gray-300">{badge(channel)}</span>
        {siblings.length > 1 ? (
          <select
            value={channel.board}
            disabled={locked}
            onChange={(e) => onMoveTo(e.target.value as BoardId)}
            aria-label="Board"
            title="Move this cable to the other board"
            className="rounded border border-gray-800 bg-transparent px-1 py-0.5 text-[11px] text-gray-400 disabled:opacity-60"
          >
            {siblings.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[11px] text-gray-500">{def.label}</span>
        )}
        <button
          type="button"
          disabled={locked}
          onClick={onUnplug}
          className="ml-auto rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] text-[var(--ink-2)] hover:border-red-400/60 hover:text-red-300 disabled:opacity-40"
          title={valve ? 'Pull the cable. Its row stays in the state table.' : 'Pull the cable'}
        >
          Unplug
        </button>
      </div>

      <NameField
        channel={channel}
        draft={draft}
        locked={locked}
        carry={carry}
        tagOf={(id) => hookup.symbol(id)?.label ?? hookup.label(id)}
        inputRef={inputRef}
        onCommit={onName}
      />

      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="w-[4.5rem] shrink-0 text-[11px] text-gray-500">Goes to</span>
        <span className="min-w-0 truncate text-gray-100">{sym?.label ?? hookup.label(channel.symbol)}</span>
        {lost && (
          <span
            className="shrink-0 text-[10.5px] text-red-300"
            title="This version of the drawing has no such symbol: unplug the cable, or plug it into the symbol that took its place. Saving is refused until then."
          >
            not on this drawing
          </span>
        )}
        <span className="shrink-0 font-mono text-[10px] text-gray-500">{sym?.type ?? drawn.get(channel.symbol)?.type}</span>
        {pages && page && <span className="shrink-0 truncate text-[10.5px] text-gray-500">{page}</span>}
        {sym?.ground && rocketOnly && (
          <span
            className="shrink-0 text-[10px] text-gray-500"
            title="Rocket only: the cart is drawn but not simulated. The cable is kept."
          >
            Cart · not simulated
          </span>
        )}
        <button
          type="button"
          onClick={onShow}
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--ink-2)] hover:bg-white/5 hover:text-[var(--ink)]"
          title="Find it on the drawing"
        >
          Show
        </button>
      </div>

      {valve && (
        <div className="mt-1.5">
          <OpensIn machine={draft.machine} name={channel.name} />
        </div>
      )}
    </section>
  );
}

/** The connector's name: the console's, and on a solenoid board the state
 *  table's row. Kept on Enter or leaving the field; Esc puts it back. Under
 *  it, what the name does to the table, or which connector already has it. */
function NameField({
  channel,
  draft,
  locked,
  carry,
  tagOf,
  inputRef,
  onCommit,
}: {
  channel: ChannelDef;
  draft: Draft;
  locked: boolean;
  carry: boolean;
  tagOf: (id: string) => string;
  inputRef: RefObject<HTMLInputElement | null>;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(channel.name);
  const [was, setWas] = useState(channel.name);
  // Renamed from elsewhere (the Symbols panel, a swap): show the new name.
  if (was !== channel.name) {
    setWas(channel.name);
    setText(channel.name);
  }
  const skip = useRef(false);
  const list = useId();
  const valve = isValveBoard(channel.board);
  const wanted = text.trim();
  const clash = wanted ? clashNote(draft, wanted, channel.symbol, tagOf) : null;
  const hint = nameHint(draft, channel.symbol, wanted, carry);
  const commit = () => {
    if (skip.current) {
      skip.current = false;
      setText(channel.name);
      return;
    }
    if (!wanted || clash) {
      setText(channel.name);
      return;
    }
    if (wanted !== channel.name) onCommit(wanted);
  };
  return (
    <div className="mt-1.5">
      <label className="flex items-center gap-2">
        <span className="w-[4.5rem] shrink-0 text-[11px] text-gray-500">Name</span>
        <input
          ref={inputRef}
          type="text"
          value={text}
          disabled={locked}
          list={valve ? list : undefined}
          placeholder={valve ? 'e.g. LOX Main' : 'e.g. LOX tank'}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && wanted && !clash) e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.stopPropagation();
              skip.current = true;
              e.currentTarget.blur();
            }
          }}
          title={valve ? 'The console’s name for it, and its row in the state table' : 'The console’s name for it'}
          className={`min-w-0 flex-1 rounded border bg-black/60 px-1.5 py-0.5 text-[12px] text-white focus:outline-none disabled:opacity-50 ${
            clash ? 'border-red-500' : 'border-gray-700 focus:border-blue-500'
          }`}
        />
        {valve && (
          <datalist id={list}>
            {unwiredRows(draft).map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        )}
      </label>
      {(clash || hint) && (
        <p
          className={`mt-0.5 truncate pl-[5rem] text-[10.5px] ${clash ? 'text-red-300' : 'text-gray-500'}`}
          title={clash ? 'Another connector has this name: leaving the field puts the old one back' : hint?.title}
        >
          {clash ?? hint?.text}
        </p>
      )}
    </div>
  );
}
