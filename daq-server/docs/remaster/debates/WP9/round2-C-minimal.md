# WP9 round 2 — C (minimal): rebuttal and revised design

Lines are `calibration_main.cpp` on `backend-remastered` unless said.

## 1. Correcting the record

Both opponents' "against C" sections attack DESIGN §A column C, the stage pipeline: A's table row
("Blend and smoother behind interfaces in other TUs") and B §3 ("virtual calls in other TUs … a
rewrite cannot keep the literal multiset"). C-minimal has no interface, no virtual, no rewrite: one
`static` header of 209 pure lines, nothing else moved. Neither charge lands.

## 2. A's weakest point: the prerequisite ledger keeps growing

A's own Improvement 2 finds that `stack.txt` does not exercise the inner `continue`s at 1673 and
1796 (Zero All / Tare All with a stale uid), and asks for a C0 case. B finds that no golden freezes
startup stdout (`service_run.py:134,146-147` send it to `cal.log`; `:245` excludes it; the golden has
zero `[Cal` lines, verified), and asks for a `cal.log` golden. Add §7's three: A now needs **five
test-only packages before step 2 can land** — tares-before-reload, G5, G1 (the wall-clock Blend
reseed), the stale Zero/Tare All, the `cal.log` golden. Every one is good work; none should sit on
`WP8 → WP9 → WP10`. C needs none because it moves none of the guarded lines (1404/1410, 1544, 300,
1673/1796, 660-1472): its diff touches no line a new golden would freeze.

A's O1 ("neither `this->` nor `ctx.` is clearer") concedes the ~126 prefixed lines are a cost with
no clarity return; A's reason for paying it is `main`'s size, which D39 already waived once.

## 3. B's weakest point: it is A with the order moved into a header, and B knows it

B §6 concedes S34's letter rejects it and that it "degrades to A"; D45 recorded B as lost. B's
real contribution is §2(b), the effect audit of every constructor, and §3's count: members keep
today's names, so ~170 lines A must review are dimmed in B. True — against A. Against C it is
nothing: C dims every moved line *and* has no header list to check against 660-1562, no
`pt_board_configs` losing `const`, no `[this, uid]`, no S3 exception owed for `cubic_store` without
a trailing underscore. B's O2 ("nothing in GCC's inliner distinguishes a member from a free
function") is correct and irrelevant to C, which moves neither.

B's one claim I dispute: "the order is still behaviour … B proposes the C0 gap A needs too." Yes —
and a `cal.log` cmp pre/post is a move-only check *every* design should run. C adopts it; it passes
by construction.

## 4. Concessions

**A's FMA census neutralises the risk half of my float-path argument.** `objdump -d | grep -cE
'fmadd|fmsub|fnmadd|fnmsub|fmla|fmls'` pre/post on both arm64 legs (the Release count on each leg;
this Mac's `build/` is -O0 and not evidence) detects exactly the mechanism I named — a contraction
appearing or vanishing because inlining changed — and A's bound is right: the Blend result enters
`PtSmoother::step` (`PtSmoothing.hpp:30`) as a multiplicand, so no `a*b+c` can span the two
statements. What survives of my argument is narrower: C does not need the census, the §6.3 table or
the argument, and a reviewer has nothing to re-derive. That is review cost, not golden risk. I
withdraw "risk" and keep "cost".

**B's `cal.log` finding is real and I missed it.** DESIGN §A's "construction order … reviewed as
behaviour" and my round-1 reliance on "today's order of side effects" both assumed something froze
the lines; nothing does. For C the finding is neutral (no startup line moves), but it means A's
`--color-moved` review is the *only* guard on the trap §8 calls the worst one. B's plan (§2(b):
effectful statements in `init()`, silent constructors in the mem-init list, `cal_cfg` first) is
sound; I would still not take it, because it buys B's dimmed diff at the price of a second place
where order is declared.

**Slimming.** The refactor's goal (BLOAT-MAP, S33) is a smaller `main`; C leaves ~1,900 lines and
fails that goal outright. What C delivers is net lines: ~−30 after cleanup against A's ~+380 header
lines in move-only and the same ~40 deletions later. If the DoD is `main`'s size, C does not meet
it and I will not pretend otherwise.

**A's `static→inline`.** With the census in place, the 13 header functions can be `inline` as A
says; none is fusable (§6.3). I keep `static` as the default for a one-includer header (S27) but
will not argue it further.

## 5. Revised design

Sequence, not shape, is what I now contest.

1. **Move-only item 1 (now, before WP10):** `Conversions.hpp` as round 1 (`static`, one includer, no
   CMake edit) **plus** two checks adopted from the opponents: B's `cal.log` pre/post `cmp` and A's
   FMA census, both on macOS and Linux arm64. No C0 prerequisite.
2. **Cleanup item (now):** the round-1 deletions — `logged_ch5` + baseline line, `<deque>`/`<mutex>`,
   `pt_cal_status`, `board_number_from_uid`, the `resolve_*` merge conditional on open question 2.
3. **Move-only item 2 (after WP10):** A's steps 2-5 exactly as A declares them — `SensorModels`,
   `CalibrationContext`, `CalibrationActions`, `AbortThresholds`, `CalibrationCommands`. I drop my
   objection to the carrier: D43(3) ruled on it, and with the census the D22 argument no longer
   separates us for code that does not touch the stream. It still needs all five C0 packages, because
   each guards a line steps 2-5 move: G1 → 300 (`select_pt_psi`, step 2); `cal.log` → 773-879,
   894-911, 1436-1472 (the `load_*`/`print_*` prints, step 2); tares-before-reload → 1294-1391
   (`reload_live_store`, step 3); G5 → 1385-1389 (the reload tail that writes the two files G5
   freezes, step 3); stale Zero/Tare All → 1673/1796 (step 5). What C buys is the order: WP10 does
   not wait on them.
4. **`RawStream` (A's step 6): not queued.** The one TU holding the Blend → smoother sequence
   (1870-1879, 2000-2015) leaves `main` only inside the fix package whose fix is its reason to exist
   — D-SLOT's "PT2.CH1 smoothed twice" is the candidate — by analogy to the WP10 verdict §4 rule
   for collaborators (RawStream is Tier 0 there; the rule here is mine), with the census and both
   legs judging it in that package. `last_adc_map` keeps one writer and the `on_elodin_reconnected`
   amendment never arises.

`main` after items 1-3: roughly A's ~430 plus the ~300-line stream (1827-2127) — the loop head, the
dispatch and the two branches. After a D-SLOT fix package takes step 6: A's ~430.

## 6. Remaining disagreements

- **A:** whether steps 2-6 belong before WP10 (A: yes, one item; C: steps 2-5 after WP10, step 6
  only with a fix).
- **A:** whether `RawStream` is a move-only cut at all or a fix-package admission (C: the latter,
  by analogy to WP10 verdict §4).
- **A:** `static` vs `inline` for a one-includer header (C: `static`, S27; conceded as taste once
  the census runs).
- **B:** whether a class that only moves code is D43(3)'s carrier (C: no — a carrier references,
  an owner declares order; D45 settled it).
- **B:** whether B's dimmed-diff gain outweighs a second declaration of construction order (C: not
  while `cal.log` is unfrozen; after B's own golden lands, closer).
- **Both:** whether the three-plus-two C0 packages are WP9's cost or the team's (C: the team's,
  queued in parallel; both opponents: WP9's, on the critical path).
