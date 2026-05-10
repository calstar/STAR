import { useState, useCallback, useEffect } from 'react';
import { PressureProfileForm } from './PressureProfileForm';
import { SegmentCurveBuilder } from './SegmentCurveBuilder';
import { PressureCurveChart } from './PressureCurveChart';
import {
  generateTimeseries,
  generateFromSegments,
  uploadTimeseriesFromCSV,
  getConfig,
  type ProfileParams,
  type PressureSegment,
  type TimeSeriesData,
  type TimeSeriesSummary,
  type EngineConfig,
} from '../api/client';

interface TimeSeriesModeProps {
  config: EngineConfig | null;
  onConfigLoaded?: (config: EngineConfig) => void;
}

type InputMode = 'simple' | 'segments' | 'blowdown' | 'upload';

// Default profile params
const defaultLoxProfile: ProfileParams = {
  start_pressure_psi: 750,
  end_pressure_psi: 500,
  profile_type: 'exponential',
  decay_constant: 3.0,
};

const defaultFuelProfile: ProfileParams = {
  start_pressure_psi: 600,
  end_pressure_psi: 400,
  profile_type: 'exponential',
  decay_constant: 3.0,
};

// Default segments for segment builder
const defaultLoxSegments: PressureSegment[] = [
  {
    length_ratio: 0.3,
    type: 'blowdown',
    start_pressure_psi: 750,
    end_pressure_psi: 650,
    k: 0.5,
  },
  {
    length_ratio: 0.4,
    type: 'blowdown',
    start_pressure_psi: 650,
    end_pressure_psi: 550,
    k: 0.7,
  },
  {
    length_ratio: 0.3,
    type: 'blowdown',
    start_pressure_psi: 550,
    end_pressure_psi: 500,
    k: 1.0,
  },
];

const defaultFuelSegments: PressureSegment[] = [
  {
    length_ratio: 0.3,
    type: 'blowdown',
    start_pressure_psi: 600,
    end_pressure_psi: 500,
    k: 0.5,
  },
  {
    length_ratio: 0.4,
    type: 'blowdown',
    start_pressure_psi: 500,
    end_pressure_psi: 450,
    k: 0.7,
  },
  {
    length_ratio: 0.3,
    type: 'blowdown',
    start_pressure_psi: 450,
    end_pressure_psi: 400,
    k: 1.0,
  },
];

// Session storage key
const TIMESERIES_RESULTS_KEY = 'timeseries_results';

interface StoredResults {
  data: TimeSeriesData;
  summary: TimeSeriesSummary;
  timestamp: number;
}

function saveResultsToSession(results: { data: TimeSeriesData; summary: TimeSeriesSummary }) {
  const stored: StoredResults = {
    ...results,
    timestamp: Date.now(),
  };
  sessionStorage.setItem(TIMESERIES_RESULTS_KEY, JSON.stringify(stored));
}

function loadResultsFromSession(): { data: TimeSeriesData; summary: TimeSeriesSummary } | null {
  try {
    const stored = sessionStorage.getItem(TIMESERIES_RESULTS_KEY);
    if (!stored) return null;
    const parsed: StoredResults = JSON.parse(stored);
    return { data: parsed.data, summary: parsed.summary };
  } catch {
    return null;
  }
}

