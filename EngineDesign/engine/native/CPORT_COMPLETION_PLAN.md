# Finishing the C port — completion plan

Goal: make the Layer-1 optimizer evaluate each CMA-ES candidate with a **single native
`ed_evaluate` call** instead of Python orchestration that crosses the ctypes boundary ~5× per
sample, and retire the `ED_USE_NATIVE` gating so C is simply the path (with Python kept only as a
fallback/parity oracle). Written to be executed surgically without shifting physics or breaking the
GUI flow.

---

## Progress log

- **Phase 0 — DONE (2026-06-26).** Python parity oracle captured
  (`tests/golden/nozzle_oracle.json`, pintle + impinging × 3 pressure points, shifting + frozen
  branches). Baseline: **2.73 ms / Python evaluate**. Tool: `tools/capture_nozzle_oracle.py`.
  - **Key finding:** shifting equilibrium moves F/Isp by **up to 0.96% (9.6e-3)** — ~10× the 1e-3
    parity target. So a frozen nozzle cannot match the *shifting* oracle; it matches the *frozen*
    oracle exactly. This drove the Phase 1 split below.
- **Phase 1a — DONE (2026-06-26).** Frozen C nozzle implemented + golden-tested.
  - `include/ed_nozzle.h`, `src/ed_nozzle.c` (faithful port of `nozzle.py::calculate_thrust`
    frozen path + `mach_solver.py` supersonic Newton).
  - `tools/export_nozzle_golden.py` → `tests/golden/nozzle_golden.json`; `tests/test_nozzle_golden.c`
    wired into CMake. **Passes at rtol 1e-7** (6/6 samples); full existing suite still green.
- **Phase 1b — DEFERRED.** Shifting-equilibrium in C (see Phase 1b below). Decision: frozen now,
  shifting later. **Constraint (user):** no physics may be lost — the Python shifting-equilibrium
  path stays intact and remains the AUTHORITATIVE nozzle for Layer-1 finalization and every reported
  number. The frozen C nozzle is the fast inner-loop ranking kernel only.
- **Phase 5 + 6 — DONE (2026-06-26).** Native is now the DEFAULT path (no env var needed). Single
  source of truth `native_injector.native_enabled()` (ON unless `ED_USE_NATIVE=0`; re-reads env each
  call so the escape hatch works at runtime; caches only the lib-load probe). Replaced all scattered
  `os.environ.get("ED_USE_NATIVE")` checks (closure prewarm, chamber_solver, stability/analysis,
  layer1 fast-eval). **Removed the per-call Python residual guard** in chamber_solver (the dominant
  per-candidate Python cost) — now behind `ED_NATIVE_VERIFY=1` (debug only). Phase 6: marked
  nozzle/chamber_solver/closure as the authoritative/fallback-oracle paths in their docstrings (no
  behavior change). Two bugs found & fixed while validating: (1) `_ensure_cea` keyed by `id(cache)`
  but the native lib has ONE tables buffer → a freed cache's id reuse silently served stale CEA
  tables in multi-config processes; now tracked by a token stored on the cache object. (2) my initial
  `native_enabled()` cached the env read, defeating the anchor test's runtime `ED_USE_NATIVE=0` pin.
  Archived 3 dead debug scripts (reproduce_failure / reproduce_blowdown / reproduce_masking) to
  `archive/scrap_files/`. **No physics file is removable** — pintle runs entirely on the Python path,
  which is also the impinging fallback + the authoritative finalization/flight/time-series path.
  Full pytest suite at baseline (51 pre-existing fails / 342 pass, no NEW failures); suite 4× faster
  (35s→8s); pintle verified working (Python fallback, F=7454 N); impinging native parity 2.6e-15.
- **Phase 3 + 4 — DONE (2026-06-26).** `native_injector.evaluate()` returns a runner-compatible
  result dict (physics from `ed_evaluate`; full diagnostics via an injector solve at the converged Pc
  + `_result_to_diag`, so D32/delta_p_feed/etc. match; stability via the same
  `comprehensive_stability_analysis` the Python path uses). Wired into `_eval_candidate`
  ([layer1:~1873]) native-first with Python fallback, gated by `_native_fast_eval_enabled()`
  (`ED_USE_NATIVE=1`, GUI default; `ED_LAYER1_NATIVE_EVAL=0` forces Python). Validation
  (`tools/check_fast_eval_parity.py`): native fast path == Python frozen path to **2.6e-15** across
  physics, diagnostics AND stability (score/acoustic/chug/feed). **Measured 3.4× per-candidate
  speedup** (903 → 266 µs). Layer-1 pytest green with native ON and OFF; pintle falls back to Python;
  finalization replay stays Python (full shifting). Subtlety fixed: stability uses the cooling-adjusted
  effective Tc (`r.Tc_effective`), not the ideal Tc the nozzle expands from.
