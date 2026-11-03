/**
 * One stand, live, shared by every view.
 *
 * The important shift from the last version is that this holds a **session**
 * rather than a request. The backend keeps the vessels — gas mass, gas energy,
 * liquid mass, wall temperature — and integrates them; this ticks it and draws
 * what comes back. That is why a tank now reads atmosphere until you fill it,
 * why Fuel Press takes a few seconds to come up, and why the bottle droops.
 *
 * The tick is self-pacing: the next one is scheduled when the last one lands,
 * with the real elapsed time as its `dt`. A fixed interval would queue up
 * behind a slow solve and then integrate a backlog in one step.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { keyOf, useCheckout, type Checkout, type DocRef } from '@stardesign-ui';
import { NO_ORDER, type ConsoleView, type Order } from './lib/shown';
import { standApi, type StandPayload } from './stands';
import { defaultPicks, pastIdle } from './lib/standPick';
import {
  commandSession,
  getConsoleHidden,
  getHookup,
  getModel,
  getStateMachine,
  sessionStateMachine,
  listArtifacts,
  loadSampleStand,
  openSession,
  sessionBurns,
  sessionT0,
  sessionHistory,
  setConsoleHidden,
  setConsoleOrder as putConsoleOrder,
  setConsoleView,
  tickSession,
  type Artifact,
  type Burns,
  type ChannelDef,
  type HookupBody,
  type ModelView,
  type RunResult,
  type SessionState,
  type StandSetup,
  type StateMachine,
  type Where,
} from './api';

/** Target wall-clock period of the tick [ms], from the start of one tick to the
 *  start of the next. A tick that takes longer is followed at once and the next
 *  carries the time it took as its dt. (Waiting this long *after* each reply put
 *  the round trip on top of it: a stand whose solve took 100 ms per 250 ms tick
 *  ran at 0.6x on a machine that could run it at twice real time.) */
const TICK_MS = 200;

/** Longest dt a single tick may carry [s]. A backgrounded tab must not
 *  integrate a minute of stand in one step — it resumes, it does not catch up. */
const MAX_DT = 0.25;

/** Why the cockpit has no stand on screen, when it has none. */
export type NoStand =
  /** Still asking the library what it holds. */
  | { kind: 'library' }
  /** The library holds no drawing: the first-run panel. */
  | { kind: 'empty' }
  /** The drawing picked could not be built into a stand. */
  | { kind: 'failed'; diagram: string; name: string; reason: string }
  /** The library could not be read at all. */
  | { kind: 'unreachable'; reason: string };

/** A switch of drawing or engine held for a yes, because the stand on screen
 *  is past Idle and switching throws it away. */
export interface PendingPick {
  kind: 'diagram' | 'engine';
  id: string;
  name: string;
  /** What switching would throw away, in a few words. */
  losing: string;
}

