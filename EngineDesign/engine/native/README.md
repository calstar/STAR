# `engine/native` — Native C11 physics kernel (parallel implementation)

A clean-room C11 port of the STAR EngineDesign hot path
(`ChamberSolver.solve → nozzle → comprehensive_stability_analysis`), built **next
to** the Python package. It links against **no** Python at runtime and is **not**
wired into any production path (`runner.py`, Layer 1, routers, frontend are
untouched). The goal, once integrated behind an opt-in flag, is a ≥10× single-core
speedup on `evaluate + stability` with documented numerical parity.

> **Status: Stages 1–3 complete and verified. The native chamber solve is wired
> into production behind `ED_USE_NATIVE=1` with auto-build on startup.** The whole
> chamber residual loop — impinging injector, CEA, combustion efficiency
> (L*/kinetics/mixing/turbulence), ablative cooling_eff, and the Brent root-find —
> now runs in C. Measured against the live Python implementation:
> `ed_chamber_solve` matches `ChamberSolver.solve` to **~5e-10 on Pc** and is
> **~400× faster**. Stage 5 ported the per-eval stability physics (the chug
> complex-impedance sweep + the 1L/1T acoustic growth rates) to C, and the
> display-only ablative heat-flux profile is skipped on the optimizer (`silent`)
> path. A full `runner.evaluate()` is now **~68× faster end-to-end** (68 ms →
> 1.0 ms) at ~5e-10 parity. What's left is Python *orchestration* — logging
> f-strings, ctypes call overhead, result-dict assembly, and the nozzle's CEA/
> shifting-equilibrium calls (Stage 4, deferred) — **not** the chamber/stability
> physics, which is native.

## Cross-platform

Builds and runs on **macOS, Linux, and Windows**. The CMake flags are
compiler-aware (GCC/Clang `-O3 [-march=native] [-flto]`; MSVC `/O2`), `libm` is
linked only on UNIX, and the benchmark clock uses `QueryPerformanceCounter` on
Windows / `clock_gettime` elsewhere. The macOS arch note below is **macOS-only**
and is handled automatically — it has no effect on Windows or Linux users.

---

## Why staged

The chamber residual is not a small function. For the canonical configs it pulls
in `combustion_physics.calculate_combustion_efficiency_advanced` (~1.4k lines of
finite-rate chemistry / gasification-SMD / mixing), `reaction_chemistry`, and the
ablative + graphite cooling models, then nozzle expansion, then the full
chug/acoustic/feed stability stack — together ~6–10k lines of intricate, tightly
coupled numerics that must match Python to **Pc rtol 1e-4**. Emitting all of that
in one pass without the ability to iterate against Python parity would produce
code that silently fails the golden gate. So this delivers **correct, tested
layers** and grows upward, exactly as the spec's suggested implementation order
prescribes (`ed_types/ed_state/ed_cea/ed_root_find + unit tests` first).

## What is implemented and verified now

| Component | Source | Parity vs Python | Speed |
|---|---|---|---|
| CEA trilinear interp + clamp | `src/ed_cea.c` ↔ `cea_cache.py` | **max rel err 3.98e-16** (79 samples incl. clamp edges) | **91.7 ns** / 6-property eval (~15 ns/table; target <100 ns) |
| Brent/bisection root find | `src/ed_root_find.c` ↔ `scipy.brentq` | analytic roots to 1e-9; bracket/endpoint cases | **41.7 ns** / solve |
| Feed-system loss | `src/ed_feed_loss.c` ↔ `feed_loss.py` | exact (60 samples, all `phi_type`) | — |
| Injector discharge Cd | `src/ed_discharge.c` ↔ `discharge.py` | exact (61 samples, geom/P/T/clamp paths) | — |
| Spray (J, TMR, We, Oh, SMD Ingebo/Lefebvre, x*) | `src/ed_spray.c` ↔ `spray.py` | exact | — |
| **Impinging injector solve** | `src/ed_injector_impinging.c` ↔ `injectors/impinging.py` | **rtol 1e-6** (24 samples: mdot, Cd, momentum R, jet areas, SMD, We, θ, x*) | feed-orifice fixed point in C |
| **Combustion efficiency** (η_L*/kinetics/mixing/turbulence) | `src/ed_combustion_physics.c` ↔ `combustion_physics.py` | **~3e-16** (180 residual checks) | — |
| **Ablative cooling_eff** | `src/ed_cooling.c` ↔ `_evaluate_cooling_models` + hot-wall flux + ablative response | **~3e-16** | — |
| **Chamber solve** (whole residual loop + Brent) | `src/ed_chamber.c` ↔ `ChamberSolver.solve` | **Pc ~5e-10**; `runner.evaluate()` ~5e-10 | **~400×** vs Python solve |
| **Chug stability** (200-pt complex Nyquist sweep) | `src/ed_stability_modes.c` ↔ `chug.py::chug_margin_fast` | **~3e-16** (gain margin, f_chug) | dominant stability cost |
| **Acoustic stability** (1L+1T growth rates) | `src/ed_stability_modes.c` ↔ `acoustic.py::fast_acoustic` | **0** (bit-identical) | per-eval stability now fully native |
| **Chamber post-proc tail** (display-only ablative profile gated on `silent`) | `chamber_solver.py` | bit-identical scalars; display path keeps the profile | biggest tail cost removed |
| **Python orchestration (Tier 1)** | silent-path logging level (`runner.py`); `np.clip`→scalar in `cea_cache.py` | exact (CEA golden diff = 0) | `evaluate()` now **~88×** end-to-end (68 ms → 0.77 ms) |
| Flat POD config snapshot | `include/ed_state.h` + `ed_state_patch()` | O(1) hot-field patch | — |
| ctypes shim | `python/ed_native.py` | drives the above; **112× vs Python `CEACache.eval`** through ctypes | — |

