# Config system — two canonical configs + presets

Quick reference for how configs work now, and **why the two canonical files must be committed (not gitignored).**

## The idea

There are **two canonical engine configs**, one per injector type. Switching injector type in the
UI **loads the whole config** for that type — it does *not* patch the current one. This is deliberate:
the two configs are **independent and must NOT stay in sync**. Values that converge for one injector
(e.g. pintle Cd 0.40 fixed) are nonsense for the other (doublet geometry‑Cd 0.60), so each type owns
its own coherent block.

```
configs/canonical/pintle.yaml      ← ethalox pintle   (main physics: fixed Cd 0.40/0.65, smd_pintle)
configs/canonical/impinging.yaml   ← methalox doublet (fork physics: geometry-Cd 0.60, ingebo SMD)
```

Propellant is the *lighter* switch: it overlays the preset identity (fluids + CEA names) onto whatever
geometry is loaded, without swapping the whole config.

```
configs/propellants/methalox.yaml   ethalox.yaml   kerolox.yaml   ← propellant presets
```

## How a switch works (in‑memory only)

1. UI calls `POST /api/config/switch` with `injector_type` and/or `propellant_preset`.
2. **Injector change** → `load_canonical_config(type)` loads `configs/canonical/<type>.yaml` wholesale
   (through the normal loader, so the propellant preset resolves).
3. **Propellant change** → overlays the preset onto the current geometry.
4. The result updates the in‑memory session config. **It is never written to disk** — saving is an
   explicit action, so toggling a dropdown can't clobber a file.

A `design_valid_for: {injector, propellant}` stamp records what the chamber was solved/seeded for. If
you overlay a different propellant onto an existing chamber, forward mode shows a **"needs
re‑optimization"** warning (the chamber is a seed, not a solved design, until you re‑run the optimizer).

## Git — do **not** gitignore the canonical configs

The canonical configs are **source of truth** and must be tracked and pushed. `.gitignore` already
protects them:

```gitignore
!configs/
!configs/**
# only personal/solver-exported configs are ignored, by explicit name pattern:
configs/layer1_optimized_config*.yaml
configs/*Designer*Config*.yaml
configs/latest.yaml
# ... etc
```

`configs/canonical/*.yaml` and `configs/propellants/*.yaml` do **not** match any ignore pattern, so
they are committed normally. Verify with:

```bash
git check-ignore configs/canonical/pintle.yaml   # prints nothing + exit 1 = NOT ignored (correct)
```

**Rules for contributors**
- ✅ Commit changes to `configs/canonical/*.yaml` and `configs/propellants/*.yaml` like normal source.
- ❌ Never add `configs/canonical/` or a broad `configs/*.yaml` line to `.gitignore`.
- ❌ Don't commit personal/exported runs — those already match the ignore patterns above; if you make
  a new personal config, name it so it matches (e.g. `*Designer*Config*.yaml`) or put it in
  `output/user_configs/`.
- When you change physics that should be the new starting point for everyone, edit the **canonical**
  file and commit it. When it's a one‑off experiment, save it under an ignored name.

## Burn time — one value, three slots

Burn time appears in **three** config sections and they must agree:
`design_requirements.target_burn_time`, `pressure_curves.target_burn_time_s`, and `thrust.burn_time`.
`engine/pipeline/burn_time_sync.py` reconciles them:

- `canonical_burn_time_s(config)` returns the authoritative value by priority —
  `design_requirements.target_burn_time` → `pressure_curves.target_burn_time_s` → `thrust.burn_time`
  (or `None` if none are set).
- `sync_burn_time_fields(config)` writes that canonical value back into every slot that is present
  (in place). It is also exposed as a method on `PintleEngineConfig` and is called from
  `backend/routers/optimizer.py` so an optimizer run leaves all three slots consistent.

Edit whichever slot is most convenient; sync makes the highest-priority one win.

## Where things live

| File | Role |
|---|---|
| `configs/canonical/<type>.yaml` | the two committed starting configs (one per injector) |
| `configs/propellants/<name>.yaml` | propellant presets (fluids + CEA identity) |
| `configs/default.yaml` | what the backend loads at startup (currently methalox doublet) |
| `engine/pipeline/config_switch.py` | `switch_config`, `load_canonical_config`, `apply_propellant`, `design_staleness` |
| `engine/pipeline/burn_time_sync.py` | `canonical_burn_time_s`, `sync_burn_time_fields` (reconcile the 3 burn-time slots) |
| `engine/pipeline/io.py` | `load_config` + preset resolution/merge |
| `backend/routers/config.py` | `/switch`, `/options`, `/injector_schema` endpoints |
