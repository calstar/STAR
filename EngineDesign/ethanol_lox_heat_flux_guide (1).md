# Implementation Spec: Ethanol / LOX Concentric-Tank Freezing Model

**Audience:** a coding agent implementing a transient simulation.

**Primary deliverables (in priority order):**
1. **Equilibrium ice thickness** at the initial bulk temperature (the quasi-steady layer the
   ice would asymptote to if the bulk held its temperature).
2. If that equilibrium is not reached within the mission window, the **ice thickness at
   t = 20 min**.
3. The **bulk ethanol temperature vs time** over 0–20 min.
4. A **plot of ethanol viscosity vs time** over 0–20 min (derived from the bulk temperature).
5. The **time to fully solidify** the ethanol (`r_s → 0`), reported when there is no
   mission-timescale equilibrium.

**Goal:** compute the above by marching the coupled heat-transfer / freezing problem in time.

This is a **coupled transient** problem, not a single steady calculation. The headline
physics: liquid ethanol convects heat to a freeze front pinned at its melting point; that
heat conducts out through the ice and aluminum wall into the boiling LOX; the imbalance
freezes more liquid. Solve it by marching in time.

---

## 1. Scope, assumptions, and known limitations

**Modeled**
- Radial 1-D heat path: liquid ethanol core → freeze front (159 K) → solid ethanol (ice)
  → aluminum wall → LOX.
- Ethanol-side single-phase **natural convection** (static tank, buoyancy-driven, Pr > 1),
  vertical orientation so the characteristic length is the tank height H.
- A frozen ethanol layer that grows inward from the wall (moving-boundary / Stefan).
- Transient cooling of the bulk liquid ethanol.

**Simplifying assumptions**
- **LOX side = fixed-temperature sink.** Nucleate boiling pins the outer wall at the LOX
  saturation temperature `T_LOX = T_sat(P_tank)` (90 K at 1 atm; use the value at the
  actual tank pressure). Its resistance `R_2 ≈ 0`. Boil-off mass is not tracked (it does
  not change the flux). Valid only below the critical heat flux — see §7.
- **Aluminum wall** is treated as a thin, high-conductivity shell; `R_w` is retained but is
  numerically negligible.
- **Quasi-steady conduction** through the ice (steady log profile at each instant).
  Borderline here (Stefan number ≈ 0.8) — see §7.
- **Lumped bulk ethanol:** one temperature for the whole liquid core. See limitation below.

**Known limitations (do not silently trust the absolute numbers)**
- **No stratification.** A real vertical tank stratifies: chilled ethanol sinks and the
  bottom freezes first, faster, and thicker than a single bulk temperature predicts. The
  lumped model understates the worst-location hazard. If local ice thickness matters,
  refine into axial segments (stacked 1-D slices up the height).
- **Open-plate correlation on an enclosed cavity.** Churchill–Chu is for an open vertical
  plate; the ethanol is confined, which suppresses circulation. This **over**estimates h1.
- **Large-ΔT property variation.** Properties are taken at a single film temperature, but
  ethanol viscosity varies by >10× across the gradient. Largest single error source.
- Expect roughly a **factor-of-2** uncertainty on absolute freeze time and ice thickness;
  more locally. Trust trends, ordering, and order of magnitude; validate absolutes.

---

## 2. Nomenclature

| Symbol | Meaning | Units |
|---|---|---|
| `r_i` | inner wall radius (ethanol/wall interface) | m |
| `r_o` | outer wall radius (wall/LOX interface) | m |
| `r_s(t)` | freeze-front radius; ice occupies `r_s..r_i` | m |
| `H` | wetted height | m |
| `T_eth(t)` | bulk liquid ethanol temperature | K |
| `T_fr` | ethanol freezing point (≈ 159 K) | K |
| `T_LOX` | LOX saturation temp at tank pressure (≈ 90 K @ 1 atm) | K |
| `T_w(t)` | wall temperature (derived) | K |
| `T_f` | film temperature for property evaluation | K |
| `h1(t)` | ethanol natural-convection coefficient | W/m^2K |
| `k` | liquid ethanol thermal conductivity (for Nu) | W/mK |
| `k_s` | solid ethanol (ice) conductivity | W/mK |
| `k_Al` | aluminum conductivity | W/mK |
| `rho, mu, c_p, beta` | liquid ethanol props at `T_f` | SI |
| `nu = mu/rho`, `alpha = k/(rho c_p)`, `Pr = nu/alpha` | derived liquid props | SI |
| `rho_s, c_p_s` | solid ethanol density, specific heat | SI |
| `L_fus` | latent heat of fusion (≈ 1.05e5) | J/kg |
| `m_liq(t)` | liquid ethanol mass | kg |
| `A_s = 2*pi*r_s*H` | freeze-front area | m^2 |
| `R_ice, R_w, R_2` | series resistances (cold path) | K/W |
| `Qin, Qout` | heat into / out of the front | W |
| `g` | 9.81 | m/s^2 |

