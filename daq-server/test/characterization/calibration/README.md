# Calibration characterization

Freezes what the calibration code computes so the remaster can prove it changed nothing.

| golden | produced by | covers |
|---|---|---|
| `golden/lib.txt` | `char_calibration_lib` (ctest, label `characterization`) | `lib/src/calibration` and `lib/src/t7` through their public API: PT cubics and their inverse, the PT/sensor managers' loaders, RTD Callendar-Van Dusen, type K, the 4-20 mA shunt code, PT smoothing, ball-valve position, command dedupe, the capture window, the cubic store (fits, captures, load/save bytes, orphans, unit mismatch), the LC tare store, Allan variance, the robust learner, the T7 conversions and channel map |
| `golden/stack.txt` | `run.sh` → `service_run.py` | the built `calibration_service` against a stand-in Elodin on 127.0.0.1: every frame it publishes for a scripted raw-sample and command stream, and every file it writes (cubic store, tares, abort thresholds, robust adjustments), through captures, tares, zeros, clears, a profile swap, SIGTERM and a restart |
| `golden/ts.txt` | `run.sh` → `ts_harness.mts` (`npx tsx`) | backend `calibration.ts`, `calibration-handler.ts`, `lc-tare.ts`, `ball-valve-cal.ts`, `routes/calibration-profiles.ts` |

`calibration_main.cpp` is reached only through the built service: the refactor splits that file,
so nothing here compiles it. Fixtures are copied into a temp dir before use; nothing touches the
live `cubic_calibration.json` / `lc_tare.json`. The stack half binds one port: it runs under
`with_stack_lock.sh`. `CHAR_UPDATE=1` regenerates, only on main's code, from the Release build.

## How outputs compare

One golden per output for every build type, OS and arch (`golden_compare.py`): text, integers,
ids, raw codes and hex compare exactly; floats within **4 ULP** of the golden value (published
float32 values, printed with an `f` suffix, in float32 ULP). An unoptimised and a Release build
differ in the last bits (arm64 clang contracts a*b+c into an FMA at -O2), and the refactor will
move this code between translation units.

Four families are ill-conditioned and carry a wider, named limit (`tolerances.txt`); everything
else is 4 ULP. Each limit was measured noopt vs Release (arm64, Apple clang) and shown to still
catch a change of a meaningful size:

| family | values | limit | why | measured noopt vs Release | mutation that must go red |
|---|---|---|---|---|---|
| `rtd-cvd-near-R0` | CVD inverse outputs with \|T\| < 1 °C | abs 1e-11 °C | catastrophic cancellation in (-A + sqrt(A²-4B(1-R/R0)))/2B near R0 | 7.5e-13 °C (2.2e5 ULP) | CVD `A` × (1+1e-9): 6 of these values red (with 72 others) |
| `rtd-cvd` | the rest of the CVD inverse (`T(`, `board(`, T7 `rtd` lines) | rel 1e-13 | same cancellation: a constant ~4e-13 °C absolute error | 106 ULP, rel 2e-14 | same mutation: 46 values red |
| `robust-parameters` | robust learner θ, covariance, RLS P (lib); the service's `adj.json` snapshots (stack) | rel 1e-7 | ridge least-squares seed on a 9-term basis, -O0 vs -O2 | rel 6.8e-10 (lib), 3.7e-10 (stack, 252 values) | `kRidgeLambda` × (1+1e-6): 108 values red |
| `robust-prediction` | robust predictions (`pred` lines) | abs 1e-9 psi | values that should be 0 psi are cancellation residue (~1e-15) | 2.3e-11 psi | same mutation: 39 values red |
| `allan-fit` | `fit` line fields K and tau_min | 8 ULP | 4-column least-squares solve | 5 ULP | K column × (1+1e-12) (fit moves 5e-13 rel): red at 2254 / 3005 ULP |

Mutations of the default 4-ULP rule (each applied, seen red, reverted):

- `PTCalibrationCoeffs::calculate_pressure`, `D` × (1+1e-12): lib red (201 values), stack red
  (46 values, e.g. a published T7 cubic PT value 9e9 float32 ULP off).
- the same function's result × (1+2.2e-15), about 10-17 ULP: lib red (201 values, e.g. 17 ULP).
- `LcTareStore` offset sign flipped: lib red (integer 25 → -25 exact, 15 floats), stack red
  (22 values, `offset_kg` 24.99… → -24.99…).
- `calculatePressure` in `calibration.ts`, `C·x` × (1+1e-12): ts red (86 values).

A known fragility: the same function's result × (1+4.4e-16), about 2 ULP, passes every PT value
but moves robust θ₁ by 1e-5 relative (the seed is that ill-conditioned), so `robust-parameters`
goes red. Recorded as a WP9 constraint: `calculate_pressure` and the robust-seed path must move
bit-identically, and a red robust family is a contract change.

Without the family limits, the unoptimised build fails the Release goldens on 226 lib values and
252 stack values; with them, both builds pass `lib.txt`, `stack.txt` and `ts.txt`.

Not covered: `IMUCalibration.cpp` (commented out of the build; does not compile on main),
`T7Stream` (the LabJack socket layer), `save_coefficients` in `calibration-handler.ts` (writes into
the checkout's `daq-server/calibration/`).

Normalised in the stack golden: wall-clock timestamps within an hour of now, and the robust
preview curve's `fitCurve[].psi` (the robust bias is propagated by wall-clock dt between
predictions, so those values are not a function of the inputs).
