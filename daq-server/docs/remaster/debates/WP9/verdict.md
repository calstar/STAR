# WP9 verdict — split `calibration_main.cpp`

Lines are `calibration_main.cpp` on `backend-remastered` unless named; every claim was re-read at
`git show backend-remastered:daq-server/<path>`.

## 1. Fact rulings

1. **No golden freezes startup stdout (B, true).** `service_run.py:134-148` runs the service with
   `stdout=cal.log, stderr=STDOUT`; `:245` drops `cal.log` from the listing; `golden/stack.txt`
   has 0 `[Cal`/`[Calibration` lines in 42,382; lifecycle reads only `Elodin|subscrib`
   (`lifecycle.py:890`) and two shutdown strings (`:1438-1440`); the "after startup" snapshot
   (`stack.txt:681`) is files and frames. DESIGN §A's reason for rejecting B is **false**. The
   order is still behaviour (AGENT-RULES 4); its guard is B's `cal.log` golden, nothing existing.
2. **Inner-loop `continue`s (A, true; B confirms).** 1673, 1789, 1796 are inner-`for` continues.
   `burst()` (`service_run.py:430-446`) ticks 10 s then sends 10 fresh samples per uid in `every`
   (`:509-518`) before cmd 0 and cmd 8, so 1673/1796 (refused capture inside Zero All/Tare All)
   never fire in the golden. 1789 **is** exercised: `clearing = ref_val >= 0.5f`; the harness
   sends `cmd(8, 0, 1.0)` (`:522`). A wrongly `return`ed 1673 or 1796 passes today's golden.
3. **Constructor-effect table (B, true on every cite).** `config::load` prints only in its
   `catch`es (`Config.cpp:442-456`); `PTCalibrationManager(false)` skips the load
   (`PTCalibration.cpp:88-92`); both stores store a path (`CubicCalibrationStore.cpp:32-34`,
   `LcTareStore.cpp:35`); `ElodinClient()` is a `make_unique` (`ElodinClient.cpp:10-12`);
   `load_active_boards`/`load_pt_boards` call `load` (`LoadActiveBoards.cpp:12-19`).
