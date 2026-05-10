## Full Engine Optimizer UI

The **Full Engine Optimizer UI** is an end‑to‑end design environment for a LOX/RP‑1 pintle engine.  
It couples injector sizing, chamber/nozzle geometry, stability analysis, thermal protection, and (optionally) flight performance checks into a single multi‑layer optimization pipeline.

This UI is implemented in `design_optimization_view.py` and built on:
- `PintleEngineConfig` / `config_minimal.yaml` (and optionally any exported `optimized_engine.yaml`) for configuration
- `PintleEngineRunner` for performance and stability evaluation
- The `pintle_pipeline` optimizers (`comprehensive_optimizer`, `coupled_optimizer`, `chamber_optimizer`, etc.)

---

## High‑Level Workflow

1. **Load a base engine config**
   - Start from `examples/pintle_engine/config_minimal.yaml` or any previously exported optimized configuration file.
   - The YAML is parsed and validated into a `PintleEngineConfig` (see `pintle_pipeline.config_schemas`).

2. **Specify design requirements / constraints in the UI**
   - **Targets**: design thrust, target burn time, optimal O/F ratio, optional Isp target.
   - **Tank limits**: max LOX and fuel tank pressures.
   - **Geometry limits**: max chamber OD, max nozzle exit diameter, max engine length, $L^*$ bounds.
   - **Stability requirements**: minimum combined stability margin and/or minimum stability score, option to handicap/relax requirements.
   - **Analysis options**: enable/disable time‑varying analysis, set optimization iterations and tolerances.

3. **Run the full engine optimizer**
   - The UI calls `_run_full_engine_optimization_with_flight_sim` which:
     - Builds a **multi‑objective optimizer** over geometry + pressure‑curve + thermal‑protection variables.
     - Evaluates designs through **three main optimization layers** (Layer 1: static, Layer 2: burn candidate, Layer 3: burn analysis), preceded by a coupled geometry pre-optimization (Layer 0).
     - Logs progress to a log file (default location: project root `full_engine_optimizer.log`) and surfaces it live in the UI.

4. **Inspect results in the UI**
   - Summary of optimized geometry and pintle parameters.
   - Static performance and stability metrics at t=0.
   - Time‑varying thrust, stability and recession plots (if enabled).
   - Optional flight performance summary.

5. **Export the optimized design**
   - The final `PintleEngineConfig` can be serialized to YAML (e.g., `optimized_engine.yaml`) and used as a new starting point for further refinement.

---

## Optimizer Structure and Layers

### Layer 0 – Coupled Geometry + Pintle Pre‑Optimization

Before the main iterative optimizer, `_run_full_engine_optimization` performs a **coupled pintle + chamber geometry optimization** (`CoupledPintleChamberOptimizer`):

- **Design requirements**
  - Target thrust and burn time.
  - Target O/F ratio.
  - Design tank pressures for LOX and fuel (usually max allowable).
  - Minimum stability margin target.

- **Key constraints**
  - Chamber $L^*$ range (`min_Lstar`, `max_Lstar`).
  - Chamber length and diameter limits (from max engine length and max chamber OD).
  - Nozzle expansion ratio bounds (derived from max exit diameter).
  - Pintle geometry ranges:
    - Pintle tip diameter
    - Gap height
    - Number of LOX orifices
    - LOX orifice diameter
    - LOX orifice angle (fixed to 90° in this phase).

- **Goals**
  - Find a **consistent pintle + chamber + nozzle set** that can hit thrust and O/F ratio targets within constraints.
  - Enforce basic stability and geometry sanity before launching the more expensive multi‑layer optimization.

This phase provides a good starting `PintleEngineConfig` and associated runner/diagnostics for the following layers.

---

### Layer 1 – Static Test Optimization (Geometry + Pressure Candidate)

Layer 1 is implemented inside the objective of `_run_full_engine_optimization_with_flight_sim`.  
It treats a vector of **optimizer variables** `x` as a candidate engine and pressure‑curve design:

