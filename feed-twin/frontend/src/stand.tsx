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
import { standApi, type StandPayload } from './stands';
import {
  commandSession,
  getHookup,
  getModel,
  getStateMachine,
  listArtifacts,
  openSession,
  sessionBurns,
  sessionT0,
  sessionHistory,
  tickSession,
  type Artifact,
  type Burns,
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

interface StandValue {
  artifacts: Artifact[];
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
  pick: (kind: 'diagram' | 'engine', id: string) => void;
  go: (state: string) => void;
  toggleValve: (id: string) => void;
  /** Turn one of the hookup's knobs [psig]. The dome knob is `setSetup({dome})`. */
  turnKnob: (id: string, value: number) => void;
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
  /** Open a stand document: its drawing, engine, settings, hookup and knobs,
   *  on a fresh session. */
  openStand: (ref: DocRef, name: string) => Promise<void>;
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
  /** Change the stand's hookup (kept with the stand; Save writes it). */
  setStandHookup: (hookup: Record<string, unknown>) => void;
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

const Ctx = createContext<StandValue | null>(null);

export const useStand = () => {
  const value = useContext(Ctx);
  if (!value) throw new Error('useStand outside StandProvider');
  return value;
};

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
  const [setup, setSetupState] = useState<StandSetup>({
    dome: 500,
    copv_target: 4500,
    copv_fill_s: 9.7,
    tank_fill_s: 120,
    fuel_fill_s: 15,
    dewar_psi: 100,
    dewar_fill_cv: 0.019,
    bottle_delivered: false,
    fill_stirring: 20,
    ullage_collapse: true,
    ullage_vapour: true,
    chilldown: 100,
    line_walls: true,
    ambient_leak: 8,
  });
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [generation, setGeneration] = useState(0);
  const [standDoc, setStandDoc] = useState<OpenStand | null>(readStand);
  // Taking the checkout must not reload the stand: that would reopen the
  // session and throw away the run on screen.
  const checkout = useCheckout({ api: standApi, ref: standDoc?.ref ?? null, reload: () => undefined });
  const locked = Boolean(standDoc) && !checkout.held;
  /** The open stand's hookup and knobs, applied to every fresh session on it. */
  const standPayload = useRef<StandPayload | null>(null);

  const where: Where = { diagram, engine, fluidSet: 'hotfire', machine: 'diablo' };
  const session = useRef('');
  /** Set by Reset: the next open must be a new stand, not the remembered one. */
  const wantFresh = useRef(false);
  const last = useRef(0);
  const alive = useRef(true);
  /** Stand seconds per wall second over the last few ticks. A stiff stand
   *  (helium's regulator-ullage loop steps at a millisecond) integrates
   *  slower than real time; the panel then runs in slow motion and says so,
   *  rather than freezing. */
  const [speed, setSpeed] = useState(1);
  const pace = useRef<{ wall: number; t: number } | null>(null);

  const refresh = useCallback(async () => {
    const list = await listArtifacts();
    setArtifacts(list);
    return list;
  }, []);

  useEffect(() => {
    refresh()
      .then((list) => {
        // The list is newest first. Prefer what this browser used last time,
        // if it is still in the library; otherwise the newest stand drawing
        // (the study drawings are for the Study tab), and the newest engine.
        //
        // The engine used to be picked only when the library held exactly
        // one. With two it picked none, silently: the console opened with no
        // engine, no chamber and nothing that could light, and the only sign
        // was an Engine section that was not there.
        const diagrams = list.filter((a) => a.kind === 'diagram');
        const engines = list.filter((a) => a.kind === 'engine');
        const remembered = (kind: 'diagram' | 'engine') => {
          try {
            const id = window.localStorage.getItem(`feedtwin.${kind}`);
            return id && list.some((a) => a.kind === kind && a.id === id) ? id : '';
          } catch {
            return '';
          }
        };
        const stand = diagrams.find((a) => /stand/i.test(a.name)) ?? diagrams[0];
        const pickedDiagram = remembered('diagram') || stand?.id || '';
        const pickedEngine = remembered('engine') || engines[0]?.id || '';
        if (pickedDiagram) setDiagram(pickedDiagram);
        if (pickedEngine) setEngine(pickedEngine);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [refresh]);

  /** Remember the picks, so reopening the tab lands on the same stand. */
  useEffect(() => {
    try {
      if (diagram) window.localStorage.setItem('feedtwin.diagram', diagram);
      if (engine) window.localStorage.setItem('feedtwin.engine', engine);
    } catch {
      // Storage can be unavailable; the picks still work for this tab.
    }
  }, [diagram, engine]);

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
    session.current = '';
    setBusy(true);
    setError('');
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
      const id = remembered();
      if (id) {
        try {
          return await tickSession(id, 1e-3);
        } catch {
          // The backend forgot it (restart, deploy); a fresh stand is honest.
        }
      }
      // A stand document: the run records name it, and its own hookup is used
      // for this session without touching the drawing's saved one.
      let onStand = standDoc;
      if (onStand && !standPayload.current) {
        try {
          standPayload.current = await standApi.load(onStand.ref);
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
      // The stand's hookup and knob positions belong to the drawing it was
      // saved with. On another drawing they name valves and regulators that
      // are not there: the drawing's own hookup is used, and saving the stand
      // records the drawing it is now on.
      const doc = onStand && standPayload.current?.diagram === diagram ? standPayload.current : null;
      const opened = await openSession(where, {
        state: 'Idle',
        ...setup,
        ...(onStand ? { stand: { id: onStand.ref.id, owner: onStand.ref.owner ?? '' } } : {}),
        ...(doc && Object.keys(doc.hookup).length ? { hookup: doc.hookup } : {}),
      });
      const knobs = (doc?.operating_point?.knobs ?? {}) as Record<string, number>;
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
        const [view, sm, first] = await Promise.all([
          getModel(diagram, engine, 'hotfire'),
          getStateMachine(where),
          reopen(),
        ]);
        if (cancelled) return;
        setModel(view);
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
        setHistory(null);
        setBurns(null);
        last.current = performance.now();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
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
      const dt = Math.min((now - last.current) / 1000, MAX_DT);
      last.current = now;
      try {
        const next = await tickSession(session.current, dt);
        if (!alive.current) return;
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
        setError('');
      } catch (e) {
        if (!alive.current) return;
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        // The backend restarted and forgot the stand. Sessions live in
        // memory, so this is what a dev reload, a deploy or a crash looks
        // like from here: every tick 404s and the panel freezes on its last
        // frame with the clock stopped. Open a fresh stand instead -- cold
        // and empty, which is honest -- and say so.
        if (/no session/i.test(message)) {
          session.current = '';
          wantFresh.current = true;
          setError('The stand was restarted; this is a fresh one. ' + message);
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

  /** Pull the trace periodically — it is bulky and only the plot reads it. */
  useEffect(() => {
    if (!session.current) return undefined;
    const pull = () => {
      if (!session.current) return;
      sessionHistory(session.current).then(setHistory).catch(() => undefined);
      sessionBurns(session.current).then(setBurns).catch(() => undefined);
    };
    pull();
    const id = window.setInterval(pull, 1500);
    return () => window.clearInterval(id);
  }, [live?.id]);

  const command = useCallback(
    async (body: Parameters<typeof commandSession>[1]) => {
      if (!session.current) return;
      // Wall clock is reset so the next tick does not charge the stand for the
      // time this round trip took.
      try {
        const next = await commandSession(session.current, body);
        setLive(next);
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
      setSetupState(next);
      void command({ setup: patch });
    },
    setRunning,
    hidden,
    toggleChannel: (id) => setHidden((h) => ({ ...h, [id]: !h[id] })),
    pick: (kind, id) => {
      if (locked) return refuse();
      if (kind === 'diagram') setDiagram(id);
      else setEngine(id);
    },
    go: (state) => void command({ state }),
    toggleValve: (id) =>
      void command({ valve: id, open: !(live?.open[id] ?? false) }),
    turnKnob: (id, value) => {
      if (locked) return refuse();
      void command({ knob: { id, value } });
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
    openStand: async (ref, name) => {
      const doc = await standApi.load(ref);
      standPayload.current = doc;
      const opened = { ref, name };
      setStandDoc(opened);
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
      standPayload.current = null;
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
    setStandHookup: (hookup) => {
      if (locked || !standPayload.current) return refuse();
      standPayload.current = { ...standPayload.current, diagram, hookup };
      wantFresh.current = true;
      setGeneration((g) => g + 1);
    },
    snapshot: async () => {
      const hookup = await getHookup(where).catch(() => null);
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
          : ((hookup?.hookup ?? {}) as unknown as Record<string, unknown>),
        operating_point: {
          knobs: Object.fromEntries((live?.knobs ?? []).map((k) => [k.id, k.psig])),
        },
        notes: standPayload.current?.notes ?? '',
      };
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
