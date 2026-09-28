# ethalox_6500N.yaml: full config audit (2026-09-25)

Scope: every number in `configs/ethalox_6500N.yaml`, checked against sources outside this
codebase:
- NASA CEA through rocketcea
- CoolProp 7.2
- the `fluids` library
- NASA SP-8089, Huzel & Huang, Sutton
- vendor and datasheet values
- hand calculation

The rule from `docs/PHYSICS-BENCHMARK.md` applies: **you cannot verify the sim with the sim.** A
number is "verified" here only when an outside source agrees with it.

Five reviews ran in parallel: propellants and combustion, chamber/nozzle/thermal, injector,
tanks/feed/pressurant, and vehicle/flight. The claims that drive the ranking below were
re-checked by hand. They are marked **(re-checked)**.

## Verdict

**The config is not ready for flight hardware.** The engine's design point is sound:
- the independent CEA solve reproduces Pc, mdot, O/F and Cf to within 0.1 %;
- injector pressure drop, chug margin and cavitation margin are healthy;
- there is no nozzle flow separation.

Around that design point, though, there is a list of problems:
- **Tank pressure:** the tanks run at their yield point.
- **Pressurant:** the GN2 load does not cover the burn once LOX-side collapse is counted.
- **Feed losses:** the feed lines and losses are the test stand's, not the vehicle's.
- **Undefined hardware:** the vehicle geometry is a leftover template, and parts of the nozzle
  and insert hardware are not defined at all.
- **Thermal model:** its root-cause bug is now identified.

None of these can be fixed by editing numbers alone. Several need a hardware answer first.

## The chamber width question

The 127 mm bore (contraction ratio 8.26, face to throat 154 mm) is **acceptable, but it was not
chosen**.

**What set the bore.** The frozen 6.5 in sleeve minus 2 × (0.5 in liner + 0.25 in wall) fixes
it at exactly 5.000 in. L* is pinned at 1.0 m (min = max), and the chamber-mass objective
favours a fat chamber at fixed volume. Nothing in the model penalises a short chamber.

**What it buys, at fixed L* 1.0 m:**
- lowest Rayleigh loss (0.30 %, chamber Mach 0.072);
- lowest convective heat load (about 170 kW, against 267 kW at CR 5);
- lowest mass.

Residence time is 1.35 ms at every CR.

**What it costs:**
- **Vaporisation length.** At SMD 100 µm, ethanol is 69–83 % vaporised by the throat here, against
  79–91 % at CR 5. At SMD 50 µm the length does not matter. Real SMD for 1.4–1.5 mm jets at
  35 m/s is likely near 100 µm.
- **Face-corner recirculation.** 60 % of the bore lies outside the ~80 mm impingement ring, which
  can streak the liner near the face.
- **Transverse stability.** It trends the wrong way: 1T mode about 5.4 kHz, low chamber Mach, less
  nozzle damping.

**Literature.** Small student engines commonly run CR ≈ 8 (the ASU 405 lbf paper, citing Humble).
The Humble curve fit (quoted from memory, to be checked in the book) gives CR ≈ 4.5 and a
149 mm chamber length for this throat. So the length is typical and the area ratio is about
1.8× typical.

**Recommendation:**
- **Sleeve already bought:** keep the bore, and design the barrel to take a ~50 mm spacer ring
  (takes L* to about 1.4 m).
- **Sleeve not bought:** CR 5–6 in a 5.4–5.75 in OD sleeve is the textbook choice. It is about
  +1.3 kg and +69 mm long.

Either way, measure c* in hot fire. Do not choose a bore from EngineDesign's efficiency or
thermal output (see C-5).

## Critical: must be resolved before loading propellant

**C-1. The tanks run at yield** (re-checked).

The header names Seamless Tanks 6.625 in OD aluminium air tanks. The maker rates them at 200 psi
(vendor listings). The only test data found is from Honkawa Rocketry: at about 0.058 in wall they
start to balloon at about 620 psi, and Honkawa's MEOP is 413 psi.

- **Hoop stress at 584 psi:** 33.1 ksi on a 0.058 in wall (hand calculation). That is 95 % of
  6061-T6 yield (35 ksi); yield itself is reached at 618 psi.
