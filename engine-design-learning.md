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

## 3. Performance Optimization
- [x] Specific impulse (Isp) — the key figure of merit, Isp = c* · Cf / g0
- [x] Mixture ratio (O/F) — stoichiometric vs optimal, why fuel-rich wins on Isp + protection + safety
- [x] Thrust coefficient (Cf) — nozzle figure of merit, momentum + pressure thrust terms
- [x] Characteristic velocity (c*) — combustion figure of merit, independent of throat geometry
- [ ] Nozzle expansion ratio for altitude optimization

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