---

## 3. Inputs and required property data

**Scalar inputs:** `r_i, r_o, H, P_tank, T_eth0 (initial), m_liq0 (initial liquid mass)`.

**Run controls:** `t_mission = 1200 s` (20 min), `t_solidify_max` (horizon for the
solidification search, e.g. a few hours), `dt0`, `delta_seed`, `r_min`.

**Optional thresholds (for readouts):** `mu_pump_max` (max ethanol viscosity the feed
system tolerates) and `delta_ice_max` (max tolerable ice thickness), used to mark when each
limit is crossed.

**Material data:** `k_Al(T)`, `k_s` (solid ethanol), `rho_s`, `c_p_s`, `L_fus`, `T_fr`.

**Property functions of temperature (from NIST REFPROP / WebBook):**
- Liquid ethanol: `rho(T), mu(T), k(T), c_p(T), beta(T)` — needed across ~159–300 K.
- Oxygen: `T_sat(P_tank)` to set `T_LOX`.

Implement properties as interpolated lookups; **flag if T leaves the tabulated range**.

---

## 4. Physical model (the coupled system)

State variables marched in time: `T_eth(t)`, `r_s(t)`, `m_liq(t)`.

Resistance view of the cold path, front → LOX (front pinned at `T_fr` by the phase change):

```
[liquid core T_eth] --Qin(convection)--> [FRONT @ T_fr] --Qout--> [ice R_ice]+[wall R_w]+[LOX R_2≈0] --> [LOX @ T_LOX]
                                               |
                                     freezing if Qout > Qin
```

The front is an internal node held at `T_fr`. The mismatch between heat arriving from the
liquid (`Qin`) and heat leaving to the LOX (`Qout`) is made up by latent heat as liquid
freezes (or melts).

---

## 5. Sub-models (implement as functions)

### 5.1 Ethanol convection coefficient — `h1 = convection(T_eth, r_s)`
Convective surface is the freeze front at `T_fr`.
1. Film temperature: `T_f = 0.5*(T_eth + T_fr)`
2. Liquid props at `T_f`: `rho, mu, k, c_p, beta` → `nu, alpha, Pr`
3. Rayleigh (characteristic length = height H, driving ΔT to the **front**):
$$
Ra_H = \frac{g\,\beta\,(T_{\text{eth}} - T_{\text{fr}})\,H^3}{\nu\,\alpha}, \qquad Gr_H = Ra_H/Pr
$$
4. Cylinder-as-plate check (use current core diameter `D = 2*r_s`); flag if violated:
$$
\frac{D}{H} \gtrsim \frac{35}{Gr_H^{1/4}}
$$
5. Nusselt (Churchill–Chu, all-Ra):
$$
\overline{Nu}_H = \left\{ 0.825 + \frac{0.387\,Ra_H^{1/6}}{\left[1 + (0.492/Pr)^{9/16}\right]^{8/27}} \right\}^2
$$
6. Coefficient: `h1 = Nu_H * k / H`
7. Record regime: laminar if `Ra_H < 1e9`, else turbulent.

### 5.2 Cold-side resistances and heat out — `Qout = cold_path(r_s, T_w_unused)`
$$
R_{\text{ice}} = \frac{\ln(r_i/r_s)}{2\pi k_s H}, \quad
R_w = \frac{\ln(r_o/r_i)}{2\pi k_{\text{Al}} H}, \quad R_2 \approx 0
$$
$$
\dot Q_{\text{out}} = \frac{T_{\text{fr}} - T_{\text{LOX}}}{R_{\text{ice}} + R_w + R_2}
$$
Derived wall temperature (for reporting): `T_w = T_LOX + Qout*(R_w + R_2)`.

### 5.3 Liquid heat delivery — `Qin`
$$
A_s = 2\pi r_s H, \qquad \dot Q_{\text{in}} = h1 \cdot A_s \cdot (T_{\text{eth}} - T_{\text{fr}})
$$
(Equivalently `R_1 = 1/(h1*A_s)` for the network view.)

### 5.4 Front motion (Stefan condition)
$$
\frac{dr_s}{dt} = -\,\frac{\dot Q_{\text{out}} - \dot Q_{\text{in}}}{\rho_s\,L_{\text{fus}}\,A_s}
$$
`dr_s/dt < 0` ⇒ ice grows inward. If `Qin > Qout`, the front retreats (melts); allow it,
but clamp `r_s ≤ r_i` (cannot melt past the wall) and `r_s ≥ r_min` (numerical floor).

