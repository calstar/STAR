# Engine Design Learning Outline

## 1. Physics Foundation
- [x] Thermodynamics — first law, enthalpy, isentropic flow, stagnation quantities
- [x] Fluid mechanics — compressible flow, Mach number, choked flow, area-velocity relation
- [x] Chemistry — propellant reactions, stoichiometry, fuel-rich vs ox-rich, dissociation, why fuel-rich never crosses stoichiometric during transients

## 2. Engine Cycle & Structure
- [x] Combustion chamber sizing — L*, characteristic length, contraction ratio, convergent geometry
- [x] Nozzle design — de Laval nozzle, area ratio, throat geometry, why converging-diverging is required
- [ ] Propellant feed systems — pressure-fed vs. pump-fed cycles
- [ ] Injector design — impinging, coaxial, swirl types
- [x] Ignition sequencing — fuel lead/lag, hard start risk, LOX pooling vs fuel pooling, why fuel-rich never crosses stoichiometric during transients
- [ ] Hard starts — revisit in more depth; LOX-rich vs fuel-rich hard start danger (disagreement: LOX cannot ignite on its own and is stoichiometrically limited by available fuel — come back to this)
- [ ] Fuel combustion chemistry in fuel-rich conditions — what actually burns when there is insufficient LOX, incomplete combustion products (CO, H2, soot), and whether fuel can react at all with zero oxidizer (thermal decomposition / pyrolysis vs. combustion)

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

---

## Starting Point
1. [x] **Tsiolkovsky rocket equation** → understand Isp and why it matters
2. [x] **Isentropic flow relations** → understand how gas accelerates through a nozzle
3. [x] **NASA CEA** → run a first combustion simulation

**Reference:** *Rocket Propulsion Elements* — Sutton & Biblarz (chapters 3 & 5)
