import { useState, useEffect, useMemo } from 'react';
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer,
} from 'recharts';
import {
    runLayer2Optimization,
    getLayer2Status,
    stopLayer2Optimization,
    uploadLayer2Config,
    simulateLayer2Controller,
    simulateLayer2ControllerStream,
    API_BASE
} from '../api/client';
import type {
    Layer2Settings,
    Layer2ProgressEvent,
    Layer2Results,
    DesignRequirements,
    Layer2ControllerSimulateResponse,
    ControllerStreamEvent
} from '../api/client';

interface Layer2OptimizationProps {
    requirements: DesignRequirements | null;
}

// Helper component for result cards
function ResultCard({
    label,
    value,
    unit,
    decimals = 2,
    color = 'blue',
    isText = false
}: {
    label: string;
    value: number | string | undefined;
    unit?: string;
    decimals?: number;
    color?: string;
    isText?: boolean;
}) {
    const colorClasses: Record<string, string> = {
        blue: 'bg-blue-500/10 border-blue-500/30',
        green: 'bg-green-500/10 border-green-500/30',
        yellow: 'bg-yellow-500/10 border-yellow-500/30',
        red: 'bg-red-500/10 border-red-500/30',
        purple: 'bg-purple-500/10 border-purple-500/30',
        orange: 'bg-orange-500/10 border-orange-500/30',
        cyan: 'bg-cyan-500/10 border-cyan-500/30',
        pink: 'bg-pink-500/10 border-pink-500/30',
        indigo: 'bg-indigo-500/10 border-indigo-500/30',
    };

    const textColorClasses: Record<string, string> = {
        blue: 'text-blue-400',
        green: 'text-green-400',
        yellow: 'text-yellow-400',
        red: 'text-red-400',
        purple: 'text-purple-400',
        orange: 'text-orange-400',
        cyan: 'text-cyan-400',
        pink: 'text-pink-400',
        indigo: 'text-indigo-400',
    };

    const displayValue = isText
        ? String(value || '-')
        : typeof value === 'number'
            ? value.toFixed(decimals)
            : value !== undefined && value !== null
                ? String(value)
                : '-';

    return (
        <div className={`rounded-lg p-3 border ${colorClasses[color] || colorClasses.blue}`}>
            <p className="text-xs text-[var(--color-text-secondary)] mb-1">{label}</p>
            <p className={`text-lg font-bold ${textColorClasses[color] || textColorClasses.blue}`}>
                {displayValue}
                {unit && <span className="text-sm font-normal text-[var(--color-text-secondary)] ml-1">{unit}</span>}
            </p>
        </div>
    );
}

