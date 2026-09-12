# The physics benchmark

**Run this whenever you change physics, add a model, or are asked whether something
still works.** It exists because this project has repeatedly been given confident
wrong answers by a simulation that ran cleanly, and every entry below is a number
that was checked against something *other than this code*.

If you are an agent picking this up cold: read "The rule" first. It is the part that
matters. Everything after it is bookkeeping.

---

## The rule

**You cannot verify the sim with the sim.**

A run that converges, produces smooth curves and violates no assertion is not
evidence of anything. Every check in this document compares against one of:

- a closed-form result you can do on paper,
- an independent library (`fluids`, CoolProp) computing the same standard,
- a handbook value,
- or the *previous* recorded value, where the requirement is "do not move".

When a check disagrees, **the sim is guilty until proven innocent.** The historical
base rate in this codebase is not close: of the disagreements found so far, the
model was wrong nearly every time.

Two corollaries that have each cost a day:

- **A test that cannot fail is not a test.** Before trusting a new regression test,
  break the thing it guards and confirm it goes red. Three tests in this repo passed
  against bugs they were written for — one compared a value against the very constant
  it was guarding, one used a fixture whose line losses hid the effect, and one
  benchmark measured its own cache.
- **State what you did not check.** "I verified X" and "X looked fine" are different
  claims and the reader cannot tell them apart unless you say so.

---

## Tier 0 — gates. Nothing else counts until these pass.

```bash
cd lib/feedtwin   && python3 -m pytest -q && python3 -m mypy feedtwin && python3 -m black --check feedtwin tests
cd ../../feed-twin && python3 -m pytest -q && python3 -m black --check backend tests
cd frontend        && npm run build
cd ../../pid-designer && PYTHONPATH=../lib/stardesign python3 -m pytest tests/ -q
cd ../EngineDesign    && PYTHONPATH=../lib/stardesign python3 -m pytest tests/ -q
```

| suite | expected |
|---|---|
| feedtwin library | **568 passed** |
| feed-twin API | **128 passed** |
| pid-designer | **96 passed** |
| EngineDesign | 568 passed, **4 pre-existing failures**, 81 skipped |

The four EngineDesign failures (`test_assumptions_registry`,
`test_flight_propellant_iteration`, `test_injector_parity`,
`test_propellant_presets`) are known and predate this work. If you touch
EngineDesign, confirm they are still *those four* — do not let a fifth hide among
them.

Counts go up, never down. A count that fell means you deleted a test; say which and
why.

---

## Tier 1 — closed form. Component level, no network, no integrator.

These are fast and they localise a fault to one component. Run them first when
something downstream looks wrong.

### 1.1 Pipe friction against Darcy–Weisbach by hand

Ethanol, ρ 789, µ 1.2e-3, 1.0 kg/s through 1.6 m of 10.2 mm bore.

| quantity | expected |
|---|---|
| velocity | 15.511 m/s |
| Reynolds | 104 023 |
| friction factor (Clamond) | 0.01862 |
| Δp | **277 186.813 Pa** |

Compute `f·L/D · ρv²/2` on paper and compare. Tolerance: **exact to 6 significant
figures.** This is arithmetic; a mismatch is a bug, not a tolerance question.

### 1.2 A one-segment run equals the plain darcy pipe

Same geometry through `model="segmented"` with a single segment.

Expected: **bit-identical**, `delta 0.000e+00`. Not "close". The segmented path must
reduce exactly to the old one or the loss ladder has changed an answer it should not
have.

### 1.3 Gas choking against `fluids`' own IEC 60534

`Valve.flow_ceiling()` vs `fluids.control_valve.size_control_valve_g` across helium
and nitrogen, 200–4500 psi, Cv 1.6–60, 250–293 K.

Expected: **worst error 0.000000%** (test asserts `rel=1e-6`).

This one has a specific trap. The published `N6` depends on which unit set *and*
which flow coefficient (Kv or Cv) the table is written for. Pairing `N6 = 27.3` with
Cv and kPa over-predicts by **10.5×**; getting the Kv/Cv factor backwards leaves a
clean **33.657%** (= 1/0.865²). Both look plausible. The coefficient is therefore
*calibrated from the library at import*, not transcribed — if you "simplify" that to
a literal, this check is what catches you.

Also assert the negative: a **liquid** valve must still return `flow_ceiling() is
None`. A LOX main valve must not acquire a sonic limit.

### 1.4 Latent heats against the handbook

| fluid | T | expected h_fg |
|---|---|---|
| oxygen | 90.0 K | 213.2 kJ/kg (NBP ≈ 213) |
| nitrogen | 77.0 K | 199.6 kJ/kg (NBP ≈ 199) |
| ethanol | 293.15 K | 926.0 kJ/kg |

Tolerance ±2 kJ/kg. Computed as the difference of the two saturated enthalpies, so
it goes to zero at the critical point on its own.

### 1.5 Boil-off is exactly q/h_fg

LOX at 90 K, 612.9 W of interfacial heat.

Expected: **2.874 g/s**, and `evaporation == latent_power / h_fg` to `rel=1e-12`.
This is a definition, not a correlation. It must be exact.

### 1.6 Vapour partial pressure is linear and never negative

Oxygen vapour in a 0.531 L ullage at 200 K, swept 1 µg → 5 g.

Expected: strictly positive, monotonically increasing, and linear — 1.0 g gives
**14.16 psi**, 0.1 g gives 1.42, 0.01 g gives 0.142.

**The trap:** CoolProp's Helmholtz formulation returns **−6057 psi** at 1 µg
(0.002 kg/m³). One such sample takes the whole tank pressure negative and every solve
after it. Below ~1 kg/m³ the gas is ideal to well under 0.1%, so the ideal answer is
the better number, not a fallback. Sweep the full range; do not spot-check one value.

### 1.7 Chilldown magnitudes

293 K wall over 90 K LOX, `wetted_conductance = 50 W/(m²·K)`.

| quantity | expected |
|---|---|
| heat into liquid | ≈ 2750 W |
| boil-off | ≈ 15.8 g/s |
| wall cooling | ≈ −0.54 K/s |

