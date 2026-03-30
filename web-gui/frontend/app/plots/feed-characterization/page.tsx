'use client'

import { useEffect, useState, useMemo } from 'react';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { PRESSURE_SENSORS, getEntityColor } from '@/lib/sensor-colors';
import { getWebSocketClient } from '@/lib/websocket';
import { ActuatorId, ActuatorState } from '@/lib/types';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import {
    ScatterChart,
    Scatter,
    XAxis,
    YAxis,
    ZAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Label,
} from 'recharts';

interface CharacterizationResult {
    id: number;
    timestamp: string;
    system: string;
    fluid: string;
    flowTime: number;
    totalMass: number;
    mdot: number;
    avgPUp: number;
    avgPDown: number;
    deltaP: number;
    cda: number;
    re: number;
}

const FLUID_PROPERTIES: Record<string, { density: number; viscosity: number }> = {
    'LOX': { density: 1141, viscosity: 1.9e-4 },
    'Kerosene': { density: 810, viscosity: 2.4e-3 },
    'Water': { density: 1000, viscosity: 8.9e-4 },
    'GN2': { density: 1.25, viscosity: 1.8e-5 }, // At STP, roughly
    'Custom': { density: 1000, viscosity: 1e-3 },
};

const SYSTEMS = [
    { label: 'Fuel', up: 'PT_Cal.Fuel_Upstream', down: 'PT_Cal.Fuel_Downstream' },
    { label: 'LOX', up: 'PT_Cal.Ox_Upstream', down: 'PT_Cal.Ox_Downstream' },
    { label: 'COPV', up: 'PT_Cal.GN2_High', down: 'PT_Cal.GN2_Regulated' },
];

