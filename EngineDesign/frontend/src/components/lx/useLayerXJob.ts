import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  layerx, DEFAULT_SETTINGS,
  type Drawing, type LayerXResult, type LayerXSettings, type LayerXStatus, type Preflight, type RunMeta, type RunView, type SweepResult,
} from '../../api/layerx';
import type { EngineConfig } from '../../api/client';
import { useConfigChanged } from '../../lib/configBus';
import { useViewState } from '../../lib/viewState';
import { configFingerprint } from '../../lib/engineIdentity';
import { saveTimeSeriesResults } from '../../utils/timeseriesSession';
import { pollJob } from '../layerx/jobs';
import { burnCsv } from '../layerx/csv';
import { testCardHtml } from '../layerx/testcard';
import { fmt, LB } from '../layerx/format';
import { KIND_WORD, runLabel } from '../layerx/runs';

/**
 * Layer X's run lifecycle, lifted out of layerx/LayerX.tsx so the rebuilt shell is only layout:
 * the rail's settings (view state, under the old keys so a person's settings carry over), the
 * drawings, the preflight (debounced, numbered so a slow answer never overwrites a newer one), the
 * runs list, the open run (with a stale-fetch guard), start and cancel, polling, the job the
 * backend is busy with, the sweep that belongs to each burn, the compared run, the tab-title
 * progress, and what changed since the open burn ran (the stale banner).
 *
 * Behaviour is the old component's, line for line where it could be; the one change is the
 * default drawing (helium, the hot-fire pressurant), used only when no drawing is stored.
 */

export type Stored = Omit<LayerXSettings, 'drawing_id'> & { drawing_id: string };
export type Tool = 'burn' | 'injector' | 'optimize';
/** The old view key's values: kept so the stored choice carries over ('trade' is gone: Burn). */
type MainView = 'burn' | 'trade' | 'optimise' | 'reconcile';

/** The drawing to start from when none is stored: helium, the hot-fire pressurant. */
export const DEFAULT_DRAWING = 'copv_study_he';

/** The stored drawing if it still exists; else the default by name; else the first. */
/**
 * The helium twin of a drawing, for "Use helium" on a nitrogen hot fire: the drawing named the same
 * with "he" for "gn2" (copv_study_gn2 -> copv_study_he), else -- for a shipped drawing only -- the
 * shipped hot-fire drawing. Null otherwise; then the caller swaps the gas on the drawing instead.
 * Somebody's own drawing (an upload, a pid-designer pull) is never traded for a shipped stand: on
 * LE4 that swap burned a different feed system under the user's settings.
 */
export function heliumTwin(
  current: (Pick<Drawing, 'id' | 'name'> & { source?: string }) | null,
  drawings: readonly Pick<Drawing, 'id' | 'name'>[],
): string | null {
  const name = current?.name ?? '';
  const twin = /gn2/i.test(name) ? drawings.find((d) => d.name === name.replace(/gn2/i, 'he')) : undefined;
  if (twin) return twin.id;
  const shipped = !current?.source || current.source.startsWith('shipped');
  return shipped ? (drawings.find((d) => d.name === DEFAULT_DRAWING)?.id ?? null) : null;
}

/**
 * Settings stored before 2026-10-03 carry the thermal switches at their old defaults (all off),
 * which would now override the feed twin's own Setup for every burn. Those four at exactly the old
 * defaults are the old default, not a choice: hand them back to the feed twin (null).
 */
export function withFeedTwinThermal<T extends Partial<LayerXSettings>>(s: T): T {
  const old = s.ullage_collapse === false && s.ullage_vapour === false && s.line_walls === false && s.chilldown === 0;
  return old ? { ...s, ullage_collapse: null, ullage_vapour: null, line_walls: null, chilldown: null } : s;
}

export function pickDrawing(stored: string, drawings: readonly Pick<Drawing, 'id' | 'name'>[]): string {
  if (stored && drawings.some((d) => d.id === stored)) return stored;
  return (drawings.find((d) => d.name === DEFAULT_DRAWING) ?? drawings[0])?.id ?? '';
}

