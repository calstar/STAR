import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { ConfigUpload } from './components/ConfigUpload';
import { ConfigEditor } from './components/ConfigEditor';
import { ParametersWorkspace } from './components/ParametersWorkspace';
import { ForwardMode } from './components/ForwardMode';
import { TimeSeriesMode } from './components/TimeSeriesMode';
import { CustomPlotter } from './components/CustomPlotter';
import { FlightSimulation } from './components/FlightSimulation';
import { ChamberGeometry } from './components/ChamberGeometry';
import { Optimizer } from './components/Optimizer';
import { ControllerMode } from './components/ControllerMode';
import { OptimizerDemo } from './components/OptimizerDemo';
import { wantsGallery, wantsLayerXTab, wantsV2 } from './components/lx/url';
import ConfigurationSelector from './components/ConfigurationSelector';
import { emitConfigChanged } from './lib/configBus';
import { useViewState } from './lib/viewState';
import { DesignVersions } from './components/DesignVersions';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ReadOnlyProvider, SuiteSwitcher } from '@stardesign-ui';
import { getHealth } from './api/client';
import type { EngineConfig } from './api/client';
import { resolveTab, visibleTabs, wantsAdvanced, type Tab } from './lib/tabs';

// Injected by vite.config.ts from ENGINE_DESIGN_API_PORT. Named only in the
// disconnected message's hover, for whoever runs the server.
declare const __API_PORT__: string
const API_PORT = typeof __API_PORT__ === 'undefined' ? '8000' : __API_PORT__

// Layer X is the rebuilt GUI (components/lx) since the cut-over of 2026-10-03. `?lx=1` opens the old
// one (components/layerx) for one release -- TODO(next release): remove it and this switch. Each is
// fetched only when its tab is opened, and the dev gallery (?lx-gallery=1) only when asked for.
// Read once, at load: switching is a reload, never a remount mid-session.
const LayerXV2 = lazy(() => import('./components/lx/LayerX'));
const LayerXOld = lazy(() => import('./components/layerx/LayerX').then((m) => ({ default: m.LayerX })));
const LxGallery = lazy(() => import('./components/lx/dev/Gallery'));
const LX_SEARCH = typeof window === 'undefined' ? '' : window.location.search;
const LX_V2 = wantsV2(LX_SEARCH);
const LX_GALLERY = wantsGallery(LX_SEARCH);
// The prototype views (Controller, Demo, Custom Plotter) are listed only with ?advanced=1.
const ADVANCED = wantsAdvanced(LX_SEARCH);
const TAB_STRIP = visibleTabs(ADVANCED);

