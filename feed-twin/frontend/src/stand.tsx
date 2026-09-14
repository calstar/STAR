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
import {
  commandSession,
  getModel,
  getStateMachine,
  listArtifacts,
  openSession,
  sessionHistory,
  tickSession,
  type Artifact,
  type ModelView,
  type RunResult,
  type SessionState,
  type StandSetup,
  type StateMachine,
  type Where,
} from './api';

/** Target wall-clock gap between ticks [ms]. The solve usually beats it; when
 *  it does not, the next tick simply carries a larger dt. */
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
  release: () => void;
  restart: () => void;
  refresh: () => Promise<Artifact[]>;
}

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
  const [running, setRunning] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [setup, setSetupState] = useState<StandSetup>({
    dome: 500,
    copv_target: 4500,
    copv_fill_s: 25,
    tank_fill_s: 120,
    fuel_fill_s: 15,
    bottle_delivered: false,
    fill_stirring: 20,
    ullage_collapse: true,
    ullage_vapour: true,
    chilldown: 100,
    line_walls: false,
    ambient_leak: 8,
  });
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [generation, setGeneration] = useState(0);

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
        const saved = raw ? (JSON.parse(raw) as { id?: string; diagram?: string; engine?: string }) : null;
        return saved && saved.diagram === diagram && saved.engine === engine && saved.id ? saved.id : '';
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
      return openSession(where, { state: 'Idle', ...setup });
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
          window.localStorage.setItem('feedtwin.session', JSON.stringify({ id: first.id, diagram, engine }));
        } catch {
          // Storage can be unavailable; the stand still works for this tab.
        }
        // The stand's knobs are the stand's: a reattached session says where
        // its regulators are, and the GSE tab must show that, not the defaults.
        if (first.setup) setSetupState((s) => ({ ...s, ...first.setup }) as StandSetup);
        setLive(first);
        setHistory(null);
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
      const dt = Math.min((now - last.current) / 1000, MAX_DT);
      last.current = now;
      try {
        const next = await tickSession(session.current, dt);
        if (!alive.current) return;
        // While the run is being computed ahead the display holds its frame;
        // the wall clock that passes must not be handed to the first replay
        // tick as a quarter-second jump into the burn.
        if (next.computing) last.current = performance.now();
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
      if (alive.current) timer = window.setTimeout(pump, TICK_MS);
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

  const value: StandValue = {
    artifacts,
    model,
    machine,
    live,
    history,
    running,
    busy,
    error,
    speed,
    where,
    setup,
    setSetup: (patch) => {
      const next = { ...setup, ...patch } as StandSetup;
      setSetupState(next);
      void command({ setup: patch });
    },
    setRunning,
    hidden,
    toggleChannel: (id) => setHidden((h) => ({ ...h, [id]: !h[id] })),
    pick: (kind, id) => (kind === 'diagram' ? setDiagram(id) : setEngine(id)),
    go: (state) => void command({ state }),
    toggleValve: (id) =>
      void command({ valve: id, open: !(live?.open[id] ?? false) }),
    release: () => void command({ release: '*' }),
    restart: () => {
      wantFresh.current = true;
      setGeneration((g) => g + 1);
    },
    refresh,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