export function toolOf(view: MainView | string): Tool {
  return view === 'reconcile' ? 'injector' : view === 'optimise' ? 'optimize' : 'burn';
}

function viewOf(tool: Tool): MainView {
  return tool === 'injector' ? 'reconcile' : tool === 'optimize' ? 'optimise' : 'burn';
}

// ------------------------------------------------------------------ what changed since a run

/** The rail's own words for each setting, so the banner reads like the rail. */
export const SETTING_LABEL: Partial<Record<keyof LayerXSettings, string>> = {
  drawing_id: 'Drawing', tank_pressure_psia: 'Tank pressure', copv_pressure_psig: 'Bottle fill', load: 'Propellant load',
  fill_fraction: 'Fill fraction', dry_kg: 'Unusable propellant', engine_model: 'Engine', ullage_collapse: 'Ullage collapse',
  ullage_vapour: 'Propellant vapour', chilldown: 'Tank wall heat transfer', line_walls: 'Line-wall heat',
  hold_s: 'Loaded before T−0', dt: 'Time step', horizon_s: 'Max burn', settle: 'Settle', replay: 'Nozzle erosion',
  flight: 'Flight', pressurant: 'Pressurant', liftoff_mass_kg: 'Liftoff mass',
  fuel_lead_s: 'Fuel lead',
  ack_gn2_condensation: 'GN2 over LOX anyway',
};

/** Each setting's value as the rail shows it, with its unit. */
const SETTING_SHOW: Partial<Record<keyof LayerXSettings, (v: number) => string>> = {
  tank_pressure_psia: (v) => `${fmt(v, 1)} psia`, copv_pressure_psig: (v) => `${fmt(v, 0)} psig`,
  fill_fraction: (v) => `${fmt(v * 100, 0)} %`, dry_kg: (v) => `${fmt(v, 3)} kg`, chilldown: (v) => `${fmt(v, 0)} W/m²·K`,
  hold_s: (v) => `${fmt(v, 0)} s`, dt: (v) => `${fmt(v * 1000, 0)} ms`, horizon_s: (v) => `${fmt(v, 0)} s`,
  liftoff_mass_kg: (v) => `${fmt(v / LB, 1)} lb`,
  fuel_lead_s: (v) => `${fmt(v, 2)} s`, valve_travel_s: (v) => `${fmt(v, 2)} s`, outlet_d_mm: (v) => `${fmt(v, 2)} mm`,
};
/** "Not set" says where the value comes from. */
const UNSET: Partial<Record<keyof LayerXSettings, string>> = {
  tank_pressure_psia: 'the design', copv_pressure_psig: 'the drawing', liftoff_mass_kg: 'the design', pressurant: 'as drawn',
  ullage_collapse: 'the feed twin', ullage_vapour: 'the feed twin', line_walls: 'the feed twin', chilldown: 'the feed twin',
  fuel_lead_s: '0 s',
  ack_gn2_condensation: 'off',
};

export interface SettingChange { key: keyof LayerXSettings | 'measured'; label: string; from: string; to: string }

/** What differs between the settings a burn ran with and the rail's now. */
export function settingsDiff(ran: LayerXSettings, now: LayerXSettings, drawingName: (id: string) => string): SettingChange[] {
  const show = (k: keyof LayerXSettings, v: unknown) =>
    v === null || v === undefined ? (UNSET[k] ?? 'not set') : typeof v === 'boolean' ? (v ? 'on' : 'off')
      : k === 'drawing_id' ? drawingName(String(v)) : SETTING_SHOW[k] && typeof v === 'number' ? SETTING_SHOW[k]!(v) : String(v);
  const out: SettingChange[] = [];
  for (const k of Object.keys(SETTING_LABEL) as (keyof LayerXSettings)[]) {
    const a = ran[k] ?? null;
    const b = now[k] ?? null;
    if (k === 'liftoff_mass_kg' && !ran.flight && !now.flight) continue;
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ key: k, label: SETTING_LABEL[k]!, from: show(k, a), to: show(k, b) });
  }
  return out;
}