Cross-check by hand: wetted area ≈ 0.26 m² × 50 × 203 K ≈ 2640 W. Within 5% is fine
here — the geometry's head treatment moves it slightly.


### 1.8 Line walls — stainless heat capacity

316 is not a constant-cp material anywhere near a cryogen. NIST cryogenic values:

| temperature | cp |
|---|---|
| 77 K | 190 J/(kg·K) |
| 100 K | 230 |
| 293 K | 494 |

**cp(293)/cp(77) ≈ 2.6.** A model with one constant cp is wrong by that factor on
exactly the lines where the metal is coldest — which are the LOX lines, which are the
ones somebody will ask about first.

Tube mass: ½ in. × 0.035 in. wall 316 is **0.265 kg/m**. A 255 mm run is 67 g against
roughly 200 g for the two unions holding it on, so `fitting_mass` is the number that
decides the answer and `wall_thickness` is the rounding. Say so when reporting.

### 1.9 Line walls — the exchange

`LineWall(mass=0.4, area=π·0.010922·0.5, bore=0.010922)`, ṁ = 0.15 kg/s of nitrogen at
ρ = 50, μ = 1.29e-5, k = 0.0185, cp = 1080; wall 293 K, gas in at 200 K.

Work it by hand — this is the check, not the printed number:

```
Re  = 4·ṁ/(π·d·μ)        = 1.356e6
Pr  = cp·μ/k             = 0.753
Nu  = 0.023·Re^0.8·Pr^0.4 = 1655
h   = Nu·k/d             = 2803 W/(m²·K)
NTU = h·A/(ṁ·cp)         = 0.2967
ε   = 1 − exp(−NTU)      = 0.2567
```

| quantity | expected |
|---|---|
| effectiveness | 0.2567 |
| gas rise | 23.9 K |
| Q − ṁ·cp·ΔT | 0 (exactly) |
| ṁ = 0 | heat exactly 0 |
| wall colder than gas | heat negative |

**ε must stay well below 1.** If it saturates, the answer no longer depends on the
correlation at all — only on the metal's heat capacity — and the model has quietly
become "gas leaves at wall temperature". On the shipped stand ε runs 0.03–0.25.

**ṁ = 0 must give exactly zero.** A wall that leaks heat with no flow is a soak model
arriving by the back door, and it will warm a stand that is only sitting there.

### 1.10 Line walls — which path is worth modelling

The stand's own evidence is frost, then icicles, on the fittings downstream of the
regulator. Two paths could put heat into that gas. Only one survives arithmetic.

| path | mechanism | rise in a 150 g/s stream |
|---|---|---|
| B | room → frost → tube → gas | 0.04 K still air, 0.18 K generously frosted |
| A | the line's own metal | **8–24 K** |

Path B is two orders down and is not modelled. **Path A is, and the icicles are the
evidence for it**: metal only gets cold by giving its heat away, and frost on a fitting
is a receipt for the joules that went into the gas.

Path A also runs out. The wall relaxes toward the stream with τ = C/(ε·ṁ·cp) ≈ 4.5 s
on that line, so:

| after | metal |
|---|---|
| 6 s of flow | 223.6 K |

and joules out of the metal must equal joules into the gas to **within 1%** (the
residual is piecewise-linear cp taken at a midpoint rather than integrated).

**This is a first-run effect.** The second run of the day starts from cold metal,
because the only thing that recharges it is Path B and Path B is the one worth two
hundredths of a kelvin. Do not benchmark a wall run on a session that has already
burned.

---

## Tier 2 — integration. The He/GN2 benchmark.

**Every pressure in this tier is gauge (psig)**, because that is what the stand's
transducers read and what the study traces report; a vented vessel is 0.0. The model
underneath is absolute — the study primes at 550 psig, which is 564.7 psia — and the
only two places the two meet are `backend.run.psig` / `from_psig`. Differential
pressures are the same in either.

This is the headline regression. Run it after any change to the solver, the
regulator, the vessels or the transient stepper.

```bash
# 2 gases, dt = 10 ms, baseline physics
StudyRequest(gases=("gn2","he"), dt=0.01, horizon=14.0)
```

**Use dt = 10 ms, not the 50 ms default.** The ignition dip is a ~40 ms feature and
the coarse step walks over its recovery, reporting the GN2 dip as −74 psi instead of
−44.5. If you report a dip from a 50 ms run you are reporting an artefact.

### 2.1 Baseline expectations

Re-baselined 2026-09-10, twice. First: the previous table predated the
enthalpy-propagation walk and had never been re-run against it (reproduced with the old
hard-coded vessel walls on current code it already read differently). Second: the
gauge convention landed the same day, so the prime moved from 550 psia to 550 psig and
every number below is psig.

| | GN2 | Helium |
|---|---|---|
| T-0 pressure | 550.0 psig | 550.0 psig |
| ignition dip | **-35.2 psi** | **-12.9 psi** |
| recovers to lockup | **never** | **t = 0.41 s** |
| at t = 1 s | 528.0 | 557.6 |
| at t = 4 s | 548.1 | 595.5 |
| burn to depletion | 5.51 s | 5.20 s |
| COPV remaining | 518 psig | 559 psig |
| peak thrust | 8.10 kN | 8.80 kN |
| failed ticks | **0** | **0** |

Tolerance: **±2 psi and ±0.05 s.** Anything larger is a change in behaviour and needs
an explanation, not a shrug — and the explanation goes *here*, next to the number.

Three properties matter more than the individual numbers, because they are the
physics rather than the arithmetic:

1. **Both start at 550.0 psig** — dome 500 plus the 1092-50's 50 psi spring bias.
2. **The trace drops at ignition, climbs, then blows down.** If pressure *rises* at
   ignition the supply-pressure effect or the lockup rise is missing from the
   drawing. This exact error shipped once.
3. **Helium recovers lockup in under half a second; GN2 climbs back to within a few
   psi of it and does not get there before the tanks run dry.** The recovery is the
   supply-pressure effect lifting the setpoint as the bottle falls, an order of
   magnitude slower on nitrogen. If GN2 recovers in under a second something has given
   the regulator more capacity than it has; if helium stops recovering, the SPE has
   been lost from the drawing.

