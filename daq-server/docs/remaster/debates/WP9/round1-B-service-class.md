# WP9 round 1 — B: `CalibrationService`, one owner for `main`'s frame

Advocate B. Lines are `calibration_main.cpp` on `backend-remastered` (product = `main` @ 15b5a0c5);
other paths under `daq-server/diablo_server/`.

**Position.** The ~15 lambdas (999-1259, 1294-1391), the four Elodin lambdas (1483-1542) and the
two stream branches (1823-2127) become member functions of one class whose data members are
today's `main` locals, declared in today's order. `main` is argv (597-651), banner and
`std::signal` (653-657), then `CalibrationService svc(config_path, elodin_host, elodin_port,
adjustments_path); svc.init(); return svc.run();`. Conversions and SensorModels are exactly
DESIGN §2. Only what replaces the lambdas differs from A: members of an owner instead of free
functions over two carriers of references.

## 1. Files (STYLE-S2: `<Class>_<aspect>.cpp`)

| file | contents (verbatim) |
|---|---|
| `CalibrationService.hpp` | members = locals 660-762, 889, 918, 931-942, 1478, 1513, 1557-1562 in that order; declarations of every lambda-turned-member |
| `CalibrationService_init.cpp` | `init()`: 661-1475 statement for statement, calling `load_pt_lc_models`, `load_t7_models`, `register_store_channels`, `print_model_summary` where A does |
| `_actions.cpp`, `_abort.cpp`, `_commands.cpp`, `_stream.cpp` | A's steps 3-6 as members; A's `continue`→`return` list |
| `Conversions.hpp`, `SensorModels.hpp/.cpp` | as A |
| `calibration_main.cpp` | `main`; `running` + `signalHandler` (154, 459-462); **`CalibrationService::run()` defined here** (1544-1627, dispatch, 2130-2139) with `pkt_buf` and `logged_ch5` as its locals; the four Elodin members (1483-1542) |

Defining `run()` in the main TU keeps DESIGN §0 (Elodin code stays in this file), `running` a
file-static, and `unused variable 'logged_ch5'` attributed to `calibration_main.cpp`
(`baseline_warnings.txt:7`). File ~250 lines, `main` ~65.

## 2. Construction order, explicitly today's

DESIGN §A rejects B because "one reordered member changes `stack.txt`'s startup lines or the
tare/reload order". The second half: 1404 and 1410 are consecutive `init()` statements, order
unchanged. The first half, two facts:

**(a) No golden freezes startup line order.** `service_run.py:134` sends the service's stdout to
`cal.log`, `:245` excludes it from the file listing; `golden/stack.txt` has zero
`[Calibration]`/`[Cal]` lines. Lifecycle reads only `Elodin|subscrib` (`lifecycle.py:890`) and
the two shutdown lines (`:1438-1440`). The order is still behaviour (AGENT-RULES 4, 6), so B
proposes the C0 gap A needs too: a normalised `cal.log` golden (port masked) with a
malformed-config run, and a move-only `cmp` of pre/post `cal.log`.

**(b) One constructor among `main`'s locals does I/O.** Rule: the mem-init-list constructs only
objects whose constructor has no effect; every statement that prints, reads or writes is in
`init()` at today's position.

| local | ctor effect | in B |
|---|---|---|
| `cal_cfg` 660 | `config::load` prints `[Config]` on bad TOML (`Config.cpp:446-452`) | **first** in the mem-init-list: today's first effectful statement after 657 |
| `pt_calibration(false)` 670 | none (`PTCalibration.cpp:88-92`; the default arg `true` would auto-load, so `(false)` stays) | mem-init |
| `robust_manager` 675 | `= default` | mem-init |
| `tc/rtd/lc_calibration` 679-689 | stores 3 fields (`SensorCalibration.hpp:74-77`); the prints are the `load_calibration` **calls** | mem-init; calls in `init()` at 680-692 |
| `active_boards` 708, `pt_board_configs` 724 | each calls `config::load` (`LoadActiveBoards.cpp:14,18`): a `[Config]` line after the 694-702 prints | assigned in `init()` at 708/724 (`pt_board_configs` loses `const`) |
| `t7_map(cal_cfg)` 889 | pure (`T7Calibration.cpp:37-52`; the T7 stderr line is `main`'s 890-893) | mem-init (const) |
| `cubic_store`, `lc_tare_store` 931/938 | store a path (`CubicCalibrationStore.cpp:32-34`, `LcTareStore.cpp:35`) | mem-init; `register_channel` calls in `init()` at 943-992 |
| `capture_window`, `sub_tracker`, `command_dedupe` | none | mem-init |
| `elodin_client` 1478 | `make_unique<TCPClient>` (`ElodinClient.cpp:10-12`; `TCPClient.cpp:16-18` reserves a buffer) | mem-init |

Destructors: only `~ElodinClient` has an effect (`disconnect()`, `ElodinClient.cpp:14-16`;
prints only if connected, `:62-69`). Today it runs at `main`'s `}` after `[Cal] Stopped.`; in B
`svc` dies at the same `}`. On C6-9's `return 1` it is unconnected: silent, as today. Every other
destructor is trivial or `= default`, so reverse declaration order is unobservable. The header
carries one comment per member with its old line; the review checks that list against 660-1562
once.

## 3. What B buys

**Diff shape, countable.** A's §6.1 admits as non-dimmed every `ctx.`/`st.` prefix and every
call that gains a context argument. Over 999-1391 and 1630-2127, `grep -ow` finds `cubic_store`
29, `robust_manager` 16, `lc_calibration` 12, `pt_calibration` 11, `lc_tare_store` 11,
`elodin_client` 11, `capture_window` 7, `last_adc_map` 5, … ≈ 140 occurrences (upper bound,
comments included), plus 34 lambda call sites (`take_capture` 6, `reload_live_store` 4,
`apply_capture` 4, …). In B members keep today's names, so those ~170 lines are dimmed verbatim.
B's allow-list is A's minus the prefix and context-argument items, plus a data-member declaration
of today's local's type and a mem-init entry with today's arguments: in the moved bodies ~60
lines to review instead of ~230, and one header list to check against 660-1562.

**One owner, fewer amendments.** `last_adc_map.clear()` at 1575 has one writer, so the
`on_elodin_reconnected` amendment does not arise. Cleanup C2 is the same move for B, but
`g_hp_ma_live`, `g_pt_smoother`, `g_t7_cold_junction_c` become members with no referencing
struct; the `CalibrationContext.hpp` amendment (four headers, an include cycle) is moot.

**Direction for fixes (STYLE-S8a, S11).** C6-9's inverse (observation class, startup transient →
retry) is a loop around `connect_and_register()` inside `run()`, no signature touched; D-SLOT's
exit 78 is a check ending `init()`. Testability in WP9 is nil either way (README: reached only
through the binary; D20); B only makes a future in-process construction possible. Lines deleted:
~0, as A; B's ~110-line class declaration replaces five of A's seven headers, about the same total.

