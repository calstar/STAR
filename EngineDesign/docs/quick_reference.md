# Quick Reference

A cheat sheet for the EngineDesign pipeline. See `README.md` for the full picture.

## Run the app

```bash
./dev.sh                 # backend (:8000) + frontend (:5173), native kernel on
```

Manual: `uvicorn backend.main:app --reload --port 8000`, then `cd frontend && npm run dev`.

- API docs: http://localhost:8000/docs
- Health: http://localhost:8000/api/health

## Evaluate an engine from Python

```python
from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner

config = load_config("configs/canonical/impinging.yaml")   # or default.yaml
runner = PintleEngineRunner(config)

results = runner.evaluate(P_tank_O, P_tank_F)   # tank pressures in Pa
print(results["F"], results["Pc"], results["MR"], results["mdot_total"])
```

**Pc is never an input** — it is always solved so that injector supply = combustion demand.

## Propellants

Add `propellant_preset: <name>` at the top of a config:

| Preset | Combination | Committed CEA cache |
|--------|-------------|---------------------|
| `kerolox`  | LOX / RP‑1    | built on first use |
| `methalox` | LOX / CH₄     | `output/cache/cea_cache_LOX_CH4_3D.npz` |
| `ethalox`  | LOX / Ethanol | `output/cache/cea_cache_LOX_Ethanol_3D.npz` |

Presets live in `configs/propellants/`. The `*.npz` cache tables are committed, so
methalox/ethalox run without a multi-minute first-use cache build.

## Injector types

Set `injector.type: pintle` or `injector.type: impinging`. Canonical seeds:
`configs/canonical/pintle.yaml` (LOX/Ethanol) and `configs/canonical/impinging.yaml`
(LOX/CH₄). See `optimizer_readme.md` for the per-type Layer-1 design vectors.

## Native C kernel

- Enabled automatically by the backend (`ED_USE_NATIVE=1`); for CLI: `export ED_USE_NATIVE=1`.
- `ED_USE_NATIVE=0` forces pure Python (byte-for-byte reference path).
- Engages for **impinging + ablative-only + advanced-efficiency** configs; everything
  else falls back to Python automatically.
- Look for `[native] kernel enabled` at backend startup. Details: `engine/native/README.md`.

## Optimizer

Entry point: `run_full_engine_optimization_with_flight_sim()` in
`engine/optimizer/main_optimizer.py`. Layers run sequentially:

| Layer | File | Purpose |
|-------|------|---------|
| 1 | `layers/layer1_static_optimization.py` | Static geometry + pressure design (parallel CMA‑ES) |
| 2 | `layers/layer2_pressure.py` | Time-series pressure-curve optimization |
| 3 | `layers/layer3_thermal_protection.py` | Ablative/graphite thickness sizing |
| 4 | `layers/layer4_flight_simulation.py` | RocketPy trajectory validation |

## Example scripts

```bash
python scripts/simple_example.py
python scripts/run_full_pipeline.py
python scripts/pressure_sweep.py
```
