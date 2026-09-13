# Where this model has lied, and what it took to catch it

Every entry below produced a plausible, converged, steady-looking result that
was wrong. That is the pattern worth internalising: in a coupled feed-system
model the failure mode is almost never a crash. It is a smooth curve with a
defensible shape and a wrong number in it.

The counter-practice is the same every time. **Check a piece against a closed
form, not against the rest of the model.**

---

## 1. Explicit coupling past the RC time constant

The regulator and the ullage it feeds are an RC pair — capacitance `C = m/p`,
resistance `R = flow_droop / rated_flow`. On this stand τ is **~1 ms for helium
and ~7 ms for GN2**. The coupling was re-solving the network every 10–50 ms.

An explicit scheme past its stability limit overshoots and overcorrects. The
result was 27 psi of tick-to-tick swing on helium — and, crucially, a *biased*
mean: helium read 20 psi **below** nitrogen when the truth is 20 above. The
conclusion of an entire study inverted.

**How it was caught.** A dt sweep. If the answer changes with the step, the
answer is the step.

| | dt = 50 ms | dt = 2 ms |
|---|---|---|
| He swing | 36.9 psi | 1.1 psi |
| He settled | 484–545 | 548–553 |

**Fix.** `Session._coupling_timescale()` computes τ and the coupling count is
sized from it, `COUPLING_SAFETY = 0.25` of τ per step. The regression test
asserts the literal τ/4 — an earlier version compared against
`COUPLING_SAFETY` itself and so passed no matter what that constant was set to.

---

## 2. A regulator is not symmetric

`HydraulicComponent.total_dp` negates the loss for reverse flow. Correct for a
pipe: run it backwards and the pressure falls backwards. **A regulator's
forward "loss" is the entire 4500 → 550 psi difference**, so mirroring it puts a
**7900 psi step across `mdot = 0`**.

The finite difference across that step reported a slope of ~1e16 Pa/(kg/s). One
Newton iterate landing near zero flow destroyed the solve; the network then
settled into gas circulating backwards out of one tank into the other, which
balances mass perfectly and is nonsense. **117 ticks in 141 failed**, presenting
as a tank draining to atmosphere while the bottle stayed full.

**Fix.** `Regulator.total_dp` overrides: forward is the base class, backward is
continuous at zero and steeply resistant (`REVERSE_STIFFNESS`), so Newton is
pushed back to non-negative flow rather than finding a mirrored pressure source.

---

## 3. A relay at exactly 50% duty

A tank stops accepting gas once it has caught up with what is feeding it. The
reference it compared against was the node *next door*, which in a converged
solve sits above it by exactly the line loss — a psi or two on a short, fat
helium press line. So any sub-step that put gas in crossed it.

Fill → cross → refuse → drain back → fill. A limit cycle at **exactly 50.0%
duty**, and the bottle had already been debited for the refused gas. Half the
pressurant was destroyed, perfectly steadily, which is why it read as physics.

**Fix.** The refusal is returned as a number the caller credits back to the
bottle, and the clamp closes past the supply by a margin rather than at a point.

**Test lesson.** The first regression test for this passed with the bug in
place: the shipped stand has enough line loss to keep a tank clear of its
supply. The test now exercises the invariant at the vessel — *whatever a tank
refuses, it reports* — and was verified to fail on revert.

---

## 4. `raise_on_failure=False` did not mean it

Three separate paths in `solve_steady` raised anyway: the top-of-loop residual
evaluation, the `splu` factorisation failure, and one call to `_result`. A live
cockpit calls this every tick and must be able to hold its last good answer
through a hard instant.

Related: `_result` rebuilds its own branch indexing from `isolated`, and one
caller omitted it. That reads past the end of the solution vector on a good day
and **silently reports a neighbour's flow** on a bad one. It is a required
argument now.

---

## 5. Invented numbers wearing a `manufacturer` tag

The provenance system only warns on `estimated` and `default`. A made-up value
tagged `manufacturer` is therefore invisible to `check()` — and several were.
The invented press solenoid alone cost 41 psi at the GN2 duty, more than the
stand's entire observed 25 psi ignition drop.

**Practice.** Before trusting any trace, dump the parameters with their `source`
and treat anything not traceable to a datasheet or a measurement as estimated.
When a datasheet genuinely lacks a figure — TB 1031 has no droop curve — back it
out from stand data and tag it `measured`, saying so.