Measured on this machine (Apple Silicon, Apple clang 17, `-O3 -flto`,
Release). `CEACache.eval` in Python is ~99 µs/call — dominated by dict + numpy
churn — versus 0.88 µs through the ctypes-bound C kernel and ~0.09 µs native; this
is the dict-elimination win the spec calls out, shown on the one kernel ported so
far.

## Directory layout

```
engine/native/
├── include/      ed_types,ed_state,ed_cea,ed_workspace,ed_root_find,
│                 ed_feed_loss,ed_discharge,ed_chamber,ed_evaluate,ed_stability,ed_abi
├── src/          implemented: ed_cea, ed_root_find, ed_feed_loss, ed_discharge,
│                 ed_workspace, ed_abi; staged stubs: ed_chamber, ed_evaluate,
│                 ed_stability(+_modes), ed_nozzle, ed_cooling, ed_spray,
│                 ed_combustion_eff/_physics, ed_injector_{pintle,impinging,coaxial}
├── tests/        test_root_find, test_cea_interp, test_feed_discharge (PASS);
│                 test_chamber_golden (SKIP=77 until physics lands); golden/*.json,*.bin
├── bench/        bench_evaluate.c  (per-kernel ns/call; full path auto-enables)
├── tools/        export_cea_tables.py, export_component_golden.py,
│                 export_golden_vectors.py, state_from_yaml.c
└── python/       __init__.py, ed_native.py, ed_state_builder.py, bench_compare.py
```

## Build

**macOS / Linux:**

```bash
cd engine/native
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
./build/bench_evaluate
```

Flags: `-O3` (Release) with `-march=native` (`-DED_NATIVE_ARCH=OFF` for portable
`-O2`-class builds) and `-flto` (`-DED_ENABLE_LTO=OFF` to disable). `-ffast-math`
is **OFF by default** (`-DED_FAST_MATH=ON` to enable): the CEA NaN-corner fallback
and residual NaN guards depend on IEEE NaN semantics, so fast-math would change
behavior — only enable it for isolated nozzle/stability arithmetic and document
any parity delta.

**Windows (MSVC):**

```bat
cd engine\native
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
ctest --test-dir build -C Release --output-on-failure
build\Release\bench_evaluate.exe
```

The auto-build path (below) shells out to whatever CMake generator/toolchain is
installed (MSVC or MinGW) and produces `ed_physics.dll`; no Windows-specific
steps are required.

**macOS arch note — auto-handled, macOS-only:** a ctypes library must match the
Python interpreter's architecture, and on Apple Silicon the system can run an
x86_64 (Rosetta) Python alongside arm64 toolchains. The **auto-build builds with
the running interpreter's architecture**, so this is resolved automatically and
needs no manual flag. This note does **not** apply to Windows or Linux. For a
manual arch-matched build if ever needed:

```bash
cmake -S . -B build_arm -DCMAKE_OSX_ARCHITECTURES=arm64 -DED_NATIVE_ARCH=OFF
cmake --build build_arm -j --target ed_physics_shared
```

## Export tables, golden vectors, and a state snapshot

All exporters read the existing `engine/` package **read-only** and write only
under `engine/native/`. Run from the repo root (`EngineDesign/`):

