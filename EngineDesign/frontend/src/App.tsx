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
import { ReadOnlyProvider } from '@stardesign-ui';
import { getConfig, getHealth } from './api/client';
import type { EngineConfig } from './api/client';

// Injected by vite.config.ts from ENGINE_DESIGN_API_PORT, so the reconnect
// hint names the port this build actually proxies to.
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

type Tab =
  | 'forward'
  | 'timeseries'
  | 'plotter'
  | 'flight'
  | 'geometry'
  | 'optimizer'
  | 'layerx'
  | 'controller'
  | 'demo' | 'config';

function App() {
  // Which tab you were on is yours, not the design's -- remembered locally so
  // a reload puts you back without it counting as an edit to a shared design.
  const [activeTab, setActiveTab] = useViewState<Tab>('activeTab', 'forward');
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

  // Check backend health and load config on mount.
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
          // The backend always has a config in the caller's session (the default is
          // loaded lazily per user), so fetch it unconditionally. DesignVersions may
          // then swap in the active document's working copy.
          const configResult = await getConfig();
          if (!cancelled && configResult.data) {
            setConfig(configResult.data.config);
          }
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
  }, []);

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

  return (
    // The whole app, not just <main>: the injector / propellant selectors sit up
    // in the header, and switching either rewrites the config wholesale -- as
    // much an edit as typing in a field. Gating is opt-in, so the designs bar
    // inside is unaffected: Take / Release / History have to stay live exactly
    // when you do not hold the design.
    <ReadOnlyProvider readOnly={!editable}>
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      {/* Header */}
      <header className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1.5 py-1.5">
            {/* Logo and title */}
            <div className="flex items-center gap-3 shrink-0">
              <div className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <h1 className="text-base font-bold text-[var(--color-text-primary)]" title="Bipropellant rocket engine simulation">Liquid Engine Designer</h1>
            </div>

            {/* First-class config selectors + connection status */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 min-w-0">
              <ConfigurationSelector onConfigChange={setConfig} />
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isConnected === null ? 'bg-yellow-500 animate-pulse' :
                  isConnected ? 'bg-green-500' : 'bg-red-500'
                  }`} />
                <span className="text-sm text-[var(--color-text-secondary)]">
                  {isConnected === null ? 'Connecting...' :
                    isConnected ? 'Connected' : 'Disconnected'}
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
              inline
            />
          </div>

          {/* Navigation tabs */}
          <nav className="flex gap-1 -mb-px overflow-x-auto" aria-label="Views">
            <button
              onClick={() => setActiveTab('forward')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${activeTab === 'forward'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Forward Mode
            </button>
            <button
              onClick={() => setActiveTab('timeseries')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${activeTab === 'timeseries'
                ? 'border-purple-500 text-purple-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Time-Series Analysis
            </button>
            <button
              onClick={() => setActiveTab('plotter')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${activeTab === 'plotter'
                ? 'border-emerald-500 text-emerald-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Custom Plotter
            </button>
            <button
              onClick={() => setActiveTab('flight')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${activeTab === 'flight'
                ? 'border-orange-500 text-orange-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Flight Simulation
            </button>
            <button
              onClick={() => setActiveTab('geometry')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${activeTab === 'geometry'
                ? 'border-rose-500 text-rose-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Chamber Geometry
            </button>
            <button
              onClick={() => setActiveTab('optimizer')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${activeTab === 'optimizer'
                ? 'border-yellow-500 text-yellow-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Optimizer
            </button>
            <button
              onClick={() => setActiveTab('layerx')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${activeTab === 'layerx'
                ? 'border-violet-400 text-violet-300'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Layer X
            </button>
            <button
              onClick={() => setActiveTab('controller')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${activeTab === 'controller'
                ? 'border-teal-500 text-teal-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Controller
            </button>
            <button
              onClick={() => setActiveTab('demo')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${activeTab === 'demo'
                ? 'border-cyan-500 text-cyan-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Demo
            </button>
            <button
              onClick={() => setActiveTab('config')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${activeTab === 'config'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Configuration
            </button>
          </nav>
        </div>
      </header>

      {/* Main content */}
      {/* The rebuilt Layer X is full width, and fills the window below the header (its tab only). */}
      <main className={lxFull ? '' : 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6'}>
        {/* Inputs go grey without the checkout. Reading the design stays live:
            Forward mode, the plotter and the charts never write it back. The
            optimizer layers DO write their result into the config (see
            backend/routers/optimizer.py), so those runs are gated too. */}
        {!isConnected && isConnected !== null && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400">
            <div className="flex items-center gap-3">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div>
                <p className="font-semibold">Backend not connected</p>
                <p className="text-sm">Make sure the FastAPI server is running on port {API_PORT}</p>
                <code className="text-xs mt-1 block text-red-300">uvicorn backend.main:app --reload --port {API_PORT}</code>
              </div>
            </div>
          </div>
        )}

        {/* Keep all tab panels mounted; hide inactive ones to preserve state */}
        <div className={tabPanelClass('forward')}>
          <ErrorBoundary label="Forward Mode">
            <div className="space-y-6">
              {!config && (
                <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                  <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                  <ConfigUpload onConfigLoaded={handleConfigLoaded} />
                </div>
              )}
              <ForwardMode config={config} onConfigUpdated={handleConfigLoaded} />
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('timeseries')}>
          <ErrorBoundary label="Time Series">
            <div className="space-y-6">
              {!config && (
                <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                  <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                  <ConfigUpload onConfigLoaded={handleConfigLoaded} />
                </div>
              )}
              <TimeSeriesMode config={config} onConfigLoaded={handleConfigLoaded} />
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('plotter')}>
          <ErrorBoundary label="Plotter">
            <CustomPlotter isVisible={activeTab === 'plotter'} />
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('flight')}>
          <ErrorBoundary label="Flight Simulation">
            <div className="space-y-6">
              {!config && (
                <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                  <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                  <ConfigUpload onConfigLoaded={handleConfigLoaded} />
                </div>
              )}
              <FlightSimulation config={config} isVisible={activeTab === 'flight'} onConfigUpdated={handleConfigLoaded} />
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('geometry')}>
          <ErrorBoundary label="Geometry">
            <div className="space-y-6">
              {!config && (
                <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                  <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                  <ConfigUpload onConfigLoaded={handleConfigLoaded} />
                </div>
              )}
              <ChamberGeometry config={config} onConfigUpdated={handleConfigLoaded} />
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('optimizer')}>
          <ErrorBoundary label="Optimizer">
            <div className="space-y-6">
              {!config && (
                <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                  <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                  <ConfigUpload onConfigLoaded={handleConfigLoaded} />
                </div>
              )}
              <Optimizer config={config} />
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('layerx')}>
          <ErrorBoundary label="Layer X">
            <div className="space-y-6">
              {!config && (
                <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                  <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                  <ConfigUpload onConfigLoaded={handleConfigLoaded} />
                </div>
              )}
              {!lxSeen ? null : LX_V2
                ? <Suspense fallback={null}><LayerXV2 config={config} isVisible={activeTab === 'layerx'} onConfigUpdated={handleConfigLoaded} /></Suspense>
                : <Suspense fallback={null}><LayerXOld config={config} isVisible={activeTab === 'layerx'} onConfigUpdated={handleConfigLoaded} /></Suspense>}
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('controller')}>
          <ErrorBoundary label="Controller">
            <div className="space-y-6">
              {!config && (
                <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                  <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                  <ConfigUpload onConfigLoaded={handleConfigLoaded} />
                </div>
              )}
              <ControllerMode config={config} />
            </div>
          </ErrorBoundary>
        </div>

        <div className={tabPanelClass('demo')}>
          <ErrorBoundary label="Demo">
            <div className="space-y-6">
              {!config && (
                <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                  <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                  <ConfigUpload onConfigLoaded={handleConfigLoaded} />
                </div>
              )}
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
                  {config && (
                    <div className="flex-shrink-0 px-4 py-2 bg-green-500/10 border border-green-500/30 rounded-lg text-green-400 text-sm flex items-center gap-2">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Config loaded and ready
                    </div>
                  )}
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
      </main>

      {/* Footer */}
{!lxFull && (
        <footer className="border-t border-[var(--color-border)] mt-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
            <p className="text-sm text-[var(--color-text-secondary)] text-center">
              Pintle Engine Design Pipeline - FastAPI + React
            </p>
          </div>
        </footer>
      )}
    </div>
    </ReadOnlyProvider>
  );
}

export default App;
