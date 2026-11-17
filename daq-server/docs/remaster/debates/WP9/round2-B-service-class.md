# WP9 round 2 — B: rebuttal and revised design

Lines are `calibration_main.cpp` on `backend-remastered` (product = `main` @ 15b5a0c5).

## 1. Where I am beaten

- **A's FMA census: adopted.** `objdump -d calibration_service | grep -cE
  'fmadd|fmsub|fnmadd|fnmsub|fmla|fmls'` pre/post on both arm64 legs is flag-free and sees what a
  float32 publish at 4 ULP hides. Refinement, since a count stays equal while one fusion moves:
  per symbol (`objdump -d --no-show-raw-insn`, split on `<…>:`). B's members keep today's names, so
  symbols map by name; A's lambdas map by order. The lib is `SHARED` (`lib/CMakeLists.txt:45`), so
  the census covers exactly the moved code.
- **A's inner-loop finding: confirmed and shared.** `burst` (`service_run.py:430-446`) sends 10
  fresh samples per uid in `every` (`:509-518`) before cmd 0 and cmd 8, so 1673 (`Zero All`) and
  1796 (`Tare`) never fire; only 1789 (`clearing`: four tares and the `save()` at 1815 skipped) is
  guarded. A wrongly `return`ed 1673 or 1796 passes today's golden under A **and B** (the same
  loops move into `handle_calibration_command` in both). A's C0 case — Zero All and Tare All with
  one stale uid — is a must-close for B too.
- **C's two GCC mechanisms are real.** (a) `static` → `inline` moves a function from the
  `max-inline-insns-auto` budget to the larger `-single`; (b) growth into a large caller is
  throttled (`large-function-insns`/`-growth`), and a 1,540-line `main` is plausibly over that line
  while a 215-line handler is not — *more* may inline after the split. Both can change which
  `convert_*`/`select_*` body is inlined on gcc-12. Neither creates a contraction:
  `-ffp-contract=fast` fuses `a*b` with the add that consumes it, and across every moved boundary
  the crossing value is a *multiplicand* — the Blend result enters `step` as `alpha_ * value`
  (`PtSmoothing.hpp:30`); `convert_hp`'s `((i-4)/16)*fs` is multiplied again. A's bound, B's bound;
  C's "by construction" is stronger than any bound: conceded.
- **The three must-close gaps are off C's path.** True: C moves neither 1404/1410, 1544 nor line
  300. But C's cleanup edits the D22 TU at 2004-2011 (`pt_cal_status`, between `select_pt_psi` 2000
  and `step` 2015) and 1975/2073, and C's §4.2 queues A's steps 2-6 "after WP10" — G1 and
  tares-before-reload are deferred, not avoided. Legitimate (D43(9)); not a saving.

## 2. A's weakest points

**A1. The order argument rests on a false golden.** §3 still says a reordered member "moves the
'after startup' snapshot or the tare/reload order". The snapshot (`stack.txt:681`) is files and
frames produced by *calls* — `reload_live_store` 1410, `cubic_store.save()` 1435 — consecutive
`init()` statements in B, as are 1404/1410. No startup print is in any golden (`service_run.py:134`,
`:245`; zero `[Cal]` lines in `stack.txt`). One member constructor does I/O (`config::load`, 660)
and it is first; the traps, `load_active_boards`/`load_pt_boards` (`LoadActiveBoards.cpp:14,18`),
B assigns in `init()` at 708/724. A disputes no row of that table. "`main`'s statements, reviewed
as behaviour, dimmed by `--color-moved`" describes B's `init()` exactly.

**A2. A's review-burden argument against C indicts A relative to B.** A's own count: 126
`ctx.`/`st.` lines (60 + 13 + 53) plus context arguments on ~34 call sites, each "permitted".
Permitted is not free: §6.1 makes any *other* non-dimmed line a review stop, so the reviewer reads
all ~160 to find the one that is not a prefix. In B they are dimmed verbatim; the non-dimmed set is
signatures, braces, includes, 11 `return`s and one header list checked once against 660-1562.
"Neither is clearer" (O1) is true of a line and false of the diff.

**A3. Two writers of RawStream's state are a carrier artefact.** The `on_elodin_reconnected`
amendment exists because `last_adc_map` lives in `StreamState` but is cleared from `main` (1575).
One owner, one writer, no amendment; likewise C2's "`SensorModels` value referenced from
`CalibrationContext`" adds a second carrier where B's members already are the value.

## 3. C's weakest points

**C1. C is not the work package.** D17(a) and D39 set WP9 as a split with `main` at ~430 after
move-only; C leaves it at ~1,900 (C's number) and asks the judge to waive the DoD by the same
mechanism — a recorded ruling overturned in debate — that C says disqualifies B under D45. C's §5
concedes A "wins readability outright"; readability was the point.

**C2. C's cleanup edits the TU it promised not to touch.** `pt_cal_status` (1871-1878 ≡
2004-2011) and `resolve_*` (1975, 2073) sit in the ESP32 PT path whose Blend → smoother sequence
C protects. Integer-only, yes; but afterwards "same TU, same callgraph, by construction" is gone and
C needs A's checks, which it already runs.

**C3. `static` in a header.** Correct today (one includer; the `convert_*` name no global), fragile
by design: a second includer silently duplicates code, and C's own fix is A's step 1. The
by-construction proof covers 209 pure lines with no fusable pattern (§6.3) — the lines that never
needed it.

Where C is right: `<mutex>` and `<deque>` are dead (grep: the include lines only); `logged_ch5`
is the orchestrator's call (D4); every deletion is available to every design.

## 4. S34 and D45

Honestly: **B does not survive S34 read as written.** S34 lists "a new class" as an abstraction
and names WP9's carrier structs as the not-abstraction case; D45 recorded the class as lost; D47
built WP10's tiers on "no collaborator object". B's argument is that the recorded *reason* in
DESIGN §A is wrong in its first half (no golden freezes startup lines) and answered in its second
(`init()` keeps 1404 → 1410), and that D43(3)'s purpose test — "only moves code; a new shared
behaviour needs ≥2 users" — is met: one instance, no virtuals, no second user, nothing
substitutable. A judge may amend S34's definition to say so; a judge who holds the letter should
rule against B, and I would not call that wrong. So the revised design is written to lose
gracefully.

## 5. Revised design, B′

A's TU map, checks and must-close list, with one change in what carries `main`'s frame:

| | A | B′ |
|---|---|---|
| TUs | A's seven | the same, S2-named `CalibrationService_{actions,abort,commands,stream}.cpp` where they define members |
| carrier | `CalibrationContext` (11 refs + 3 doubles), `StreamState` (5 refs + 4 owned) | one **owning** `struct CalibrationService`: members = locals 660-1562 in today's order; mem-init only for ctors proven silent (round 1 §2), `cal_cfg` first; `active_boards`/`pt_board_configs` assigned in `init()` at 708/724 |
| lambdas → | free functions over `ctx`/`st` | member functions, bodies verbatim, no prefix |
| `run()` | loop head in `main` | member defined in `calibration_main.cpp`; Elodin lambdas (§0), `running`, `pkt_buf`, `logged_ch5` stay there |
| checks | §6.1 + FMA census + Improvement-2 cases | the same, plus a normalised `cal.log` `cmp` pre/post and its C0 golden with one malformed-config run |
| cleanup | C1, C2 (`SensorModels` value + `on_elodin_reconnected`), C3 | C1; C2 = the three stream globals become members, no `on_elodin_reconnected`; C3; S3 exception for member names |
| fallback | — | if S34 holds, B′ **is** A: same TUs, same checks, two reference carriers for one owner; nothing redone |

Unchanged: `select_pt_psi`/`select_lc_kg` free `inline` in `SensorModels.hpp`; `debug_limit` a
member in both; `pt_board_configs` loses `const` in B′ only.

## 6. Remaining disagreements

1. **A vs B′:** whether S34's letter ("a new class") or D43(3)'s purpose ("only moves code") decides a one-instance owner of `main`'s frame.
2. **A vs B′:** whether ~160 permitted non-dimmed prefix/argument lines are a review cost (B) or neutral (A, O1).
3. **A vs B′:** whether construction order belongs to `main`'s text (A) or to an `init()` body plus a proven-silent mem-init list (B′) — the facts are agreed, the preference is not.
4. **C vs A/B′:** whether WP9's move-only may leave `main` at ~1,900 against D39's ~430.
5. **C vs A/B′:** whether "by construction" for 209 non-fusable lines outweighs a split whose fusable lines are bounded, censused and byte-compared.
6. **All:** whether the normalised `cal.log` golden is a C0 must-close (B′) or a nice-to-have held by the literal multiset (A: G9).