/** The person's restatements a run used, comparable across runs (the vehicle's are its own). */
export function restatedKey(list: unknown): string {
  return JSON.stringify(((list ?? []) as { origin?: string; key?: string; value?: number }[])
    .filter((o) => o.origin !== 'vehicle').map((o) => [o.key, o.value]).sort());
}

/** The holes a what-if burned, in words: "LOX 1.588 mm, fuel 1.191 mm". */
export function whatIfHoles(patch: LayerXSettings['design_patch']): string {
  if (!patch) return '';
  return (['oxidizer', 'fuel'] as const).map((k) => {
    const d = patch[k]?.d_jet;
    return d ? `${k === 'oxidizer' ? 'LOX' : 'fuel'} ${fmt(d * 1000, 3)} mm` : null;
  }).filter(Boolean).join(', ');
}

/** The rail's sections, for the collapsed rail's dots: which differ from the design (or the defaults). */
export type RailSection = 'drawing' | 'before' | 'simulate' | 'advanced';

export function sectionsChanged(s: Stored, restated: number): Record<RailSection, boolean> {
  const d = DEFAULT_SETTINGS;
  const differs = (k: keyof typeof d) => JSON.stringify(s[k] ?? null) !== JSON.stringify(d[k] ?? null);
  return {
    drawing: restated > 0,
    before: differs('tank_pressure_psia') || differs('copv_pressure_psig') || differs('pressurant'),
    simulate: differs('replay') || differs('flight') || (!!s.flight && differs('liftoff_mass_kg')),
    advanced: (['load', 'fill_fraction', 'dry_kg', 'ullage_collapse', 'ullage_vapour', 'line_walls', 'chilldown', 'dt', 'horizon_s', 'hold_s'] as const)
      .some((k) => k === 'fill_fraction' ? s.load === 'fill' && differs(k) : differs(k))
      // The opt-in choices: unset (null) is the default, whatever DEFAULT_SETTINGS leaves out.
      || (['fuel_lead_s', 'ack_gn2_condensation'] as const)
        .some((k) => (s[k] ?? null) !== null),
  };
}

/** The stage a running burn is in (engine/layerx/analysis.py names them). */
export interface StageView {
  /** 0 settle, 1 passes, 2 checks. */
  phase: 0 | 1 | 2;
  pass: number;
  subs: { key: string; label: string }[];
  /** Index into subs of the step under way; -1 between them. */
  sub: number;
  caption: string;
  typical: number;
}

const PASS_STAGES = [
  { key: 'burn', label: 'Burn', match: /^Burning/ },
  { key: 'erosion', label: 'Erosion', match: /^Nozzle erosion/ },
  { key: 'flight', label: 'Flight', match: /^Flight/ },
] as const;

export function stageOf(run: Pick<RunView, 'stage' | 'settings'>): StageView {
  const stage = run.stage || '';
  const phase = /^Settling/.test(stage) ? 0 : /^(Checking|Done)/.test(stage) ? 2 : 1;
  const pass = Number(/pass (\d+)/.exec(stage)?.[1] ?? (phase === 1 ? 1 : 0));
  const subs = PASS_STAGES.filter((st) => (st.key !== 'erosion' || run.settings.replay !== false) && (st.key !== 'flight' || run.settings.flight));
  const sub = subs.findIndex((st) => st.match.test(stage));
  const fed = [run.settings.replay !== false && 'the eroded throat', run.settings.flight && pass >= 3 && "the flight's acceleration"].filter(Boolean);
  const caption = pass <= 1 ? 'As built' : fed.length ? `Re-burning with ${fed.join(' and ')}` : 'Re-burning';
  const typical = run.settings.flight ? 4 : run.settings.replay !== false ? 2 : 1;
  return { phase, pass, subs: subs.map(({ key, label }) => ({ key, label })), sub, caption, typical };
}

