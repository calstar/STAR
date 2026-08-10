# Archived: Streamlit UI

The Streamlit front end, superseded by the FastAPI backend + React frontend
(`backend/` and `frontend/`). Kept for reference only — these have **zero
references** anywhere in the live codebase.

## Contents

| File | Was | Role |
| --- | --- | --- |
| `design_optimization_view.py` | `ui/` | Streamlit app entry point |
| `flight_visuals.py` | `ui/` | Flight-trajectory plots |
| `display_results.py` | `engine/optimizer/` | Pressure/COPV/convergence plots |
| `views/tabs.py` | `engine/optimizer/views/` | The optimizer tab UI |
| `views/helpers.py` | `engine/optimizer/views/` | Shared Streamlit widgets |
| `views/__init__.py` | `engine/optimizer/views/` | Re-exports from `tabs.py` |

## Why they moved

`display_results.py` was imported eagerly by `engine/optimizer/__init__.py`, so
importing *any* optimizer submodule pulled in Streamlit — including from the
FastAPI backend, which never used it:

```
backend/routers/timeseries.py  →  engine.optimizer.layers.layer2_pressure
                               →  engine/optimizer/__init__.py  (parent package runs)
                               →  display_results.py  →  import streamlit
```

That made Streamlit and its transitive tail (pyarrow, altair, pydeck, protobuf,
gitpython, jsonschema, watchdog) mandatory for the API container — roughly half
its image size, for code the API never called.

`streamlit` has been dropped from `requirements-base.txt`, so **these files will
not run as-is**; `pip install streamlit` first if you need to resurrect one.

## What did NOT move

- `ui/flight_sim.py` — live. `engine/optimizer/copv_flight_helpers.py` imports
  `setup_flight` from it. No Streamlit.
- `ui/interactive_pipeline.py` — standalone CLI
  (`python ui/interactive_pipeline.py`), no Streamlit. `views/tabs.py` used to
  borrow its `solve_for_thrust`; nothing does now.
- The `plot_*` helpers are gone from `engine.optimizer`'s public API. They only
  ever rendered into a Streamlit page (`st.plotly_chart` / `st.metric`) and
  returned `None`, so there was nothing headless to keep.
