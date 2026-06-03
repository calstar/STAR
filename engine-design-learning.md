# Engine Design Learning Outline

## 1. Physics Foundation
- [ ] Thermodynamics — combustion, heat transfer, isentropic flow
- [ ] Fluid mechanics — compressible flow, Mach number, choked flow
- [ ] Chemistry — propellant reactions, specific impulse, stoichiometry

## 2. Engine Cycle & Structure
- [ ] Combustion chamber sizing — L*, characteristic length
- [ ] Nozzle design — de Laval nozzle, area ratio, throat geometry
- [ ] Propellant feed systems — pressure-fed vs. pump-fed cycles
- [ ] Injector design — impinging, coaxial, swirl types

## 3. Performance Optimization
- [ ] Specific impulse (Isp) — the key figure of merit
- [ ] Mixture ratio (O/F) optimization
- [ ] Thrust coefficient and characteristic velocity (c*)
- [ ] Nozzle expansion ratio for altitude optimization

## 4. The Design Pipeline
- [ ] Mission requirements → thrust & burn time → propellant mass
- [ ] Chamber pressure selection → nozzle sizing → injector design
- [ ] Thermal analysis → regenerative or ablative cooling
- [ ] Iteration via tools — RocketCEA, OpenFOAM, NASA CEA

## 5. Practical Engineering
- [ ] Combustion instability — chugging, screaming
- [ ] Structural loads and pressure vessel design
- [ ] Testing — hot fire, cold flow

---

## Starting Point
1. [x] **Tsiolkovsky rocket equation** → understand Isp and why it matters
2. **Isentropic flow relations** → understand how gas accelerates through a nozzle
3. **NASA CEA** → run a first combustion simulation

**Reference:** *Rocket Propulsion Elements* — Sutton & Biblarz (chapters 3 & 5)