// ------------------------------------------------------------------ the hook

export interface LayerXJob {
  settings: Stored;
  set: <K extends keyof Stored>(key: K, value: Stored[K]) => void;
  setSettings: Dispatch<SetStateAction<Stored>>;
  /** What the rail would run (null without a drawing). */
  payload: LayerXSettings | null;
  status: LayerXStatus | null;

  tool: Tool;
  setTool: (t: Tool) => void;
  /** A past job picked for the Injector or Optimize tool to open. */
  focusJob: { id: string; kind: string; nonce: number } | null;
  openJob: (id: string, kind: string) => void;
  clearFocusJob: () => void;

  drawings: Drawing[];
  drawing: Drawing | null;
  loadDrawings: () => Promise<void>;
  upload: (file: File) => Promise<void>;
  uploadError: string | null;
  useDrawing: (d: Drawing) => Promise<void>;
  restated: number;
  onMeasurementsSaved: (n: number) => void;

  pf: Preflight | null;
  pfError: string | null;
  pfLoading: boolean;
  derived: Preflight['derived'] | undefined;
  configTankPsia: number | null;
  designLiftoffKg: number | null;
  designLiftoffApprox: boolean;

  runs: RunView[];
  burns: RunView[];
  loadRuns: () => Promise<void>;
  /** The open run, with what the list knows of it (drawing, name, pin). */
  run: RunView | null;
  openRunId: string;
  openRun: (id: string) => void;
  closeRun: () => void;
  result: LayerXResult | null;
  live: boolean;
  activeJob: RunView | null;
  activeWord: string;
  canRun: boolean;
  starting: boolean;
  runError: string | null;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  cancelJob: (id: string) => void;
  pin: () => void;
  annotate: (meta: RunMeta) => Promise<string | null>;
  deleteRun: () => Promise<string | null>;

  /** The compared run, once it has loaded. */
  compareId: string;
  /** The run asked to be compared against, loaded or not (what the URL carries). */
  compareWanted: string;
  setCompare: (id: string) => void;
  reference: { label: string; result: LayerXResult; run: RunView } | null;

  sweep: RunView | null;
  sweepLive: boolean;
  sweepResult: SweepResult | null;
  sweepError: string | null;
  startSweep: () => Promise<void>;

  changed: SettingChange[];
  restatedMoved: boolean;
  designMoved: boolean;
  designUnknown: boolean;
  whatIf: LayerXSettings['design_patch'] | null;
  whatIfHoles: string;
  useRunSettings: () => void;

  exportError: string | null;
  exportCsv: () => void;
  exportEng: () => Promise<void>;
  sent: boolean;
  canSend: boolean;
  sendNote: string;
  sendToForward: () => void;
  printTestCard: () => Promise<void>;
}