### 5.5 Bulk cooling and mass update
Bulk loses, sensibly, the heat it convects to the front:
$$
\frac{dT_{\text{eth}}}{dt} = -\,\frac{\dot Q_{\text{in}}}{m_{\text{liq}}\,c_p}
$$
Liquid mass converts to solid as the front advances:
$$
\frac{dm_{\text{liq}}}{dt} = \rho_s\,A_s\,\frac{dr_s}{dt} \quad (\le 0)
$$
(Enthalpy carried by the freezing mass from `T_eth` to `T_fr` is a second-order correction;
include it later if energy-balance checks demand.)

---

## 6. Time-marching algorithm

```
# Initialization — seed a tiny ice layer to avoid the t=0 singularity
# (R_ice -> 0 and Qout -> infinity when r_s = r_i exactly).
t      = 0
r_s    = r_i - delta_seed         # delta_seed ~ 1e-5 m; result is insensitive if small
T_eth  = T_eth0
m_liq  = m_liq0
dt     = dt0                      # small; the early growth is fast (see note)

while (t < t_run) and (r_s > r_min) and (T_eth > T_fr + eps):
    # t_run = t_mission (1200 s) for the main run; extend to t_solidify_max
    # only if the run is classified UNBOUNDED and you need t_solidify (6a.4).
    h1   = convection(T_eth, r_s)          # 5.1
    Qout = cold_path(r_s)                  # 5.2
    Qin  = h1 * (2*pi*r_s*H) * (T_eth - T_fr)   # 5.3

    drs_dt   = -(Qout - Qin) / (rho_s * L_fus * 2*pi*r_s*H)   # 5.4
    dTeth_dt = -Qin / (m_liq * c_p)                          # 5.5
    dmliq_dt =  rho_s * (2*pi*r_s*H) * drs_dt                # 5.5

    # integrate (forward Euler shown; prefer RK4 or an adaptive stepper)
    r_s   += drs_dt   * dt
    T_eth += dTeth_dt * dt
    m_liq += dmliq_dt * dt
    r_s    = clamp(r_s, r_min, r_i)
    t     += dt

    record(t, T_eth, r_s, ice_thickness = r_i - r_s, mu_eth = mu(T_eth),
           Qin, Qout, T_w, h1, Ra_H, regime)
```

**Stepping notes**
- Early growth is very fast (the seeded front accelerates), so use a small `dt` or an
  adaptive/RK integrator near `t=0`; verify the answer is insensitive to `delta_seed` and
  `dt` by halving each.
- Alternative robust start: seed using the short-time analytic Stefan growth
  `delta_ice ∝ sqrt(t)` for the first few steps, then hand off to the loop.
- Stop conditions: fully frozen (`r_s → r_min`), bulk reaches freezing (`T_eth → T_fr`), or
  the run horizon `t_run` (= `t_mission` for the main run; `t_solidify_max` for the
  solidification search in 6a.4).

## 6a. Producing the deliverables

### 6a.1 Equilibrium (quasi-steady) ice thickness — Deliverable 1
For a fixed bulk temperature `T_eth`, growth stalls when `Qout = Qin`. Solve for the front
radius `r_s_eq` (with `R_w, R_2 ≈ 0`):
$$
\frac{k_s\,(T_{\text{fr}} - T_{\text{LOX}})}{\ln(r_i / r_{s,\text{eq}})}
= h1 \cdot r_{s,\text{eq}} \cdot (T_{\text{eth}} - T_{\text{fr}})
$$
This is a 1-D root find for `r_s_eq` on `(r_min, r_i)`; evaluate `h1` (§5.1) at the current
`T_eth`. Equilibrium thickness `delta_eq = r_i - r_s_eq`. Compute it first at `T_eth0`.

### 6a.2 There is no *permanent* equilibrium — only a mission-timescale one
While `T_eth > T_fr` the bulk keeps losing heat, so `T_eth` falls monotonically, `delta_eq`
grows, and the true `t → ∞` state is always full solidification. "Bounded" therefore means
the ice plateaus near `delta_eq(T_eth0)` *only if* the bulk cools slowly compared to the
20-min window. So always do BOTH: the equilibrium estimate (6a.1) AND the transient run.

### 6a.3 Transient run and classification — Deliverables 2 and 3
Run the §6 loop to `t_mission = 1200 s`, recording `T_eth(t)`, `delta_ice(t) = r_i - r_s(t)`,
and `mu_eth(t) = mu(T_eth(t))`. Classify by the state at `t_mission`:
- **BOUNDED:** `delta_ice` has plateaued (e.g. `d(delta_ice)/dt` near zero and within a few %
  of `delta_eq`, with `T_eth` nearly unchanged). Report `delta_eq` and the time to reach 95%
  of it.
