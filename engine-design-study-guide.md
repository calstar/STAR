# Engine Design Study Guide

Concise reference covering key equations and physical intuitions. No derivations — just the results and the reasoning behind them.

---

## 1. Tsiolkovsky Rocket Equation

$$\Delta v = I_{sp} \cdot g_0 \cdot \ln\left(\frac{m_0}{m_f}\right)$$

- **g_0** = 9.81 m/s². **Isp** in seconds is unit-system independent.
- Isp is the only lever that scales linearly with delta-v. Mass ratio is logarithmic — adding propellant gives diminishing returns fast.
- LEO requires ~9,400 m/s. At Isp = 250 s (solid): mass ratio ~42. At Isp = 450 s (LOX/LH2): mass ratio ~8.5.

**Isp reference:**

| Propellant | Isp vac (s) |
|---|---|
| APCP solid | ~250 |
| LOX / RP-1 | ~380 |
| LOX / Ethanol | ~370 |
| LOX / LH2 | ~450 |
| Ion thruster | ~3000 |

---

## 2. Stagnation Enthalpy

$$h_0 = h + \frac{v^2}{2}$$

- **h = u + P/ρ** — enthalpy bundles internal energy and flow work. Flow work (P/ρ) appears because fluid crossing a boundary has to push itself in — no analog in closed systems.
- In a nozzle (adiabatic, no shaft work): h_0 is conserved. High h and low v in the chamber; low h and high v at the exit. Thermal+pressure energy converts one-for-one into kinetic energy.

---

## 3. Isentropic Relations

Isentropic = adiabatic + reversible (ds = 0). The working assumption for nozzle core flow.

$$\frac{T_0}{T} = 1 + \frac{\gamma-1}{2}M^2$$

$$\frac{P_0}{P} = \left(1 + \frac{\gamma-1}{2}M^2\right)^{\gamma/(\gamma-1)}$$

$$\frac{\rho_0}{\rho} = \left(1 + \frac{\gamma-1}{2}M^2\right)^{1/(\gamma-1)}$$

All three share the same base. Exponents are 1, γ/(γ-1), and 1/(γ-1) for T, P, ρ respectively. At M=0 all ratios = 1. As M increases, local T, P, ρ all drop.

---

## 4. Area-Velocity Relation & Choked Flow

$$\frac{dA}{A} = (M^2 - 1)\frac{dv}{v}$$

- **M < 1:** accelerating flow needs a converging section (dA < 0)
- **M > 1:** accelerating flow needs a diverging section (dA > 0)
- **M = 1:** dA = 0 — the throat

**Why converging-diverging is required (not just efficient):** The sign of the required geometry flips at M = 1. A purely converging nozzle can only reach M = 1 at its exit — it cannot produce supersonic flow. The diverging section is geometrically necessary, not optional.

**Choked flow:** When the pressure ratio is large enough that M = 1 is reached at the throat, mass flow saturates and becomes independent of downstream pressure. The upstream signal speed (a - v) equals zero at M = 1 — disturbances downstream cannot propagate upstream. The two flow regions are causally decoupled.

---

## 5. Exit Velocity

$$v_e = \sqrt{\frac{2\gamma}{\gamma-1}\frac{R_u T_0}{M_w}\left[1 - \left(\frac{P_e}{P_0}\right)^{(\gamma-1)/\gamma}\right]}$$

- **T_0** — chamber stagnation temperature. Higher is better.
- **M_w** — exhaust molecular weight. Lower is better. This is why LOX/LH2 beats LOX/RP-1 despite similar flame temperature — exhaust M_w ≈ 9 vs 22.
- **R_u / M_w** — this ratio is the specific gas constant R for the exhaust mixture (units: J/kg·K). R_u = 8.314 J/(mol·K) is universal and fixed; M_w is what varies between propellants. Lower M_w → larger R → more thermal energy per kilogram of exhaust.
- **P_e/P_0** — nozzle expansion. Smaller ratio → more expansion → higher v_e. Goes to zero in vacuum.
- **P_e** is the fluid pressure at the exit plane, NOT ambient. Ambient sets whether the nozzle is over/under/perfectly expanded.

