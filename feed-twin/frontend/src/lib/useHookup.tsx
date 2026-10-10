/**
 * The drawing's hookup -- the DAQ box, the state table and the knobs -- loaded
 * once and edited in one place by every panel that shows it: the P&ID's
 * Symbols list and DAQ box, the State machine tab and the Knobs page. One
 * draft for all of them, so wiring a valve on the P&ID, ticking the states it
 * opens in on the State machine tab and saving from either is one change;
 * switching panels never loses an edit.
 *
 * On a stand the hookup is the stand's, kept with it (shown and bound by the
 * backend as the stand runs it); off one it is the drawing's own, in the
 * library. Names apply to a running stand live; a change of wiring, table or
 * knobs reopens the stand bound the new way.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { keyOf } from '@stardesign-ui';
import {
  getHookup,
  resetHookup,
  saveHookup,
  viewHookup,
  type BoardDef,
  type BoardId,
  type Hookup,
  type HookupBody,
  type HookupSymbol,
} from '../api';
import { useStand } from '../stand';
import { type Draft, isValveBoard, sameMachine } from './hookupDraft';

export interface HookupApi {
  /** What the backend says: the hookup as saved (or suggested), the boards,
   *  the symbols that can go on them, the DAQ's own table. */
  data: Hookup | null;
  /** The hookup being edited, shared by every panel. */
  draft: Draft | null;
  /** Apply an edit (lib/hookupDraft.ts). */
  update: (edit: (d: Draft) => Draft) => void;
  setDraft: (d: Draft) => void;
  error: string;
  busy: boolean;
  /** Anything unsaved. */
  dirty: boolean;
  /** Only names changed -- a transducer's connector, an alias, rows shown --
   *  so the running stand takes it without reopening. */
  namesOnly: boolean;
  onStand: boolean;
  locked: boolean;
  save: () => void;
  discard: () => void;
  /** Forget what was saved: the twin's own matching again. */
  reset: () => void;
  boards: BoardDef[];
  board: (id: BoardId) => BoardDef | undefined;
  symbols: HookupSymbol[];
  symbol: (id: string) => HookupSymbol | undefined;
  /** A symbol's tag, with its page on a drawing of several. */
  label: (id: string) => string;
  /** What the twin's own matching would call a symbol on the box -- "LOX
   *  Main" for the LOX main valve -- when no other connector has that name;
   *  else its tag. The name a newly wired connector starts with. */
  suggestedName: (id: string) => string;
}

const Context = createContext<HookupApi | null>(null);

/** The draft a backend answer starts: always a box, always a table. */
export function draftOf(h: Hookup): Draft {
  return {
    ...h.hookup,
    aliases: h.hookup.aliases ?? {},
    channels: h.hookup.channels ?? [],
    rows: h.hookup.rows ?? {},
    machine: h.hookup.machine ?? h.machine_shipped,
  };
}

const sortedChannels = (d: Draft) =>
  [...d.channels].sort((a, b) => (a.board + a.slot).localeCompare(b.board + b.slot) || a.slot - b.slot);

/** The parts that decide what the stand does: which connector goes where,
 *  what each valve connector is called (its row), the table, the knobs. */
const wiringKey = (d: Draft) =>
  JSON.stringify({
    // A valve's name is its row, matched ignoring case: "Lox Main" for
    // "LOX Main" is a name, not wiring.
    channels: sortedChannels(d).map((c) => [c.board, c.slot, c.symbol, isValveBoard(c.board) ? c.name.toLowerCase() : '']),
    knobs: d.knobs,
    valves: d.valves,
  });
const namesKey = (d: Draft) =>
  JSON.stringify({
    channels: sortedChannels(d).map((c) => c.name),
    aliases: Object.entries(d.aliases ?? {}).sort(),
    rows: Object.entries(d.rows ?? {}).sort(),
  });