```bash
# CEA tables (.bin) + reference eval samples (.json) for the C parity test
python engine/native/tools/export_cea_tables.py     --config configs/canonical/impinging.yaml --out engine/native/tests/golden

# Leaf-physics parity samples (feed loss, discharge)
python engine/native/tools/export_component_golden.py --out engine/native/tests/golden

# Runner-level golden vectors (Pc, F, MR, injector + stability margins) for the
# future chamber/evaluate/stability golden test
python engine/native/tools/export_golden_vectors.py --config configs/canonical/impinging.yaml \
    --out engine/native/tests/golden/golden_impinging.json

# Flat EdEngineState field mapping (JSON today; packed .bin lands with ed_evaluate)
python engine/native/python/ed_state_builder.py --config configs/canonical/impinging.yaml
```

## Run tests & benchmark

```bash
ctest --test-dir build --output-on-failure      # root_find, cea_interp, feed_discharge PASS; chamber_golden SKIP
./build/bench_evaluate                           # per-kernel ns/call
python engine/native/python/bench_compare.py     # Python vs C (CEA today; combined path when implemented)
```

## Production wiring (LIVE — chamber solve)

The whole chamber solve is wired into the live hot path **today**, opt-in and safe:

- **Enable:** the FastAPI backend (`backend/main.py`) sets `ED_USE_NATIVE=1` by
  default at startup — before the Layer-1 `ProcessPoolExecutor` spawns, so worker
  processes inherit it — and prebuilds the native lib once so workers don't race to
  compile. So the **frontend optimizer uses the native path automatically.** Opt out
  with `ED_USE_NATIVE=0`. For CLI/scripts not going through the backend, export
  `ED_USE_NATIVE=1` yourself. Unset/`0` is pure Python, byte-for-byte unchanged.
- **Config compatibility:** native engages only for **impinging** injectors with
  **ablative-only** cooling (film/regen off) and the advanced efficiency model — the
  ported path. Pintle/coaxial designs, or film/regen-coupled cooling, fall back to
  Python (correct, but no speedup). If a frontend run isn't faster, check the
  injector type and that `[native] kernel enabled` printed at backend startup.
- **Dispatch points:**
  - `engine/core/chamber_solver.py::solve()` calls `_native_chamber_pc()` →
    `native_injector.chamber_solve()` → C `ed_chamber_solve` (whole residual loop +
    Brent). On success the Python root-find is skipped and the existing
    post-processing rebuilds the full diagnostics dict from the solved Pc, so the
    nozzle/stability code downstream is unchanged.
  - `engine/core/closure.py::flows()` still routes the injector branch natively for
    any caller that uses `flows()` directly.
  - Non-impinging injectors, film/regen-coupled cooling, or non-advanced efficiency
    models fall back to Python automatically (`_can_handle_chamber`).
- **CEA tables:** the live `CEACache` is dumped to a temp `.bin`, loaded into the
  native lib once per process (so the C path uses exactly the runtime grid), and the
  temp file is **deleted immediately after the load** — `ed_cea_load` `fread`s the
  whole file into its own memory and closes it, so the file is dead weight the moment
  it returns. (Earlier this leaked one ~1.8 MB `.bin` per worker process into
  `$TMPDIR`; with a `ProcessPoolExecutor` over many optimizer runs that grew to
  hundreds of GB.)
- **Auto-build on startup:** importing `closure` with `ED_USE_NATIVE=1` kicks off a
  **background** CMake build (`engine/native/python/autobuild.py::prewarm`) into an
  arch-tagged dir; the first `flows()` call transparently waits for it. No manual
  `cmake` step. Rebuilds only when sources change.
- **Self-check + fallback:** the injector `flows()` path runs a one-time `mdot`
  parity check (>0.1% disables native for the process). The chamber solve uses a
  **per-call, non-latching guard**: every native `Pc` is validated against the Python
  residual (one residual eval — ~0.15 ms vs the ~78 ms full Python solve, so the
  native path is still **~200×**) with a tolerance *relative to* the solved
  `mdot_total`. A geometry where native and Python disagree — rare, near-degenerate
  CMA samples — falls back to Python **for that call only**; native stays enabled for
  every other geometry. Only a genuine library failure (exception) disables native for
  the process. This replaced an earlier *one-time latch* that disabled native for a
  whole worker if its first sampled geometry happened to be one of those degenerate
  cases (≈1 in 200), which is why long optimizer runs would silently drop back to
  Python despite `ED_USE_NATIVE=1`.
- **Layout-drift guard:** `ed_native.py` asserts `ctypes.sizeof(EdEngineState) ==
  ed_sizeof_engine_state()` at load, so any `ed_state.h` change that isn't mirrored
  fails loudly (→ fallback) instead of corrupting inputs.

## Remaining integration (later stages)

1. **`runner._evaluate_native()`** opt-in once `ed_evaluate` (Stages 3–4) lands —
   replaces the whole chamber→nozzle path, not just the injector, behind the same
   `ED_USE_NATIVE` flag with Python fallback.
