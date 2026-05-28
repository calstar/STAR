/**
 * API client for communicating with the FastAPI backend.
 * 
 * The evaluate endpoint returns results in the same format as runner.evaluate() 
 * from the Python engine - keeping consistency with the Streamlit UI.
 */

export const API_BASE = '/api';

interface ApiResponse<T> {
  data?: T;
  error?: string;
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return { error: errorData.detail || `HTTP ${response.status}: ${response.statusText}` };
    }

    const data = await response.json();
    return { data };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}

// Config types
export interface EngineConfig {
  fluids: Record<string, unknown>;
  injector: Record<string, unknown>;
  feed_system: Record<string, unknown>;
  combustion: Record<string, unknown>;
  chamber: Record<string, unknown>;
  nozzle: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ConfigResponse {
  config: EngineConfig;
}

export interface UploadResponse {
  status: string;
  message: string;
  config: EngineConfig;
}

// Evaluation types - matches runner.evaluate() output from engine/core/runner.py
export interface EvaluateRequest {
  lox_pressure_psi: number;
  fuel_pressure_psi: number;
  use_cold_flow_cd?: boolean;  // When false, strips saved Cd fit and uses Re-based formula
}

// Runner results - same field names as runner.evaluate() returns
export interface RunnerResults {
  // Primary performance
  Pc: number;              // Chamber pressure [Pa]
  F: number;               // Thrust [N]
  Isp: number;             // Specific impulse [s]
  mdot_O: number;          // Oxidizer mass flow [kg/s]
  mdot_F: number;          // Fuel mass flow [kg/s]
  mdot_total: number;      // Total mass flow [kg/s]
  MR: number;              // Mixture ratio (O/F)

  // Nozzle performance
  v_exit: number;          // Exit velocity [m/s]
  M_exit: number;          // Exit Mach number
  P_exit: number;          // Exit pressure [Pa]
  P_throat: number;        // Throat pressure [Pa]

  // Temperatures
  Tc: number;              // Chamber temperature [K]
  T_throat: number;        // Throat temperature [K]
  T_exit: number;          // Exit temperature [K]

  // Thrust coefficients
  Cf: number;              // Thrust coefficient (actual)
  Cf_actual: number;       // Thrust coefficient (actual)
  Cf_ideal: number;        // Thrust coefficient (ideal)
  Cf_theoretical: number;  // Thrust coefficient (theoretical)

  // Characteristic velocity
  cstar_actual: number;    // Actual c* [m/s]
  cstar_ideal: number;     // Ideal c* [m/s]
  eta_cstar: number;       // c* efficiency

  // Thermodynamic properties
  gamma: number;           // Ratio of specific heats (chamber)
  gamma_exit: number;      // Ratio of specific heats (exit)
  R: number;               // Gas constant (chamber) [J/(kg·K)]
  R_exit: number;          // Gas constant (exit) [J/(kg·K)]

  // Geometry
  eps: number;             // Expansion ratio
  A_throat: number;        // Throat area [m²]
  A_exit: number;          // Exit area [m²]

  // Discharge coefficients
  Cd_O: number;            // Oxidizer discharge coefficient
  Cd_F: number;            // Fuel discharge coefficient

  // Chamber intrinsics
  chamber_intrinsics: {
    Lstar?: number;           // Characteristic length [m]
    residence_time?: number;  // Residence time [s]
    velocity_mean?: number;   // Mean velocity [m/s]
    velocity_throat?: number; // Throat velocity [m/s]
    mach_number?: number;     // Mach number in chamber
    mach_number_throat?: number; // Throat Mach number (always 1.0, sonic)
    reynolds_number?: number; // Reynolds number
    density?: number;         // Gas density [kg/m³]
    sound_speed?: number;     // Sound speed [m/s]
    is_choked?: boolean;      // Whether flow is choked (P_back/Pc <= critical ratio)
    critical_pressure_ratio?: number; // Critical P_back/Pc for choking
    actual_pressure_ratio?: number;   // Actual P_back/Pc ratio
  } | null;

  // Injector pressure diagnostics
  injector_pressure: {
    P_injector_O?: number;      // Injector pressure, oxidizer [Pa]
    P_injector_F?: number;      // Injector pressure, fuel [Pa]
    delta_p_injector_O?: number; // Injector pressure drop, oxidizer [Pa]
    delta_p_injector_F?: number; // Injector pressure drop, fuel [Pa]
    delta_p_feed_O?: number;     // Feed pressure drop, oxidizer [Pa]
    delta_p_feed_F?: number;     // Feed pressure drop, fuel [Pa]
  } | null;