**Nozzle conditions:**
- P_e = P_amb: perfectly expanded — maximum efficiency
- P_e > P_amb: underexpanded — gas continues expanding in the plume, performance left on the table
- P_e < P_amb: overexpanded — ambient pushes back, flow separation, thrust loss

---

## 6. Gamma (γ)

$$\gamma = \frac{c_p}{c_v} = \frac{f+2}{f}$$

where f = active degrees of freedom per molecule.

| Gas | Active modes | f | γ |
|---|---|---|---|
| Monatomic (He, Ar) | 3 translational | 3 | 5/3 ≈ 1.67 |
| Diatomic (N2, O2, ~300K) | 3 trans + 2 rot | 5 | 7/5 = 1.4 |
| Polyatomic (H2O, CO2, high T) | 3 trans + 3 rot + vib | 6+ | ~1.2 |

- More atoms in molecule → more internal modes → higher heat capacity → lower γ
- Vibrational modes activate at high temperatures — combustion gases at 3000+ K have lower γ than at room temperature
- Higher γ = more efficient energy extraction through nozzle expansion. Monatomic is best; combustion products are worst.
- Combustion exhaust γ ≈ 1.14–1.2 (LOX/RP-1 and LOX/Ethanol)

---

## 7. NASA CEA

CEA minimizes Gibbs free energy to find equilibrium composition at combustion temperature:

$$G = \sum_i n_i \mu_i \quad \text{subject to atom conservation}$$

**Outputs:** T_0 (flame temperature), M_w (effective molecular weight), γ, c_p — all fed into the v_e equation.

**Flow models:**
- **Frozen flow:** composition locks at throat, no recombination. Conservative bound on Isp.
- **Equilibrium flow:** recombination continues through nozzle. Optimistic bound.
- Real engines are between the two. Difference ≈ 1–3% Isp.

**Your code:** Uses RocketCEA (Python wrapper around NASA Fortran executable). Precomputes a 3D `.npz` lookup table over (Pc, MR, expansion ratio), then uses trilinear interpolation at runtime — no live CEA calls during simulation. Equilibrium flow assumed (no `frozen_nozzle` arg passed).

---

## 8. Propellant Chemistry & Stoichiometry

**Stoichiometric reaction (ethanol/LOX):**

$$\text{C}_2\text{H}_5\text{OH} + 3\text{O}_2 \rightarrow 2\text{CO}_2 + 3\text{H}_2\text{O}$$

$$\text{O/F}_\text{stoich} = \frac{3 \times 32}{46} \approx 2.09$$

**Temperature vs mixture ratio:** Temperature peaks at stoichiometric. Both fuel-rich and oxidizer-rich are cooler. The mechanism is covered in Section 17 — "thermal ballast" is an imprecise shorthand; the actual cause is a combination of reduced total heat release (incomplete oxidation) and endothermic decomposition of excess fuel.

**Why fuel-rich is optimal for Isp:** Excess fuel (H2, CO) lowers exhaust M_w. Since v_e ∝ sqrt(T_0 / M_w), the M_w reduction outweighs the modest temperature reduction.

**Dissociation at stoichiometric:** Peak temperature drives maximum dissociation of CO2/H2O into CO, O, OH, H. Dissociation is endothermic — energy is stored in broken bonds, not thermal energy. In frozen flow it is lost entirely; in equilibrium flow some is recovered by recombination. Net effect: dissociation is a loss mechanism that reduces effective T_0 more than it helps M_w.

**Propellant pair comparison:**

| Pair | T_0 (K) | M_w (g/mol) | Isp vac (s) |
|---|---|---|---|
| LOX / LH2 | ~3250 | ~9 | ~450 |
| LOX / RP-1 | ~3500 | ~22 | ~380 |
| LOX / Ethanol | ~3400 | ~21 | ~370 |
| N2O4 / MMH | ~3100 | ~22 | ~340 |

**Four reasons for running fuel-rich:**
1. Lower M_w exhaust → higher Isp
2. Lower temperature → less heat load on chamber/nozzle
3. Reducing environment (CO, H2) → no corrosion vs. hot O2 attacking metal
4. Never crosses stoichiometric during startup or shutdown transients — natural buffer against sequencing errors

---

## 9. Ignition Sequencing

