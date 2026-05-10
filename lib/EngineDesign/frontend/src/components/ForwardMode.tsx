import { useState, useCallback, useEffect } from 'react';
import { evaluate } from '../api/client';
import type { RunnerResults, EngineConfig } from '../api/client';
import { ResultsDisplay } from './ResultsDisplay';

interface ForwardModeProps {
  config: EngineConfig | null;
}

export function ForwardMode({ config }: ForwardModeProps) {
  // Use config's initial pressures if available, falling back to sensible defaults
  const loxConfig = config?.lox_tank as Record<string, unknown> | undefined;
  const fuelConfig = config?.fuel_tank as Record<string, unknown> | undefined;
  const defaultLox = loxConfig?.initial_pressure_psi ? String(loxConfig.initial_pressure_psi) : '750';
  const defaultFuel = fuelConfig?.initial_pressure_psi ? String(fuelConfig.initial_pressure_psi) : '600';

  const [loxPressure, setLoxPressure] = useState<string>(defaultLox);
  const [fuelPressure, setFuelPressure] = useState<string>(defaultFuel);
  const [results, setResults] = useState<RunnerResults | null>(null);
  const [ambientPressure, setAmbientPressure] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Update defaults when config changes
  useEffect(() => {
    if (config) {
      const loxConfig = config.lox_tank as Record<string, unknown> | undefined;
      const fuelConfig = config.fuel_tank as Record<string, unknown> | undefined;
      if (loxConfig?.initial_pressure_psi) {
        setLoxPressure(String(loxConfig.initial_pressure_psi));
      }
      if (fuelConfig?.initial_pressure_psi) {
        setFuelPressure(String(fuelConfig.initial_pressure_psi));
      }
    }
  }, [config]);

  const handleEvaluate = useCallback(async () => {
    const lox = parseFloat(loxPressure);
    const fuel = parseFloat(fuelPressure);

    if (isNaN(lox) || lox <= 0) {
      setError('LOX pressure must be a positive number');
      return;
    }
    if (isNaN(fuel) || fuel <= 0) {
      setError('Fuel pressure must be a positive number');
      return;
    }

    setIsLoading(true);
    setError(null);

    const result = await evaluate({
      lox_pressure_psi: lox,
      fuel_pressure_psi: fuel,
    });

    setIsLoading(false);

    if (result.error) {
      setError(result.error);
      setResults(null);
      setAmbientPressure(null);
    } else if (result.data) {
      // Results come directly from runner.evaluate() - same format as Streamlit UI
      setResults(result.data.results);
      // Store ambient pressure from response (computed from config elevation)
      setAmbientPressure(result.data.inputs.ambient_pressure_pa);
    }
  }, [loxPressure, fuelPressure]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleEvaluate();
    }
  };

  if (!config) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--color-text-secondary)]">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <p>No config loaded</p>
          <p className="text-sm mt-1">Upload a YAML config file first</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Input section */}
      <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Tank Pressures</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* LOX Pressure */}
          <div>
            <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
              LOX Tank Pressure
            </label>
            <div className="relative">
              <input
                type="number"
                value={loxPressure}
                onChange={(e) => setLoxPressure(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="750"
                className="w-full px-4 py-3 pr-12 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] text-sm">
                psi
              </span>
            </div>
          </div>

          {/* Fuel Pressure */}
          <div>
            <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
              Fuel Tank Pressure
            </label>
            <div className="relative">
              <input
                type="number"
                value={fuelPressure}
                onChange={(e) => setFuelPressure(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="600"
                className="w-full px-4 py-3 pr-12 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] text-sm">
                psi
              </span>
            </div>
          </div>
        </div>

        {/* Evaluate button */}
        <button
          onClick={handleEvaluate}
          disabled={isLoading}
          className="mt-5 w-full md:w-auto px-8 py-3 rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Evaluating...
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Evaluate
            </>
          )}
        </button>

        {/* Error message */}
        {error && (
          <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>

      {/* Results section */}
      <ResultsDisplay results={results} isLoading={isLoading} targetExitPressure={ambientPressure} />
    </div>
  );
}
