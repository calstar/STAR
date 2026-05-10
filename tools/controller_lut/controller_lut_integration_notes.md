## Controller + LUT integration notes

This repository treats `engine_sim` as a read-only git submodule. The
controller LUT integration is therefore implemented **entirely outside** the
submodule, but designed so that both the Python controller backend and the
C++ FSW controller can consume the same LUT artifacts.

### Python engine_sim backend

For SITL and analysis runs where the Python `engine_sim` controller backend is
used, the intended integration pattern is:

- Generate a LUT with `generate_controller_lut.py` and store it under
  `output/lut/` with a descriptive name.
- In the FastAPI backend that constructs `RobustDDPController` instances,
  load the same LUT file via `EngineLUT` and pass a thin wrapper into the
  controller alongside the existing `EngineWrapper`. The wrapper should:
  - Accept `(P_u_fuel, P_u_ox)` and any other state variables used as LUT
    axes.
  - Query the LUT to obtain `F`, `MR`, `P_ch`, `mdot_F`, `mdot_O`, and
    stability-related metrics.
  - Fall back to `EngineWrapper.estimate_from_pressures` when the query is
    out of bounds or the LUT value is NaN.

This keeps the controller API unchanged while allowing its internal engine
estimates to come from either the LUT or the full physics model.

### C++ FSW controller

For the C++ `RobustDDPController` used in flight/hotfire:

- Use the same `.npz` files produced by `generate_controller_lut.py` (or a
  derived binary form) as the single source of truth for the LUT.
- Implement a small C++ helper library that:
  - Loads axis grids and data tensors from the LUT file at startup.
  - Exposes a function
    `evaluate_lut(const State& state, const Command& cmd) -> EngineEstimate`
    that mirrors the Python `EngineLUT.evaluate` API.
  - Uses the same multilinear interpolation scheme as `EngineLUT` so that
    Python and C++ behave identically.
- Inside the C++ controller, replace direct calls to the C++ engine wrapper
  with calls to this LUT helper, preserving the option to fall back to the
  physics model if the LUT is unavailable or out of bounds.

### Safety and validation

- LUTs should be generated with conservative axis ranges that fully cover the
  expected operating envelope of tank pressures and commanded thrust.
- During commissioning, run controller-in-the-loop simulations where the LUT
  and full physics backends are compared on identical trajectories to confirm
  that thrust, MR, and pressure predictions match within acceptable bounds.
- In all cases, retain the ability to disable LUT usage at runtime and revert
  to the baseline controller behavior if discrepancies are observed.
