# Phase 14 — ullage vapour and chilldown, and what they are actually worth

Both are **opt-in**, both are reachable from the Study tab, and the headline from
running the He/GN2 benchmark with everything switched on is not what I expected.

## The benchmark, full physics

Six traces at dt = 10 ms: the two baseline cases, plus the four the full-physics run
produces (ullage vapour + chilldown 50 W/m²K applied run-wide, ullage collapse adding
its own extra case per gas so its effect is visible). **All six converged with zero
failed ticks.**

| case | T-0 psi | dip from its own T-0 | t = 1 s | t = 4 s | burn | COPV left |
|---|---|---|---|---|---|---|
| GN2 baseline | 550.0 | −44.6 | 525.8 | 537.3 | 5.43 s | 650 |
| GN2 vapour + chilldown | **578.9** | −67.3 | 526.3 | 537.6 | 5.42 s | 656 |
| GN2 + collapse as well | **461.5** | −16.6 | 525.9 | 536.8 | 5.44 s | 644 |
| He baseline | 550.0 | −16.6 | 557.6 | 591.4 | 5.00 s | 694 |
| He vapour + chilldown | **578.7** | −39.4 | 557.5 | 591.2 | 4.99 s | 708 |
| He + collapse as well | **478.1** | 0.0 | 557.7 | 591.6 | 4.99 s | 680 |

## The finding: they move the pad, not the burn

Read the `t = 1 s` and `t = 4 s` columns. Across all three GN2 cases they agree to
within half a psi, and **the largest spread between them at any point in the burn is
3.29 psi**, at t = 4.9 s as the tank runs dry. Helium is the same.

Every large number in that table is in the **T-0** column — where the tank sits
*before* the mains open. Vapour puts it up 29 psi (oxygen partial pressure over the
liquid); collapse pulls it down 117 psi from there. Once firing, the regulator is
actively holding pressure against a 5-second flow timescale, while conduction into
the liquid goes as √t and the wall's thermal mass is minutes of time constant. The
thermal terms simply do not get a chance to act.

**So: turn them on for pad states, holds, loading, and vent planning. Leave them off
for burn traces.** That is a real result and it is the opposite of "more physics is
always better" — it is the justification for the toggles being toggles.

One caveat on the dip column: a dip measured from a fixed 550 datum is misleading
once the settle lands somewhere else, which is why the table measures each case from
its own T-0. The collapse cases look like they have the *shallowest* dip only because
they started 100 psi lower.

## Cost

15.9 s per case baseline, 17.3 s per case full physics — about **9% more compute**,
not the doubling I expected. The extra property calls are cheap next to the network
solve.

## What the models are

**Ullage vapour** (`feedtwin/vessels/vapour.py`) rests on one statement: a liquid at
its saturation temperature cannot warm, so heat arriving at it boils liquid instead.
`ṁ = q/h_fg`, the mass enters the ullage, and its partial pressure adds by Dalton.
Hand-checked: 612.9 W ÷ 213.2 kJ/kg = 2.874 g/s, exact. Latent heats agree with the
handbook (LOX 213.2 vs ~213 kJ/kg at NBP, LN₂ 199.6 vs 199).

Partial pressures rather than a mixture EOS, deliberately: a real mixture model costs
a CoolProp mixture per evaluation and a class of convergence failures at exactly the
compositions this spends most of its time at — pure pressurant at T-0, pure vapour in
a vented tank. The error is a percent-level fugacity correction.

**Chilldown** is the wetted face of the wall. The wall term that already existed was
ullage-to-wall only, so nothing cooled during a load. `wetted_conductance` uses the
`wetted_area()` the geometry has been carrying since the note that said Phase 14 would
want it. At 50 W/(m²·K) a 293 K wall over 90 K LOX puts 2750 W in, boiling 15.8 g/s
and cooling the wall 0.54 K/s.

They are one phase because they are one mechanism: the warm wall is *what boils the
cryogen* during a load.

## Two traps, both now regression tests

**A reference-state category error, mine.** I credited saturated-vapour enthalpy into
the ullage energy budget. But `ullage.energy` is the *pressurant's* internal energy in
the pressurant's reference state: LOX saturated liquid is −133.7 kJ/kg while helium at
ullage conditions is +628.6 kJ/kg. With ~2 g of helium in a LOX ullage that inverts the
state in one step. Vapour now contributes mass and partial pressure, never energy —
which under-counts the thermal energy the vapour carries back in, biasing the ullage
cool. Stated in the docstring rather than hidden.

**CoolProp returns −6057 psi for a microgram of oxygen.** At 0.002 kg/m³ the Helmholtz
formulation extrapolates badly; 10 µg and everything above is clean and linear. One
such sample took the whole tank pressure negative and every solve after it. Below
~1 kg/m³ the gas is ideal to well under 0.1%, so the ideal answer is not a fallback,
it is the better number.

## Three bugs found on the way

- **The solver reported success on a non-physical pressure.** A residual can go to zero
  on a state that is not a pressure; it now refuses that as a failed solve rather than
  handing −6428 bar to the property layer several frames from the cause.
- **`TankState` was rebuilt field-by-field** in three places, silently dropping anything
  added to the dataclass later — exactly how `vapour_mass` reset to zero every step.
- **`_setup` had the same shape**, while its docstring promised "anything unsent is
  kept": every dial outside four listed ones reverted to its class default, so nudging
  the dome turned `ullage_collapse` back on by itself. Pre-existing.