- **Representative optimization variables** (conceptual groups)
  - **Chamber / nozzle geometry**
    - Throat area $A_\mathrm{throat}$
    - $L^*$ (chamber characteristic length)
    - Derived: chamber volume, chamber length, chamber diameter (bounded by `max_chamber_outer_diameter`), contraction ratio.
  - **Tank pressure curve parameters**
    - Maximum LOX and fuel tank pressures.
    - Segmented pressure‑curve controls for LOX and fuel:
      - Segment type: linear vs blowdown (`segments_from_optimizer_vars` / `optimizer_vars_from_segments`).
      - Segment durations (normalized to total burn time).
      - Start/end pressure ratios per segment.
      - Blowdown time constant ratios.
  - **Thermal protection seeds**
    - Initial guesses for ablative liner and graphite insert thickness (later refined in Layers 2–3).

- **Layer 1 evaluation**
  - Converts `x` → `PintleEngineConfig` and associated LOX/fuel pressure segments (`apply_x_to_config`).
  - Selects **initial tank pressures** from the first segment’s start values.
  - Runs a **static hot‑fire** at t=0 via `PintleEngineRunner.evaluate(P_O_initial, P_F_initial)`.

- **Static objectives / penalties**
  - **Thrust match** to `target_thrust`.
  - **Mixture ratio match** to `optimal_of_ratio`.
  - **Stability** (via `stability_results`):
    - Combined stability state (`stable` / `marginal` / `unstable`) with a stability score in $[0, 1]$.
    - Individual margins: chugging, acoustic, feed‑system.
    - Penalties increase sharply for unstable or marginal designs and when margins fall below required thresholds.
  - **Isp quality** (bonus for higher Isp; penalty if substantially below 200 s).
  - **Soft bounds** on variables to back up the hard L-BFGS-B bounds.

The **Layer 1 objective** is a weighted sum of these errors and penalties, heavily biased toward stability and thrust/O/F ratio accuracy.  
Only candidates that pass these static checks move on to Layer 2.

---

### Layer 2 – Time‑Series Burn Candidate (Initial Thermal Protection Tuning)

Layer 2 lives in the “LAYER 2: TIME SERIES ANALYSIS (BURN CANDIDATE)” block.

- **When it runs**
  - Time‑varying analysis is enabled (`use_time_varying`).
  - The Layer 1 candidate is considered valid (passes basic static stability and performance checks).

- **Optimization variables**
  - A short vector of **initial thermal protection guesses**:
    - Ablative liner initial thickness (if `ablative_cooling.enabled`).
    - Graphite insert initial thickness (if `graphite_insert.enabled`).
  - Each has simple bounds, e.g., 3–20 mm for ablative, 3–15 mm for graphite.

- **Objective**
  - Deep‑copies the current `optimized_config`, applies the trial thicknesses, and runs:
    - `PintleEngineRunner.evaluate_arrays_with_time(...)` over the burn using the LOX/Fuel pressure curves.
  - Computes:
    - Max chamber and throat recession over time.
    - Min stability score over the burn (or mapped from chugging margin if needed).
    - Thrust history vs `target_thrust`.
  - The Layer 2 objective **minimizes recession** and **enforces thrust/stability requirements over the time series**, penalizing:
    - Large recession.
    - Large thrust error over the burn.
    - Low stability scores.

Layer 2 therefore turns a good **static candidate** into a good **burn candidate**, with realistic initial guesses for the thermal protection system.

---

### Layer 3 – Burn Analysis & Thermal Protection Optimization

Layer 3 is described in the “LAYER 3: BURN ANALYSIS (ABLATIVE/GRAPHITE OPTIMIZATION)” section.

- **Inputs**
  - The Layer 2‑validated pressure curves and geometry.
  - Full time‑varying histories from the prior run (recession vs time, stability vs time, thrust vs time).

- **Targets and bounds**
  - For each enabled thermal protection element (ablative liner, graphite insert):
    - Compute the **maximum recession** seen in the Layer 2 burn.
    - Set a target thickness ≈ 1.2 × max recession (20% margin).
    - Define bounds around this target (roughly 0.8–1.5× the target, clamped to practical limits).

- **Optimization variables**
  - A small vector of **final thicknesses** for ablative and graphite.

- **Objective**
  - Reruns `PintleEngineRunner.evaluate_arrays_with_time(...)` for each thickness vector.
  - Penalizes designs where **recession exceeds ~80% of the corresponding thickness**.
  - Minimizes the **total thermal‑protection thickness (as a proxy for mass)** plus any recession penalties.

