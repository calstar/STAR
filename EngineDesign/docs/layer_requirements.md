# Layer 1 → Layer 2 Requirements

## Required Outputs from Layer 1

### 1. **optimized_config** (PintleEngineConfig)
   - Complete engine configuration with optimized geometry:
     - **Chamber**: `A_throat`, `Lstar`, `volume`, `length`, `chamber_inner_diameter`
     - **Nozzle**: `A_throat`, `A_exit`, `expansion_ratio`
     - **Injector**: Pintle geometry (d_pintle_tip, h_gap, n_orifices, d_orifice)
     - **Combustion**: CEA config with expansion_ratio set
   - Used to create `PintleEngineRunner` for time-series evaluation
   - Note: Layer 2 disables ablative/graphite internally, but config should have them defined

### 2. **initial_lox_pressure_pa** (float)
   - Initial LOX tank pressure in Pascals [Pa]
   - Used as the fixed starting point for LOX pressure curve optimization
   - First point of `P_tank_O_array` is set to this value (line 408)
   - Passed to `segments_from_optimizer_vars_pressure()` as `initial_pressure_pa`

### 3. **initial_fuel_pressure_pa** (float)
   - Initial fuel tank pressure in Pascals [Pa]
   - Used as the fixed starting point for fuel pressure curve optimization
   - First point of `P_tank_F_array` is set to this value (line 409)
   - Passed to `segments_from_optimizer_vars_pressure()` as `initial_pressure_pa`

### 4. **peak_thrust** (float)
   - Target/achieved peak thrust in Newtons [N]
   - Used as reference for initial thrust (assumed to be achieved at initial pressures)
   - Note: Layer 2 does NOT optimize initial thrust - it assumes Layer 1 already achieved it
   - Used in fallback/default values and summary reporting

## Key Notes

- **Initial pressures are FIXED**: Layer 2 uses `initial_lox_pressure_pa` and `initial_fuel_pressure_pa` as the starting point and only optimizes the pressure decay curves after t=0
- **Initial thrust is ASSUMED**: The code comment states "Initial pressures are fixed from Layer 1 and assumed to produce peak_thrust" (line 433-434)
- **Geometry must be complete**: The `optimized_config` must have all geometry parameters set correctly for the runner to work
- **Thermal protection**: Config should have ablative/graphite defined (even if disabled), as Layer 2 will disable them internally