### 2.2 Full-physics expectations

```bash
StudyRequest(gases=("gn2","he"), dt=0.01, collapse=True, vapour=True, chilldown=50.0)
```

Four traces, **all converged, 0 failed ticks.** Pressures psig. T-0 is now a *primed* tank -- wetted wall at liquid temperature, ullage wall at gas temperature, interface aged 300 s, settled through the press valves -- so collapse no longer opens the trace 130 psi under lockup (see §2.4c).

| case | T-0 | t = 1 s | t = 4 s | burn | COPV left |
|---|---|---|---|---|---|
| GN2 vapour+chilldown | 550.2 | 528.0 | 548.1 | 5.51 s | 518 |
| GN2 + collapse | 548.5 | 528.0 | 547.9 | 5.51 s | 517 |
| He vapour+chilldown | 549.7 | 557.6 | 595.5 | 5.20 s | 559 |
| He + collapse | 548.1 | 557.7 | 595.6 | 5.20 s | 558 |

**The load-bearing assertion is the one people get wrong:**

> During the burn the three GN2 cases sit within **0.2 psi** of each other at the
> recorded instants (re-baselined 2026-09-10; the previous full-trace figure was
> 3.29 psi). Thermal effects move the **pad state**, not the burn.

Every large difference is in the T-0 column. If a change makes thermal effects matter
*during* the burn by more than a few psi, that is a finding — investigate it, do not
accept it. The regulator actively holds pressure against a 5-second flow timescale
while conduction goes as √t and the wall's time constant is minutes.

Cost: ~15.9 s per case baseline, ~17.3 s full physics (**+9%**). A large slowdown
means something is being recomputed per step that should be cached.

### 2.3 Steady fire on the shipped stand

12 steps of 50 ms in `Fire` on `copv_study_gn2`, primed at 550 psig. Chamber pressure
here is **absolute**, as every pressure inside the model is — `scripts/physics_benchmark.py`
reads it off the chamber result, not off a gauge.

| quantity | expected |
|---|---|
| chamber pressure (abs) | 452.1 psia |
| thrust | 7730 N |
| total flow | 3.131 kg/s |
| O/F | 1.695 |
| ox plumbing Δp | 19.0 psi |
| injector Δp ox | 66.6 psi |

**The shape matters more than the values: the injector must hold most of the drop.**
If plumbing exceeds the injector, either the geometry is wrong or someone has
invented a line again (see 4.2).

*Gas-derived wall film (September 2026).* The cockpit now estimates a vessel's
gas-to-wall hA from its ullage gas and its size (`Setup.wall_hA_from_gas`,
on by default; `feedtwin.vessels.convection`) when the drawing leaves it blank.
With it off the script reproduces the table above check for check; with it on,
2.3 moves by +0.03 psia / +0.7 N — inside every tolerance, and the whole of the
difference. Checked both ways per 2.5.


### 2.4 Line walls on the shipped stands

```bash
StudyRequest(gases=("gn2","he"), dt=0.05, horizon=14.0, line_walls=True)
```

5.90 kg of metal declared across 20 lines on `copv_study_gn2`.

| case | ox at T-0 | ox min | ox at end | COPV left |
|---|---|---|---|---|
| GN2 walls off | 550.0 | 456.3 | 456.3 | 512 |
| GN2 walls on | 550.0 | 515.5 | 515.5 | 615 |
| He walls off | 550.0 | 545.4 | 551.0 | 559 |
| He walls on | 550.0 | 545.4 | 604.9 | **768** |

**The two gases spend the heat differently, and that is the finding.**

- **GN2 has lost regulator authority by the end** — the tank has fallen to 492 psi,
  so tank pressure is set by what the bottle can still deliver. Wall heat therefore
  shows up as tank pressure: **+59.2 psi at the end of the burn**.
- **Helium is still in lockup** — the regulator is holding the setpoint, so tank
  pressure cannot move. The heat shows up entirely as bottle reserve: **+209 psi**.

So neglecting the walls makes a nitrogen COPV look substantially more undersized than
it is. Both cases are the same physics: warmer pressurant is less dense, so fewer
kilograms hold the same pressure.

Expected wall temperatures after 14 s:

| line | GN2 | He |
|---|---|---|
| `l_kb` (bottle → regulator) | 237 K | 246 K |
| `l_reg` | 237 K | 249 K |
| LOX lines (`l_ox1`, `l_ox2`, `l_oxfill`) | 90 K | 90 K |

**LOX lines must not move.** Liquid's heat capacity dwarfs the metal's; if a LOX line
warms by more than a kelvin over a burn, the wall is exchanging with something it
should not be.

**Where the metal starts, per line, with no soak model:**

| line holds at rest | starts at |
|---|---|
| liquid | the liquid's temperature (90 K for LOX) |
| ullage vapour | the ullage gas temperature — *not* the liquid's |
| pressurant | ambient / bottle |

That distinction is why walls are seeded from the first settled temperature walk and
not at build time: at build time a tank node still reads as liquid, so a vent line off
the *top* of a LOX tank would be seeded 200 K too cold.

**Cost: none measurable.** 13 s per GN2 case with and without.

### 2.4b The line-wall audit — why the number is that big, and what is still wrong

The first reaction to +51.7 psi is that a coefficient must be too high. It is not,
and the reason is one line of arithmetic:

| | heat capacity |
|---|---|
| 5.90 kg of steel on the stand | **2655 J/K** |
| ~1 kg of pressurant that flows through it | **1139 J/K** |

**The metal holds 2.3× the heat capacity of all the gas that passes through it.** A
large effect is the expected outcome; the surprise would be its absence.

**Verified against things that are not this codebase:**

| check | result |
|---|---|
| Nu vs `ht.turbulent_Dittus_Boelter` | 0.00% |
| Nu vs `ht.Nu_conv_internal` (auto-selected) | −1.1% |
| Nu vs Sieder–Tate | would be **+20%**, i.e. ours is on the low side |
| 26.2 kJ → closed-form pressurant saving | +23.3 K, 9.7% less mass, **≈146–188 psi** of bottle |
| what the sim actually reported | **+110–124 psi** — *under* the hand calculation |

