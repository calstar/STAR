import './fonts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EngineConfig } from '../../api/client';
import type { RunView } from '../../api/layerx';
import { useViewState } from '../../lib/viewState';
import { byPinThenNewest, runLabel } from '../layerx/runs';
import { Engine } from './pages/Engine';
import { Feed } from './pages/Feed';
import { Flight } from './pages/Flight';
import { Hardware } from './pages/Hardware';
import { Injector } from './pages/Injector';
import type { Theme } from './pages/kit';
import { Optimize } from './pages/Optimize';
import { Overview, type PageProps } from './pages/Overview';
import { Record } from './pages/Record';
import { Stand } from './pages/Stand';
import { Uncertainty } from './pages/Uncertainty';
import { Rail, type RailStep } from './Rail';
import { Timeline } from './time/Timeline';
import { TimeProvider } from './time/TimeProvider';
import { nearestIndex } from './time/search';
import { createTimeStore, type TimeEvent } from './time/store';
import { useShortcuts } from './time/useShortcuts';
import { ShortcutSheet, TopBar } from './TopBar';
import { Badge, Button, Panel, STATUS_GLYPH, STATUS_VAR, Tabs, tabPanelProps, type TabSpec } from './ui';
import { UnitsProvider, useUnits } from './units';
import { LX_PAGES, readLxUrl, replaceLxUrl, type LxPage } from './url';
import { stageOf, useLayerXJob, type LayerXJob, type RailSection } from './useLayerXJob';
import { useRunData, type RunData } from './useRunData';
import { withContract } from './dev/contractFixture';

/** DEV ONLY: `&lxfixture=contract` dresses the open run in made-up DATA-CONTRACT blocks
 * (dev/contractFixture.ts) so the pages can be checked before the backend writes them. */
const FIXTURE = import.meta.env.DEV && typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('lxfixture') === 'contract';

/**
 * Layer X, rebuilt (docs/layerx/GUI-SPEC.md): a telemetry console for a burn that has not happened
 * yet. The top bar picks the tool and the run, the rail sets the burn up, the page tabs each answer
 * one question, and one time cursor (the docked timeline) drives every chart and number on them.
 *
 * Lifecycle is useLayerXJob's, the run's derived data useRunData's; this is layout, keyboard and
 * the URL. Mounted by App.tsx as Layer X (since the cut-over; ?lx=1 opens the old GUI for one release).
 */

const PAGES: { key: LxPage; label: string; question: string }[] = [
  { key: 'overview', label: 'Overview', question: 'Will it work?' },
  { key: 'feed', label: 'Feed', question: 'Where does the pressure go?' },
  { key: 'engine', label: 'Engine', question: 'What does the chamber see?' },
  { key: 'hardware', label: 'Hardware', question: 'What does the burn do to the engine?' },
  { key: 'flight', label: 'Flight', question: 'How does it fly?' },
  { key: 'stand', label: 'Stand', question: 'What should the stand read, and did it?' },
  { key: 'uncertainty', label: 'Uncertainty', question: 'What don\'t we know, and does it matter?' },
  { key: 'record', label: 'Record', question: 'Can I trust this run?' },
];

const NO_TIMES: readonly number[] = [];
const NO_EVENTS: readonly TimeEvent[] = [];

// ------------------------------------------------------------------ states

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => { const h = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(h); }, []);
  const s = Math.max(0, Math.round(now - since));
  return <>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</>;
}

