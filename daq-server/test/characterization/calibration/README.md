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

Some values are ill-conditioned or not portable and carry a wider, named limit
(`tolerances.txt`); everything else is 4 ULP. Each limit is the smallest round number that passes
on macOS arm64 Apple clang (-O0 and Release) and Linux arm64 gcc-12 (Release and -O0) and
clang-18 (Release), against goldens generated from macOS Release, and is shown to still catch a
change of a meaningful size:

| family | values | limit | why | worst measured | mutation that goes red |
|---|---|---|---|---|---|
| `cubic-fit-eval` | psi of each cubic-store fit at 5 codes across its span (`eval:` lines) | abs 1e-9 psi | what a reader evaluates; well conditioned | within limit on all five builds | one fixture capture point's psi × (1+1e-9): 60 values red |
| `cubic-fit` | the fit's coefficients (A/B/C/D, rmse, normalised poly; in `print_fit` lines and the store JSON) | rel 1e-12 or abs 1e-11 | `colPivHouseholderQr` least squares: near-zero coefficients are solver residue (Linux gcc: B rel 0.31, D abs 1.4e-11 psi, rmse abs 2.6e-13). The raw A/B/C are below the abs floor, so they are checked through `eval:` and, in the stack golden, every published PT / LC value | same mutation: 62 values red |
| `robust-prediction` | robust predictions (`pred` lines) | abs 1e-9 psi | values that should be 0 psi are cancellation residue (~1e-15) | 2.3e-11 psi | `kRidgeLambda` × (1+1e-6): 39 values red |
| `robust-parameters` | robust θ, covariance, RLS P (lib); the service's `adj.json` (stack) | rel 1e-2 | the 9-term ridge seed is barely identifiable: θ₁ moves 1.4e-5 rel between compilers, 2e-3 rel in `adj.json` after learning; its predictions are the frozen behaviour | rel 2e-3 | (caught through `robust-prediction`) |
| `rtd-cvd-near-R0` | CVD inverse outputs with \|T\| < 1 °C | abs 1e-11 °C | catastrophic cancellation in (-A + sqrt(A²-4B(1-R/R0)))/2B | 7.5e-13 °C (2.2e5 ULP) | CVD `A` × (1+1e-9): 6 values red |
| `rtd-cvd` | the rest of the CVD inverse (`T(`, `board(`, T7 `rtd` lines) | rel 1e-13 | the same constant ~4e-13 °C absolute error | rel 2e-14 | same mutation: 46 values red |
| `rtd-cvd-forward` | CVD R(T) | 8 ULP | gcc -O0 rounding | 5 ULP | same mutation: 26 values red |
| `poly-eval` | type K both ways; the factory-CSV PT cubics (`p(` lines); sensor polynomials (`calc(`); T7 cold junction (`cjc`) | abs 1e-12 (°C, mV, psi) | terms cancel near the result's zero; gcc -O0 rounds each term | abs 7.4e-13 | PT `D` × (1+1e-12): 106 values red |
| `allan` | Allan variance `tau=` lines and the `fit` line | 32 ULP | sums and a 4-column solve, accumulated differently at -O0 | 25 ULP | K column × (1+1e-12): red at 1504-3005 ULP |
| `published-near-zero` | published float32 values (stack) | abs 1e-12 | a fit evaluated at its own zero point is residue (~1e-13) | 1.7e-13 | PT `D` × (1+1e-12): 2 values red |
| `tare-near-zero` | `offset_kg` in the service's `lc_tare.json` | abs 1e-12 kg | a tare taken at the curve's zero | 2.4e-14 | tare sign flipped: 16 values red |
| `curve-fp-hash` | `LcTareStore::fingerprint` values, `fp=`, `"curve_fp"` | ignored | a hash of float outputs bit for bit, so not portable by construction; its behaviour (the `stale=` counts) stays exact | differs on gcc -O0 | (behaviour caught by `stale=`) |

Mutations of the default 4-ULP rule (each applied, seen red, reverted):

- `PTCalibrationCoeffs::calculate_pressure`, `D` × (1+1e-12): lib red (202 values), stack red
  (2 values: published float32 values cannot show a 1e-12 relative change except near zero).
- the same function's result × (1+2.2e-15), about 10-17 ULP: lib red (151 values, 95 of them at
  the default 4 ULP, e.g. 17 ULP).
- `LcTareStore` offset sign flipped: lib red (integer 25 → -25 exact, 15 floats), stack red (16).
- `calculatePressure` in `calibration.ts`, `C·x` × (1+1e-12): ts red (86 values).

The same function's result × (1+4.4e-16), about 2 ULP, now passes everything. Earlier (rel 1e-7
on the robust parameters) it turned the robust family red; the parameters moved 1.4e-5 rel
between compilers on main's own code, so they are compared loosely and the robust predictions,
which do not move, carry the contract.

Text that is not ours is normalised in the harness: NaN prints as `nan` (glibc prints `-nan`), and
a `JSON.parse` failure prints its error class, not V8's message (which differs between Node
versions). The stack golden prints every file snapshot in full rather than as diffs: a value that
moves in its last bits on one platform and not another would change the hunks.

Not covered: `IMUCalibration.cpp` (commented out of the build; does not compile on main),
`T7Stream` (the LabJack socket layer), `save_coefficients` in `calibration-handler.ts` (writes into
the checkout's `daq-server/calibration/`).

Normalised in the stack golden: wall-clock timestamps within an hour of now, and the robust
preview curve's `fitCurve[].psi` (the robust bias is propagated by wall-clock dt between
predictions, so those values are not a function of the inputs).