**It is film-limited, not mass-limited**, which is what makes the invented
`fitting_mass` survivable:

| fitting mass | ox at end |
|---|---|
| 0 kg | 492.1 psi |
| 1.48 kg | 521.5 |
| 2.95 kg | 534.0 |
| **5.90 kg (shipped)** | **543.8** (pre-fix walls, psia; see 2.4 for current) |
| 11.80 kg | 549.8 |

Doubling the metal buys 6 psi; halving it costs 10. **If a future drawing lands in the
steep part of that curve, the trade-offs below stop being acceptable — re-run this
sweep before trusting a wall result on new geometry.**

**Known wrong, knowingly:**

1. **Lumped capacitance is invalid for the fittings.** Bi = 0.17 across the 0.889 mm
   tube wall (lumped is exact there against a 1-D solution), but 0.93 at 5 mm of
   fitting body and 1.49 at 8 mm. Over a 6 s burn the lumped wall over-credits the
   heat by **19% at 5 mm, 32% at 8 mm** — the core cannot reach the bore, steel's
   diffusion depth being 4.7 mm at 6 s. Worth ~2–3 psi of the 51.7 because of
   saturation. A second node would fix it and is not currently earning its complexity.
2. **Vessel walls are estimated unless the drawing declares them.** Every vessel
   symbol now carries `wall_mass`, `wall_capacity`, `wall_conductance`. Undeclared,
   a tank takes 0.457 kg/L, 900 J/(kg·K), hA = 12·(V/17.5 L)^(2/3) W/K and a bottle
   1.36 kg/L (steel K-bottle), 500, hA = 20·(V/4.687 L)^(2/3); every use is listed in
   the session's assumptions. The shipped study bottle declares the SCBA cylinder it
   is (3.5 kg, 850 J/(kg·K), 20 W/K, all `estimated`). `hA` is still the least-known
   number on the stand, and the split of thermal effect between bottle wall and line
   walls depends on it — that part of the caveat stands.

**Quote the total thermal effect, not "+59 psi from line walls" alone**: the split
between bottle wall and line walls still rides on an estimated `hA`.

### 2.4c T-0 is an initial condition, not a burn result

A GN2 trace with collapse + vapour + walls + chilldown opened with a violent drop and
recovery at ignition. It was not the burn. The study primed a "loaded" LOX tank as if
freshly filled — wall at 293 K, interface 2 s old — so the `1/√t` collapse flux and
2.4 kW of wetted-wall boiling collapsed the ullage to 411 psig during the settle, and
the regulator catching up in 0.1 s read as an ignition transient.

Checks, in order:

1. **One wall node cannot describe a loaded cryogenic tank.** Set to 90 K it condenses
   the pressurant on the ullage face (N₂ at 39 bar saturates at 113 K); set to 293 K it
   boils the liquid. `TankState.wetted_wall_temperature` is the second node; `None`
   reproduces the old single lump exactly.
2. **A primed tank states its hold.** `prime(hold_s=300)`: interface contact time 300 s,
   wetted wall at liquid temperature, ullage wall at gas temperature.
3. **The settle checks it settled.** In `Ready` the actuator table shuts the press
   solenoids, so a collapsing ullage *drifts* — physical. `_stand` now tops up with the
   press valves forced open until every tank sits within 4 psi of lockup (wider than the regulator’s 0.5% dead band) for 0.5 s
   (2–10 s), then releases them. A trace note says if it never got there.
4. **A loaded tank already holds its vapour.** Primed dry, saturated LOX boiled ~15 psi
   of O₂ onto a locked-up ullage and nothing could take it back out. `initial_state`
   now seeds `p_sat(T_liquid)` of vapour (vapour model fitted, liquid present,
   `contact_time > 0`, `p_sat < p/2`) and the pressurant makes up the *rest* of the
   stated total. `NoVapour`: unchanged.
5. **What arrives is priced at where it came from.** Helium still rose 550 → 569 psig
   with `PR_D total −0.000 g`: the two primed tanks slosh a few g/s through the shared
   press manifold every step, and gas from the *fuel tank's* 293 K ullage was priced at
   the *bottle's* enthalpy — higher for He at 4500 psi, so each exchange pumped energy
   in (GN2 ran it the other way and cooled). `_pressurant_enthalpy` now reads the walked
   arrival at the ullage node regardless of the line-walls toggle; only a node nothing
   reached falls back to the bottle. Instrument: per-branch flows into the ullage node
   and the enthalpy each is priced at, when a tank warms with no net inflow.

Expected: with everything on, both gases settle in 2 s with no note, T-0 within 4 psi
of 550 psig (He 547.3, GN2 547.8), ullage ≈ 288 K, and an ignition dip within 5 psi
of the baseline's. The tank↔tank slosh itself (±5 g/s, ~1 psi at the inner step) is
the explicit-coupling artefact of §2.1's RC note, not physics.

### 2.5 Toggle discipline

Every optional physics model must satisfy both:

1. **Off is byte-identical.** `line_walls=False` reproduces the baseline trace
   exactly, not to a tolerance. Where an option changes which quantity is read —
   `_pressurant_enthalpy` reads the walked arrival instead of the bottle — that read
   must be gated on the toggle, because an adiabatic walk agrees with the bottle only
   to the walk's own convergence tolerance, and "agrees to a tolerance" is not
   "unchanged".
2. **On, with nothing declared, is also byte-identical.** A drawing that never gave
   `wall_thickness` or `fitting_mass` has no metal, so the option must be inert rather
   than subtly perturbing. Gate on the model having something to do, not just on the
   flag.

---

## Tier 3 — venting and the state machine

### 3.1 Blowdown against a hand-integrated choked isentrope

Fuel tank, 550 psi, 2.65 g of helium in 0.426 L of ullage, 3/8" solenoid Cv 3.8.

| | expected |
|---|---|
| simulator, to 25 psi | ≈ 30 ms |
| hand-integrated choked isentropic | ≈ 39 ms |

Agreement to ~25% is the honest expectation here: the network's line resistance
limits below the valve's own ceiling, which is physically right. What must **not**
happen is the simulator being *faster* than the choked limit — that means the sonic
ceiling is not being applied.