export default function FeedCharacterizationPage() {
    const [flowTime, setFlowTime] = useState<number>(1);
    const [totalMass, setTotalMass] = useState<number>(0.5);
    const [selectedSystemLabel, setSelectedSystemLabel] = useState<string>('Fuel');
    const [selectedFluid, setSelectedFluid] = useState<string>('Kerosene');
    const [customDensity, setCustomDensity] = useState<number>(FLUID_PROPERTIES['Kerosene'].density);
    const [customViscosity, setCustomViscosity] = useState<number>(FLUID_PROPERTIES['Kerosene'].viscosity);
    const [diameter, setDiameter] = useState<number>(0.0254); // 1 inch

    const [isTestRunning, setIsTestRunning] = useState(false);
    const [testStartTime, setTestStartTime] = useState<number | null>(null);
    const [elapsedTime, setElapsedTime] = useState<number>(0);
    const [accumulatedPUp, setAccumulatedPUp] = useState<number[]>([]);
    const [accumulatedPDown, setAccumulatedPDown] = useState<number[]>([]);
    const [results, setResults] = useState<CharacterizationResult[]>([]);

    const ws = getWebSocketClient();

    const selectedSystem = SYSTEMS.find(s => s.label === selectedSystemLabel) || SYSTEMS[0];
    const currentUpVal = useSensorValue(selectedSystem.up, 'pressure_psi');
    const currentDownVal = useSensorValue(selectedSystem.down, 'pressure_psi');

    const density = selectedFluid === 'Custom' ? customDensity : FLUID_PROPERTIES[selectedFluid].density;
    const viscosity = selectedFluid === 'Custom' ? customViscosity : FLUID_PROPERTIES[selectedFluid].viscosity;

    // Real-time delta P
    const liveDeltaP = (currentUpVal !== null && currentDownVal !== null) ? currentUpVal - currentDownVal : null;

    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (isTestRunning && testStartTime) {
            interval = setInterval(() => {
                setElapsedTime((Date.now() - testStartTime) / 1000);
            }, 50);
        }
        return () => clearInterval(interval);
    }, [isTestRunning, testStartTime]);

    useEffect(() => {
        if (isTestRunning && currentUpVal !== null && currentDownVal !== null) {
            setAccumulatedPUp(prev => [...prev, currentUpVal]);
            setAccumulatedPDown(prev => [...prev, currentDownVal]);
        }
    }, [isTestRunning, currentUpVal, currentDownVal]);

    const toggleSolenoids = (state: ActuatorState) => {
        const commands: { id: ActuatorId, name: string }[] = [];
        if (selectedSystemLabel === 'Fuel') {
            commands.push({ id: ActuatorId.FUEL_MAIN, name: 'Fuel Main' });
        } else if (selectedSystemLabel === 'LOX') {
            commands.push({ id: ActuatorId.LOX_MAIN, name: 'LOX Main' });
        } else if (selectedSystemLabel === 'COPV') {
            commands.push({ id: ActuatorId.FUEL_PRESS, name: 'Fuel Press' });
            commands.push({ id: ActuatorId.LOX_PRESS, name: 'LOX Press' });
        }

        commands.forEach(cmd => {
            ws.sendCommand({
                commandType: 'actuator',
                data: {
                    actuatorId: cmd.id,
                    actuatorName: cmd.name,
                    actuatorState: state
                }
            });
        });
    };

    const startTest = () => {
        setAccumulatedPUp([]);
        setAccumulatedPDown([]);
        setElapsedTime(0);
        const now = Date.now();
        setTestStartTime(now);
        setIsTestRunning(true);
        toggleSolenoids(ActuatorState.OPEN);
    };

    const stopTest = () => {
        setIsTestRunning(false);
        toggleSolenoids(ActuatorState.CLOSED);
        if (accumulatedPUp.length === 0 || accumulatedPDown.length === 0) return;

        const finalFlowTime = elapsedTime;
        setFlowTime(finalFlowTime);
    };

    const calculateCdA = () => {
        if (accumulatedPUp.length === 0 || accumulatedPDown.length === 0 || flowTime <= 0) return;

        const avgPUp = accumulatedPUp.reduce((a, b) => a + b, 0) / accumulatedPUp.length;
        const avgPDown = accumulatedPDown.reduce((a, b) => a + b, 0) / accumulatedPDown.length;
        const deltaP_psi = avgPUp - avgPDown;
        const deltaP_pa = deltaP_psi * 6894.76;

        const mdot = totalMass / flowTime;

        // CdA = mdot / sqrt(2 * rho * deltaP)
        // Avoid division by zero or sqrt of negative
        const cda = (deltaP_pa > 0) ? mdot / Math.sqrt(2 * density * deltaP_pa) : 0;

        // Reynolds = 4 * mdot / (pi * D * mu)
        const re = (4 * mdot) / (Math.PI * diameter * viscosity);

        const newResult: CharacterizationResult = {
            id: Date.now(),
            timestamp: new Date().toLocaleTimeString(),
            system: selectedSystemLabel,
            fluid: selectedFluid,
            flowTime,
            totalMass,
            mdot,
            avgPUp,
            avgPDown,
            deltaP: deltaP_psi,
            cda,
            re
        };

        setResults(prev => [...prev, newResult]);
    };

    const exportCsv = () => {
        if (results.length === 0) return;
        const headers = ['Timestamp', 'System', 'Fluid', 'Flow Time (s)', 'Total Mass (kg)', 'MDOT (kg/s)', 'Avg P Up (PSI)', 'Avg P Down (PSI)', 'Delta P (PSI)', 'CdA (m^2)', 'Reynolds'];
        const rows = results.map(r => [
            r.timestamp, r.system, r.fluid, r.flowTime, r.totalMass, r.mdot.toFixed(4),
            r.avgPUp.toFixed(2), r.avgPDown.toFixed(2), r.deltaP.toFixed(2),
            r.cda.toExponential(4), r.re.toExponential(2)
        ]);

        const csvContent = "data:text/csv;charset=utf-8,"
            + headers.join(",") + "\n"
            + rows.map(e => e.join(",")).join("\n");

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `feed_char_${Date.now()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    return (
        <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-3">
            <div className="flex items-center gap-3 flex-shrink-0">
                <div className="w-1 h-5 bg-blue-500 rounded-full" />
                <h1 className="text-base font-bold text-blue-400 tracking-wider uppercase">Feed System Characterization</h1>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 flex-shrink-0">
                {/* Parameters */}
                <div className="bg-card border border-gray-800 rounded-lg p-4 flex flex-col gap-3">
                    <h2 className="text-xs font-bold text-text-muted uppercase tracking-widest border-b border-gray-800 pb-2 mb-1">Inputs</h2>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-bold text-text-muted uppercase">Flow Time (s) [captured]</label>
                            <div className="bg-gray-950 border border-gray-800 rounded px-2 py-1.5 text-sm font-mono text-blue-400">
                                {isTestRunning ? elapsedTime.toFixed(2) : flowTime.toFixed(2)}
                            </div>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-bold text-text-muted uppercase">Total Mass Input (kg)</label>
                            <input
                                type="number"
                                value={totalMass}
                                onChange={(e) => setTotalMass(Number(e.target.value))}
                                className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm font-mono text-emerald-400"
                            />
                        </div>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-text-muted uppercase">System</label>
                        <select
                            value={selectedSystemLabel}
                            onChange={(e) => setSelectedSystemLabel(e.target.value)}
                            className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm"
                        >
                            {SYSTEMS.map(s => <option key={s.label} value={s.label}>{s.label}</option>)}
                        </select>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-text-muted uppercase">Fluid</label>
                        <select
                            value={selectedFluid}
                            onChange={(e) => {
                                setSelectedFluid(e.target.value);
                                if (e.target.value !== 'Custom') {
                                    setCustomDensity(FLUID_PROPERTIES[e.target.value].density);
                                    setCustomViscosity(FLUID_PROPERTIES[e.target.value].viscosity);
                                }
                            }}
                            className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm"
                        >
                            {Object.keys(FLUID_PROPERTIES).map(f => <option key={f} value={f}>{f}</option>)}
                        </select>
                    </div>

                    {selectedFluid === 'Custom' && (
                        <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] font-bold text-text-muted uppercase">Density (kg/m³)</label>
                                <input
                                    type="number"
                                    value={customDensity}
                                    onChange={(e) => setCustomDensity(Number(e.target.value))}
                                    className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] font-bold text-text-muted uppercase">Viscosity (Pa·s)</label>
                                <input
                                    type="number"
                                    value={customViscosity}
                                    onChange={(e) => setCustomViscosity(Number(e.target.value))}
                                    className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm"
                                />
                            </div>
                        </div>
                    )}

                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-text-muted uppercase">Char. Diameter (m)</label>
                        <input
                            type="number"
                            value={diameter}
                            onChange={(e) => setDiameter(Number(e.target.value))}
                            className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm"
                        />
                    </div>
                </div>

                {/* Capture */}
                <div className="bg-card border border-gray-800 rounded-lg p-4 flex flex-col gap-3 justify-between">
                    <div>
                        <h2 className="text-xs font-bold text-text-muted uppercase tracking-widest border-b border-gray-800 pb-2 mb-4">Capture Controls</h2>

                        <div className="grid grid-cols-2 gap-4 mb-4">
                            <div className="bg-gray-900/50 rounded p-2 border border-gray-800/50 text-center">
                                <div className="text-[10px] font-bold text-text-muted uppercase mb-1">Upstream</div>
                                <div className="text-xl font-mono font-bold text-blue-400">{currentUpVal?.toFixed(1) ?? '---'}</div>
                                <div className="text-[9px] text-gray-500">PSI</div>
                            </div>
                            <div className="bg-gray-900/50 rounded p-2 border border-gray-800/50 text-center">
                                <div className="text-[10px] font-bold text-text-muted uppercase mb-1">Downstream</div>
                                <div className="text-xl font-mono font-bold text-indigo-400">{currentDownVal?.toFixed(1) ?? '---'}</div>
                                <div className="text-[9px] text-gray-500">PSI</div>
                            </div>
                        </div>

                        <div className="bg-blue-900/10 rounded-lg p-3 border border-blue-900/30 text-center mb-4">
                            <div className="text-[10px] font-bold text-blue-400 uppercase mb-1">Live Delta P</div>
                            <div className="text-3xl font-mono font-bold text-blue-300">{liveDeltaP?.toFixed(2) ?? '---'}</div>
                            <div className="text-[10px] text-blue-500/80 mt-1">PSI</div>
                        </div>
                    </div>

                    {!isTestRunning ? (
                        <div className="flex flex-col gap-2">
                            <button
                                onClick={startTest}
                                className="w-full bg-blue-600 hover:bg-blue-500 text-black font-black py-4 rounded-xl transition-all uppercase tracking-tighter"
                            >
                                Start Flow Window
                            </button>
                            {accumulatedPUp.length > 0 && (
                                <button
                                    onClick={calculateCdA}
                                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-black font-bold py-2 rounded-lg transition-all uppercase text-xs"
                                >
                                    Calculate with Mass Input
                                </button>
                            )}
                        </div>
                    ) : (
                        <button
                            onClick={stopTest}
                            className="w-full bg-red-600 hover:bg-red-500 text-white font-black py-4 rounded-xl transition-all uppercase animate-pulse"
                        >
                            Stop & Capture Time
                        </button>
                    )}
                </div>

                {/* Latest Result */}
                <div className="bg-card border border-gray-800 rounded-lg p-4 flex flex-col">
                    <h2 className="text-xs font-bold text-text-muted uppercase tracking-widest border-b border-gray-800 pb-2 mb-4">Latest Calculation</h2>

                    {results.length > 0 ? (
                        <div className="flex-1 flex flex-col justify-around">
                            <div className="flex justify-between items-end border-b border-gray-800/40 pb-2">
                                <span className="text-xs font-bold text-text-muted">MDOT</span>
                                <span className="text-xl font-mono font-bold text-white">{results[results.length - 1].mdot.toFixed(3)} <span className="text-xs font-normal text-gray-400">kg/s</span></span>
                            </div>
                            <div className="flex justify-between items-end border-b border-gray-800/40 py-2">
                                <span className="text-xs font-bold text-text-muted">CdA</span>
                                <span className="text-xl font-mono font-bold text-emerald-400">{results[results.length - 1].cda.toExponential(3)} <span className="text-xs font-normal text-gray-400">m²</span></span>
                            </div>
                            <div className="flex justify-between items-end border-b border-gray-800/40 py-2">
                                <span className="text-xs font-bold text-text-muted">Reynolds</span>
                                <span className="text-xl font-mono font-bold text-amber-400">{results[results.length - 1].re.toExponential(2)}</span>
                            </div>
                            <button
                                onClick={exportCsv}
                                className="mt-4 bg-gray-800 hover:bg-gray-700 text-xs font-bold py-2 rounded uppercase border border-gray-600"
                            >
                                Export CSV ({results.length} runs)
                            </button>
                        </div>
                    ) : (
                        <div className="flex-1 flex items-center justify-center text-gray-600 italic text-sm text-center">
                            No results yet.<br />Perform a flow to see calculations.
                        </div>
                    )}
                </div>
            </div>

            <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-3">
                {/* Plots */}
                <div className="bg-card border border-gray-800 rounded-lg p-2 flex flex-col min-w-0">
                    <div className="px-2 pt-1 flex justify-between items-center">
                        <h3 className="text-[10px] font-bold text-text-muted uppercase mb-2">Live Pressures (PSI)</h3>
                        <div className="flex gap-2 mb-2">
                            <div className="flex items-center gap-1">
                                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: getEntityColor(selectedSystem.up) }} />
                                <span className="text-[9px] text-gray-500 uppercase font-mono">Up</span>
                            </div>
                            <div className="flex items-center gap-1">
                                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: getEntityColor(selectedSystem.down) }} />
                                <span className="text-[9px] text-gray-500 uppercase font-mono">Down</span>
                            </div>
                        </div>
                    </div>
                    <div className="flex-1 min-h-[180px]">
                        <TimeSeriesPlot
                            title="Feed Pressures"
                            entities={[selectedSystem.up, selectedSystem.down]}
                            component="pressure_psi"
                            colors={[getEntityColor(selectedSystem.up), getEntityColor(selectedSystem.down)]}
                            height={180}
                        />
                    </div>
                </div>

                <div className="bg-card border border-gray-800 rounded-lg p-2 flex flex-col min-w-0">
                    <div className="px-2 pt-1">
                        <h3 className="text-[10px] font-bold text-text-muted uppercase mb-2">CdA vs MDOT</h3>
                    </div>
                    <div className="flex-1 min-h-0">
                        <ResponsiveContainer width="100%" height="100%">
                            <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                                <XAxis type="number" dataKey="mdot" name="MDOT" stroke="#888" fontSize={10}>
                                    <Label value="MDOT (kg/s)" position="bottom" offset={0} fill="#888" fontSize={10} />
                                </XAxis>
                                <YAxis type="number" dataKey="cda" name="CdA" stroke="#888" fontSize={10}>
                                    <Label value="CdA (m²)" angle={-90} position="left" offset={-10} fill="#888" fontSize={10} />
                                </YAxis>
                                <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ backgroundColor: '#111', border: '1px solid #333', fontSize: '10px' }} />
                                <Scatter name="Tests" data={results} fill="#34d399" />
                            </ScatterChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                <div className="bg-card border border-gray-800 rounded-lg p-2 flex flex-col min-w-0">
                    <div className="px-2 pt-1">
                        <h3 className="text-[10px] font-bold text-text-muted uppercase mb-2">Reynolds vs CdA</h3>
                    </div>
                    <div className="flex-1 min-h-0">
                        <ResponsiveContainer width="100%" height="100%">
                            <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                                <XAxis type="number" dataKey="re" name="Reynolds" stroke="#888" fontSize={10} domain={['auto', 'auto']}>
                                    <Label value="Reynolds Number" position="bottom" offset={0} fill="#888" fontSize={10} />
                                </XAxis>
                                <YAxis type="number" dataKey="cda" name="CdA" stroke="#888" fontSize={10}>
                                    <Label value="CdA (m²)" angle={-90} position="left" offset={-10} fill="#888" fontSize={10} />
                                </YAxis>
                                <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ backgroundColor: '#111', border: '1px solid #333', fontSize: '10px' }} />
                                <Scatter name="Tests" data={results} fill="#fbbf24" />
                            </ScatterChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            </div>

            {/* History Table */}
            <div className="h-32 bg-card border border-gray-800 rounded-lg overflow-hidden flex flex-col flex-shrink-0">
                <div className="bg-gray-900 border-b border-gray-800 px-3 py-1 flex justify-between items-center">
                    <span className="text-[10px] font-black text-text-muted uppercase">Run History</span>
                    <span className="text-[9px] text-gray-500 font-mono">{results.length} points</span>
                </div>
                <div className="flex-1 overflow-auto">
                    <table className="w-full text-[10px] text-left border-collapse">
                        <thead className="bg-gray-900/50 sticky top-0">
                            <tr className="border-b border-gray-800 text-text-muted">
                                <th className="px-3 py-1 font-bold">Time</th>
                                <th className="px-3 py-1 font-bold">System</th>
                                <th className="px-3 py-1 font-bold">MDOT</th>
                                <th className="px-3 py-1 font-bold">ΔP</th>
                                <th className="px-3 py-1 font-bold">CdA</th>
                                <th className="px-3 py-1 font-bold">Re</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800/40">
                            {results.slice().reverse().map(r => (
                                <tr key={r.id} className="hover:bg-white/[0.02]">
                                    <td className="px-3 py-1 font-mono">{r.timestamp}</td>
                                    <td className="px-3 py-1">{r.system} ({r.fluid})</td>
                                    <td className="px-3 py-1 font-mono">{r.mdot.toFixed(3)}</td>
                                    <td className="px-3 py-1 font-mono">{r.deltaP.toFixed(1)}</td>
                                    <td className="px-3 py-1 font-mono text-emerald-400">{r.cda.toExponential(3)}</td>
                                    <td className="px-3 py-1 font-mono text-amber-400">{r.re.toExponential(2)}</td>
                                </tr>
                            ))}
                            {results.length === 0 && (
                                <tr>
                                    <td colSpan={6} className="px-3 py-4 text-center text-gray-600 italic">No data recorded.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </main>
    );
}
