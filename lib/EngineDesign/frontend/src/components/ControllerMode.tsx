import { useState, useCallback, useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import {
  initController,
  simulateController,
  resetController,
  getControllerStatus,
  type EngineConfig,
  type ControllerSimulateRequest,
  type ControllerSimulateResponse,
  API_BASE,
} from '../api/client';

interface ControllerModeProps {
  config: EngineConfig | null;
}

type CommandMode = 'thrust_desired' | 'altitude_goal';

export function ControllerMode({ config }: ControllerModeProps) {
  // Command mode
  const [commandMode, setCommandMode] = useState<CommandMode>('thrust_desired');
  
  // Thrust command mode
  const [thrustConstant, setThrustConstant] = useState('5000');
  const [thrustCurve, setThrustCurve] = useState<Array<[number, number]>>([]);
  const [useThrustCurve, setUseThrustCurve] = useState(false);
  
  // Altitude command mode
  const [altitudeGoal, setAltitudeGoal] = useState('200');
  
  // Initial conditions
  const [initialPcopv, setInitialPcopv] = useState('2750'); // psi
  const [initialPreg, setInitialPreg] = useState('1000'); // psi
  const [initialPufuel, setInitialPufuel] = useState('435'); // psi
  const [initialPuox, setInitialPuox] = useState('507'); // psi
  const [initialPdfuel, setInitialPdfuel] = useState('420'); // psi
  const [initialPdox, setInitialPdox] = useState('500'); // psi
  const [initialAltitude, setInitialAltitude] = useState('0');
  const [initialVelocity, setInitialVelocity] = useState('0');
  const [vehicleMass, setVehicleMass] = useState('100');
  
  // Simulation parameters
  const [duration, setDuration] = useState('5.0');
  const [dt, setDt] = useState('0.01');
  
  // Results
  const [results, setResults] = useState<ControllerSimulateResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [controllerInitialized, setControllerInitialized] = useState(false);
  
  // Real-time streaming state
  const [realtimeData, setRealtimeData] = useState<Array<any>>([]);
  const [simulationProgress, setSimulationProgress] = useState(0);
  const [simulationStage, setSimulationStage] = useState('');
  
  // Check controller status on mount
  useEffect(() => {
    checkControllerStatus();
  }, []);
  
  const checkControllerStatus = useCallback(async () => {
    const status = await getControllerStatus();
    if (status.data?.initialized) {
      setControllerInitialized(true);
    }
  }, []);
  
  const handleInit = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await initController({
        use_engine_config: true,
      });
      
      if (response.error) {
        setError(response.error);
      } else {
        setControllerInitialized(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize controller');
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  const handleSimulate = useCallback(async () => {
    if (!config) {
      setError('Please load an engine configuration first');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    setResults(null);
    
    try {
      // Initialize controller if needed
      if (!controllerInitialized) {
        await handleInit();
      }
      
      // Convert psi to Pa
      const PSI_TO_PA = 6894.76;
      
      // Build command
      let cmd: any;
      let thrustCurveArray: number[] | undefined;
      let timeArray: number[] | undefined;
      
      if (commandMode === 'thrust_desired') {
        if (useThrustCurve && thrustCurve.length > 0) {
          // Piecewise thrust curve
          thrustCurveArray = thrustCurve.map(([t, f]) => f);
          timeArray = thrustCurve.map(([t, f]) => t);
          cmd = {
            command_type: 'thrust_desired',
            thrust_desired: null,
          };
        } else {
          // Constant thrust
          cmd = {
            command_type: 'thrust_desired',
            thrust_desired: parseFloat(thrustConstant),
          };
        }
      } else {
        cmd = {
          command_type: 'altitude_goal',
          altitude_goal: parseFloat(altitudeGoal),
        };
      }
      
      const request: ControllerSimulateRequest = {
        initial_meas: {
          P_copv: parseFloat(initialPcopv) * PSI_TO_PA,
          P_reg: parseFloat(initialPreg) * PSI_TO_PA,
          P_u_fuel: parseFloat(initialPufuel) * PSI_TO_PA,
          P_u_ox: parseFloat(initialPuox) * PSI_TO_PA,
          P_d_fuel: parseFloat(initialPdfuel) * PSI_TO_PA,
          P_d_ox: parseFloat(initialPdox) * PSI_TO_PA,
        },
        initial_nav: {
          h: parseFloat(initialAltitude),
          vz: parseFloat(initialVelocity),
          theta: 0,
          mass_estimate: parseFloat(vehicleMass),
        },
        cmd,
        duration: parseFloat(duration),
        dt: parseFloat(dt),
        thrust_curve: thrustCurveArray,
        time_array: timeArray,
      };
      
      const response = await simulateController(request);
      
      if (response.error) {
        setError(response.error);
      } else if (response.data) {
        setResults(response.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to simulate controller');
    } finally {
      setIsLoading(false);
    }
  }, [
    config,
    commandMode,
    thrustConstant,
    thrustCurve,
    useThrustCurve,
    altitudeGoal,
    initialPcopv,
    initialPreg,
    initialPufuel,
    initialPuox,
    initialPdfuel,
    initialPdox,
    initialAltitude,
    initialVelocity,
    vehicleMass,
    duration,
    dt,
    controllerInitialized,
    handleInit,
  ]);
  
  const addThrustPoint = useCallback(() => {
    const lastTime = thrustCurve.length > 0 ? thrustCurve[thrustCurve.length - 1][0] : 0;
    setThrustCurve([...thrustCurve, [lastTime + 1, parseFloat(thrustConstant) || 5000]]);
  }, [thrustCurve, thrustConstant]);
  
  const removeThrustPoint = useCallback((index: number) => {
    setThrustCurve(thrustCurve.filter((_, i) => i !== index));
  }, [thrustCurve]);
  
  const updateThrustPoint = useCallback((index: number, time: number, thrust: number) => {
    const updated = [...thrustCurve];
    updated[index] = [time, thrust];
    updated.sort((a, b) => a[0] - b[0]); // Sort by time
    setThrustCurve(updated);
  }, [thrustCurve]);
  
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <h2 className="text-2xl font-bold text-[var(--color-text-primary)] mb-2">
          Robust DDP Thrust Controller
        </h2>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Provide a target thrust curve or altitude goal, and the controller will compute optimal actuation commands.
        </p>
      </div>
      
      {/* Controller Status */}
      {!controllerInitialized && (
        <div className="p-4 rounded-xl bg-yellow-500/10 border border-yellow-500/30">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold text-yellow-400">Controller not initialized</p>
              <p className="text-sm text-yellow-300/80">Initialize the controller before running simulations</p>
            </div>
            <button
              onClick={handleInit}
              disabled={isLoading || !config}
              className="px-4 py-2 bg-yellow-500 hover:bg-yellow-600 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Initialize Controller
            </button>
          </div>
        </div>
      )}
      
      {/* Error Display */}
      {error && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400">
          <p className="font-semibold">Error</p>
          <p className="text-sm">{error}</p>
        </div>
      )}
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Inputs */}
        <div className="space-y-6">
          {/* Command Mode Selection */}
          <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
            <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Command Mode</h3>
            <div className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="commandMode"
                  value="thrust_desired"
                  checked={commandMode === 'thrust_desired'}
                  onChange={(e) => setCommandMode(e.target.value as CommandMode)}
                  className="w-4 h-4"
                />
                <span className="text-[var(--color-text-primary)]">Target Thrust</span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="commandMode"
                  value="altitude_goal"
                  checked={commandMode === 'altitude_goal'}
                  onChange={(e) => setCommandMode(e.target.value as CommandMode)}
                  className="w-4 h-4"
                />
                <span className="text-[var(--color-text-primary)]">Altitude Goal</span>
              </label>
            </div>
          </div>
          
          {/* Thrust Command Input */}
          {commandMode === 'thrust_desired' && (
            <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
              <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Thrust Command</h3>
              <div className="space-y-4">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useThrustCurve}
                    onChange={(e) => setUseThrustCurve(e.target.checked)}
                    className="w-4 h-4"
                  />
                  <span className="text-[var(--color-text-primary)]">Use piecewise thrust curve</span>
                </label>
                
                {!useThrustCurve ? (
                  <div>
                    <label className="block text-sm text-[var(--color-text-secondary)] mb-1">
                      Constant Thrust
                    </label>
                    <input
                      type="number"
                      value={thrustConstant}
                      onChange={(e) => setThrustConstant(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
                      placeholder="5000"
                    />
                    <p className="text-xs text-[var(--color-text-muted)] mt-1">Thrust in Newtons [N]</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-[var(--color-text-primary)]">
                        Thrust Curve Points
                      </label>
                      <button
                        onClick={addThrustPoint}
                        className="px-3 py-1 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded"
                      >
                        Add Point
                      </button>
                    </div>
                    {thrustCurve.map(([time, thrust], index) => (
                      <div key={index} className="flex gap-2 items-center">
                        <input
                          type="number"
                          value={time}
                          onChange={(e) => updateThrustPoint(index, parseFloat(e.target.value) || 0, thrust)}
                          className="flex-1 px-2 py-1 rounded bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
                          placeholder="Time [s]"
                        />
                        <input
                          type="number"
                          value={thrust}
                          onChange={(e) => updateThrustPoint(index, time, parseFloat(e.target.value) || 0)}
                          className="flex-1 px-2 py-1 rounded bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
                          placeholder="Thrust [N]"
                        />
                        <button
                          onClick={() => removeThrustPoint(index)}
                          className="px-2 py-1 text-sm bg-red-500 hover:bg-red-600 text-white rounded"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {thrustCurve.length === 0 && (
                      <p className="text-sm text-[var(--color-text-muted)]">No points added. Click "Add Point" to create a thrust curve.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          
          {/* Altitude Goal Input */}
          {commandMode === 'altitude_goal' && (
            <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
              <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Altitude Goal</h3>
              <div>
                <label className="block text-sm text-[var(--color-text-secondary)] mb-1">
                  Target Altitude
                </label>
                <input
                  type="number"
                  value={altitudeGoal}
                  onChange={(e) => setAltitudeGoal(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
                  placeholder="200"
                />
                <p className="text-xs text-[var(--color-text-muted)] mt-1">Altitude in meters [m]</p>
              </div>
            </div>
          )}
          
          {/* Initial Conditions */}
          <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
            <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Initial Conditions</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-[var(--color-text-secondary)] mb-1">COPV Pressure</label>
                <input
                  type="number"
                  value={initialPcopv}
                  onChange={(e) => setInitialPcopv(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
                />
                <p className="text-xs text-[var(--color-text-muted)] mt-1">[psi]</p>
              </div>
              <div>
                <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Regulator Pressure</label>
                <input
                  type="number"
                  value={initialPreg}
                  onChange={(e) => setInitialPreg(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
                />
                <p className="text-xs text-[var(--color-text-muted)] mt-1">[psi]</p>
              </div>
              <div>
                <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Fuel Ullage Pressure</label>
                <input
                  type="number"
                  value={initialPufuel}
                  onChange={(e) => setInitialPufuel(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
                />
                <p className="text-xs text-[var(--color-text-muted)] mt-1">[psi]</p>
              </div>
              <div>
                <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Ox Ullage Pressure</label>
                <input
                  type="number"
                  value={initialPuox}
                  onChange={(e) => setInitialPuox(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
                />
                <p className="text-xs text-[var(--color-text-muted)] mt-1">[psi]</p>
              </div>
              <div>
                <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Initial Altitude</label>
                <input
                  type="number"
                  value={initialAltitude}
                  onChange={(e) => setInitialAltitude(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
                />
                <p className="text-xs text-[var(--color-text-muted)] mt-1">[m]</p>
              </div>
              <div>
                <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Initial Velocity</label>
                <input
                  type="number"
                  value={initialVelocity}
                  onChange={(e) => setInitialVelocity(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
                />
                <p className="text-xs text-[var(--color-text-muted)] mt-1">[m/s]</p>
              </div>
              <div>
                <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Vehicle Mass</label>
                <input
                  type="number"
                  value={vehicleMass}
                  onChange={(e) => setVehicleMass(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
                />
                <p className="text-xs text-[var(--color-text-muted)] mt-1">[kg]</p>
              </div>
            </div>
          </div>
          
          {/* Simulation Parameters */}
          <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
            <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Simulation Parameters</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Duration</label>
                <input
                  type="number"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
                />
                <p className="text-xs text-[var(--color-text-muted)] mt-1">[s]</p>
              </div>
              <div>
                <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Time Step</label>
                <input
                  type="number"
                  value={dt}
                  onChange={(e) => setDt(e.target.value)}
                  step="0.001"
                  className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)]"
                />
                <p className="text-xs text-[var(--color-text-muted)] mt-1">[s]</p>
              </div>
            </div>
          </div>
          
          {/* Run Buttons */}
          <div className="space-y-2">
            <button
              onClick={handleSimulate}
              disabled={isLoading || !config || !controllerInitialized}
              className="w-full px-6 py-3 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? 'Running Simulation...' : 'Run Controller Simulation'}
            </button>
            
            <label className="w-full px-6 py-3 bg-green-500 hover:bg-green-600 text-white font-semibold rounded-lg cursor-pointer transition-colors flex items-center justify-center gap-2">
              📁 Run from Layer 2 Config File
              <input
                type="file"
                accept=".yaml,.yml"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  
                  setIsLoading(true);
                  setError(null);
                  setResults(null);
                  setRealtimeData([]);
                  setSimulationProgress(0);
                  setSimulationStage('Loading config...');
                  
                  try {
                    const formData = new FormData();
                    formData.append('file', file);
                    formData.append('dt', dt);
                    
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
                          setIsLoading(false);
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
                                if (data.progress !== undefined) setSimulationProgress(data.progress);
                                if (data.stage) setSimulationStage(data.stage);
                              } else if (data.type === 'data') {
                                setRealtimeData(prev => [...prev, data]);
                              } else if (data.type === 'complete') {
                                setIsLoading(false);
                                setSimulationProgress(1.0);
                                setSimulationStage('Complete');
                                setRealtimeData(prev => {
                                  const finalResults: ControllerSimulateResponse = {
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
                                  };
                                  setResults(finalResults);
                                  return prev;
                                });
                              } else if (data.type === 'error') {
                                setError(data.error || 'Unknown error');
                                setIsLoading(false);
                              }
                            } catch (err) {
                              console.error('Error parsing SSE event:', err);
                            }
                          }
                        }
                        
                        readStream();
                      }).catch(err => {
                        setError(err instanceof Error ? err.message : 'Stream error');
                        setIsLoading(false);
                      });
                    };
                    
                    readStream();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to process config');
                    setIsLoading(false);
                  }
                }}
              />
            </label>
          </div>
          
          {/* Progress indicator for streaming */}
          {isLoading && simulationStage && (
            <div className="mt-2">
              <div className="flex justify-between text-xs text-[var(--color-text-secondary)] mb-1">
                <span>{simulationStage}</span>
                <span className="text-green-400 font-bold">{(simulationProgress * 100).toFixed(0)}%</span>
              </div>
              <div className="w-full bg-[var(--color-bg-primary)] rounded-full h-2">
                <div
                  className="bg-green-500 h-full rounded-full transition-all duration-300"
                  style={{ width: `${simulationProgress * 100}%` }}
                />
              </div>
            </div>
          )}
        </div>
        
        {/* Right Column: Results */}
        <div className="space-y-6">
          {(results || realtimeData.length > 0) && (
            <>
              {/* Thrust Tracking */}
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">
                  Thrust Tracking {isLoading && <span className="text-green-400 text-xs">(Live)</span>}
                </h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={(results ? results.time : realtimeData.map(d => d.time || 0)).map((t, i) => ({
                    time: t,
                    reference: results ? results.thrust_ref[i] : (realtimeData[i]?.thrust_ref || 0),
                    actual: results ? results.thrust_actual[i] : (realtimeData[i]?.thrust_actual || 0),
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" label={{ value: 'Time [s]', position: 'insideBottom', offset: -5 }} />
                    <YAxis label={{ value: 'Thrust [N]', angle: -90, position: 'insideLeft' }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="reference" stroke="#8884d8" name="Reference" strokeWidth={2} />
                    <Line type="monotone" dataKey="actual" stroke="#82ca9d" name="Actual" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              
              {/* Pressures */}
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">
                  Pressures {isLoading && <span className="text-green-400 text-xs">(Live)</span>}
                </h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={(results ? results.time : realtimeData.map(d => d.time || 0)).map((t, i) => ({
                    time: t,
                    P_copv: (results ? results.P_copv[i] : (realtimeData[i]?.P_copv || 0)) / 6894.76,
                    P_reg: (results ? results.P_reg[i] : (realtimeData[i]?.P_reg || 0)) / 6894.76,
                    P_u_fuel: (results ? results.P_u_fuel[i] : (realtimeData[i]?.P_u_fuel || 0)) / 6894.76,
                    P_u_ox: (results ? results.P_u_ox[i] : (realtimeData[i]?.P_u_ox || 0)) / 6894.76,
                    P_ch: (results ? results.P_ch[i] : (realtimeData[i]?.P_ch || 0)) / 6894.76,
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" label={{ value: 'Time [s]', position: 'insideBottom', offset: -5 }} />
                    <YAxis label={{ value: 'Pressure [psi]', angle: -90, position: 'insideLeft' }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="P_copv" stroke="#ff7300" name="COPV" strokeWidth={2} />
                    <Line type="monotone" dataKey="P_reg" stroke="#00ff00" name="Regulator" strokeWidth={2} />
                    <Line type="monotone" dataKey="P_u_fuel" stroke="#0088fe" name="Fuel Ullage" strokeWidth={2} />
                    <Line type="monotone" dataKey="P_u_ox" stroke="#00c49f" name="Ox Ullage" strokeWidth={2} />
                    <Line type="monotone" dataKey="P_ch" stroke="#ff0080" name="Chamber" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              
              {/* Actuation Commands */}
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">
                  Actuation Commands {isLoading && <span className="text-green-400 text-xs">(Live)</span>}
                </h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={(results ? results.time : realtimeData.map(d => d.time || 0)).map((t, i) => ({
                    time: t,
                    duty_F: (results ? results.duty_F[i] : (realtimeData[i]?.duty_F || 0)) * 100,
                    duty_O: (results ? results.duty_O[i] : (realtimeData[i]?.duty_O || 0)) * 100,
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" label={{ value: 'Time [s]', position: 'insideBottom', offset: -5 }} />
                    <YAxis label={{ value: 'Duty Cycle [%]', angle: -90, position: 'insideLeft' }} domain={[0, 100]} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="duty_F" stroke="#ff7300" name="Fuel Duty" strokeWidth={2} />
                    <Line type="monotone" dataKey="duty_O" stroke="#0088fe" name="Ox Duty" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              
              {/* Mixture Ratio */}
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">
                  Mixture Ratio {isLoading && <span className="text-green-400 text-xs">(Live)</span>}
                </h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={(results ? results.time : realtimeData.map(d => d.time || 0)).map((t, i) => ({
                    time: t,
                    MR: results ? results.MR[i] : (realtimeData[i]?.MR || 0),
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" label={{ value: 'Time [s]', position: 'insideBottom', offset: -5 }} />
                    <YAxis label={{ value: 'MR (O/F)', angle: -90, position: 'insideLeft' }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="MR" stroke="#8884d8" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              
              {/* Value Function (DDP Objective) */}
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">
                  Value Function (DDP Objective) {isLoading && <span className="text-green-400 text-xs">(Live)</span>}
                </h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={(results ? results.time : realtimeData.map(d => d.time || 0)).map((t, i) => ({
                    time: t,
                    value: results ? (results.value_function?.[i] || 0) : (realtimeData[i]?.value_function || 0),
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" label={{ value: 'Time [s]', position: 'insideBottom', offset: -5 }} />
                    <YAxis label={{ value: 'Cost', angle: -90, position: 'insideLeft' }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="value" stroke="#8884d8" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              
              {/* Control Effort */}
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">
                  Control Effort {isLoading && <span className="text-green-400 text-xs">(Live)</span>}
                </h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={(results ? results.time : realtimeData.map(d => d.time || 0)).map((t, i) => ({
                    time: t,
                    effort: results ? (results.control_effort?.[i] || 0) : (realtimeData[i]?.control_effort || 0),
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" label={{ value: 'Time [s]', position: 'insideBottom', offset: -5 }} />
                    <YAxis label={{ value: '||u - u_prev||', angle: -90, position: 'insideLeft' }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="effort" stroke="#ff7300" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              
              {/* Tank States (Ullage Volumes) */}
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">
                  Tank States (Ullage Volumes) {isLoading && <span className="text-green-400 text-xs">(Live)</span>}
                </h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={(results ? results.time : realtimeData.map(d => d.time || 0)).map((t, i) => ({
                    time: t,
                    V_u_fuel: results ? (results.V_u_fuel?.[i] || 0) : (realtimeData[i]?.V_u_fuel || 0),
                    V_u_ox: results ? (results.V_u_ox?.[i] || 0) : (realtimeData[i]?.V_u_ox || 0),
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" label={{ value: 'Time [s]', position: 'insideBottom', offset: -5 }} />
                    <YAxis label={{ value: 'Volume [m³]', angle: -90, position: 'insideLeft' }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="V_u_fuel" stroke="#ff7300" name="Fuel Ullage" strokeWidth={2} />
                    <Line type="monotone" dataKey="V_u_ox" stroke="#0088fe" name="Ox Ullage" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              
              {/* Mass Flow Rates */}
              <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Mass Flow Rates</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={(results ? results.time : realtimeData.map(d => d.time || 0)).map((t, i) => ({
                    time: t,
                    mdot_F: results ? (results.mdot_F?.[i] || 0) : (realtimeData[i]?.mdot_F || 0),
                    mdot_O: results ? (results.mdot_O?.[i] || 0) : (realtimeData[i]?.mdot_O || 0),
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" label={{ value: 'Time [s]', position: 'insideBottom', offset: -5 }} />
                    <YAxis label={{ value: 'Mass Flow [kg/s]', angle: -90, position: 'insideLeft' }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="mdot_F" stroke="#ff7300" name="Fuel" strokeWidth={2} />
                    <Line type="monotone" dataKey="mdot_O" stroke="#0088fe" name="Oxidizer" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              
              {/* Altitude/Velocity (if altitude mode) */}
              {commandMode === 'altitude_goal' && (
                <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                  <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Altitude & Velocity</h3>
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={(results ? results.time : realtimeData.map(d => d.time || 0)).map((t, i) => ({
                      time: t,
                      altitude: results ? results.altitude[i] : (realtimeData[i]?.altitude || 0),
                      velocity: results ? results.velocity[i] : (realtimeData[i]?.velocity || 0),
                    }))}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="time" label={{ value: 'Time [s]', position: 'insideBottom', offset: -5 }} />
                      <YAxis yAxisId="left" label={{ value: 'Altitude [m]', angle: -90, position: 'insideLeft' }} />
                      <YAxis yAxisId="right" orientation="right" label={{ value: 'Velocity [m/s]', angle: 90, position: 'insideRight' }} />
                      <Tooltip />
                      <Legend />
                      <Line yAxisId="left" type="monotone" dataKey="altitude" stroke="#8884d8" name="Altitude" strokeWidth={2} />
                      <Line yAxisId="right" type="monotone" dataKey="velocity" stroke="#82ca9d" name="Velocity" strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}
          
          {!results && !isLoading && (
            <div className="p-8 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-center">
              <p className="text-[var(--color-text-secondary)]">Run a simulation to see results</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