**On the shipped stand, the whole vent.** The operator's datum: the fuel tank vents
550 psig to zero in about a second. The drawings shipped with a 1/4" vent path (Cv 1.2
solenoid, 6.35 mm lines) that took 2.5 s to 10 psig — and raising the valve's Cv to 15
changed nothing, because the *line* was choked (a 6.35 mm bore passes ~0.29 kg/s of
N₂ at 565 psia; the ullage holds 0.12 kg). The tank vents now carry a 3/8" path (Cv 3.8,
9.525 mm, tagged `calibrated` with the observation) and the 2.6 L ullage reaches
10 psig in ~1.0 s. `tests/test_session.py::test_the_tank_vents_in_about_a_second`.
If the real vent hardware turns out to be something else, change the drawing, not the
test's expectation — the second is the measurement.

### 3.2 Isolation

With a main valve shut, the leg beyond it must **hold its own pressure** and not
track the tank down. Known-good: `MVO.out` sits at 14.7 psi while the tank vents.

There is a related open defect — a leg that is a genuine *dead end* is back-filled
from the node across the shut branch, and the hold-last-value guard does not arm for
a plain valve because its `pressure_drop(0.0)` is identically zero. Check both.

### 3.3 Vents must exist at all

A valve with exactly one port plumbed is a vent to atmosphere — pid-designer infers
it (`components/pid/vents.ts`) and feedtwin now reads the same rule. Assert:

- the free side becomes a **fixed 101325 Pa boundary**
- the inference is **reported in the run warnings** (inferring a boundary is a
  modelling decision and must be said aloud)
- a valve plumbed both ends is **not** a vent
- a spare **manifold** port is **not** a vent — it is a plug, and plugs are not drawn

### 3.4 The state machine must fail closed

`can_go` on a state whose row could not be parsed must refuse every non-abort target,
while **aborts stay reachable**. The shipped Diablo table has 10 malformed rows; that
is expected and documented in `feed-twin/backend/statemachines/NEEDS-REPAIR.md`.

Assert specifically: **`Idle → Armed → Fire` is refused.** That two-move path to
ignition is what fail-open allowed.

### 3.5 The actuator table, and hand holds

`diablo_actuators.csv` opens **Fuel Main and LOX Press in Idle** and **both mains in
Engine/Emergency Abort**, as the DAQ reads it. The twin obeys the aborts and warns;
**Idle it holds shut** (the de-energised state — read literally, a full bottle pressed
the LOX tank before anybody armed; see `NEEDS-REPAIR.md`). Asserted:

- `open_actuators("Idle")` is empty, and the warning names what the table claimed;

- a valve taken by hand is **released by the next state transition** — a transition
  writes every actuator the table knows. Before this, shutting Idle's open valves by
  hand pinned them for the rest of the session: Ox Press pressed nothing and Fire opened
  no fuel main (`test_a_state_change_takes_command_back_from_the_hand`);
- a valve the table never commands keeps the hand's position.

### 3.6 A filled bottle sags — by how much is the open number

`GN2 High Press` charges the bottle from GSE in `copv_fill_s` (25 s, the stand's own
pace). That is an **adiabatic charge**: 10 kg of N₂ into 44 L lands at 382 K in 25 s
and 342 K in 300 s (γ·T_supply is 410 K; the wall takes the rest), then sags toward
its steel — ~10 psi/s after a 25 s fill — and every tank pressed from it inherits the
heat (fuel ullage 411 K at 550 psig, collapsing to 480 in 6 s; 344 K and 517 from a
cold bottle). The operator read both as leaks — and reports the real stand's 25 s fill does *not*
sag like that. The still-gas wall conductance is the lever: a charge jet stirs the
vessel and forced convection off it runs several times natural. `Setup.fill_stirring`
multiplies `wall_conductance` while gas is being charged in (bottle during GSE fill,
ullage during a press; `GasVolume.rates(stirring=)` / `Tank.rates(stirring=)`, 1 =
old behaviour exactly). Sensitivity, 25 s fill of the 44 L bottle, then 60 s shut:

| stirring | gas / wall at fill end | 60 s later | fuel tank 10 s after a press |
|---|---|---|---|
| 1 (still) | 380 / 300 K | 3961 psig (−12%) | 433 psig |
| 5 | 357 / 308 | 4154 (−8%) | 461 |
| 10 | 345 / 313 | 4261 (−5%) | 480 |
| **20 (default)** | **336 / 316** | **4355 (−3%)** | **501** |

The tank column is with the stirring **gated**: it applies only while the tank is more
than 2 % below its supply (`STIR_BAND`). Ungated, it fired on the few grams a second two
tanks at lockup trade through the press manifold, ran a 293 K wall into 292 K gas at
20× natural, and ratcheted both tanks 16 psi above lockup in ten seconds — the study
could no longer settle at T-0. Inside the band the last of the charge heating decays at
the still-gas rate, so a pressed tank sags ~50 psi in the ten seconds after its solenoid
shuts (collapse onto the cryogen does the rest on LOX). Twenty is an order-of-magnitude
estimate. **Calibrate it against the bottle RTD after
a real GN2 High Press**: the wall reading at end of fill and the pressure sag over the
next minute pin it. The session says in its notes whenever the bottle gas is > 15 K
above its wall, and the fill supply is a bank at ambient (`FILL_SUPPLY_T`) rather than
the bottle's own warming wall.
`Setup.bottle_delivered` (default off) starts the bottle full and cold instead, for a
supplier's cylinder — but the Diablo table opens `LOX Press` in Idle, so a full
bottle would have pressed the LOX tank in Idle had the table been obeyed there (§3.5).

---

### 3.7 Operator walks

