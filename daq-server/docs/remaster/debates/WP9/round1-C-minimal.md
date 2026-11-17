# WP9 round 1 — C (minimal): one pure header, delete the rest

Position: buy deletion; protect the TU the 1e-9 psi robust family runs through. Move only what has
no state and no FMA candidate; leave `main`, its lambdas and the stream loop byte-for-byte. Lines: `calibration_main.cpp` @ b2599617. "A" = DESIGN-WP9 §2/§6.1 as
amended (carriers, five TUs); "B" = §A column B (an owning class).

## 1. Design

**Move-only (one commit).** One file, `services/calibration/Conversions.hpp`, namespace
`fsw::calibration_service`, holding verbatim: 263-278 (`kRatiometricPt*`, ratiometric PT), 331-457 (the
HP, TC, clamp, RTD, ACT and LC `convert_*`), 464-477 (`unix_now`, `mono_ns`, the stray comment with
`mono_ns`, S38), 479-530 (`resolve_{pt,lc}_sensor_uid`). 209 lines, 54 of them comment.
Included once, by `calibration_main.cpp`, as `#include "Conversions.hpp"` (quoted, resolves beside the
includer: **no CMake edit**; self-contained, so Regroup may reorder it). Functions **keep
`static`**: with one includer the preprocessed TU is today's TU with 209 lines relocated above the
globals, none of which they name (grep). S27 in its strongest form: no linkage changes.

Cut rule: the header ends at the first function that reads a global, `select_pt_psi` (288), which also
holds the Blend (300). My brief said 263-594; I leave `select_pt_psi`, `select_lc_kg` and
`invert_abort_psi_to_adc` (532-594: `pt_full_scale_for`, `select_pt_psi`) in place on purpose — moving
them drags the eleven globals into `extern` linkage, which is A's step 2.

Everything else goes **nowhere**: globals 73-152, `running`, helpers 156-261, `select_*`,
`signalHandler`, the abort inversion, and all of `main` 596-2139 — the fourteen `[&]` lambdas of §1.3,
the Elodin lambdas, loop head, 0x46 handler, T7 and ESP32 branches, tail. No carrier structs, no
`continue → return`, no `ctx.`/`st.` prefix.

**Cleanup (second item), deletions only, one commit each, with proof.**

| commit | lines | proof |
|---|---|---|
| `logged_ch5` 1558 + `baseline_warnings.txt:7` (orchestrator, D4) | −1 | warnings diff: that line only |
| dead `#include <deque>`, `<mutex>` (sole hit: the include) | −2 | build; `nm --undefined-only` identical |
| `pt_cal_status` 1871-1878 ≡ 2004-2011 (diff modulo indentation: empty) — A's C3 | −6 | `stack.txt` `cal_status` exact |
| `board_number_from_uid` 1067-1069 ≡ 1142-1144 — A's C3 | −1 | integer |
| `resolve_*_sensor_uid` 483-503 ≡ 510-530 (`diff`: parameter names only) → one function, callers 1975/2073 | −22 | integer; **conditional on open question 2** (505-509 gives a blast-radius reason, not a design one) |

`T7Stream.hpp` is live (`kTypeHi` 1826, `calibrated_table_id` 1850). C1 stop handlers: WP8's row, after
WP8 gap 1, as in A. `main`: 2139 → ~1900 — a review and risk gain, not a reading one.

## 2. The four flows (all in `main`, today's lines)

- **Raw ADC sample:** loop head 1564-1627 → ESP32 filter 1913-1940 → decode 1943-1968 → 0x20 branch
  1971-2035: header `convert_*` 1994/1997 → `select_pt_psi` 2000 → `g_pt_smoother.step` 2015 → publish →
  `flush_batch` 2114 → count log and auto-save 2116-2127. Hops out of the TU: the lib only, as today.
- **capture_point (cmd 1):** 1634 length → 1636 dedupe → 1697 `take_capture` → `apply_capture` 1220 →
  `apply_pt_capture` 1110 (lib fit/learn, `sample_robust_curve` 999, saves) → `write_abort_thresholds`
  1032 → `invert_abort_psi_to_adc` 535 → forward lambda 565 (header conversions + `select_pt_psi` 578)
  → `.tmp` + rename 1096-1107.
- **Reconnect** 1565-1578: unchanged; `last_adc_map.clear()` has one writer. A's walkthrough (d)
  concedes move-only A has two until cleanup C2.
- **Elodin down (C6-9):** 1404 tares → 1410 reload → 1424-1431 audit → 1434 `cubic_store.save()` →
  1544 `connect_and_register` false → `return 1`. Untouched; kept (`cpp-service-plumbing.md:169`).