- **Fuel lead on ignition:** establish fuel before oxidizer. LOX pooling is more dangerous than ethanol pooling because LOX is cryogenic (-183°C), expands 860:1 on vaporization (pressure spike before combustion), and ox-rich environments have faster flame propagation.
- **Oxidizer cut first on shutdown:** ensures last combustion is fuel-rich, leaving reducing environment as chamber cools. Oxidizer-rich at shutdown causes hot O2 corrosion of chamber walls — a chemical damage mechanism, not a temperature one.
- **Your code:** LOX opens 79 ms before ethanol (oxidizer-lead). Mitigation is that the igniter is verified hot before FIRE is commanded, so pooling time is short. No fuel-lead on shutdown — both valves close simultaneously.

---

## 10. Combustion Chamber — L*

$$L^* = \frac{V_c}{A_t}$$

V_c includes the cylindrical section AND the convergent cone (everything above the throat). A_t = throat area. Typical units: meters.

**Why L* rather than raw length:** Residence time depends on volume relative to throughput. Throughput per unit throat area is set by Pc and c*, so the ratio V_c/A_t captures residence time independent of engine scale.

**Typical values:**

| Propellant | L* (m) |
|---|---|
| LOX / LH2 | 0.6–0.9 |
| LOX / RP-1 | 1.0–1.3 |
| LOX / Ethanol | 1.0–1.5 |
| Hypergolics | 0.6–0.9 |

**Geometry from L*:** Pick contraction ratio ε_c = A_c/A_t (typically 4–10), then:

$$V_c = L^* \cdot A_t \qquad L_\text{cyl} = \frac{V_c - V_\text{cone}}{A_c}$$

The cone volume must be subtracted because L* accounts for it but it has its own geometry.

**Combustion efficiency vs L*:**

$$\eta_{c^*} \approx 1 - 0.3 \cdot e^{-0.15 \cdot L^*}$$

Short L* directly discounts Isp. Your engine: L* ≈ 1.24 m → ~97% c* efficiency.

**Convergent half-angle (your code):** Hardcoded at 45° from the centerline. Reasonable — convergent flow is subsonic and forgiving; 45° is well within the acceptable range (20–60°) and saves optimization complexity for a low-impact parameter.

---

## 11. Characteristic Velocity c*

$$c^* = \frac{P_c \cdot A_t}{\dot{m}}$$

After substituting choked flow, A_t and P_c cancel entirely:

$$c^* = \frac{\sqrt{R_u T_c / M_w}}{\Gamma(\gamma)}$$

c* depends only on flame temperature, molecular weight, and γ — pure combustion properties. The throat sets the relationship between P_c, A_t, and ṁ together, but their ratio is fixed by chemistry.

**Physical meaning:** For a given ṁ and A_t, how much chamber pressure do you build? High c* = energetic combustion.

**Measured directly from a hot fire:** just measure P_c, A_t, and ṁ. Compares to CEA prediction to get c* efficiency — isolates combustion problems from nozzle problems.

**The Γ(γ) function** is the choked mass flux coefficient. It falls out of the choked throat derivation:

$$\dot{m} = \frac{P_0 \cdot A_t \cdot \Gamma(\gamma)}{\sqrt{R_u T_0 / M_w}} \qquad \Gamma(\gamma) = \sqrt{\gamma}\left(\frac{2}{\gamma+1}\right)^{(\gamma+1)/2(\gamma-1)}$$

Γ is a pure function of γ — it captures all the isentropic-ratio algebra for a choked throat into one number. Higher γ → slightly higher Γ → more mass flow per unit P0·At.

| γ | Γ(γ) |
|---|---|
| 1.15 | 0.634 |
| 1.20 | 0.648 |
| 1.40 (air) | 0.685 |
| 1.67 (monatomic) | 0.726 |

**Γ cancels in Isp.** The Cf momentum term also contains Γ in the numerator:

$$C_{f,mom} = \Gamma(\gamma) \cdot \sqrt{\frac{2\gamma}{\gamma-1}\left[1 - \left(\frac{P_e}{P_c}\right)^{(\gamma-1)/\gamma}\right]}$$