**Against C.** C puts the Blend expression and `PtSmoother::step` behind virtual calls in other
TUs (§A: float path high), and a rewrite cannot keep the literal multiset or `nm --undefined-only`
identical; B shares none of that. C's per-stage testability is equally unavailable to B: the
stages write files and publish, and the goldens are black-box.

## 4. Float path (D22)

Same placement, same argument-not-proof, same checks. `select_pt_psi` (Blend, 300) and
`select_lc_kg` stay free `inline` in `SensorModels.hpp`, inlined at the same three sites;
`PtSmoother::step` (`PtSmoothing.hpp:30`) is inlined into `handle_esp32_raw`/`handle_t7_raw`,
out-of-line members of `_stream.cpp` — a TU indistinguishable from A's `RawStream.cpp` except
`this->member` for `ctx.ref`: one fewer load, no change to the expression trees
`-ffp-contract=fast` fuses. Lib untouched; `nm --undefined-only`, literal/float multisets,
byte-identical `service_run.py` on macOS and Linux arm64 gcc-12, `-O0` once, all as §6.1.

## 5. Flows

- **Raw ADC:** `run()` loop head (reconnect, due re-subscribe, read, header, `debug_limit`
  member) → `handle_esp32_raw` → `select_pt_psi` → `g_pt_smoother.step` → one batch → count log
  and 5-min save (ESP32 tail only).
- **capture_point:** `handle_calibration_command` (dedupe, memcpy decode, log) → `take_capture`
  → `is_lc_uid` → `apply_capture` → store/fit/robust/save → `write_abort_thresholds`.
- **Reconnect:** loop head: 2 s sleep, `reconnect()`, `register_calibrated()`, `subscribe_all()`,
  timeout, `capture_window.clear(); last_adc_map.clear();`, log.
- **Elodin down (C6-9):** `init()` has written `abort_thresholds.txt`, the store and stale tares;
  `connect_and_register()` fails → `run()` returns 1 → `main` returns 1; no shutdown save.

## 6. Conceded

- **S34 read literally** ("a new class") rejects B; `CalibrationController` died on it (§5) and D45
  recorded B as lost. My reading is D43(3): a class that only moves code — no interface, virtual,
  template, callback type or knob; one instance; nothing substitutable — is the carrier struct
  that owns instead of references. If the judge holds the letter, B degrades to A.
- **Names.** Members keep today's names (`cubic_store`, not `cubic_store_`): S7 forbids move-only
  renames and the dimmed diff depends on it. Cleanup owes a recorded S3 exception or a rename
  pass touching the D22 TUs, each commit byte-checked.
- `pt_board_configs` loses `const`; `debug_limit` (1621) becomes a member, as in A.

## 7. Objections

1. *"Order lives in a header nobody reviews as behaviour."* §2(b): one constructor has an effect
   and it is first; the rest are silent by their bodies; everything else is `init()` statements
   in `main`'s old order. B adds the `cal.log` cmp that makes order mechanical, which A's checks
   (stack golden, literals, `nm`) never test.
2. *"A member function in another TU changes inlining."* So does A's free function in
   `RawStream.cpp`; the contractible expressions are header-inline in both. Nothing in GCC's
   inliner or `widening_mul` distinguishes a member from a free function of the same linkage.
3. *"`[this, uid]` in the evaluator outlives the object."* One thread (§1.4); the evaluator is
   used only inside `LcTareStore` calls (`const Evaluator&`); `svc` lives for the process — the
   facts the design already grants `[&ctx, uid]`.
