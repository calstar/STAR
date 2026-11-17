# WP9 round 1 — A: TUs per concern + two carrier structs (the reviewed design)

Lines are `calibration_main.cpp` on `backend-remastered` (product = `main` @ 15b5a0c5); `§` is
DESIGN-WP9. `current_loop_board` has two callers, 1070 and 1973, both after `ctx` exists (old 992).

## 1. Files and ownership

| TU (`services/calibration/`, linked into `calibration_service` only) | moved verbatim | owns |
|---|---|---|
| `Conversions.hpp` | 263-278, 331-457, 464-477, 479-530; `static`→`inline` | conversions, clocks, uid resolvers; nothing fusable (§6.3) |
| `SensorModels.{hpp,cpp}` | enums 91/127; globals 80-150 minus three stream globals (`extern` until C2); 156-261, 286-329 inline; 773-879, 894-911, 943-992, 1436-1472 as the `load_*`/`register_*`/`print_*` functions | which model each uid streams; **`select_pt_psi` with the Blend expression (300), header-inline at its three call sites 577, 1879, 2004** |
| `CalibrationContext.hpp` | — | 14 members: 11 references to `main`'s locals, 3 `const double` copies (stub) |
| `CalibrationActions.{hpp,cpp}` | 727-732, 999-1259, 1294-1391 in textual order; 15 lambdas → same-named functions | capture/clear/tare/reload; the `LcTareStore::mutex_` → evaluator nesting (`LcTareStore.hpp:77-112`: `const Evaluator&`, never stored) |
| `AbortThresholds.{hpp,cpp}` | 532-594 static, 1032-1108 | the one writer of `abort_thresholds.txt` |
| `CalibrationCommands.{hpp,cpp}` | 1631-1819 | 0x46 decode, cmd 0-8 dispatch; dedupe passed in |
| `RawStream.{hpp,cpp}` | 1827-1910, 1913-2127; `g_hp_ma_live`, `g_pt_smoother`, `g_t7_cold_junction_c` in its anonymous namespace | `StreamState` (1557-1562 + `debug_limit`), T7 and ESP32 handlers with the 10000-log and auto-save tail |
| `calibration_main.cpp` (~430, waived D39) | 596-760, 889-893, 913-938, 1261-1283, 1393-1435, 1474-1627, three dispatches, 2130-2139 | argv, **every construction at today's statement**, signals, Elodin connect/register/subscribe/reconnect (1483-1548: one of two registrars, research subscription-robustness §0; order frozen by the elodin golden), loop head, shutdown |

`g_uid_role` (global, 780-830, 897) and `uid_role` (main local 913-921, passed to
`save_adjustments`) stay distinct; `pkt_buf` and `logged_ch5` (1558) stay in `main`.

## 2. Four flows

**Raw ESP32 PT sample.** Loop head 1564-1627 unchanged (reconnect, `due()`, read, ErrorResponse,
header bytes, `stream.debug_limit < 10` log) → `handle_esp32_raw(ctx, st, pkt_buf, len, hi, lo)`:
filter 1913-1939 (`continue`→`return` before `begin_batch`) → decode → `begin_batch` →
`current_loop_board(ctx, …)`, `resolve_pt_sensor_uid` (Conversions), `st.last_adc_map[uid]`,
`ctx.capture_window.push`, lib cubic and robust (out of line, `PTCalibration.cpp:313-322`,
`RobustCalibrationManager.cpp:185-191`), `convert_hp/ratiometric`, `select_pt_psi` (inline),
`psi = g_pt_smoother.step(uid, psi)` (2015, same statement sequence), clamp, publish →
`flush_batch` → `++st.packet_count` → 10000 log → 5-min save (2116-2127, ESP32 tail only).

**capture_point (0x46, cmd 1).** `handle_calibration_command(ctx, command_dedupe, …)`: `pkt_len ≥
24`, `seen()` (1637 → `return`), memcpy decode, "Received" log → `take_capture(ctx, uid, "Capture
ref")` (REJECTED if stale) → `apply_capture` → `is_lc_uid` → file-static `apply_pt_capture`:
`add_point` (fit, lib) → `set_calibration` → `update_calibration` → `set_fit_curve(sample_robust_curve)`
→ `cubic_store.save()` → `save_adjustments` → `write_abort_thresholds(ctx)` (bisection over
`select_pt_psi`, `.tmp` + rename). `main`: 1820 `continue`. No reply exists; `stack.txt` freezes
the files and the next published frame.

**Reconnect.** 1565-1578 stay in `main` verbatim: `retrying in 2s`, uninterruptible sleep,
`reconnect()`, `register_calibrated`, `subscribe_all` (result ignored), timeout 1000,
`capture_window.clear()`, then the one edited statement `stream.last_adc_map.clear()` (C2:
`on_elodin_reconnected`), `[Cal] Reconnected`. The next capture is REJECTED (window empty). G3 is
open; no golden sees this.