export function Layer2Optimization({ requirements }: Layer2OptimizationProps) {
    const [settings, setSettings] = useState<Layer2Settings>({
        max_iterations: 20,
        save_plots: false,
        de_maxiter: 5,
        de_popsize: 2,
        de_n_time_points: 25,
    });
    const [showAdvanced, setShowAdvanced] = useState(false);

    const [isRunning, setIsRunning] = useState(false);
    const [isStopping, setIsStopping] = useState(false);
    const [progress, setProgress] = useState(0);
    const [stage, setStage] = useState('');
    const [message, setMessage] = useState('');
    const [results, setResults] = useState<Layer2Results | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [objectiveHistory, setObjectiveHistory] = useState<Array<{
        iteration: number;
        objective: number;
        best_objective: number;
    }>>([]);
    const [pressureCurves, setPressureCurves] = useState<Array<{
        time: number;
        lox: number;
        fuel: number;
        copv?: number;
    }>>([]);

    const [eventSourceRef, setEventSourceRef] = useState<EventSource | null>(null);
    const [configLoaded, setConfigLoaded] = useState(false);
    
    // Controller simulation state
    const [controllerResults, setControllerResults] = useState<Layer2ControllerSimulateResponse | null>(null);
    const [controllerLoading, setControllerLoading] = useState(false);
    const [controllerError, setControllerError] = useState<string | null>(null);
    const [controllerProgress, setControllerProgress] = useState(0);
    const [controllerStage, setControllerStage] = useState('');
    const [controllerStreamAbort, setControllerStreamAbort] = useState<AbortController | null>(null);
    
    // Real-time data for streaming
    const [realtimeData, setRealtimeData] = useState<Array<ControllerStreamEvent>>([]);

    // Calculate min/max objective values for dot scaling
    const { minObj, maxObj } = useMemo(() => {
        if (objectiveHistory.length === 0) {
            return { minObj: 1, maxObj: 1 };
        }
        const values = objectiveHistory.map(h => h.objective).filter(v => typeof v === 'number' && isFinite(v));
        if (values.length === 0) {
            return { minObj: 1, maxObj: 1 };
        }
        return {
            minObj: Math.min(...values),
            maxObj: Math.max(...values),
        };
    }, [objectiveHistory]);

    const renderDot = useMemo(() => {
        const minSize = 5;
        const maxSize = 2;
        const logMinObj = Math.log(Math.max(1e-10, minObj));
        const logMaxObj = Math.log(Math.max(1e-10, maxObj));
        const logRange = logMaxObj - logMinObj;

        return (props: any) => {
            const { cx, cy, payload } = props;
            if (!payload || typeof payload.objective !== 'number' || !isFinite(payload.objective)) {
                return <circle cx={cx} cy={cy} r={0} fill="none" />;
            }

            const isBest = payload.best_objective !== undefined &&
                Math.abs(payload.objective - payload.best_objective) < 1e-10;

            let radius = maxSize;
            if (logRange > 0) {
                const logValue = Math.log(Math.max(1e-10, payload.objective));
                const normalized = (logMaxObj - logValue) / logRange;
                radius = maxSize + (minSize - maxSize) * normalized;
            } else if (isBest) {
                radius = minSize;
            }

            return <circle cx={cx} cy={cy} r={radius} fill={isBest ? "#ec4899" : "#a855f7"} />;
        };
    }, [minObj, maxObj]);

    useEffect(() => {
        checkStatus();
    }, []);

    useEffect(() => {
        return () => {
            if (eventSourceRef) eventSourceRef.close();
        };
    }, [eventSourceRef]);

    const checkStatus = async () => {
        const response = await getLayer2Status();
        if (response.data) {
            setIsRunning(response.data.running);
            setProgress(response.data.progress);
            setStage(response.data.stage);
            setMessage(response.data.message);
            if (response.data.has_results && !response.data.running) {
                // results are fetched separately if needed
            }
        }
    };

    const handleConfigUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setError(null);
        setSuccessMessage(null);
        const result = await uploadLayer2Config(file);
        if (result.error) {
            setError(result.error);
        } else {
            setSuccessMessage('Configuration uploaded successfully for Layer 2');
            setConfigLoaded(true);
        }
    };

    const handleRun = () => {
        setIsRunning(true);
        setIsStopping(false);
        setProgress(0);
        setStage('Initializing');
        setMessage('Starting Layer 2 optimization...');
        setError(null);
        setSuccessMessage(null);
        setResults(null);
        setObjectiveHistory([]);
        setPressureCurves([]);

        const eventSource = runLayer2Optimization(
            settings,
            (event: Layer2ProgressEvent) => {
                if (event.type === 'status' || event.type === 'progress') {
                    if (event.progress !== undefined) setProgress(event.progress);
                    if (event.stage) setStage(event.stage);
                    if (event.message) setMessage(event.message);
                } else if (event.type === 'objective') {
                    if (event.objective_history) {
                        setObjectiveHistory(prev => [...prev, ...event.objective_history!]);
                    }
                } else if (event.type === 'pressure_curves') {
                    // Update pressure curves in real-time during optimization
                    // Convert from Pa to PSI (1 PSI = 6894.76 Pa)
                    const PSI_TO_PA = 6894.76;
                    if (event.time_array && event.lox_pressure && event.fuel_pressure) {
                        const curves = event.time_array.map((t: number, i: number) => {
                            // Find corresponding COPV pressure for this time
                            let copvPressure: number | undefined = undefined;
                            if (event.copv_pressure && event.copv_time) {
                                const copvIdx = event.copv_time.findIndex((ct: number) => Math.abs(ct - t) < 0.01);
                                if (copvIdx >= 0 && event.copv_pressure[copvIdx] != null) {
                                    copvPressure = event.copv_pressure[copvIdx] / PSI_TO_PA;
                                }
                            }
                            return {
                                time: t,
                                lox: (event.lox_pressure![i] || 0) / PSI_TO_PA,
                                fuel: (event.fuel_pressure![i] || 0) / PSI_TO_PA,
                                copv: copvPressure,
                            };
                        });
                        setPressureCurves(curves);
                    }

                } else if (event.type === 'complete') {
                    setIsRunning(false);
                    setIsStopping(false);
                    setProgress(1.0);
                    // Check if this was a user-initiated stop
                    const stoppedByUser = (event as any).stopped_by_user === true;
                    setStage(stoppedByUser ? 'Stopped' : 'Complete');
                    setMessage(stoppedByUser
                        ? 'Optimization stopped by user - using best solution found'
                        : 'Layer 2 optimization complete');
                    if (event.results) {
                        setResults(event.results);
                        if (event.results.time_array && event.results.lox_pressure) {
                            // Convert from Pa to PSI (1 PSI = 6894.76 Pa)
                            const PSI_TO_PA = 6894.76;
                            const curves = event.results.time_array.map((t: number, i: number) => ({
                                time: t,
                                lox: (event.results?.lox_pressure[i] || 0) / PSI_TO_PA,
                                fuel: (event.results?.fuel_pressure[i] || 0) / PSI_TO_PA,
                            }));
                            setPressureCurves(curves);
                        }
                    }
                    setEventSourceRef(null);
                } else if (event.type === 'error') {
                    setIsRunning(false);
                    setIsStopping(false);
                    // Check if this is a stop message - don't treat as error
                    if (event.error && event.error.toLowerCase().includes('stopped')) {
                        setError(null);
                        setMessage('Optimization stopped by user');
                        setStage('Stopped');
                    } else {
                        setError(event.error || 'Optimization failed');
                    }
                    setEventSourceRef(null);
                }
            },
            (err) => {
                setIsRunning(false);
                setError(err);
                setEventSourceRef(null);
            }
        );
        setEventSourceRef(eventSource);
    };

    const handleStop = async () => {
        // Don't close the EventSource - let the backend return results gracefully
        // The backend will return a 'complete' event with stopped_by_user: true
        setIsStopping(true);
        setMessage('Stopping optimization...');
        try {
            await stopLayer2Optimization();
        } catch (err) {
            // If stop API fails, force close
            console.error('Failed to stop optimization:', err);
            if (eventSourceRef) {
                eventSourceRef.close();
                setEventSourceRef(null);
            }
            setIsRunning(false);
            setIsStopping(false);
            setStage('Stopped');
            setMessage('Optimization stopped');
        }
    };

    const downloadConfig = () => {
        if (!results?.config_yaml) return;
        const blob = new Blob([results.config_yaml], { type: 'text/yaml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'layer2_optimized_config.yaml';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const downloadCSV = () => {
        if (!results?.time_array) return;
        let csv = 'Time (s),LOX Pressure (Pa),Fuel Pressure (Pa)\n';
        results.time_array.forEach((t: number, i: number) => {
            csv += `${t},${results.lox_pressure[i]},${results.fuel_pressure[i]}\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'pressure_curves.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleRunController = () => {
        if (!results?.summary?.thrust_curve_time || !results?.summary?.thrust_curve_values) {
            setControllerError('No thrust curve available. Run Layer 2 optimization first.');
            return;
        }

        setControllerLoading(true);
        setControllerError(null);
        setControllerResults(null);
        setRealtimeData([]);
        setControllerProgress(0);
        setControllerStage('Starting...');

        // Use streaming for real-time visualization
        const abortController = simulateLayer2ControllerStream(
            {
                thrust_curve_time: results.summary.thrust_curve_time,
                thrust_curve_values: results.summary.thrust_curve_values,
                dt: 0.01,
            },
            (event: ControllerStreamEvent) => {
                if (event.type === 'status' || event.type === 'progress') {
                    if (event.progress !== undefined) setControllerProgress(event.progress);
                    if (event.stage) setControllerStage(event.stage);
                } else if (event.type === 'data') {
                    // Add data point to real-time array
                    setRealtimeData(prev => [...prev, event]);
                } else if (event.type === 'complete') {
                    setControllerLoading(false);
                    setControllerProgress(1.0);
                    setControllerStage('Complete');
                    // Final results will be built from accumulated realtimeData
                    // Use a callback to ensure we have the latest data
                    setRealtimeData(prev => {
                        const finalResults: Layer2ControllerSimulateResponse = {
                            time: prev.map(d => d.time || 0),
                            thrust_ref: prev.map(d => d.thrust_ref || 0),
                            thrust_actual: prev.map(d => d.thrust_actual || 0),
                            MR: prev.map(d => d.MR || 0),
                            P_copv: prev.map(d => d.P_copv || 0),
                            P_reg: prev.map(d => d.P_reg || 0),
                            P_u_fuel: prev.map(d => d.P_u_fuel || 0),
                            P_u_ox: prev.map(d => d.P_u_ox || 0),
                            P_d_fuel: prev.map(d => d.P_d_fuel || 0),
                            P_d_ox: prev.map(d => d.P_d_ox || 0),
                            P_ch: prev.map(d => d.P_ch || 0),
                            duty_F: prev.map(d => d.duty_F || 0),
                            duty_O: prev.map(d => d.duty_O || 0),
                            altitude: prev.map(d => d.altitude || 0),
                            velocity: prev.map(d => d.velocity || 0),
                            value_function: prev.map(d => d.value_function || 0),
                            control_effort: prev.map(d => d.control_effort || 0),
                            V_u_fuel: prev.map(d => d.V_u_fuel || 0),
                            V_u_ox: prev.map(d => d.V_u_ox || 0),
                            mdot_F: prev.map(d => d.mdot_F || 0),
                            mdot_O: prev.map(d => d.mdot_O || 0),
                            w_bar: prev.map(d => d.w_bar || []),
                            constraint_margins: prev.map(d => d.constraint_margins || {}),
                        };
                        setControllerResults(finalResults);
                        return prev;
                    });
                } else if (event.type === 'error') {
                    setControllerError(event.error || 'Unknown error');
                    setControllerLoading(false);
                }
            },
            (error: string) => {
                setControllerError(error);
                setControllerLoading(false);
            }
        );
        
        setControllerStreamAbort(abortController);
    };
    
    const handleStopController = () => {
        if (controllerStreamAbort) {
            controllerStreamAbort.abort();
            setControllerStreamAbort(null);
            setControllerLoading(false);
            setControllerStage('Stopped');
        }
    };

    return (
        <div className="space-y-6">
            {/* Description */}
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
                <h2 className="text-2xl font-bold text-[var(--color-text-primary)] mb-2">Layer 2: Pressure Curve Optimization</h2>
                <p className="text-sm text-[var(--color-text-secondary)]">
                    Layer 2 optimizes the <strong>time-varying tank pressure curves</strong> to maximize total impulse while staying within tank capacities and stability margins. It uses the engine geometry fixed in Layer 1.
                </p>
            </div>

            {/* Controls */}
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
                <div className="flex flex-wrap items-center gap-4">
                    <div className="flex-1 min-w-[200px]">
                        <h3 className="text-sm font-semibold text-[var(--color-text-secondary)] mb-2 uppercase tracking-wider">Start Here</h3>
                        <div className="flex gap-2">
                            <label className="flex-1">
                                <span className="sr-only">Upload Config</span>
                                <div className="relative group">
                                    <input
                                        type="file"
                                        accept=".yaml,.yml"
                                        onChange={handleConfigUpload}
                                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                                        disabled={isRunning}
                                    />
                                    <div className="px-4 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm font-medium hover:border-blue-500 transition-colors flex items-center justify-center gap-2">
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1M16 8l-4-4m0 0L8 8m4-4v12" />
                                        </svg>
                                        Upload Start Config
                                    </div>
                                </div>
                            </label>
                            <button
                                onClick={handleRun}
                                disabled={isRunning || (!requirements && !configLoaded)}
                                className={`px-6 py-2 rounded-lg font-bold text-white transition-all ${isRunning || (!requirements && !configLoaded)
                                    ? 'bg-gray-500 cursor-not-allowed'
                                    : 'bg-purple-600 hover:bg-purple-700 shadow-lg shadow-purple-500/20'
                                    }`}
                            >
                                {isRunning ? '🔄 Optimizing...' : '🚀 Run Layer 2'}
                            </button>
                            {isRunning && (
                                <button
                                    onClick={handleStop}
                                    disabled={isStopping}
                                    className={`px-6 py-2 text-white rounded-lg font-bold transition-all ${isStopping
                                        ? 'bg-yellow-600 cursor-wait'
                                        : 'bg-red-600 hover:bg-red-700'
                                        }`}
                                >
                                    {isStopping ? '⏳ Stopping...' : '⏹ Stop'}
                                </button>
                            )}
                        </div>
                    </div>
                    <div>
                        <button
                            onClick={() => setShowAdvanced(!showAdvanced)}
                            className="text-xs text-blue-400 hover:text-blue-300 font-medium"
                        >
                            {showAdvanced ? 'Hide Advanced Settings' : 'Advanced Settings'}
                        </button>
                    </div>
                </div>

                {showAdvanced && (
                    <div className="mt-6 pt-6 border-t border-[var(--color-border)] grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
                        <div>
                            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Local Max Iter</label>
                            <input
                                type="number"
                                value={settings.max_iterations}
                                onChange={(e) => setSettings({ ...settings, max_iterations: parseInt(e.target.value) })}
                                className="w-full bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded p-2 text-sm text-white"
                                min="1"
                                max="100"
                            />
                        </div>
                        <div>
                            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">DE Max Iter</label>
                            <input
                                type="number"
                                value={settings.de_maxiter}
                                onChange={(e) => setSettings({ ...settings, de_maxiter: parseInt(e.target.value) })}
                                className="w-full bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded p-2 text-sm text-white"
                                min="1"
                                max="100"
                            />
                        </div>
                        <div>
                            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">DE Pop Size</label>
                            <input
                                type="number"
                                value={settings.de_popsize}
                                onChange={(e) => setSettings({ ...settings, de_popsize: parseInt(e.target.value) })}
                                className="w-full bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded p-2 text-sm text-white"
                                min="1"
                                max="20"
                            />
                        </div>
                        <div>
                            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">DE Time Points</label>
                            <input
                                type="number"
                                value={settings.de_n_time_points}
                                onChange={(e) => setSettings({ ...settings, de_n_time_points: parseInt(e.target.value) })}
                                className="w-full bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded p-2 text-sm text-white"
                                min="5"
                                max="200"
                            />
                        </div>
                        <div className="flex items-end pb-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={settings.save_plots}
                                    onChange={(e) => setSettings({ ...settings, save_plots: e.target.checked })}
                                    className="rounded border-[var(--color-border)] bg-[var(--color-bg-primary)]"
                                />
                                <span className="text-xs text-[var(--color-text-secondary)]">Save PNG Plots</span>
                            </label>
                        </div>
                    </div>
                )}
            </div>

            {/* Progress & Status */}
            {(isRunning || progress > 0 || error || successMessage) && (
                <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
                    <div className="flex justify-between text-sm mb-2">
                        <span className="text-[var(--color-text-primary)] font-medium">{stage}</span>
                        <span className="text-purple-400 font-bold">{(progress * 100).toFixed(0)}%</span>
                    </div>
                    <div className="w-full bg-[var(--color-bg-primary)] rounded-full h-2 mb-4">
                        <div
                            className="bg-purple-500 h-full rounded-full transition-all duration-300"
                            style={{ width: `${progress * 100}%` }}
                        />
                    </div>
                    {message && <p className="text-sm text-[var(--color-text-secondary)]">{message}</p>}
                    {error && <p className="text-sm text-red-400 mt-2 font-medium">❌ {error}</p>}
                    {successMessage && <p className="text-sm text-green-400 mt-2 font-medium">✅ {successMessage}</p>}
                </div>
            )}

            {/* Visualizations */}
            <div className="grid grid-cols-1 gap-6">
                {/* Convergence History */}
                <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
                    <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4 flex items-center gap-2">
                        <span className="text-purple-400">📈</span> Convergence History
                    </h3>
                    <div className="h-[300px] w-full">
                        {objectiveHistory.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={objectiveHistory} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                                    <XAxis dataKey="iteration" stroke="var(--color-text-secondary)" tick={{ fontSize: 12 }} />
                                    <YAxis scale="log" domain={['auto', 'auto']} stroke="var(--color-text-secondary)" tick={{ fontSize: 12 }} />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px' }}
                                        itemStyle={{ color: '#fff' }}
                                    />
                                    <Line type="monotone" dataKey="objective" stroke="#a855f7" strokeWidth={0} dot={renderDot} isAnimationActive={false} />
                                    <Line type="monotone" dataKey="best_objective" stroke="#f97316" strokeWidth={2} strokeDasharray="5 5" dot={false} isAnimationActive={false} />
                                </LineChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="h-full flex items-center justify-center text-[var(--color-text-secondary)] border border-dashed border-[var(--color-border)] rounded-lg">
                                Waiting for optimization data...
                            </div>
                        )}
                    </div>
                </div>

                {/* Pressure Curves */}
                <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
                    <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4 flex items-center gap-2">
                        <span className="text-blue-400">🌊</span> Pressure Curves (Current Best)
                        {pressureCurves.some(p => p.copv !== undefined) && (
                            <span className="text-xs text-purple-400 ml-2">+ COPV</span>
                        )}
                    </h3>
                    <div className="h-[350px] w-full">
                        {pressureCurves.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={pressureCurves} margin={{ top: 5, right: 60, left: 10, bottom: 5 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                                    <XAxis dataKey="time" unit="s" stroke="var(--color-text-secondary)" tick={{ fontSize: 12 }} />
                                    {/* Left Y-axis for tank pressures */}
                                    <YAxis
                                        yAxisId="left"
                                        stroke="var(--color-text-secondary)"
                                        tick={{ fontSize: 12 }}
                                        label={{ value: 'Tank Pressure (PSI)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }}
                                    />
                                    {/* Right Y-axis for COPV pressure (if available) */}
                                    {pressureCurves.some(p => p.copv !== undefined) && (
                                        <YAxis
                                            yAxisId="right"
                                            orientation="right"
                                            stroke="#a855f7"
                                            tick={{ fontSize: 12 }}
                                            label={{ value: 'COPV Pressure (PSI)', angle: 90, position: 'insideRight', fill: '#a855f7' }}
                                        />
                                    )}
                                    <Tooltip
                                        contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px' }}
                                    />
                                    <Legend />
                                    <Line yAxisId="left" type="monotone" dataKey="lox" name="LOX Pressure" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
                                    <Line yAxisId="left" type="monotone" dataKey="fuel" name="Fuel Pressure" stroke="#ef4444" strokeWidth={2} dot={false} isAnimationActive={false} />
                                    {/* COPV pressure on right axis */}
                                    {pressureCurves.some(p => p.copv !== undefined) && (
                                        <Line
                                            yAxisId="right"
                                            type="monotone"
                                            dataKey="copv"
                                            name="COPV Pressure"
                                            stroke="#a855f7"
                                            strokeWidth={2}
                                            dot={false}
                                            isAnimationActive={false}
                                            connectNulls
                                        />
                                    )}
                                </LineChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="h-full flex items-center justify-center text-[var(--color-text-secondary)] border border-dashed border-[var(--color-border)] rounded-lg">
                                Pressure curves will appear during optimization...
                            </div>
                        )}
                    </div>
                </div>

            </div>

            {/* Results */}
            {results && (
                <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
                    <div className="flex justify-between items-center mb-6">
                        <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">✨ Final Optimization Results</h3>
                        <div className="flex gap-2">
                            <button
                                onClick={downloadCSV}
                                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
                            >
                                📊 Download CSV
                            </button>
                            <button
                                onClick={downloadConfig}
                                className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition-colors"
                            >
                                💾 Download Config (YAML)
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <ResultCard label="Total Impulse" value={results.summary.total_impulse_Ns} unit="N·s" decimals={0} color="blue" />
                        <ResultCard label="Required Impulse" value={results.summary.required_impulse_Ns} unit="N·s" decimals={0} color="cyan" />
                        <ResultCard label="LOX Mass" value={results.summary.lox_mass_kg} unit="kg" decimals={2} color="indigo" />
                        <ResultCard label="Fuel Mass" value={results.summary.fuel_mass_kg} unit="kg" decimals={2} color="red" />
                        <ResultCard label="Burn Time" value={results.summary.burn_time_s} unit="s" decimals={2} color="orange" />
                        <ResultCard label="Avg O/F" value={results.summary.avg_of_ratio} decimals={2} color="yellow" />
                        <ResultCard label="Min Stability" value={results.summary.min_stability_margin} decimals={3} color="purple" />
                        <ResultCard label="Status" value={results.summary.is_success ? 'VALID' : 'INVALID'} isText color={results.summary.is_success ? 'green' : 'red'} />
                    </div>

                    {/* Thrust Curve Chart */}
                    {results.summary.thrust_curve_time && results.summary.thrust_curve_values &&
                        results.summary.thrust_curve_time.length > 0 && results.summary.thrust_curve_values.length > 0 && (
                            <div className="mt-6">
                                <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-4 flex items-center gap-2">
                                    <span className="text-green-400">🚀</span> Thrust Curve (Time Series, No Ablation/Oxidation)
                                </h4>
                                <div className="h-[300px] w-full">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <LineChart
                                            data={results.summary.thrust_curve_time.map((t: number, i: number) => ({
                                                time: t,
                                                thrust: results.summary.thrust_curve_values[i] || 0,
                                            }))}
                                            margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
                                        >
                                            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                                            <XAxis
                                                dataKey="time"
                                                unit=" s"
                                                stroke="var(--color-text-secondary)"
                                                tick={{ fontSize: 12 }}
                                            />
                                            <YAxis
                                                stroke="var(--color-text-secondary)"
                                                tick={{ fontSize: 12 }}
                                                label={{ value: 'Thrust (N)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }}
                                            />
                                            <Tooltip
                                                contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px' }}
                                            />
                                            <Legend />
                                            <Line
                                                type="monotone"
                                                dataKey="thrust"
                                                name="Thrust"
                                                stroke="#10b981"
                                                strokeWidth={2}
                                                dot={false}
                                                isAnimationActive={false}
                                            />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>
                        )}

                    {/* O/F Ratio Curve Chart */}
                    {results.summary.thrust_curve_time && results.summary.of_curve_values &&
                        results.summary.thrust_curve_time.length > 0 && results.summary.of_curve_values.length > 0 && (
                            <div className="mt-6">
                                <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-4 flex items-center gap-2">
                                    <span className="text-yellow-400">⚗️</span> O/F Ratio (Mixture Ratio) Curve (Time Series, No Ablation/Oxidation)
                                </h4>
                                <div className="h-[300px] w-full">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <LineChart
                                            data={results.summary.thrust_curve_time.map((t: number, i: number) => ({
                                                time: t,
                                                of_ratio: results.summary.of_curve_values[i] || 0,
                                            }))}
                                            margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
                                        >
                                            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                                            <XAxis
                                                dataKey="time"
                                                unit=" s"
                                                stroke="var(--color-text-secondary)"
                                                tick={{ fontSize: 12 }}
                                            />
                                            <YAxis
                                                stroke="var(--color-text-secondary)"
                                                tick={{ fontSize: 12 }}
                                                label={{ value: 'O/F Ratio', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }}
                                            />
                                            <Tooltip
                                                contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px' }}
                                            />
                                            <Legend />
                                            <Line
                                                type="monotone"
                                                dataKey="of_ratio"
                                                name="O/F Ratio"
                                                stroke="#eab308"
                                                strokeWidth={2}
                                                dot={false}
                                                isAnimationActive={false}
                                            />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>
                        )}

                    {/* Injector Pressure Drops Chart */}
                    {results.summary.thrust_curve_time && results.summary.delta_p_inj_O_psi && results.summary.delta_p_inj_F_psi &&
                        results.summary.thrust_curve_time.length > 0 && results.summary.delta_p_inj_O_psi.length > 0 && results.summary.delta_p_inj_F_psi.length > 0 && (
                            <div className="mt-6">
                                <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-4 flex items-center gap-2">
                                    <span className="text-cyan-400">💧</span> Injector Pressure Drops (Time Series, No Ablation/Oxidation)
                                </h4>
                                <div className="h-[300px] w-full">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <LineChart
                                            data={results.summary.thrust_curve_time.map((t: number, i: number) => ({
                                                time: t,
                                                lox: results.summary.delta_p_inj_O_psi[i] || 0,
                                                fuel: results.summary.delta_p_inj_F_psi[i] || 0,
                                            }))}
                                            margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
                                        >
                                            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                                            <XAxis
                                                dataKey="time"
                                                unit=" s"
                                                stroke="var(--color-text-secondary)"
                                                tick={{ fontSize: 12 }}
                                            />
                                            <YAxis
                                                stroke="var(--color-text-secondary)"
                                                tick={{ fontSize: 12 }}
                                                label={{ value: 'Pressure Drop (psi)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }}
                                            />
                                            <Tooltip
                                                contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px' }}
                                            />
                                            <Legend />
                                            <Line
                                                type="monotone"
                                                dataKey="lox"
                                                name="LOX ΔP"
                                                stroke="#3b82f6"
                                                strokeWidth={2}
                                                dot={false}
                                                isAnimationActive={false}
                                            />
                                            <Line
                                                type="monotone"
                                                dataKey="fuel"
                                                name="Fuel ΔP"
                                                stroke="#ef4444"
                                                strokeWidth={2}
                                                dot={false}
                                                isAnimationActive={false}
                                            />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>
                        )}

                    {/* COPV Pressure Curve Chart with Tank Pressures */}
                    {results.summary.copv_time_s && results.summary.copv_pressure_trace_Pa &&
                        results.summary.copv_time_s.length > 0 && results.summary.copv_pressure_trace_Pa.length > 0 && (
                            <div className="mt-6">
                                <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-4 flex items-center gap-2">
                                    <span className="text-purple-400">🔋</span> COPV & Tank Pressures
                                </h4>
                                <div className="mb-2 grid grid-cols-2 gap-4">
                                    <ResultCard
                                        label="COPV Initial Pressure (P0)"
                                        value={results.summary.copv_P0_Pa ? results.summary.copv_P0_Pa / 6894.76 : undefined}
                                        unit="psi"
                                        decimals={0}
                                        color="purple"
                                    />
                                    <ResultCard
                                        label="COPV Initial Pressure (P0)"
                                        value={results.summary.copv_P0_Pa ? results.summary.copv_P0_Pa / 1e6 : undefined}
                                        unit="MPa"
                                        decimals={2}
                                        color="indigo"
                                    />
                                </div>
                                <div className="h-[400px] w-full">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <LineChart
                                            data={results.time_array.map((t: number, i: number) => {
                                                // Find corresponding COPV pressure for this time
                                                const copvIdx = results.summary.copv_time_s?.findIndex((ct: number) => Math.abs(ct - t) < 0.01) ?? -1;
                                                const copvPressure = copvIdx >= 0 && results.summary.copv_pressure_trace_Pa
                                                    ? results.summary.copv_pressure_trace_Pa[copvIdx] / 6894.76
                                                    : null;

                                                return {
                                                    time: t,
                                                    lox: (results.lox_pressure[i] || 0) / 6894.76,
                                                    fuel: (results.fuel_pressure[i] || 0) / 6894.76,
                                                    copv: copvPressure,
                                                };
                                            })}
                                            margin={{ top: 5, right: 60, left: 10, bottom: 5 }}
                                        >
                                            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                                            <XAxis
                                                dataKey="time"
                                                unit=" s"
                                                stroke="var(--color-text-secondary)"
                                                tick={{ fontSize: 12 }}
                                            />
                                            {/* Left Y-axis for tank pressures */}
                                            <YAxis
                                                yAxisId="left"
                                                stroke="var(--color-text-secondary)"
                                                tick={{ fontSize: 12 }}
                                                label={{ value: 'Tank Pressure (psi)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }}
                                            />
                                            {/* Right Y-axis for COPV pressure */}
                                            <YAxis
                                                yAxisId="right"
                                                orientation="right"
                                                stroke="#a855f7"
                                                tick={{ fontSize: 12 }}
                                                label={{ value: 'COPV Pressure (psi)', angle: 90, position: 'insideRight', fill: '#a855f7' }}
                                            />
                                            <Tooltip
                                                contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px' }}
                                            />
                                            <Legend />
                                            {/* Tank pressures on left axis */}
                                            <Line
                                                yAxisId="left"
                                                type="monotone"
                                                dataKey="lox"
                                                name="LOX Pressure"
                                                stroke="#3b82f6"
                                                strokeWidth={2}
                                                dot={false}
                                                isAnimationActive={false}
                                            />
                                            <Line
                                                yAxisId="left"
                                                type="monotone"
                                                dataKey="fuel"
                                                name="Fuel Pressure"
                                                stroke="#ef4444"
                                                strokeWidth={2}
                                                dot={false}
                                                isAnimationActive={false}
                                            />
                                            {/* COPV pressure on right axis */}
                                            <Line
                                                yAxisId="right"
                                                type="monotone"
                                                dataKey="copv"
                                                name="COPV Pressure"
                                                stroke="#a855f7"
                                                strokeWidth={2}
                                                dot={false}
                                                isAnimationActive={false}
                                                connectNulls
                                            />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>
                        )}

                    {/* Controller Simulation Section */}
                    <div className="mt-8 pt-8 border-t border-[var(--color-border)]">
                        <div className="flex justify-between items-center mb-4">
                            <h4 className="text-lg font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
                                <span className="text-purple-400">🎮</span> Controller Simulation
                            </h4>
                            <div className="flex gap-2">
                                {controllerLoading && (
                                    <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                                        <span>{controllerStage}</span>
                                        <span className="text-purple-400 font-bold">{(controllerProgress * 100).toFixed(0)}%</span>
                                    </div>
                                )}
                                {controllerLoading ? (
                                    <button
                                        onClick={handleStopController}
                                        className="px-4 py-2 rounded-lg font-medium transition-colors bg-red-600 hover:bg-red-700 text-white"
                                    >
                                        ⏹ Stop
                                    </button>
                                ) : (
                                    <>
                                        <button
                                            onClick={handleRunController}
                                            disabled={!results?.summary?.thrust_curve_time}
                                            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                                                !results?.summary?.thrust_curve_time
                                                    ? 'bg-gray-600 cursor-not-allowed text-gray-400'
                                                    : 'bg-purple-600 hover:bg-purple-700 text-white'
                                            }`}
                                        >
                                            ▶ Run from Layer 2 Results
                                        </button>
                                        <label className="px-4 py-2 rounded-lg font-medium transition-colors bg-green-600 hover:bg-green-700 text-white cursor-pointer">
                                            📁 Run from Config File
                                            <input
                                                type="file"
                                                accept=".yaml,.yml"
                                                className="hidden"
                                                onChange={async (e) => {
                                                    const file = e.target.files?.[0];
                                                    if (!file) return;
                                                    
                                                    setControllerLoading(true);
                                                    setControllerError(null);
                                                    setControllerResults(null);
                                                    setRealtimeData([]);
                                                    setControllerProgress(0);
                                                    setControllerStage('Loading config...');
                                                    
                                                    try {
                                                        const formData = new FormData();
                                                        formData.append('file', file);
                                                        formData.append('dt', '0.01');
                                                        
                                                        const response = await fetch(`${API_BASE}/control/upload-config-and-simulate`, {
                                                            method: 'POST',
                                                            body: formData,
                                                        });
                                                        
                                                        if (!response.ok) {
                                                            throw new Error(`HTTP ${response.status}`);
                                                        }
                                                        
                                                        // Handle streaming response
                                                        const reader = response.body?.getReader();
                                                        const decoder = new TextDecoder();
                                                        let buffer = '';
                                                        
                                                        if (!reader) {
                                                            throw new Error('No response body');
                                                        }
                                                        
                                                        const readStream = () => {
                                                            reader.read().then(({ done, value }) => {
                                                                if (done) {
                                                                    setControllerLoading(false);
                                                                    return;
                                                                }
                                                                
                                                                buffer += decoder.decode(value, { stream: true });
                                                                const lines = buffer.split('\n');
                                                                buffer = lines.pop() || '';
                                                                
                                                                for (const line of lines) {
                                                                    if (line.trim() && line.startsWith('data: ')) {
                                                                        try {
                                                                            const data = JSON.parse(line.slice(6));
                                                                            if (data.type === 'status' || data.type === 'progress') {
                                                                                if (data.progress !== undefined) setControllerProgress(data.progress);
                                                                                if (data.stage) setControllerStage(data.stage);
                                                                            } else if (data.type === 'data') {
                                                                                setRealtimeData(prev => [...prev, data]);
                                                                            } else if (data.type === 'complete') {
                                                                                setControllerLoading(false);
                                                                                setControllerProgress(1.0);
                                                                                setControllerStage('Complete');
                                                                                setRealtimeData(prev => {
                                                                                    const finalResults: Layer2ControllerSimulateResponse = {
                                                                                        time: prev.map(d => d.time || 0),
                                                                                        thrust_ref: prev.map(d => d.thrust_ref || 0),
                                                                                        thrust_actual: prev.map(d => d.thrust_actual || 0),
                                                                                        MR: prev.map(d => d.MR || 0),
                                                                                        P_copv: prev.map(d => d.P_copv || 0),
                                                                                        P_reg: prev.map(d => d.P_reg || 0),
                                                                                        P_u_fuel: prev.map(d => d.P_u_fuel || 0),
                                                                                        P_u_ox: prev.map(d => d.P_u_ox || 0),
                                                                                        P_d_fuel: prev.map(d => d.P_d_fuel || 0),
                                                                                        P_d_ox: prev.map(d => d.P_d_ox || 0),
                                                                                        P_ch: prev.map(d => d.P_ch || 0),
                                                                                        duty_F: prev.map(d => d.duty_F || 0),
                                                                                        duty_O: prev.map(d => d.duty_O || 0),
                                                                                        altitude: prev.map(d => d.altitude || 0),
                                                                                        velocity: prev.map(d => d.velocity || 0),
                                                                                        value_function: prev.map(d => d.value_function || 0),
                                                                                        control_effort: prev.map(d => d.control_effort || 0),
                                                                                        V_u_fuel: prev.map(d => d.V_u_fuel || 0),
                                                                                        V_u_ox: prev.map(d => d.V_u_ox || 0),
                                                                                        mdot_F: prev.map(d => d.mdot_F || 0),
                                                                                        mdot_O: prev.map(d => d.mdot_O || 0),
                                                                                        w_bar: prev.map(d => d.w_bar || []),
                                                                                        constraint_margins: prev.map(d => d.constraint_margins || {}),
                                                                                    };
                                                                                    setControllerResults(finalResults);
                                                                                    return prev;
                                                                                });
                                                                            } else if (data.type === 'error') {
                                                                                setControllerError(data.error || 'Unknown error');
                                                                                setControllerLoading(false);
                                                                            }
                                                                        } catch (err) {
                                                                            console.error('Error parsing SSE event:', err);
                                                                        }
                                                                    }
                                                                }
                                                                
                                                                readStream();
                                                            }).catch(err => {
                                                                setControllerError(err instanceof Error ? err.message : 'Stream error');
                                                                setControllerLoading(false);
                                                            });
                                                        };
                                                        
                                                        readStream();
                                                    } catch (err) {
                                                        setControllerError(err instanceof Error ? err.message : 'Failed to process config');
                                                        setControllerLoading(false);
                                                    }
                                                }}
                                            />
                                        </label>
                                    </>
                                )}
                            </div>
                        </div>
                        
                        {controllerLoading && (
                            <div className="mb-4">
                                <div className="w-full bg-[var(--color-bg-primary)] rounded-full h-2">
                                    <div
                                        className="bg-purple-500 h-full rounded-full transition-all duration-300"
                                        style={{ width: `${controllerProgress * 100}%` }}
                                    />
                                </div>
                            </div>
                        )}
                        
                        {controllerError && (
                            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                                ❌ {controllerError}
                            </div>
                        )}

                        {(controllerResults || realtimeData.length > 0) && (
                            <div className="space-y-6">
                                {/* Thrust Tracking */}
                                <div className="p-4 rounded-xl bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                                    <h5 className="text-sm font-semibold mb-3 text-[var(--color-text-primary)]">
                                        Thrust Tracking {controllerLoading && <span className="text-purple-400 text-xs">(Live)</span>}
                                    </h5>
                                    <ResponsiveContainer width="100%" height={250}>
                                        <LineChart data={(controllerResults ? controllerResults.time : realtimeData.map(d => d.time || 0)).map((t, i) => ({
                                            time: t,
                                            reference: controllerResults ? controllerResults.thrust_ref[i] : (realtimeData[i]?.thrust_ref || 0),
                                            actual: controllerResults ? controllerResults.thrust_actual[i] : (realtimeData[i]?.thrust_actual || 0),
                                        }))}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                                            <XAxis dataKey="time" unit=" s" stroke="var(--color-text-secondary)" tick={{ fontSize: 11 }} />
                                            <YAxis stroke="var(--color-text-secondary)" tick={{ fontSize: 11 }} label={{ value: 'Thrust (N)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }} />
                                            <Tooltip contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px' }} />
                                            <Legend />
                                            <Line type="monotone" dataKey="reference" name="Reference (Layer 2)" stroke="#10b981" strokeWidth={2} dot={false} />
                                            <Line type="monotone" dataKey="actual" name="Actual (Controller)" stroke="#3b82f6" strokeWidth={2} dot={false} />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>

                                {/* Robustness Metrics */}
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                    <ResultCard
                                        label="Max Tracking Error"
                                        value={Math.max(...controllerResults.time.map((t, i) => 
                                            Math.abs(controllerResults.thrust_ref[i] - controllerResults.thrust_actual[i])
                                        ))}
                                        unit="N"
                                        decimals={1}
                                        color="red"
                                    />
                                    <ResultCard
                                        label="RMS Tracking Error"
                                        value={Math.sqrt(
                                            controllerResults.time.reduce((sum, t, i) => {
                                                const err = controllerResults.thrust_ref[i] - controllerResults.thrust_actual[i];
                                                return sum + err * err;
                                            }, 0) / controllerResults.time.length
                                        )}
                                        unit="N"
                                        decimals={1}
                                        color="orange"
                                    />
                                    <ResultCard
                                        label="Avg Robustness Bound"
                                        value={controllerResults.w_bar.length > 0
                                            ? controllerResults.w_bar.reduce((sum, w) => sum + w.reduce((s, v) => s + Math.abs(v), 0), 0) / (controllerResults.w_bar.length * controllerResults.w_bar[0].length)
                                            : 0
                                        }
                                        unit=""
                                        decimals={3}
                                        color="purple"
                                    />
                                    <ResultCard
                                        label="Min Constraint Margin"
                                        value={controllerResults.constraint_margins.length > 0
                                            ? Math.min(...controllerResults.constraint_margins.flatMap(m => Object.values(m).filter(v => typeof v === 'number')))
                                            : 0
                                        }
                                        unit=""
                                        decimals={3}
                                        color="cyan"
                                    />
                                </div>

                                {/* Pressures */}
                                <div className="p-4 rounded-xl bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                                    <h5 className="text-sm font-semibold mb-3 text-[var(--color-text-primary)]">
                                        Pressures {controllerLoading && <span className="text-purple-400 text-xs">(Live)</span>}
                                    </h5>
                                    <ResponsiveContainer width="100%" height={250}>
                                        <LineChart data={(controllerResults ? controllerResults.time : realtimeData.map(d => d.time || 0)).map((t, i) => ({
                                            time: t,
                                            copv: (controllerResults ? controllerResults.P_copv[i] : (realtimeData[i]?.P_copv || 0)) / 6894.76,
                                            reg: (controllerResults ? controllerResults.P_reg[i] : (realtimeData[i]?.P_reg || 0)) / 6894.76,
                                            u_fuel: (controllerResults ? controllerResults.P_u_fuel[i] : (realtimeData[i]?.P_u_fuel || 0)) / 6894.76,
                                            u_ox: (controllerResults ? controllerResults.P_u_ox[i] : (realtimeData[i]?.P_u_ox || 0)) / 6894.76,
                                            ch: (controllerResults ? controllerResults.P_ch[i] : (realtimeData[i]?.P_ch || 0)) / 6894.76,
                                        }))}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                                            <XAxis dataKey="time" unit=" s" stroke="var(--color-text-secondary)" tick={{ fontSize: 11 }} />
                                            <YAxis stroke="var(--color-text-secondary)" tick={{ fontSize: 11 }} label={{ value: 'Pressure (psi)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }} />
                                            <Tooltip contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px' }} />
                                            <Legend />
                                            <Line type="monotone" dataKey="copv" name="COPV" stroke="#a855f7" strokeWidth={2} dot={false} />
                                            <Line type="monotone" dataKey="reg" name="Regulator" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                                            <Line type="monotone" dataKey="u_fuel" name="Ullage Fuel" stroke="#ef4444" strokeWidth={2} dot={false} />
                                            <Line type="monotone" dataKey="u_ox" name="Ullage LOX" stroke="#3b82f6" strokeWidth={2} dot={false} />
                                            <Line type="monotone" dataKey="ch" name="Chamber" stroke="#10b981" strokeWidth={2} dot={false} />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>

                                {/* Actuation */}
                                <div className="p-4 rounded-xl bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                                    <h5 className="text-sm font-semibold mb-3 text-[var(--color-text-primary)]">
                                        Actuation (Duty Cycles) {controllerLoading && <span className="text-purple-400 text-xs">(Live)</span>}
                                    </h5>
                                    <ResponsiveContainer width="100%" height={200}>
                                        <LineChart data={(controllerResults ? controllerResults.time : realtimeData.map(d => d.time || 0)).map((t, i) => ({
                                            time: t,
                                            duty_F: (controllerResults ? controllerResults.duty_F[i] : (realtimeData[i]?.duty_F || 0)) * 100,
                                            duty_O: (controllerResults ? controllerResults.duty_O[i] : (realtimeData[i]?.duty_O || 0)) * 100,
                                        }))}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                                            <XAxis dataKey="time" unit=" s" stroke="var(--color-text-secondary)" tick={{ fontSize: 11 }} />
                                            <YAxis stroke="var(--color-text-secondary)" tick={{ fontSize: 11 }} label={{ value: 'Duty (%)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }} domain={[0, 100]} />
                                            <Tooltip contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px' }} />
                                            <Legend />
                                            <Line type="monotone" dataKey="duty_F" name="Fuel Duty" stroke="#ef4444" strokeWidth={2} dot={false} />
                                            <Line type="monotone" dataKey="duty_O" name="LOX Duty" stroke="#3b82f6" strokeWidth={2} dot={false} />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>

                                {/* Mixture Ratio */}
                                <div className="p-4 rounded-xl bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                                    <h5 className="text-sm font-semibold mb-3 text-[var(--color-text-primary)]">
                                        Mixture Ratio (MR) {controllerLoading && <span className="text-purple-400 text-xs">(Live)</span>}
                                    </h5>
                                    <ResponsiveContainer width="100%" height={200}>
                                        <LineChart data={(controllerResults ? controllerResults.time : realtimeData.map(d => d.time || 0)).map((t, i) => ({
                                            time: t,
                                            MR: controllerResults ? controllerResults.MR[i] : (realtimeData[i]?.MR || 0),
                                        }))}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                                            <XAxis dataKey="time" unit=" s" stroke="var(--color-text-secondary)" tick={{ fontSize: 11 }} />
                                            <YAxis stroke="var(--color-text-secondary)" tick={{ fontSize: 11 }} label={{ value: 'MR', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }} />
                                            <Tooltip contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px' }} />
                                            <Legend />
                                            <Line type="monotone" dataKey="MR" name="Mixture Ratio" stroke="#eab308" strokeWidth={2} dot={false} />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
