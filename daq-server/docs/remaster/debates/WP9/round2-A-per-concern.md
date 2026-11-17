# WP9 round 2 — A: rebuttal and revised design

Lines are `calibration_main.cpp` on `backend-remastered`; harness paths under
`test/characterization/`. Every opponent claim below was re-checked.

## 1. Conceded

**B's cal.log finding is correct and DESIGN §A's reason for rejecting B is wrong.** `service_run.py:134-148`
opens `cal.log` and gives the service `stdout=log, stderr=STDOUT`; `:245` drops `cal.log` from the
listing; `stack.txt` has no `[Cal]`/`[Calibration]` line (round 1 said so for log *text*; it holds
for *order* too). Lifecycle reads only `'Saved robust adjustments on shutdown'`
and `'[Cal] Stopped.'` (`lifecycle.py:1438-1440`). So "one reordered member changes `stack.txt`'s
startup lines" is false: nothing freezes those lines. The order is still behaviour (AGENT-RULES 4),
and B's fix is the right one: a normalised `cal.log` golden (port masked, a malformed-config run so
`Config.cpp:446-452`'s `[Config]` line has a position to hold) plus a move-only `cmp` of pre/post
`cal.log`. **Adopted as a C0 prerequisite of A** — it guards A's own trap (1404 before 1410 prints
`LC tare: resumed` before `Cubic: resumed`) better than the stale-tare audit.

**B's constructor table holds.** `load` prints only on error (`Config.cpp:446-455`),
`PTCalibrationManager(false)` does nothing (`PTCalibration.cpp:88-92`), both stores store a path
(`CubicCalibrationStore.cpp:32-34`, `LcTareStore.cpp:35`), `ElodinClient()` is a `make_unique`
(`ElodinClient.cpp:10-12`). The order argument against B shrinks to: it is correct today, and it is
held by a header comment list rather than by statement order.

**B's diff-shape count: conceded in the bodies.** My own grep gives 126 lines carrying a captured
local (60/13/53), 15 lambda heads, 3 signatures, 11 `return`s, ~30 call sites gaining `ctx` — ~180
non-dimmed body lines against B's ~60. The gap closes outside the bodies: B turns 27 declaration
lines into members or assignments (660, 670, 675, 679, 684, 689, 708, 724, 749-755, 889, 918,
931-942, 1478, 1513, 1557-1562) and adds a ~110-line class header; A's seven stubs are ~380 lines,
about 150 of them S36 comments B owes too. Roughly 200 vs 560 reviewed lines. §4 makes A's 126
prefix lines mechanical rather than read.

**C's two GCC mechanisms are real.** (a) `static`→`inline` moves a function from
`max-inline-insns-auto` to `max-inline-insns-single` (GCC manual, `--param`), so *whether*
`convert_hp_pt_to_pressure` (62 lines) or `select_pt_psi` is inlined on gcc-12 can change; (b) the
callers shrink from ~1540 lines to 215/84, and GCC throttles growth into large functions
(`large-function-growth`). Round 1 called §6.3 "an argument, not a proof"; C names the two ways it
can fail. Also conceded: C's review-burden count (~540 for A vs ~15 for C) is arithmetic, and C's
deletions (`logged_ch5` with its baseline line as an orchestrator decision, dead `<deque>`/`<mutex>`,
the two C3 duplicates) belong in A's cleanup list; the `resolve_*` merge stays open question 2.

## 2. B's weakest point: what the class is allowed to be

B concedes (§6) that S34 read literally rejects it and "degrades to A". The record is not just the
letter. D45 recorded "a CalibrationService class … lost"; D47's admission rule lets an owner object
enter only in the fix package whose fix is its reason to exist, its single user recorded as the S34
exception. B mints a 30-member owner with ~25 methods in a **move-only** pass, with no fix as its
reason. D43(3)'s carve-out names a *carrier struct* and a *one-call-site extraction*; an
object that owns construction, destruction and the loop is neither. Two traps B must still state:
`last_save` (1559) is initialised *after* `connect_and_register` today; as a mem-init member it starts
at construction, so the 300 s auto-save window gains the connect time — B's `run()` must assign it at
old 1559, exactly as A's `StreamState` must (§4, item 4). And 27 `auto`/`const` locals acquire
spelled-out member types; `pt_board_configs` loses `const`. Each is small; each is a non-dimmed line
A does not have.