4. **`last_save` (A item 4, B's trap: true).** `auto last_save = steady_clock::now()` at 1559,
   *after* `connect_and_register` (1544). The stub's bare `time_point last_save;` is the epoch:
   the first ESP32 packet satisfies `> 300` s (2124) and saves (§4 item 7).
5. **`current_loop_board`**: defined 727-732, called at 1070 and 1973 only.
6. **Float path.** Blend 300: `(1.0 - kFactoryWeight) * psi_rob + kFactoryWeight * psi_fac`;
   smoother `PtSmoothing.hpp:30`: `alpha_ * value + (1.0 - alpha_) * it->second`; sequence
   1870→1879 and 2000→2015 with integer `cal_status` between. The Blend result is `value`, a
   *multiplicand*: no `a*b+c` spans the two statements. GCC 12 `params.opt`:
   `max-inline-insns-single` Init(70), `max-inline-insns-auto` Init(15), `large-function-insns`
   2700, `large-function-growth` 100 % (the single = declared-inline / auto = the rest scoping is
   the manual's `--param` prose, not re-fetched here). C's two mechanisms are real: they
   change *whether* a `convert_*`/`select_*` inlines on gcc-12, not the expression trees, and
   the censuses see exactly that. Verify on the leg: `g++-12 -O2 -Q --help=params`.
7. **C's 209 lines** (263-278, 331-457, 464-477, 479-530) name no `g_*`; 11 `static`
   functions. Dead `<deque>`/`<mutex>` (lines 35, 41 only) and `pt_cal_status` 1871-1878 ≡
   2004-2011 modulo indentation: true.
8. **`static` in a header.** GCC's `-Wunused-function` fires on an unused header `static` in every
   including TU; clang, as I recall, suppresses it outside the main file, and
   `baseline_warnings.txt` is clang/macOS only (D4). Safe at one includer; a hazard from step 3
   on (≥3 includers).
9. **New: byte-identical `cmp` is not proven feasible.** `adj.json` carries `theta_mean`/
   `theta_cov` at full precision (`stack.txt:7352+`); the normaliser masks only timestamps and
   `fitCurve[].psi` (`service_run.py:264-290`); the robust path has a wall-clock input upstream
   of the θ update — predictions propagate the bias by steady-clock dt
   (`RobustCalibrationFramework.cpp:326-333`) and `add_calibration_point`'s residual includes
   `bias_contribution()` (`:377-386`) before `bayesian_update`. Whether it reaches `adj.json` is
   settled empirically (§2). DESIGN §6.1 and the brief assume unconditional identity.
10. Lib is `SHARED` (`lib/CMakeLists.txt:45`); the service is one TU today
    (`services/CMakeLists.txt:45`); no `-ffp-contract` anywhere: censuses on the service binary
    cover exactly the moved code.
11. **S34/D45/D47.** B's class is "a new class", one instance; D45 recorded it lost; D47 admits an
    owner object only with the fix that is its reason. B concedes the letter (round 2 §4).

## 2. Decision

**A′ — TUs per concern with two reference carriers — with B's facts and C's censuses.** B loses
on S34's letter, D45 and D47: a 30-member owner minted in a move-only pass with no fix as its
reason is what those rulings refuse; its one real gain (dimmed prefixes) is matched by A′'s
prefix-strip diff. C loses on D39: WP9 is the split to ~430 and C leaves ~1,900; its
by-construction proof covers the 209 lines §6.3 already shows non-fusable.

**Files.** DESIGN §2 plus the `CalibrationContext.hpp` amendment: `Conversions.hpp`
(`inline`, not `static` — fact 8), `SensorModels` (`extern` globals until C2; `select_*`
header-inline), `CalibrationContext.hpp`, `CalibrationActions`, `AbortThresholds`,
`CalibrationCommands`, `RawStream`, `calibration_main.cpp` ~430. Carriers, not a class;
construction order stays `main`'s statements; `last_adc_map.clear()` stays in `main` in
move-only, C2's `on_elodin_reconnected` stands.

**Queue.** One move-only item with two internal checkpoints (the D49(10) shape): checkpoint 1 =
steps 1-5; checkpoint 2 = step 6 (RawStream) on top. At each: the `cmp` (as redefined below), per-symbol FMA census,
defined-symbol census, `nm --undefined-only`, literal and float multisets, warnings, lib diff
empty. **Fallback:** a diff at checkpoint 2 only → re-cut to steps 1-5, `main` ~730 with an S33
waiver in the LEDGER, step 6 "not queued" until a package with a reason (D-SLOT's fix; RawStream
is Tier 0 code, so C's D47 analogy does not bind it). A diff at
checkpoint 1 → the package stops (§6.3). The compare is never loosened. Cleanup is the next item
(C1 after WP8 gap 1; C2; C3 plus C's deletions; `logged_ch5` and the `resolve_*` merge are
orchestrator/team calls).

**C0 prerequisites.** All five are test-only, D32-batchable, start now in parallel with WP8, and
gate checkpoint 1 (step 2 relocates line 300; step 3 moves 1294-1391):
| package | guards | moved by |
|---|---|---|
| `cal.log` golden (normalised, port masked, one malformed-config run so `Config.cpp:447` has a position) + pre/post `cmp` | startup print order; 1404 before 1410 | steps 2-3 |
| Zero All and Tare All with one stale uid | 1673, 1796 stay `continue` | step 5 |
| tares-before-reload mutation (DESIGN §7) | 1404→1410 | step 3 |
| G5 Elodin-down exit 1 after `abort_thresholds.txt` and the store, no `adj.json` | 1385-1389, 1544 | step 3 |
| G1 Blend reseed (`kFactoryWeight` 0.25→0.75 red) | line 300 | step 2 |
WP9 precedes WP10 as the LEDGER orders; if only G1 is not green when the rest is, the orchestrator
may run WP10 first and queue WP9 after it — the one sequencing point C wins.

**Float-path checks.** (a) *Pre/pre first:* two runs of the unchanged Release binary per leg
(macOS, Linux arm64 gcc-12); every field they disagree on is masked and listed in the merge row
(expected: at most `adj.json` θ/cov — published values are deterministic, no robust role
streams); everything else `cmp` byte-identical pre/post. (b) `objdump -d` split on `<…>:`,
`grep -cE 'fmadd|fmsub|fnmadd|fnmsub|fmla|fmls'` per moved symbol, equal. (c) `nm -C
--defined-only` on the moved names, compared demangled and unqualified: pre `_ZL…` `t`, post
`fsw::calibration_service::…` `W` — the *set* with an out-of-line copy must match, the kind
change accepted. (d) `nm -C --undefined-only | sort` identical. (e) Both goldens on both legs plus
the `-O0` run (D22). This Mac's `build/` is -O0, not evidence.

## 3. Best argument from each side

- **A:** `main` as a table of contents with construction at today's statements; that today's
  golden does not exercise 1673/1796; the FMA census and prefix-strip diff that turn B's and C's
  counts into scripts. Lost: §A's order argument against B (fact 1).
- **B:** the `cal.log` finding — the design's worst-named trap had no guard — and the
  constructor-effect audit, both adopted. Lost: the class, on S34/D45/D47, conceded.
- **C:** naming the two GCC mechanisms with their parameters, which made the censuses necessary;
  that A's prerequisite ledger grew to five and the deletions are design-independent. Lost: a
  ~1,900-line `main` against D39; `static` in a header.

## 4. Edits DESIGN-WP9.md and the stubs need

1. §A column B / "Why B lost": replace the false golden claim with fact 1 and S34/D45/D47; record
   the `cal.log` golden as the guard.
2. §6.1 "byte-identical": the pre/pre procedure of §2(a), mask in the merge row; censuses (b)-(d)
   with the `t`→`W` caveat; the prefix-strip diff (`sed -E 's/\b(ctx|st|stream)\.//g'`).
3. §6.1 steps: the two checkpoints, the fallback, "a diff at checkpoint 1 stops the package".
4. §7 must-close: add the `cal.log` golden and the stale-uid Zero All/Tare All; state G1 gates
   step 2 (line 300 moves there), G5 and tares-before-reload step 3, stale-uid step 5.
5. §4: note 1673 and 1796 are unexercised by today's `stack.txt`.
6. §6.2 cleanup: dead `<deque>`/`<mutex>`, each its own commit with `nm --undefined-only`
   identical; `logged_ch5` stays open question 5.
7. `RawStream.hpp` stub: `last_save` is written by `main` at old 1557's position (aggregate
   init with `steady_clock::now()` or an assignment immediately after); a bare member is the
   epoch and the first ESP32 packet saves.
8. `Conversions.hpp` stub: one line on why `inline` (≥3 includers; GCC warns on unused header
   `static`s; budget change censused).
9. §6.3: the GCC 12 parameter values (fact 6); the censuses, not the table, are the evidence.
10. LEDGER: a D-row for this verdict; D39's waiver with the ~730 fallback.

## 5. Remaining team questions

1. Open questions 2 (`resolve_*` merge) and 5 (`logged_ch5` + its baseline line).
2. Should the `cal.log` golden also freeze the `[Calibration]` count lines nothing reads?
3. Should `adj.json`'s θ/cov be masked permanently in the stack golden (rel 1e-2, no contract;
   the predictions carry it), once the pre/pre run shows the spread?
4. C6-9's inverse (startup retry, S11) and D-SLOT's fix are fix packages with their own goldens,
   not WP9's.