interface StandValue {
  artifacts: Artifact[];
  /** Null while a stand is on screen or opening; otherwise why there is none. */
  noStand: NoStand | null;
  /** Put the bundled sample stand into the library and open it. */
  loadSample: () => Promise<void>;
  /** A switch waiting for the operator's yes (see `pick`). */
  pendingPick: PendingPick | null;
  confirmPick: () => void;
  cancelPick: () => void;
  model: ModelView | null;
  machine: StateMachine | null;
  live: SessionState | null;
  history: RunResult | null;
  /** Every burn still in the history: what the engine did. */
  burns: Burns | null;
  running: boolean;
  busy: boolean;
  error: string;
  /** Stand seconds per wall second, ~1 when the solver keeps up. */
  speed: number;
  where: Where;
  setup: StandSetup;
  setSetup: (patch: Partial<StandSetup>) => void;
  setRunning: (on: boolean) => void;
  hidden: Record<string, boolean>;
  toggleChannel: (id: string) => void;
  /** What the console's menus and the P&ID tab hide, for everyone on this
   *  drawing. Kept by the backend, so every browser shows the same console. */
  consoleHidden: Record<string, boolean>;
  /** The order the strip draws transducers and tanks in; shared the same way. */
  consoleOrder: Order;
  setConsoleOrder: (order: Order) => void;
  hideOnConsole: (ids: string[], hide: boolean) => void;
  /** Put a drawing or engine on the console. On a stand past Idle -- loaded,
   *  pressed, burned -- it waits in `pendingPick` for a yes instead: an
   *  import used to switch the stand and throw a T-0'd one away unasked. */
  pick: (kind: 'diagram' | 'engine', id: string) => void;
  go: (state: string) => void;
  toggleValve: (id: string) => void;
  /** Stand seconds per wall second asked for (time warp); 1 at Fire. */
  warp: number;
  setWarp: (w: number) => void;
  /** Turn one of the hookup's knobs [psig]. The dome knob is `setSetup({dome})`. */
  turnKnob: (id: string, value: number) => void;
  /** What the console calls a valve or transducer: its alias, or `tag`. */
  nameOf: (id: string, tag: string) => string;
  /** Give the running stand new console names (no reopen). */
  setAliases: (aliases: Record<string, string>) => void;
  /** Give the running stand new names -- aliases and what its connectors are
   *  called -- without reopening it. False when it refuses (a valve's
   *  connector renamed off its row is rewiring): reopen it instead. */
  setNames: (aliases: Record<string, string>, channels: ChannelDef[] | null) => Promise<boolean>;
  release: () => void;
  restart: () => void;
  /** Skip the pad: loaded, charged, at lockup, in Ready. */
  jumpToT0: () => void;
  /** Skip a LOX load's chilldown: the wall goes where the chill leaves it and
   *  the load collects from now. Operating, not configuring: never locked. */
  skipChill: (tankId?: string) => void;
  refresh: () => Promise<Artifact[]>;
  /** The stand document this cockpit is on, if any (stands.ts). */
  standDoc: OpenStand | null;
  /** The operator has changed this set-up -- a setting or a knob -- since it
   *  opened (kept across a reload, as the settings are). Until then the stand
   *  bar names what is running instead of calling it unsaved work. */
  changed: boolean;
  /** Open a stand document: its drawing, engine, settings, hookup and knobs,
   *  on a fresh session. */
  openStand: (ref: DocRef, name: string, take?: boolean) => Promise<void>;
  /** Leave the stand document; the cockpit keeps what it has. */
  closeStand: () => void;
  /** The cockpit's configuration as a stand document's payload. */
  snapshot: () => Promise<StandPayload>;
  /** The stand's checkout: who may change what is saved in it. */
  checkout: Checkout;
  /** On a stand you have not taken: its configuration is read only. Running it
   *  (states, valves, T-0, Fire) is never locked -- that is operating the
   *  stand, not changing it. */
  locked: boolean;
  /** The stand's own hookup, when it has one for the drawing on screen. */
  standHookup: Record<string, unknown> | null;
  /** Give the open stand a hookup; `reopen` false when only console names
   *  changed (they are applied live). False, with the reason in the error
   *  line, when the stand could not take it (not taken, not loaded). */
  setStandHookup: (hookup: Record<string, unknown>, reopen?: boolean) => boolean;
  /** Write the open stand as it is now (the stand bar's Save). */
  saveStand: () => Promise<void>;
}

/** A stand document, open. */
export interface OpenStand {
  ref: DocRef;
  name: string;
}

const readStand = (): OpenStand | null => {
  try {
    const raw = window.localStorage.getItem('feedtwin.stand');
    return raw ? (JSON.parse(raw) as OpenStand) : null;
  } catch {
    return null;
  }
};

const HELD_KEY = 'feedtwin.stand.held';
const readHeld = (): string => {
  try {
    return window.localStorage.getItem(HELD_KEY) ?? '';
  } catch {
    return '';
  }
};
const keepHeld = (key: string) => {
  try {
    window.localStorage.setItem(HELD_KEY, key);
  } catch {
    // Storage unavailable: a reload asks for Take again.
  }
};
const forgetHeld = () => {
  try {
    window.localStorage.removeItem(HELD_KEY);
  } catch {
    // Nothing to forget.
  }
};

const Ctx = createContext<StandValue | null>(null);

export const useStand = () => {
  const value = useContext(Ctx);
  if (!value) throw new Error('useStand outside StandProvider');
  return value;
};

/** Where this browser keeps the cockpit's settings and which drawn knobs it
 *  has turned, so a reload after a backend restart reopens the same stand. */
const SETUP_KEY = 'feedtwin.setup';
const TURNED_KEY = 'feedtwin.turned';
const CHANGED_KEY = 'feedtwin.changed';

function remembered<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? ({ ...fallback, ...(JSON.parse(raw) as T) } as T) : fallback;
  } catch {
    return fallback;
  }
}

function keep(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the settings last this tab.
  }
}

/** Setup keys a drawing sets on its regulators: a fresh stand starts them there. */
const DRAWN_KNOBS = ['dome', 'copv_target'];

const orderOf = (raw?: { pts?: string[]; tanks?: string[] } | null): Order => ({
  pts: raw?.pts ?? [],
  tanks: raw?.tanks ?? [],
});

/** Put a saved stand's console view back on its drawing (the team's view).
 *  A stand saved before views were kept carries none, and changes nothing. */
async function putStandView(diagram: string, view?: Partial<ConsoleView> | null): Promise<void> {
  if (!diagram || !view || !Array.isArray(view.hidden)) return;
  await setConsoleView(diagram, view.hidden, orderOf(view.order)).catch(() => undefined);
}