const download = (text: string, filename: string, type = 'text/plain') => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export function useLayerXJob({ config, isVisible }: { config: EngineConfig | null; isVisible: boolean }): LayerXJob {
  const [storedSettings, setSettings] = useViewState<Stored>('layerx.settings.v2', { ...DEFAULT_SETTINGS, drawing_id: '' });
  // Stored before a setting existed means stored without it: lay the defaults underneath.
  const settings = useMemo<Stored>(() => ({ ...DEFAULT_SETTINGS, ...withFeedTwinThermal(storedSettings) }), [storedSettings]);
  const [openRunId, setOpenRunId] = useViewState<string>('layerx.openRun', '');
  const openRunRef = useRef(openRunId);
  useEffect(() => { openRunRef.current = openRunId; }, [openRunId]);
  const [status, setStatus] = useState<LayerXStatus | null>(null);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [pf, setPf] = useState<Preflight | null>(null);
  const [pfError, setPfError] = useState<string | null>(null);
  const [pfLoading, setPfLoading] = useState(false);
  const [rawRun, setRun] = useState<RunView | null>(null);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sentId, setSentId] = useState('');
  const [compareId, setCompareId] = useViewState<string>('layerx.compare', '');
  const [compareRun, setCompareRun] = useState<RunView | null>(null);
  const [restated, setRestated] = useState(0);
  const [mainView, setMainView] = useViewState<MainView>('layerx.view', 'burn');
  const [focusJob, setFocusJob] = useState<{ id: string; kind: string; nonce: number } | null>(null);
  // A sweep belongs to the burn it was started from: run id -> sweep id.
  const [sweepByRun, setSweepByRun] = useViewState<Record<string, string>>('layerx.sweepByRun', {});
  const [sweep, setSweep] = useState<RunView | null>(null);
  const [sweepError, setSweepError] = useState<string | null>(null);
  const pfSeq = useRef(0);
  const [configTick, setConfigTick] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const set = useCallback(<K extends keyof Stored>(key: K, value: Stored[K]) => setSettings((s) => ({ ...s, [key]: value })), [setSettings]);
  const tool = toolOf(mainView);
  const setTool = useCallback((t: Tool) => setMainView(viewOf(t)), [setMainView]);

  const loadDrawings = useCallback(async () => {
    const r = await layerx.drawings();
    if (r.data) {
      const list = r.data;
      setDrawings(list);
      setSettings((s) => {
        const id = pickDrawing(s.drawing_id, list);
        return id === s.drawing_id ? s : { ...s, drawing_id: id };
      });
    }
  }, [setSettings]);
  const loadRuns = useCallback(async () => { const r = await layerx.runs(); if (r.data) setRuns(r.data); }, []);

  useEffect(() => {
    if (!isVisible) return;
    layerx.status().then((r) => r.data && setStatus(r.data));
    loadDrawings();
    loadRuns();
  }, [isVisible, loadDrawings, loadRuns]);

  // How many of this drawing's parameters this person has restated.
  useEffect(() => {
    if (!isVisible || !settings.drawing_id) return;
    layerx.parameters(settings.drawing_id).then((r) => setRestated(r.data?.overrides.length ?? 0));
  }, [isVisible, settings.drawing_id]);

  // The sweep of the burn that is open, and polling one that is going.
  const openSweepId = rawRun ? sweepByRun[rawRun.id] ?? '' : '';
  useEffect(() => {
    if (!isVisible) return;
    if (!openSweepId) { setSweep(null); return; }
    if (sweep?.id === openSweepId) return;
    setSweep(null);
    layerx.run(openSweepId).then((r) => { if (r.data && r.data.id === openSweepId) setSweep(r.data); });
  }, [isVisible, openSweepId, sweep?.id]);
  const sweepLive = !!sweep && (sweep.status === 'queued' || sweep.status === 'running');
  const sweepLiveId = sweepLive && sweep ? sweep.id : null;
  useEffect(() => {
    if (!sweepLiveId) return;
    return pollJob(sweepLiveId, 1000, setSweep, loadRuns);
  }, [sweepLiveId, loadRuns]);

  // Reopen the run this browser last looked at (or a link asked for).
  useEffect(() => {
    if (!isVisible || !openRunId || rawRun?.id === openRunId) return;
    const wanted = openRunId;
    // Only the run still wanted when its answer lands: two quick clicks must not show the first.
    layerx.run(wanted).then((r) => {
      if (openRunRef.current !== wanted) return;
      if (r.data && r.data.id === wanted) setRun(r.data);
      // A run the backend no longer has (pruned, deleted, a stale link): forget it, do not wait on it.
      else if (r.status === 404) setOpenRunId('');
    });
  }, [isVisible, openRunId, rawRun?.id, setOpenRunId]);
  // The sweep-to-burn links, kept to runs that still exist (it grew for ever in local storage).
  useEffect(() => {
    if (!runs.length) return;
    const ids = new Set(runs.map((r) => r.id));
    const kept = Object.fromEntries(Object.entries(sweepByRun).filter(([burn, sw]) => ids.has(burn) && ids.has(sw)));
    if (Object.keys(kept).length !== Object.keys(sweepByRun).length) setSweepByRun(kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  useConfigChanged(useCallback(() => setConfigTick((n) => n + 1), []));

  // Preflight follows the settings, debounced. Each request is numbered so a slow answer to an
  // older question never overwrites a newer one. One engine: EngineDesign's, through its card.
  const payload = useMemo<LayerXSettings | null>(
    () => (settings.drawing_id ? { ...settings, engine_model: 'card' } : null), [settings]);
  const key = JSON.stringify(payload);
  useEffect(() => {
    if (!isVisible || !payload || !config) return;
    const seq = ++pfSeq.current;
    setPfLoading(true);
    const handle = setTimeout(async () => {
      const r = await layerx.preflight(payload);
      if (seq !== pfSeq.current) return;
      setPfLoading(false);
      if (r.error) { setPfError(r.error); setPf(null); } else { setPfError(null); setPf(r.data ?? null); }
    }, 650);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, isVisible, configTick, config]);

  // Poll a live run, by id: a response for a run no longer open never replaces the one that is.
  const live = !!rawRun && (rawRun.status === 'queued' || rawRun.status === 'running');
  const liveId = live && rawRun ? rawRun.id : null;
  useEffect(() => {
    if (!liveId) return;
    return pollJob(liveId, 500, setRun, loadRuns);
  }, [liveId, loadRuns]);

  // Any job of this user's still going, whatever view started it: the backend runs one at a time.
  const activeJob = runs.find((r) => r.status === 'queued' || r.status === 'running') ?? null;
  // Its progress in the tab's title, so a two-minute study can be left in another tab.
  const titlePct = activeJob ? Math.round((activeJob.progress ?? 0) * 100) : null;
  useEffect(() => {
    if (titlePct === null) return;
    const before = document.title;
    document.title = `${titlePct} % · Layer X`;
    return () => { document.title = before; };
  }, [titlePct]);
  useEffect(() => {
    if (!activeJob || !isVisible) return;
    const handle = setInterval(loadRuns, 2000);
    return () => clearInterval(handle);
  }, [activeJob, isVisible, loadRuns]);

  // The request preflights before it answers (~3 s): one click is one run.
  const start = async () => {
    if (!payload || starting) return;
    setRunError(null);
    setStarting(true);
    const r = await layerx.start(payload).finally(() => setStarting(false));
    if (r.error || !r.data) {
      setRunError(r.error ?? 'Could not start the run.');
      // The backend refused what the rail showed as ready: its design changed underneath (a
      // reload, another tab). Re-check so the rail says what the backend now holds.
      setConfigTick((n) => n + 1);
      return;
    }
    setOpenRunId(r.data.id);
    setMainView('burn');
    setRun({ id: r.data.id, status: r.data.status, stage: 'Starting', progress: 0, error: null, started: Date.now() / 1000,
             finished: null, design: '', settings: payload });
    loadRuns();
  };
  const cancel = async () => { if (rawRun) await layerx.cancel(rawRun.id); };
  const cancelJob = (id: string) => { layerx.cancel(id).then(loadRuns); };

  const startSweep = async () => {
    // From the burn that is open, not from whatever the rail says now.
    if (!rawRun) return;
    const base = { ...DEFAULT_SETTINGS, ...rawRun.settings } as LayerXSettings;
    const owner = rawRun.id;
    setSweepError(null);
    const r = await layerx.startUncertainty(base);
    if (r.error || !r.data) { setSweepError(r.error ?? 'Could not start the sweep.'); return; }
    const id = r.data.id;
    setSweepByRun((m) => ({ ...m, [owner]: id }));
    setSweep({ id, kind: 'uncertainty', status: r.data.status, stage: 'Starting', progress: 0, error: null,
               started: Date.now() / 1000, finished: null, design: '', settings: base });
    loadRuns();
  };
  const upload = async (file: File) => {
    setUploadError(null);
    const r = await layerx.upload(file);
    if (r.error) { setUploadError(r.error); return; }
    await loadDrawings();
    if (r.data) set('drawing_id', r.data.id);
  };
  const useDrawing = async (d: Drawing) => { await loadDrawings(); set('drawing_id', d.id); };

  const drawing = drawings.find((d) => d.id === settings.drawing_id) ?? null;
  const derived = pf?.derived;
  const configTankPsia = useMemo(() => {
    const t = (config?.lox_tank as { initial_pressure_psi?: number } | undefined)?.initial_pressure_psi;
    return typeof t === 'number' ? t : null;
  }, [config]);

  // The burn to compare against: any other finished burn, fetched once when picked.
  useEffect(() => {
    if (!compareId || compareRun?.id === compareId) return;
    layerx.run(compareId).then((r) => {
      if (r.data && r.data.status === 'done' && (r.data.kind ?? 'run') === 'run') setCompareRun(r.data);
      else setCompareId('');
    });
  }, [compareId, compareRun?.id, setCompareId]);
  const setCompare = useCallback((id: string) => { setCompareId(id); if (!id) setCompareRun(null); }, [setCompareId]);
  // One object per pick, not per render: the charts rebuild their merged data when it changes.
  const runId = rawRun?.id;
  const reference = useMemo(() => (compareId && compareRun?.id === compareId && compareId !== runId && compareRun.result
    ? { label: runLabel(compareRun), result: compareRun.result as LayerXResult, run: compareRun } : null), [compareId, compareRun, runId]);

  const result = rawRun?.status === 'done' && (rawRun.kind ?? 'run') === 'run' ? (rawRun.result as LayerXResult | null) ?? null : null;
  // The design's vehicle on the rail: the last flight's own total when it flew the design's
  // airframe, otherwise the config's empty vehicle plus the propellant (the gas is not known yet).
  const lastBudget = result?.flight?.ok ? result.flight.mass_budget : null;
  const designLiftoffExact = lastBudget && lastBudget.airframe_source === 'config' ? lastBudget.liftoff_kg : null;
  const dryKg = typeof derived?.vehicle_dry_kg === 'number' ? derived.vehicle_dry_kg : null;
  const propKg = derived?.loads_kg ? Object.values(derived.loads_kg as Record<string, number>).reduce((a, b) => a + b, 0) : null;
  const designLiftoffKg = designLiftoffExact ?? (dryKg !== null && propKg !== null ? dryKg + propKg : null);
  const sweepResult = sweep?.status === 'done' && sweep.id === openSweepId ? (sweep.result as SweepResult | null) ?? null : null;

  // The burn on screen against the rail and the design now.
  const drawingName = (id: string) => drawings.find((d) => d.id === id)?.name ?? id.slice(0, 8);
  const changedSettings = result && rawRun && payload ? settingsDiff({ ...DEFAULT_SETTINGS, ...rawRun.settings } as LayerXSettings, payload, drawingName) : [];
  const restatedMoved = !!(result && pf?.derived && restatedKey(result.provenance.derived?.overrides) !== restatedKey(pf.derived.overrides));
  // A what-if ran on a modified copy of the design on purpose: its hash differs, and that is not "moved".
  const whatIf = rawRun?.settings?.design_patch ?? null;
  const designMoved = !whatIf && !!(result && pf?.derived?.config_sha256 && result.provenance.config_sha256 !== pf.derived.config_sha256);
  // Only a settled preflight vouches for the design: one still in flight (a design just loaded) or
  // one that failed says nothing, so nothing is handed on or written until it has spoken.
  const designUnknown = !pf?.derived?.config_sha256 || pfLoading;
  // A preflight still settling does not block the click: the server preflights the run itself.
  const canRun = !!pf?.ok && !live && !activeJob && !starting;

  const burns = runs.filter((r) => (r.kind ?? 'run') === 'run');
  // The open run as the list knows it too: the list carries its drawing, name and pin.
  const listed = rawRun ? runs.find((x) => x.id === rawRun.id) : undefined;
  const openMeta = listed?.meta ?? rawRun?.meta;
  const run = useMemo(() => (rawRun ? { ...rawRun, drawing: rawRun.drawing ?? listed?.drawing, meta: openMeta } : null), [rawRun, listed?.drawing, openMeta]);

  const sendNote = whatIf ? 'A what-if: these holes are not the design’s. Write them into the design on the Injector tool first.'
    : designMoved ? 'Made on an older version of the design. Run it again first.'
    : designUnknown ? 'Checking the design…' : 'Forward mode and the Flight tab use this burn.';

  return {
    settings, set, setSettings, payload, status,
    tool, setTool,
    focusJob, openJob: (id, kind) => setFocusJob({ id, kind, nonce: Date.now() }), clearFocusJob: () => setFocusJob(null),
    drawings, drawing, loadDrawings, upload, uploadError, useDrawing,
    restated, onMeasurementsSaved: (n) => { setRestated(n); setConfigTick((t) => t + 1); },
    pf, pfError, pfLoading, derived, configTankPsia, designLiftoffKg, designLiftoffApprox: designLiftoffExact === null,
    runs, burns, loadRuns, run, openRunId,
    openRun: (id) => setOpenRunId(id),
    closeRun: () => { setOpenRunId(''); setRun(null); },
    result, live, activeJob, activeWord: activeJob ? KIND_WORD[activeJob.kind ?? 'run'] ?? 'run' : '',
    canRun, starting, runError, start, cancel, cancelJob,
    pin: () => { if (run) layerx.annotate(run.id, { pinned: !openMeta?.pinned }).then(loadRuns); },
    annotate: async (meta) => {
      if (!run) return 'No run is open.';
      const r = await layerx.annotate(run.id, meta);
      if (r.error) return r.error;
      loadRuns();
      return null;
    },
    deleteRun: async () => {
      if (!run) return null;
      const r = await layerx.deleteRun(run.id);
      if (r.error) return r.error;
      setOpenRunId(''); setRun(null); loadRuns();
      return null;
    },
    compareId: reference ? compareId : '', compareWanted: compareId, setCompare, reference,
    sweep, sweepLive, sweepResult, sweepError, startSweep,
    changed: restatedMoved ? [...changedSettings, { key: 'measured', label: 'Measured values', from: 'as run', to: 'changed' }] : changedSettings,
    restatedMoved, designMoved, designUnknown, whatIf, whatIfHoles: whatIfHoles(whatIf),
    useRunSettings: () => { if (rawRun) setSettings({ ...DEFAULT_SETTINGS, ...rawRun.settings, design_patch: null } as Stored); },
    exportError,
    exportCsv: () => { if (result && run) download(burnCsv(result, run.id), `layerx_${run.id}.csv`, 'text/csv'); },
    exportEng: async () => {
      if (!run) return;
      setExportError(null);
      const r = await layerx.exportEng(run.id);
      if (r.error || !r.data) { setExportError(r.error ?? 'Export failed.'); return; }
      download(r.data.text, r.data.filename);
    },
    sent: !!run && sentId === run.id,
    canSend: !!result?.timeseries && !designMoved && !designUnknown && !whatIf,
    sendNote,
    sendToForward: () => { if (result?.timeseries && run) { saveTimeSeriesResults(result.timeseries, configFingerprint(config)); setSentId(run.id); } },
    printTestCard: async () => {
      if (!result || !run) return;
      // Opened on the click itself, so a popup blocker lets it through; filled once the channel map is in.
      const w = window.open('', '_blank');
      if (!w) { setExportError('The browser blocked the test card window.'); return; }
      const ch = await layerx.channels(result.provenance.drawing.id);
      w.document.write(testCardHtml(result, run, ch.data?.channels ?? {}, sweepResult));
      w.document.close();
    },
  };
}