  // Cooling results
  cooling: {
    regen?: {
      enabled: boolean;
      coolant_outlet_temperature?: number;
      heat_removed?: number;
      overall_heat_flux?: number;
      mdot_coolant?: number;
      wall_temperature_hot?: number;
      wall_temperature_coolant?: number;
    };
    film?: {
      enabled: boolean;
      mass_fraction?: number;
      effectiveness?: number;
      mdot_film?: number;
      heat_flux_factor?: number;
      blowing_ratio?: number;
    };
    ablative?: {
      enabled: boolean;
      recession_rate?: number;
      effective_heat_flux?: number;
      cooling_power?: number;
      heat_removed?: number;
      incident_heat_flux?: number;
      below_pyrolysis?: boolean;
    };
  } | null;

  // Stability analysis
  stability: {
    is_stable: boolean;
    stability_state: string;
    stability_score: number;
    chugging: {
      frequency?: number;
      stability_margin?: number;
      stability_index?: number;
      period?: number;
      tau_residence?: number;
      Lstar?: number;
    };
    acoustic: {
      stability_margin?: number;
      modes?: Record<string, number>;
      longitudinal_modes?: number[];
      transverse_modes?: number[];
      sound_speed?: number;
    };
    feed_system: {
      pogo_frequency?: number;
      surge_frequency?: number;
      water_hammer_margin?: number;
      stability_margin?: number;
      sound_speed?: number;
    };
    issues: string[];
    recommendations: string[];
  } | null;

  // Profiles (optional, for plotting)
  pressure_profile?: unknown;
  temperature_profile?: unknown;

  // Ambient conditions (computed from config elevation)
  P_ambient?: number;       // Ambient pressure used [Pa]
  elevation?: number;       // Elevation from config [m]