- **End-of-burn pressure:** the regulator's supply-pressure effect (TB 1031: 17 psi per 1000 psi
  of inlet drop) and lock-up add roughly 50 psi and 25 psi. That puts end-of-burn MEOP at about
  630–650 psi, above yield.
- **The limit is not structural:** `max_*_tank_pressure_psi: 600` has no MAWP behind it. The
  sibling `ethalox_6500N_375psi.yaml` says so itself.
- **Relief:** no relief setting fits between MEOP and yield.
- **Action:** get a proof/burst-tested MAWP on flight-lot tanks (cryo-cycled for the LOX tank), or
  change the tanks. Then set the tank limit, the regulator setpoint and the relief valve from
  that number.

**C-2. The GN2 pressurant does not cover the burn** (N2 properties re-checked).

The header's "needs 0.528 kg, delivers 1.098 kg, 2.08×" is isothermal at 293 K with no regulator
headroom. Two effects break it:

- **LOX-side condensation.** Tank pressure (~598 psia) is above N2's critical pressure
  (492.5 psia). At 100 K N2 is 708 kg/m³, a dense liquid. Warm GN2 entering the LOX tank
  condenses and dissolves instead of pressurising.
- **Cold arrival.** The COPV expands close to adiabatically in 4 s. Gas arrives at about 215–240 K,
  60–68 kg/m³.

Transient blowdown results (Audit D), by LOX collapse factor (CF):

| Collapse factor | Result |
|---|---|
| 1.0 | ends about 250 psi above tank pressure |
| 1.25 | regulation lost at 3.84 s |
| 1.5 | lost at 3.44 s |
| 2.0 | lost at 2.85 s |

The expected CF for GN2 on LOX is 1.5–3×. The team's own `feed-twin/docs/copv-study.md` already
found the stand bottle "on its knee with zero margin".

Options:
- helium at 4500 psig, which passes to CF 1.5 (it does not condense, and warms on throttling);
- a bigger bottle;
- a lower tank pressure, which C-1 forces anyway;
- a measured collapse factor from a stand test.

