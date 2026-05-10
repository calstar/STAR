import yaml
import numpy as np
from engine.pipeline.config_schemas import PintleEngineConfig
from engine.core.runner import PintleEngineRunner

config_yaml = """
ablative_cooling:
  ambient_temperature: 300.0
  blowing_coefficient: 0.5
  blowing_efficiency: 0.75
  blowing_min_reduction_factor: 0.1
  char_layer_conductivity: 0.2
  char_layer_thickness: 0.001
  coverage_fraction: 0.9
  enabled: true
  heat_of_ablation: 2500000.0
  initial_thickness: 0.008
  material_density: 1600.0
  nozzle_ablative: false
  pyrolysis_temperature: 950.0
  radiative_sink_fallback_temperature: 600.0
  radiative_sink_minimum_threshold: 400.0
  specific_heat: 1500.0
  surface_emissivity: 0.85
  surface_temperature_limit: 1200.0
  thermal_conductivity: 0.35
  throat_recession_multiplier: null
  track_geometry_evolution: true
  turbulence_exponent: 1.0
  turbulence_max_multiplier: 3.0
  turbulence_reference_intensity: 0.08
  turbulence_sensitivity: 1.5
  use_physics_based_blowing: true
chamber: null
chamber_geometry:
  A_exit: 0.00801184666481737
  A_throat: 0.0020871516214242044
  Cf: 1.5188161629552588
  Lstar: 1.1679230154197113
  chamber_diameter: 0.11313578262864687
  design_MR: 2.55
  design_pressure: 2413166.0
  design_thrust: 7000.0
  exit_diameter: 0.101
  expansion_ratio: 3.838651002915805
  length: 0.2720453721187396
  length_contraction: 0.0451
  length_cylindrical: 0.121
  nozzle_efficiency: 0.95
  volume: 0.0024376324153318964
combustion:
  cea:
    MR_range:
    - 1.0
    - 2.5
    Pc_range:
    - 1000000.0
    - 9000000.0
    cache_file: output/cache/cea_cache_LOX_Ethanol_3D.npz
    cea_parallel_workers: null
    eps_range:
    - 4.0
    - 15.0
    expansion_ratio: 3.838651002915805
    fuel_name: Ethanol
    n_points: 34
    ox_name: LOX
    use_parallel_cea_build: true
  efficiency:
    A0_ethanol: 50000000.0
    A0_hydrocarbon: 10000000.0
    A0_hydrogen: 1000000000.0
    C: 0.3
    Ea_ethanol: 140000.0
    Ea_hydrocarbon: 80000.0
    Ea_hydrogen: 40000.0
    K: 0.15
    Pc_gate: 1000000.0
    T_star_fuel_cap_K: 700.0
    cooling_efficiency_floor: 0.25
    mixture_efficiency_floor: 0.25
    model: exponential
    n_pre_ethanol: 0.25
    n_pre_hydrocarbon: 0.3
    n_pre_hydrogen: 0.2
    n_pressure: 0.8
    smd_penalty_exponent: null
    spray_penalty_factor: 0.8
    target_smd_microns: null
    target_turbulence_intensity: null
    tau_ref: 1.0e-05
    tau_ref_P: 4000000.0
    tau_ref_T: 3500.0
    turbulence_efficiency_floor: 0.3
    turbulence_penalty_exponent: null
    use_advanced_model: true
    use_cooling_coupling: true
    use_finite_rate_chemistry: true
    use_mixture_coupling: false
    use_shifting_equilibrium: true
    use_spray_correction: false
    use_turbulence_coupling: true
    we_penalty_exponent: null
    we_reference: null
    xstar_limit_mm: null
    xstar_penalty_exponent: null
design_requirements:
  acoustic_margin_min: 0.1
  chugging_margin_min: 0.2
  copv_free_volume_L: 4.5
  copv_free_volume_m3: null
  feed_stability_min: 0.15
  fuel_tank_capacity_kg: null
  lox_tank_capacity_kg: null
  max_Lstar: 1.5
  max_P_tank_F: null
  max_P_tank_O: null
  max_chamber_outer_diameter: 0.15
  max_engine_length: 0.5
  max_fuel_tank_pressure_psi: 800.0
  max_lox_tank_pressure_psi: 700.0
  max_nozzle_exit_diameter: 0.101
  min_Lstar: 0.95
  min_stability_margin: 1.2
  min_stability_score: 0.75
  optimal_of_ratio: 1.4
  require_stable_state: true
  stability_margin_handicap: 0.0
  target_apogee: 3048.0
  target_burn_time: 6.0
  target_thrust: 7000.0
discharge:
  fuel:
    Cd_inf: 0.65
    Cd_min: 0.2
    P_ref: 5000000.0
    T_ref: 300.0
    a_P: 0.0
    a_Re: 0.2
    a_T: 0.0
    use_pressure_correction: false
    use_temperature_correction: false
  oxidizer:
    Cd_inf: 0.4
    Cd_min: 0.15
    P_ref: 5000000.0
    T_ref: 90.0
    a_P: 0.0
    a_Re: 0.15
    a_T: 0.0
    use_pressure_correction: false
    use_temperature_correction: false
environment:
  date:
  - 2025
  - 12
  - 6
  - 18
  elevation: 626.67
  latitude: 35.34722
  longitude: -117.8099547
feed_system:
  fuel:
    A_hydraulic: 7.13e-05
    K0: 2.0
    K1: 0.0
    d_inlet: 0.009525
    phi_type: none
  oxidizer:
    A_hydraulic: 7.13e-05
    K0: 2.0
    K1: 0.0
    d_inlet: 0.009525
    phi_type: none
film_cooling:
  apply_to_fraction_of_length: 0.6
  blowing_exponent: 0.62
  cp_override: null
  decay_length: 0.05
  density_override: null
  effectiveness_ref: 0.45
  enabled: false
  injection_temperature: null
  mass_fraction: 0.05
  reference_blowing_ratio: 0.6
  reference_wall_temperature: 1100.0
  slot_height: 0.00035
  turbulence_exponent: 1.0
  turbulence_min_multiplier: 0.5
  turbulence_reference_intensity: 0.08
  turbulence_sensitivity: 1.0
fluids:
  fuel:
    boiling_point: 351.4
    density: 789.0
    latent_heat: 838000.0
    molecular_weight: 46.07
    name: Ethanol
    specific_heat: 2440.0
    surface_tension: 0.0223
    temperature: 293.0
    thermal_conductivity: 0.17
    vapor_pressure: 5800.0
    viscosity: 0.0012
  oxidizer:
    boiling_point: null
    density: 1140.0
    latent_heat: null
    molecular_weight: null
    name: LOX
    specific_heat: 2300.0
    surface_tension: 0.013
    temperature: 90.0
    thermal_conductivity: 0.15
    vapor_pressure: 101325.0
    viscosity: 0.00018
fuel_tank:
  fuel_tank_pos: 3.0
  initial_pressure_psi: 650.7097331886973
  mass: 7.0
  rp1_h: 0.609
  rp1_radius: 0.0762
  tank_volume_m3: 0.011109
graphite_insert:
  ablation_surface_temperature: null
  ablation_transition_width: 200.0
  activation_energy: 190000.0
  ambient_temperature: null
  char_layer_conductivity: 5.0
  char_layer_thickness: 0.0005
  coverage_fraction: 1.0
  emissivity: null
  enabled: true
  feedback_fraction_max: null
  feedback_fraction_min: null
  friction_coefficient_override: null
  heat_of_ablation: 15000000.0
  initial_thickness: 0.006
  material_density: 2260.0
  mixture_mw: null
  oxidation_enthalpy: null
  oxidation_pre_exponential: null
  oxidation_pressure_exponent: null
  oxidation_rate: 1.0e-06
  oxidation_reference_pressure: 21000.0
  oxidation_reference_temperature: 973.0
  oxidation_stoichiometry_ratio: null
  oxidation_temperature: 800.0
  oxygen_mass_fraction: null
  oxygen_mole_fraction: null
  recession_multiplier: null
  reference_diffusivity: null
  reference_diffusivity_pressure: 1000000.0
  reference_diffusivity_temperature: 1500.0
  simplified_graphite_oxidation: false
  sizing_only_mode: false
  specific_heat: 710.0
  surface_temperature_limit: 2500.0
  thermal_conductivity: 100.0
injector:
  geometry:
    fuel:
      A_entry: 0.00039766352715787256
      d_hydraulic: 0.0008415470670316337
      d_pintle_tip: 0.022501576128713043
      d_reservoir_inner: 0.023343123195744678
      h_gap: 0.00042077353351581686
    lox:
      A_entry: 4.573969014658098e-06
      d_hydraulic: 0.002413246408027166
      d_orifice: 0.002413246408027166
      n_orifices: 14
      theta_orifice: 90.0
  type: pintle
lox_tank:
  initial_pressure_psi: 583.4991635154511
  lox_h: 1.14
  lox_radius: 0.06985
  mass: 18.0
  ox_tank_pos: 0.8
  tank_volume_m3: 0.017474
nozzle: null
optimizer:
  mode: hybrid_cma_blocks
pressure_curves:
  fuel_segments: []
  lox_segments: []
  initial_fuel_pressure_pa: 4486487.440000103
  initial_lox_pressure_pa: 4023086.6926397914
  n_points: 200
  target_burn_time_s: 6.0
regen_cooling:
  enabled: false
  hot_gas_viscosity: 4.0e-05
  d_inlet: 0.01
  L_inlet: 0.1
  n_channels: 20
  channel_width: 0.005
  channel_height: 0.005
  channel_length: 0.3
  L_outlet: 0.1
rocket:
  airframe_mass: 78.72
  cm_wo_motor: 3.861725449
  copv_dry_mass: 2.969
  dry_mass: null
  engine_cm_offset: 0.15
  engine_mass: 8.0
  fins:
    fin_position: 1.054535
    fin_span: 0.20066
    no_fins: 4
    root_chord: 0.626872
    tip_chord: 0.20066
  fuel_tank_structure_mass: 3.0
  inertia:
  - 8.0
  - 8.0
  - 0.5
  lox_tank_structure_mass: 5.0
  mass: null
  motor: null
  motor_inertia: null
  motor_position: 0.0
  propulsion_cm_offset: 0.4
  propulsion_dry_mass: 21.0
  radius: 0.078359
  rocket_length: 7.5
  strakes:
    fin_position: 3.58
    fin_span: 0.152
    no_fins: 4
    root_chord: 0.305
    tip_chord: 0.152
solver:
  Pc_bounds:
  - 100000.0
  - 8000000.0
  closure:
    Cd_reduction_factor: 0.95
    max_iterations: 6
    tolerance: 0.0001
  max_iterations: 100
  method: brentq
  tolerance: 1.0e-06
spray:
  evaporation:
    K: 300000.0
    use_constraint: true
    x_star_limit: 0.05
  momentum_flux_ratio: true
  pintle:
    B: 2.0
    C: 15.0
    n: 0.5
    p: 0.2
  smd:
    C: 0.5
    m: 0.6
    model: lefebvre
    p: 0.0
  spray_angle:
    k: 0.5
    model: TMR
    n: 0.5
  turbulence_breakup_gain: 1.0
  turbulence_penetration_gain: 0.5
  use_turbulence_corrections: false
  weber:
    We_min: 15.0
stainless_steel_case: null
thrust:
  burn_time: 10.0
"""

def main():
    try:
        # Load config
        data = yaml.safe_load(config_yaml)
        config = PintleEngineConfig(**data)
        
        # Initialize runner
        runner = PintleEngineRunner(config)
        
        # Try to evaluate
        P_O_Pa = 4023086.69
        P_F_Pa = 4486487.44
        
        print("Starting evaluation...")
        result = runner.evaluate(P_O_Pa, P_F_Pa, debug=True)
        print("Success!")
        print(f"Thrust: {result.get('F')} N")
        
    except Exception as e:
        print(f"FAILED: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()