export function StandProvider({ children }: { children: ReactNode }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [diagram, setDiagram] = useState('');
  const [engine, setEngine] = useState('');
  const [model, setModel] = useState<ModelView | null>(null);
  const [machine, setMachine] = useState<StateMachine | null>(null);
  const [live, setLive] = useState<SessionState | null>(null);
  const [history, setHistory] = useState<RunResult | null>(null);
  const [burns, setBurns] = useState<Burns | null>(null);
  const [running, setRunning] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [noStand, setNoStand] = useState<NoStand | null>({ kind: 'library' });
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const [setup, setSetupState] = useState<StandSetup>(() => ({
    dome: 500,
    copv_target: 4500,
    copv_fill_s: 9.7,
    tank_fill_s: 120,
    fuel_fill_s: 15,
    dewar_psi: 100,
    dewar_fill_cv: 0.019,
    bottle_delivered: false,
    ignore_gse: false,
    pressurant: '',
    fill_stirring: 20,
    ullage_collapse: true,
    ullage_vapour: true,
    chilldown: 100,
    line_walls: true,
    ambient_leak: 8,
    // What this browser last ran with: a backend restart and a reload used to
    // reopen the stand on these defaults, silently -- Ignore the drawn GSE and
    // every Configuration change gone (found 2026-10-09).
    ...remembered<Partial<StandSetup>>(SETUP_KEY, {}),
  }));
  useEffect(() => keep(SETUP_KEY, setup), [setup]);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [consoleHidden, setConsoleHiddenState] = useState<Record<string, boolean>>({});
  const [consoleOrder, setConsoleOrderState] = useState<Order>(NO_ORDER);
  const [generation, setGeneration] = useState(0);
  const [standDoc, setStandDoc] = useState<OpenStand | null>(readStand);
  const [changed, setChangedState] = useState<boolean>(() => remembered<{ on: boolean }>(CHANGED_KEY, { on: false }).on);
  const setChanged = useCallback((on: boolean) => {
    setChangedState(on);
    keep(CHANGED_KEY, { on });
  }, []);
  // Taking the checkout must not reload the stand: that would reopen the
  // session and throw away the run on screen.
  const checkout = useCheckout({ api: standApi, ref: standDoc?.ref ?? null, reload: () => undefined });
  const locked = Boolean(standDoc) && !checkout.held;
  /** Knob positions a closed stand left the cockpit, for its next fresh
   *  stand on the same drawing. */
  const carried = useRef<{ diagram: string; knobs: Record<string, number> } | null>(null);
  /** The stand this browser held when the page went away. Closing the tab
   *  hands the checkout back (useCheckout's unload beacon), so a reload -- or
   *  a stand somebody had just made -- came back read only, with a Take
   *  button for their own stand. It is taken again, once, if nobody else
   *  has it. */
  const heldKey = useRef(readHeld());
  const retook = useRef('');
  const standKey = standDoc ? keyOf(standDoc.ref) : '';
  const wasHeld = useRef(false);
  useEffect(() => {
    if (checkout.held && standKey) {
      heldKey.current = standKey;
      keepHeld(standKey);
    } else if (wasHeld.current && !checkout.held && !checkout.lostUnexpectedly) {
      // Released on purpose: the next reload must not take it back.
      heldKey.current = '';
      forgetHeld();
    }
    wasHeld.current = checkout.held;
  }, [checkout.held, checkout.lostUnexpectedly, standKey]);
  const { take, holder, held, busy: checkoutBusy } = checkout;
  useEffect(() => {
    if (!standKey || held || checkoutBusy || holder !== null) return;
    if (heldKey.current !== standKey || retook.current === standKey) return;
    retook.current = standKey;
    void take().catch(() => undefined);
  }, [standKey, held, checkoutBusy, holder, take]);
  /** The open stand's hookup and knobs, applied to every fresh session on it. */
  const standPayload = useRef<StandPayload | null>(null);

  const where: Where = { diagram, engine, fluidSet: 'hotfire', machine: 'diablo' };
  const session = useRef('');
  /** Set by Reset: the next open must be a new stand, not the remembered one. */
  const wantFresh = useRef(false);
  /** The pressurant was asked for in the URL: it is not carried over. */
  const gasAsked = useRef(false);
  /** The session this tab last ran, when a fresh one replaces it (Reset, a
   *  stand the server closed): the next open names it, so the server frees
   *  its seat and says if it had closed it to make room. */
  const replacing = useRef('');
  /** The drawing's knobs this tab has turned (dome, COPV fill). Only those are
   *  sent when a stand opens; the rest start where the drawing sets them. */
  const turned = useRef<{ diagram: string; keys: Set<string> }>(
    (() => {
      const saved = remembered<{ diagram?: string; keys?: string[] }>(TURNED_KEY, {});
      return { diagram: saved.diagram ?? '', keys: new Set(saved.keys ?? []) };
    })(),
  );
  const keepTurned = () =>
    keep(TURNED_KEY, { diagram: turned.current.diagram, keys: [...turned.current.keys] });
  const last = useRef(0);
  const alive = useRef(true);
  /** Stand seconds per wall second over the last few ticks. A stiff stand
   *  (helium's regulator-ullage loop steps at a millisecond) integrates
   *  slower than real time; the panel then runs in slow motion and says so,
   *  rather than freezing. */
  const [speed, setSpeed] = useState(1);
  /** Stand seconds per wall second the cockpit asks for: x1, or faster to wait
   *  out a load or a charge. Back to x1 at Fire. */
  const [warp, setWarpState] = useState(1);
  const warpRef = useRef(1);
  const liveState = useRef('');
  const pace = useRef<{ wall: number; t: number } | null>(null);

  const refresh = useCallback(async () => {
    const list = await listArtifacts();
    setArtifacts(list);
    return list;
  }, []);
  const artifactsRef = useRef<Artifact[]>([]);
  artifactsRef.current = artifacts;

  /** Open on the stand `defaultPicks` chooses, or say why there is none. */
  const land = useCallback((list: Artifact[]) => {
    // The engine used to be picked only when the library held exactly one.
    // With two it picked none, silently: the console opened with no engine,
    // no chamber and nothing that could light.
    const stored = (kind: 'diagram' | 'engine') => {
      try {
        return window.localStorage.getItem(`feedtwin.${kind}`);
      } catch {
        return null;
      }
    };
    let asked: { diagram?: string | null; engine?: string | null } = {};
    try {
      const q = new URLSearchParams(window.location.search);
      asked = { diagram: q.get('diagram'), engine: q.get('engine') };
      const gas = q.get('pressurant');
      if (gas === 'helium' || gas === 'nitrogen' || gas === 'drawing') {
        setSetupState((s) => ({ ...s, pressurant: gas === 'drawing' ? '' : gas }));
        gasAsked.current = true;
      }
    } catch {
      // No query to read.
    }
    const picks = defaultPicks(list, { diagram: stored('diagram'), engine: stored('engine') }, asked);
    if (picks.diagram) setDiagram(picks.diagram);
    if (picks.engine) setEngine(picks.engine);
    setNoStand(picks.diagram ? null : { kind: 'empty' });
  }, []);

  useEffect(() => {
    refresh()
      .then(land)
      .catch((e: unknown) =>
        setNoStand({ kind: 'unreachable', reason: e instanceof Error ? e.message : String(e) }),
      );
  }, [refresh, land]);

  const loadSample = useCallback(async () => {
    setError('');
    const list = await loadSampleStand();
    setArtifacts(list);
    // The sample is the featured stand: open it, whatever this browser
    // remembered from a library that no longer holds it.
    const diagrams = list.filter((a) => a.kind === 'diagram');
    const engines = list.filter((a) => a.kind === 'engine');
    const d = diagrams.find((a) => a.featured) ?? diagrams[0];
    const e = engines.find((a) => a.featured) ?? engines[0];
    if (!d) throw new Error('The sample stand did not arrive in the library.');
    setNoStand(null);
    setChanged(false);
    if (e) setEngine(e.id);
    setDiagram(d.id);
  }, [setChanged]);

  /** Remember the picks once a stand has opened on them, so reopening the tab
   *  lands on the same stand. Not before: a drawing that cannot be built was
   *  remembered, and every reload landed on it again. */
  const rememberPicks = useCallback((d: string, e: string) => {
    try {
      if (d) window.localStorage.setItem('feedtwin.diagram', d);
      if (e) window.localStorage.setItem('feedtwin.engine', e);
    } catch {
      // Storage can be unavailable; the picks still work for this tab.
    }
  }, []);

  /** Load the drawing and pick the stand up where it was, or open a fresh one.
   *
   *  A reload used to mean a new stand: whatever was loaded and pressed was
   *  gone, and an operator who touched F5 mid-run lost the run -- and the
   *  overpressure screen they were meant to read. The session lives on the
   *  backend, so remember its id and reattach if it is still there and still
   *  on this drawing; otherwise, and after Reset, open cold. */
  useEffect(() => {
    if (!diagram) return;
    let cancelled = false;
    replacing.current = session.current || replacing.current;
    session.current = '';
    setBusy(true);
    setError('');
    setNoStand(null);
    const fresh = wantFresh.current;
    wantFresh.current = false;
    const remembered = (): string => {
      if (fresh) return '';
      try {
        const raw = window.localStorage.getItem('feedtwin.session');
        const saved = raw
          ? (JSON.parse(raw) as { id?: string; diagram?: string; engine?: string; stand?: string })
          : null;
        const stand = standDoc ? keyOf(standDoc.ref) : '';
        return saved && saved.diagram === diagram && saved.engine === engine && (saved.stand ?? '') === stand && saved.id
          ? saved.id
          : '';
      } catch {
        return '';
      }
    };
    const reopen = async (): Promise<SessionState> => {
      // A stand document: the run records name it, and its own hookup is used
      // for this session without touching the drawing's saved one. Read
      // first, before reattaching to a session that is still running: a page
      // reloaded on a stand used to reattach without it, so the hookup panels
      // showed the drawing's, a hookup Save had no stand to go into, and the
      // stand's Save wrote the drawing's suggestion over the stand's own.
      let onStand = standDoc;
      if (onStand && !standPayload.current) {
        try {
          standPayload.current = await standApi.load(onStand.ref);
          // The stand's console view is put back for its drawing.
          await putStandView(standPayload.current.diagram, standPayload.current.console);
        } catch (e) {
          // Unshared or deleted: say so, and open the cockpit off the stand
          // rather than leave it hanging on a session the server refuses.
          setError(`Stand "${onStand.name}" could not be opened (${e instanceof Error ? e.message : String(e)}); running without it.`);
          onStand = null;
          setStandDoc(null);
          try {
            window.localStorage.removeItem('feedtwin.stand');
          } catch {
            // Nothing to forget.
          }
        }
      }
      const id = remembered();
      if (id) {
        try {
          return await tickSession(id, 1e-3);
        } catch {
          // The backend forgot it (restart, deploy, closed to make room); a
          // fresh stand is honest, and its notes say which.
          replacing.current = replacing.current || id;
        }
      }
      // The stand's hookup and knob positions belong to the drawing it was
      // saved with. On another drawing they name valves and regulators that
      // are not there: the drawing's own hookup is used, and saving the stand
      // records the drawing it is now on.
      const doc = onStand && standPayload.current?.diagram === diagram ? standPayload.current : null;
      // The dome and the COPV fill are the drawing's until someone turns them
      // here, or a stand carries them: this tab's 500 and 4,500 used to win
      // over whatever the drawing set its regulators to.
      // The pressurant is the drawing's too: Helium picked on one drawing
      // burned the next one on helium with only a badge to say so (D-70).
      let gasReset = false;
      if (turned.current.diagram !== diagram) {
        gasReset =
          turned.current.diagram !== '' && !gasAsked.current && Boolean(setup.pressurant) && !(doc && 'pressurant' in doc.setup);
        turned.current = { diagram, keys: new Set() };
        keepTurned();
        if (gasReset) setSetupState((s) => ({ ...s, pressurant: '' }));
      }
      gasAsked.current = false;
      const fromDrawing = [
        ...DRAWN_KNOBS.filter((key) => !turned.current.keys.has(key) && !(doc && key in doc.setup)),
        ...(gasReset ? ['pressurant'] : []),
      ];
      const sent = Object.fromEntries(Object.entries(setup).filter(([key]) => !fromDrawing.includes(key)));
      const replaces = replacing.current;
      replacing.current = '';
      const opened = await openSession(where, {
        state: 'Idle',
        ...(replaces ? { replaces } : {}),
        ...sent,
        ...(onStand ? { stand: { id: onStand.ref.id, owner: onStand.ref.owner ?? '' } } : {}),
        ...(doc && Object.keys(doc.hookup).length ? { hookup: doc.hookup } : {}),
      });
      const knobs = (doc?.operating_point?.knobs ??
        (carried.current?.diagram === diagram ? carried.current.knobs : {})) as Record<string, number>;
      let state = opened;
      for (const [id, value] of Object.entries(knobs)) {
        if (opened.knobs?.some((k) => k.id === id)) {
          state = await commandSession(opened.id, { knob: { id, value } });
        }
      }
      return state;
    };
    (async () => {
      try {
        const first = await reopen();
        // Read the drawing as the session was built: a reattached one may
        // ignore the GSE whatever this tab's defaults say.
        const cut = Boolean(first.setup?.ignore_gse ?? setup.ignore_gse);
        // The table the session commands, bound as it runs: a stand's own
        // hookup (and its own table) included, which the drawing's endpoint
        // cannot see. An older backend falls back to the drawing's.
        const [view, sm] = await Promise.all([
          getModel(diagram, engine, 'hotfire', cut),
          sessionStateMachine(first.id).catch(() => getStateMachine(where, cut)),
        ]);
        if (cancelled) return;
        setModel(view);
        setConsoleHiddenState(Object.fromEntries((view.console_hidden ?? []).map((id) => [id, true])));
        setConsoleOrderState(orderOf(view.console_order));
        setMachine(sm);
        session.current = first.id;
        try {
          window.localStorage.setItem(
            'feedtwin.session',
            JSON.stringify({ id: first.id, diagram, engine, stand: standDoc ? keyOf(standDoc.ref) : '' }),
          );
        } catch {
          // Storage can be unavailable; the stand still works for this tab.
        }
        // The stand's knobs are the stand's: a reattached session says where
        // its regulators are, and the GSE tab must show that, not the defaults.
        if (first.setup) setSetupState((s) => ({ ...s, ...first.setup }) as StandSetup);
        setLive(first);
        liveState.current = first.state;
        setHistory(null);
        setBurns(null);
        rememberPicks(diagram, engine);
        last.current = performance.now();
      } catch (e) {
        if (cancelled) return;
        // Nothing on screen may outlive the stand it showed: the last
        // drawing's console stayed up, RUNNING, with T-0 doing nothing.
        session.current = '';
        setModel(null);
        setLive(null);
        setMachine(null);
        setHistory(null);
        setBurns(null);
        setNoStand({
          kind: 'failed',
          diagram,
          name: artifactsRef.current.find((a) => a.id === diagram)?.name ?? 'This drawing',
          reason: e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `setup` is read once at open; turning a knob later goes through command().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram, engine, generation]);

  /** The tick. Self-pacing: schedule the next when this one lands. */
  useEffect(() => {
    alive.current = true;
    if (!running || !session.current) return undefined;

    let timer = 0;
    const pump = async () => {
      if (!alive.current || !session.current) return;
      const now = performance.now();
      const started = now;
      // Time warp: the tick carries `warp` times the wall time, never in Fire
      // (a burn is watched in real time) -- the backend runs it as whole steps.
      const w = liveState.current === 'Fire' ? 1 : warpRef.current;
      const dt = Math.min(((now - last.current) / 1000) * w, MAX_DT * w);
      last.current = now;
      const asked = session.current;
      try {
        const next = await tickSession(asked, dt);
        // A Reset or a new drawing replaced the stand while this was out: its
        // answer is about a stand nobody is looking at.
        if (!alive.current || session.current !== asked) return;
        // Pace, smoothed over ~1 s of wall clock so it reads steadily.
        const nowWall = performance.now();
        if (pace.current && nowWall - pace.current.wall > 1000) {
          const ratio = (next.t - pace.current.t) / ((nowWall - pace.current.wall) / 1000);
          if (Number.isFinite(ratio) && ratio >= 0) setSpeed(ratio);
          pace.current = { wall: nowWall, t: next.t };
        } else if (!pace.current) {
          pace.current = { wall: nowWall, t: next.t };
        }
        setLive(next);
        liveState.current = next.state;
        setError('');
      } catch (e) {
        if (!alive.current || session.current !== asked) return;
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        // The backend restarted and forgot the stand. Sessions live in
        // memory, so this is what a dev reload, a deploy or a crash looks
        // like from here: every tick 404s and the panel freezes on its last
        // frame with the clock stopped. Open a fresh stand instead -- cold
        // and empty, which is honest -- and say so.
        if (/no session/i.test(message)) {
          replacing.current = session.current;
          session.current = '';
          wantFresh.current = true;
          setError('This is a fresh stand. ' + message);
          setGeneration((g) => g + 1);
          return;
        }
      }
      if (alive.current) {
        const wait = Math.max(TICK_MS - (performance.now() - started), 0);
        timer = window.setTimeout(pump, wait);
      }
    };
    timer = window.setTimeout(pump, TICK_MS);
    return () => {
      alive.current = false;
      window.clearTimeout(timer);
    };
  }, [running, live?.id]);

  /** Pull the trace periodically — it is bulky and only the plot reads it.
   *  Every 1.5 s, and three times as often while firing: a four-second burn
   *  drew as two jumps. Each pull is for one stand: replaced (Reset, a new
   *  drawing), its pulls still in flight are dropped, and a stale answer never
   *  lands on the new stand's plot. */
  const sessionId = live?.id;
  useEffect(() => {
    if (!sessionId) return undefined;
    const abort = new AbortController();
    let timer = 0;
    const pull = async () => {
      if (abort.signal.aborted || session.current !== sessionId) return;
      await Promise.all([
        sessionHistory(sessionId, 300, 1500, abort.signal)
          .then((h) => {
            if (!abort.signal.aborted && session.current === sessionId) setHistory(h);
          })
          .catch(() => undefined),
        sessionBurns(sessionId, abort.signal)
          .then((b) => {
            if (!abort.signal.aborted && session.current === sessionId) setBurns(b);
          })
          .catch(() => undefined),
      ]);
      if (!abort.signal.aborted) timer = window.setTimeout(pull, liveState.current === 'Fire' ? 500 : 1500);
    };
    void pull();
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [sessionId]);

  /** What the console hides is the team's, so another operator's change has to
   *  arrive here without a reload. A few seconds late is fine; it is layout. */
  useEffect(() => {
    if (!diagram) return undefined;
    const pull = () =>
      getConsoleHidden(diagram)
        .then(({ hidden: ids, order }) => {
          setConsoleHiddenState(Object.fromEntries(ids.map((id) => [id, true])));
          setConsoleOrderState(orderOf(order));
        })
        .catch(() => undefined);
    const id = window.setInterval(pull, 5000);
    return () => window.clearInterval(id);
  }, [diagram]);

  const hideOnConsole = useCallback(
    (ids: string[], hide: boolean) => {
      if (!diagram || ids.length === 0) return;
      const before = consoleHidden;
      setConsoleHiddenState((h) => ({ ...h, ...Object.fromEntries(ids.map((id) => [id, hide])) }));
      // One request per item, applied in order on the server; the last answer
      // is the whole list, so it is what this browser keeps.
      ids
        .reduce<Promise<{ hidden: string[] } | null>>(
          (prev, id) => prev.then(() => setConsoleHidden(diagram, id, hide)),
          Promise.resolve(null),
        )
        .then((last) => {
          if (last) setConsoleHiddenState(Object.fromEntries(last.hidden.map((i) => [i, true])));
        })
        .catch((e: unknown) => {
          setConsoleHiddenState(before);
          setError(e instanceof Error ? e.message : String(e));
        });
    },
    [diagram, consoleHidden],
  );

  /** The order the strip draws transducers and tanks in, for everyone. */
  const changeConsoleOrder = useCallback(
    (order: Order) => {
      if (!diagram) return;
      setConsoleOrderState(order);
      putConsoleOrder(diagram, order).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    },
    [diagram],
  );

  const command = useCallback(
    async (body: Parameters<typeof commandSession>[1]) => {
      if (!session.current) return;
      const asked = session.current;
      // Wall clock is reset so the next tick does not charge the stand for the
      // time this round trip took.
      try {
        const next = await commandSession(asked, body);
        if (session.current !== asked) return;
        setLive(next);
        liveState.current = next.state;
        last.current = performance.now();
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  const refuse = () =>
    setError('Read only: take the stand (top bar) to change its settings. Running it is not locked.');

  const value: StandValue = {
    artifacts,
    model,
    machine,
    live,
    history,
    burns,
    running,
    busy,
    error,
    speed,
    where,
    setup,
    setSetup: (patch) => {
      if (locked) return refuse();
      const next = { ...setup, ...patch } as StandSetup;
      if ((Object.keys(patch) as (keyof StandSetup)[]).some((k) => patch[k] !== setup[k])) setChanged(true);
      setSetupState(next);
      for (const key of DRAWN_KNOBS) if (key in patch) turned.current.keys.add(key);
      keepTurned();
      // Ignoring the GSE, or another pressurant, is a different network: a
      // fresh stand, built with it.
      if (
        ('ignore_gse' in patch && Boolean(patch.ignore_gse) !== Boolean(setup.ignore_gse)) ||
        ('pressurant' in patch && (patch.pressurant ?? '') !== (setup.pressurant ?? ''))
      ) {
        wantFresh.current = true;
        setGeneration((g) => g + 1);
        return;
      }
      void command({ setup: patch });
    },
    setRunning,
    hidden,
    toggleChannel: (id) => setHidden((h) => ({ ...h, [id]: !h[id] })),
    consoleHidden,
    hideOnConsole,
    consoleOrder,
    setConsoleOrder: changeConsoleOrder,
    pick: (kind, id) => {
      if (locked) return refuse();
      if ((kind === 'diagram' ? diagram : engine) === id) return;
      const losing = pastIdle(live, burns);
      if (losing) {
        // The ref, not this render's list: an import refreshes the library
        // and picks in one go, and the list here is the one from before.
        const name = artifactsRef.current.find((a) => a.id === id)?.name ?? 'the import';
        setPendingPick({ kind, id, name, losing });
        return;
      }
      setPendingPick(null);
      if (kind === 'diagram') setDiagram(id);
      else setEngine(id);
    },
    pendingPick,
    confirmPick: () => {
      if (!pendingPick) return;
      setPendingPick(null);
      if (pendingPick.kind === 'diagram') setDiagram(pendingPick.id);
      else setEngine(pendingPick.id);
    },
    cancelPick: () => setPendingPick(null),
    noStand,
    loadSample,
    go: (state) => {
      if (/^fire$/i.test(state)) {
        warpRef.current = 1;
        setWarpState(1);
      }
      void command({ state });
    },
    warp,
    setWarp: (w) => {
      warpRef.current = w;
      setWarpState(w);
    },
    toggleValve: (id) =>
      void command({ valve: id, open: !(live?.open[id] ?? false) }),
    turnKnob: (id, value) => {
      if (locked) return refuse();
      setChanged(true);
      void command({ knob: { id, value } });
    },
    nameOf: (id, tag) => live?.aliases?.[id] || tag,
    setAliases: (aliases) => void command({ aliases }),
    setNames: async (aliases, channels) => {
      if (!session.current) return true;
      try {
        setLive(await commandSession(session.current, { names: { aliases, channels } }));
        last.current = performance.now();
        return true;
      } catch {
        return false;
      }
    },
    release: () => void command({ release: '*' }),
    skipChill: (tankId) => void command({ skip_chill: tankId ?? true }),
    restart: () => {
      wantFresh.current = true;
      setGeneration((g) => g + 1);
    },
    jumpToT0: () => {
      if (!session.current) return;
      setBusy(true);
      sessionT0(session.current)
        .then((next) => {
          setLive(next);
          last.current = performance.now();
          setError('');
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    },
    refresh,
    standDoc,
    changed,
    openStand: async (ref, name, take = false) => {
      const doc = await standApi.load(ref);
      // A stand somebody has just made is theirs to change: taken as it opens.
      if (take) {
        heldKey.current = keyOf(ref);
        retook.current = '';
      }
      standPayload.current = doc;
      await putStandView(doc.diagram, doc.console);
      const opened = { ref, name };
      setStandDoc(opened);
      setChanged(false);
      try {
        window.localStorage.setItem('feedtwin.stand', JSON.stringify(opened));
      } catch {
        // Storage can be unavailable; the stand is still open in this tab.
      }
      if (Object.keys(doc.setup).length) setSetupState((s) => ({ ...s, ...doc.setup }) as StandSetup);
      if (doc.diagram) setDiagram(doc.diagram);
      if (doc.engine !== undefined) setEngine(doc.engine);
      wantFresh.current = true;
      setGeneration((g) => g + 1);
    },
    closeStand: () => {
      // The cockpit keeps what the stand gave it -- drawing, engine, settings,
      // and where the knobs sit. The settings stayed and the knobs went back
      // to the drawing's on the next fresh stand: half a stand.
      const knobs = Object.fromEntries((live?.knobs ?? []).map((k) => [k.id, k.psig]));
      carried.current = Object.keys(knobs).length ? { diagram, knobs } : null;
      for (const key of DRAWN_KNOBS) if (live?.setup && key in live.setup) turned.current.keys.add(key);
      keepTurned();
      standPayload.current = null;
      heldKey.current = '';
      forgetHeld();
      setStandDoc(null);
      try {
        window.localStorage.removeItem('feedtwin.stand');
      } catch {
        // Nothing to forget.
      }
    },
    checkout,
    locked,
    standHookup:
      standPayload.current?.diagram === diagram &&
      standPayload.current?.hookup &&
      Object.keys(standPayload.current.hookup).length
        ? standPayload.current.hookup
        : null,
    setStandHookup: (hookup, reopen = true) => {
      if (locked) {
        refuse();
        return false;
      }
      if (!standPayload.current) {
        setError('The stand is still loading: save the hookup again in a moment.');
        return false;
      }
      standPayload.current = { ...standPayload.current, diagram, hookup };
      if (reopen) {
        wantFresh.current = true;
        setGeneration((g) => g + 1);
      }
      return true;
    },
    saveStand: async () => {
      if (!standDoc || locked) return;
      await standApi.autosave(standDoc.ref, await value.snapshot());
    },
    snapshot: async () => {
      const hookup = await getHookup(where).catch(() => null);
      // The drawing's box only when somebody wrote one down: unsaved, it is
      // the twin's guess, and a stand that kept it would read as wired. The
      // table is the response's own (null when nothing is saved).
      const drawn: HookupBody | null = hookup
        ? hookup.wired
          ? hookup.hookup
          : { ...hookup.hookup, channels: null, rows: {} }
        : null;
      return {
        diagram,
        engine,
        fluid_set: where.fluidSet,
        machine: where.machine,
        setup: { ...(live?.setup ?? setup) },
        hookup: standPayload.current?.diagram === diagram &&
          standPayload.current?.hookup &&
          Object.keys(standPayload.current.hookup).length
          ? standPayload.current.hookup
          : ((drawn ?? {}) as unknown as Record<string, unknown>),
        operating_point: {
          knobs: Object.fromEntries((live?.knobs ?? []).map((k) => [k.id, k.psig])),
        },
        // What the console shows and in what order, as this tab has it.
        console: {
          hidden: Object.keys(consoleHidden).filter((id) => consoleHidden[id]),
          order: consoleOrder,
        },
        notes: standPayload.current?.notes ?? '',
      };
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