2. **Layer 1 worker uses native** — the CMA-ES worker calls `ed_evaluate_batch`
   with one frozen `EdEngineState` + per-thread `EdWorkspace`, patching hot fields
   via `ed_state_patch()`.

That full switch-over is gated on `bench_compare.py` reporting **≥10×** on the
combined `evaluate + stability` path and the golden tests passing at the documented
tolerances (Pc 1e-4, F/mdot 1e-3, margins 1e-2).

## Staged plan

Each stage is independently golden-tested before the next begins.

- **Stage 1 — foundation (DONE):** types, flat state, CEA interp, Brent, feed
  loss, discharge, workspace, build system, export tooling, ctypes shim, parity
  tests. *(this commit)*
- **Stage 2 — impinging injector + spray + wiring (DONE):** ported
  `injectors/impinging.py` and `spray.py` (SMD Ingebo/Lefebvre), golden-tested
  (mdot, Cd, momentum ratio R, jet areas, SMD), and wired into `closure.flows`
  behind `ED_USE_NATIVE=1` with auto-build + self-check. *(this commit)*
  Pintle/coaxial solves are the next sub-step before Stage 3.
- **Stage 3 — combustion efficiency + cooling + chamber solve (DONE):** ported
  `combustion_physics.calculate_combustion_efficiency_advanced` (η_L*, η_kinetics,
  η_mixing, η_turbulence) and the ablative `cooling_eff` chain (hot-wall flux +
  `compute_ablative_response`), golden-tested to ~3e-16, then wired the whole
  residual + Brent into `ed_chamber_solve` and into `ChamberSolver.solve`. Pc parity
  ~5e-10 (≪ 1e-4 target); ~400× faster chamber solve, ~38× faster `evaluate()`.
  `reaction_chemistry` progress is diagnostics-only (runs after the root-find, does
  not affect Pc) and is deferred. *(this commit)*
- **Stage 5 — stability (chug DONE):** ported `chug.py::chug_margin_fast` — the
  200-pt complex-impedance Nyquist sweep that dominates per-eval stability cost — to
  C (`ed_chug_margin_fast`), parity ~3e-16, and wired it into
  `compute_physical_stability` behind `ED_USE_NATIVE`. `evaluate()` is now ~50×.
  *(this commit)*. Remaining (small): `acoustic.fast_acoustic` and the feed-system
  margins.
- **Stage 4 — nozzle + `ed_evaluate`:** `nozzle.py` thrust/Isp/exit conditions →
  full `EdEvaluateResult`. NOTE: parity requires porting the shifting-equilibrium
  path (`reaction_chemistry.calculate_shifting_equilibrium_properties`), which moves
  F by ~0.4% (above the 1e-3 target) — so this stage carries the reaction-chemistry
  port. Currently the nozzle (calculate_thrust) still runs in Python (~10% of eval).
- **Chamber post-processing tail (~30% of the native eval):** `ChamberSolver.solve`
  still rebuilds the diagnostics dict in Python (re-runs `_evaluate_cooling_models`
  + `reaction_chemistry` progress) after the native root-find. Trimming this (have
  the native solve return cooling/progress) is the other remaining lever.
- **Stage 6 — optimize to ≥10×:** profile the combined path; batch API; confirm
  zero hot-loop allocation; `bench_compare.py` 10× gate.

## Known gaps vs Python (current)

- `ed_chamber_solve` / `ed_evaluate` / `ed_stability_analyze` return
  `ED_ERR_NOT_IMPLEMENTED` (Stages 2–5). APIs and result structs are frozen.
- Cd P/T corrections, `phi_type ∈ {sqrtP, logP}`, and clamp branches are ported
  and tested even though the canonical impinging config does not exercise them
  (it uses `phi_type=none`, geometry-Cd, corrections off).
- Standalone C `state_from_yaml` defers to `python/ed_state_builder.py` so config
  resolution (presets/defaults/derived geometry) has a single source of truth.
- Deliberate non-goals (unchanged): time-varying solver, flight sim, Layer 2–4,
  `stability/report.py` rich payload, calling RocketCEA from C.

## Parity tolerances (asserted / planned)

| Quantity | Tolerance | Where |
|---|---|---|
| CEA properties | rel 1e-9 (achieves ~1e-16) | `test_cea_interp` (now) |
| feed Δp, Cd | rel 1e-9 (exact) | `test_feed_discharge` (now) |
| Pc | rtol 1e-4 | `test_chamber_golden` (Stage 3) |
| F, mdot_* | rtol 1e-3 | Stage 4 |
| stability margins | rtol 1e-2 | Stage 5 |