/** Settle → Pass n: Burn / Erosion / Flight → Checks, with the progress and a cancel. */
function Running({ run, onCancel }: { run: RunView; onCancel: () => void }) {
  const st = stageOf(run);
  const top = ['Settle', st.pass > 0 ? `Pass ${st.pass}` : 'Passes', 'Checks'];
  return (
    <Panel ariaLabel="The burn is running" className="mx-auto mt-6 max-w-3xl">
      <ol className="flex items-center gap-2" aria-label="Stages">
        {top.map((label, k) => {
          const state = k < st.phase ? 'done' : k === st.phase ? 'now' : 'next';
          return (
            <li key={label} className="flex flex-1 items-center gap-2" aria-current={state === 'now' ? 'step' : undefined}>
              <span className={`lx-num flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-[11px] ${
                state === 'now' ? 'bg-[var(--lx-accent)] text-[var(--lx-on-accent)]'
                  : state === 'done' ? 'bg-[var(--lx-surface-2)] text-[var(--lx-text-2)]' : 'border border-[var(--lx-line-strong)] text-[var(--lx-text-3)]'}`}>
                {state === 'done' ? '✓' : k + 1}
              </span>
              <span className={`text-[12px] ${state === 'now' ? 'text-[var(--lx-text)]' : 'text-[var(--lx-text-3)]'}`}>{label}</span>
              {k < top.length - 1 && <span aria-hidden className="h-px flex-1 bg-[var(--lx-line)]" />}
            </li>
          );
        })}
      </ol>
      {st.phase === 1 && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
          <span className="text-[var(--lx-text-2)]">{st.caption}</span>
          <span className="flex items-center gap-1.5">
            {st.subs.map((s, k) => (
              <span key={s.key} className={`rounded-[4px] px-2 py-0.5 ${k === st.sub ? 'bg-[var(--lx-accent-soft)] text-[var(--lx-text)]' : k < st.sub ? 'text-[var(--lx-text-2)]' : 'text-[var(--lx-text-3)]'}`}>
                {k < st.sub ? '✓ ' : ''}{s.label}
              </span>
            ))}
          </span>
          <span className="text-[var(--lx-text-3)]">usually {st.typical} pass{st.typical > 1 ? 'es' : ''}</span>
        </div>
      )}
      <div className="mt-4 h-1 overflow-hidden rounded-full bg-[var(--lx-line)]" role="progressbar" aria-label="Burn progress"
           aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(run.progress * 100)}>
        <div className="h-full bg-[var(--lx-accent)] transition-[width] duration-300" style={{ width: `${Math.max(run.progress, 0.02) * 100}%` }} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-[12px] text-[var(--lx-text-3)]">
        <span className="lx-num"><Elapsed since={run.started} /> · {run.stage}</span>
        <Button size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </Panel>
  );
}

function Failed({ run }: { run: RunView }) {
  const [open, setOpen] = useState(false);
  const first = (run.error ?? 'No reason was given.').split('\n')[0];
  return (
    <Panel ariaLabel="The run failed" className="mx-auto mt-6 max-w-3xl">
      <div role="alert" className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Badge status="bad">The run failed</Badge>
        <span className="min-w-0 truncate text-[12px] text-[var(--lx-text-2)]" title={first}>{first}</span>
        {run.error && run.error.length > first.length && (
          <Button variant="bare" size="sm" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="ml-auto">Details</Button>
        )}
      </div>
      {open && <pre className="lx-num mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--lx-text-3)]">{run.error}</pre>}
    </Panel>
  );
}