**Elodin down (C6-9).** Everything through 1472 runs in today's order: `lc_tare_store.load()` 1404
→ `reload_live_store(ctx, true)` 1410, whose tail 1385-1389 writes `abort_thresholds.txt` and
`lc_tare.json` → stale audit → `cubic_store.save()` 1434 → `print_model_summary()` → 1525-1528
stderr → `return 1` at 1544; 2130-2135 never runs, so no `adj.json`. `main` owns every object, so
destruction order is today's. G5 freezes exit 1 + the two files.

## 3. Why A, with evidence

| axis | A | B (`CalibrationService` class) | C (stage pipeline) |
|---|---|---|---|
| clarity: construction order | `main`'s statements: `load` prints (660), store ctors 927/935, tares 1404 before reload 1410 — reviewed as behaviour, `--color-moved` dims them | member declaration order in a header; one reordered member moves the "after startup" snapshot or the tare/reload order (§A) | rewrite |
| float path (D22, LEDGER WP9 row) | Blend (300) and `PtSmoother::step` (`PtSmoothing.hpp:24`, `alpha_*v + (1-alpha_)*prev`) stay inline in the same statements, same flags (no `-ffp-contract` anywhere; `CMakeLists.txt:14` adds only `-Wall…`); lib diff empty | same only if every method stays inline-able | Blend and smoother behind interfaces in other TUs; GCC `-ffp-contract=fast` sees new code |
| lines deleted | ~0 move-only (D12(e)); C2/C3 ~40 | ~0, +~120 declaration | negative |
| testability | identical: black-box only (D20; `calibration/README.md`: reached only through the binary) | identical | per-stage tests in principle; stages write files and publish |
| harness edits | none; byte-identical `service_run.py` pre/post, literal multisets, `nm --undefined-only` | none | multiset and `nm` checks fail |
| S34/D43(3) | carrier structs ruled "not an abstraction" | single-user class, refused once (BLOAT-MAP `CalibrationController`, §2) | one implementation per interface |

**Honest cost.** A's "same inlining context" (§6.3) is an argument, not a proof: the callers shrink
from a ~1540-line `main` to a 215-line `handle_esp32_raw` and an 84-line `handle_t7_raw`, and GCC's
inliner weighs caller size. Bounds: both fusable expressions are single statements (the Blend
result enters `step` as a *multiplicand*, so no cross-statement `a*b+c` spans them); published
values are float32 at 4 ULP; byte-identical pre/post runs on both legs.
**Improvement 1:** add an FMA census to §6.1 on both arm64 legs — `objdump -d calibration_service
| grep -cE 'fmadd|fmsub|fnmadd|fnmsub|fmla|fmls'` pre/post, equal. Flag-free; it catches a
contraction change float32 rounding would hide.

**Improvement 2 (coverage of §4's traps).** `stack.txt` freezes frames and file snapshots only;
log text goes to `cal.log`, held by the literal multiset (G9). Of the three inner-loop
`continue`s that *stay*: 1789 is guarded ("tare clear all" over four standing tares; a `return`
skips the remaining clears and the `save()` at 1815, so the snapshot goes red). **1673 and 1796 are
not**: they fire only when `take_capture` refuses inside Zero All / Tare All, and `burst()`
(`service_run.py:430-446`) ticks 10 s then sends 10 fresh samples per uid in `every` (509-518),
which covers every uid the window holds (pushes: 1861, 1884, 1984, 2076). Add to the must-close
list a Zero All and a Tare All with one stale uid (C0, test-only). The compiler catches the opposite
error: an outer-loop `continue` left in a moved body is "continue not in loop".

## 4. Objections, answered

**O1 — "Fourteen members in a struct is a class without the honesty; `ctx.` touches ~130
lines."** 60 lines in 999-1391, 13 in the command body, 53 in the stream; each a permitted
non-dimmed line (§6.1). No constructor logic, methods or ownership — D43(3) ruled on exactly this.
The one thing a class would own, construction order, is what A refuses to move out of `main`.
`this->cubic_store` versus `ctx.cubic_store`: neither is clearer; only one freezes order in a header.

**O2 — "`extern` globals read from four TUs: S24/S26/S27 and a static-init hazard."** Moved, not
new (STYLE precedence: move-only applies only its note's rules); default-constructed containers,
no cross-TU initialiser, no reader before `main`; `g_` matches S3; the linkage change is listed
(§8). A models struct would edit every lookup in 156-329 — C2's job, once the move is proven.

**O3 — "Eleven `continue→return` sites plus three traps; B keeps the loop whole."** B's methods
contain the same inner loops, so the trap is B's too. Conceded: today's golden misses two of the
three; Improvement 2 is the test-only fix. The per-site list (§4) plus the compiler covers the
other direction.

Conceded: testability and lines deleted do not separate A from B in move-only.