## 3. Against A and B

B loses on the note's own grounds (§A): side-effecting construction order becomes member declaration
order, and a method in its own TU puts the Blend out of line.

**Review burden under A's own §6.1 non-dimmed rule.** A: 14 lambda heads (994-1391), 3 handler
signatures, 11 `continue → return`, ~126 lines gaining a `ctx.`/`st.` prefix (grep of the captured
names: 999-1391: 60; 1631-1821: 13; 1826-2127: 53), 382 lines of new headers (the stubs), CMake. C:
~15 (pragma, includes, namespace, `using`, S36 comment); every moved line dims.

**Float path (D22; LEDGER WP9 row: 8e-10 measured against 1e-9).** C: byte-identity by construction
(same TU, linkage, callgraph); the gate still runs. A rests on "`select_pt_psi` is still inlined at
its three call sites" (§6.3) without addressing two mechanisms: (a) `static → inline` moves every
relabelled function from GCC's `max-inline-insns-auto` budget to the larger `max-inline-insns-single`
(GCC manual, `--param`), so *whether* `convert_hp_pt_to_pressure` (62 lines, callers 570/1994) or
`select_pt_psi` is inlined can change on the gcc-12 leg; (b) the Blend → smoother sequence leaves a
~1,540-line `main` for a ~200-line handler, and GCC throttles inlining into very large callers
(`large-function-insns`, `large-function-growth`). §6.3's table says nothing fusable moves — probably
true; the byte-compare proves it afterwards. C needs neither argument nor table.

**Must-close gaps.** tares-before-reload guards 1404/1410, G5 guards 1544, G1 guards line 300. C moves
none, so none gates it. They should still land, in parallel, off the `WP8 → WP9 → WP10` chain. G1 is the
expensive one: a wall-clock-dependent Blend (C3-1) frozen only after a reseed with no learning,
mutation-proven on three platforms.

**Lines deleted:** equal — every deletion above is available to A (WP10 verdict §3); A lists C3 and
defers the rest. Growth differs: A +~380 header lines and ~160 edited lines in the D22 TU; C +~15.

**Testability and goldens:** equal. §7 "White-box hooks: none"; a test is not S34's second user
(D48(2)). Both byte-identical on `service_run.py`; C cannot move `nm --undefined-only` or the warnings
baseline. Registration at 1484 (`subscription-robustness.md:52`) stays in `main` in both.

## 4. Objections

1. **"WP10's cut rule (ii) — a wire format a different reader reviews — carves `CalibrationCommands`
   (0x46 decode) and `RawStream` (21-byte decode) exactly as it carved `_udp`/`_pwm`."** The verdict
   approved those after fact 4: "clamp + cast, nothing fusable (D22 holds)". Here the stream decoder
   cannot be cut without the fusable Blend → smoother sequence (2000-2015) going with it, and the 0x46
   decoder's every branch is a call to a `main` lambda (`take_capture`, `apply_capture`, `apply_clear`,
   `reload_live_store`), so cutting it drags in A's steps 2-5 — carrier, `extern` globals, header-`inline`
   `select_pt_psi`, G1 back as a prerequisite. Rule (ii) offers no cheap cut here: it is A or C. The
   principled hybrid is A minus step 6 (RawStream stays in `main`, so 1870-1879 and 2000-2015 never leave
   today's TU); it still costs G1 and tares-before-reload.
2. **"Not a split: D39 waived `main` to ~430, not ~1,900; S33."** S33: targets, not gates; D43(9): per WP.
   Record the waiver with its price: A buys 1,500 lines of `main` with three C0 prerequisites and the
   edits counted above. C is A's step 1 minus `static → inline`; steps 2-6 queue after WP10 with nothing
   redone ("C as a prefix of A", WP10 verdict §3).
3. **"`static` in a header is a smell; a second includer duplicates code silently."** One includer by
   design; the S36 comment says so, citing D22/S27; a commit adding a second includer flips it to
   `inline` under the byte-compare. If the judge wants `inline` now: conceded — I lose the
   by-construction proof for 209 lines and keep it for 1,900.

## 5. Concessions

A wins readability outright: `main` as a table of contents in execution order is real; C does not
deliver it. `handle_calibration_command(ctx, …)` is the one function a future ctest could drive.
D-SLOT's eventual fix ("PT2.CH1 smoothed twice") is a one-file diff with a named carrier under A and
lives inside a 2,100-line `main` under C. A's §6.1 checks (literal and float multisets, `nm`,
two-platform `cmp`, `-O0`) are right; C runs them all.