In the product c* · C_f,mom, the Γ in the denominator of c* and the Γ in the numerator of C_f cancel exactly, leaving only v_e. Γ does not appear in Isp — it is only relevant for relating Pc, At, and ṁ to each other via the c* equation.

---

## 12. Thrust Coefficient C_f

$$C_f = \frac{F}{P_c \cdot A_t}$$

Dimensionless, typically 1.2–1.8. Measures nozzle quality.

**Thrust has two contributions:**

$$F = \underbrace{\dot{m} v_e}_\text{momentum thrust} + \underbrace{(P_e - P_a) A_e}_\text{pressure thrust}$$

The pressure term is zero for perfectly expanded, positive for underexpanded, negative for overexpanded.

**The Isp factorization:**

$$F = C_f \cdot \dot{m} \cdot c^* \qquad \boxed{I_{sp} = \frac{c^* \cdot C_f}{g_0}}$$

P_c and A_t vanish. Isp is determined entirely by combustion quality (c*) and nozzle quality (C_f). These are tracked separately in the optimizer because they diagnose different problems:
- Low c* vs CEA → combustion issue (incomplete mixing, short L*, cold spots)
- Normal c*, low Isp → nozzle issue (overexpansion, flow separation, poor contour)

---

## 13. Nozzle Expansion Ratio & Altitude

$$\varepsilon = \frac{A_e}{A_t}$$

**Direction chain (monotonic, one-directional):**

$$\varepsilon \uparrow \implies M_e \uparrow \implies P_e \downarrow$$

Larger exit area → flow expands further → higher Mach → lower static exit pressure. The area-Mach relation ties ε to Me; isentropic relations then give Pe/P0.

**The altitude mismatch problem:** Pe is fixed by geometry. Pa drops continuously from ~101 kPa at sea level to zero in vacuum. A single fixed ε cannot be perfectly expanded at all altitudes.

**Fixed compromise:** Choose ε such that Pe is slightly below Pa at launch (slightly overexpanded — negative pressure term, but no separation if Pe/Pa > ~0.4). As altitude increases and Pa drops, the nozzle passes through perfectly expanded at the design altitude, then becomes underexpanded above it.

**Summerfield separation criterion:** Flow separates from the nozzle wall when:

$$\frac{P_e}{P_a} \lesssim 0.4$$

Separation causes asymmetric side loads and a de facto shorter nozzle. Overexpansion is the dangerous direction; underexpansion is merely inefficient.

**Your engine (ε = 4.54):** Constrained by 101 mm max exit diameter. Optimizer wanted ε = 6–8 but the diameter cap forced ε = 4.54. At estimated runtime Pc ≈ 2.9 MPa, Pe ≈ 107 kPa vs Pa ≈ 94 kPa — slightly underexpanded at launch. Near-optimal for a sounding rocket burn that stays at low altitude.

**Cf at different expansion ratios** (Pc = 2.9 MPa, Pa = 94 kPa, γ = 1.2):

| ε | Pe (kPa) | Condition | Cf sea level | Cf vacuum |
|---|---|---|---|---|
| 4.54 (current) | 107 | slightly underexpanded | 1.48 | 1.63 |
| 4.93 (optimal SL) | 94 | perfectly expanded | 1.48 | 1.64 |
| 8 | 51 | overexpanded | 1.45 | 1.71 |
| 15 | 16 | badly overexpanded | 1.31 | 1.79 |

**Mission profile governs the penalty:** For a sounding rocket burning below 5 km, the sea-level column dominates — going to ε = 8 loses ~2% at sea level while gaining ~5% in vacuum, a net loss for a low-altitude burn. For a vacuum upper stage, larger ε is always better.

---

## Key Physical Intuitions

1. **Enthalpy vs internal energy:** Enthalpy is the right energy variable for flowing systems because it includes flow work P/ρ. Using u requires tracking the boundary work term separately.

2. **Isentropic flow is the useful approximation** for nozzle core flow. Real losses (boundary layer friction, wall heat transfer) are applied as efficiency factors on top.

3. **The throat is a causal boundary.** At M = 1, upstream signal speed = a - v = 0. Downstream conditions are invisible to the throat. Once choked, mass flow is set by upstream conditions only.

