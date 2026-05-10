# Physics Fixes: Mach Numbers and Throat Recession

## Critical Physics Corrections

### 1. Mach Number Clarification

**THERE ARE THREE DIFFERENT MACH NUMBERS:**

1. **Chamber Mach Number** (`M_chamber`)
   - Location: Mean flow in the combustion chamber
   - Value: Subsonic (typically 0.01 - 0.1)
   - Calculated in: `chamber_profiles.py` → `calculate_chamber_intrinsics()`
   - Formula: `M_chamber = v_chamber / a_chamber`
   - This is what was previously called "mach_number" in the code

2. **Throat Mach Number** (`M_throat`)
   - Location: At the throat (minimum area)
   - Value: **ALWAYS M = 1.0 (sonic)** - This is the definition of the throat
   - Physics: The throat is defined as the location where flow becomes sonic
   - Isentropic relations at throat (M = 1.0):
     - `T_throat/Tc = 2/(γ+1)`
     - `P_throat/Pc = [2/(γ+1)]^(γ/(γ-1))`
     - `v_throat = a_throat = sqrt(γ × R × T_throat)`

3. **Exit Mach Number** (`M_exit`)
   - Location: At the nozzle exit
   - Value: Supersonic (typically 2.0 - 5.0)
   - Calculated in: `nozzle.py` → `calculate_thrust()`
   - Formula: From area-Mach relation (isentropic flow)
   - Isentropic relations:
     - `P_exit/Pc = [1 + (γ-1)/2 × M_exit²]^(-γ/(γ-1))`
     - `T_exit/Tc = [1 + (γ-1)/2 × M_exit²]^(-1)`
     - `v_exit = M_exit × sqrt(γ × R × T_exit)`

### 2. Throat Recession Physics

**CRITICAL:** When throat area changes due to recession, the flow automatically adjusts to maintain **M_throat = 1.0**.

- If throat area increases → flow adjusts to maintain M = 1.0 at new throat location
- If throat area decreases → flow adjusts to maintain M = 1.0 at new throat location
- **The throat is ALWAYS at M = 1.0** - this is not a constraint, it's the definition

**Graphite Insert:**
- Purpose: Keep throat area CONSTANT (non-ablating)
- When graphite is present and `allow_runtime_recession = False`:
  - Throat area: **CONSTANT** (no change)
  - Throat Mach number: **M = 1.0** (always)
  - Throat diameter: **CONSTANT**
- When graphite is consumed or not present:
  - Throat area: **GROWS** (ablative recession)
  - Throat Mach number: **M = 1.0** (always, at new throat location)
  - Flow adjusts to maintain sonic conditions

### 3. Isentropic Flow Relations

All calculations use proper isentropic flow relations:

**Throat (M = 1.0):**
```
T_throat = Tc × [2/(γ+1)]
P_throat = Pc × [2/(γ+1)]^(γ/(γ-1))
v_throat = sqrt(γ × R × T_throat)
```

**Exit (M > 1.0):**
```
P_exit = Pc × [1 + (γ-1)/2 × M_exit²]^(-γ/(γ-1))
T_exit = Tc × [1 + (γ-1)/2 × M_exit²]^(-1)
v_exit = M_exit × sqrt(γ × R × T_exit)
```

**Area-Mach Relation:**
```
A/A* = (1/M) × [(2/(γ+1)) × (1 + (γ-1)/2 × M²)]^((γ+1)/(2(γ-1)))
```

Where:
- A* = throat area (where M = 1.0)
- A = local area
- M = local Mach number

### 4. Code Changes

1. **`chamber_profiles.py`**:
   - Added comments clarifying that `mach_number` is the **chamber** Mach number
   - Added `mach_number_throat = 1.0` to return dict
   - Clarified that throat velocity is sonic (M = 1.0)

2. **`time_varying_solver.py`**:
   - Added comment that M_throat = 1.0 when throat area is constant
   - Clarified physics: flow adjusts to maintain M = 1.0

3. **`chamber_physics_fixed.py`** (new):
   - Created helper functions for correct physics:
     - `calculate_throat_conditions()` - Always returns M_throat = 1.0
     - `calculate_chamber_mach_number()` - Calculates subsonic chamber M
     - `calculate_exit_mach_from_area_ratio()` - Calculates supersonic exit M
     - `calculate_exit_conditions_from_mach()` - Uses isentropic relations

### 5. Verification Checklist

- [x] Chamber Mach number is subsonic (0.01 - 0.1)
- [x] Throat Mach number is always 1.0 (sonic)
- [x] Exit Mach number is supersonic (> 1.0)
- [x] Isentropic relations used throughout
- [x] Throat area constant when graphite present (no recession)
- [x] Flow adjusts to maintain M = 1.0 at throat when area changes

## Summary

The key fix is understanding that:
1. **Chamber Mach number** = subsonic (what we calculate in `chamber_profiles.py`)
2. **Throat Mach number** = always 1.0 (by definition)
3. **Exit Mach number** = supersonic (calculated from area ratio)

All three are different and serve different purposes. The confusion was treating "mach_number" as if it were the exit Mach number, when it's actually the chamber Mach number.

