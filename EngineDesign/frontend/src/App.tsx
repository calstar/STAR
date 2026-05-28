import { useState, useEffect } from 'react';
import { ConfigUpload } from './components/ConfigUpload';
import { ConfigEditor } from './components/ConfigEditor';
import { ForwardMode } from './components/ForwardMode';
import { TimeSeriesMode } from './components/TimeSeriesMode';
import { CustomPlotter } from './components/CustomPlotter';
import { FlightSimulation } from './components/FlightSimulation';
import { ChamberGeometry } from './components/ChamberGeometry';
import { Optimizer } from './components/Optimizer';
import { ControllerMode } from './components/ControllerMode';
import { OptimizerDemo } from './components/OptimizerDemo';
import { ExperimentMode } from './components/ExperimentMode';
import { getConfig, getHealth } from './api/client';
import type { EngineConfig } from './api/client';

type Tab =
  | 'forward'
  | 'timeseries'
  | 'plotter'
  | 'flight'
  | 'geometry'
  | 'optimizer'
  | 'controller'
  | 'demo'
  | 'experiment'
  | 'config';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('forward');
  const [config, setConfig] = useState<EngineConfig | null>(null);
  const [isConnected, setIsConnected] = useState<boolean | null>(null);

  // Keep all tab panels mounted; hide inactive ones to preserve state
  const tabPanelClass = (tab: Tab) => (activeTab === tab ? '' : 'hidden');

  // Check backend health and load config on mount
  useEffect(() => {
    async function init() {
      const healthResult = await getHealth();
      if (healthResult.error) {
        setIsConnected(false);
        return;
      }
      setIsConnected(true);

      // If config is already loaded on backend, fetch it
      if (healthResult.data?.config_loaded) {
        const configResult = await getConfig();
        if (configResult.data) {
          setConfig(configResult.data.config);
        }
      }
    }
    init();
  }, []);

  const handleConfigLoaded = (newConfig: EngineConfig) => {
    setConfig(newConfig);
  };

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      {/* Header */}
      <header className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo and title */}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div>
                <h1 className="text-lg font-bold text-[var(--color-text-primary)]">Pintle Engine Designer</h1>
                <p className="text-xs text-[var(--color-text-secondary)]">LOX/RP-1 Rocket Engine Simulation</p>
              </div>
            </div>

            {/* Connection status */}
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

          {/* Navigation tabs */}
          <nav className="flex gap-1 -mb-px overflow-x-auto" style={{scrollbarWidth: 'none'}}>
            <button
              onClick={() => setActiveTab('forward')}
              className={`flex-shrink-0 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === 'forward'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Forward Mode
            </button>
            <button
              onClick={() => setActiveTab('timeseries')}
              className={`flex-shrink-0 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === 'timeseries'
                ? 'border-purple-500 text-purple-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Time-Series Analysis
            </button>
            <button
              onClick={() => setActiveTab('plotter')}
              className={`flex-shrink-0 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === 'plotter'
                ? 'border-emerald-500 text-emerald-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Custom Plotter
            </button>
            <button
              onClick={() => setActiveTab('flight')}
              className={`flex-shrink-0 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === 'flight'
                ? 'border-orange-500 text-orange-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Flight Simulation
            </button>
            <button
              onClick={() => setActiveTab('geometry')}
              className={`flex-shrink-0 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === 'geometry'
                ? 'border-rose-500 text-rose-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Chamber Geometry
            </button>
            <button
              onClick={() => setActiveTab('optimizer')}
              className={`flex-shrink-0 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === 'optimizer'
                ? 'border-yellow-500 text-yellow-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Optimizer
            </button>
            <button
              onClick={() => setActiveTab('controller')}
              className={`flex-shrink-0 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === 'controller'
                ? 'border-teal-500 text-teal-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Controller
            </button>
            <button
              onClick={() => setActiveTab('demo')}
              className={`flex-shrink-0 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === 'demo'
                ? 'border-cyan-500 text-cyan-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Demo
            </button>
            <button
              onClick={() => setActiveTab('experiment')}
              className={`flex-shrink-0 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === 'experiment'
                ? 'border-amber-500 text-amber-400'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border)]'
                }`}
            >
              Experiment
            </button>
            <button
              onClick={() => setActiveTab('config')}
              className={`flex-shrink-0 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === 'config'
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
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {!isConnected && isConnected !== null && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400">
            <div className="flex items-center gap-3">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div>
                <p className="font-semibold">Backend not connected</p>
                <p className="text-sm">Make sure the FastAPI server is running on port 8000</p>
                <code className="text-xs mt-1 block text-red-300">uvicorn backend.main:app --reload --port 8000</code>
              </div>
            </div>
          </div>
        )}

        {/* Keep all tab panels mounted; hide inactive ones to preserve state */}
        <div className={tabPanelClass('forward')}>
          <div className="space-y-6">
            {!config && (
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                <ConfigUpload onConfigLoaded={handleConfigLoaded} />
              </div>
            )}
            <ForwardMode config={config} />
          </div>
        </div>

        <div className={tabPanelClass('timeseries')}>
          <div className="space-y-6">
            {!config && (
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                <ConfigUpload onConfigLoaded={handleConfigLoaded} />
              </div>
            )}
            <TimeSeriesMode config={config} onConfigLoaded={handleConfigLoaded} />
          </div>
        </div>

        <div className={tabPanelClass('plotter')}>
          <CustomPlotter isVisible={activeTab === 'plotter'} />
        </div>

        <div className={tabPanelClass('flight')}>
          <div className="space-y-6">
            {!config && (
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                <ConfigUpload onConfigLoaded={handleConfigLoaded} />
              </div>
            )}
            <FlightSimulation config={config} isVisible={activeTab === 'flight'} onConfigUpdated={handleConfigLoaded} />
          </div>
        </div>

        <div className={tabPanelClass('geometry')}>
          <div className="space-y-6">
            {!config && (
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                <ConfigUpload onConfigLoaded={handleConfigLoaded} />
              </div>
            )}
            <ChamberGeometry config={config} />
          </div>
        </div>

        <div className={tabPanelClass('optimizer')}>
          <div className="space-y-6">
            {!config && (
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                <ConfigUpload onConfigLoaded={handleConfigLoaded} />
              </div>
            )}
            <Optimizer config={config} />
          </div>
        </div>

        <div className={tabPanelClass('controller')}>
          <div className="space-y-6">
            {!config && (
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                <ConfigUpload onConfigLoaded={handleConfigLoaded} />
              </div>
            )}
            <ControllerMode config={config} />
          </div>
        </div>

        <div className={tabPanelClass('demo')}>
          <div className="space-y-6">
            {!config && (
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Load Configuration</h3>
                <ConfigUpload onConfigLoaded={handleConfigLoaded} />
              </div>
            )}
            <OptimizerDemo config={config} />
          </div>
        </div>

        <div className={tabPanelClass('experiment')}>
          <ExperimentMode config={config} onConfigUpdated={handleConfigLoaded} />
        </div>

        <div className={tabPanelClass('config')}>
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

            {/* Editor section - full width */}
            <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] overflow-hidden" style={{ height: 'calc(100vh - 280px)', minHeight: '500px' }}>
              <ConfigEditor config={config} onConfigUpdated={handleConfigLoaded} />
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-[var(--color-border)] mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <p className="text-sm text-[var(--color-text-secondary)] text-center">
            Pintle Engine Design Pipeline — FastAPI + React
          </p>
        </div>
      </footer>
    </div>
  );
}

export default App;