4. **c* and C_f are orthogonal diagnostics.** c* is set entirely in the chamber, C_f entirely in the nozzle. You can measure each independently from a hot fire.

5. **LOX/LH2 wins on Isp despite lower flame temperature than LOX/RP-1** because v_e ∝ sqrt(T_0/M_w) and M_w ≈ 9 vs 22.

6. **Fuel-rich operation** wins simultaneously on Isp, wall protection, corrosion resistance, and transient safety.

7. **γ represents** the fraction of molecular energy that is translational (visible as temperature). More internal modes → lower γ → less efficient nozzle expansion. Combustion products γ ≈ 1.14–1.2 vs air γ = 1.4.

8. **Γ(γ) cancels in Isp.** It appears in the denominator of c* and numerator of Cf — they cancel exactly when multiplied. Γ only matters for relating Pc, At, and ṁ to each other (the c* equation). It has no effect on the final Isp.

9. **R_u/Mw is what drives the molecular weight effect on Isp.** R_u = 8.314 J/(mol·K) is fixed. The specific gas constant R = R_u/Mw is what varies. Lower Mw → larger R → more thermal energy per kg → higher ve for the same flame temperature.

---

---

## 14. Injector Design

The injector does two things: meters mass flow (sets O/F by controlling orifice areas) and atomizes propellants (breaks liquid into droplets so they vaporize and mix before combustion). Both matter — orifice areas set O/F, spray pattern drives c* efficiency.

**The four types:**

**Impinging:** Jets aimed at each other. Collision shatters both streams into a spray fan.
- *Like-on-like* (LOX/LOX and fuel/fuel pairs separately): global O/F set by total manifold flows. Forgiving of element-to-element variation.
- *Unlike* (one LOX + one fuel per element): each element must individually deliver correct O/F. Sensitive to orifice manufacturing tolerance and manifold pressure non-uniformity. If one element is off, that zone burns at the wrong ratio.

**Coaxial:** Slow inner jet surrounded by fast outer annulus. The velocity difference drives Kelvin-Helmholtz instability at the interface — the fast outer stream drags on the slow inner surface, creating radial waves that grow in amplitude until their crests detach as droplets. The detached pieces (ligaments) break further into fine droplets.

Velocity ratio is the design variable:

$$\frac{v_{outer}}{v_{inner}} = \frac{\dot{m}_{outer}}{\dot{m}_{inner}} \times \frac{\rho_{inner}}{\rho_{outer}} \times \frac{A_{inner}}{A_{outer}}$$

- **LOX/LH2** at O/F = 5, equal areas: ratio = (1/5) × (1141/71) × 1 = 3.2. Density contrast (16×) overwhelms the mass flow ratio. Easily pushed to 10-20 with modest geometry.
- **LOX/Ethanol** at O/F = 1.7, equal areas: ratio = (1/1.7) × (1141/789) × 1 = 0.86. Inner stream is *faster* than outer. Getting to ratio = 5 requires A_inner/A_outer = 5.8 — an extremely narrow annulus that is fragile and hard to manufacture. Coaxial is poorly suited.

**Swirl:** Propellant enters through tangential ports, spins inside a cavity. Centrifugal force pushes liquid to the outer wall, forming a hollow vortex with a gas core. Exits as a spinning hollow cone. The thin rotating sheet is inherently unstable and breaks into very fine droplets without needing an external fast stream. High atomization quality, wide spray cone. Used extensively in Russian engines. For bipropellants: two concentric swirl elements whose spinning cones collide and interpenetrate.

**Pintle:** Single central post carrying one propellant with radial holes at the tip. The other propellant flows as an annular sheet axially around the base. They collide at the tip. The velocity vectors add:

$$\frac{v_{radial}}{v_{axial}} = TMR \quad \text{(Total Momentum Ratio)}$$

TMR determines the spray cone half-angle. High TMR → spray goes radially toward walls. Low TMR → spray stays axial near centreline. Design target: outer edge of spray cone reaches ~70–80% of chamber radius — good cross-section coverage without direct wall impingement.

*Why throttleable:* Moving the post axially changes the annular gap area → changes flow rate at fixed pressure drop. Wide throttle ratios (10:1) achievable. Used on Apollo LM descent engine.