**C-3. The feed losses are the test stand's, not the vehicle's.**
- **What the config carries:** `feed_system` lengths are the stand's 3 ft fuel leg and 4 in LOX leg
  (the stand's LOX leg is actually 8 in). The K values are fL/D plus a sharp exit: no valve, no
  bends, no fittings.
- **Realistic vehicle drops:** the vehicle layout implies a fuel run of 2.4 m or more. Realistic
  drops are 31–80 psi (LOX) and 74–112 psi (fuel), against the modelled 13 and 27 psi.
- **Tank outlet port:** add 35–93 psi more if the outlet is the tanks' 3/8 NPT port.
- **Budget:** tank-to-Pc headroom is only about 164 psi. Either Pc and thrust fall, or the regulator
  must be set higher, which C-1 forbids.
- **Other gaps:**
  - The line velocity head dumped into the manifold (about 1·q, i.e. 13–20 psi) is not modelled.
  - A 2.5 m fuel run alone moves O/F to 1.67 (+11 %).
  - Line inertance is 2.8–5× the modelled value, so the chug margin is unverified for the
    vehicle.
- **Action:** model the flight plumbing from the vehicle routing, valve by valve.

**C-4. The nozzle downstream of the graphite is undefined, and the insert heats through.**
- **Undefined section:** the graphite insert ends about 33 mm past the throat (ε ≈ 2.4), and
  `nozzle_ablative: false`. Heat flux near ε 2 is 5–10 MW/m², so the ε 2.4–5.6 section needs a
  defined material before any fire.
- **Heat-through:** the 6 mm insert's back face passes 2000 K by 4 s. Recession is 0.4–0.8 mm
  per burn, which confirms the header's 0.4 mm as the low end.
- **Cumulative erosion:** over a static-fire campaign the throat area opens 15–31 %.
- **Action:** measure Dt after every fire, define the insert backing and retention, and fly a
  fresh insert.

**C-5. Thermal model root cause** (re-checked).

`calculate_gas_viscosity_huzel` has the bug (`engine/pipeline/thermal/regen_cooling.py:82`, and
the same code in `engine/accel/kernels.py`).
- **The unit error:** it converts Huzel's result, which is in lbm/(in·s), with the lbf·s/in² factor
  (6894.76 instead of 17.858).
- **Size:** the code returns **0.0275 Pa·s** at 3225 K, M 22.25. The correct value is
  **7.1e-5 Pa·s** (CEA gives 1.04e-4). That is 386× high, the value of g_c, so h comes out about
  117× low.
- **Compounding errors:** with a hot-gas k of 0.12 (CEA: 0.35), the stale regen bore of 84.9 mm
  (real: 127 mm), which is read even though regen is disabled, and a gas emissivity of 0.85
  (hand estimate: 0.3–0.5), this explains the long-known "ablative convection ~283× low".
- **Where it reaches:** through `use_cooling_coupling: true` it feeds η, and so Isp and apogee.
- **Action:** until it is fixed (a physics change: run `scripts/physics_benchmark.py`), do not size
  the liner or choose a bore from the thermal output.

## High: fix before the next hot fire

**H-1. Injector manifold channels are undersized.**
- **Size:** 22.8 / 24.0 mm², which is 0.50× / 0.63× of the orifice area they feed.
- **Why it matters:** fed from one inlet, channel velocity is 32 / 30 m/s, about jet speed. Channel
  dynamic pressure is 63 % / 40 % of the injector Δp. Combined with oblique flat-floor entries
  (short wall L/d 3.5 < SP-8089's 4), that means flow maldistribution and skewed jets.
- **Target:** at least 81 / 68 mm² for manifold q ≤ 5 % of Δp, better about 125 mm²; or a
  distribution ring / multiple inlets. Cone or spot-face the entries.

**H-2. The obvious flow test will mislead** (re-checked).
- **The trap:** water into 1 atm at the design Δp (137 / 124 psi) gives cavitation number
  K = 1.105, below K_crit = 1.665. The holes cavitate and read Cd ≈ 0.65.
- **The wrong fix:** "correcting" the holes to that reading gives hot-fire Cd ≈ 0.985, which drops
  fuel Δp/Pc to about 0.20 and raises Pc to about 462 psia.
- **How to test:** use 91 psia or more of back pressure, or Δp ≤ 21 psi at 1 atm.

**H-3. The zero-residual propellant split has no O/F margin.**
- **Where the uncertainty comes from:**
  - LOX density depends on its temperature at load (1126–1151 kg/m³, a swing of −80 g to +61 g);
  - hole tolerance of ±0.025 mm moves O/F ±3 %;
  - a Cd mismatch between the two sides moves it up to ±11 %.
- **Consequence:** there is roughly a 50 % chance that fuel runs out first, giving a LOX-rich
  shutdown on a graphite throat and ablative liner.
- **Action:** after the flow test, bias the load 1–3 % fuel-rich, and load against the measured
  LOX temperature.

**H-4. Fuel identity is unconfirmed.** The config assumes neat ethanol, and nothing in the repo
says otherwise. A 75 wt % blend would lower c* 4.8 % and Isp 3.4 %, move the optimum O/F to
1.40, and change density, viscosity and SMD. **Operator question.**

**H-5. The igniter port is short.** A 1/2 NPT thread needs L2 = 13.56 mm of engagement, and the plug
is 12.70 mm. The hot-gas seal does not reach wrench-tight engagement. Add a boss of 14 mm or more
(`hub_thickness`), or use a straight-thread O-ring port.

**H-6. Flight simulation cannot be trusted as shipped** (re-checked in `ui/flight_sim.py`).
- **Drag:** it is a hardcoded constant, Cd 0.45 at every Mach number (max Mach 0.87). A build-up
  for this body gives about 0.7–1.0, which puts apogee 1,000–2,500 ft below the claimed 12,760 ft.
- **Fill bug:** the sim seeds each tank with 0.05 kg of GN2 at 50 kg/m³ (1.0 L). A 10 % ullage LOX
  tank has 0.64 L free, so the shipped config fails in the sim.
- **Not reproducible:** 12,760 ft cannot be reproduced from the header's own thrust curve.

**H-7. The ceiling is not enforced, and its datum is unknown.** 15,000 ft appears nowhere in code or
config, and `target_apogee` is a stored output, not a limit.
- **If the ceiling is MSL:** the AGL ceiling is about 12,944 ft, and the Cd 0.45 prediction
  (about 13,200 ft) already exceeds it.
- **Action:** state the datum and add a `max_apogee` requirement.

**H-8. Vehicle geometry is a leftover template.** Radius, fins, `cm_wo_motor`, inertia, tank
positions, the 4.0 m avionics bay and `propulsion_dry_mass` all trace to the January methalox
`default.yaml`.
- **Diameters don't fit:** the airframe OD (6.17 in) is smaller than both the 6.625 in tanks and the
  6.5 in chamber.
- **Inertia:** [8, 8, 0.5] is the router default; the real Ixx is about 150–220 kg·m².
- **Stacking:** there is a 1.8 m empty gap between the tanks, and the sim builds a 7.76 m vehicle,
  not 6.43 m.
- **Static margin:** computed at 7.3–8.4 calibres, grossly overstable.
- **Mislabelled limit:** `min_stability_margin` is the combustion chug margin, not flight static
  margin.
- **Action:** take all of these from the vehicle CAD and scale.

## Medium: wrong numbers with bounded effect

| Item | Config | Correct / independent | Effect |
|---|---|---|---|
| LOX bulk modulus | 1.5e9 Pa | 0.937e9 (CoolProp, re-checked); ~0.9e9 with tube compliance | LOX feed acoustic frequencies 24–28 % high in the stability model |
| LOX specific heat | 2300 | 1699 J/kg·K (CoolProp, re-checked) | Unused today (latent hazard) |
| LOX viscosity | 1.8e-4 | 1.96e-4 (sat. 90 K) to 2.03e-4 (584 psia) | SMD about −2 % |
| spray chamber_gas_T / R | 3094 K / 389 | 3226 K / 374 at O/F 1.5 (CEA, re-checked); config values are at O/F 1.35 | ρ_g cancels; k_evap 10 % low |
| Model P_exit | reports 94.04 kPa | CEA 87.2 kPa (re-checked); code uses equilibrium γ as an isentrope | Any exit-pressure gate is biased; thrust unaffected |
| Momentum ratio R | band 0.95–1.05 | Actual 1.053 (violated, unaudited); Rupe's own ratio is 1.204 (re-checked) against an optimum of 1.0 | A few % mixing; `design_audit.py` does not check R |
| `design_audit.py` Δp check | (P_tank − Pc)/Pc | Should be injector-only: 0.317 LOX / 0.286 fuel | Checks the wrong quantity |
| Phenolic k / cp / density | 0.35 / 1500 / 1600 | MX-2600 silica phenolic ≈ 0.87 / 920–1170 / 1700–1750 | Char depth predicted ~1.8× too shallow |
| Graphite density / cp | 2260 / 710 | Isomolded 1770–1850; cp ~1850–2000 at 1500–2500 K | Recession and heat-through understated |
| Graphite oxidation model | air/O2 constants, +32.8 MJ/kg | Throat oxidisers are H2O and CO2; the reactions are endothermic (−10.9 / −14.4 MJ/kg C) | Wrong regime and wrong sign |
| Tank radii | LOX 5.5 in, fuel 6.0 in | 6.625 in OD tanks, ID ~6.34–6.51 in | CG, stack and heights wrong |
| Tank lengths (header) | 14.99 / 14.50 in | 15.31 / 14.84 in (vendor volume fit) | Bought at 15.0 / 14.5 in: 7.7 % / 7.4 % ullage, not 10 % |
| `burn_time`, `target_burn_time` | 3.994 s | 3.8978 s (integrated) | Stale from the 6405 N build; the validator overwrites `thrust.burn_time` from `target_burn_time` |
| Regulator curve | "flat" | Rises ~45–55 psi over the burn (TB 1031); code constant is 10 psi/1000 | Feeds C-1 |
| Tank pressure units | 584.27 "psi" | Engine treats it as psia (570.6 psig at site) | 14 psi ambiguity at the regulator gauge |
| Element pitch | limit 22.5 mm | Actual 22.97 mm; passes because the squared miss is under the gate epsilon | Guard does not bite |
| `layer1_min_Lcyl_over_D` | unset | Barrel L/D is 0.776 | Guard off |
| `max_nozzle_exit_diameter` 8 in, `max_chamber_outer_diameter` 6.5 in | | Both larger than the airframe OD | Inconsistent |

## Stale notes and dead keys

- The header's "time_varying_solver hardcodes Pa = 101325; +61.4 N by hand" is **stale**. The
  solver now derives Pa from the elevation (re-checked). Applying the hand correction to new
  output double-counts it.
- These keys are unused and should be deleted or wired up:
  - discharge: `Cd_inf`, `cd_inf_*`, `d_ref_m`, `cd_small_hole_exponent`, `cd_large_hole_log_gain`,
    `d_min_m`, `Cd_min`, the P/T corrections;
  - efficiency: `C`, `K`, `use_finite_rate_chemistry`, `use_shifting_equilibrium`;
  - spray: Lefebvre `C`/`m`/`p`, the pintle block, `spray_angle` `k`/`n`, evaporation `K`;
  - requirements: `propulsion_dry_mass`, `propulsion_cm_offset`, `thrust.design_thrust`,
    `layer1_injector_counterbore_dia_m`, `layer1_injector_min_face_incidence_deg`;
  - `environment.date`.
- `regen_cooling` is **not** unused while disabled: the ablative path reads its gas properties and
  its stale 84.9 mm bore (feeds C-5).
- η_c* 0.95 is not predicted. It is `Em_peak: 0.96` restated (η_mix = Em_peak × 0.9999). Plan
  performance on 0.88–0.95 until hot fire. At 0.88, apogee is about −1,570 ft, Pc about 402 psia
  and thrust about 6.0 kN.
- The spray model (Ingebo) is used outside its validated domain. The design also fails its own
  x* limit (0.0544 against 0.05 m), silently.

## Verified (sourced, no action)

- **Design point** (independent tank → line → orifice → chamber solve, CEA c* 1725.4 m/s):
  Pc 433.8 psia, O/F 1.500, mdot 2.798 kg/s.
- **CEA thermochemistry:** the ethanol heat of formation is correct (−277.69 kJ/mol; the old CEARUN
  trap is cleared).
- **Geometry:** At, Ae, ε, Cf and the chamber geometry, all to within 0.3 %.
- **Injector:** Δp/Pc is 0.32 LOX / 0.29 fuel, inside the 0.2–0.4 band (SP-8089 asks for 0.10–0.15
  for unlike doublets). It holds late in the burn.
- **Cavitation:** none in hot fire; LOX margin is 2.4×.
- **Impingement:** free jets of 5.2 d and 6.0 d, inside SP-8089's 5–7 d.
- **Nozzle:** no separation (Pe/Pa 0.93).
- **Fuel properties:** density, viscosity, surface tension, vapour pressure, latent heat, boiling
  point, molecular weight and critical temperature all match CoolProp/NIST to within 3 %.
- **Site:** elevation (USGS 624 m), coordinates, and ambient pressure (94.07 kPa).
- **Masses:** the mass sum is 81.65 kg = 180.0 lb (arithmetic).
- **COPV:** gas mass 1.312 kg is GN2 at about 4000 psig and 293 K in 4.619 L. The COPV dry mass
  matches MSA's H-30 spec.

## Operator questions

1. Which fuel is actually bought (neat ethanol or a blend, and what denaturant)?
2. What is the tanks' tested MAWP? Is the LOX tank cryo-rated?
3. Is the 6.5 in × 0.25 in sleeve already bought, and in what material?
4. What material covers the nozzle from ε 2.4 to 5.6? How is the graphite insert backed and
   retained?
5. What is the flight plumbing: routing, valves and fittings, and the tank outlet port size?
6. Is the regulator setpoint in psig or psia? What regulator is it, and what are its lock-up and
   supply-pressure effect?
7. What is the source and datum (AGL or MSL) of the 15,000 ft ceiling, and the source of the
   "16 L rule"?
8. What is the real airframe OD? Are the tanks structural skin?
9. What are the CAD masses, CG, inertia, fin datum and tank stack positions?
10. What is the launch rail length and angle at FAR?

## Tests that settle what analysis cannot

- **Injector cold flow, per side:** at ≥ 91 psia back pressure, or Δp ≤ 21 psi at 1 atm. Gives Cd
  per side and the O/F trim.
- **Tank proof / burst on flight-lot vessels:** cryo-cycle the LOX tank.
- **GN2-on-LOX pressurisation test:** measures the collapse factor.
- **Hot fire:**
  - c* and η_c*;
  - high-rate Pc (≥ 25 kHz) for transverse modes;
  - throat diameter measured after every fire;
  - section the liner to measure char depth.