export function HookupProvider({ children }: { children: ReactNode }) {
  const stand = useStand();
  const { where, standDoc, standHookup, locked, setup, model, live } = stand;
  // The stand's callbacks are new on every tick; read through a ref, so save
  // and reset -- and with them every panel reading this hookup -- change only
  // when the hookup does, not 60 times a minute.
  const calls = useRef(stand);
  calls.current = stand;
  // Rocket only: the binding shown is what the stand runs on the rocket alone.
  const ignoreGse = Boolean(live?.setup?.ignore_gse ?? setup.ignore_gse);
  const at = useMemo(
    () => ({ diagram: where.diagram, engine: where.engine, fluidSet: where.fluidSet, machine: where.machine, ignoreGse }),
    [where.diagram, where.engine, where.fluidSet, where.machine, ignoreGse],
  );
  const onStand = Boolean(standDoc);
  const [data, setData] = useState<Hookup | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const base = useMemo(() => (data ? draftOf(data) : null), [data]);
  const sameTable = Boolean(base && draft && sameMachine(base.machine, draft.machine));
  const sameWiring = Boolean(base && draft && sameTable && wiringKey(base) === wiringKey(draft));
  const sameNames = Boolean(base && draft && namesKey(base) === namesKey(draft));
  const dirty = Boolean(base && draft && !(sameWiring && sameNames));
  // A box written down for the first time changes what the console shows
  // (only what is wired), so that reopens the stand too.
  const namesOnly = dirty && sameWiring && Boolean(data?.wired);

  // What the draft is the hookup of: this drawing, on this stand (or none).
  // An answer for the same one while edits are unsaved -- the engine or
  // rocket-only changed, the stand reopened -- replaces what the backend
  // says and leaves the edits alone; one for another drawing or stand
  // replaces the draft.
  const owner = `${where.diagram}|${standDoc ? keyOf(standDoc.ref) : ''}`;
  const draftOwner = useRef<string | null>(null);
  const unsaved = useRef(false);
  useEffect(() => {
    unsaved.current = dirty;
  });

  useEffect(() => {
    if (!where.diagram) return;
    let stale = false;
    setError('');
    const own = standHookup as unknown as HookupBody | null;
    const asked = owner;
    // Shown, not checked: a stand whose drawing lost a symbol must still
    // open here, or its cable could never be unplugged (`problems` says).
    (own ? viewHookup(at, own, false) : getHookup(at))
      .then((h) => {
        if (stale) return;
        setData(h);
        if (draftOwner.current === asked && unsaved.current) return;
        draftOwner.current = asked;
        setDraft(draftOf(h));
      })
      .catch((e) => !stale && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [where.diagram, where.engine, standHookup, ignoreGse, owner]);

  /** What is written: the box as it stands, and the table only when it is
   *  not the DAQ's (so a fix to the shipped table still reaches it). */
  const body = useCallback(
    (d: Draft): HookupBody => ({
      ...d,
      machine: data && sameMachine(d.machine, data.machine_shipped) ? null : d.machine,
    }),
    [data],
  );

  const live_names = useCallback(async (d: Draft) => {
    // The running stand takes new names without reopening; if it refuses
    // (it was built on other wiring), reopen it.
    if (!(await calls.current.setNames(d.aliases ?? {}, d.channels))) calls.current.restart();
  }, []);

  // One save at a time: a second click while the first is out is dropped.
  const saving = useRef(false);
  const save = useCallback(() => {
    if (!data || !draft || saving.current) return;
    const reopen = !namesOnly;
    const out = body(draft);
    saving.current = true;
    setBusy(true);
    setError('');
    // On a stand it is kept with the stand (the stand's Save writes it), so
    // the backend is asked to read it first: a body it refuses kept here
    // would be marked saved, and the stand would open on the drawing's own.
    (onStand ? viewHookup(at, out) : saveHookup(at, out))
      .then((h) => {
        if (onStand) calls.current.setStandHookup(out as unknown as Record<string, unknown>, reopen);
        setData(onStand ? { ...h, saved: true } : h);
        setDraft(draftOf(h));
        if (reopen) {
          if (!onStand) calls.current.restart();
        } else void live_names(draftOf(h));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        saving.current = false;
        setBusy(false);
      });
  }, [data, draft, namesOnly, onStand, body, at, live_names]);

  const reset = useCallback(() => {
    if (!data) return;
    if (onStand) {
      // The suggestion as it is: matched by name, so it follows the drawing.
      // Its answer replaces the draft, unsaved edits and all: they are what
      // the user just chose to forget.
      draftOwner.current = null;
      calls.current.setStandHookup(
        { ...data.suggested, channels: null, machine: null } as unknown as Record<string, unknown>,
        true,
      );
      return;
    }
    setBusy(true);
    resetHookup(at)
      .then((h) => {
        setData(h);
        setDraft(draftOf(h));
        calls.current.restart();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [data, onStand, at]);

  const discard = useCallback(() => {
    if (base) setDraft(structuredClone(base));
  }, [base]);

  const update = useCallback((edit: (d: Draft) => Draft) => setDraft((d) => (d ? edit(d) : d)), []);

  const value = useMemo<HookupApi>(() => {
    const symbols = data?.symbols ?? [];
    const byId = new Map(symbols.map((s) => [s.id, s]));
    const boards = data?.boards ?? [];
    const pages = (data?.pages.length ?? 0) > 1;
    return {
      data,
      draft,
      update,
      setDraft,
      error,
      busy,
      dirty,
      namesOnly,
      onStand,
      locked,
      save,
      discard,
      reset,
      boards,
      board: (id) => boards.find((b) => b.id === id),
      symbols,
      symbol: (id) => byId.get(id),
      suggestedName: (id) => {
        const tag = byId.get(id)?.label ?? id;
        const named = data?.suggested.channels?.find((c) => c.symbol === id)?.name;
        const taken = (n: string) =>
          (draft?.channels ?? []).some((c) => c.symbol !== id && c.name.toLocaleLowerCase() === n.toLocaleLowerCase());
        return named && !taken(named) ? named : tag;
      },
      label: (id) => {
        const s = byId.get(id);
        if (s) return `${s.label}${pages ? ` · ${s.page}` : ''}`;
        // Rocket only, a vent row can be bound to the rocket's capped
        // disconnect, which the whole drawing mates rather than lists.
        const a = model?.actuators.find((x) => x.id === id);
        return a ? `${a.tag}${model?.pages?.[id] ? ` · ${model.pages[id]}` : ''}` : id;
      },
    };
  }, [data, draft, update, error, busy, dirty, namesOnly, onStand, locked, save, discard, reset, model]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useHookup(): HookupApi {
  const found = useContext(Context);
  if (!found) throw new Error('useHookup outside HookupProvider');
  return found;
}
