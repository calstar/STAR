# Engine Design Learning Outline

## 1. Physics Foundation
- [x] Thermodynamics — first law, enthalpy, isentropic flow, stagnation quantities
- [x] Fluid mechanics — compressible flow, Mach number, choked flow, area-velocity relation
- [x] Chemistry — propellant reactions, stoichiometry, fuel-rich vs ox-rich, dissociation, why fuel-rich never crosses stoichiometric during transients

## 2. Engine Cycle & Structure
- [x] Combustion chamber sizing — L*, characteristic length, contraction ratio, convergent geometry
- [x] Nozzle design — de Laval nozzle, area ratio, throat geometry, why converging-diverging is required
- [x] Propellant feed systems — pressure-fed vs blowdown; polytropic pressurant expansion (n=1.2, GN2); blowdown ratios LOX 1.47 / fuel 1.80; injector orifice equation; brentq Pc solve at each timestep
- [x] Injector design — impinging (like-on-like vs unlike, O/F distribution sensitivity), coaxial (shear/Kelvin-Helmholtz atomization, velocity ratio = (ṁ_out/ṁ_in)·(ρ_in/ρ_out)·(A_in/A_out), why LOX/LH2 works and LOX/ethanol doesn't), swirl (tangential entry, hollow spinning cone, self-contained breakup), pintle (central post radial spray + annular axial flow, TMR sets spray angle, blockage, throttleable, acoustically stable); oxidizer through central post (coking, cryogenic cooling, wall protection); radial vs axial trade-off (wall heat flux vs mixing length vs L* requirement); D² droplet vaporization law; L* is the full vaporization budget across the droplet size distribution — no clean zones, no effective L*
- [x] Ignition sequencing — fuel lead/lag, hard start risk, LOX pooling vs fuel pooling, why fuel-rich never crosses stoichiometric during transients
- [x] Hard starts — pressure spike mechanism (accumulated propellant → bulk ignition → transient above design Pc); LOX-rich danger is oxidizer-rich combustion burning hardware + rapid vaporization pressure spike, NOT self-ignition (LOX cannot ignite without fuel); fuel-rich accumulation is the harder pressure spike concern (fuel vapor deflagration across full chamber volume); fuel-lead mitigates LOX pooling; pre-purge causes ignition failures in student teams because spark igniters need a flammable mixture at the gap — without purge, air O₂ establishes the pilot flame kernel (stoichiometrically limited → small, self-terminating combustion event)
- [x] Fuel combustion chemistry in fuel-rich conditions — excess fuel cannot combust (no oxidizer available); undergoes endothermic thermal decomposition (pyrolysis) at 3000 K producing CO, H₂, fragments; fuel-rich is cooler for two reasons: (1) incomplete oxidation releases less total heat (CO instead of CO₂ = 283 kJ/mol locked away; H₂ instead of H₂O = 242 kJ/mol locked away) — dominant effect; (2) endothermic decomposition of excess fuel absorbs heat from products — secondary effect; "thermal ballast" framing is imprecise — excess fuel is a heat sink via endothermic reactions, not inert mass; Isp peaks fuel-rich because lower Mw exhaust (CO, H₂) outweighs the temperature penalty in the sqrt(T/Mw) term

## 3. Performance Optimization
- [x] Specific impulse (Isp) — the key figure of merit, Isp = c* · Cf / g0
- [x] Mixture ratio (O/F) — stoichiometric vs optimal, why fuel-rich wins on Isp + protection + safety
- [x] Thrust coefficient (Cf) — nozzle figure of merit, momentum + pressure thrust terms
- [x] Characteristic velocity (c*) — combustion figure of merit, independent of throat geometry
- [x] Nozzle expansion ratio for altitude optimization — ε → Me → Pe direction chain (larger ε → higher Me → lower Pe); fixed compromise means slightly overexpanded at launch, perfectly expanded at design altitude, underexpanded above; Summerfield separation criterion Pe/Pa < ~0.4; Cf vs altitude numerical table for the engine (ε=4.54 is diameter-constrained, near-optimal for low-altitude sounding rocket burn)
- [x] Γ(γ) function — choked mass flux: ṁ = P0·At·Γ/sqrt(Ru·T0/Mw); appears in c* denominator and Cf momentum term; cancels completely in the c*·Cf product — Γ does not appear in Isp
- [x] R_u — universal gas constant 8.314 J/(mol·K); specific gas constant R = R_u/Mw; R_u/Mw in exit velocity equation is thermal energy per kg — lower Mw means more energy per kg for the same flame temperature

## 4. The Design Pipeline
- [ ] Mission requirements → thrust & burn time → propellant mass
- [ ] Chamber pressure selection → nozzle sizing → injector design
- [ ] Thermal analysis → regenerative or ablative cooling
- [x] Iteration via tools — NASA CEA

## 5. Practical Engineering
- [ ] Combustion instability — chugging, screaming
- [ ] Structural loads and pressure vessel design
- [ ] Testing — hot fire, cold flow

## 6. Code Deep Dives (revisit after understanding the parts)
- [ ] Supply vs. demand pressure equilibrium — how ChamberSolver.solve() works, brentq on mdot_supply(Pc) = mdot_demand(Pc), and why Pc emerges from physics rather than being prescribed
- [ ] O/F ratio in the optimizer — why it's a config input not a sweep variable, how Layer 1 drives injector geometry to hit the target MR, and how MR is computed dynamically from actual flow rates during simulation
- [ ] Optimization engine deep dive — how the actual optimizer works: CMA-ES (Covariance Matrix Adaptation Evolution Strategy), the hybrid CMA-blocks mode, what the objective function looks like across all 10 Layer 1 variables, how the optimizer avoids local minima, and why gradient-free methods are needed here

---

## Starting Point
1. [x] **Tsiolkovsky rocket equation** → understand Isp and why it matters
2. [x] **Isentropic flow relations** → understand how gas accelerates through a nozzle
3. [x] **NASA CEA** → run a first combustion simulation

**Reference:** *Rocket Propulsion Elements* — Sutton & Biblarz (chapters 3 & 5)
