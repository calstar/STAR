# Core Engine Changes

This document summarizes changes to core engine files (excluding optimizer refactor).

## Summary

Changes focus on:
- **Logging improvements**: Replaced `print()` statements with proper logging infrastructure
- **Error handling**: More graceful handling of edge cases (missing injection velocities, solver failures)
- **Solver robustness**: Efficiency clamping, feed loss margin adjustments
- **Code cleanup**: Better default values, cleaner logic flow

---

## Files Changed

### 1. `engine/core/chamber_geometry_solver.py`
**35 lines changed**

#### Changes:
- **Logging refactor**: Replaced all `print()` statements with proper logging using `logging.getLogger("evaluate")`
  - All verbose output now uses `logger.info()` or `logger.warning()`
  - Ensures logging can be controlled centrally and doesn't interfere with console output when not needed

#### Impact:
- Better integration with logging infrastructure
- More control over output verbosity
- Consistent logging behavior across the codebase

---

### 2. `engine/core/chamber_solver.py`
**31 lines changed**

#### Changes:

1. **Injection velocity handling**:
   - Changed from conditional extraction (`if "u_F" in diagnostics`) to always extracting with defaults
   - Now always provides `u_fuel` and `u_lox` with default value of `0.0` if missing
   - Added `spray_diagnostics` to `advanced_params` for exponential model

2. **Efficiency clamping**:
   - Added minimum efficiency floor of `0.1` (10%) to prevent solver extinction at low pressures
   - Prevents "Supply < Demand" condition that breaks solver bounds when efficiency approaches zero
   - Efficiency is now clamped to range `[0.1, 1.0]`

3. **Feed loss margin reduction**:
   - Reduced feed loss margin from `0.15` (15%) to `0.02` (2%)
   - Allows solver to find solutions with lower pressure drops
   - More conservative margin was too restrictive for valid solutions

#### Impact:
- More robust solver that handles edge cases better
- Prevents solver failures at low chamber pressures
- Allows optimization to explore wider design space

---

### 3. `engine/core/injectors/pintle.py`
**135 lines changed**

#### Changes:

1. **Default values for diagnostics**:
   - Changed all diagnostic dictionary defaults from `None` to sensible numeric defaults (`0.0`)
   - Added new diagnostic fields:
     - `u_O`, `u_F`: Injection velocities
     - `P_injector_O`, `P_injector_F`: Injector pressures
     - `delta_p_injector_O`, `delta_p_injector_F`: Injector pressure drops
     - `delta_p_feed_O`, `delta_p_feed_F`: Feed pressure drops
     - `Cd_O`, `Cd_F`: Discharge coefficients
     - Default turbulence intensity values (`0.05`)

use pintle_SMD function

2. **Simplified feed loss calculation loop**:
   - Removed redundant feed loss calculations outside the loop
   - Moved Cd calculations inside the feed iteration loop for better coupling
   - Cleaner logic flow: feed losses → injector pressures → pressure drops → velocities → Reynolds → Cd → mass flows
   - Removed conditional checks that were causing confusion

3. **Velocity calculation**:
   - Physical velocities (`u_O`, `u_F`) now calculated after feed iteration converges
   - Uses converged mass flows for accurate velocity computation
   - Eliminates redundant quick estimates

#### Impact:
- Cleaner, more maintainable code
- Better default values prevent `None` errors downstream
- More consistent injector diagnostics
- Improved coupling between feed losses and discharge coefficients

---

### 4. `engine/core/runner.py`
**90 lines changed**

#### Changes:

1. **New `silent` parameter**:
   - Added `silent` parameter to `evaluate()` and `_evaluate_internal()` methods
   - When `silent=True`, suppresses console output (prints) when debug is False
   - Useful for batch optimization runs where console noise is unwanted

2. **Logging infrastructure improvements**:
   - Added `logger.propagate = False` to prevent double logging to root logger
   - Better handler management (removes existing handlers before adding new ones)
   - Console handler only added if not silent
   - Set default logging level to `INFO` when not in debug mode

3. **Debug logging cleanup**:
   - Removed commented-out print statements
   - Converted remaining prints to logger calls
   - Added debug logging for runner initialization with key geometry parameters

4. **Error handling**:
   - Changed print statements in exception handlers to logger warnings
   - Traceback printing now conditional on `debug` flag

#### Impact:
- Better control over output verbosity
- Cleaner console output during optimization
- More consistent logging behavior
- Useful debug information during initialization

---

### 5. `engine/pipeline/cea_cache.py`
**105 lines changed**

#### Changes:

1. **Comprehensive logging refactor**:
   - Replaced all `print()` statements with `logging.getLogger("evaluate")` calls
   - All cache-related messages now use proper logging levels:
     - `logger.info()` for informational messages
     - `logger.warning()` for warnings
   - Affects:
     - Cache metadata validation messages
     - Cache building progress messages
     - Error messages during cache construction
     - Grid size mismatch warnings

2. **Safe print function update**:
   - Updated `safe_print()` to log messages instead of printing
   - Original print functionality commented out
   - Ensures Unicode-safe message handling through logging system

#### Impact:
- Consistent logging across CEA cache operations
- Better integration with logging infrastructure
- Easier to control cache-related output verbosity
- Prevents encoding issues on different platforms

---

### 6. `engine/pipeline/combustion_physics.py`
**34 lines changed**

#### Changes:

1. **Injection velocity error handling**:
   - Changed from raising `ValueError` exceptions to emitting warnings and using default values
   - Both `compute_combustion_state()` and `calculate_combustion_efficiency_advanced()` now:
     - Use `warnings.warn()` instead of raising exceptions
     - Default missing `u_fuel` or `u_lox` to `0.0`
     - Allow computation to proceed with degraded accuracy rather than crashing

2. **Code cleanup**:
   - Removed redundant type conversion (already handled in new default assignment)
   - Cleaner flow with immediate assignment instead of validation then conversion

#### Impact:
- More robust combustion calculations that don't crash on missing data
- Allows optimization to proceed even with incomplete diagnostics
- Better graceful degradation behavior
- Prevents hard failures that stop optimization loops

---

## Overall Themes

### Logging Standardization
All core engine files now use the centralized logging infrastructure (`logging.getLogger("evaluate")`), providing:
- Consistent output control
- Better integration with logging levels and handlers
- Easier debugging and monitoring
- Reduced console noise during batch operations

### Error Resilience
Multiple changes improve robustness:
- Graceful handling of missing injection velocities (warnings instead of crashes)
- Efficiency clamping prevents solver failures
- Better default values prevent `None` errors

### Solver Improvements
- Reduced feed loss margins allow more design space exploration
- Efficiency floor prevents numerical issues at low pressures
- Better coupling between feed losses and discharge coefficients

### Code Quality
- Cleaner logic flow in injector calculations
- Better separation of concerns
- More consistent default values
- Reduced redundancy

---

## Testing Recommendations

1. **Verify logging behavior**: Ensure log files are created correctly and console output is appropriate
2. **Test edge cases**: Low pressure scenarios, missing diagnostics, edge geometry configurations
3. **Confirm solver stability**: Test with wide parameter ranges to ensure efficiency clamping works
4. **Validate injector diagnostics**: Ensure all diagnostic fields are populated correctly
5. **Check silent mode**: Verify `silent=True` suppresses output appropriately during optimization