*Why acoustically stable:* A single large element covers the whole chamber face with no regular spatial pattern. Array injectors can have element spacing that matches acoustic wavelengths and couple to chamber modes. The pintle doesn't.

**Why oxidizer through the central post:**
1. *Coking:* Small hot radial holes + fuel = carbon deposits that block flow over time. Oxidizer doesn't thermally decompose.
2. *Post cooling:* Cryogenic LOX (-183°C) flowing through the post cools it from inside.
3. *Wall protection:* Fuel in the annular position means the outer spray contacts the wall — fuel-rich mixture is cooler and less corrosive than oxidizer-rich.

**Radial vs axial spray trade-off (all injector types):**
- More radial → short mixing length, fills chamber cross-section quickly, but spray hits walls sooner → high wall heat flux, tight droplet size requirement
- More axial → long mixing length, lower wall heat flux, but requires more L* for complete combustion

---

## 15. Droplet Vaporization & L* Revisited

**The D² law:** A droplet's lifetime scales with its initial diameter squared:

$$\tau_{evap} \sim \frac{D_0^2}{K}$$

where K is the evaporation constant (function of chamber temperature, pressure, propellant). Vaporization distance = v × τ_evap ∝ D₀². Doubling droplet diameter quadruples the distance needed to vaporize. This is why atomization quality dominates combustion length.

**After vaporization:** The rate-limiting step is mixing (turbulent), not chemistry. Chemical reaction at 3000 K and several MPa is near-instantaneous once fuel and oxidizer vapors are co-located. Mixing is fast but not instant — it's the actual bottleneck after vaporization.

**What L* actually provides:** The injector produces a distribution of droplet sizes. Small droplets vaporize near the injector face. Large droplets vaporize further down. The chamber must be large enough that even the largest droplets in the distribution vaporize before the throat. Any droplet that reaches the throat as a liquid exits unreacted — propellant mass paid for, zero energy extracted.

L* is the total vaporization budget across the entire size distribution. There is no clean "vaporization zone then combustion zone" — different droplets are vaporizing at different points throughout the entire chamber simultaneously.

**The injector–L* trade-off:** Better injector → smaller maximum droplet size → shorter vaporization distance → same c* efficiency at lower L*. Injector quality and L* are two levers on the same outcome. The c* efficiency curve reflects this:

$$\eta_{c^*} \approx 1 - 0.3 \cdot e^{-0.15 \cdot L^*}$$

As L* grows, more of the size distribution tail is captured, efficiency asymptotes to 1. Below the minimum L* for a given injector, large droplets exit the throat unreacted and c* drops sharply.

---

---

## 16. Hard Starts

A hard start occurs when propellant accumulates in the chamber before ignition establishes. When ignition fires, the accumulated bolus combusts at once rather than as a steady stream → pressure transient above design Pc. If the spike exceeds the burst pressure of the weakest component → failure.

**Spike severity depends on:**
- Accumulation time before ignition — more time = more mass = larger spike
- Physical state of accumulated propellant — vapor ignites faster than liquid → sharper pressure rise rate
- Chamber volume — larger volume dilutes a given mass → smaller pressure fraction

**LOX-rich accumulation — the actual dangers:**

LOX does **not** combust without fuel. It cannot self-ignite. The dangers of LOX pooling are distinct from combustion:

1. *Oxidizer-rich combustion when fuel arrives:* very high O/F → extreme local temperature → burns through chamber and nozzle hardware. This is a hardware destruction mechanism.
2. *Rapid LOX vaporization:* liquid oxygen expanding ~860:1 on phase change creates pressure spike purely from phase change, before any combustion occurs.
3. *Materials compatibility:* some elastomers, hydrocarbons, and aluminum alloys react violently with liquid oxygen under impact or shock — a design concern rather than a sequencing concern.

**Fuel-rich accumulation — the harder pressure spike:**

Fuel vapor (ethanol: 3.3–19% flammability range in air) fills the chamber volume. When ignition fires, deflagration is spatially distributed across the entire chamber — high energy release rate. The accumulated fuel mass represents real stored chemical energy that converts to pressure. This is the dominant hard start concern for fuel-lead engines if ignition timing slips.

**Fuel-lead mitigation:**