The result is a set of **right‑sized thermal protection thicknesses** that are just thick enough (with built‑in margin) while avoiding unnecessary mass.

After Layer 3, the code reruns a final burn to verify that recession, thrust, and stability meet requirements with the optimized protection system.

---

## Optimization Variables – Conceptual Overview

Across the full pipeline, the optimizer manipulates several groups of variables (some in the coupled pintle–chamber stage, some in Layers 1–3):

- **Chamber / nozzle geometry**
  - Throat area $A_\mathrm{throat}$, nozzle exit area / expansion ratio.
  - $L^*$ and derived chamber volume, length, and diameter (within hardware envelopes).
  - Contraction geometry via the chamber geometry utilities in `chamber/chamber_geometry.py`.

- **Injector geometry (pintle)**
  - Pintle tip diameter and fuel gap height.
  - Fuel reservoir inner diameter.
  - LOX orifice count, diameter, and (fixed) injection angle.
  - Validated against the ranges in `_run_full_engine_optimization` constraints.

- **Feed system / tank pressure curves**
  - Max allowable LOX and fuel tank pressures.
  - Detailed segmented LOX/Fuel pressure curves:
    - Segment type: linear vs blowdown.
    - Per‑segment duration fractions.
    - Start/end pressure ratios.
    - Blowdown time‑constant ratios.
  - Converted between segment lists and flat optimizer vectors via:
    - `segments_from_optimizer_vars`
    - `optimizer_vars_from_segments`

- **Thermal protection**
  - Ablative liner thickness (chamber).
  - Graphite insert thickness (throat/nozzle).
  - Both appear as coarse seeds in Layer 1 / Layer 2 and are refined in Layer 3.

The UI surfaces the **resulting values** (not the raw optimizer vector) in human units: mm for geometry, bar/psi/MPa for pressures, etc.

---

## Goals and Evaluation Metrics

The full engine optimizer balances several goals simultaneously:

- **Performance**
  - Match `target_thrust` at t=0 and across the burn (static and time‑averaged thrust).
  - Hit a target O/F ratio (`optimal_of_ratio`) and, optionally, maximize Isp.

- **Stability**
  - Achieve a “stable” stability state and a stability score above a user‑set threshold.
  - Enforce minimum chugging, acoustic, and feed‑system stability margins.
  - Penalize marginal or unstable designs very strongly so they are rejected early.

- **Hardware / geometry**
  - Respect bounds on chamber OD, nozzle exit diameter, engine length, and $L^*$.
  - Keep pintle geometry within manufacturable and physically reasonable ranges.

- **Thermal survivability**
  - Limit chamber and throat recession under the time‑varying burn.
  - Right‑size ablative and graphite thicknesses to carry recession with margin while minimizing added mass.

- **System / flight**
  - Use tank‑pressure profiles consistent with the COPV constraints.
  - Optionally run a flight simulation (`_run_flight_simulation`) for good candidates to check trajectory-level performance.

All of these are folded into the **multi‑objective cost function** with carefully tuned weights and penalties, so that only designs that satisfy performance, stability, geometry, and thermal constraints can be accepted.

---

## Using the UI in Practice

- **Start simple**
  - Load `config_minimal.yaml`.
  - Set realistic thrust, burn time, and tank pressure limits.
  - Start with moderate stability requirements and enable time‑varying analysis once basic designs converge.

- **Watch the layers**
  - In the UI, track which layer the optimizer is currently working on (messages and progress bar).
  - If optimization stalls in Layer 1, loosen constraints (e.g., $L^*$ range or chamber OD) or adjust tank limits.
  - If failures occur in Layers 2–3, inspect recession and stability plots and adjust thermal‑protection settings/requirements.

- **Export and iterate**
  - Once satisfied, export the optimized YAML and use it:
    - As a new baseline for further refinement.
    - As input to standalone analyses (stability, chamber geometry visualizer, flight sim).

This README should give you a mental model of how the full engine optimizer UI is structured, what it is optimizing, and how the different layers and variables interact to produce a robust pintle engine design.