export function TimeSeriesMode({ config, onConfigLoaded }: TimeSeriesModeProps) {
  // Mode selection
  const [inputMode, setInputMode] = useState<InputMode>('simple');

  // Simple profile state
  const [duration, setDuration] = useState(5.0);
  const [nSteps, setNSteps] = useState(101);
  const [loxProfile, setLoxProfile] = useState<ProfileParams>(defaultLoxProfile);
  const [fuelProfile, setFuelProfile] = useState<ProfileParams>(defaultFuelProfile);

  // Segment builder state
  const [segmentDuration, setSegmentDuration] = useState(5.0);
  const [nPoints, setNPoints] = useState(200);
  const [segmentDurationInput, setSegmentDurationInput] = useState('5.0');
  const [nPointsInput, setNPointsInput] = useState('200');
  const [loxSegments, setLoxSegments] = useState<PressureSegment[]>(defaultLoxSegments);
  const [fuelSegments, setFuelSegments] = useState<PressureSegment[]>(defaultFuelSegments);

  // Blowdown mode state
  const [loxInitialPressure, setLoxInitialPressure] = useState(750);
  const [fuelInitialPressure, setFuelInitialPressure] = useState(600);

  // Upload state
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Sync local input states
  useEffect(() => {
    setSegmentDurationInput(segmentDuration.toString());
  }, [segmentDuration]);

  useEffect(() => {
    setNPointsInput(nPoints.toString());
  }, [nPoints]);

  const commitSegmentDuration = (value: string) => {
    const num = parseFloat(value);
    if (isNaN(num) || num < 0.1 || num > 600) {
      setSegmentDurationInput(segmentDuration.toString());
      return;
    }
    setSegmentDuration(num);
    setSegmentDurationInput(num.toString());
  };

  const commitNPoints = (value: string) => {
    const num = parseInt(value);
    if (isNaN(num) || num < 10 || num > 2000) {
      setNPointsInput(nPoints.toString());
      return;
    }
    setNPoints(num);
    setNPointsInput(num.toString());
  };

  // Results state - initialize from sessionStorage
  const [results, setResults] = useState<{
    data: TimeSeriesData;
    summary: TimeSeriesSummary;
  } | null>(() => loadResultsFromSession());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Handle simple profile submission
  const handleSimpleSubmit = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setResults(null);

    const response = await generateTimeseries({
      duration_s: duration,
      n_steps: nSteps,
      lox_profile: loxProfile,
      fuel_profile: fuelProfile,
    });

    setIsLoading(false);

    if (response.error) {
      setError(typeof response.error === 'string' ? response.error : JSON.stringify(response.error));
    } else if (response.data) {
      const newResults = {
        data: response.data.data,
        summary: response.data.summary,
      };
      setResults(newResults);
      saveResultsToSession(newResults);
    }
  }, [duration, nSteps, loxProfile, fuelProfile]);

  // Handle segment-based submission
  const handleSegmentSubmit = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setResults(null);

    const response = await generateFromSegments({
      duration_s: segmentDuration,
      n_points: nPoints,
      lox_segments: loxSegments,
      fuel_segments: fuelSegments,
      blowdown_mode: false,
    });

    setIsLoading(false);

    if (response.error) {
      setError(typeof response.error === 'string' ? response.error : JSON.stringify(response.error));
    } else if (response.data) {
      const newResults = {
        data: response.data.data,
        summary: response.data.summary,
      };
      setResults(newResults);
      saveResultsToSession(newResults);
    }
  }, [segmentDuration, nPoints, loxSegments, fuelSegments]);

  // Handle blowdown submission
  const handleBlowdownSubmit = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setResults(null);

    const response = await generateFromSegments({
      duration_s: segmentDuration, // Reuse duration
      n_points: nPoints,           // Reuse points
      lox_segments: [],            // Ignored in blowdown mode
      fuel_segments: [],           // Ignored in blowdown mode
      blowdown_mode: true,
      lox_initial_pressure_psi: loxInitialPressure,
      fuel_initial_pressure_psi: fuelInitialPressure,
    });

    setIsLoading(false);

    if (response.error) {
      setError(typeof response.error === 'string' ? response.error : JSON.stringify(response.error));
    } else if (response.data) {
      const newResults = {
        data: response.data.data,
        summary: response.data.summary,
      };
      setResults(newResults);
      saveResultsToSession(newResults);
    }
  }, [segmentDuration, nPoints, loxInitialPressure, fuelInitialPressure]);


  // Handle CSV upload submission
  const handleUploadSubmit = useCallback(async () => {
    if (!uploadedFile) {
      setUploadError('Please select a file');
      return;
    }

    setIsLoading(true);
    setError(null);
    setUploadError(null);
    setResults(null);

    const response = await uploadTimeseriesFromCSV(uploadedFile);

    setIsLoading(false);

    if (response.error) {
      const errorMsg = typeof response.error === 'string' ? response.error : JSON.stringify(response.error);
      setError(errorMsg);
      setUploadError(errorMsg);
    } else if (response.data) {
      const newResults = {
        data: response.data.data,
        summary: response.data.summary,
      };
      setResults(newResults);
      saveResultsToSession(newResults);

      // If it was a YAML config file, fetch and update the config
      const isConfigFile = uploadedFile.name.endsWith('.yaml') || uploadedFile.name.endsWith('.yml');
      if (isConfigFile && onConfigLoaded) {
        const configResponse = await getConfig();
        if (configResponse.data) {
          onConfigLoaded(configResponse.data.config);
        }
      }
    }
  }, [uploadedFile, onConfigLoaded]);

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
      {/* Header */}
      <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-pink-600 flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Time-Series Analysis</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Generate pressure profiles and evaluate thrust performance over time
            </p>
          </div>
        </div>

        {/* Mode Toggle */}
        <div className="flex gap-2 p-1 bg-[var(--color-bg-primary)] rounded-lg w-fit">
          <button
            onClick={() => setInputMode('simple')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${inputMode === 'simple'
              ? 'bg-blue-600 text-white'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
          >
            Simple Profile
          </button>
          <button
            onClick={() => setInputMode('segments')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${inputMode === 'segments'
              ? 'bg-blue-600 text-white'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
          >
            Segment Builder
          </button>
          <button
            onClick={() => setInputMode('blowdown')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${inputMode === 'blowdown'
              ? 'bg-blue-600 text-white'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
          >
            Pure Blowdown
          </button>
          <button
            onClick={() => setInputMode('upload')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${inputMode === 'upload'
              ? 'bg-blue-600 text-white'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
          >
            Upload
          </button>
        </div>
      </div>

      {/* Input Section */}
      <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        {inputMode === 'simple' ? (
          <>
            <h3 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
              Generate Profile
            </h3>
            <PressureProfileForm
              duration={duration}
              nSteps={nSteps}
              loxProfile={loxProfile}
              fuelProfile={fuelProfile}
              onDurationChange={setDuration}
              onNStepsChange={setNSteps}
              onLoxProfileChange={setLoxProfile}
              onFuelProfileChange={setFuelProfile}
              onSubmit={handleSimpleSubmit}
              isLoading={isLoading}
            />
          </>
        ) : inputMode === 'segments' ? (
          <>
            <h3 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
              Interactive Segment Builder
            </h3>
            <p className="text-sm text-[var(--color-text-secondary)] mb-6">
              Build custom pressure curves by defining segments. Each segment uses a blowdown
              profile: P(t) = P_end + (P_start - P_end) × e^(-k×t). Drag endpoints to adjust
              pressures, drag boundaries to adjust timing.
            </p>

            {/* Duration and Points */}
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
                  Duration
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={segmentDurationInput}
                    onChange={(e) => setSegmentDurationInput(e.target.value)}
                    onBlur={(e) => commitSegmentDuration(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.currentTarget.blur();
                      }
                    }}
                    className="w-full px-4 py-3 pr-8 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-[var(--color-text-secondary)]">s</span>
                </div>
              </div>
              <div>
                <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
                  Points
                </label>
                <input
                  type="text"
                  value={nPointsInput}
                  onChange={(e) => setNPointsInput(e.target.value)}
                  onBlur={(e) => commitNPoints(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  className="w-full px-4 py-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            {/* LOX and Fuel Segment Builders - Side by Side */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
              {/* LOX Segment Builder */}
              <div>
                <SegmentCurveBuilder
                  label="LOX Pressure Profile"
                  segments={loxSegments}
                  onChange={setLoxSegments}
                  colorClass="border-cyan-500/30 bg-cyan-500/5"
                  strokeColor="#06b6d4"
                  minPressure={300}
                  maxPressure={1100}
                  duration={segmentDuration}
                  overlaySegments={fuelSegments}
                  overlayStrokeColor="#f97316"
                />
              </div>

              {/* Fuel Segment Builder */}
              <div>
                <SegmentCurveBuilder
                  label="Fuel Pressure Profile"
                  segments={fuelSegments}
                  onChange={setFuelSegments}
                  colorClass="border-orange-500/30 bg-orange-500/5"
                  strokeColor="#f97316"
                  minPressure={300}
                  maxPressure={1100}
                  duration={segmentDuration}
                  overlaySegments={loxSegments}
                  overlayStrokeColor="#06b6d4"
                />
              </div>
            </div>

            {/* Run Button */}
            <button
              onClick={handleSegmentSubmit}
              disabled={isLoading}
              className="w-full px-6 py-3 rounded-lg bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Running Time-Series...
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                  Run Time-Series from Segments
                </>
              )}
            </button>
          </>
        ) : inputMode === 'blowdown' ? (
          <>
            <h3 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
              Pure Blowdown Simulation
            </h3>
            <p className="text-sm text-[var(--color-text-secondary)] mb-6">
              Simulate tank blowdown without COPV regulation or active pressure control.
              Tanks start at the specified initial pressure and naturally decay as propellant is consumed
              according to physics-based polytropic expansion with real gas effects.
            </p>

            <div className="max-w-xl">
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-2">
                    LOX Initial Pressure (psi)
                  </label>
                  <input
                    type="number"
                    value={loxInitialPressure}
                    onChange={(e) => setLoxInitialPressure(parseFloat(e.target.value) || 0)}
                    min={100}
                    max={2000}
                    step={10}
                    className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-2">
                    Fuel Initial Pressure (psi)
                  </label>
                  <input
                    type="number"
                    value={fuelInitialPressure}
                    onChange={(e) => setFuelInitialPressure(parseFloat(e.target.value) || 0)}
                    min={100}
                    max={2000}
                    step={10}
                    className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              {/* Duration and Points */}
              <h4 className="text-xs font-medium text-[var(--color-text-secondary)] mb-2 uppercase tracking-wider">Simulation Settings</h4>
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
                    Duration
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={segmentDurationInput}
                      onChange={(e) => setSegmentDurationInput(e.target.value)}
                      onBlur={(e) => commitSegmentDuration(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur();
                        }
                      }}
                      className="w-full px-4 py-3 pr-8 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-[var(--color-text-secondary)]">s</span>
                  </div>
                </div>
                <div>
                  <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
                    Points
                  </label>
                  <input
                    type="text"
                    value={nPointsInput}
                    onChange={(e) => setNPointsInput(e.target.value)}
                    onBlur={(e) => commitNPoints(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.currentTarget.blur();
                      }
                    }}
                    className="w-full px-4 py-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              {/* Run Button */}
              <button
                onClick={handleBlowdownSubmit}
                disabled={isLoading}
                className="w-full px-6 py-3 rounded-lg bg-gradient-to-r from-teal-500 to-emerald-600 hover:from-teal-600 hover:to-emerald-700 text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Simulating...
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Run Blowdown Simulation
                  </>
                )}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
              Upload CSV or Config File
            </h3>
            <p className="text-xs text-[var(--color-text-secondary)] mb-4">
              Upload a <strong>CSV file</strong> with columns <strong>T</strong> (time in seconds), <strong>P_O</strong> (LOX tank pressure in psi),
              and <strong>P_F</strong> (Fuel tank pressure in psi). The time column is optional - if missing,
              uniform spacing will be assumed.
            </p>
            <p className="text-xs text-[var(--color-text-secondary)] mb-4">
              Alternatively, upload a <strong>YAML config file</strong> with a <code className="text-xs bg-[var(--color-bg-primary)] px-1 py-0.5 rounded">pressure_curves</code> section.
              The config will be set as the active session config, and time-series analysis will run using the pressure curves from the segments.
            </p>

            {/* File Upload */}
            <div className="mb-4">
              <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
                Select CSV or YAML File
              </label>
              <div className="relative">
                <input
                  type="file"
                  accept=".csv,.yaml,.yml"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setUploadedFile(file);
                      setUploadError(null);
                    }
                  }}
                  className="w-full px-4 py-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                />
              </div>
              {uploadedFile && (
                <div className="mt-2 text-sm text-[var(--color-text-secondary)]">
                  Selected: <span className="text-[var(--color-text-primary)] font-medium">{uploadedFile.name}</span>
                  <span className="ml-2 text-xs">({(uploadedFile.size / 1024).toFixed(1)} KB)</span>
                  {uploadedFile.name.endsWith('.yaml') || uploadedFile.name.endsWith('.yml') ? (
                    <span className="ml-2 text-xs text-blue-400">(Config file)</span>
                  ) : (
                    <span className="ml-2 text-xs text-blue-400">(CSV file)</span>
                  )}
                </div>
              )}
              {uploadError && (
                <div className="mt-2 text-sm text-red-400">
                  {uploadError}
                </div>
              )}
            </div>

            {/* Run Button */}
            <button
              onClick={handleUploadSubmit}
              disabled={isLoading || !uploadedFile}
              className="w-full px-6 py-3 rounded-lg bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Running Time-Series...
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  {uploadedFile && (uploadedFile.name.endsWith('.yaml') || uploadedFile.name.endsWith('.yml'))
                    ? 'Run Time-Series from Config'
                    : 'Run Time-Series from CSV'}
                </>
              )}
            </button>
          </>
        )}

        {/* Error Message */}
        {error && (
          <div className="mt-4 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="font-medium">Evaluation Failed</p>
                <p className="text-sm mt-1">{error}</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Results Section */}
      {results && (
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-green-500/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">
                Time-Series Results
              </h3>
              <p className="text-sm text-[var(--color-text-secondary)]">
                {results.data.time.length} data points over {results.summary?.burn_time_s?.toFixed(2) || '—'}s burn
              </p>
            </div>
          </div>

          <PressureCurveChart
            data={results.data}
            summary={results.summary}
          />
        </div>
      )}

      {/* Empty state when no results */}
      {!results && !isLoading && !error && (
        <div className="p-8 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-center">
          <svg className="w-16 h-16 mx-auto mb-4 text-[var(--color-text-secondary)] opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <p className="text-[var(--color-text-secondary)]">
            Configure pressure profiles above and run to see time-series results
          </p>
        </div>
      )}
    </div>
  );
}