- **UNBOUNDED:** `delta_ice` is still climbing at `t_mission`. Report `delta_ice(20 min)` and
  go to 6a.4.

`T_eth(t)` over 0–20 min is a direct output of this run (Deliverable 3 — the bulk cooling
curve).

### 6a.4 Time to fully solidify — Deliverable 5 (when unbounded)
If unbounded, continue marching (up to `t_solidify_max`) until `r_s ≤ r_min` (all ethanol
frozen) and report `t_solidify`. If not reached by `t_solidify_max`, report `> t_solidify_max`.

### 6a.5 Viscosity vs time — Deliverable 4
Evaluate the liquid viscosity along the temperature trajectory, `mu_eth(t) = mu(T_eth(t))`,
and **plot it vs time over 0–20 min**. Expect a steep, near-exponential rise as `T_eth`
approaches `T_fr` (cold ethanol thickens fast). If `mu_pump_max` is supplied, mark where
`mu_eth` crosses it — that point is the usable hold time for feeding the engine, often the
real operational limit before the ice layer is.

---

## 7. Checks and flags the code should emit

- **Flow regime** each step: laminar (`Ra_H < 1e9`) vs turbulent.
- **Cylinder-as-plate validity** each step (re-check as `r_s` shrinks; §5.1.4).
- **CHF guard:** compute LOX-side flux `q'' = Qout / (2*pi*r_o*H)` and compare to the
  oxygen critical heat flux. If approached, the boiling/`R_2≈0`/fixed-`T_LOX` assumption is
  invalid (film boiling → wall temp spikes). Expected to be safe here, but check.
- **Stefan number** (constant): `Ste = c_p_s*(T_fr − T_LOX)/L_fus ≈ 0.8`. Warn that the
  quasi-steady ice conduction is borderline; for a trusted number, replace §5.2 with
  transient 1-D conduction through the solid (moving-boundary finite differences).
- **Stratification warning:** the model is lumped/uniform; real freezing is bottom-heavy.
  Emit a note that local thickness may exceed the uniform prediction.
- **Property range:** warn if `T` exits the tabulated NIST range.

---

## 8. Accuracy and conservatism (split by metric — IMPORTANT)

Confidence: framework correct; absolute numbers good to ~factor of 2 (worse locally).
Trust trends, ordering, and order of magnitude.

The direction of "conservative" **depends on which freeze quantity you care about**, and
the two are opposite for the convection coefficient:

- **Freeze TIME / onset / bulk cool-down:** to be conservative (predict it *sooner*), bias
  `h1` **high**, treat LOX as a perfect `T_sat` sink, and drop `R_w`. A high `h1` pulls
  heat out of the bulk faster.
- **Ice THICKNESS / amount:** to be conservative (predict *more* ice), bias `h1` **low**.
  A high `h1` delivers more warmth to the front (`Qin ↑`) and gives a *thinner* layer, so
  the high-`h1` choice is non-conservative here. (This corrects earlier guidance that said
  to always use a high `h1`.)

**Recommendation:** run the model twice — once with `h1` biased high (bounds freeze time)
and once with `h1` biased low (bounds ice thickness) — and report both bounds. If local
ice thickness is a real failure mode (blocked port, volume change, structural load), also
add the axial/stratified refinement, because the lumped model is non-conservative there.

---

## 9. Suggested unit / sanity tests

- **Conduction limit:** set `h1 = 0` (stagnant liquid) → pure-conduction Stefan growth;
  compare against the classical analytic cylindrical Stefan solution.
- **Energy balance:** integrate `Qout` to LOX over the run and compare to (bulk sensible
  heat lost) + (latent heat of total frozen mass). Should close to a few %.
- **Resistance ordering:** assert `R_w, R_2 << R_ice` once a finite ice layer exists.
- **Churchill–Chu:** check `Nu_H(Ra, Pr)` against tabulated reference values.
- **Step independence:** halve `dt` and `delta_seed`; results should not move materially.

## 10. References
- Incropera & Bergman, *Fundamentals of Heat and Mass Transfer*, Ch. 9 (natural convection,
  Churchill–Chu, vertical-cylinder criterion).
- Rohsenow et al., *Handbook of Heat Transfer* (nucleate boiling, CHF).
- Alexiades & Solomon, *Mathematical Modeling of Melting and Freezing Processes* (Stefan).
- NIST REFPROP / NIST Chemistry WebBook (ethanol and oxygen properties).