- **Phase 2 — DONE (2026-06-26).** `ed_evaluate.c` body implemented: `ed_chamber_solve` →
  `ed_cea_eval(MR,Pc,Pa,eps)` → `ed_nozzle_solve` → flatten into `EdEvaluateResult` (every field
  Layer-1 reads). Validated through the **real ctypes path** (`build_state` → `EdNative.evaluate`)
  against the frozen oracle: `tools/check_evaluate_parity.py`, impinging × 3 points, **worst rel
  1.1e-15** (machine precision — native chamber is bit-identical to Python, nozzle is frozen-exact).
  Full C ctest suite still green. NOTE: validation is the Python parity harness (it exercises the
  exact production `build_state` path); a pure-C `test_evaluate_golden.c` is optional/deferred since
  it would be strictly weaker. `build_state` is impinging-only today, so pintle still uses the Python
  path (Phase 4 preserves that fallback).

---

## 0. Current state (verified, 2026-06-26)

**Already in C** (called today via `native_injector`, with `ED_USE_NATIVE` defaulted to `1`):
- Chamber fixed-point solve + Brent — `ed_chamber_solve` (the whole residual loop runs in C)
- Injector flows — `ed_injector_solve`
- CEA lookups — `ed_cea_eval`
- Stability chug sweep + acoustic — `ed_chug_margin_fast`, `ed_fast_acoustic`

**Still Python, per sample** (`engine/core/runner.py::PintleEngineRunner.evaluate`):
- Orchestration: builds the call sequence, re-packs `EdEngineState` each call (`build_state`)
- **Nozzle → thrust → Isp** (`engine/core/nozzle.py::calculate_thrust`) — *not ported*
- Per-call **Python residual validation** of every native Pc (`chamber_solver.py:263`)
- One-time **parity self-checks** + Python-injector fallback (`closure.py`, `chamber_solver.py`)
- Objective assembly (`layer1_static_optimization.py::_compute_objective_value`) — stays Python (cheap)

**Two stubs block the single-call path:**
- `engine/native/src/ed_nozzle.c` — `ed_nozzle_stage()` returns `"deferred"`; nozzle physics unwritten in C.
- `engine/native/src/ed_evaluate.c` — calls `ed_chamber_solve`, then `return ED_ERR_NOT_IMPLEMENTED`
  (comment: "Nozzle expansion + thrust/Isp assembly lands with the chamber port").

**API is already frozen** — `engine/native/include/ed_evaluate.h` fully specifies `EdEvaluateResult`
(every field Layer-1 consumes) and the `ed_evaluate` / `ed_evaluate_batch` signatures. `ed_native.py`
already binds `ed_evaluate` (argtypes/restype at ~line 221). So this is **implementation + wiring**,
not redesign.

### About `ED_USE_NATIVE` (the "bs that keeps popping up")
It is **already on for every GUI run**: `backend/main.py:28` does
`os.environ.setdefault("ED_USE_NATIVE", "1")` before the optimizer imports and before the Layer-1
`ProcessPool` spawns, so workers inherit it. It was built as an opt-*out* kill switch + a cautious
per-call/one-time parity guard during the port. Now that the kernels are trusted, the gating and the
per-call Python validation are pure overhead and noise. Phase 5 removes them and makes C unconditional
(Python only if the library genuinely fails to load).

---

## 1. Guardrails (do these before touching anything)

1. **Lock a parity oracle.** For a fixed set of configs — at minimum `configs/canonical/pintle.yaml`
   and `configs/canonical/impinging.yaml`, plus `tests/golden/anchor_A_config_ethalox_pintle.yaml` —
   record the full `runner.evaluate()` result dict (Python path, `ED_USE_NATIVE=0`) at several
   `(P_O, P_F)` points. This is the ground truth every later phase is checked against.
2. **Parity tolerance, not bit-equality.** C↔Python will differ at the ULP level. Use the tolerance
   already in the codebase: `rtol = 1e-3` on `mdot`/`Pc` (see `closure.py::_NATIVE_RTOL`), and add
   `rtol = 1e-3` on `F`, `Isp`, `Cf`, `T_exit`. Document that bit-identical is **not** a goal.