## 3. C's weakest point: it protects what did not need protecting

C's by-construction guarantee covers 209 lines whose §6.3 row already reads "no (sub, div, mul)":
nothing fusable, no global read. The fusable code — Blend (300), `step` (2015), the smoother sequence
at 1870-1879 — stays in a 1,900-line `main`, which is what D17(a) and D39 (waiver to ~430, not
~1,900) said to split. C's answer is "steps 2-6 queue after WP10 with nothing redone" (§4.2): then the
same `extern` globals, the same `ctx.` lines, the same G1 and tares-before-reload gates land later,
with the same byte-compare as their only proof. Deferral is not elimination. C's `static`-in-header
has a one-includer precondition the deferred step 2 breaks on day one (a second includer with
`static` means `-Wunused-function` against `baseline_warnings.txt`, D4). C concedes (§5) the
readability loss and that D-SLOT's eventual fix lives inside 2,100 lines under C.

## 4. Revised design A′

Files, carriers, `continue`→`return` list, construction order in `main`: as round 1 and §6.1. Added:

1. **C0 before WP9 (from B):** normalised `cal.log` golden incl. a malformed-config run; move-only
   `cmp` of pre/post `cal.log` on both legs. With round 1's stale-uid Zero All / Tare All (1673,
   1796), G1, G5, tares-before-reload.
2. **Prefix-strip diff (answers B's and C's counts):** `sed -E 's/\b(ctx|st|stream)\.//g'` over the
   new TUs, then `git diff --color-moved` against the parent. After the strip, the only permitted
   non-dimmed lines are includes, namespace lines, `static`→`inline`, 15 heads + 3 signatures, 11
   `return`s, CMake. The 126 prefix lines become a script result, not a reading task.
3. **Two censuses (answer C's mechanisms, flag-free):** on both arm64 legs,
   `nm -C --defined-only calibration_service` filtered to the moved function names — the set with an
   out-of-line copy must be identical pre/post (mechanism (a) and (b) both show up here); and the FMA
   census `objdump -d | grep -cE 'fmadd|fmsub|fnmadd|fnmsub|fmla|fmls'`, equal.
4. **`StreamState` is aggregate-initialised at old 1557**, `last_save{std::chrono::steady_clock::now()}`
   written in `main` at today's position; the stub's bare member would default to the epoch and the
   first ESP32 packet would trigger a save.
5. **Recorded fallback (C's hybrid):** if the gcc-12 byte-compare differs *only* in published float
   values within the 4-ULP golden and a census locates the change in `RawStream.cpp`, step 6 is
   dropped — the T7/ESP32 branches stay in `main` (~730 lines, an S33 waiver recorded in the LEDGER)
   and steps 1-5 ship. The compare is never loosened to admit the diff.
6. **Cleanup list gains C's deletions** (§1), each its own commit with C's proofs.

A′ keeps what C concedes A wins — `main` as a table of contents, `handle_calibration_command(ctx, …)`
as the one future ctest entry, D-SLOT's fix as a one-file diff — and turns B's order finding and C's
failure modes into checks.

## 5. Remaining disagreements

- **B:** whether a 30-member owner minted in a move-only pass is a "carrier" under D43(3) or the
  class D45/D47 refused; I say the latter, B says the judge decides.
- **B:** whether 27 member-type declarations plus a ~110-line header are cheaper to review than 126
  script-checkable prefixes; after item 2, I say no.
- **C:** whether leaving 1,900 lines in `main` satisfies D17(a)/D39 at all; C says per-WP targets
  are not gates, I say the waiver was to ~430.
- **C:** whether "by construction" for 209 non-fusable lines is worth deferring the split of the
  fusable 1,900; I say the censuses give the fusable part an empirical check now.
- **C:** G1/G5/tares-before-reload as gates: they do not gate C, agreed; they guard `main`'s
  behaviour regardless and the LEDGER already lists them as must-close.