function App() {
  // Which tab you were on is yours, not the design's -- remembered locally so
  // a reload puts you back without it counting as an edit to a shared design.
  const [storedTab, setActiveTab] = useViewState<Tab>('activeTab', 'forward');
  const activeTab = resolveTab(storedTab, ADVANCED);
  // A Layer X link (?lx=1 or ?lx=2&run=...) opens on Layer X, whatever tab was last open.
  useEffect(() => { if (wantsLayerXTab(LX_SEARCH)) setActiveTab('layerx'); }, [setActiveTab]);
  const lxFull = activeTab === 'layerx' && LX_V2;
  // Layer X's code is fetched the first time its tab opens, then kept mounted like every other tab.
  const [lxSeen, setLxSeen] = useState(false);
  useEffect(() => { if (activeTab === 'layerx') setLxSeen(true); }, [activeTab]);
  const [configView, setConfigView] = useViewState<'parameters' | 'sections'>('configView', 'parameters');
  const [config, setConfig] = useState<EngineConfig | null>(null);
  // A design is editable only while it is checked out to you. The editor reads
  // this through ReadOnlyProvider, so a new input cannot accidentally stay live
  // when someone else holds the design.
  const [editable, setEditable] = useState(false);
  const [isConnected, setIsConnected] = useState<boolean | null>(null);

  // Keep all tab panels mounted; hide inactive ones to preserve state
  const tabPanelClass = (tab: Tab) => (activeTab === tab ? '' : 'hidden');

  // The first design is open (or the session's config stands in for one). Until then the tabs
  // are not drawn: every panel that reads the backend on mount would read the config a fresh
  // session starts with -- configs/default.yaml, methalox -- and Forward Mode would then call the
  // switch to the design a propellant change ("previous results cleared") on a page nobody touched.
  const [booted, setBooted] = useState(false);
  const handleBooted = useCallback(() => setBooted(true), []);
  // Bumped by Retry, and every 10 s while the backend is down, to run the probe again.
  const [probe, setProbe] = useState(0);

  // Check backend health on mount. The design itself is opened by DesignVersions once this
  // reports the backend up (its `ready` prop): it picks the design and hands it to handleRestore.
  //
  // This RETRIES. A single attempt raced the backend on every `dev.sh --restart`:
  // vite is serving in about a second but importing backend.main takes ~6 s (numba
  // warm plus the router graph), and dev.sh prints the URLs without waiting for
  // /api/health. Reload inside that window and the one probe failed, isConnected
  // latched false, and "Backend not connected" stayed up until a manual reload --
  // while the backend had in fact come up fine seconds later.
  //
  // Backoff caps at ~30 s total, which covers a cold start with a CEA cache build.
  // isConnected stays null (banner hidden) while retries are in flight, so a slow
  // start reads as "still loading" rather than a false error.
  useEffect(() => {
    let cancelled = false;
    const DELAYS_MS = [250, 500, 1000, 2000, 3000, 4000, 5000, 6000, 8000];

    async function init() {
      for (let attempt = 0; attempt <= DELAYS_MS.length; attempt++) {
        if (cancelled) return;
        const healthResult = await getHealth();
        if (cancelled) return;

        if (!healthResult.error) {
          setIsConnected(true);
          return;
        }

        if (attempt === DELAYS_MS.length) break;   // out of retries
        await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
      }
      if (!cancelled) setIsConnected(false);
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [probe]);

  // While the backend is down, look again every 10 s, so it comes back without a reload.
  useEffect(() => {
    if (isConnected !== false) return;
    const id = setTimeout(() => setProbe((n) => n + 1), 10_000);
    return () => clearTimeout(id);
  }, [isConnected, probe]);

  const handleConfigLoaded = (newConfig: EngineConfig) => {
    setConfig(newConfig);
    emitConfigChanged(newConfig); // uploading a different-injector config also refreshes dependent UI
  };

  // Stable identity is load-bearing: DesignVersions.apply -> openDoc -> its
  // bootstrap effect all depend on this via useCallback, and the effect calls
  // setConfig. An inline arrow here mints a new identity every render, so the
  // effect re-runs on its own setConfig and the app fetches in a tight loop
  // forever (the "stuck on Connecting…" hang). useCallback([]) breaks the cycle.
  const handleRestore = useCallback((c: EngineConfig) => {
    setConfig(c);
    emitConfigChanged(c);
  }, []);

  if (LX_GALLERY) return <Suspense fallback={null}><LxGallery /></Suspense>;

  // Shown in place of a panel when no design could be loaded at all (no stored design and no
  // default config on the server): the one way in is a file.
  const loadPrompt = booted && !config && (
    <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
      <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load a design</h3>
      <ConfigUpload onConfigLoaded={handleConfigLoaded} />
    </div>
  );

  return (
    // The whole app, not just <main>: the injector / propellant selectors sit up
    // in the header, and switching either rewrites the config wholesale -- as
    // much an edit as typing in a field. Gating is opt-in, so the designs bar
    // inside is unaffected: Take / Release / History have to stay live exactly
    // when you do not hold the design.
    <ReadOnlyProvider readOnly={!editable}>
    <div className="min-h-screen flex flex-col bg-[var(--color-bg-primary)]">
      {/* Header: full width, like the other Hotbench apps and Layer X. */}
      <header className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <div className="px-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1.5 py-2">
            <div className="flex items-center gap-4 shrink-0">
              {/* The suite's own end of the header, the same in every Hotbench
                  app: the wordmark and Engine | P&ID | Twin. */}
              <SuiteSwitcher app="engine" />
            </div>

            {/* First-class config selectors + connection status. The selectors follow the
                open design, so they wait for it rather than show the server's default first. */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 min-w-0">
              {booted && <ConfigurationSelector onConfigChange={setConfig} />}
              <div className="flex items-center gap-2" title={isConnected ? 'The engine design server is answering' : undefined}>
                <div className={`w-2 h-2 rounded-full ${isConnected === null ? 'bg-yellow-500 animate-pulse' :
                  isConnected ? 'bg-green-500' : 'bg-red-500'
                  }`} />
                <span className="text-xs text-[var(--color-text-secondary)]">
                  {isConnected === null ? 'Connecting' :
                    isConnected ? 'Connected' : 'Not connected'}
                </span>
              </div>
            </div>
          </div>

          {/* Versioned designs, tucked between the title and the tabs so the
              design you are on sits with the rest of the app chrome. */}
          <div className="border-t border-[var(--color-border)]">
            <DesignVersions
              onRestore={handleRestore}
              onEditableChange={setEditable}
              ready={isConnected === true}
              onBooted={handleBooted}
              inline
            />
          </div>

          {/* Navigation tabs. One accent for all of them; the prototypes are listed with ?advanced=1. */}
          <nav className="flex gap-1 -mb-px overflow-x-auto" aria-label="Views">
            {TAB_STRIP.map((t, i) => (
              <button
                key={t.id}
                type="button"
                title={t.hint}
                aria-current={activeTab === t.id ? 'page' : undefined}
                onClick={() => setActiveTab(t.id)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  t.advanced && !TAB_STRIP[i - 1]?.advanced ? 'ml-3 ' : ''
                }${activeTab === t.id
                  ? 'border-[var(--color-accent)] text-[var(--color-text-primary)]'
                  : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Main content */}
      {/* The rebuilt Layer X is full width, and fills the window below the header (its tab only). */}
      <main className={lxFull ? 'flex-1' : 'flex-1 w-full max-w-[1536px] mx-auto px-4 sm:px-6 py-6'}>
        {/* Inputs go grey without the checkout. Reading the design stays live:
            Forward mode, the plotter and the charts never write it back. The
            optimizer layers DO write their result into the config (see
            backend/routers/optimizer.py), so those runs are gated too. */}
        {isConnected === false && (
          <div role="alert" className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-300"
               title={`The engine design server is expected on port ${API_PORT}.`}>
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div className="flex-1">
                <p className="font-semibold">The engine design server is not answering.</p>
                <p className="text-sm text-[var(--color-text-secondary)] mt-0.5">
                  Nothing you saved is lost. This page keeps trying every few seconds; it picks up where you were as soon as the server is back.
                </p>
              </div>
              <button type="button" onClick={() => { setIsConnected(null); setProbe((n) => n + 1); }}
                      className="shrink-0 px-3 py-1.5 rounded-lg border border-red-500/40 text-sm text-red-200 hover:bg-red-500/10">
                Try now
              </button>
            </div>
          </div>
        )}

        {/* Opening the design: a line, not the panels' "no config" placeholders. */}
        {!booted && isConnected !== false && (
          <div className="py-24 text-center text-sm text-[var(--color-text-secondary)]" aria-live="polite">
            Opening the design…
          </div>
        )}

        {/* Keep all tab panels mounted; hide inactive ones to preserve state. They mount before
            the design opens -- each registers its slice of the stored design, which the design bar
            writes back when it opens one -- but stay out of sight until it has. */}
        <div className={booted ? '' : 'hidden'}>
        <div className={tabPanelClass('forward')}>
          <ErrorBoundary label="Forward Mode">
            <div className="space-y-6">
              {loadPrompt}
              <ForwardMode config={config} onConfigUpdated={handleConfigLoaded} />
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('timeseries')}>
          <ErrorBoundary label="Time-Series">
            <div className="space-y-6">
              {loadPrompt}
              <TimeSeriesMode config={config} onConfigLoaded={handleConfigLoaded} />
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('plotter')}>
          <ErrorBoundary label="Custom Plotter">
            <CustomPlotter isVisible={activeTab === 'plotter'} />
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('flight')}>
          <ErrorBoundary label="Flight">
            <div className="space-y-6">
              {loadPrompt}
              <FlightSimulation
                config={config}
                isVisible={activeTab === 'flight'}
                onConfigUpdated={handleConfigLoaded}
                onOpenTab={(t) => setActiveTab(t)}
              />
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('geometry')}>
          <ErrorBoundary label="Chamber Geometry">
            <div className="space-y-6">
              {loadPrompt}
              <ChamberGeometry config={config} onConfigUpdated={handleConfigLoaded} />
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('optimizer')}>
          <ErrorBoundary label="Optimizer">
            <div className="space-y-6">
              {loadPrompt}
              <Optimizer config={config} />
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('layerx')}>
          <ErrorBoundary label="Layer X">
            <div className="space-y-6">
              {loadPrompt}
              {!lxSeen ? null : LX_V2
                ? <Suspense fallback={null}><LayerXV2 config={config} isVisible={activeTab === 'layerx'} onConfigUpdated={handleConfigLoaded} /></Suspense>
                : <Suspense fallback={null}><LayerXOld config={config} isVisible={activeTab === 'layerx'} onConfigUpdated={handleConfigLoaded} /></Suspense>}
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('controller')}>
          <ErrorBoundary label="Controller">
            <div className="space-y-6">
              {loadPrompt}
              <ControllerMode config={config} />
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('demo')}>
          <ErrorBoundary label="Demo">
            <div className="space-y-6">
              {loadPrompt}
              <OptimizerDemo config={config} />
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('config')}>
          <ErrorBoundary label="Configuration">
            <div className="space-y-6">
              {/* Upload section - compact */}
              <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <div className="flex items-center gap-6">
                  <div className="flex-1">
                    <ConfigUpload onConfigLoaded={handleConfigLoaded} />
                  </div>
                </div>
              </div>

              {/* Parameters: every field the design carries, searchable, with defaults and units.
                  The section editor is kept as the second view. */}
              <div className="flex gap-1 text-[12px]">
                {(['parameters', 'sections'] as const).map((v) => (
                  <button key={v} type="button" onClick={() => setConfigView(v)}
                          className={`px-3 py-1 rounded border ${configView === v ? 'border-blue-500 text-blue-400' : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}>
                    {v === 'parameters' ? 'Parameters' : 'Section editor'}
                  </button>
                ))}
              </div>
              <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] overflow-hidden" style={{ height: 'calc(100vh - 280px)', minHeight: '500px' }}>
                {configView === 'parameters'
                  ? <ParametersWorkspace config={config} onConfigUpdated={handleConfigLoaded} />
                  : <ConfigEditor config={config} onConfigUpdated={handleConfigLoaded} />}
              </div>
            </div>
          </ErrorBoundary>
        </div>
        </div>
      </main>

      {/* Footer */}
      {!lxFull && (
        <footer className="border-t border-[var(--color-border)]">
          <div className="px-4 sm:px-6 py-4">
            <p className="text-xs text-[var(--color-text-secondary)] text-center">
              Hotbench · a STAR project
            </p>
          </div>
        </footer>
      )}
    </div>
    </ReadOnlyProvider>
  );
}

export default App;