/** The guided start (GUI-SPEC "States"): three steps, each lights its rail control. */
function GuidedStart({ job, onShow }: { job: LayerXJob; onShow: (step: RailStep) => void }) {
  const u = useUnits();
  const last = [...job.burns].filter((r) => r.status === 'done').sort(byPinThenNewest)[0];
  const tank = job.settings.tank_pressure_psia ?? job.configTankPsia;
  const drawn = typeof job.derived?.copv_drawn_psig === 'number' ? (job.derived.copv_drawn_psig as number) : null;
  const fill = job.settings.copv_pressure_psig ?? drawn;
  const steps: { step: RailStep; n: string; title: string; now: ReactNode; done: boolean }[] = [
    { step: 'drawing', n: '1', title: 'Pick the drawing', now: job.drawing?.name ?? 'none yet', done: !!job.drawing },
    { step: 'before', n: '2', title: 'Set tank pressure and bottle fill', done: tank !== null && fill !== null,
      now: <span className="lx-num">{u.fmt(u.p(tank))} · {fill === null ? '—' : `${Math.round(fill).toLocaleString('en-US')}\u00a0psig`}</span> },
    { step: 'run', n: '3', title: 'Run', done: false,
      now: job.pf?.ok ? 'ready' : job.pfLoading ? 'checking…' : job.pf ? 'blocked: see the rail' : '—' },
  ];
  return (
    <div className="mx-auto mt-10 max-w-xl">
      <h2 className="text-[15px] font-medium text-[var(--lx-text)]">Set up a burn</h2>
      <ol className="mt-4 space-y-2">
        {steps.map((s) => (
          <li key={s.step}>
            <button type="button" onClick={() => onShow(s.step)}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-[6px] border border-[var(--lx-line)] bg-[var(--lx-surface)] px-4 py-3 text-left hover:bg-[var(--lx-surface-2)]">
              <span className={`lx-num flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] ${s.done ? 'bg-[var(--lx-surface-2)] text-[var(--lx-ok)]' : 'border border-[var(--lx-line-strong)] text-[var(--lx-text-2)]'}`}>
                {s.done ? '✓' : s.n}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-[var(--lx-text)]">{s.title}</span>
                <span className="block truncate text-[12px] text-[var(--lx-text-3)]">{s.now}</span>
              </span>
              <span aria-hidden className="text-[12px] text-[var(--lx-text-3)]">←</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="mt-5 flex items-center gap-3">
        <Button variant="primary" disabled={!job.canRun} onClick={job.start}>Run burn</Button>
        {last && (
          <Button variant="bare" onClick={() => job.openRun(last.id)} title={runLabel(last)}>
            Open the last burn <span className="max-w-[16rem] truncate text-[var(--lx-text-3)]">{last.meta?.name || runLabel(last).split(' · ')[0]}</span>
          </Button>
        )}
      </div>
    </div>
  );
}

/** The burn on screen against the rail and the design now: the exact changes, and what to do. */
function Stale({ job }: { job: LayerXJob }) {
  const { changed, designMoved } = job;
  const [open, setOpen] = useState(false);
  if (!designMoved && !changed.length) return null;
  // A changed design is worth a warning: the figures are not this design's. Changed settings are
  // not: the rail is simply set up for the next burn, so it is one quiet line, the list on demand.
  const list = open && changed.length > 0 && (
    <ul className="basis-full flex min-w-0 flex-wrap gap-x-4 gap-y-1 pt-1 text-[12px]">
      {changed.map((c) => (
        <li key={c.key} className="whitespace-nowrap">
          <span className="text-[var(--lx-text-2)]">{c.label}</span>{' '}
          <span className="lx-num text-[var(--lx-text-3)]">{c.from}</span>
          <span className="text-[var(--lx-text-3)]"> → </span>
          <span className="lx-num text-[var(--lx-text)]">{c.to}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--lx-text-2)]"
         style={designMoved ? { borderLeft: '3px solid var(--lx-warn)', paddingLeft: 10 } : undefined}>
      {designMoved
        ? <Badge status="warn">The design changed since this burn</Badge>
        : <span>The rail differs from this burn</span>}
      {changed.length > 0 && (
        <button type="button" className="text-[var(--lx-text-3)] underline decoration-dotted underline-offset-2 hover:text-[var(--lx-text)]"
                aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {changed.length} change{changed.length > 1 ? 's' : ''}
        </button>
      )}
      <span className="ml-auto flex gap-2">
        {changed.length > 0 && <Button size="sm" variant="ghost" onClick={job.useRunSettings}>Use this burn's settings</Button>}
        <Button size="sm" onClick={job.start} disabled={!job.canRun}>Run with the rail</Button>
      </span>
      {list}
    </div>
  );
}

// ------------------------------------------------------------------ the burn pages

function BurnPage({ page, props, onConfigUpdated }: { page: LxPage; props: PageProps; onConfigUpdated?: (c: EngineConfig) => void }) {
  switch (page) {
    case 'overview': return <Overview {...props} />;
    case 'feed': return <Feed {...props} />;
    case 'engine': return <Engine {...props} />;
    case 'hardware': return <Hardware {...props} />;
    case 'flight': return <Flight {...props} />;
    case 'stand': return <Stand {...props} />;
    case 'uncertainty': return <Uncertainty {...props} />;
    case 'record': return <Record {...props} onConfigUpdated={onConfigUpdated} />;
  }
}

function tabsFor(data: RunData): TabSpec<LxPage>[] {
  const warnEvents = data.result.events.filter((e) => e.kind === 'warn').length;
  return PAGES.map((p) => ({
    key: p.key,
    label: p.label,
    title: p.question,
    badge: p.key === 'overview'
      ? <span aria-label={`, ${data.verdict === 'ok' ? 'within limits' : data.verdict === 'warn' ? 'worth a look' : 'fails'}`} className="text-[12px] font-semibold" style={{ color: STATUS_VAR[data.verdict] }}>{STATUS_GLYPH[data.verdict]}</span>
      : p.key === 'record' && warnEvents
        ? <span className="lx-num text-[11px]" style={{ color: 'var(--lx-warn)' }} aria-label={`, ${warnEvents} warnings`}>{warnEvents}</span>
        : undefined,
    disabled: p.key === 'flight' && !data.flight,
  }));
}

// ------------------------------------------------------------------ the root

export function LayerX({ config, isVisible, onConfigUpdated }: {
  config: EngineConfig | null; isVisible: boolean; onConfigUpdated?: (config: EngineConfig) => void;
}) {
  const job = useLayerXJob({ config, isVisible });
  const [theme, setTheme] = useViewState<Theme>('lx.theme', 'dark');
  const [railCollapsed, setRailCollapsed] = useViewState<boolean>('lx.railCollapsed', false);
  const [storedPage, setPage] = useViewState<LxPage>('lx.page', 'overview');
  const page: LxPage = LX_PAGES.includes(storedPage) ? storedPage : 'overview';
  const [sheet, setSheet] = useState(false);
  const [highlight, setHighlight] = useState<RailStep | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [store] = useState(() => createTimeStore());
  const shown = useMemo(() => (FIXTURE && job.result ? withContract(job.result) : job.result), [job.result]);
  const { data, ref } = useRunData(shown, job.reference?.result ?? null);

  // ---- the page fills the window below the app's header; the main column scrolls, the rail and
  // the timeline stay put.
  const rootRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(112);
  useLayoutEffect(() => {
    if (!isVisible) return;
    const measure = () => { const el = rootRef.current; if (el) setTop(Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY))); };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [isVisible]);

  // ---- the URL: read once, applied once; then kept in step.
  const [url] = useState(() => (typeof window === 'undefined' ? null : readLxUrl(window.location.search)));
  const pendingT = useRef<{ run: string | null; t: number } | null>(url?.t !== null && url?.t !== undefined ? { run: url.run, t: url.t } : null);
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || !url) return;
    applied.current = true;
    if (url.run) { job.openRun(url.run); job.setTool('burn'); }
    if (url.page) setPage(url.page);
    if (url.vs) job.setCompare(url.vs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (isVisible && applied.current) replaceLxUrl({ run: job.openRunId || null }); }, [isVisible, job.openRunId]);
  useEffect(() => { if (isVisible && applied.current) replaceLxUrl({ page }); }, [isVisible, page]);
  useEffect(() => { if (isVisible && applied.current) replaceLxUrl({ vs: job.compareWanted || null }); }, [isVisible, job.compareWanted]);
  useEffect(() => {
    if (!isVisible) return;
    let timer: number | undefined;
    let last = NaN;
    const unsub = store.subscribe(() => {
      const s = store.get();
      if (!s.range || s.t === last) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { last = s.t; replaceLxUrl({ t: store.get().t }); }, 500);
    });
    return () => { unsub(); window.clearTimeout(timer); };
  }, [isVisible, store]);

  // ---- where the cursor starts on a newly opened run: the link's moment, else mid-burn.
  const runId = job.run?.id ?? null;
  useEffect(() => {
    if (!data) return;
    const p = pendingT.current;
    if (p && (!p.run || p.run === runId)) {
      pendingT.current = null;
      store.setT(p.t);
    } else {
      // Mid-burn, on a sample: every readout and the timeline then name the same moment.
      const mid = data.fireT + 0.5 * (data.burnoutT - data.fireT);
      store.setT(data.t[nearestIndex(data.t, mid)] ?? mid);
    }
    store.flush();
  }, [data, runId, store]);

  // ---- actions the keyboard and the bars share
  const lastCompare = useRef('');
  const toggleCompare = useCallback(() => {
    if (job.compareId) { lastCompare.current = job.compareId; job.setCompare(''); return; }
    const other = [...job.burns].sort(byPinThenNewest).find((r) => r.id !== job.run?.id && r.status === 'done');
    const pick = lastCompare.current && job.burns.some((r) => r.id === lastCompare.current) ? lastCompare.current : other?.id;
    if (pick) job.setCompare(pick);
  }, [job]);
  const run = useCallback(() => { if (job.canRun) void job.start(); }, [job]);
  const toggleRail = useCallback(() => setRailCollapsed((v) => !v), [setRailCollapsed]);
  const showStep = useCallback((step: RailStep | RailSection) => {
    setRailCollapsed(false);
    const railStep: RailStep | null = step === 'drawing' || step === 'before' || step === 'run' ? step : null;
    setHighlight(railStep);
    window.setTimeout(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-lx-step="${step}"], [data-lx-section="${step}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
    }, 30);
    window.setTimeout(() => setHighlight(null), 1600);
  }, [setRailCollapsed]);
  const say = useCallback((text: string) => { setNotice(text); window.setTimeout(() => setNotice(null), 4000); }, []);
  const copyLink = useCallback(() => {
    replaceLxUrl({ run: job.openRunId || null, page, t: store.get().range ? store.get().t : null, vs: job.compareWanted || null });
    const done = () => { setNotice('Link copied'); window.setTimeout(() => setNotice(null), 1800); };
    navigator.clipboard?.writeText(window.location.href).then(done, () => setNotice('Copy the address bar'));
  }, [job.openRunId, job.compareWanted, page, store]);

  const pageKeys = useMemo(() => Object.fromEntries(PAGES.map((p, k) => [String(k + 1), () => { job.setTool('burn'); setPage(p.key); }])), [job, setPage]);
  const extra = useMemo(() => ({
    ...pageKeys,
    c: toggleCompare,
    r: run,
    '?': () => setSheet((v) => !v),
    '\\': toggleRail,
  }), [pageKeys, toggleCompare, run, toggleRail]);
  const burn = job.tool === 'burn';
  useShortcuts(burn && data ? store : null, extra, { enabled: isVisible && !sheet });

  // ---- what the main column shows
  const pageProps: PageProps | null = data ? { data, vs: ref, vsLabel: job.reference?.label ?? null, job, theme } : null;
  let main: ReactNode;
  if (!config) {
    main = <Quiet>Load an engine design first. Layer X burns the live design through a feed-system drawing.</Quiet>;
  } else if (job.status && !job.status.feedtwin.available) {
    main = <Quiet>The feed-system library is not installed in this backend: <code className="lx-num">pip install -e lib/feedtwin</code>, then restart. ({job.status.feedtwin.error})</Quiet>;
  } else if (!burn) {
    main = job.tool === 'injector'
      ? <Injector job={job} theme={theme} isVisible={isVisible} onConfigUpdated={onConfigUpdated} />
      : <Optimize job={job} theme={theme} isVisible={isVisible} config={config} onConfigUpdated={onConfigUpdated} />;
  } else if (job.live && job.run) {
    main = <Running run={job.run} onCancel={() => { void job.cancel(); }} />;
  } else if (job.run?.status === 'failed') {
    main = <Failed run={job.run} />;
  } else if (job.run?.status === 'cancelled') {
    main = <Quiet>Cancelled. <Button variant="bare" size="sm" onClick={job.closeRun}>Set up another</Button></Quiet>;
  } else if (pageProps && data) {
    main = (
      <>
        <Stale job={job} />
        {FIXTURE && (
          <div className="mb-3 text-[12px] text-[var(--lx-text-2)]">
            <Badge status="warn" size="sm">Fixture data</Badge> made-up diagnostics from dev/contractFixture.ts, not this run’s physics
          </div>
        )}
        {job.whatIfHoles && (
          <div className="mb-3 text-[12px] text-[var(--lx-text-2)]">
            <Badge status="warn" size="sm">What-if</Badge> <span className="lx-num">holes {job.whatIfHoles}</span>, not the design’s
          </div>
        )}
        <div {...tabPanelProps('lx', page)} className="outline-none">
          <BurnPage page={page} props={pageProps} onConfigUpdated={onConfigUpdated} />
        </div>
      </>
    );
  } else if (job.openRunId && !job.run) {
    main = <Quiet>Opening the run…</Quiet>;
  } else {
    main = <GuidedStart job={job} onShow={showStep} />;
  }

  const tabs = data && burn && !job.live && job.run?.status === 'done' ? tabsFor(data) : null;
  const current = PAGES.find((p) => p.key === page)!;
  // With a burn on screen the bar's controls sit beside the page's question, under the tabs;
  // before one, the bar is its own.
  const topBar = (inline: boolean) => (
    <TopBar job={job} theme={theme} onTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} onShortcuts={() => setSheet(true)}
            onRun={run} onCopyLink={copyLink} notice={notice} onNotice={say} inline={inline} />
  );

  return (
    <div ref={rootRef} className="lx flex flex-col overflow-hidden" data-theme={theme} style={{ height: `calc(100vh - ${top}px)`, minHeight: 520 }}>
      <UnitsProvider gaugeZeroPsia={data?.gaugeZeroPsia}>
        <TimeProvider store={store} series={data?.t ?? NO_TIMES} events={data?.events ?? NO_EVENTS}>
          {!tabs && topBar(false)}
          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 shrink-0">
              <Rail job={job} collapsed={railCollapsed} onToggle={toggleRail} highlight={highlight} onExpandTo={showStep} />
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto" data-lx-main>
                <div className="mx-auto w-full max-w-[1600px] px-6 pb-10">
                  {tabs ? (
                    <div className="sticky top-0 z-10 -mx-6 mb-5 bg-[var(--lx-bg)] px-6 pt-2">
                      <Tabs ariaLabel="Burn pages" idPrefix="lx" tabs={tabs} value={page} onChange={setPage}
                            subtitle={<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 pb-1"><span>{current.question}</span>{topBar(true)}</div>} />
                    </div>
                  ) : <div className="h-4" />}
                  {main}
                </div>
              </div>
              {burn && data && tabs && <div className="shrink-0"><Timeline /></div>}
            </div>
          </div>
          <ShortcutSheet open={sheet} onClose={() => setSheet(false)} />
        </TimeProvider>
      </UnitsProvider>
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <div className="mx-auto mt-16 max-w-xl text-center text-[13px] text-[var(--lx-text-2)]">{children}</div>;
}

export default LayerX;