3. **Existing native golden tests must stay green** the whole time:
   `engine/native/tests/test_chamber_golden.c`, `test_injector_golden.c`, `test_residual_golden.c`,
   `test_cea_interp.c`. Add new golden tests in the same harness (Phases 1–2).
4. **Capture a full Layer-1 run** (best config + objective trace + wall-clock) on one canonical
   problem now, to compare end-to-end after wiring (Phase 4). Use `bench_compare.py` for timing.
5. **Injector-type coverage.** Native covers pintle + impinging; `native_injector._can_handle_*`
   returns False for unsupported types (e.g. coaxial). Every phase must preserve the Python fallback
   for types the C path can't handle — do not assume all configs go native.

---

## 2. Phase 1a — Frozen nozzle in C (`ed_nozzle.c`) — DONE

Ported the FROZEN path of `engine/core/nozzle.py::calculate_thrust` (use_shifting_equilibrium=False)
+ `mach_solver.py` supersonic Newton. Scope decision came from Phase 0 (shifting eq is a ~1% term;
see Progress log).

- `include/ed_nozzle.h` — flat `EdNozzleInputs`/`EdNozzleResult` + `ed_nozzle_solve`.
- `src/ed_nozzle.c` — area-Mach Newton (tol 1e-10, identical to Python), isentropic exit state,
  momentum+pressure thrust, throat conditions. `ed_nozzle_stage()` now returns `"frozen"`.
- `tools/export_nozzle_golden.py` records CEA-derived inputs + frozen outputs →
  `tests/golden/nozzle_golden.json`. `tests/test_nozzle_golden.c` asserts **rtol 1e-7** (kernel is
  the same formulas on the same thermo, so parity is near machine precision).
- `engine/core/nozzle.py` untouched — it remains the oracle AND the authoritative shifting-eq nozzle.

Done checklist:
- [x] `ed_nozzle.h` added; `ed_nozzle.c` in the existing `ED_SOURCES` list (no CMake source edit needed).
- [x] `test_nozzle_golden` wired + passing (6/6, rtol 1e-7); existing suite green (root_find, cea_interp,
      feed_discharge, residual_golden, injector_golden).

## 2b. Phase 1b — Shifting equilibrium in C (`ed_nozzle`) — DEFERRED

Brings the inner-loop nozzle from ~1% (frozen) to <1e-3 vs the *shifting* oracle. Only do this if the
inner-loop ranking bias is shown to matter; the Python shifting path already guarantees correct final
numbers, so this is an optimization-quality refinement, not a correctness fix.

- Port `reaction_chemistry.py::calculate_shifting_equilibrium_properties` +
  `calculate_shifting_equilibrium_gamma` + `calculate_frozen_gamma_from_composition`, and the 20-iter
  loop in `nozzle.py:432-500`. These do iterative CEA re-evaluations — reuse `ed_cea_eval`.
- Watch the empirical branches (`α≈0.15-0.25`, `Da/(1+Da)`, the CEA-failed fallback). Capture a
  dedicated shifting golden from the `shifting` branch already in `nozzle_oracle.json`.
- **Hard constraint:** do not delete or weaken the Python shifting path. It stays authoritative for
  Layer-1 finalization regardless of whether 1b lands.

---

## 3. Phase 2 — Implement `ed_evaluate.c` body — DONE

(See Progress log. Implemented as below; cooling fields taken from chamber diag, no separate
`ed_cooling` call needed since Layer-1 disables ablative/graphite for the static eval.)

Fill in the assembly between `ed_chamber_solve` and the result:

1. Call `ed_chamber_solve(state, cea, P_tank_O, P_tank_F, ws, &chamber_diag)` (already implemented).
2. Pull thermo + flow from `EdChamberDiagnostics` (`ed_chamber.h:26`): `Pc, mdot_O, mdot_F, MR,
   gamma, R, Tc, cstar_actual/ideal, eta_cstar, Cd_O, Cd_F, momentum_ratio_R, SMD,
   delta_P_injector_*, A_geom_*`.
3. Call `ed_nozzle_solve(...)` (Phase 1) for `F, Isp, v_exit, P_exit/throat, T_exit/throat,
   Cf_actual/ideal`.
4. Populate **every** `EdEvaluateResult` field (`ed_evaluate.h:20-46`), set `converged = 1`, return
   `ED_OK`. On any sub-step failure, return the sub-step's status and leave `converged = 0` (Python
   fallback will catch `None`).
