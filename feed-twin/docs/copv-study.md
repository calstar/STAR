# COPV sizing study

**Question.** Can the pressurant bottle hold the propellant tanks at their
regulated pressure for a whole burn, and does the answer differ between nitrogen
and helium?

**Answer.** Yes, on either gas, for the whole burn. Helium holds the tanks
20–45 psi higher and never dips below where it started. GN2 dips 23 psi at
ignition and is back above it within two seconds. Neither reaches blowdown — the
propellant runs out first, with 15–22% of the charge still in the bottle.

Run it from the **Study** tab, or call `POST /api/study`.

## The hardware

| | |
|---|---|
| COPV | 45 scf SCBA cylinder → **4.687 L / 286 in³**, 4500 psi |
| Regulator | Aqua Environment 1092-50, dome-loaded, balanced poppet |
| Tanks | LOX 9.68 L / 10.5 kg, ethanol 8.67 L / 6.5 kg, 5% ullage |
| Tank pressure | 550 psi = dome 500 + 50 psi spring bias |
| Press path | 6 in of ½" Swagelok (0.430" ID), Cv 1.7 solenoid |
| Ox leg | ½" valve + ½" Swagelok, **8 in. overall**, then the injector |
| Fuel leg | **3 ft** of ½" Swagelok, then a ½" NPT ball valve, then the injector |
| Mains | ½" full-port ball valves, Cv 26.1 (Crane, K = 3·f_T), ~50 ms |
| Engine | ethalox doublet, 7000 N, design Pc 420 psi, O/F 1.65 |

**The downstream legs were invented once, and it cost a wrong verdict.** An
earlier version of these drawings carried three pipes per leg totalling 2.3–2.5 m
plus a check valve, ox at 12.7 mm and fuel at 9.5 mm — none of it measured,
all of it tagged `measured`/`manufacturer`. It predicted Pc 321 psi and 5.3 kN
against a 420 psi / 7 kN engine, and blamed the plumbing, which held 67% of the
pressure drop.

The real stand is the two rows above: both legs ½" × 0.035 wall, **ID 10.92 mm**.
Note that the old 12.7 mm ox bore was the tube *OD* used as a bore — the exact
error `components.toml` warns about, and worth about 40% in loss on its own.
With the real geometry the stand makes **Pc 438 psi, 7501 N, 3.05 kg/s at
O/F 1.685**, and the injector holds 65 / 60 psi against 19 / 29 psi of plumbing,
which is the right way round for stability.

**The bottle volume is the number to get right.** "45" on an SCBA cylinder is
cubic *feet of free air*, not cubic inches of steel: 52.8 mol of standard air,
which at 4500 psi and Z = 1.1145 occupies **4.64 L** of water volume. Taking it
as 45 in³ (0.74 L) is a 6.5× error, and an entire earlier version of this study
concluded — correctly, for the wrong bottle — that the stand regulated for one
second.

## What it runs

Both drawings are primed to T-0 directly rather than flown through fills and
presses. Pressing the tanks draws on the same bottle the study is about, so
rehearsing the pad would mean an undersized COPV failed for two reasons at once
and the trace could not say which.

| Option | Cases | Notes |
|---|---|---|
| default | 1 per gas | the as-built bottle |
| 8 L bottle | +1 per gas | a bottle past the knee, to show the as-built one already is |
| Ullage collapse | +1 per gas | transient conduction only — a lower bound |
| Volume sweep | +5 per gas | 2, 3, 4, 6, 8 L. This is the slow one |

About a minute of compute per case. Every sample carries whether its solve
converged; the view drops the ones that did not rather than plotting them.

## Findings

### At the as-built bottle

| | GN2 | Helium |
|---|---|---|
| Ignition dip (dt = 10 ms) | **−45 psi** | **−17 psi** |
| Climb through the burn | 521 → 538 | 551 → 596 |
| Burn to propellant depletion | 5.45 s | 5.05 s |
| Chamber pressure | 403 → 450 psi | 458 → 491 psi |
| Thrust | 6.8 → 7.7 kN | 7.9 → 8.5 kN |
| Bottle left at depletion | 643 psi (14%) | 672 psi (15%) |

Read the ignition dip at **10 ms, not the study's 50 ms** — the coarse step
reports GN2 at −74 psi because it steps straight over the recovery. The dip
lasts about 40 ms on helium and rather longer on GN2.