  // Full diagnostics
  diagnostics: Record<string, unknown>;
}

export interface EvaluateResponse {
  status: string;
  inputs: {
    lox_pressure_psi: number;
    fuel_pressure_psi: number;
    ambient_pressure_pa: number;  // Computed from elevation
    elevation_m: number;          // Elevation from config
  };
  results: RunnerResults;
}

// API functions
export async function uploadConfig(file: File): Promise<ApiResponse<UploadResponse>> {
  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch(`${API_BASE}/config/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return { error: errorData.detail || `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { data };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Upload failed' };
  }
}

export async function getConfig(): Promise<ApiResponse<ConfigResponse>> {
  return request<ConfigResponse>('/config');
}

export async function updateConfig(updates: Partial<EngineConfig>): Promise<ApiResponse<ConfigResponse>> {
  return request<ConfigResponse>('/config', {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export async function evaluate(params: EvaluateRequest): Promise<ApiResponse<EvaluateResponse>> {
  return request<EvaluateResponse>('/evaluate', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function getHealth(): Promise<ApiResponse<{ status: string; config_loaded: boolean }>> {
  return request('/health');
}


// ============================================================================
// Time-Series Types and API
// ============================================================================

export type ProfileType = 'linear' | 'exponential' | 'power';
export type SegmentType = 'blowdown' | 'linear';

// Profile parameters for simple generation
export interface ProfileParams {
  start_pressure_psi: number;
  end_pressure_psi: number;
  profile_type: ProfileType;
  decay_constant?: number;  // For exponential
  power?: number;           // For power
}

// Request for simple profile generation
export interface GenerateProfileRequest {
  duration_s: number;
  n_steps: number;
  lox_profile: ProfileParams;
  fuel_profile: ProfileParams;
  use_cold_flow_cd?: boolean;  // When false, strips saved Cd fit and uses Re-based formula
}

// Pressure segment for segment-based curve building
export interface PressureSegment {
  length_ratio: number;      // Fraction of total time (0-1)
  type: SegmentType;
  start_pressure_psi: number;
  end_pressure_psi: number;
  k: number;                 // Blowdown decay constant (0.1-3.0)
}

export interface SolenoidScheduleInterval {
  t_open: number;
  t_close: number;
}

// Request for segment-based generation
export interface SegmentsRequest {
  duration_s: number;
  n_points: number;
  lox_segments: PressureSegment[];
  fuel_segments: PressureSegment[];
  // Blowdown mode parameters
  blowdown_mode?: boolean;
  lox_initial_pressure_psi?: number;
  fuel_initial_pressure_psi?: number;
  // Water flow test parameters
  waterflow_mode?: boolean;
  // Initial propellant/water mass overrides (from tank fill visualizer UI)
  lox_initial_mass_kg?: number;
  fuel_initial_mass_kg?: number;
  // Optional pressurant solenoid schedules (blowdown mode only)
  lox_solenoid_schedule?: SolenoidScheduleInterval[];
  fuel_solenoid_schedule?: SolenoidScheduleInterval[];
  use_cold_flow_cd?: boolean;  // When false, strips saved Cd fit and uses Re-based formula
}

// Time-series data returned from the API
export interface TimeSeriesData {
  time: number[];
  P_tank_O_psi: number[];
  P_tank_F_psi: number[];
  Pc_psi: number[];
  thrust_kN: number[];
  Isp_s: number[];
  MR: number[];
  mdot_O_kg_s: number[];
  mdot_F_kg_s: number[];
  mdot_total_kg_s: number[];
  cstar_actual_m_s: number[];
  gamma: number[];
  /** Nozzle exit static pressure [psi] (combustion runs only; omitted for water-flow test) */
  P_exit_psi?: number[];
  // Tank fill levels (propellant mass remaining)
  lox_mass_remaining_kg?: number[];
  fuel_mass_remaining_kg?: number[];
  Cd_O?: number[];
  Cd_F?: number[];
  // Optional fields for additional plots
  delta_P_injector_O_psi?: number[];
  delta_P_injector_F_psi?: number[];
  Lstar_mm?: number[];
  recession_rate_ablative_um_s?: number[];
  recession_rate_graphite_thermal_um_s?: number[];
  recession_rate_graphite_oxidation_um_s?: number[];
  recession_cumulative_ablative_mm?: number[];
  recession_cumulative_graphite_thermal_mm?: number[];
  recession_cumulative_graphite_oxidation_mm?: number[];
  recession_cumulative_chamber_um?: number[];
  recession_cumulative_throat_um?: number[];
  V_chamber_m3?: number[];
  A_throat_m2?: number[];
  V_chamber_initial_m3?: number;
  A_throat_initial_m2?: number;
  // COPV pressure trace (single shared COPV for both tanks)
  copv_pressure_psi?: number[];
  // Correlation matrix data
  correlation_matrix?: number[][];
  correlation_labels?: string[];
  // Water flow test flag
  is_waterflow?: boolean;
  // Heat Flux Profiles (Regen Cooling)
  heat_flux_profiles_w_m2?: number[][];
  wall_temp_profiles_k?: number[][];
  axial_positions_m?: number[];
  // Heat Flux Profiles (Ablative Cooling)
  ablative_axial_positions_m?: number[];
  ablative_q_incident_profiles_w_m2?: number[][];
  ablative_q_conv_profiles_w_m2?: number[][];
  ablative_q_rad_profiles_w_m2?: number[][];
  ablative_q_net_profiles_w_m2?: number[][];
  ablative_throat_index?: number;
}

// Shutdown event reported when the engine terminates before the end of the scheduled burn
export interface ShutdownEvent {
  time_s: number;
  step_index: number;
  reason: 'supply_below_demand' | 'pressure_bounds_invalid' | string;
  details: {
    P_tank_O_Pa?: number;
    P_tank_F_Pa?: number;
    Pc_max_Pa?: number;
    Pc_min_Pa?: number;
    residual_min?: number;
    residual_max?: number;
  };
}

// Summary statistics
export interface TimeSeriesSummary {
  avg_thrust_kN: number;
  peak_thrust_kN: number;
  min_thrust_kN: number;
  avg_Pc_psi: number;
  peak_Pc_psi: number;
  avg_Isp_s: number;
  total_impulse_kNs: number;
  total_propellant_kg: number;
  burn_time_s: number;
  // COPV summary metrics
  copv_initial_pressure_psi?: number;
  copv_initial_mass_kg?: number;
  copv_min_margin_psi?: number;
  copv_volume_L?: number;
  /** Ambient/back pressure used for thrust [psi], for overlay on exit pressure plot */
  target_P_exit_psi?: number;
  // Present only when the engine shut down before the end of the scheduled burn
  shutdown_event?: ShutdownEvent | null;
  // Water flow test fields
  is_waterflow?: boolean;
  avg_mdot_lox_kg_s?: number;
  avg_mdot_fuel_kg_s?: number;
  avg_mdot_total_kg_s?: number;
  peak_mdot_lox_kg_s?: number;
  peak_mdot_fuel_kg_s?: number;
  total_lox_consumed_kg?: number;
  total_fuel_consumed_kg?: number;
  total_water_consumed_kg?: number;
  flow_duration_s?: number;
  Cd_used?: number;
}

// Response for generate endpoint
export interface GenerateProfileResponse {
  status: string;
  data: TimeSeriesData;
  summary: TimeSeriesSummary;
}

// Response for segments endpoint
export interface SegmentsResponse {
  status: string;
  data: TimeSeriesData;
  summary: TimeSeriesSummary;
  lox_curve_preview: number[];
  fuel_curve_preview: number[];
}

// Preview request for real-time curve visualization
export interface PreviewCurveRequest {
  n_points: number;
  segments: PressureSegment[];
}

// Preview response
export interface PreviewCurveResponse {
  curve_psi: number[];
  normalized_time: number[];
}

// Time-series API functions
export async function generateTimeseries(
  params: GenerateProfileRequest
): Promise<ApiResponse<GenerateProfileResponse>> {
  return request<GenerateProfileResponse>('/timeseries/generate', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function generateFromSegments(
  params: SegmentsRequest
): Promise<ApiResponse<SegmentsResponse>> {
  return request<SegmentsResponse>('/timeseries/from-segments', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function previewCurve(
  params: PreviewCurveRequest
): Promise<ApiResponse<PreviewCurveResponse>> {
  return request<PreviewCurveResponse>('/timeseries/preview-curve', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function uploadTimeseriesFromCSV(
  file: File
): Promise<ApiResponse<GenerateProfileResponse>> {
  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch(`${API_BASE}/timeseries/from-csv`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return { error: errorData.detail || `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { data };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'CSV upload failed' };
  }
}


// ============================================================================
// Flight Simulation Types and API
// ============================================================================

export interface FlightEnvironmentConfig {
  latitude: number;
  longitude: number;
  elevation: number;
  date: [number, number, number, number]; // [year, month, day, hour]
}

export interface FlightFinsConfig {
  no_fins: number;
  root_chord: number;
  tip_chord: number;
  fin_span: number;
  fin_position: number;
}

export interface FlightRocketConfig {
  airframe_mass: number;
  engine_mass: number;
  lox_tank_structure_mass: number;
  fuel_tank_structure_mass: number;
  radius: number;
  rocket_length: number;
  motor_position: number;
  inertia: [number, number, number]; // [Ixx, Iyy, Izz]
  fins?: FlightFinsConfig;
}

export interface FlightTankConfig {
  mass: number;
  height: number;
  radius: number;
  position: number;
}

export type FlightSourceType = 'timeseries';

export interface FlightSimRequest {
  // Time-series data (required)
  time_array: number[];
  thrust_array: number[];
  mdot_O_array: number[];
  mdot_F_array: number[];

  // Propellant configuration
  lox_mass_kg: number;
  fuel_mass_kg: number;

  // Tank geometry (optional)
  lox_tank?: FlightTankConfig;
  fuel_tank?: FlightTankConfig;

  // Environment configuration
  environment?: FlightEnvironmentConfig;

  // Rocket configuration
  rocket?: FlightRocketConfig;
}

export interface FlightTrajectory {
  time: number[];
  altitude: number[];
  velocity: number[];
}

export interface FlightTruncationInfo {
  truncated: boolean;
  cutoff_time?: number;
  reason?: string;
}

export interface FlightSimResponse {
  status: string;
  apogee_m: number;
  apogee_ft: number;
  max_velocity_m_s: number;
  flight_time_s: number;
  trajectory?: FlightTrajectory;
  truncation?: FlightTruncationInfo;
  thrust_curve?: {
    time: number[];
    thrust_N: number[];
  };
  rocket_diagram?: string;  // Base64-encoded PNG
  error?: string;
}

export interface RocketPyCheckResponse {
  available: boolean;
  message: string;
  install_hint?: string;
}

// Flight simulation API functions
export async function runFlightSimulation(
  params: FlightSimRequest
): Promise<ApiResponse<FlightSimResponse>> {
  return request<FlightSimResponse>('/flight/simulate', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function checkRocketPy(): Promise<ApiResponse<RocketPyCheckResponse>> {
  return request<RocketPyCheckResponse>('/flight/check');
}


// ============================================================================
// Chamber Geometry Types and API
// ============================================================================

export interface ChamberGeometryResponse {
  positions: number[];
  R_gas: number[];
  R_ablative_outer: number[];
  R_graphite_outer: number[];
  R_stainless: number[];
  throat_position: number;
  graphite_start: number;
  graphite_end: number;
  D_chamber: number;
  D_throat: number;
  D_exit: number;
  L_chamber: number;
  L_nozzle: number;
  expansion_ratio: number;
  ablative_enabled: boolean;
  graphite_enabled: boolean;
  // Rao bell nozzle contour
  nozzle_x: number[];
  nozzle_y: number[];
  nozzle_method: string;
  // Chamber contour from CEA solver
  chamber_contour_x: number[];
  chamber_contour_y: number[];
  // Solver results
  Cf: number | null;
  Cf_ideal: number | null;
  A_throat_solved: number | null;
  chamber_contour_method: string | null;  // "solved" or "cea_iterative"
  t_abl_opt_mm: number | null;
  t_gra_opt_mm: number | null;
}

export async function getChamberGeometry(): Promise<ApiResponse<ChamberGeometryResponse>> {
  return request<ChamberGeometryResponse>('/geometry');
}


// ============================================================================
// Optimizer Types and API
// ============================================================================

// Frozen parameters for Layer 1 optimization (user-friendly units)
export interface FrozenParameters {
  // Chamber geometry
  A_throat_mm2?: number;           // Throat area [mm²]
  Lstar_mm?: number;               // Characteristic length L* [mm]
  expansion_ratio?: number;        // Expansion ratio (A_exit/A_throat)
  D_chamber_outer_mm?: number;     // Chamber outer diameter [mm]

  // Injector geometry
  d_pintle_tip_mm?: number;        // Pintle tip diameter [mm]
  h_gap_mm?: number;               // Annular gap height [mm]
  n_orifices?: number;             // Number of LOX orifices
  d_orifice_mm?: number;           // LOX orifice diameter [mm]

  // Initial tank pressures
  P_O_start_psi?: number;          // Initial LOX tank pressure [psi]
  P_F_start_psi?: number;          // Initial fuel tank pressure [psi]
}

export interface DesignRequirements {
  // Performance targets
  target_thrust: number;
  target_apogee?: number;
  optimal_of_ratio: number;
  target_burn_time: number;

  // Tank pressures
  max_lox_tank_pressure_psi: number;
  max_fuel_tank_pressure_psi: number;
  max_P_tank_O?: number;
  max_P_tank_F?: number;

  // Geometry constraints
  max_engine_length: number;
  max_chamber_outer_diameter: number;
  max_nozzle_exit_diameter: number;

  // L* constraints
  min_Lstar: number;
  max_Lstar: number;

  // Stability requirements (new comprehensive analysis)
  min_stability_score: number;
  require_stable_state: boolean;
  stability_margin_handicap: number;

  // Stability requirements (legacy margins)
  min_stability_margin: number;
  chugging_margin_min: number;
  acoustic_margin_min: number;
  feed_stability_min: number;

  // Tank capacities
  lox_tank_capacity_kg?: number;
  fuel_tank_capacity_kg?: number;

  // COPV
  copv_free_volume_L?: number;
  copv_free_volume_m3?: number;

  // Frozen parameters (optional - for locking specific values during optimization)
  frozen_parameters?: FrozenParameters;
}

export interface DesignRequirementsResponse {
  requirements: DesignRequirements | null;
}

export interface SaveDesignRequirementsResponse {
  status: string;
  message: string;
  requirements: DesignRequirements;
}

export interface Layer1Settings {
  thrust_tolerance: number;
  target_burn_time?: number;
}

export interface Layer1StatusResponse {
  running: boolean;
  progress: number;
  stage: string;
  message: string;
  has_results: boolean;
  error: string | null;
}

export interface Layer1ProgressEvent {
  type: 'status' | 'progress' | 'objective' | 'complete' | 'error';
  progress?: number;
  stage?: string;
  message?: string;
  objective_history?: Array<{
    iteration: number;
    objective: number;
    best_objective: number;
  }>;
  total_count?: number;
  results?: Layer1Results;
  error?: string;
  traceback?: string;
}

export interface Layer1Results {
  performance: {
    // Core performance
    F?: number;           // Thrust [N]
    MR?: number;          // O/F ratio
    Isp?: number;         // Specific impulse [s]
    Pc?: number;          // Chamber pressure [Pa]
    P_exit?: number;      // Exit pressure [Pa]
    Cf?: number;          // Thrust coefficient
    Cf_actual?: number;   // Actual thrust coefficient
    eta_cstar?: number;   // c* efficiency
    mdot_total?: number;  // Total mass flow [kg/s]
    mdot_O?: number;      // Oxidizer mass flow [kg/s]
    mdot_F?: number;      // Fuel mass flow [kg/s]

    // Injector metrics
    effective_injector_area_ratio?: number;  // Effective injector area / throat area ratio

    // Tank pressures
    P_O_start_psi?: number;  // LOX tank pressure [psi]
    P_F_start_psi?: number;  // Fuel tank pressure [psi]

    // Stability
    stability_results?: {
      stability_score?: number;
      stability_state?: string;
      chugging_margin?: number;
      acoustic_margin?: number;
      feed_margin?: number;
      is_stable?: boolean;
    };

    // Validation
    thrust_check_passed?: boolean;
    of_check_passed?: boolean;
    stability_check_passed?: boolean;
    geometry_check_passed?: boolean;
    pressure_candidate_valid?: boolean;
    failure_reasons?: string[];

    // Additional fields
    chamber_intrinsics?: {
      is_choked?: boolean;
      critical_pressure_ratio?: number;
      actual_pressure_ratio?: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  validation: Record<string, unknown>;
  geometry: Record<string, unknown>;
  objective_history: Array<{
    iteration: number;
    objective: number;
    best_objective: number;
  }>;
  iteration_history?: Array<Record<string, unknown>>;
  config?: EngineConfig;
  config_yaml?: string;
}

export interface Layer1ResultsResponse {
  status: string;
  results: Layer1Results;
}

// Optimizer API functions
export async function saveDesignRequirements(
  requirements: DesignRequirements
): Promise<ApiResponse<SaveDesignRequirementsResponse>> {
  return request<SaveDesignRequirementsResponse>('/optimizer/design-requirements', {
    method: 'POST',
    body: JSON.stringify({ requirements }),
  });
}

export async function getDesignRequirements(): Promise<ApiResponse<DesignRequirementsResponse>> {
  return request<DesignRequirementsResponse>('/optimizer/design-requirements');
}

export async function getLayer1Status(): Promise<ApiResponse<Layer1StatusResponse>> {
  return request<Layer1StatusResponse>('/optimizer/layer1/status');
}

export async function getLayer1Results(): Promise<ApiResponse<Layer1ResultsResponse>> {
  return request<Layer1ResultsResponse>('/optimizer/layer1/results');
}

export async function stopLayer1Optimization(): Promise<ApiResponse<{ status: string; message: string }>> {
  return request<{ status: string; message: string }>('/optimizer/layer1/stop', {
    method: 'POST',
  });
}

/**
 * Run Layer 1 optimization with Server-Sent Events for real-time progress updates.
 * Returns an EventSource that emits progress events.
 */
export function runLayer1Optimization(
  settings: Layer1Settings,
  onProgress: (event: Layer1ProgressEvent) => void,
  onError: (error: string) => void
): EventSource {
  const params = new URLSearchParams({
    thrust_tolerance: settings.thrust_tolerance.toString(),
  });

  if (settings.target_burn_time) {
    params.append('target_burn_time', settings.target_burn_time.toString());
  }

  const url = `${API_BASE}/optimizer/layer1?${params.toString()}`;

  const eventSource = new EventSource(url);

  eventSource.onmessage = (event) => {
    try {
      const data: Layer1ProgressEvent = JSON.parse(event.data);
      onProgress(data);

      // Close connection on completion or error
      if (data.type === 'complete' || data.type === 'error') {
        eventSource.close();
      }
    } catch (err) {
      console.error('Error parsing SSE event:', err);
      onError(err instanceof Error ? err.message : 'Failed to parse progress event');
      eventSource.close();
    }
  };

  eventSource.onerror = (err) => {
    console.error('SSE connection error:', err);
    onError('Connection to server lost');
    eventSource.close();
  };

  return eventSource;
}
// ============================================================================
// Layer 2 Optimizer Types and API
// ============================================================================

export interface Layer2Settings {
  max_iterations: number;
  save_plots?: boolean;
  de_maxiter?: number;
  de_popsize?: number;
  de_n_time_points?: number;
  /** Pure blowdown: coupled tank physics + same post-blowdown engine evaluation as Time Series Analysis */
  pure_blowdown?: boolean;
  /** Skip the impulse-vs-required-impulse penalty in the objective */
  disable_impulse_requirement?: boolean;
}

export interface Layer2Results {
  performance: Record<string, any>;
  summary: Record<string, any>;
  objective_history: Array<{
    iteration: number;
    objective: number;
    best_objective: number;
  }>;
  time_array: number[];
  lox_pressure: number[];
  fuel_pressure: number[];
  config?: EngineConfig;
  config_yaml?: string;
}

export interface Layer2ProgressEvent {
  type: 'status' | 'progress' | 'objective' | 'pressure_curves' | 'complete' | 'error';
  progress?: number;
  stage?: string;
  message?: string;
  objective_history?: Array<{
    iteration: number;
    objective: number;
    best_objective: number;
  }>;
  total_count?: number;
  time_array?: number[];
  lox_pressure?: number[];
  fuel_pressure?: number[];
  copv_pressure?: number[];
  copv_time?: number[];
  results?: Layer2Results;
  error?: string;
  traceback?: string;
}


export interface Layer2StatusResponse {
  running: boolean;
  progress: number;
  stage: string;
  message: string;
  has_results: boolean;
  error: string | null;
}

export interface Layer2ResultsResponse {
  status: string;
  results: Layer2Results;
}

export async function getLayer2Status(): Promise<ApiResponse<Layer2StatusResponse>> {
  return request<Layer2StatusResponse>('/optimizer/layer2/status');
}

export async function getLayer2Results(): Promise<ApiResponse<Layer2ResultsResponse>> {
  return request<Layer2ResultsResponse>('/optimizer/layer2/results');
}

export async function stopLayer2Optimization(): Promise<ApiResponse<{ status: string; message: string }>> {
  return request<{ status: string; message: string }>('/optimizer/layer2/stop', {
    method: 'POST',
  });
}

export async function uploadLayer2Config(file: File): Promise<ApiResponse<UploadResponse>> {
  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch(`${API_BASE}/optimizer/layer2/upload-config`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return { error: errorData.detail || `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { data };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Upload failed' };
  }
}

/**
 * Run Layer 2 optimization with Server-Sent Events for real-time progress updates.
 */
export function runLayer2Optimization(
  settings: Layer2Settings,
  onProgress: (event: Layer2ProgressEvent) => void,
  onError: (error: string) => void
): EventSource {
  const params = new URLSearchParams({
    max_iterations: settings.max_iterations.toString(),
    save_plots: (settings.save_plots || false).toString(),
  });

  if (settings.de_maxiter !== undefined) {
    params.append('de_maxiter', settings.de_maxiter.toString());
  }
  if (settings.de_popsize !== undefined) {
    params.append('de_popsize', settings.de_popsize.toString());
  }
  if (settings.de_n_time_points !== undefined) {
    params.append('de_n_time_points', settings.de_n_time_points.toString());
  }
  if (settings.pure_blowdown) {
    params.append('pure_blowdown', 'true');
  }
  if (settings.disable_impulse_requirement) {
    params.append('disable_impulse_requirement', 'true');
  }

  const url = `${API_BASE}/optimizer/layer2?${params.toString()}`;

  const eventSource = new EventSource(url);

  eventSource.onmessage = (event) => {
    try {
      const data: Layer2ProgressEvent = JSON.parse(event.data);
      onProgress(data);

      if (data.type === 'complete' || data.type === 'error') {
        eventSource.close();
      }
    } catch (err) {
      console.error('Error parsing SSE event:', err);
      onError(err instanceof Error ? err.message : 'Failed to parse progress event');
      eventSource.close();
    }
  };

  eventSource.onerror = (err) => {
    console.error('SSE connection error:', err);
    onError('Connection to server lost');
    eventSource.close();
  };

  return eventSource;
}

// ============================================================================
// Controller API
// ============================================================================

export interface MeasurementRequest {
  P_copv: number;
  P_reg: number;
  P_u_fuel: number;
  P_u_ox: number;
  P_d_fuel: number;
  P_d_ox: number;
}

export interface NavStateRequest {
  h: number;
  vz: number;
  theta?: number;
  mass_estimate?: number;
}

export interface CommandRequest {
  command_type: 'thrust_desired' | 'altitude_goal';
  thrust_desired?: number;
  altitude_goal?: number;
}

export interface ControllerInitRequest {
  controller_config_path?: string;
}

export interface ControllerSimulateRequest {
  initial_meas: MeasurementRequest;
  initial_nav: NavStateRequest;
  cmd: CommandRequest;
  duration: number;
  dt?: number;
  thrust_curve?: number[];
  time_array?: number[];
  controller_config_path?: string;
}

export interface ControllerSimulateResponse {
  time: number[];
  thrust_ref: number[];
  thrust_actual: number[];
  MR: number[];
  P_copv: number[];
  P_reg: number[];
  P_u_fuel: number[];
  P_u_ox: number[];
  P_d_fuel: number[];
  P_d_ox: number[];
  P_ch: number[];
  duty_F: number[];
  duty_O: number[];
  altitude: number[];
  velocity: number[];
  value_function: number[];
  control_effort: number[];
  V_u_fuel: number[];
  V_u_ox: number[];
  mdot_F: number[];
  mdot_O: number[];
  w_bar: number[][];
  constraint_margins: Record<string, number>[];
}

export interface ControllerStatusResponse {
  initialized: boolean;
  tick?: number;
  state?: Record<string, any>;
}

export async function initController(
  requestData: ControllerInitRequest
): Promise<ApiResponse<{ status: string; config: any }>> {
  return request<{ status: string; config: any }>('/control/init', {
    method: 'POST',
    body: JSON.stringify(requestData),
  });
}

export async function simulateController(
  requestData: ControllerSimulateRequest
): Promise<ApiResponse<ControllerSimulateResponse>> {
  return request<ControllerSimulateResponse>('/control/simulate', {
    method: 'POST',
    body: JSON.stringify(requestData),
  });
}

export async function resetController(): Promise<ApiResponse<{ status: string }>> {
  return request<{ status: string }>('/control/reset', {
    method: 'POST',
  });
}

export async function getControllerStatus(): Promise<ApiResponse<ControllerStatusResponse>> {
  return request<ControllerStatusResponse>('/control/status');
}

// ============================================================================
// Layer 2 Controller Simulation Types and API
// ============================================================================

export interface Layer2ControllerSimulateRequest {
  thrust_curve_time: number[];
  thrust_curve_values: number[];
  dt?: number;
}

export interface Layer2ControllerSimulateResponse {
  time: number[];
  thrust_ref: number[];
  thrust_actual: number[];
  MR: number[];
  P_copv: number[];
  P_reg: number[];
  P_u_fuel: number[];
  P_u_ox: number[];
  P_d_fuel: number[];
  P_d_ox: number[];
  P_ch: number[];
  duty_F: number[];
  duty_O: number[];
  altitude: number[];
  velocity: number[];
  value_function: number[];
  control_effort: number[];
  V_u_fuel: number[];
  V_u_ox: number[];
  mdot_F: number[];
  mdot_O: number[];
  w_bar: number[][];
  constraint_margins: Record<string, number>[];
}

export interface ControllerStreamEvent {
  type: 'status' | 'progress' | 'data' | 'complete' | 'error';
  progress?: number;
  stage?: string;
  message?: string;
  error?: string;
  // Data fields (when type='data')
  time?: number;
  thrust_ref?: number;
  thrust_actual?: number;
  MR?: number;
  P_copv?: number;
  P_reg?: number;
  P_u_fuel?: number;
  P_u_ox?: number;
  P_d_fuel?: number;
  P_d_ox?: number;
  P_ch?: number;
  duty_F?: number;
  duty_O?: number;
  altitude?: number;
  velocity?: number;
  value_function?: number;
  control_effort?: number;
  V_u_fuel?: number;
  V_u_ox?: number;
  mdot_F?: number;
  mdot_O?: number;
  w_bar?: number[];
  constraint_margins?: Record<string, number>;
}

/**
 * Non-streaming controller simulation for Layer 2.
 */
export async function simulateLayer2Controller(
  requestData: Layer2ControllerSimulateRequest
): Promise<ApiResponse<Layer2ControllerSimulateResponse>> {
  return request<Layer2ControllerSimulateResponse>('/control/simulate-layer2', {
    method: 'POST',
    body: JSON.stringify(requestData),
  });
}

/**
 * Streaming controller simulation (SSE-like via fetch/ReadableStream) for Layer 2.
 */
export function simulateLayer2ControllerStream(
  requestData: Layer2ControllerSimulateRequest,
  onEvent: (event: ControllerStreamEvent) => void,
  onError?: (error: string) => void
): AbortController {
  const abortController = new AbortController();

  fetch(`${API_BASE}/control/simulate-layer2-stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestData),
    signal: abortController.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              onEvent(data);
            } catch (e) {
              console.error('Error parsing stream event:', e);
            }
          }
        }
      }
    })
    .catch((err) => {
      if (err.name === 'AbortError') return;
      console.error('Stream error:', err);
      if (onError) onError(err.message);
    });

  return abortController;
}

// ============================================================================
// Layer 3 Thermal Protection Optimizer Types and API
// ============================================================================

export interface Layer3Settings {
  max_iterations?: number;
  save_plots?: boolean;
  optimization_method?: 'gradient' | 'cma' | 'de';  // gradient is fastest (default)
}

export interface Layer3Results {
  performance: Record<string, any>;
  summary: {
    optimized_ablative_thickness?: number;  // meters
    optimized_graphite_thickness?: number;   // meters
    max_recession_chamber?: number;          // meters
    max_recession_throat?: number;           // meters
    thermal_protection_valid?: boolean;
    ablative_adequate?: boolean;
    graphite_adequate?: boolean;
    total_impulse_Ns?: number;
    burn_time_s?: number;
    min_stability_margin?: number;
    [key: string]: any;
  };
  objective_history: Array<{
    iteration: number;
    objective: number;
    best_objective: number;
  }>;
  time_array: number[];
  lox_pressure: number[];
  fuel_pressure: number[];
  config?: EngineConfig;
  config_yaml?: string;
}

export interface Layer3ProgressEvent {
  type: 'status' | 'progress' | 'objective' | 'pressure_curves' | 'complete' | 'error';
  progress?: number;
  stage?: string;
  message?: string;
  objective_history?: Array<{
    iteration: number;
    objective: number;
    best_objective: number;
  }>;
  total_count?: number;
  time_array?: number[];
  lox_pressure?: number[];
  fuel_pressure?: number[];
  copv_pressure?: number[];
  copv_time?: number[];
  results?: Layer3Results;
  stopped_by_user?: boolean;
  error?: string;
  traceback?: string;
}

export interface Layer3StatusResponse {
  running: boolean;
  progress: number;
  stage: string;
  message: string;
  has_results: boolean;
  error: string | null;
}

export interface Layer3ResultsResponse {
  status: string;
  results: Layer3Results;
}

export async function getLayer3Status(): Promise<ApiResponse<Layer3StatusResponse>> {
  return request<Layer3StatusResponse>('/optimizer/layer3/status');
}

export async function getLayer3Results(): Promise<ApiResponse<Layer3ResultsResponse>> {
  return request<Layer3ResultsResponse>('/optimizer/layer3/results');
}

export async function stopLayer3Optimization(): Promise<ApiResponse<{ status: string; message: string }>> {
  return request<{ status: string; message: string }>('/optimizer/layer3/stop', {
    method: 'POST',
  });
}

export async function uploadLayer3Config(file: File): Promise<ApiResponse<UploadResponse>> {
  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch(`${API_BASE}/optimizer/layer3/upload-config`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return { error: errorData.detail || `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { data };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Upload failed' };
  }
}

/**
 * Run Layer 3 thermal protection optimization with Server-Sent Events for real-time progress updates.
 */
export function runLayer3Optimization(
  settings: Layer3Settings,
  onProgress: (event: Layer3ProgressEvent) => void,
  onError: (error: string) => void
): EventSource {
  const params = new URLSearchParams({
    max_iterations: (settings.max_iterations || 20).toString(),
    save_plots: (settings.save_plots || false).toString(),
    optimization_method: settings.optimization_method || 'gradient',
  });

  const url = `${API_BASE}/optimizer/layer3?${params.toString()}`;

  const eventSource = new EventSource(url);

  eventSource.onmessage = (event) => {
    try {
      const data: Layer3ProgressEvent = JSON.parse(event.data);
      onProgress(data);

      if (data.type === 'complete' || data.type === 'error') {
        eventSource.close();
      }
    } catch (err) {
      console.error('Error parsing SSE event:', err);
      onError(err instanceof Error ? err.message : 'Failed to parse progress event');
      eventSource.close();
    }
  };

  eventSource.onerror = (err) => {
    console.error('SSE connection error:', err);
    onError('Connection to server lost');
    eventSource.close();
  };

  return eventSource;
}