Fuel arrives first → igniter fires in fuel-rich atmosphere → LOX arrives into established flame → ignites immediately at the contact front → O/F transitions from fuel-rich toward design value. The system never spends time with LOX pooling in an unignited state.

**Pre-purge and ignition reality:**

Textbook sequencing calls for a nitrogen purge before ignition to eliminate the uncontrolled air oxygen variable. In practice:

- Most student teams skip pre-purge — it adds valves, GN₂ supply, and sequencing logic
- Pre-purge frequently causes ignition failures: a spark igniter requires a flammable mixture at the spark gap. A nitrogen-filled chamber has no flammability — the spark fires and quenches immediately without establishing a flame kernel

Without purge, air O₂ in the chamber supports the initial fuel-air combustion. This is stoichiometrically limited by the small mass of air O₂ — the combustion event is small and self-terminating. It establishes the pilot flame kernel; LOX then takes over as the primary oxidizer. The trade: accept a small, bounded uncontrolled combustion event in exchange for reliable ignition.

---

## 17. Fuel-Rich Combustion Chemistry

**What actually burns:**

Combustion requires an oxidizer. In fuel-rich conditions only the stoichiometric fraction of fuel reacts with the available LOX. The excess fuel cannot combust — there is no oxidizer to drive it.

**What happens to excess fuel at 3000 K:**

Thermal decomposition (pyrolysis), not combustion. For ethanol, dominant routes:

$$\text{C}_2\text{H}_5\text{OH} \rightarrow \text{CO} + 2\text{H}_2 + \text{fragments} \quad (\text{endothermic})$$

$$\text{C}_2\text{H}_5\text{OH} \rightarrow \text{C}_2\text{H}_4 + \text{H}_2\text{O} \quad (\text{endothermic})$$

These reactions require energy input — they are endothermic. The products (CO, H₂) would need additional oxidizer to combust further, which is unavailable in fuel-rich conditions.

**Why fuel-rich combustion is cooler — two effects:**

*1. Less total heat released (dominant effect):*

Insufficient oxygen means incomplete oxidation. Carbon stops at CO instead of going all the way to CO₂:

$$\text{C} + \tfrac{1}{2}\text{O}_2 \rightarrow \text{CO} \quad \Delta H \approx -111 \text{ kJ/mol}$$

$$\text{C} + \text{O}_2 \rightarrow \text{CO}_2 \quad \Delta H \approx -394 \text{ kJ/mol}$$

The difference (283 kJ/mol) stays locked in the CO bond — never converted to heat. Similarly, hydrogen staying as H₂ instead of burning to H₂O retains 242 kJ/mol as chemical potential energy. The equilibrium products in a fuel-rich burn contain substantial CO and H₂ — these represent energy released from the propellants that did not appear as chamber temperature.

*2. Excess mass absorbs heat (secondary effect):*

The decomposition products must be heated from injection temperature to flame temperature. Same heat release distributed over more total mass → lower final equilibrium temperature. This is the physical kernel of truth in calling excess fuel "thermal ballast" — but the mechanism is endothermic decomposition acting as a heat sink, not chemically inert mass.

**The "thermal ballast" framing — why it is imprecise:**

Excess fuel is not chemically passive. It decomposes endothermically and produces intermediate species. The framing implies the fuel is an inert heat absorber. The more correct description: excess fuel reduces total heat released (incomplete oxidation) while simultaneously acting as a heat sink through endothermic decomposition. Both effects reduce flame temperature; the incomplete oxidation effect dominates.

**Why Isp peaks fuel-rich despite lower temperature:**

$$I_{sp} \propto \sqrt{\frac{T_c}{M_w}}$$

At stoichiometric: exhaust is mostly CO₂ (Mw = 44) and H₂O (Mw = 18). At fuel-rich: exhaust shifts toward CO (Mw = 28), H₂ (Mw = 2), and lighter species. The molecular weight of the exhaust drops significantly. Even though T_c also drops, the reduction in Mw wins — the ratio T/Mw increases and Isp rises. Temperature is a penalty of going fuel-rich; lower Mw is a larger benefit.

---

*Reference: Rocket Propulsion Elements — Sutton & Biblarz, chapters 3 & 5*