5. Cooling fields (`cooling_efficiency`, `Tc_effective`): Layer-1 typically runs with ablative/
   graphite cooling **disabled** for the static eval (`layer1_static_optimization.py:3369-3372`).
   Mirror that — if cooling is off, set `cooling_efficiency = 1.0`, `Tc_effective = Tc`. Only port
   `ed_cooling` into the evaluate path if a Layer-1 sample actually needs it (it does not today).
6. Leave `ed_evaluate_batch` as a thin loop over `ed_evaluate` for now (optional speedup later).

Golden test: `engine/native/tests/test_evaluate_golden.c` comparing the full struct to the Python
`runner.evaluate()` oracle for pintle + impinging at several pressures, `rtol 1e-3`.

Surgical checklist:
- [ ] `ed_evaluate.c` returns `ED_OK` with a fully-populated struct for pintle + impinging.
- [ ] Field-by-field mapping documented inline (chamber-diag field → result field).
- [ ] `test_evaluate_golden.c` passes.

---

## 4. Phase 3 — Python wrapper (`native_injector.evaluate`)

Add a `evaluate()` to `engine/native/python/native_injector.py` mirroring the existing
`chamber_solve()` shape:

```
def evaluate(config, cache, P_O_Pa, P_F_Pa, P_ambient_Pa, Pc_guess_Pa=0.0):
    if not _can_handle_chamber(config): return None         # preserves type fallback
    nat = _nat()
    if not _ensure_cea(cache): return None
    st = build_state(config)
    rc, res = nat.evaluate(st, P_O_Pa, P_F_Pa, P_ambient_Pa, Pc_guess_Pa)  # EdEvaluateResult
    if rc != 0 or not res.converged: return None
    return _result_to_runner_dict(res)                       # match runner.evaluate keys
```

- Add `EdNative.evaluate(...)` in `ed_native.py` that allocates an `EdEvaluateResult`, calls the
  already-bound `ed_evaluate`, returns `(rc, struct)`. Reuse the existing `self._ws_buf` /
  `self._tables_buf` workspace buffers (already allocated once per process).
- `_result_to_runner_dict` must produce **exactly** the keys Layer-1 reads downstream — verified
  against `runner.py`: top-level `F, Isp, Pc, MR, v_exit, P_exit, P_throat, T_exit, T_throat,
  Cf_actual, Cf_ideal` and a `diagnostics` sub-dict with `cstar_actual, mdot_O, mdot_F, MR, gamma,
  R, Tc, momentum_ratio_R, Cd_O, Cd_F, P_injector_*, delta_p_*`. Cross-check against
  `_compute_objective_value` and `_layer1_*` consumers so nothing reads a missing key.
- **Process safety:** each `ProcessPool` worker imports its own `native_injector` and holds its own
  `EdNative` instance + workspace — no shared mutable state across workers. Confirm `_nat()` is
  per-process (it is, module-global in the worker).

Surgical checklist:
- [ ] `native_injector.evaluate` returns a dict byte-compatible with `runner.evaluate` consumers, or `None`.
- [ ] Parity test (Python): `native_injector.evaluate` vs `runner.evaluate` within tolerance on the oracle set.

---

## 5. Phase 4 — Wire into the Layer-1 hot path

In `engine/optimizer/layers/layer1_static_optimization.py::_eval_candidate` (~line 1874), replace the
unconditional `_worker_runner.evaluate(...)` with:

```
result = None
if _worker_native_ok:                       # resolved once per worker (see Phase 5)
    result = native_injector.evaluate(_worker_runner.config, _worker_runner.cea_cache,
                                      P_O_Pa, P_F_Pa, _worker_constants['P_ambient'])
if result is None:                          # unsupported type / non-converged → Python
    result = _worker_runner.evaluate(P_O_Pa, P_F_Pa,
                                     P_ambient=_worker_constants['P_ambient'], silent=True)
```

- **Everything downstream is unchanged** — `_compute_objective_value`, thrust/MR extraction, the
  impinging momentum hinge all keep reading `result[...]`. That is the whole point of matching keys
  in Phase 3.
- **Stability:** if Layer-1 scores stability per sample, route it natively too — `ed_stability.h`
  already takes a `const EdEvaluateResult*` (`ed_stability.h:80`), so feed the struct straight into
  `ed_chug_margin_fast` / `ed_fast_acoustic` instead of re-deriving inputs in Python
  (`stability/analysis.py:483-500`). If stability is only scored at finalization (not per sample),
  leave it for a follow-up.
- **Finalization replay** (`layer1_static_optimization.py:3376`, the high-fidelity re-eval of the
  winning candidate) should stay on the **Python** `runner.evaluate` so the final reported numbers go
  through the full-fidelity path including cooling. Only the inner search loop goes native.

