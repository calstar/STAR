import { useState, useEffect, useCallback, useRef } from 'react';
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
import { DemoLayerCard, type LayerStatus, type ObjectiveHistoryPoint } from './DemoLayerCard';
import {
  saveDesignRequirements,
  getDesignRequirements,
  runLayer1Optimization,
  runLayer2Optimization,
  runLayer3Optimization,
  runFlightSimulation,
  stopLayer1Optimization,
  stopLayer2Optimization,
  stopLayer3Optimization,
  getChamberGeometry,
  type DesignRequirements,
  type EngineConfig,
  type Layer1Results,
  type Layer1ProgressEvent,
  type Layer2Results,
  type Layer2ProgressEvent,
  type Layer3Results,
  type Layer3ProgressEvent,
  type FlightSimResponse,
  type ChamberGeometryResponse,
} from '../api/client';
import { ChamberContourPlot } from './ChamberContourPlot';

interface OptimizerDemoProps {
  config: EngineConfig | null;
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

// Helper component for validation cards
function ValidationCard({ label, passed }: { label: string; passed: boolean | undefined }) {
  const isPassed = passed === true;
  return (
    <div className={`rounded-lg p-3 border ${isPassed ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
      <p className="text-xs text-[var(--color-text-secondary)] mb-1">{label}</p>
      <p className={`text-lg font-bold ${isPassed ? 'text-green-400' : 'text-red-400'}`}>
        {isPassed ? 'PASS' : 'FAIL'}
      </p>
    </div>
  );
}

type DemoState = 
  | 'idle' 
  | 'running_layer1' 
  | 'waiting_layer1' 
  | 'running_layer2' 
  | 'waiting_layer2' 
  | 'running_layer3' 
  | 'waiting_layer3' 
  | 'running_layer4' 
  | 'complete';

// Session storage key for time-series results (needed for Layer 4)
const TIMESERIES_RESULTS_KEY = 'timeseries_results';

export function OptimizerDemo({ config }: OptimizerDemoProps) {
  // Demo state machine
  const [demoState, setDemoState] = useState<DemoState>('idle');
  
  // Requirements form
  const [requirements, setRequirements] = useState<DesignRequirements>({
    target_thrust: 7000.0,
    target_apogee: 3048.0,
    optimal_of_ratio: 2.3,
    target_burn_time: 10.0,
    max_lox_tank_pressure_psi: 700.0,
    max_fuel_tank_pressure_psi: 850.0,
    max_engine_length: 0.5,
    max_chamber_outer_diameter: 0.15,
    max_nozzle_exit_diameter: 0.101,
    min_Lstar: 0.95,
    max_Lstar: 1.27,
    min_stability_score: 0.75,
    require_stable_state: true,
    stability_margin_handicap: 0.0,
    min_stability_margin: 1.2,
    chugging_margin_min: 0.2,
    acoustic_margin_min: 0.1,
    feed_stability_min: 0.15,
    copv_free_volume_L: 4.5,
  });
  const [requirementsSaved, setRequirementsSaved] = useState(false);
  const [showRequirementsForm, setShowRequirementsForm] = useState(true);

  // Layer progress and results
  const [layer1Progress, setLayer1Progress] = useState(0);
  const [layer1Message, setLayer1Message] = useState('');
  const [layer1Results, setLayer1Results] = useState<Layer1Results | null>(null);
  const [layer1Error, setLayer1Error] = useState<string | null>(null);
  const [layer1ObjectiveHistory, setLayer1ObjectiveHistory] = useState<ObjectiveHistoryPoint[]>([]);
  const [chamberGeometry, setChamberGeometry] = useState<ChamberGeometryResponse | null>(null);

  const [layer2Progress, setLayer2Progress] = useState(0);
  const [layer2Message, setLayer2Message] = useState('');
  const [layer2Results, setLayer2Results] = useState<Layer2Results | null>(null);
  const [layer2Error, setLayer2Error] = useState<string | null>(null);
  const [layer2ObjectiveHistory, setLayer2ObjectiveHistory] = useState<ObjectiveHistoryPoint[]>([]);
  const [layer2PressureCurves, setLayer2PressureCurves] = useState<Array<{ time: number; lox: number; fuel: number }>>([]);

  const [layer3Progress, setLayer3Progress] = useState(0);
  const [layer3Message, setLayer3Message] = useState('');
  const [layer3Results, setLayer3Results] = useState<Layer3Results | null>(null);
  const [layer3Error, setLayer3Error] = useState<string | null>(null);
  const [layer3ObjectiveHistory, setLayer3ObjectiveHistory] = useState<ObjectiveHistoryPoint[]>([]);
  const [layer3PressureCurves, setLayer3PressureCurves] = useState<Array<{ time: number; lox: number; fuel: number }>>([]);

  const [layer4Progress, setLayer4Progress] = useState(0);
  const [layer4Results, setLayer4Results] = useState<FlightSimResponse | null>(null);
  const [layer4Error, setLayer4Error] = useState<string | null>(null);

  // Global error
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Event source refs for cleanup
  const eventSourceRef = useRef<EventSource | null>(null);

  // Load requirements on mount
  useEffect(() => {
    loadRequirements();
  }, []);

  // Auto-fill from config when available
  useEffect(() => {
    if (config?.design_requirements) {
      setRequirements(config.design_requirements as DesignRequirements);
    }
  }, [config]);

  const loadRequirements = async () => {
    const response = await getDesignRequirements();
    if (response.data?.requirements) {
      setRequirements(response.data.requirements);
      setRequirementsSaved(true);
    }
  };

  const updateField = (field: keyof DesignRequirements, value: number | boolean) => {
    setRequirements(prev => ({ ...prev, [field]: value }));
    setRequirementsSaved(false);
  };

  const handleSaveRequirements = async () => {
    const response = await saveDesignRequirements(requirements);
    if (response.error) {
      setGlobalError(response.error);
    } else {
      setRequirementsSaved(true);
      setGlobalError(null);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Get layer status based on demo state
  const getLayerStatus = (layerNum: number): LayerStatus => {
    const stateMap: Record<DemoState, Record<number, LayerStatus>> = {
      idle: { 1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending' },
      running_layer1: { 1: 'running', 2: 'pending', 3: 'pending', 4: 'pending' },
      waiting_layer1: { 1: layer1Error ? 'failed' : 'complete', 2: 'pending', 3: 'pending', 4: 'pending' },
      running_layer2: { 1: 'complete', 2: 'running', 3: 'pending', 4: 'pending' },
      waiting_layer2: { 1: 'complete', 2: layer2Error ? 'failed' : 'complete', 3: 'pending', 4: 'pending' },
      running_layer3: { 1: 'complete', 2: 'complete', 3: 'running', 4: 'pending' },
      waiting_layer3: { 1: 'complete', 2: 'complete', 3: layer3Error ? 'failed' : 'complete', 4: 'pending' },
      running_layer4: { 1: 'complete', 2: 'complete', 3: 'complete', 4: 'running' },
      complete: { 1: 'complete', 2: 'complete', 3: 'complete', 4: layer4Error ? 'failed' : 'complete' },
    };
    return stateMap[demoState]?.[layerNum] || 'pending';
  };

  // Calculate overall progress
  const getOverallProgress = (): number => {
    switch (demoState) {
      case 'idle': return 0;
      case 'running_layer1': return layer1Progress * 0.25;
      case 'waiting_layer1': return 25;
      case 'running_layer2': return 25 + layer2Progress * 0.25;
      case 'waiting_layer2': return 50;
      case 'running_layer3': return 50 + layer3Progress * 0.25;
      case 'waiting_layer3': return 75;
      case 'running_layer4': return 75 + layer4Progress * 0.25;
      case 'complete': return 100;
      default: return 0;
    }
  };

  // Start the optimizer (Layer 1)
  const handleStartOptimizer = async () => {
    // Save requirements first
    if (!requirementsSaved) {
      const response = await saveDesignRequirements(requirements);
      if (response.error) {
        setGlobalError(response.error);
        return;
      }
      setRequirementsSaved(true);
    }

    // Reset state
    setLayer1Results(null);
    setLayer1Error(null);
    setLayer1Progress(0);
    setLayer1ObjectiveHistory([]);
    setChamberGeometry(null);
    setLayer2Results(null);
    setLayer2Error(null);
    setLayer2Progress(0);
    setLayer2ObjectiveHistory([]);
    setLayer2PressureCurves([]);
    setLayer3Results(null);
    setLayer3Error(null);
    setLayer3Progress(0);
    setLayer3ObjectiveHistory([]);
    setLayer3PressureCurves([]);
    setLayer4Results(null);
    setLayer4Error(null);
    setLayer4Progress(0);
    setGlobalError(null);
    setShowRequirementsForm(false);

    // Start Layer 1
    setDemoState('running_layer1');
    
    const eventSource = runLayer1Optimization(
      { thrust_tolerance: 0.05, target_burn_time: requirements.target_burn_time },
      (event: Layer1ProgressEvent) => {
        if (event.type === 'progress' || event.type === 'status') {
          setLayer1Progress((event.progress || 0) * 100);
          setLayer1Message(event.message || event.stage || 'Optimizing...');
        } else if (event.type === 'objective') {
          // Handle real-time objective updates
          if (event.objective_history && Array.isArray(event.objective_history)) {
            setLayer1ObjectiveHistory(prev => [...prev, ...event.objective_history!]);
          }
        } else if (event.type === 'complete') {
          setLayer1Results(event.results || null);
          setLayer1Progress(100);
          // Update objective history from final results
          if (event.results?.objective_history) {
            setLayer1ObjectiveHistory(event.results.objective_history);
          }
          // Fetch chamber geometry for contour plot
          getChamberGeometry().then(response => {
            if (response.data) {
              setChamberGeometry(response.data);
            }
          });
          setDemoState('waiting_layer1');
        } else if (event.type === 'error') {
          setLayer1Error(event.error || 'Unknown error');
          setDemoState('waiting_layer1');
        }
      },
      (error: string) => {
        setLayer1Error(error);
        setDemoState('waiting_layer1');
      }
    );
    eventSourceRef.current = eventSource;
  };

  // Continue to Layer 2
  const handleContinueToLayer2 = useCallback(() => {
    setDemoState('running_layer2');
    setLayer2Progress(0);
    setLayer2ObjectiveHistory([]);
    setLayer2PressureCurves([]);
    
    const eventSource = runLayer2Optimization(
      { max_iterations: 20, save_plots: false, de_maxiter: 5, de_popsize: 3, pure_blowdown: false },
      (event: Layer2ProgressEvent) => {
        if (event.type === 'progress' || event.type === 'status') {
          setLayer2Progress((event.progress || 0) * 100);
          setLayer2Message(event.message || event.stage || 'Optimizing pressure curves...');
        } else if (event.type === 'objective') {
          if (event.objective_history && Array.isArray(event.objective_history)) {
            setLayer2ObjectiveHistory(prev => [...prev, ...event.objective_history!]);
          }
        } else if (event.type === 'pressure_curves') {
          // Update pressure curves in real-time
          if (event.time_array && event.lox_pressure && event.fuel_pressure) {
            const curves = event.time_array.map((t, i) => ({
              time: t,
              lox: (event.lox_pressure![i] || 0) / 6894.76, // Convert to PSI
              fuel: (event.fuel_pressure![i] || 0) / 6894.76,
            }));
            setLayer2PressureCurves(curves);
          }
        } else if (event.type === 'complete') {
          setLayer2Results(event.results || null);
          setLayer2Progress(100);
          
          // Update objective history from final results
          if (event.results?.objective_history) {
            setLayer2ObjectiveHistory(event.results.objective_history);
          }
          
          // Update pressure curves from final results
          if (event.results?.time_array && event.results?.lox_pressure && event.results?.fuel_pressure) {
            const curves = event.results.time_array.map((t, i) => ({
              time: t,
              lox: (event.results!.lox_pressure[i] || 0) / 6894.76,
              fuel: (event.results!.fuel_pressure[i] || 0) / 6894.76,
            }));
            setLayer2PressureCurves(curves);
          }
          
          // Store time-series data for Layer 4
          if (event.results) {
            const timeSeriesData = {
              time: event.results.time_array,
              thrust_kN: [],
              mdot_O_kg_s: [],
              mdot_F_kg_s: [],
              P_tank_O_psi: event.results.lox_pressure?.map(p => p / 6894.76) || [],
              P_tank_F_psi: event.results.fuel_pressure?.map(p => p / 6894.76) || [],
            };
            sessionStorage.setItem(TIMESERIES_RESULTS_KEY, JSON.stringify({
              data: timeSeriesData,
              timestamp: Date.now(),
            }));
          }
          
          setDemoState('waiting_layer2');
        } else if (event.type === 'error') {
          setLayer2Error(event.error || 'Unknown error');
          setDemoState('waiting_layer2');
        }
      },
      (error: string) => {
        setLayer2Error(error);
        setDemoState('waiting_layer2');
      }
    );
    eventSourceRef.current = eventSource;
  }, []);

  // Continue to Layer 3
  const handleContinueToLayer3 = useCallback(() => {
    setDemoState('running_layer3');
    setLayer3Progress(0);
    setLayer3ObjectiveHistory([]);
    setLayer3PressureCurves([]);
    
    const eventSource = runLayer3Optimization(
      { max_iterations: 20, save_plots: false, optimization_method: 'gradient' },
      (event: Layer3ProgressEvent) => {
        if (event.type === 'progress' || event.type === 'status') {
          setLayer3Progress((event.progress || 0) * 100);
          setLayer3Message(event.message || event.stage || 'Optimizing thermal protection...');
        } else if (event.type === 'objective') {
          if (event.objective_history && Array.isArray(event.objective_history)) {
            setLayer3ObjectiveHistory(prev => [...prev, ...event.objective_history!]);
          }
        } else if (event.type === 'pressure_curves') {
          if (event.time_array && event.lox_pressure && event.fuel_pressure) {
            const curves = event.time_array.map((t, i) => ({
              time: t,
              lox: (event.lox_pressure![i] || 0) / 6894.76,
              fuel: (event.fuel_pressure![i] || 0) / 6894.76,
            }));
            setLayer3PressureCurves(curves);
          }
        } else if (event.type === 'complete') {
          setLayer3Results(event.results || null);
          setLayer3Progress(100);
          
          // Update objective history from final results
          if (event.results?.objective_history) {
            setLayer3ObjectiveHistory(event.results.objective_history);
          }
          
          // Update pressure curves from final results
          if (event.results?.time_array && event.results?.lox_pressure && event.results?.fuel_pressure) {
            const curves = event.results.time_array.map((t, i) => ({
              time: t,
              lox: (event.results!.lox_pressure[i] || 0) / 6894.76,
              fuel: (event.results!.fuel_pressure[i] || 0) / 6894.76,
            }));
            setLayer3PressureCurves(curves);
          }
          
          setDemoState('waiting_layer3');
        } else if (event.type === 'error') {
          setLayer3Error(event.error || 'Unknown error');
          setDemoState('waiting_layer3');
        }
      },
      (error: string) => {
        setLayer3Error(error);
        setDemoState('waiting_layer3');
      }
    );
    eventSourceRef.current = eventSource;
  }, []);

  // Continue to Layer 4 (Flight Simulation)
  const handleContinueToLayer4 = useCallback(async () => {
    setDemoState('running_layer4');
    setLayer4Progress(50); // Show indeterminate progress
    setLayer4Error(null); // Clear previous errors
    
    try {
      // Debug: log available data
      console.log('Layer 2 results:', layer2Results);
      console.log('Layer 3 results:', layer3Results);
      
      // Get time-series data from Layer 3 results or Layer 2
      // The backend returns time in summary.thrust_curve_time or time_array
      const summary3 = layer3Results?.summary || {};
      const summary2 = layer2Results?.summary || {};
      const timeArray = summary3.thrust_curve_time || summary2.thrust_curve_time || 
                        layer3Results?.time_array || layer2Results?.time_array || [];
      
      // Get thrust array from summary (Layer 2/3 return thrust_curve_values in summary)
      const thrustArray = summary3.thrust_curve_values || summary2.thrust_curve_values || 
                          timeArray.map(() => requirements.target_thrust);
      
      // Calculate mass flow from thrust and Isp
      // F = mdot * Ve, Ve ~ Isp * g0
      const g0 = 9.81;
      const estimatedIsp = 250; // Conservative estimate
      const Ve = estimatedIsp * g0;
      
      const mdotOArray = timeArray.map((_, i) => {
        const thrust = thrustArray[i] || requirements.target_thrust;
        const totalMdot = thrust / Ve;
        const OF = requirements.optimal_of_ratio || 2.0;
        return totalMdot * OF / (1 + OF);
      });
      
      const mdotFArray = timeArray.map((_, i) => {
        const thrust = thrustArray[i] || requirements.target_thrust;
        const totalMdot = thrust / Ve;
        const OF = requirements.optimal_of_ratio || 2.0;
        return totalMdot / (1 + OF);
      });

      // Estimate propellant masses from burn time and mass flows
      const avgMdotO = mdotOArray.length > 0 ? mdotOArray.reduce((a, b) => a + b, 0) / mdotOArray.length : 1.5;
      const avgMdotF = mdotFArray.length > 0 ? mdotFArray.reduce((a, b) => a + b, 0) / mdotFArray.length : 0.75;
      const burnTime = requirements.target_burn_time || 10;
      
      console.log('Flight sim input:', { 
        timeArrayLength: timeArray.length, 
        thrustArrayLength: thrustArray.length,
        avgMdotO, avgMdotF, burnTime 
      });
      
      // Ensure we have valid arrays for the simulation
      const finalTimeArray = timeArray.length > 0 ? timeArray : Array.from({ length: 100 }, (_, i) => i * burnTime / 99);
      const finalThrustArray = thrustArray.length === finalTimeArray.length 
        ? thrustArray 
        : finalTimeArray.map(() => requirements.target_thrust);
      const finalMdotO = mdotOArray.length === finalTimeArray.length ? mdotOArray : finalTimeArray.map(() => avgMdotO);
      const finalMdotF = mdotFArray.length === finalTimeArray.length ? mdotFArray : finalTimeArray.map(() => avgMdotF);
      
      const response = await runFlightSimulation({
        time_array: finalTimeArray,
        thrust_array: finalThrustArray,
        mdot_O_array: finalMdotO,
        mdot_F_array: finalMdotF,
        lox_mass_kg: avgMdotO * burnTime * 1.1, // 10% margin
        fuel_mass_kg: avgMdotF * burnTime * 1.1,
        rocket: {
          airframe_mass: 50,
          engine_mass: 10,
          lox_tank_structure_mass: 3,
          fuel_tank_structure_mass: 2,
          radius: 0.1,
          rocket_length: 3.0,
          motor_position: 0.5,
          inertia: [10, 10, 0.5],
        },
      });

      if (response.error) {
        setLayer4Error(response.error);
      } else if (response.data) {
        // Check if the response itself contains an error
        if (response.data.error) {
          setLayer4Error(response.data.error);
        } else if (response.data.status === 'error') {
          setLayer4Error('Flight simulation failed - check backend logs');
        } else {
          setLayer4Results(response.data);
        }
      } else {
        setLayer4Error('No response from flight simulation');
      }
    } catch (err) {
      console.error('Layer 4 error:', err);
      setLayer4Error(err instanceof Error ? err.message : 'Flight simulation failed');
    }
    
    setLayer4Progress(100);
    setDemoState('complete');
  }, [layer2Results, layer3Results, requirements]);

  // Stop current layer
  const handleStop = async () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    
    if (demoState === 'running_layer1') {
      await stopLayer1Optimization();
      setDemoState('waiting_layer1');
    } else if (demoState === 'running_layer2') {
      await stopLayer2Optimization();
      setDemoState('waiting_layer2');
    } else if (demoState === 'running_layer3') {
      await stopLayer3Optimization();
      setDemoState('waiting_layer3');
    }
  };

  // Reset demo
  const handleReset = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    setDemoState('idle');
    setLayer1Results(null);
    setLayer1Error(null);
    setLayer1Progress(0);
    setLayer1ObjectiveHistory([]);
    setChamberGeometry(null);
    setLayer2Results(null);
    setLayer2Error(null);
    setLayer2Progress(0);
    setLayer2ObjectiveHistory([]);
    setLayer2PressureCurves([]);
    setLayer3Results(null);
    setLayer3Error(null);
    setLayer3Progress(0);
    setLayer3ObjectiveHistory([]);
    setLayer3PressureCurves([]);
    setLayer4Results(null);
    setLayer4Error(null);
    setLayer4Progress(0);
    setGlobalError(null);
    setShowRequirementsForm(true);
  };

  // Build metrics for each layer
  const getLayer1Metrics = () => {
    if (!layer1Results?.performance) return [];
    const perf = layer1Results.performance;
    return [
      { label: 'Thrust', value: (perf.F || 0) / 1000, unit: 'kN', color: 'purple' as const },
      { label: 'Chamber Pressure', value: (perf.Pc || 0) / 1e6, unit: 'MPa', color: 'blue' as const },
      { label: 'O/F Ratio', value: perf.MR || 0, color: 'cyan' as const },
      { label: 'Isp', value: perf.Isp || 0, unit: 's', color: 'green' as const },
      { label: 'LOX Pressure', value: perf.P_O_start_psi || 0, unit: 'psi', color: 'orange' as const },
      { label: 'Fuel Pressure', value: perf.P_F_start_psi || 0, unit: 'psi', color: 'yellow' as const },
      { label: 'Stability Score', value: perf.stability_results?.stability_score || 0, color: perf.stability_results?.is_stable ? 'green' as const : 'red' as const },
    ];
  };

  const getLayer2Metrics = () => {
    if (!layer2Results?.summary) return [];
    const summary = layer2Results.summary;
    // Calculate avg thrust from total impulse / burn time
    const avgThrust = summary.burn_time_s > 0 
      ? (summary.total_impulse_Ns || 0) / summary.burn_time_s / 1000 
      : 0;
    return [
      { label: 'Total Impulse', value: (summary.total_impulse_Ns || 0) / 1000, unit: 'kN-s', color: 'pink' as const },
      { label: 'Burn Time', value: summary.burn_time_s || 0, unit: 's', color: 'blue' as const },
      { label: 'Avg Thrust', value: avgThrust, unit: 'kN', color: 'purple' as const },
      { label: 'Avg O/F', value: summary.avg_of_ratio || 0, color: 'cyan' as const },
      { label: 'Min Stability', value: summary.min_stability_margin || 0, color: 'orange' as const },
    ];
  };

  const getLayer3Metrics = () => {
    if (!layer3Results?.summary) return [];
    const summary = layer3Results.summary;
    return [
      { label: 'Ablative Thickness', value: (summary.optimized_ablative_thickness || 0) * 1000, unit: 'mm', color: 'orange' as const },
      { label: 'Graphite Thickness', value: (summary.optimized_graphite_thickness || 0) * 1000, unit: 'mm', color: 'purple' as const },
      { label: 'Chamber Recession', value: (summary.max_recession_chamber || 0) * 1e6, unit: 'um', color: 'blue' as const },
      { label: 'Throat Recession', value: (summary.max_recession_throat || 0) * 1e6, unit: 'um', color: 'red' as const },
    ];
  };

  const getLayer4Metrics = () => {
    if (!layer4Results) return [];
    return [
      { label: 'Apogee', value: layer4Results.apogee_m || 0, unit: 'm', color: 'cyan' as const },
      { label: 'Target Apogee', value: requirements.target_apogee || 3048, unit: 'm', color: 'blue' as const },
      { label: 'Max Velocity', value: layer4Results.max_velocity_m_s || 0, unit: 'm/s', color: 'purple' as const },
      { label: 'Flight Time', value: layer4Results.flight_time_s || 0, unit: 's', color: 'green' as const },
    ];
  };

  const isRunning = demoState.startsWith('running');
  const overallProgress = getOverallProgress();

  return (
    <div className="space-y-6">
      {/* Header with overall progress */}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Optimizer Demo</h1>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Run all 4 optimization layers sequentially with real-time progress tracking
            </p>
          </div>
          {demoState !== 'idle' && (
            <button
              onClick={handleReset}
              className="px-4 py-2 text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors"
            >
              Reset
            </button>
          )}
        </div>

        {/* Progress bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[var(--color-text-secondary)]">Overall Progress</span>
            <span className="font-mono text-[var(--color-text-primary)]">{overallProgress.toFixed(0)}%</span>
          </div>
          <div className="h-3 bg-[var(--color-bg-tertiary)] rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-purple-500 via-pink-500 via-orange-500 to-cyan-500 transition-all duration-500"
              style={{ width: `${overallProgress}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-[var(--color-text-tertiary)]">
            <span>Layer 1</span>
            <span>Layer 2</span>
            <span>Layer 3</span>
            <span>Layer 4</span>
          </div>
        </div>
      </div>

      {/* Global Error */}
      {globalError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
          <p className="text-red-400 font-semibold">Error</p>
          <p className="text-red-400/80 text-sm mt-1">{globalError}</p>
        </div>
      )}

      {/* Design Requirements Form - collapsible */}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl overflow-hidden">
        <button
          onClick={() => setShowRequirementsForm(!showRequirementsForm)}
          className="w-full px-6 py-4 flex items-center justify-between hover:bg-[var(--color-bg-tertiary)] transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <div className="text-left">
              <h3 className="font-semibold text-[var(--color-text-primary)]">Design Requirements</h3>
              <p className="text-xs text-[var(--color-text-secondary)]">
                {requirementsSaved ? 'Saved' : 'Unsaved changes'} - {requirements.target_thrust} N, {requirements.target_burn_time}s burn
              </p>
            </div>
          </div>
          <svg
            className={`w-5 h-5 text-[var(--color-text-secondary)] transition-transform ${showRequirementsForm ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showRequirementsForm && (
          <div className="px-6 pb-6 border-t border-[var(--color-border)]">
            <div className="pt-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {/* Performance Targets */}
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Target Thrust [N]</label>
                <input
                  type="number"
                  value={requirements.target_thrust}
                  onChange={(e) => updateField('target_thrust', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm"
                  disabled={isRunning}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Target Apogee [m]</label>
                <input
                  type="number"
                  value={requirements.target_apogee || 3048}
                  onChange={(e) => updateField('target_apogee', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm"
                  disabled={isRunning}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">O/F Ratio</label>
                <input
                  type="number"
                  step="0.1"
                  value={requirements.optimal_of_ratio}
                  onChange={(e) => updateField('optimal_of_ratio', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm"
                  disabled={isRunning}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Burn Time [s]</label>
                <input
                  type="number"
                  value={requirements.target_burn_time}
                  onChange={(e) => updateField('target_burn_time', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm"
                  disabled={isRunning}
                />
              </div>
              {/* Tank Pressures */}
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Max LOX Pressure [psi]</label>
                <input
                  type="number"
                  value={requirements.max_lox_tank_pressure_psi}
                  onChange={(e) => updateField('max_lox_tank_pressure_psi', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm"
                  disabled={isRunning}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Max Fuel Pressure [psi]</label>
                <input
                  type="number"
                  value={requirements.max_fuel_tank_pressure_psi}
                  onChange={(e) => updateField('max_fuel_tank_pressure_psi', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm"
                  disabled={isRunning}
                />
              </div>
              {/* Stability */}
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Min Stability Score</label>
                <input
                  type="number"
                  step="0.05"
                  value={requirements.min_stability_score}
                  onChange={(e) => updateField('min_stability_score', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm"
                  disabled={isRunning}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">COPV Volume [L]</label>
                <input
                  type="number"
                  step="0.5"
                  value={requirements.copv_free_volume_L || 4.5}
                  onChange={(e) => updateField('copv_free_volume_L', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm"
                  disabled={isRunning}
                />
              </div>
            </div>
            
            {/* Save button */}
            <div className="mt-4 flex justify-end">
              <button
                onClick={handleSaveRequirements}
                disabled={requirementsSaved || isRunning}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
              >
                {requirementsSaved ? 'Saved' : 'Save Requirements'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Layer Cards */}
      <div className="space-y-4">
        <DemoLayerCard
          layerNumber={1}
          title="Static Optimization"
          description="Optimize engine geometry and initial tank pressures"
          status={getLayerStatus(1)}
          progress={layer1Progress}
          message={layer1Message}
          metrics={getLayer1Metrics()}
          validationPassed={layer1Results?.performance?.pressure_candidate_valid}
          defaultExpanded={demoState !== 'idle'}
          objectiveHistory={layer1ObjectiveHistory}
        >
          {layer1Error && (
            <div className="mt-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-sm text-red-400">{layer1Error}</p>
            </div>
          )}
          
          {/* Detailed Layer 1 Results */}
          {layer1Results?.performance && (
            <div className="mt-4 space-y-4">
              {/* Stability Analysis */}
              <div>
                <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-3">Stability Analysis</h4>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <ResultCard
                    label="Stability Score"
                    value={layer1Results.performance.stability_results?.stability_score}
                    decimals={2}
                    color={layer1Results.performance.stability_results?.stability_score && layer1Results.performance.stability_results.stability_score >= 0.75 ? 'green' : 'yellow'}
                  />
                  <ResultCard
                    label="Stability State"
                    value={layer1Results.performance.stability_results?.stability_state}
                    isText
                    color={layer1Results.performance.stability_results?.stability_state === 'stable' ? 'green' : 'yellow'}
                  />
                  <ResultCard
                    label="Chugging Margin"
                    value={layer1Results.performance.stability_results?.chugging_margin}
                    decimals={3}
                    color="purple"
                  />
                  <ResultCard
                    label="Acoustic Margin"
                    value={layer1Results.performance.stability_results?.acoustic_margin}
                    decimals={3}
                    color="blue"
                  />
                  <ResultCard
                    label="Feed Margin"
                    value={layer1Results.performance.stability_results?.feed_margin}
                    decimals={3}
                    color="cyan"
                  />
                </div>
              </div>

              {/* Validation Status */}
              <div>
                <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-3">Validation Status</h4>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <ValidationCard label="Thrust Check" passed={layer1Results.performance.thrust_check_passed} />
                  <ValidationCard label="O/F Check" passed={layer1Results.performance.of_check_passed} />
                  <ValidationCard label="Stability Check" passed={layer1Results.performance.stability_check_passed} />
                  <ValidationCard label="Geometry Check" passed={layer1Results.performance.geometry_check_passed} />
                  <ValidationCard label="Pressure Candidate" passed={layer1Results.performance.pressure_candidate_valid} />
                </div>
              </div>

              {/* Failure Reasons */}
              {layer1Results.performance.failure_reasons && layer1Results.performance.failure_reasons.length > 0 && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                  <p className="text-sm text-red-400 font-semibold mb-1">Failure Reasons:</p>
                  <ul className="text-sm text-red-400 list-disc list-inside">
                    {layer1Results.performance.failure_reasons.map((reason: string, i: number) => (
                      <li key={i}>{reason}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Chamber Contour Plot */}
              {chamberGeometry && chamberGeometry.chamber_contour_x && chamberGeometry.chamber_contour_x.length > 0 && (
                <div className="mt-4">
                  <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-3">Optimized Chamber Contour</h4>
                  <ChamberContourPlot
                    geometry={chamberGeometry}
                    title="Optimized Chamber Geometry"
                    showCfBadge={true}
                  />
                </div>
              )}
            </div>
          )}
        </DemoLayerCard>

        <DemoLayerCard
          layerNumber={2}
          title="Pressure Curve Optimization"
          description="Optimize time-varying pressure profiles for the full burn"
          status={getLayerStatus(2)}
          progress={layer2Progress}
          message={layer2Message}
          metrics={getLayer2Metrics()}
          validationPassed={layer2Results?.summary?.burn_candidate_valid}
          objectiveHistory={layer2ObjectiveHistory}
        >
          {layer2Error && (
            <div className="mt-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-sm text-red-400">{layer2Error}</p>
            </div>
          )}

          {/* Pressure Curves Chart */}
          {layer2PressureCurves.length > 0 && (
            <div className="mt-4">
              <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-3">
                Optimized Pressure Curves
              </h4>
              <div className="h-64 bg-[var(--color-bg-secondary)] rounded-lg p-3">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={layer2PressureCurves} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                    <XAxis 
                      dataKey="time" 
                      unit="s" 
                      stroke="var(--color-text-secondary)" 
                      tick={{ fontSize: 11 }} 
                    />
                    <YAxis 
                      stroke="var(--color-text-secondary)" 
                      tick={{ fontSize: 11 }} 
                      label={{ value: 'Pressure (PSI)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)', fontSize: 11 }} 
                    />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'var(--color-bg-primary)', 
                        border: '1px solid var(--color-border)', 
                        borderRadius: '8px',
                        fontSize: '12px'
                      }} 
                    />
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                    <Line type="monotone" dataKey="lox" name="LOX Pressure" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="fuel" name="Fuel Pressure" stroke="#ef4444" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Additional Layer 2 Results */}
          {layer2Results?.summary && (
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              <ResultCard
                label="Burn Time"
                value={layer2Results.summary.burn_time_s}
                unit="s"
                decimals={2}
                color="blue"
              />
              <ResultCard
                label="Total Impulse"
                value={(layer2Results.summary.total_impulse_Ns || 0) / 1000}
                unit="kN-s"
                decimals={1}
                color="pink"
              />
              <ResultCard
                label="Avg Thrust"
                value={layer2Results.summary.burn_time_s > 0 
                  ? (layer2Results.summary.total_impulse_Ns || 0) / layer2Results.summary.burn_time_s / 1000 
                  : 0}
                unit="kN"
                decimals={2}
                color="purple"
              />
              <ResultCard
                label="Burn Candidate"
                value={layer2Results.summary.burn_candidate_valid ? 'VALID' : 'INVALID'}
                isText
                color={layer2Results.summary.burn_candidate_valid ? 'green' : 'red'}
              />
            </div>
          )}
        </DemoLayerCard>

        <DemoLayerCard
          layerNumber={3}
          title="Thermal Protection"
          description="Optimize ablative liner and graphite insert thicknesses"
          status={getLayerStatus(3)}
          progress={layer3Progress}
          message={layer3Message}
          metrics={getLayer3Metrics()}
          validationPassed={layer3Results?.summary?.thermal_protection_valid}
          objectiveHistory={layer3ObjectiveHistory}
        >
          {layer3Error && (
            <div className="mt-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-sm text-red-400">{layer3Error}</p>
            </div>
          )}

          {/* Pressure Curves Chart */}
          {layer3PressureCurves.length > 0 && (
            <div className="mt-4">
              <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-3">
                Final Pressure Curves
              </h4>
              <div className="h-64 bg-[var(--color-bg-secondary)] rounded-lg p-3">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={layer3PressureCurves} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                    <XAxis dataKey="time" unit="s" stroke="var(--color-text-secondary)" tick={{ fontSize: 11 }} />
                    <YAxis stroke="var(--color-text-secondary)" tick={{ fontSize: 11 }} label={{ value: 'Pressure (PSI)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)', fontSize: 11 }} />
                    <Tooltip contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px', fontSize: '12px' }} />
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                    <Line type="monotone" dataKey="lox" name="LOX Pressure" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="fuel" name="Fuel Pressure" stroke="#ef4444" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Additional Layer 3 Results */}
          {layer3Results?.summary && (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <ResultCard
                  label="Total Impulse"
                  value={layer3Results.summary.total_impulse_Ns}
                  unit="N-s"
                  decimals={0}
                  color="blue"
                />
                <ResultCard
                  label="Burn Time"
                  value={layer3Results.summary.burn_time_s}
                  unit="s"
                  decimals={2}
                  color="cyan"
                />
                <ResultCard
                  label="Min Stability"
                  value={layer3Results.summary.min_stability_margin}
                  decimals={3}
                  color="purple"
                />
                <ResultCard
                  label="Thermal Protection"
                  value={layer3Results.summary.thermal_protection_valid ? 'VALID' : 'INVALID'}
                  isText
                  color={layer3Results.summary.thermal_protection_valid ? 'green' : 'red'}
                />
              </div>

              {/* Performance Charts */}
              {layer3Results.time_array && layer3Results.performance && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Thrust Curve */}
                  {Array.isArray(layer3Results.performance.F) && (
                    <div>
                      <h5 className="text-sm font-medium text-[var(--color-text-primary)] mb-2">Thrust Curve</h5>
                      <div className="h-48 bg-[var(--color-bg-secondary)] rounded-lg p-2">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart 
                            data={layer3Results.time_array.map((t, i) => ({ time: t, thrust: (layer3Results.performance.F as number[])[i] || 0 }))}
                            margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                          >
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                            <XAxis dataKey="time" unit="s" stroke="var(--color-text-secondary)" tick={{ fontSize: 10 }} />
                            <YAxis stroke="var(--color-text-secondary)" tick={{ fontSize: 10 }} />
                            <Tooltip contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px', fontSize: '11px' }} />
                            <Line type="monotone" dataKey="thrust" name="Thrust (N)" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}

                  {/* O/F Ratio */}
                  {Array.isArray(layer3Results.performance.MR) && (
                    <div>
                      <h5 className="text-sm font-medium text-[var(--color-text-primary)] mb-2">Mixture Ratio (O/F)</h5>
                      <div className="h-48 bg-[var(--color-bg-secondary)] rounded-lg p-2">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart 
                            data={layer3Results.time_array.map((t, i) => ({ time: t, mr: (layer3Results.performance.MR as number[])[i] || 0 }))}
                            margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                          >
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                            <XAxis dataKey="time" unit="s" stroke="var(--color-text-secondary)" tick={{ fontSize: 10 }} />
                            <YAxis stroke="var(--color-text-secondary)" tick={{ fontSize: 10 }} />
                            <Tooltip contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px', fontSize: '11px' }} />
                            <Line type="monotone" dataKey="mr" name="O/F Ratio" stroke="#eab308" strokeWidth={2} dot={false} isAnimationActive={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </DemoLayerCard>

        <DemoLayerCard
          layerNumber={4}
          title="Flight Simulation"
          description="Validate trajectory and apogee using RocketPy"
          status={getLayerStatus(4)}
          progress={layer4Progress}
          message="Running flight simulation..."
          metrics={getLayer4Metrics()}
          validationPassed={layer4Results ? Math.abs((layer4Results.apogee_m || 0) - (requirements.target_apogee || 3048)) / (requirements.target_apogee || 3048) < 0.15 : undefined}
        >
          {layer4Error && (
            <div className="mt-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-sm text-red-400">{layer4Error}</p>
            </div>
          )}

          {/* Flight Results */}
          {layer4Results && (
            <div className="mt-4 space-y-4">
              {/* Apogee comparison */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <ResultCard
                  label="Achieved Apogee"
                  value={layer4Results.apogee_m}
                  unit="m"
                  decimals={0}
                  color="cyan"
                />
                <ResultCard
                  label="Target Apogee"
                  value={requirements.target_apogee || 3048}
                  unit="m"
                  decimals={0}
                  color="blue"
                />
                <ResultCard
                  label="Apogee Error"
                  value={layer4Results.apogee_m && requirements.target_apogee 
                    ? Math.abs(layer4Results.apogee_m - requirements.target_apogee) / requirements.target_apogee * 100 
                    : undefined}
                  unit="%"
                  decimals={1}
                  color={layer4Results.apogee_m && requirements.target_apogee && 
                    Math.abs(layer4Results.apogee_m - requirements.target_apogee) / requirements.target_apogee < 0.15 
                    ? 'green' : 'orange'}
                />
                <ResultCard
                  label="Apogee (ft)"
                  value={layer4Results.apogee_ft}
                  unit="ft"
                  decimals={0}
                  color="purple"
                />
              </div>

              {/* Trajectory Charts */}
              {layer4Results.trajectory && layer4Results.trajectory.time && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Altitude Chart */}
                  <div>
                    <h5 className="text-sm font-medium text-[var(--color-text-primary)] mb-2">Altitude vs Time</h5>
                    <div className="h-56 bg-[var(--color-bg-secondary)] rounded-lg p-2">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={layer4Results.trajectory.time.map((t, i) => ({
                            time: t,
                            altitude: layer4Results.trajectory!.altitude[i] || 0,
                          }))}
                          margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                          <XAxis dataKey="time" unit="s" stroke="var(--color-text-secondary)" tick={{ fontSize: 10 }} />
                          <YAxis stroke="var(--color-text-secondary)" tick={{ fontSize: 10 }} />
                          <Tooltip contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px', fontSize: '11px' }} />
                          <ReferenceLine y={requirements.target_apogee || 3048} stroke="#3b82f6" strokeDasharray="5 5" />
                          <Line type="monotone" dataKey="altitude" name="Altitude (m)" stroke="#06b6d4" strokeWidth={2} dot={false} isAnimationActive={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Velocity Chart */}
                  <div>
                    <h5 className="text-sm font-medium text-[var(--color-text-primary)] mb-2">Velocity vs Time</h5>
                    <div className="h-56 bg-[var(--color-bg-secondary)] rounded-lg p-2">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={layer4Results.trajectory.time.map((t, i) => ({
                            time: t,
                            velocity: layer4Results.trajectory!.velocity[i] || 0,
                          }))}
                          margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
                          <XAxis dataKey="time" unit="s" stroke="var(--color-text-secondary)" tick={{ fontSize: 10 }} />
                          <YAxis stroke="var(--color-text-secondary)" tick={{ fontSize: 10 }} />
                          <Tooltip contentStyle={{ backgroundColor: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: '8px', fontSize: '11px' }} />
                          <Line type="monotone" dataKey="velocity" name="Velocity (m/s)" stroke="#a855f7" strokeWidth={2} dot={false} isAnimationActive={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              )}

              {/* Truncation warning */}
              {layer4Results.truncation?.truncated && (
                <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                  <p className="text-sm text-yellow-400">
                    Burn truncated due to {layer4Results.truncation.reason} at {layer4Results.truncation.cutoff_time?.toFixed(2)}s
                  </p>
                </div>
              )}
            </div>
          )}
        </DemoLayerCard>
      </div>

      {/* Action Buttons */}
      <div className="flex justify-center gap-4">
        {demoState === 'idle' && (
          <button
            onClick={handleStartOptimizer}
            disabled={!config}
            className="px-8 py-3 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-all shadow-lg hover:shadow-xl"
          >
            Run Optimizer
          </button>
        )}

        {isRunning && (
          <button
            onClick={handleStop}
            className="px-8 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-xl transition-colors"
          >
            Stop
          </button>
        )}

        {demoState === 'waiting_layer1' && !layer1Error && (
          <button
            onClick={handleContinueToLayer2}
            className="px-8 py-3 bg-gradient-to-r from-pink-600 to-orange-600 hover:from-pink-700 hover:to-orange-700 text-white font-semibold rounded-xl transition-all shadow-lg hover:shadow-xl"
          >
            Continue to Layer 2
          </button>
        )}

        {demoState === 'waiting_layer2' && !layer2Error && (
          <button
            onClick={handleContinueToLayer3}
            className="px-8 py-3 bg-gradient-to-r from-orange-600 to-yellow-600 hover:from-orange-700 hover:to-yellow-700 text-white font-semibold rounded-xl transition-all shadow-lg hover:shadow-xl"
          >
            Continue to Layer 3
          </button>
        )}

        {demoState === 'waiting_layer3' && !layer3Error && (
          <button
            onClick={handleContinueToLayer4}
            className="px-8 py-3 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700 text-white font-semibold rounded-xl transition-all shadow-lg hover:shadow-xl"
          >
            Continue to Layer 4
          </button>
        )}

        {demoState === 'complete' && (
          <div className="text-center">
            <p className="text-lg font-semibold text-green-400 mb-2">Optimization Complete!</p>
            <button
              onClick={handleReset}
              className="px-8 py-3 bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] font-semibold rounded-xl border border-[var(--color-border)] transition-colors"
            >
              Run Again
            </button>
          </div>
        )}
      </div>

      {/* No config warning */}
      {!config && demoState === 'idle' && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 text-center">
          <p className="text-yellow-400">
            Please load a configuration file first (from the Configuration tab) to run the optimizer demo.
          </p>
        </div>
      )}
    </div>
  );
}