---

## 6. Units that cannot be checked

`supply_coefficient` was a bare dimensionless ratio. 17 psi/1000 psi,
1.7 psi/100 psi and a slipped decimal all look identical once the units are
gone, and the value in the drawing was wrong for weeks.

**Fix.** It carries a `pressure_ratio` dimension, so `-` is *rejected* where one
belongs and the vendor's own wording is what gets typed in:

```toml
supply_coefficient = { value = 17, unit = "psi/1000psi" }
```

---

## 7. Zero-time actuation

`travel_time` existed in the valve spec, with a note saying it "drives startup
transients". The session ignored it and snapped valves 0 → 1. A step input into
half a litre of ullage, arriving before the chamber lit, made the ignition dip
several times too deep.

---

## 8. An input error beats every model error

The bottle was given as "45 in³". It is a 45 **scf** SCBA cylinder — 4.64 L, a
6.5× difference. The model was right; it was answering about the wrong hardware.

A second Claude session, given 5.06 L, predicted ~4.5 s of regulation. This
model at 5.06 L gives 6.5 s. The two never disagreed about physics.

**Practice.** When a result contradicts intuition, check the inputs against the
physical object before touching the solver. Compare independent estimates of the
same quantity — that is what surfaced this.

---

## What was tried and did not work

Kept because the next person will have the same idea.

**Implicit coupling, by Picard iteration.** The step is bounded by the
regulator-ullage time constant, so the obvious move is to close the step on
itself: move the vessels, re-solve the network where they landed, redo the move
on the *average* of the flows at both ends, iterate to a fixed point.
Trapezoidal, and trapezoidal is A-stable.

The iteration is not. A fixed point only contracts while the step stays near
the time constant, so past 4τ it diverged exactly like the explicit scheme --
46 psi of error on GN2 at 16τ, 19 on helium -- while costing a full network
solve per corrector. Measured against explicit at one τ: GN2 3.0x versus 2.8x,
helium 2.4x versus 3.1x. A wash on one gas and a loss on the other.

Real implicit stability needs a **Newton** solve over the vessel states and the
network *together*, not a fixed point over them in turn. That is a coupled
Jacobian of perhaps fifty unknowns -- and it is the one place in this model
where the CFD toolbox would genuinely apply, because it is the only Jacobian
here big enough to be worth a technique.

**Memoising properties before resolving the state.** `Fluid.get` memoises on the
resolved `(property, pair, v1, v2)`. Keying on the raw keyword arguments instead
would skip validation on a hit as well -- and measured slower, because
`tuple(sorted(state.items()))` allocates a nested tuple on every call and costs
more than `_resolve` saves. 1.61 s of burn became 1.67.

## The checks that actually find things

### Performance, measured

Three changes, each required to leave the tank-pressure trace bit-identical:

| Change | GN2 | Helium |
|---|---|---|
| baseline | 2.33 s | 10.24 s |
| hot-path imports hoisted out of `conditions_from_fluid` | 2.10 s | 9.69 s |
| `Fluid.get` / `accessor` memoised, 512 entries | **1.66 s** | **7.43 s** |
| | **1.40x** | **1.38x** |

The memo is exact -- same key, same number, no rounding -- and a **256-entry
cache hits as often as an unbounded one** (86.5% of 466,000 calls per second of
burn), because the repeats all live inside a Newton iteration and a vessel
sub-step. CoolProp state updates fell from 1.78 M to 90 k.

Where the time goes now: property *lookup* overhead (`_resolve`, `_validate`,
the memo probe) at roughly 16%, CoolProp itself at 10%, and sparse LU still at
0.0%.

| Check | What it catches |
|---|---|
| **dt sweep** | integration error masquerading as physics |
| **closed-form comparison** | state-update and property errors — e.g. the bottle against CoolProp's own isentrope at the same density: model temperature matches to 0.1 K, pressure to 0.00% |
| **conservation audit at the boundary** | mass created or destroyed inside a component |
| **hand-budget, term by term** | a single dominant term that is wrong |
| **provenance dump** | invented constants |
| **revert the fix, rerun the test** | tests that never tested anything |
| **fingerprint the answer** | an optimisation that quietly changed the physics — every speed change below was required to leave the trace bit-identical |
| **a benchmark that walks its inputs** | a benchmark measuring your own cache instead of the thing under test |