Two things changed when the plumbing was corrected, both in the same direction:
the flow went up (2.31 → 3.05 kg/s), so the burn got **a second shorter**, and
the regulator has more to do. GN2's ignition dip roughly doubled. Helium's is
17 psi and back inside 40 ms.

The other end of the burn is now worth a look too: helium's supply-pressure
effect walks the tanks from 550 to 596 psi, and the engine ends the burn at
**8.5 kN — 21% over its 7 kN design point**. That is the regulator doing exactly
what its datasheet says (17 psi per 1000 psi of inlet fall, and the bottle falls
3500 psi); it is not a modelling artefact, and it is a real thing to size for.

### The mole budget

A COPV stores *moles*. At 4500 psi and room temperature nitrogen and helium sit
at almost the same compressibility, so the bottle holds **51.9 mol** of nitrogen
or **52.1 mol** of helium — the same within 0.4%. Usable down to the 550 psi
setpoint: 35.3 / 36.0 mol. The engine draws 4.25 mol/s of nitrogen or 3.50 of
helium, so the regulated phase lasts **8.3 / 10.3 s** against a 6.6 s burn.

Helium's advantage on capacity is the **196 g** it saves, not more gas.

### What the regulator does to the gas

A dome regulator is a throttle: no shaft work, no heat added, so **enthalpy** is
what carries across it — not temperature, and not entropy.

| 4500 → 550 psi, isenthalpic from 293.15 K | Nitrogen | Helium |
|---|---|---|
| Temperature at the tank inlet | 263.8 K (−29.4) | 309.8 K (+16.7) |
| Delivered density | 49.29 kg/m³ | 5.79 kg/m³ |
| Mass to fill 1.957 L/s of vacated ullage | 96.5 g/s | 11.3 g/s |

Nitrogen at 293 K is far below its inversion temperature (~621 K), so throttling
cools it. Helium's inversion temperature is about 45 K, so throttling *warms*
it. Warm gas is thin gas: helium needs **18% fewer moles** per litre the liquid
vacates.

### Sizing

GN2's plateau (~529 psi) is reached at **286 in³ — the as-built cylinder,
exactly.** Helium plateaus (~550 psi) at 244 in³. So the bottle carries no
margin on nitrogen and about 40 in³ on helium. Below the knee the floor drops
fast: 475 psi on GN2 at 244 in³, 380 at 183.

## Two things this study cannot tell you

**Helium's 3 psi ignition step is a prediction, not an observation.** Every flow
loss in the press path scales with density and helium is 8.5× lighter. If a real
helium run shows the same ~25 psi step as GN2, the mechanism is regulator
*lockup* — 550 is the seat's shut-off creep and the flowing setpoint is ~525 for
either gas — and `lockup_rise`, currently zero, should be ~25 psi. **One helium
trace at ignition settles it.**

**Every GN2 curve is optimistic.** 550 psi is above nitrogen's critical pressure
(492.5 psi). At the LOX interface, 90–120 K, nitrogen at that pressure is
640–755 kg/m³ — a liquid, within 10% of the LOX it is sitting on. It condenses
into the propellant rather than pressurising it, which drains the bottle faster
than any dry budget predicts and collapses the ullage temperature that sets the
pressure. `lib/feedtwin`'s collapse model is **transient conduction only** and
its own module documentation names condensation as the missing term. With
conduction alone the GN2 floor already falls from 527 to 428 psi.

That matters because GN2 sits exactly on its knee with zero margin, and
condensation is precisely the extra consumption that pushes it off. Helium has
margin *and* does not condense.

Closing the gap needs a condensing collapse model in the registry seam that
already exists for it — and one real GN2-on-LOX pressure trace to calibrate it,
because the literature spread on collapse factors is wide (roughly 1.5–3× dry
consumption) and picking a number without data is how the last set of invented
constants got here.

## Provenance

| Value | Source |
|---|---|
| Supply-pressure effect, 17 psi/1000 psi | Aqua Environment Technical Bulletin 1031 |
| Reg Cv 0.8, 0.23" orifice, 50 psi bias | same |
| Press path, mains travel, tank pressure | measured on the stand |
| **Flow droop, 8.3 psi at 0.0965 kg/s** | **backed out from the observed GN2 ignition drop — TB 1031 carries no droop curve** |
| Fitting K-factors, 1.5 per segment | estimated |

Anything estimated is tagged `estimated` in the drawing so `check()` reports it.
A previous version of these drawings carried invented values tagged
`manufacturer`, which defeats that entirely — the invented solenoid alone cost
41 psi, more than the whole observed drop.
