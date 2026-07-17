# Optimization Pipeline Status

Current state of the multi-layer engine optimization pipeline. See
`optimizer_readme.md` and `optimization_layers_readme.md` for structure, and the
main `README.md` for the architecture overview.

## Implemented

- **Chamber solve** — `engine/core/chamber_solver.py` solves chamber pressure as the
  root of `supply(Pc) − demand(Pc) = 0` (injector supply vs. combustion demand). Pc
  is always solved, never an input.
- **Native C kernel** — the chamber residual loop (impinging injector → CEA →
  advanced combustion efficiency → ablative cooling → Brent root-find) and the
  per-eval stability physics (chug Nyquist sweep + 1L/1T acoustic growth) run in C
  behind `ED_USE_NATIVE=1`, with automatic Python fallback. `runner.evaluate()` is
  ~88× faster end-to-end at ~5e-10 Pc parity. The backend enables it at startup; the
  nozzle/thrust step and Layer-1 batching still run in Python (see
  `engine/native/README.md`).
- **Layer 1 (static)** — `engine/optimizer/layers/layer1_static_optimization.py`.
  Parallel CMA-ES over geometry + initial pressures, ranking candidates by a
  feasibility-gated objective (thrust / O-F match, stability margins, injector ΔP).
  Supports both `pintle` (10-var) and `impinging` (13-var) design vectors.
- **Layer 2 (pressure curves)** — `layer2_pressure.py`. Optimizes the LOX/fuel
  tank-pressure decay curves over the burn for the time-varying solver, with the
  initial pressures fixed from Layer 1 (see `layer_requirements.md`).
- **Layer 3 (thermal protection)** — `layer3_thermal_protection.py`. Right-sizes
  ablative liner + graphite insert thickness against the recession seen over the burn.
- **Layer 4 (flight validation)** — `layer4_flight_simulation.py`. RocketPy
  trajectory simulation and optimal burn-time search for accepted candidates.

Orchestration: `run_full_engine_optimization_with_flight_sim()` in
`engine/optimizer/main_optimizer.py`.

## Known limitations / open work

- **Convergence under strict tolerances** — meeting the safety-critical thrust/O-F
  requirements simultaneously with stability margins can require loosening geometry
  bounds (L*, chamber OD) when Layer 1 stalls.
- **Native coverage** — pintle/coaxial injectors, film/regen-coupled cooling, and the
  nozzle/thrust step fall back to Python (correct, but no speedup). Porting the
  nozzle requires the shifting-equilibrium path (Stage 4).
- **Layers 2–4 cost** — the time-varying and flight stages are the expensive part of a
  full run; they execute only for candidates that pass Layer 1 static validation.
