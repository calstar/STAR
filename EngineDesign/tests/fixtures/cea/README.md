# CEA cache fixtures

`cea_cache_LOX_Ethanol_3D.npz` is a **committed, deterministic** CEA lookup
table (~313 KB) used by the CI test gate.

## Why it's committed
Several runner/integration tests instantiate `PintleEngineRunner`, which needs
a CEA cache. Building one live calls `rocketcea` (NASA CEA, Fortran — needs
gfortran and takes minutes; the parallel path can deadlock). Committing the
prebuilt table lets those tests just `np.load` it, so the gate runs in seconds
with **no gfortran and no rocketcea** installed.

It is safe to commit because the table is a pure function of its inputs —
propellant pair (`LOX`/`Ethanol`), the CEA grid (`Pc_range`, `MR_range`,
`eps_range`, `n_points`), and the `rocketcea` version — none of which the
day-to-day engine-design code under test changes. The loader
(`engine/pipeline/cea_cache.py`) validates propellant + 2D/3D dimensionality on
load and rebuilds on mismatch, so a stale fixture can't silently feed wrong
physics for those critical inputs.

`configs/impinging_smoke.yaml` points its `cache_file` here.

## Regenerating
Only needed if the CEA grid/propellant in `impinging_smoke.yaml` changes or
`rocketcea` is upgraded. Run the **"Regenerate CEA cache fixture"** workflow
(`workflow_dispatch`) and commit the uploaded artifact, or locally:

```bash
cd EngineDesign
pip install -r requirements.txt          # full set incl. rocketcea (needs gfortran)
python -c "from engine.pipeline.io import load_config; \
from engine.core.runner import PintleEngineRunner; \
PintleEngineRunner(load_config('configs/impinging_smoke.yaml'))"
```