`tests/test_operator_walks.py` drives the shipped stand the way people do: the nominal
sequence to Fire; vent and re-press; the table's Vent state (both press solenoids *and*
both vents open — the tanks float at ~100 psig with the regulator blowing through
them); GN2 High Vent (on this drawing and the operator's own, GN2 Vent hangs off the
*regulated* manifold, so it bleeds the bottle through the regulator rather than dumping
it); GSE Abort (GSE High Press Vent dumps the bottle — GSE-side fill and vent are now
driven by the table's own `GSE High Press Control` / `GSE High Press Vent` actuators,
not by the state's name); Engine Abort from Fire (mains open, as the table says);
Emergency Abort → Idle (nothing moves); hand holds defeating a press until released;
Fire straight from Fuel Press (one of the seven bypasses — it burns, and warns); and a
200-move seeded random walk over the table. After every step: no NaN, nothing below
vacuum, no inventory below zero, and **every commanded valve is where the table says
unless a hand holds it**.

Two defects it caught on the way in: `LOX Fill` open drained the LOX tank at a few
hundred g/s *out* through its own fill valve (the free port was inferred as a vent to
atmosphere; it is the tanker's hose and now sits at the tank's pressure —
`Session._find_fill_stubs`), and GN2 High Vent drained the bottle through a rate the
table never commands.

### 3.8 What the cockpit does by default now, and why

Until 2026-09-11 the console ran with vapour off, chilldown off and no ambient heat
leak, so a loaded LOX tank with its vent shut sat at whatever it had been pressed to
forever. The operator knows a shut LOX tank climbs. Defaults are now: collapse on,
**vapour on, wall-to-liquid 100 W/(m²·K), an 8 W/(m²·K) air film on the tank skin in
series with the insulation the drawing declares, wall boiling on** (library defaults
unchanged: all off). The shipped LOX tank declares **an inch of fiberglass** (operator;
`insulation_thickness` 25.4 mm, `insulation_conductivity` 0.04 W/(m·K)), so its skin
passes `1/(1/8 + 0.0254/0.04)` = **1.3 W/(m²·K)**, ~75 W on 0.47 m² of skin at 200 K —
a bare tank sees 450 W. A chilled, insulated LOX tank shut at atmosphere climbs to
~15 psig in ten seconds and then creeps (the leak barely holds the wall above saturation
once the pressure has lifted it); a bare one runs on at a few psi a second. The tank
fill default is 120 s (was 30) so the wall has chilled by the time it is full. What
follows, each asserted:

- **A shut LOX tank at atmosphere climbs** (`test_a_lox_tank_at_atmosphere_with_the_vent_shut_climbs`):
  the leak arrives at the chilled wetted wall, the wall boils the LOX it touches when it
  is above saturation at the tank's *total* pressure, and the tank climbs a few psi a
  second — self-limiting, because the rising pressure lifts T_sat toward the wall's, so
  it settles in the tens of psig (the reason a LOX dewar's relief is 22 psig).
- **A pressed LOX tank does not run away** (`test_a_pressed_lox_tank_does_not_boil_at_the_wall`):
  at 38 bar of pressurant the liquid is 100 K subcooled; the leak warms the bulk.
- **A warm tank is a different animal.** A 293 K wall boils LOX at kilowatts (film
  boiling; 100 W/(m²·K) × 0.4 m² × 200 K ≈ 8 kW ≈ 35 g/s). Loaded in 30 s, the wall is
  still ~240 K when the vent shuts and the tank runs to the O₂ critical pressure
  (717 psig, the model's ceiling — the drawing has no relief valve; a note says so)
  before Ox Press. That is physics, not a bug: the real load takes minutes and the wall
  chills while venting. The pad guide's *Load LOX* phase is therefore not done until the
  wall is within 30 K of the liquid, and a note tells a manual operator to keep venting.
- **A vent takes the vapour with the pressurant.** `TankSim.advance` split the outflow
  only as pressurant; every gram a LOX tank boiled stayed in the ullage, and a tank
  venting 400 g/s through a wide-open 3/8" vent climbed to 500 psig *during its own
  fill*. Now split by mass fraction (`Tank.rates(mdot_vapour_out=)`) — but only for the
  share of the outflow that reaches a vent (`Session._vent_fraction` follows the solved
  flows to a boundary). Applied to the tank↔tank slosh too, vapour left one tank and
  came back as pressurant, and the study's no-collapse T-0 drifted +4 psi in 10 s.

### 3.8b The vessels are the stand's, not a guess

The shipped drawings carried 17.5 L tanks and a 44 L K-bottle tagged "manufacturer" —
invented, and the two most consequential numbers on the drawing: with them a burn lasted
9 s and the "COPV" barely blew down (4500 → 3900 psig), which the operator rightly called
broken. As of 2026-09-11 (operator): **LOX tank 3.99 US gal = 15.10 L; fuel tank 8.67 L
(6.5 kg of ethanol + 5 % ullage: 6.5/789.4/0.95); pressurant is the same 4.687 L SCBA COPV
the Study tab sizes.** Tanks load to 95 % (`FULL_FRACTION`, was 0.85). Diameters are still
*estimated* and only set static head and wetted area. Consequences the trace must show:

- the burn is **fuel-limited**: 6.5 kg at ~1.16 kg/s ≈ 5.6 s, with ~9 kg of LOX left;
- the COPV **blows down** through the burn: ~1 kg of GN2 to press 22 L of ullage growth
  out of the ~1.5 kg a 4.7 L bottle holds at 4500 psig (console run: 4500 → 1090 psig in
  6 s, chamber 385 → 374 psia, the regulator still holding).

**Small ullages are stiff.** A 5 % ullage on the fuel tank is 0.43 L — twenty grams of
gas. Two things had to change for that: the coupling step is now also bounded so one
step moves at most 4 % of any ullage's mass (the RC estimate uses the regulator's droop
slope, its stiffness *near* lockup; wide open it passes ten times its rated flow), and
the vessel clips the last step of a press onto its supply pressure (linearised, with
γ = 1.67 for the charge heating) and refuses the rest back to the bottle — before, the
fuel tank overshot lockup by 35–43 psi on the step that crossed it and the regulator
shut on it (`test_a_small_ullage_press_lands_on_lockup_not_past_it`; peak now 550.1).

### 3.9 The chamber is solved, not relaxed

Fire on the 7200 N doublet flip-flopped frame by frame between 718 psia — above the
tank pressure — and nothing. The cockpit closed the chamber loop with one relaxed step
per tick, `p_c += 0.3 (g(p_c) − p_c)`: a fixed-point iteration whose multiplier is
`1 − ω + ω g'` with `g' = −p_c / (2 Δp_inj)`. Stable for the 7000 N doublet (Δp_inj ≈
66 psi, multiplier −0.2); divergent for the 7200 N at Δp_inj ≈ 40 psi. It was also
tick-length dependent, because the factor was per step. `Session._close_chamber` now
finds the root by regula falsi on a bracket that always exists (ambient below, feed
pressure above), to 0.5 psi, warm-started so a quiet step costs no extra solve. Pc is
now the same to 1 psi at dt = 0.02, 0.1 and 0.2 s (`fire_probe2`: 440 → 385 psia
monotone; before: 1084 → 0 at dt 0.02, 579 → 260 at 0.1, 377 → 386 at 0.2).

And Fire is **integrated live** rather than precomputed and replayed: the ten-second
"Running sim…" freeze after Fire read as Fire doing nothing. A stand too stiff for real
time runs in slow motion and the top bar says by how much.

### 3.10 The console and the Study run the same numerics

The operator asked why the Study "takes a long time and gives very accurate seeming
results" while the console "seems hardcoded". Same `Session`, same physics, three
different numbers: the console capped Newton at 30 iterations (study 120), took one
0.25 s outer step per panel tick (study 0.01–0.02 s), and had a **0.15 s wall-clock
budget** that folded the remaining coupling steps into one when the solver fell behind —
which on a stiff stand is every tick, so the console was integrating a different scheme
from the one benchmarked here, and Fire was precomputed and replayed to hide it. Now
(`LIVE_STEP = 0.02`, `LIVE_ITERATIONS = 120`, `TICK_BUDGET = 1e9`): a panel tick of dt is
integrated as ⌈dt/0.02⌉ outer steps of 0.02 s, exactly the study grid, and nothing folds.
When a stand cannot keep up it runs in **slow motion** and the top bar says the ratio.
Asserted by `test_a_panel_tick_integrates_on_the_study_grid` (a 0.2 s tick advances the
clock in ten 0.02 s steps).

**MAWP.** Each vessel carries the MAWP its drawing declares (gauge; tanks 1000 psig,
COPV 6750 psig, both *estimated*). `Session._check_limits` runs after every step; a
vessel above its MAWP **trips the stand**: the frame freezes, `tripped` goes out on the
wire, state commands return 409, and the console covers itself with the vessel, the
pressure it reached and a Reset. Dome knob to 1000 psig, LOX loaded, GN2 High Press,
Ox Press: TK-LOX 722 → 1045 psig in one tick, trip
(`test_a_vessel_over_its_mawp_trips_the_stand`). The model could go on to the
propellant's critical pressure; a tank could not, and the point of the cockpit is that
the operator learns which knob did it.

**Regulators are knobs, not numbers.** The GSE Controls tab has two hand-loaded
regulators — high press (what the cart charges the COPV to) and dome control (what the
1092 locks the tanks up to, plus its 50 psi bias) — turned by dragging round them from
where they sit, by the wheel a detent at a time, or by the arrow keys; the red arc on the
dome knob is where lockup crosses the tanks' MAWP. Under each is the transducer the
operator would read. The console itself is the DAQ's dashboard (pressure cards, history
with the DAQ's window buttons, the actuator grid, the state diagram driven by the
backend's reachable set); nothing on it is set by typing.

### 3.11 A shut LOX tank climbs at tens of psi a minute, and why

The operator: "lox boiloff pressure goes up wayyy too fast, it's usually only like 20
psi/min." The model had it at ~100 psi/min for a few seconds and then almost nothing, and
after a two-minute load it ran to the critical pin in twenty seconds. Three closures, each
opt-in in the library, on by default on the cockpit, each a `Setup` field on the
Configuration tab (`backend/tunables.py`):

1. **Boiling regimes** (`chilldown_nucleate`, `leidenfrost_K`; `Tank(nucleate_conductance,
   leidenfrost_superheat)`). Film boiling (~100 W/(m²·K)) while the wetted wall is more than
   ~40 K above saturation; nucleate (~3000) under that, once the liquid wets the metal.
   `test_nucleate_boiling_takes_over_under_the_leidenfrost_point`: 30× the heat at 5 K
   superheat, identical at 100 K.
2. **Onset superheat** (`boiling_onset_K`, 2 K). A chilled wall under a 75 W leak sits a
   fraction of a kelvin above saturation. Before, that boiled the whole leak into the
   ullage; now it warms the liquid. `test_a_superheat_under_the_onset_warms_instead_of_boiling`.
3. **Stratification** (`stratification`, `surface_layer_m` 1 cm, `surface_mixing` 5;
   `Tank(surface_layer, surface_mixing)`, `TankState.surface_temperature`). The non-boiling
   wall heat and the interfacial heat warm a slab at the surface, not the bulk; the collapse
   and vapour closures see the surface temperature. The wall's share is bounded: liquid
   warmed at a wall arrives no hotter than the wall, so a layer at the wall's temperature
   takes nothing more from it (`test_the_surface_cannot_outrun_the_wall_that_warms_it`; without
   the bound a 2 K wall's stored 12 kJ put a 200 g surface 35 K above the metal and the tank at
   370 psig). The layer is also capped at saturation for the tank's pressure — a surface
   there boils, it does not superheat — and clear of the critical point
   (`test_the_surface_boils_at_saturation_instead_of_running_to_the_critical_point`; a
   room-temperature dry wall had run it to 154.6 K and frozen the tank at 0 psig).
   `test_the_surface_layer_warms_and_the_bulk_barely_does`.

Where the tens of psi a minute come from, then, is **warm hardware**: the dry wall above
the liquid, which the liquid never touched, is still ~200 K after a two-minute load; it
warms the ullage, the ullage warms the surface, the surface sets the pressure
(`test_a_shut_lox_tank_with_warm_hardware_climbs_at_tens_of_psi_a_minute`, library, 15 L
tank, 1.3 W/(m²·K) skin, dry wall 200 K: tens of psi/min, still ≥ 30 % of that in the second
half-minute; the old closure jumps and stalls to under a fifth). On the cockpit stand, primed and shut under the fiberglass, that
is ~26 psi/min over three minutes (`test_an_insulated_shut_lox_tank_climbs_slower_than_a_bare_one`;
bare is faster). A tank whose hardware has all cooled creeps at a psi or two a minute,
which is what a dewar does. The leak (an inch of
fiberglass; the un-insulated feed plumbing is not on the drawing), the layer depth and the
wall mass set the numbers; the tank's own shut-vent trace calibrates them, and each is one
row on the Configuration tab.

**The Study keeps the old closures** (`backend/study.py` sets `stratification=False`,
`boiling_onset_K=0`, `chilldown_nucleate=0`): its tanks are primed chilled and the Tier 2
expectations were set with a well-mixed liquid. Turn them on there deliberately, with a
fresh baseline — with them on, the line-wall check `test_wall_heat_reaches_the_ullage` went
the other way by 12 psi, which is a result to understand, not to absorb silently.

**What still runs away** is a tank loaded fast: with a ~7 kg aluminium wall the film-boiling
phase of the chilldown is ~2 min at h = 100, so a vent shut straight after a 120 s load
finds the wetted wall at ~230 K and it boils hard (that is regime 1 working as it should).
The pad guide's Load LOX phase waits for the wall; the wall mass, material and film
coefficient are Configuration rows because they are the unknowns.

Also in this round, at the operator's direction: **Fire ends in Vent** when a tank runs dry
(`Setup.auto_vent`, `Session._burnout_check`; the table's `Fire` row gained `Vent`), the
**fuel loads in 15 s** (`fuel_fill_s`; the cryogen keeps `tank_fill_s`), and the transition
table's `Press Standby` row was rewritten so the path is Press Standby → Ready → Calibrate →
Fire (see `statemachines/NEEDS-REPAIR.md`, "Twin-side edits").

## Tier 4 — the trap list

Each of these was a real bug that a passing test suite did not catch. Re-check them
whenever you touch the surrounding code.

### 4.1 Reference-state mixing

`ullage.energy` is the **pressurant's** internal energy in the pressurant's reference
state. LOX saturated liquid is −133.7 kJ/kg; helium at ullage conditions is
+628.6 kJ/kg. Adding one into the other is a category error and with ~2 g of helium
in a LOX ullage it inverts the state in one step.

Assert: turning vapour on **does not change `rates.ullage.energy`** (`rel=1e-12`).

### 4.2 Invented geometry wearing a real provenance tag

The shipped drawings once carried downstream legs that were never measured but were
tagged `measured` / `manufacturer`. It predicted Pc 321 psi against a 420 psi engine
and blamed the plumbing.

When a result looks wrong, **read the provenance of the inputs before doubting the
solver.** Also check for the OD-as-bore error: 1/2" tube is **10.92 mm** ID, not
12.7 mm. That mistake alone is worth ~40% in loss.

### 4.3 Dataclass fields dropped on rebuild

Rebuilding `TankState` (or `Setup`) field-by-field silently drops anything added to
the dataclass later. This is how `vapour_mass` reset to zero every step, and how
`ullage_collapse` turned itself back on whenever anyone nudged the dome.

**Use `dataclasses.replace`.** Assert that a step carries the newest field forward,
and that a settings update keeps a field the client did not send.

### 4.4 Non-physical states reported as success

A Newton residual can go to zero on a state that is not a pressure. The solver must
refuse an absolute pressure ≤ 0 as a failed solve rather than handing −6428 bar to
the property layer several frames from the cause.

### 4.5 A ceiling of 0.0 meaning "shut"

A regulator reports `flow_ceiling` 0.0 to mean *shut*. Pinning a branch whenever
`abs(mdot) >= ceiling` therefore pins **every** regulator closed. The `ceiling > 0.0`
guard is load-bearing.

### 4.6 Reverse flow through a regulator

The base class mirrors loss for reverse flow — correct for a pipe, catastrophic for a
regulator whose forward "loss" is the whole 4500→550 psi drop. It produced a 7900 psi
step at ṁ = 0 and a finite-difference slope of −2.7e16.

### 4.7 Documents destroyed by a successful-looking save

`POST /flush {}` used to replace a document with nothing and commit it to history,
returning `{"ok": true}`. Any endpoint whose payload model defaults its fields to
empty needs this check. Assert an empty body **preserves** and a full body **saves**.

### 4.9 Sonic flow against the gradient

A converged solve is not a physical one if a row has been pinned. The solver used to
write a branch in choked form whenever the Newton iterate's *flow* met the sonic
ceiling — regardless of the pressures. A pinned row does not depend on `p_dn`, so an
overshooting iterate on a helium press manifold converged with 0.188 kg/s of sonic
flow running *up* a 16 psi gradient into a tank already above its regulator's
setpoint: +13 psi per 0.45 ms sub-step into a 3 g ullage, ratcheting to 745 psig
against a 550 psig regulator. It looked exactly like a thermal effect.

**Check:** on any run where a vessel sits above the setpoint of the regulator feeding
it, instrument per coupling step: sum of vessel masses (must be constant), failed-solve
count (was 0), and the regulator branch flow with the pressures either side of the
branch that carried it. Flow with `p_dn > p_up` on a non-regulator branch is the tell.
Choked form by flow is now taken only when the component refuses to price the flow
*and* the gradient is forward.

### 4.8 Benchmarks that measure their own cache

A performance test that calls one state 20 000 times measures the memo, not the
property layer. Walk the state (`_STEP_K = 1.0e-6`).

---

## Reporting

State each check as **verified**, **failed with the number**, or **not run**. Do not
collapse those three into "looks good".

When something moved, give the old value, the new value, and the mechanism. "Pc is
now 440.6 instead of 438.5 because the thrust import began preferring
`target_thrust`" is a report. "Numbers shifted slightly" is not.

If you changed an expected value in this document, say so explicitly in your summary
and give the reason. **These numbers are the benchmark; silently editing them defeats
the entire purpose of the file.**

---

## Provenance of the numbers here

All values were produced against the code as of the Phase 14 work and cross-checked
against hand calculation, `fluids`, CoolProp or a handbook as noted per entry. The
suite counts are from a clean run of all five suites. Where a tolerance is not given,
the check is exact and a mismatch is a defect.