Validation: rerun the captured Layer-1 problem; assert the best config, feasibility, and objective
trace match the pre-change run within tolerance, and record the speedup via `bench_compare.py`.

Surgical checklist:
- [ ] `_eval_candidate` native-first with Python fallback; downstream untouched.
- [ ] End-to-end Layer-1 parity (best config + objective) within tolerance.
- [ ] Speedup measured and recorded.

---

## 6. Phase 5 — Retire the `ED_USE_NATIVE` gating and per-call guards

Now make C the path, not a toggle:

1. **Resolve native availability ONCE** at process start (library loads + passes a single golden
   parity self-check). Store a module-level `NATIVE_AVAILABLE: bool`. This replaces:
   - `closure.py` per-process `_NATIVE_OK` one-time self-check (keep the *idea*, run it once at
     startup, not lazily on first flow).
   - `chamber_solver.py` per-call Python residual guard (`_native_chamber_resolve` / line 263) —
     **delete the per-call residual**; trust the kernel that passed the startup golden. Keep a single
     `assert`-style parity check behind a debug env var for developers, off by default.
2. **Remove `os.environ.get("ED_USE_NATIVE")` branches** from the hot path
   (`closure.py:24,87`, `chamber_solver.py:243`, `stability/analysis.py:487,497`). Replace each with
   `if NATIVE_AVAILABLE:`. Keep **one** opt-out for developers: honor `ED_USE_NATIVE=0` only at the
   single startup resolution point (so `NATIVE_AVAILABLE=False` forces Python everywhere) — that's the
   debugging escape hatch, not a per-call branch.
3. `backend/main.py:28` `setdefault(..., "1")` can stay (harmless) or be dropped once gating is gone;
   leaving it documents intent. The autobuild prewarm stays.

Surgical checklist:
- [ ] Single startup native-resolution; no per-call `ED_USE_NATIVE` checks remain in hot code.
- [ ] Per-call Python residual guard removed; golden + Layer-1 parity still green.
- [ ] `ED_USE_NATIVE=0` still forces a clean all-Python run (dev fallback intact).

---

## 7. Phase 6 — Demote Python physics to fallback-only

Not deletion — these stay as the fallback + oracle, just off the hot path:
- `engine/core/runner.py::evaluate` — fallback for unsupported types + finalization replay.
- `engine/core/chamber_solver.py` (scipy residual/Brent) — fallback only.
- `engine/core/closure.py` + `engine/core/injectors/{impinging,coaxial,pintle}.py` — Python injector
  models, fallback only; coaxial stays Python until/unless `ed_injector_solve` covers it.
- `engine/core/nozzle.py`, `engine/pipeline/cea_cache.py::eval` — fallback/oracle.

Cleanup:
- [ ] Ensure no per-sample Python `import` inside the native path (move imports to module top or a
      once-per-worker init).
- [ ] Mark each fallback module with a one-line docstring note: "fallback/parity oracle; hot path is
      `ed_evaluate`."
- [ ] Confirm coaxial (and any other non-native type) still optimizes correctly via fallback.

---

## 8. Risk register

| Risk | Mitigation |
|------|-----------|
| C↔Python numeric drift changes optimizer trajectory | Gate on `rtol 1e-3` golden parity per field; compare full Layer-1 best config before/after |
| Missing/renamed result-dict key breaks `_compute_objective_value` | Phase 3 cross-checks every consumed key against `runner.py` + `layer1_*`; parity test catches it |
| Coaxial / unsupported injector silently goes wrong | `_can_handle_*` returns None → Python fallback preserved and explicitly tested |
| ProcessPool worker state races | Per-process `EdNative` + workspace; no shared mutable buffers; verify in a multi-worker run |
| Cooling fidelity lost in inner loop | Layer-1 inner eval already disables ablative/graphite; finalization replay stays Python full-fidelity |
| Nozzle exit-pressure solve diverges on extreme samples | Reuse `ed_root_find`; on non-convergence return error → Python fallback for that sample |

## 9. Suggested order & checkpoints
1. Phase 0 guardrails (oracle + baseline timing).
2. Phase 1 nozzle (green golden) → 3. Phase 2 evaluate (green golden) → 4. Phase 3 wrapper (Python parity).
5. Phase 4 wiring (end-to-end parity + speedup number) — **stop and verify here; this delivers the win.**
6. Phase 5 de-gating, then 7. Phase 6 demotion — cleanup, lower risk, do last.
