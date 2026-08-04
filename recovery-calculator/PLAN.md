# Recovery Calculator — Phase 1 Plan

**Scope: 1-D vertical descent. No wind. No drift. Conservative shock bound.**

A deliberately small first pass that produces trustworthy numbers for descent
time, velocity, acceleration, landing energy, and peak recovery loads. Wind,
drift, dispersion, and measured-coefficient refinement are explicitly Phase 2.

---

## 1. Notation and terminology

### 1.1 Conventions

- **Units are SI internally**, always. Convert at the I/O boundary only.
  Vendor data arrives in inches, feet, pounds, and fps; convert on ingest.
- **$z$ is positive up, AGL.** Descent has $v < 0$. Drag terms are written
  $|v|v$ so they oppose motion without a sign test.
- **Subscript $i$** indexes recovery devices (drogue, main, …).
- **Subscript $0$** means "fully inflated / nominal", not "initial".
  $(C_dS)_0$ is the full-open drag area.
- **Drag area $C_dS$ is one atomic symbol** with units m². Do not factor it
  into a coefficient and an area.

### 1.2 Terminology

**Drag area ($C_dS$)** — the physical drag quantity, $F_D / \tfrac12\rho v^2$,
in m². Contains no reference area, so it is convention-free. Equivalently: the
area of a flat plate with $C_d = 1$ producing the same drag. **This is the only
drag quantity that enters the equations of motion.**

**Drag coefficient ($C_d$)** — $C_dS$ divided by a *declared* reference area.
Not a property of the parachute alone: change the reference and $C_d$ changes
inversely. A bare $C_d$ with no stated denominator is not actionable.

**Nominal diameter / area ($D_0$, $S_0$)** — a bookkeeping size derived from
total canopy cloth area, *including* vents and slots. Fixed by the sewing
pattern, so it is a constant of the article. Enters this model **only** through
filling time.

**Projected diameter / area ($D_p$, $S_p$)** — the frontal size of the
*inflated* canopy. A flight variable, not a manufacturing constant. Typically
$D_p/D_0 \approx 0.67$–0.75.

**Line stretch** — the instant the suspension lines and harness come taut after
ejection. Start of inflation, and the moment of peak **snatch** load.

**Snatch** — the impulsive load when slack runs out at line stretch. Driven by
separation velocity and harness stiffness, *not* by descent speed. Frequently
the largest load in the system.

**Opening shock** — the peak load during canopy inflation, distinct from and
later than snatch.

**Filling time / filling distance ($t_f$, $s_f$)** — how long, and how far the
vehicle falls, while the canopy inflates. Canopies fill in a roughly fixed
*distance*, hence $s_f = nD_0$ and $t_f = s_f/v_s$.

**Infinite mass** — the limiting case where the vehicle does not decelerate at
all during inflation, so the canopy sees full $q_s$ at full area. Gives the
conservative upper-bound load and requires no inflation knowledge. Equivalent
to $X_1 = 1$.

**Finite mass** — the real case: the vehicle sheds speed *while* the canopy is
still growing, so peak force is lower. Credit quantified by $X_1$.

**Ballistic parameter ($A$)** — dimensionless mass ratio, vehicle mass over the
air mass the canopy processes during inflation. Large $A$ → infinite-mass
behaviour.

**Force reduction factor ($X_1$)** — the finite-mass credit, $\le 1$. Purely
kinematic.

**Opening force coefficient ($C_x$)** — transient overshoot, $\ge 1$. During
inflation the canopy briefly produces *more* drag than its steady full-open
value, because the entrained air's inertia carries the skirt past its
equilibrium diameter. Empirical, and it already contains the added-mass physics.

**Load factor** — dimensionless $F/W$. Reported "in g" by convention; the body's
acceleration in g is $F/W - 1$, since weight opposes the canopy force.

**Specific force** — what an accelerometer measures: non-gravitational
acceleration only. Reads $0$ in free fall, $+g$ at rest on the pad.

**Station pressure** — barometric pressure physically measured at the pad. *Not*
the METAR altimeter setting, which is corrected to sea level.

**ISA** — International Standard Atmosphere. An analytic convention (fixed
sea-level state and lapse rates), not data and not a forecast.

**Dense output** — the continuous interpolant an adaptive integrator produces
between steps. Needed to root-find deploy altitudes and to sample peak load
without stepping over it.

### 1.3 Symbols

**Atmosphere and environment** (§5)

| symbol | quantity | units |
|---|---|---|
| $z$ | geometric altitude AGL — state variable | m |
| $z_{\text{MSL}}$ | geometric altitude above sea level | m |
| $z_{\text{site}}$ | pad elevation MSL | m |
| $H$ | geopotential altitude | m |
| $H_b$, $H_{\text{pad}}$ | layer base, pad geopotential altitude | m |
| $R_e$ | ISA effective Earth radius, 6 356 766 | m |
| $T$, $T_b$, $T_{\text{pad}}$ | air, layer-base, pad temperature | K |
| $L_b$, $L_0$ | layer lapse rate, re-fitted lowest layer | K/m |
| $p$, $p_b$, $p_{\text{pad}}$ | pressure, layer base, pad *station* | Pa |
| $\rho$ | air density | kg/m³ |
| $R_d$ | dry-air gas constant, 287.053 | J/(kg·K) |
| $g$, $g_0$ | local gravity, standard 9.80665 | m/s² |

**Vehicle**

| symbol | quantity | units |
|---|---|---|
| $m$ | total descending mass | kg |
| $m_b$ | body mass (harness-side) = $m - \sum m_{c,i}$ | kg |
| $m_{c,i}$ | canopy + lines mass of device $i$ | kg |
| $d_{\text{body}}$, $\ell_{\text{body}}$ | airframe diameter, length | m |
| $h_a$ | apogee AGL | m |
| $v$ | vertical velocity (negative descending) | m/s |
| $v_t$ | terminal velocity | m/s |
| $v_{\text{impact}}$ | velocity at ground contact | m/s |

**Canopy and drag**

| symbol | quantity | units |
|---|---|---|
| $C_dS$ | drag area — **the physical quantity** | m² |
| $(C_dS)_i$ | full-open drag area of device $i$ | m² |
| $C_dS_{\text{body}}$ | airframe drag area (banded) | m² |
| $C_dS_{\text{tot}}$ | sum over airframe + all devices | m² |
| $C_{d_0}$, $C_{d_p}$ | drag coeff. ref. to $S_0$ / to $S_p$ | — |
| $D_0$, $S_0$ | nominal diameter, nominal area | m, m² |
| $D_p$, $S_p$ | projected diameter, projected area | m, m² |

**Inflation** (§6)

| symbol | quantity | units |
|---|---|---|
| $z_{d,i}$, $\Delta t_i$ | deploy altitude AGL, deploy delay | m, s |
| $t_{d,i}$ | deployment time | s |
| $v_{s,i}$ | freestream speed at line stretch, **frozen** (eq. 9a) | m/s |
| $q_{s,i}$ | dynamic pressure at deployment | Pa |
| $n_i$ | filling constant — diameters fallen | — |
| $s_{f,i}$ | filling distance $= n_i D_{0,i}$ | m |
| $t_{f,i}$ | filling time $= s_f/v_s$ | s |
| $\tau_i$ | normalized inflation progress, 0→1 | — |
| $j_i$ | area growth exponent (2 solid, 1 slotted) | — |

**Loads** (§8)

| symbol | quantity | units |
|---|---|---|
| $C_{x,i}$ | opening force coefficient, $\ge 1$ | — |
| $A_i$ | ballistic parameter | — |
| $B_i$ | Pflanz auxiliary $= 1/(A(j+1))$ | — |
| $\tau^*_i$ | normalized time of peak force | — |
| $X_{1,i}$ | force reduction factor, $\le 1$ | — |
| $F_{\infty,i}$ | infinite-mass opening force (the bound) | N |
| $F_{\max,i}$ | Pflanz finite-mass opening force | N |
| $F_T$ | harness tension — **sizes your hardware** | N |
| $F_{D,\text{body}}$ | airframe drag force | N |
| $F_{\text{snatch},i}$ | line-stretch peak force, device $i$ | N |
| $F_{\text{design}}$ | design load, incl. safety factor | N |
| $f$ | specific force (accelerometer reading) | m/s² |
| SF | safety factor, 1.5 | — |

**Harness** (§8.4)

| symbol | quantity | units |
|---|---|---|
| $v_{\text{rel},i}$ | **separation** velocity between the two masses — not $v_s$ | m/s |
| $k_j$, $k_{\text{eff},i}$ | member stiffness, series total for device $i$ | N/m |
| $F_{\text{rated},j}$ | rated strength of member $j$ | N |
| $\varepsilon_j$ | fractional elongation at rated load | — |
| $N_j$ | strands in parallel | — |
| $L_j$, $L_e$ | member length, suspension line length | m |
| $\theta$ | suspension line splay half-angle | rad |
| $\mu_i$ | reduced mass $m_b m_{c,i}/(m_b+m_{c,i})$ | kg |
| $t_n$ | harness natural period | s |

Members are indexed by $j$ *within* a device's load path; $j$ also names the
area growth exponent $j_i$ in §6.3. Different scopes, and the collision is
noted in §1.4.

**Numerics and validation** (§10, §12)

| symbol | quantity | units |
|---|---|---|
| $h$ | integrator step size | s |
| $\lambda$ | linearized relaxation rate $= 2g/v_t$ | 1/s |
| $\tau_{\text{relax}}$ | relaxation time $= 1/\lambda$ | s |
| $\sigma$ | geometric scale factor (eq. 46) | — |
| $W$ | weight $= mg$ | N |

### 1.4 Symbol reuse

Three letters carry different meanings in different sections. They are
disambiguated by subscript and by scope, but be careful when implementing:

| letter | §5 atmosphere | elsewhere |
|---|---|---|
| $L$ | $L_b$, $L_0$ — lapse rate, K/m | $L_j$, $L_e$ — lengths, m (§8.4) |
| $T$ | $T$, $T_b$ — temperature, K | $F_T$ — tension, N (§8.1) |
| $h$ | — (geopotential is $H$) | $h$ — step size (§10); $h_a$, $h_{\text{equiv}}$ — heights |

$\tau$ is inflation progress (§6.3) but $\tau_{\text{relax}}$ is a time constant
(§10). $\lambda$ is the relaxation rate; the geometric scale factor is $\sigma$,
deliberately not $\lambda$.

$j$ carries two meanings and they nest: $j_i$ is the area growth exponent of
device $i$ (§6.3), while $j$ alone indexes the members of one device's harness
load path (§8.4). Both appear in expressions subscripted by $i$, so read the
scope, not the letter.

---

## 2. Why this exists

OpenRocket's descent model (`BasicLandingStepper`, 18 lines) has three defects
that matter for load-bearing design work:

1. **Deployment is a step function.** `CdS` goes from zero to full between two
   integration points. Infinite jerk, no inflation, no filling time.
2. **Shock load is never computed.** There is no opening-force calculation
   anywhere in the codebase — only a warning string above 20 m/s.
3. **Airframe drag is dropped after deployment.** `computeCD` iterates only
   deployed recovery devices, so the body contributes nothing. This is a real
   error during drogue descent.

Phase 1 fixes all three. It does not attempt anything OpenRocket does well —
and note that this is a criticism of its *descent* model only. Before the first
canopy, OpenRocket runs `RK4SimulationStepper` with the full Barrowman
aerodynamic model, which is far beyond anything here.

### 2.1 The three defects, measured

The list above was asserted for a long time without a number behind it.
`physics/openrocket.py` is a port of OpenRocket **release-24.12**'s descent
model, and the Cross-check tab runs it against ours on the same config. On the
§13 worked example:

| Defect | Measurement |
|---|---|
| 1. Step deployment | Peak deceleration **163 m/s² against our 39.7** — a factor of **4.11**, entirely an artefact of opening a canopy between two integration points. The trigger also fires **7.1 m low** (152 m configured, 144.9 m actual), because the crossing is only detected at the end of a 0.5 s step. |
| 2. No shock load | Nothing to compare. Our 1613 N against an absence — which is why the tab renders it "not computed" rather than as a zero. |
| 3. Airframe dropped | Drogue descent rate 25.56 m/s against our 25.19 m/s. Small *here* because the worked example's drogue is 31× the axial airframe area; it grows as the drogue shrinks. |

The port is validated against OpenRocket's own JUnit values and converges onto
our RK45 with the residual attributed to gravity and density, not integration —
see `tests/test_openrocket.py`. `tools/openrocket-golden/` closes the last gap
against an actual run of the program.

### 2.2 The recovery mastersheets

The team's two Google Sheets mastersheets (`reference/mastersheets/`) have sized
real flight hardware and had never been checked against anything.
`physics/mastersheet.py` transcribes their eight Named Functions verbatim and
reproduces every workbook cell exactly. Their model is: terminal velocity
everywhere, instantaneous deployment, one point load per canopy. Their
`SHOCK_LOAD` **is** eq (23), times a hand-entered reduction factor where we
compute Pflanz (eq 28) — the sheet notes "Pflanz method to be added later".

Their peak load lands within 3% of ours, which is real evidence for both: the
two reach the deployment velocity by completely different routes. Three things
they get wrong, all pinned as arithmetic in `tests/test_mastersheet.py`:

* `TROP_DESCENT_TIME` is `DESCENT_WITH_LAPSE` at `ref_alt = 0`, so it has no
  field elevation, and the sheets feed it AGL altitudes while feeding
  `TROP_DENSITY` AMSL ones. Descent time runs **6.8% high** and drift with it.
* `DESCENT_TIME`, the correct 7-layer version, is defined in both books and
  **never called**.
* LE3's 3-parachute sheet is a partially-edited copy of the 2-parachute one:
  main 1's load is evaluated at main 2's density (+5.6%), and the landing speed
  uses main 1's canopy though main 2 deploys last (1.71× on speed, 2.9× on
  energy).

---

## 3. Scope

### In

- 1-D vertical descent from apogee to ground
- Exact ISA atmosphere, re-fit to measured pad conditions
- Arbitrary number of recovery devices with independent deploy triggers
- Finite canopy inflation (filling time + area growth)
- Airframe drag throughout descent
- Opening load: infinite-mass bound (primary) and Pflanz finite-mass (reference)
- Snatch load with series-spring harness
- Full `z(t)`, `v(t)`, `a(t)` history

### Out (Phase 2)

- Wind, drift, landing dispersion
- Canopy oscillation
- Elastic harness dynamics (justified below, §8.3)
- Added-mass momentum term (already inside `Cx`, §8.2)
- Measured `Cx` from flight data
- Reefing

---

## 4. Inputs

| symbol | quantity | units | source |
|---|---|---|---|
| $m$ | total descending mass | kg | vehicle |
| $m_b$ | body mass (harness-side) | kg | $m$ − canopy masses |
| $h_a$ | apogee AGL | m | flight |
| $z_{\text{site}}$ | pad elevation MSL | m | site |
| $T_{\text{pad}}$ | pad temperature | K | measured — the one atmospheric input worth an instrument |
| $p_{\text{pad}}$ | pad station pressure | Pa | ISA at site elevation by default, eq. (7a); pad barometer if recorded. Never a raw METAR altimeter setting — see eq. (7b) |
| $C_dS_{\text{body}}$ | airframe drag area | m² | geometry, banded |
| $(C_dS)_i$ | device drag area | m² | vendor spec |
| $D_{0,i}$ | device nominal diameter | m | vendor spec |
| $m_{c,i}$ | canopy + lines mass | kg | vendor spec |
| $j_i$ | area growth exponent | — | 2 solid, 1 slotted |
| $C_{x,i}$ | opening force coefficient | — | 1.2–1.8 band |
| $n_i$ | filling constant | — | sweep 6–12 |
| $z_{d,i}$ **or** $t_{a,i}$ | deploy altitude AGL **or** time after apogee | m **or** s | design choice, §6.1 |
| $\Delta t_i$ | charge-to-canopy delay | s | 0 free-packed; **0.3–1.0 s bagged** — first-order for a drogue, see §6.1.3 |
| $v_{\text{rel},i}$ | separation velocity | m/s | ground test, 5–20 |
| $k_{\text{eff},i}$ | harness stiffness | N/m | eq. (32) |

> **Everything below $m$, $h_a$ and the site block is per device.** §6.1.1
> promises that nothing assumes two devices or any particular device, and that
> only holds if the inflation *and* the harness parameters are both indexed.
> A drogue and a main do not share a filling constant (it is coupled to $j_i$),
> a separation velocity (one is an ejection charge against a stowed canopy, the
> other a bag extraction from a stabilised descent), or a harness stiffness
> (different line lengths, different materials, different splay). Carrying any
> of them as a single global is a silent coupling between two independent
> events. See §8.4.

**Sign convention:** $z$ is positive up, AGL. Descent has $v < 0$.

### 4.0 Initial condition

The run starts at apogee by default:

$$z(0) = h_a, \qquad v(0) = 0$$

Both are overridable as $(z_0, v_0)$, but see the survivability note below
before using that for early deployment.

**Early deployment is a load check, not a trajectory.** A motor ejection charge
whose delay grain fires before apogee leaves the vehicle climbing, and the
inflation model does not apply there. $v_s$ passes through zero during filling,
so freezing it per eq. (9a) is not a mild approximation but a sign error;
$s_f = nD_0$ is calibrated as a *descent* distance and no longer means what $n$
was measured against; the $\tau^j$ law was fitted to canopies trailing a
descending vehicle; and a 1-D point mass cannot represent recontact, where the
vehicle arcs over into its own canopy.

What *is* computable is the load, because eq. (23) needs only $v_s$. Rather than
guessing how early the charge fires, invert it — eq. (37) already gives the
maximum survivable deployment speed per device, and the ballistic coast converts
that to a time before apogee:

**(56)**

$$\Delta t_{\max,i} = \frac{v_c}{g}\arctan\!\left(\frac{v_{s,\max,i}}{v_c}\right),
\qquad v_c = \sqrt{\frac{2mg}{\rho\, C_dS_{\text{axial}}}}$$

Note eq. (56) uses the **axial** drag area, eq. (14) — during coast the vehicle
is flying nose-first, not in the tumbling attitude assumed for descent. This is
the one place in the model where the §6.4 band does *not* apply, because the
attitude is known.

Report both bounds for every device. For the §13 vehicle with a 1000 lbf weakest
link ($F_{\text{allow}} = 2965$ N after SF), $v_c = 147$ m/s:

| device | $v_{s,\max}$, eq. (37) | $\Delta t_{\max}$, eq. (56) |
|---|---|---|
| drogue | 143 m/s | 11.6 s |
| main | **35 m/s** | **3.5 s** |

**The main is the binding constraint by 3.3×** — a delay grain four seconds long
destroys it while the drogue would shrug it off.

Two properties of eq. (56) are worth knowing. Doubling hardware strength barely
moves the time bound (1000 → 2000 lbf takes the main from 3.5 s to 4.9 s —
**doubling the hardware buys 1.4 seconds**), because $\arctan$ saturates. And
that saturation gives a hard ceiling

$$\Delta t_{\max} \to \frac{v_c}{g}\cdot\frac{\pi}{2} = 23.6\ \text{s}$$

beyond which no deployment survives at any hardware strength. It is set by coast
dynamics, not by what you build.

> Both numbers scale with $v_c$ and therefore with the airframe, so they are not
> transferable between vehicles. The §13 vehicle is slick — $v_c = 146$ m/s
> axially — and a draggier one is bounded much harder: at the *broadside* area
> the same vehicle has $v_c = 24$ m/s and a ceiling of 3.9 s. Recompute per
> vehicle; do not carry these numbers across.

Running from $(z_0, v_0)$ with $v_0 > 0$ is therefore only meaningful for a
device the bound says survives — in practice a drogue, never a main.

> **Deployment velocity is computed, never assumed.** You supply apogee and a
> trigger; the integration returns $v_{s,i}$ at each deployment. This matters
> because $F \propto v_s^2$ — deployment speed is the single largest term in the
> load, and it is an *output* of the descent, not an input. See §6.2.

### 4.1 Mapping from `fruity-chute-scraper`

The scraper already in this folder pulls every device input we need. Take the
numbers straight from its output; do **not** recompute them from the advertised
diameter.

**(A1)** Drag area, from `cd_projected` × `area_projected` (ft² → m²):

$$(C_dS)_i = C_{d_p} \cdot S_p \cdot 0.092903$$

**(A2)** Nominal diameter, from `equivalent_flattend_d` (in → m):

$$D_{0,i} = D_{\text{flat}} \cdot 0.0254$$

**(A3)** Canopy mass, from `weight_grams`:

$$m_{c,i} = \frac{w_g}{1000}$$

Growth exponent $j_i$ from `canopy_style`: `annular` / `elliptical` are solid
cloth, so $j = 2$. Slotted types would take $j = 1$.

> **Do not compute $S_p$ yourself.** Fruity Chutes' `area_projected` **excludes
> the spill hole** — the opposite of the Knacke convention, where reference
> areas include openings. For the IFC-48, $\pi D^2/4 = 12.566$ ft² but
> `area_projected` = 12.177 ft², the difference being exactly the 8.448 in
> spill hole. Pairing their $C_d$ with your own $\pi D^2/4$ overstates $C_dS$
> by 3.2%, silently.

Consistency checks worth asserting against scraped rows, since they validate
that the record parsed correctly:

**(A4)**

$$C_{d_p}\cdot S_p = C_{d,\text{canopy}}\cdot S_{\text{canopy}}$$

**(A5)**

$$D_{\text{flat}} = \sqrt{4 S_{\text{canopy}}/\pi}$$

**(A6)**

$$\frac{\texttt{rate\_15}}{\texttt{rate\_20}} = \left(\frac{15}{20}\right)^2 = 0.5625$$

All three hold to <0.2% on the Iris Ultra line.

### 4.2 Hardware ratings — optional

Eq. (37) needs $F_{\text{allow}}$, which is not part of the physics. Supply it as
an **optional** block: without it the tool reports loads, with it the tool also
returns a verdict. Optional so that a run is possible before hardware is chosen.

| symbol | quantity | units | source |
|---|---|---|---|
| $\text{SF}$ | safety factor | — | 1.5 default, §8.6 |
| $R_k$ | rated strength of link $k$ | N | vendor |
| $F_{\text{allow}}$ | $\min_k R_k / \text{SF}$ | N | derived |

One rating per element of the load path, so the report can name **which** link
governs rather than only that something does:

```yaml
hardware:                    # optional; enables PASS/FAIL
  safety_factor: 1.5
  links:
    bulkhead_eyebolt: 1500 lbf
    quick_link:       1000 lbf
    shock_cord:       2000 lbf
    swivel:           1500 lbf
```

Every element carries $F_{\text{design}}$, so the weakest sets the limit — and it
is rarely the shock cord. Quick links, eyebolt thread engagement into the
bulkhead, and sewn-loop stitching are the usual governing items.

> The canopy itself has no published load rating. Fruity Chutes' "12.75 lb
> @ 20 fps" is a *descent-rate sizing* figure, not a structural limit, so the
> last link in the chain has no number — the same category of gap as $C_x$.

---

## 5. Atmosphere

Evaluated exactly at every call. No lookup grid — OpenRocket caches the ISA on
a 500 m table and interpolates.

That table was described here as "a ~0.6% density error near the ground". It is
not: `physics/openrocket.py` now implements the same grid, and
`tests/test_openrocket.py::test_grid_density_error_is_0_04_percent_not_0_6`
measures **0.036%** mid-cell, zero at the nodes, peaking at 0.045% over the
first 5 km. The original figure was an estimate nobody had checked, and it was
seventeen times too large. Evaluating exactly is still the right call — it is a
handful of flops and removes the question entirely — but the reason is
simplicity, not accuracy.

**(1)** Geometric to geopotential altitude ($H$ geopotential, $z$ geometric):

$$H = \frac{R_e\, z_{\text{MSL}}}{R_e + z_{\text{MSL}}}, \qquad R_e = 6{,}356{,}766\ \text{m}$$

**(2)** Temperature within layer $b$:

$$T(H) = T_b + L_b\,(H - H_b)$$

**(3)** Pressure, sloped layer ($L_b \neq 0$):

$$p(H) = p_b\left(1 + \frac{L_b (H - H_b)}{T_b}\right)^{-g_0 / (R_d L_b)}$$

**(4)** Pressure, isothermal layer ($L_b = 0$):

$$p(H) = p_b \exp\left(\frac{-g_0 (H - H_b)}{R_d T_b}\right)$$

**(5)** Density (dry air — humidity is a ≤1.5% effect, deferred):

$$\rho(z) = \frac{p(H)}{R_d\, T(H)}, \qquad R_d = 287.053\ \text{J/(kg·K)}$$

Moist air is *less* dense than dry, since H₂O (18 g/mol) is lighter than the
28.96 g/mol it displaces. The correction, with $e$ the water vapour partial
pressure, is $\rho_{\text{moist}} = \rho\,(1 - 0.378\,e/p)$ — worth 1.6% at
30 °C and saturated, under 0.5% in typical conditions. Twenty times smaller
than the $C_x$ band, so it stays deferred.

**(6)** Gravity:

$$g(z) = g_0 \left(\frac{R_e}{R_e + z_{\text{MSL}}}\right)^2, \qquad g_0 = 9.80665\ \text{m/s}^2$$

### Pad re-fit

If $T_{\text{pad}}$ is supplied, replace the lowest layer so the profile passes
through the measurement and still meets the standard tropopause (216.65 K at
11 km geopotential):

**(7)**

$$L_0 = \frac{216.65 - T_{\text{pad}}}{11000 - H_{\text{pad}}}$$

with $p_0 = p_{\text{pad}}$ at $H_{\text{pad}}$.

> **Trap:** $p_{\text{pad}}$ must be *station pressure* — what a barometer at
> the pad physically reads. A METAR altimeter setting is corrected to sea level
> and is a different number.

### Pad pressure — source hierarchy

Unlike temperature, pad pressure can be estimated from site elevation alone to
within a couple of percent, because sea-level pressure only wanders a few
percent with synoptic weather. That makes the ranking unusual:

| source | $p_{\text{pad}}$ error | status |
|---|---|---|
| ISA at site elevation, eq. (7a) | ~2% | **Phase 1 default** |
| pad barometer at launch time | ~0% | use whenever recorded |
| METAR altimeter setting + eq. (7b) | 0.3–0.6% | Phase 2 refinement, conditional |
| METAR altimeter setting used raw | 11–18% | never |

**(7a)** Phase 1 default — the standard column evaluated at your site:

$$p_{\text{pad}} = 101325 \left(1 - \frac{0.0065\, H_{\text{pad}}}{288.15}\right)^{5.2559}$$

This is eq. (3) for layer 0 run from sea level, and it needs nothing but site
elevation. It assumes a standard sea-level pressure, which costs about $\pm2\%$
across ordinary highs and lows — worth roughly 1% in descent rate and nothing at
all in the main opening load, which is density-free by eq. (23). Note that the
$T$ and $p$ anchors are independent: pairing a *measured* $T_{\text{pad}}$ in
eq. (7) with an *estimated* $p_{\text{pad}}$ from (7a) is consistent, and is the
expected Phase 1 configuration.

Prefer a real reading when you have one. Every flight altimeter logs raw
barometric pressure before any altitude conversion — Featherweight, Eggtimer and
StratoLogger all do — so a device sitting on the pad gives $p_{\text{pad}}$
directly, with no elevation lookup and no conversion to get wrong.

**(7b)** Phase 2 refinement — recovering station pressure from a METAR. The
altimeter setting $A$ is defined as *the pressure that makes an altimeter at the
field read field elevation*, so invert that definition:

$$p_{\text{pad}} = A \left(1 - \frac{0.0065\, H_{\text{pad}}}{288.15}\right)^{5.2559}, \qquad 1\ \text{inHg} = 3386.389\ \text{Pa}$$

Same expression as (7a) with the standard sea-level value replaced by the
reported setting, which is exactly what the refinement buys: today's synoptic
pressure instead of an assumed standard one. It is an exact algebraic inversion,
so the residual comes entirely from the reporting station not being your pad.

The binding term is the **elevation gap**, since (7b) transfers the reported
setting across $\Delta H = H_{\text{pad}} - H_{\text{station}}$ through a
*standard* column while the real air is not standard. It scales with the gap,
not with site elevation: roughly 0.25% for a 300 m gap on a 20 K anomalous day,
0.5% at 500 m, and 1.6% at 1500 m. Horizontal pressure gradient adds 0.03–0.5%
depending on distance and whether a front is nearby, and reporting quantisation
0.03% (US, 0.01 inHg) or 0.10% (1 hPa elsewhere).

**This refinement is only worth taking when a reporting station sits within a
few hundred metres of site elevation.** Past roughly a 1500 m gap it degrades to
the eq. (7a) default and there is no reason to prefer it. Even in the good case
it buys about 1.5% in density — 0.75% in descent rate, nothing at all in the
main opening load — so it ranks below every other Phase 2 item. High-desert
launch sites and their nearest airports usually sit in the same elevation band,
which is what makes the refinement viable there at all; verify per site rather
than assuming.

Note that (7a) and (7b) both use the **standard** $L_0$ and $T_0$ even when
eq. (7) has already replaced $L_0$. The altimeter setting is defined against the
standard column, not against today's air, so substituting the re-fit lapse rate
would decode with a different function than the station encoded with and would
*introduce* an error where none existed.

Using the setting raw, without either conversion, is the single largest
available error in this section. At a 1000 m field reporting a standard setting
($A$ = 101,325 Pa), the naive value is 101,325 Pa against a true station
pressure of 89,875 Pa — **12.7%** in density, roughly 6% in descent rate. The
error is the ISA pressure ratio at field elevation, so it vanishes at sea level
and grows with site height: 11.3% at 890 m, 15.4% at 1190 m, 18.4% at 1400 m.
It is therefore invisible in testing and worst at exactly the high desert sites
these vehicles fly from. That 89,875 Pa is also the published ISA pressure at
1000 m, which makes this case a usable unit test.

> **Do not use the `SLPxxx` group** in METAR remarks either. That is sea-level
> pressure, a third distinct number reduced using the actual station
> temperature rather than the standard column.

The 216.65 K anchor in eq. (7) is a slope-setting device, not a claim about
conditions at 11 km — the real tropopause moves in both height and temperature
daily, and we never fly there. It is deliberately left at the standard value:
perturbing it by 10 K shifts density at 3 km by only 0.8%, and it preserves a
free regression test, since feeding $T_{\text{pad}} = 288.15$ K must return
$L_0 = -6.5$ K/km exactly. Real profile accuracy comes from a sounding
(§14), not from a better anchor.

---

## 6. Deployment and inflation

This is the core improvement over OpenRocket.

### 6.1 Deploy triggers

Any number of devices, each carrying **exactly one** trigger of either type,
plus an optional delay $\Delta t_i$ for charge-to-canopy lag.

**Type ALTITUDE** — fires when $z$ crosses $z_{d,i}$ descending:

**(8)**

$$t_{d,i} = t_{x,i} + \Delta t_i, \qquad z(t_{x,i}) = z_{d,i},\ \ v < 0$$

**Type TIME** — fires at a fixed time after the run starts:

**(8a)**

$$t_{d,i} = t_{a,i} + \Delta t_i$$

Since the run begins at apogee (§4.0), $t_{a,i}$ is literally "seconds after
apogee." Apogee deployment is either $z_{d,i} = h_a$ or $t_{a,i} = 0$.

**Guard** — ALTITUDE triggers fire only on a **descending** crossing
(`direction = -1` in the root-finder). A vehicle passes its main deployment
altitude on the way up as well, and accepting either crossing fires the main
during boost at several hundred m/s. This is inert while runs start at apogee
with $v = 0$, and becomes a live bug the moment §4.0 permits $v_0 > 0$.

**Guard** — a device that would fire after impact is a design error:

**(8b)**

$$\text{skip device } i \ \text{ and warn if } \ t_{d,i} \ge t_{\text{ground}}$$

Never silently ignore it. Note this is a guard on $t_{d,i}$, **not** on
$t_{x,i}$: a device whose charge fires above ground but whose lines would come
taut below it has still failed, and it is a distinct case from a device that
never triggered at all. Both must be caught.

The two trigger types get different numerical treatment:

| | ALTITUDE | TIME |
|---|---|---|
| detection | root-find $z(t) - z_{d,i} = 0$ on the dense output | exact, known a priori |
| segment end | Brent on the interpolant, at $t_{x,i}$ | terminate at $t = t_{a,i}$ |
| cost | one root-find | free |

Both end a segment at the **trigger** $t_{x,i}$, never at $t_{d,i}$ — see
§6.1.4.

Ordering: at each segment, integrate to the **earliest** of {any pending
altitude crossing, the next pending TIME trigger, any pending line stretch,
ground hit}. Fire that one, restart. Because these can interleave, resolve them
one at a time rather than pre-sorting.

### 6.1.1 Configurations this supports

| configuration | devices |
|---|---|
| dual deploy | drogue ALTITUDE $= h_a$, main ALTITUDE $= 150$ m |
| single deploy | main ALTITUDE $= h_a$ |
| motor-eject drogue | drogue TIME $= t_a$, main ALTITUDE |
| drogueless / ballistic | main ALTITUDE, body drag only above it |
| redundant backup | second main TIME, as a late backup |

Nothing in §6–§8 assumes two devices, or any particular device. A drogue is
just a device with a small $C_dS$ that happens to deploy first, and it keeps
contributing drag after the main opens — see eq. (13) and §13.3, note 5.

> **Guard — deployment at exactly apogee is degenerate.** The first row above
> deploys a drogue at $z_{d} = h_a$, and a run that starts at apogee with
> $v_0 = 0$ then has $v_s = 0$: eq. (10) divides by zero, and eq. (23) returns a
> bound of zero for a load that is emphatically not zero (§8.2). Reject
> $v_s < \sqrt{g\,s_f}$ rather than dividing — §11.7 already warns on it — and
> in practice give the device the real apogee-detect lag, which is what §13
> does with a 2.0 s TIME trigger. Phase 2 item 2 is the actual fix: at apogee
> the vehicle retains horizontal velocity, so the true $v_s$ is not zero, it is
> just not visible to a 1-D state.

### 6.1.2 The phase before first deployment

Between apogee (or $z_0$) and the first deployment the vehicle is **not** in
vacuum free fall — it falls on airframe drag alone, eq. (14)/(15), with
$C_dS_{\text{tot}} = C_dS_{\text{body}}$.

How much that matters depends entirely on attitude, and this is the phase where
the §6.4 band does the most damage. For the §13 vehicle at 3 s:

| | $C_dS_{\text{body}}$ | ballistic $v_t$ | $v(3\ \text{s})$ | vs vacuum |
|---|---|---|---|---|
| vacuum free fall | 0 | ∞ | 29.4 m/s | — |
| axial | 0.00486 m² | 147 m/s | 29.0 m/s | −1.2% |
| broadside | 0.17556 m² | 24.5 m/s | 20.4 m/s | **−31%** |

Nose-down, the phase really is close to free fall and the drag term is a
correction. Broadside, it is nothing of the sort: the vehicle is already at 84%
of a terminal velocity it reaches within a few seconds, and since
$F \propto v_s^2$, assuming vacuum free fall would overstate the drogue opening
load by **2.1×**.

So the error of ignoring airframe drag here is not a fixed percentage — it
ranges from negligible to a factor of two across a band nobody has measured.
That is the argument for carrying eq. (14)/(15) properly *and* for running both
bounds, rather than for either simplification.

### 6.1.3 Bagged deployment

A deployment bag does not change the inflation law. It changes **when inflation
starts**, which is exactly what $\Delta t_i$ in eq. (8a) is for — cord pays out,
stows release in sequence, canopy strips from the bag, and only then does eq.
(11) start its clock.

$\Delta t$ is not a rounding term. The vehicle keeps accelerating throughout,
and $F \propto v_s^2$:

For the §13 vehicle at the axial bound:

| $\Delta t$ | $v_s$ | drogue $F_\infty$ |
|---|---|---|
| 0 | 19.5 m/s | 55 N |
| 0.25 s | 21.9 m/s | +26% |
| 0.50 s | 24.3 m/s | **+55%** |
| 1.00 s | 29.0 m/s | **+122%** |

A bag extraction plausibly runs 0.3–1.0 s, so bagging roughly **doubles the
drogue opening load** for the same trigger — not because the bag is worse, but
because the vehicle is falling faster by the time the canopy sees air.

This is the effect §6.1.4 exists to preserve. Sampling $v_s$ at the trigger
rather than at line stretch collapses every row of that table to the first one.

**This is a drogue-only sensitivity.** A main deployed from a stabilised drogue
descent is already at terminal velocity, so an extra half-second changes $v_s$
by nothing; it merely opens ~11 m lower.

**Mass bookkeeping.** The bag sits between the shock cord and the shroud lines,
so it rides on the canopy side of the harness: $m_{c,i}$ in eq. (33) is canopy +
lines + bag, and the bag is excluded from $m_b$ in eq. (20). Since
$F_{\text{snatch}} \propto \sqrt{\mu}$, a ~70 g bag on a 213 g canopy raises
snatch by about **14%**. Use the full bagged assembly for event A, which is the
governing event; splitting the bag out for event B is not worth chasing given
the $0.625$ bound.

**Stows are not compliance.** Elastic line stows do not enter $k_{\text{eff}}$.
During event A the load path is body → cord → bag, with the stows unloaded along
it; during payout each carries only its small retention force and drops out of
the path once released. They sequence the deployment, they do not spring it.

Whether bagging shifts $n$ itself is not established here. The bag acts upstream
of inflation, and once the canopy is out with lines taut inflation proceeds on
its own terms — but bagging clearly buys *repeatability*, since a free-packed
canopy can emerge tangled or inverted. Keep sweeping $n$ either way.

> **Both bag-specific unknowns fall out of one ground test.** A static ejection
> filmed at 240 fps gives $\Delta t$ (frames from charge to canopy exposure) and
> $v_{\text{rel}}$ (frame-to-frame displacement of the bag). Neither is on any
> datasheet, and between them they cover a ±48% swing on the drogue load and a
> linear factor on snatch. Comparable value to the §14 item 4 flight
> measurement, at an afternoon's cost.

### 6.1.4 The delay is a segment, not an offset

$\Delta t_i$ cannot be implemented as a number added to a timestamp. Eq. (9a)
evaluates $v_{s,i}$ at **line stretch**, $t_{d,i}$, and the vehicle accelerates
throughout the delay on airframe drag alone — which is the entire content of
§6.1.3. Sampling the velocity at the trigger $t_{x,i}$ instead discards that
acceleration and, by §6.1.3's own table, under-predicts the drogue opening load
by up to 48%.

So **line stretch is a third event class**, alongside the two trigger types:

| class | known | detection |
|---|---|---|
| ALTITUDE trigger | a priori as a *height* | root-find on the dense output |
| TIME trigger | a priori as a *time* | exact |
| **line stretch** | **only once that device has triggered** | exact, $t_{x,i} + \Delta t_i$ |

It joins the same earliest-of merge rather than being handled as "integrate one
extra segment and carry on", because **another device can trigger inside a
delay window** — a drogue with $\Delta t = 1.0$ s whose main crosses its
altitude 0.4 s later. Only one ordering rule can be correct, and it is the one
already stated in §6.1.

Three consequences, all of which the model gets wrong if the delay is treated
as an offset:

1. $v_{s,i}$, eq. (9a), is $|v(t_{d,i})|$ — sampled at the line-stretch event.
2. $\rho$ in eq. (22) is evaluated at $z(t_{d,i})$, the altitude at line
   stretch. This is ~11 m below the trigger altitude for a main and worth
   0.13% in density, so it is a notation fix rather than a numerical one — but
   a TIME-triggered device has no $z_{d,i}$ at all, so the equation is
   otherwise undefined for half the §6.1.1 configurations.
3. The error is a clean multiplicative $\left(v(t_{d,i})/v(t_{x,i})\right)^2$
   on every load number, because $A_i$ is independent of $v_s$ at fixed $s_f$
   (eq. 44). Nothing looks inconsistent when it is wrong — even the eq. (48)
   cross-check still passes, since both paths carry the same factor. It errs
   **low**, and therefore unsafe.

During the delay the device contributes **no** drag: $\tau_i < 0$, so
$C_dS_i = 0$ by eq. (12). Physically the bag and pilot chute are already out and
pulling, so the real vehicle is slightly slower than modelled and the modelled
$v_{s,i}$ is slightly high. Conservative, and left alone in Phase 1.

### 6.2 Filling time

**Only the filling-time parameter is frozen — the vehicle's velocity is not.**
The wording matters, because the two are easy to conflate:

| | frozen? | role |
|---|---|---|
| $v(t)$ in eq. (17) | **no** | integrated continuously, responds to the growing $C_dS$ |
| $v_{s,i}$ in eq. (9a) | **yes** | a single scalar, used only to set $t_f$ |

The vehicle decelerates hard during inflation and the integration captures all
of it — under the worked main, $v$ falls to **52% of $v_s$ by full inflation**.
What is frozen is the scalar that sets how fast the $\tau$ clock runs.

The consequence is that $\tau$ advances linearly in wall-clock time, whereas a
canopy physically fills by *distance*, which would give $d\tau/dt = |v(t)|/s_f$
and a filling time about **23% longer** as the vehicle slows. We keep the frozen
form anyway, because $n$ is calibrated against it: literature values assume
$t_f = nD_0/v_s$ with $v_s$ at line stretch, so a distance-based advance paired
with a book $n$ mixes conventions and turns an acknowledged approximation into a
silent one. The residual is absorbed by sweeping $n$.

Freezing also makes `CdS(t)` analytic within each integration segment.

**(9)**

$$s_{f,i} = n_i\, D_{0,i} \qquad \text{(filling distance)}$$

**(9a)**

$$v_{s,i} \equiv |v(t_{d,i})|$$

the freestream speed at line stretch — **frozen**, a single scalar per device,
and an *output* of the integration rather than an input.

**(10)**

$$t_{f,i} = \frac{s_{f,i}}{v_{s,i}}$$

> Parameterize on filling **distance** $s_{f,i}$, not on $n_i$ and $D_{0,i}$
> separately. With the velocity exponent at 1.0, $n_i$ is dimensionless
> ("diameters fallen during inflation") and unit-safe. A literature $n$ quoted
> with the $v^{0.85}$ convention carries units and needs a $\times 1.195$
> conversion from imperial.
>
> $n_i$ is per device because it is coupled to $j_i$ — solid and slotted
> canopies fill over different distances — so a single global $n$ would force a
> drogue and a main to share a constant neither of them was measured with.

### 6.3 Area growth

**(11)** Normalized inflation progress:

$$\tau_i(t) = \frac{t - t_{d,i}}{t_{f,i}}$$

**(12)** Drag area of device $i$:

$$C_dS_i(t) = \begin{cases}
0 & \tau_i < 0 \\[4pt]
(C_dS)_i\,\tau_i^{\,j_i} & 0 \le \tau_i \le 1 \\[4pt]
(C_dS)_i & \tau_i > 1
\end{cases}$$

**(13)** Total drag area:

$$C_dS_{\text{tot}}(t) = C_dS_{\text{body}} + \sum_i C_dS_i(t)$$

Note eq. (13) includes the airframe. OpenRocket omits it.

### 6.4 Airframe drag band

Attitude under canopy is not known, and the two bounds differ by two orders of
magnitude. Run both; do not pick one.

**(14)**

$$C_dS_{\text{body,axial}} \approx 0.6 \cdot \frac{\pi d_{\text{body}}^2}{4}$$

**(15)**

$$C_dS_{\text{body,broadside}} \approx 1.2 \cdot (\ell_{\text{body}} \cdot d_{\text{body}})$$

The ratio is $2.55\,\ell/d$, so it grows with fineness: **36.1×** for the §13
vehicle at $\ell/d = 14.2$. Under a main this is noise. Under a drogue it can
dominate descent rate, and before any deployment it is worth a factor of two in
opening load (§6.1.2). §13 reports every headline number at both bounds for this
reason.

---

## 7. Equation of motion

State $\mathbf{y} = [z,\ v]$.

**(16)**

$$\frac{dz}{dt} = v$$

**(17)**

$$\frac{dv}{dt} = -g(z) - \frac{\rho(z)\, C_dS_{\text{tot}}(t)}{2m}\,|v|\,v$$

The $|v|v$ form makes drag oppose motion in either direction without a sign
test. With $v<0$ the drag term is positive (upward), as it must be.

**(18)** Terminal velocity, for validation and quick estimates:

$$v_t(z) = \sqrt{\frac{2 m\, g(z)}{\rho(z)\, C_dS_{\text{tot}}}}$$

---

## 8. Loads

### 8.1 Instantaneous harness tension

The number that sizes hardware. From a free body diagram of the airframe
(mass $m_b$) under gravity, its own drag, and the riser:

**(19)**

$$F_{D,\text{body}} = \tfrac{1}{2}\rho\, C_dS_{\text{body}}\, v^2$$

**(20)**

$$F_T(t) = m_b\left(\frac{dv}{dt} + g\right) - F_{D,\text{body}}$$

**(21)** Specific force — what an accelerometer in the av bay would read:

$$f = \frac{dv}{dt} + g \qquad \Rightarrow \qquad \text{load factor} = \frac{|f|}{g_0}$$

Record $\max F_T$ over the run, **sampled on the dense output at ≤5 ms**, not at
integrator step boundaries. The adaptive controller can step over the peak.

> **The trajectory integration does not produce the opening overshoot.** The
> area-growth law, eq. (12), is a smooth monotonic ramp, so eq. (20) yields only
> the quasi-steady drag of a growing canopy. The transient overshoot that $C_x$
> represents comes from added-mass and geometric over-inflation physics that a
> $\tau^j$ law cannot generate. Taking the raw numerical peak as your design
> load under-predicts by the factor $C_x$ — a silent factor of ~1.8.

**(21a)** Corrected numerical peak:

$$F_{T,\text{peak}} = C_x \cdot \max_t F_T(t)$$

Keep $C_x$ **out** of eq. (12). Inflating the drag area by $C_x$ would
over-decelerate the vehicle and corrupt the trajectory. The overshoot is a
peak-force effect, not a sustained area increase — so it scales the load and
never the motion.

### 8.2 Opening load — the bound

Primary Phase 1 number. Requires no inflation knowledge and cannot be exceeded.

**(22)** Dynamic pressure at line stretch:

$$q_{s,i} = \tfrac{1}{2}\rho\big(z(t_{d,i})\big)\, v_{s,i}^2$$

Both the density and the speed are evaluated at $t_{d,i}$, the line-stretch
event — not at the trigger, and not at the input altitude $z_{d,i}$, which does
not exist for a TIME-triggered device. See §6.1.4.

**(23)** Infinite-mass opening force:

$$F_{\infty,i} = q_{s,i}\,(C_dS)_i\, C_{x,i}$$

This is the case where the vehicle does not decelerate during inflation, so the
canopy sees full $q_s$ at full area. $C_x$ is the **opening force coefficient**
— the transient overshoot as the canopy inflates past its equilibrium diameter,
driven by the inertia of the entrained air. Because $C_x$ is empirical, the
added-mass physics is already inside it; adding an explicit apparent-mass term
would double-count.

Use $C_x = 1.8$ for the design number unless flight data says otherwise.

> **Validity — the bound is not unconditional.** It assumes the vehicle neither
> gains nor loses speed during inflation, which makes $X_1 \le 1$ and therefore
> $F_\infty$ an upper bound. That argument is Pflanz's, and Pflanz has no
> gravity. At low $v_s$ the filling time $t_f = s_f/v_s$ grows, gravity has
> longer to act, and the speed at the peak can exceed $v_s$ — at which point
> $F_\infty$ evaluated at $v_s$ is an *under*estimate. The crossover is where
> the speed gained during inflation is comparable to $v_s$ itself:
>
> $$v_s \sim \sqrt{g\,s_f}$$
>
> For the IFC-48 main this predicts 11.2 m/s, and numerical integration puts the
> actual failure between 8 and 11 m/s. A main deployed from a stabilised drogue
> descent sits at 20–30 m/s and is safe; a drogue deployed near apogee is not,
> and at $v_s \to 0$ the bound goes to zero while the real load does not. This is
> why eq. (36) takes a max over all three candidates instead of assuming the
> bound governs, and it is the defect Phase 2 item 2 exists to fix.

### 8.3 Opening load — Pflanz reference

Reported alongside the bound so you can see how much conservatism you are
carrying. The bound can run 3–5× the realistic value for a large main.

**(24)** Ballistic parameter:

$$A_i = \frac{2m}{\rho\big(z(t_{d,i})\big)\,(C_dS)_i\, s_{f,i}}$$

**(25)**

$$B_i = \frac{1}{A_i (j_i + 1)}$$

**(26)** Time of peak force, clipped to full inflation:

$$\tau^*_i = \min\left(1,\ \left[\frac{j_i A_i (j_i+1)}{j_i + 2}\right]^{1/(j_i+1)}\right)$$

**(27)** Force reduction factor:

$$X_{1,i} = \frac{(\tau^*_i)^{j_i}}{\left(1 + B_i (\tau^*_i)^{j_i+1}\right)^2}$$

**(28)**

$$F_{\max,i} = F_{\infty,i}\, X_{1,i}$$

For $j=2$ this reduces to a closed form worth asserting in tests:

**(29)**

$$X_1 = \frac{(1.5A)^{2/3}}{2.25}\quad (A < \tfrac{2}{3}), \qquad
X_1 = \left(1 + \frac{1}{3A}\right)^{-2}\quad (A \ge \tfrac{2}{3})$$

Eqs. (24)–(28) come from non-dimensionalizing the drag-only opening ODE, so
they are derived rather than table-looked-up, and they must agree with a
numerical integration of the same reduced problem.

### 8.4 Snatch

Line stretch is an impulsive event and is frequently the **largest** load in the
system — often above the opening load. It must be computed.

**Every device has its own snatch event**, at its own line stretch, with its own
separation velocity, stiffness and reduced mass. A drogue ejected by a charge
against a stowed canopy and a main extracted from a bag during a stabilised
descent share nothing here but the airframe. Everything in this section is
therefore indexed by $i$, and eq. (36) takes the max over devices.

**(30)** Stiffness of one member ($N$ strands in parallel):

$$k_j = \frac{N_j\, F_{\text{rated},j}}{\varepsilon_{\text{rated},j}\, L_j}$$

**(31)** Suspension lines splay from the skirt; only the axial component carries:

$$k_{\text{lines},i} = \frac{N F_{\text{rated}}}{\varepsilon_{\text{rated}} L}\cos^2\theta_i,
\qquad \theta_i = \arcsin\!\left(\frac{D_{p,i}/2}{L_{e,i}}\right)$$

**(32)** Series combination — the load path is nylon lines **in series with** the
Kevlar shock cord, and the softer element dominates:

$$\frac{1}{k_{\text{eff},i}} = \sum_j \frac{1}{k_j}$$

with $j$ running over the members of device $i$'s load path.

**(33)** Reduced mass:

$$\mu_i = \frac{m_b\, m_{c,i}}{m_b + m_{c,i}}$$

**(34)** Peak snatch force:

$$F_{\text{snatch},i} = v_{\text{rel},i}\sqrt{k_{\text{eff},i}\, \mu_i}$$

Within a *single* device's deployment there are two events, and in a bagged
deployment they are **sequential rather than alternative** — the cord goes taut
first with only the Kevlar in the path, then the lines pay out and the nylon
enters it:

| event | when | $k$ |
|---|---|---|
| A — harness snatch | cord taut, canopy still bagged | Kevlar alone (stiffer, worse) |
| B — line stretch | lines paid out, both loaded | series, eq. (32) |

The second is bounded by the first, because both the stiffness *and* the
surviving relative velocity are lower:

$$\frac{F_B}{F_A} = f\sqrt{\frac{k_{\text{series}}}{k_{\text{cord}}}}
\;\le\; \sqrt{\frac{k_{\text{series}}}{k_{\text{cord}}}}$$

with $f \le 1$ the fraction of $v_{\text{rel}}$ surviving event A. For the
worked harness that ceiling is **0.625 even at $f = 1$**, a perfectly elastic
rebound losing no energy. So A always governs, and taking the max is correct —
as the larger of two events in a sequence, not as a choice between scenarios we
cannot distinguish. The bound holds without knowing $f$, which is what makes it
useful.

Packing determines whether B occurs at all. Free-packed canopies have only B.
Bagged canopies with lines stowed in bights keep the lines under tension
throughout payout, so slack never accumulates and there is nothing to run out —
the canopy then strips progressively from the bag rather than engaging as a
rigid mass, and what follows is inflation, not a third impulse. That argument
assumes stows in good condition; the $0.625$ bound does not, which is why sizing
should rest on the bound rather than on the packing.

**Design lever:** $k \propto 1/L$, so $F_{\text{snatch}} \propto L^{-1/2}$.
Doubling harness length cuts snatch 29%, and longer harness reduces recontact
anyway. Conversely $F_{\text{snatch}} \propto v_{\text{rel}}$, so over-charging
the ejection buys shock load directly — ground-test down to the minimum charge
that reliably separates.

### 8.5 Rigid harness is justified

Dynamic amplification depends on load rise time versus harness natural period:

**(35)**

$$t_{n,i} = 2\pi\sqrt{\frac{\mu_i}{k_{\text{eff},i}}}$$

For realistic hardware ($k \sim 10^4$–$10^5$ N/m, $\mu \sim 1$–3 kg),
$t_n \approx 0.02$–0.04 s against a filling time near 1 s. That is
$t_f/t_n \approx 30$ — deep in the quasi-static regime, so DAF $\approx 1$ and
eq. (20) is valid without a two-body elastic model.

*This holds only for smooth inflation.* If reefing is ever added, re-check
eq. (35) at each disreef, where the rise time can approach $t_n$.

### 8.6 Design load

**(36)**

$$F_{\text{design}} = \text{SF}\cdot\max\left(\max_i F_{\text{snatch},i},\ \max_i F_{\infty,i},\ \max_i C_{x,i}\max_t F_T(t)\right), \qquad \text{SF} = 1.5$$

All three candidates now max over devices. Report **which device and which
candidate** governs, not only the number — a design limited by drogue snatch and
one limited by main opening call for different fixes, and the bare maximum
cannot tell them apart.

**(37)** Invert against the weakest link in the chain to get a speed limit, per
device:

$$v_{s,\max,i} = \sqrt{\frac{2 F_{\text{allow}}}{\rho\, (C_dS)_i\, C_{x,i}}}$$

### 8.7 Report the expected load, not only the design load

Eq. (36) sizes to the bound, which is deliberately pessimistic. The tool must
also say **by how much**, so report per device:

| quantity | eq. | what it is |
|---|---|---|
| $F_{\infty,i}$ | (23) | infinite-mass bound, $X_1 = 1$ — what §8.6 sizes to |
| $F_{\max,i} = F_{\infty,i}X_{1,i}$ | (28) | **Pflanz expected value** — the finite-mass estimate |
| $C_x\max_t F_T(t)$ | (21a) | numerical peak, with gravity and airframe drag |
| $1/X_{1,i}$ | (27) | **conservatism ratio** |

$F_{\max,i}$ can never govern eq. (36): it is exactly $F_{\infty,i}X_{1,i}$ and
$X_{1,i}\le1$ by construction, since $X_1 = \max_\tau \tau^{j}u^2$ with both
factors bounded by 1. That is the reason to report it separately rather than
fold it into the max — it is the only number that says whether the bound is
costing you 5% or 240%.

$$\frac{1}{X_{1}} = \frac{\text{what you build}}{\text{what you expect}}$$

For the §13 IFC-48 main, $A = 0.309$ gives $1/X_1 = 3.75$: the structure is
sized to **3.75× the expected load**. For that vehicle's drogue at $A = 14.7$,
$1/X_1 = 1.05$ and the bound is nearly free. Which regime a device sits in
is what decides whether
measuring $C_x$ and $n$ in flight (§14 item 4) is worth the trouble — there is
no point instrumenting a drogue, and a large main is where the mass is.

Note the numerical value is *not* bounded by $F_{\infty,i}$ — it contains
gravity, which Pflanz omits — so it is reported for its own sake as well as for
the eq. (48) cross-check. See the validity note in §8.2.

---

## 9. Landing metrics

**(38)**

$$\text{KE}_{\text{impact}} = \tfrac{1}{2} m\, v_{\text{impact}}^2$$

**(39)** Equivalent free-fall height, the intuitive form:

$$h_{\text{equiv}} = \frac{v_{\text{impact}}^2}{2 g_0}$$

---

## 10. Numerical method

Forward Euler is the wrong tool here. Linearizing eq. (17) about terminal
velocity gives a relaxation rate

**(40)**

$$\lambda = \frac{2g}{v_t}, \qquad \tau_{\text{relax}} = \frac{v_t}{2g}$$

Forward Euler on $\dot y = -\lambda y$ gives $y_{n+1} = (1-h\lambda)y_n$, which
rings for $h\lambda > 1$ and diverges for $h\lambda > 2$. A 7 m/s main gives
$\tau = 0.36$ s and a stability limit of 0.71 s — OpenRocket's 0.5 s nominal
step sits at 70% of it, which is why its stepper contains an explicit
"oscillation avoidance" branch.

**Use adaptive RK45 (Dormand–Prince) with dense output.** `scipy.integrate.solve_ivp`
with `dense_output=True` and terminal events, restarted at each deployment.

- **Events:** each pending deploy altitude, plus ground hit ($z = 0$), all
  root-found by Brent on the interpolant.
- **Segments:** integrate to the next event, apply the deployment (set
  $t_{d,i}$, freeze $v_s$, compute $t_{f,i}$), restart. Within a segment
  $C_dS_{\text{tot}}(t)$ is smooth and analytic.
- **Tolerances:** `rtol=1e-8`, `atol=1e-10`. This problem is cheap.
- **Load sampling:** re-sample the dense output at ≤5 ms for eq. (20).

Note that adding finite inflation (§6) removes the discontinuity that made the
problem stiff in the first place. Fixes 1 and 3 reinforce each other.

---

## 11. Application

### 11.1 Independence

This is a **standalone application**. It shares technology choices with
`EngineDesign` because the team already knows that stack; it shares no runtime,
no tooling and no configuration with it.

| | recovery-calculator | EngineDesign |
|---|---|---|
| backend port | **8100** | 8000 |
| frontend port | **5273** | 5173 |
| virtualenv | own | own |
| Python deps | own `pyproject.toml` | own |
| JS deps | own `package.json` | own |
| dev script | own `dev.sh` | own |
| cross-imports | **none, either direction** | — |

Distinct ports are load-bearing, not cosmetic: `EngineDesign/dev.sh` force-kills
whatever holds port 8000, so sharing it would let one app silently kill the
other. The repo-root `pyproject.toml` touches both, but it is `[tool.black]`
only — shared formatting, not shared runtime.

**Stack:** React 19 + TypeScript + Vite + Recharts + Tailwind on the frontend;
FastAPI + uvicorn + Pydantic on the backend; numpy/scipy for the physics.

Python throughout. Measured: **23 ms** for a full apogee-to-ground descent with
two devices and event root-finding (1684 RHS evaluations), so the 16-corner
sweep is 0.4 s and nothing in Phase 1 approaches a performance wall. Phase 2
Monte Carlo at 10⁴ samples is ~230 s, and the first fix there is
`multiprocessing` over samples, not a rewrite.

### 11.2 Layout

```
recovery-calculator/
    pyproject.toml            own deps and metadata
    dev.sh                    backend :8100 + frontend :5273
    physics/            physics core -- numpy/scipy only, NO web imports
        atmosphere.py    eqs (1)-(7b)
        pad_state.py     §5 resolution, METAR/ISA
        devices.py       eqs (8)-(15)   device dataclass, CdS(t), triggers
        dynamics.py      eqs (16)-(18)  derivative function
        loads.py         eqs (19)-(37)  tension, Pflanz, snatch, design load
        solver.py        §10            segmented RK45 driver
        cases.py         §11.5/§11.9    off-nominal set, corner sweep
        report.py        eqs (38)-(39)  formatted output
        schema.py        Pydantic models, the contract
        data/
            parachutes.csv          scraper output, committed
            manual.csv              hand-entered devices, same columns
            raw/<sku>.json          one raw API payload per SKU
    backend/
        main.py
        routers/
            simulate.py     POST /api/simulate
            sweep.py        POST /api/sweep
            devices.py      GET  /api/devices    query the scraper DB
            atmosphere.py   POST /api/atmosphere pad state
    frontend/                 vite.config.ts pins server.port = 5273
    tools/
        fruity-chute-scraper/     (exists) standalone, stdlib-only
    tests/
```

**`physics` must never import FastAPI.** It is a library with a CLI; the
web app is one consumer, the test suite and notebooks are others. The §12
assertions run headless in CI with no server, and

```
python -m physics config.json
```

stays working as a debugging escape hatch — a way to bisect a bug without React
in the stack. This is an invariant, not a development phase: the library and the
UI are built together, since the failure modes here are mostly *shapes* (a wrong
$j$, a mis-sequenced event, a $\tau$ clock that fails to reset) and those are far
easier to catch on a live plot than in a regenerated PNG.

The scraper stays decoupled: it writes CSV, and `devices.py` reads it with
stdlib `csv`. No import relationship, so the scraper keeps its stdlib-only
property and the core never needs network access.

**CSV, not SQLite.** The device table is committed reference data feeding
structural load calculations, so a reviewer must be able to see a vendor
revising $C_d$ from 2.2 to 1.9 — a 14% shift in $C_dS$, straight into
eq. (23) — as a readable line in a pull request. A binary database makes every
re-scrape an unreviewable blob delta. Performance favours CSV here too: at 1000
rows (well beyond the whole hobby catalogue) an in-memory substring scan takes
0.061 ms against 0.349 ms for SQLite connect-and-query, because at this scale
connection overhead dominates any indexing benefit. CSV also removes the
async-connection question entirely, and `csv` + Pydantic gives *stronger* typing
than a non-`STRICT` SQLite table.

`raw_json` moves out of the row into `raw/<sku>.json`, one file per device, so
the raw vendor payloads stay diffable too and CSV quoting stays sane.
`manual.csv` carries hand-entered devices — a canopy no vendor sells, or one
measured in-house — so they survive a re-scrape and can be tagged as
lower-confidence in the picker.

The loader validates on read with Pydantic, and asserts eqs. (A4)-(A6) there, so
a malformed scrape fails loudly instead of yielding a silently wrong $C_dS$.

### 11.3 Inputs

Sections map to §4. Everything is one schema, serialised identically by the GUI
and accepted verbatim by the CLI.

| section | fields |
|---|---|
| vehicle | $m$, $h_a$, $d_{\text{body}}$, $\ell_{\text{body}}$; optional $(z_0, v_0)$ override for early deployment (§4.0) |
| site | $z_{\text{site}}$, $T_{\text{pad}}$, $p_{\text{pad}}$ source (ISA default / pad barometer / METAR) |
| devices | repeatable 1..N: picker selection, $(C_dS)_i$, $D_{0,i}$, $m_{c,i}$, $j_i$, $C_{x,i}$, $n_i$, trigger (ALTITUDE $z_{d,i}$ or TIME $t_{a,i}$), delay $\Delta t_i$ |
| harness | **per device**, on the same card: $v_{\text{rel},i}$, and either $k_{\text{eff},i}$ directly or the eq. (30)/(31) members |
| **hardware** | **optional** — see §4, enables PASS/FAIL |
| sweep | which parameters to corner-sweep, and their bounds |

**Device picker.** `GET /api/devices?q=iris+48` searches the device CSV;
selecting a row auto-fills $(C_dS)$, $D_0$, $m_c$ and $j$, each marked with a
badge. This is the highest-value control in the application because it removes
the §4.1 trap by construction — nobody who picks from the list can recompute
$S_p$ as $\pi D^2/4$ and silently overstate $C_dS$ by 3.2%. Manual override is
permitted, strips the badge, and displays the vendor value it replaced.

### 11.4 Outputs and export

Live in the GUI, and written to disk by a single **Export run** action:

```
recovery_2026-07-30T14-30-22/
    config.json       exact inputs -- reload to reproduce, byte-identical to Save
    result.json       full Result object, all four cases
    report.txt        human-readable summary
    report.md         same, for pasting into design docs
    trajectory.csv    t, z, v, a, F_T, CdS_tot   (one per case)
    meta.json         version, git SHA, schema version, timestamp
```

`meta.json` carries the **git SHA**. When a number from this tool reaches a
design review, which version of the physics produced it must be recoverable.
Cheap now, impossible to retrofit.

**There is one plotting implementation, and it is Recharts in the browser.**
The export bundle carries `trajectory.csv` and `result.json`, not PNGs.

The alternative — rendering figures server-side with matplotlib so the CLI can
emit them headlessly — buys a self-contained bundle at the cost of a second
plotting implementation to keep visually consistent with the first, plus a
dependency the physics core does not otherwise need. It is not worth it. A
`trajectory.csv` plots in anything, the numbers that matter are already in
`report.md` and `result.json`, and a figure for a design review can be captured
from the GUI that produced it.

Consequence worth stating: `python -m physics config.json` produces
numbers and CSV, never images. That is the intended division, not a gap.

### 11.5 Off-nominal cases

Sizing to the nominal sequence hides single-point failures, so three off-nominal
cases are computed on **every** run and presented alongside it. They are not
optional and not a separate mode — a report that shows only the nominal case is
the failure this section exists to prevent.

| case | what it is |
|---|---|
| **nominal** | drogue at its trigger, main at its altitude |
| **1. simultaneous** | main fires at the drogue's trigger time, near apogee |
| **2. main fails** | descends under drogue alone to the ground |
| **3. drogue fails** | main opens out of ballistic free fall |

The reason all three are worth carrying is that **each fails in a different
category**, so no single pass/fail number covers them. For the §13 vehicle at
the axial bound — the load-conservative one, and the choice is stated because
§6.4 forbids picking silently:

| case | descent | impact | KE | max $F_{\infty}$ | fails on |
|---|---|---|---|---|---|
| nominal | 55 s | 6.04 m/s | 103 J | 1613 N | — |
| 1. simultaneous | **146 s** | 6.04 m/s | 103 J | 900 N | **drift** |
| 2. main fails | 37 s | **25.0 m/s** | **1768 J** | 54 N | **impact** |
| 3. drogue fails | 35 s | 6.21 m/s | 109 J | **27 065 N** | **structure** |

Reading across:

**Case 1 is structurally the gentlest**, which is counterintuitive — the main
opens at 19.5 m/s instead of 25.0 because the vehicle has not yet reached drogue
terminal velocity, and it opens where the air is thinner, giving **56% of the
nominal load**. Its danger is entirely recovery-zone: 2.7× the descent time, and
drift scales with it. Nothing in a load report would flag this case, which is
exactly why descent time has to be a reported output and not a footnote.

**Case 2 loads nothing** — no main means no main opening — but lands at 24.8 m/s
for **17× the nominal impact energy**, equivalent to dropping the vehicle off a
31 m building.

**Case 3 is the structural one**, at **17× the nominal load** and far past
anything the hardware will hold. A slick airframe reaches 103 m/s in the 762 m
of free fall before the main's altitude, and $F \propto v_s^2$ does the rest. It
is a single point of failure that destroys the vehicle outright, so it warrants
an explicit decision: a redundant drogue charge, or a recorded acceptance that a
drogue failure loses the airframe.

> Case 3 is also where the §6.4 band bites hardest, and in the direction that
> should worry you least: broadside, the same failure gives 1423 N rather than
> 27 065 N, because a tumbling airframe is its own drogue. The axial figure is
> the one to design against, since nothing guarantees the vehicle tumbles.

Each case therefore reports against a different metric, and the summary names
the category rather than emitting a bare PASS/FAIL:

| case | metric to check |
|---|---|
| 1 | descent time, drift (Phase 2) |
| 2 | impact velocity, $\text{KE}_{\text{impact}}$, eq. (38)/(39) |
| 3 | $F_{\text{design}}$ against $F_{\text{allow}}$ |

**Interface.** A dropdown selects which case the figures and tables show,
**defaulting to nominal**. The off-nominal cases are computed on the same run —
four integrations at 23 ms is still under 100 ms, so there is no reason to gate
them behind a button. Any case whose own category fails is badged in the
dropdown itself, so a failure cannot be missed by never opening the menu.

**Export.** The bundle carries a trajectory per case:

```
trajectory_nominal.csv
trajectory_simultaneous.csv
trajectory_no_main.csv
trajectory_no_drogue.csv
```

and `result.json` carries all four under a `cases` key with the nominal one
duplicated at the top level, so existing consumers keep working. No images —
see §11.4.

### 11.6 Interface

Split view — inputs left, results right, both scrolling independently, so the
force curve visibly responds while a device is being edited. Collapsible
sections with sticky nav; **not a wizard**, since these values get iterated
dozens of times and a linear flow fights that. Devices are a repeatable card
list, so 1, 2 or 3 canopies need no special-casing.

A 23 ms run means neither the nominal case nor the off-nominal set needs a Run
button:

| tier | cost | trigger |
|---|---|---|
| nominal + 3 off-nominal (§11.5) | 4 × 23 ms | **live, debounced ~150 ms** |
| 16-corner sweep | 0.4 s | debounced ~500 ms |
| design sweeps (§11.10) | ~11 s | explicit button, with progress |

The off-nominal cases ride along in the live tier deliberately. Under 100 ms for
all four is cheap enough that there is no justification for hiding a
single-point failure behind a button nobody presses.

**Figure 1 — flight history.** Five stacked panels on a shared time axis
(Recharts `syncId`): altitude, velocity, acceleration **in g**, harness tension,
and $C_dS_{\text{tot}}$. Vertical event markers across all panels at apogee, each
line stretch, each full inflation, and ground; horizontal reference lines on the
tension panel at $\max_i F_{\infty,i}$, $\max_i F_{\text{snatch},i}$,
$F_{\text{design}}$ and $F_{\text{allow}}$, with the governing device named in
the legend per eq. (36).

The $C_dS_{\text{tot}}$ panel is not decoration — it makes the tension panel
legible by showing the $\tau^j$ ramp the force is following, and it is the
fastest way to spot an inflation bug.

**Wire format.** A 168 s descent at 5 ms is 33,600 points, megabytes of JSON and
a sluggish chart. Resample adaptively for transport: 2 ms within ±0.5 s of each
event, 100 ms elsewhere. ~3,700 points, ~120 KB, and full resolution exactly
where it matters.

### 11.7 Save, load, validate

The form state **is** the config schema — one serialiser, no translation layer.
Save downloads `config.json`; Load accepts it by picker or drag-drop; named
presets live in `localStorage` and remain individually downloadable. The saved
file is exactly what `python -m physics` accepts, which is what makes the
headless path real rather than aspirational.

**Hard errors** block the run: deploy altitude above apogee, no devices,
non-positive mass or drag area.

**Warnings** run anyway and display inline:

| condition | message |
|---|---|
| drogue-failure case exceeds $F_{\text{design}}$ | off-nominal: main at free-fall speed → FAIL |
| $C_x$ unmeasured | ±20% band; see §14 item 4 |
| $p_{\text{pad}}$ from the eq. (7a) default | ~2%; a pad barometer removes it |
| $v_{s,\max}$ within 20% of drogue descent rate | thin margin on eq. (37) |
| main $C_dS$ below drogue $C_dS$ | devices may be swapped |
| any device has $v_s < \sqrt{g\,s_f}$ | bound invalid here, §8.2 |

The first matters most. A tool that reports only the nominal case hides a
single-point failure that exceeds the design load by **11×** for the §13
vehicle.

### 11.8 Driver pseudocode

```python
def simulate(vehicle, devices, site):
    atm      = Atmosphere(site.elevation, site.T_pad, site.p_pad)
    state    = {i: DeviceState() for i in devices}
    y, t     = [vehicle.apogee, 0.0], 0.0
    segments = []

    while y[0] > 0:
        # Three event classes, one merge -- §6.1.4:
        #   ALTITUDE trigger  root-found on the dense output        eq. (8)
        #   TIME trigger      known a priori                        eq. (8a)
        #   LINE STRETCH      known a priori, but only once that
        #                     device has already triggered
        # Line stretch is scheduled, never added to a timestamp, because a
        # second device can trigger inside another's delay window.
        events = [ground_hit] + [alt_trigger(i) for i in pending_alt(state)]
        t_cap  = min([d.t_a for d in pending_time(state)]
                     + [state[i].t_stretch for i in triggered(state)],
                     default=T_MAX)

        seg = solve_ivp(deriv, [t, t_cap], y,
                        events=events, dense_output=True,
                        rtol=1e-8, atol=1e-10)
        segments.append(seg)
        t, y = seg.t[-1], seg.y[:, -1]

        if seg.event is ground_hit:
            break

        i, kind = resolve(seg, t_cap, state)   # which device, which class

        if kind is TRIGGER:
            # The charge has fired; the canopy is still stowed and still
            # contributes no drag (eq. 12, tau < 0). Schedule line stretch
            # and keep integrating -- the vehicle accelerates through the
            # whole delay, which is the entire point of §6.1.3.
            state[i].t_x       = t
            state[i].t_stretch = t + devices[i].delay
            if devices[i].delay == 0.0:
                kind = LINE_STRETCH        # collapse; no zero-length segment
            else:
                continue

        # LINE STRETCH. The canopy is now in the airstream, and only now is
        # v_s defined. Sampling at t_x instead drops the §6.1.3 effect
        # entirely -- up to 48% low on a bagged drogue, and silently, since
        # A is independent of v_s (eq. 44) so nothing looks inconsistent.
        d = devices[i]
        state[i].t_deploy = t                          # eq. (8) = t_x + delta_t
        state[i].v_s      = abs(y[1])                  # eq. (9a)
        state[i].rho_s    = atm.density(y[0] + site.elevation)   # at z(t_d)
        state[i].t_f      = d.n * d.D0 / state[i].v_s  # eqs (9), (10), per-device n
        record_opening_load(i, state[i].v_s, state[i].rho_s)     # eqs (22), (23)
        record_snatch(i, d.v_rel, d.k_eff, mu(vehicle, d))       # eq. (34), per device

    # eq. (8b) -- two distinct failures, and the second is easy to miss
    for i in never_triggered(state):
        warn(f"device {i} never reached its trigger before impact")
    for i in triggered(state):          # fired, but lines never came taut
        warn(f"device {i} fired at t={state[i].t_x:.2f} s but line stretch "
             f"falls at or below ground -- it never opened")

    traj   = resample(segments, dt=0.005)
    FT_max = max(tension(s) for s in traj)         # eq. (20)

    # Per device, report all three load estimates -- not just the one that
    # sizes the hardware. F_pflanz can never govern eq. (36) since it is
    # F_inf * X1 with X1 <= 1, which is exactly why it must be reported:
    # F_inf / F_pflanz = 1 / X1 is the conservatism the design is carrying.
    per_device = {
        i: dict(F_inf    = q_s[i] * d.CdS * d.Cx,              # eq. (23)
                X1       = X1_of(A[i], d.j),                   # eq. (27)/(29)
                F_pflanz = q_s[i] * d.CdS * d.Cx * X1_of(A[i], d.j),   # eq. (28)
                ratio    = 1.0 / X1_of(A[i], d.j),             # §8.7
                F_snatch = snatch[i],                          # eq. (34)
                v_s      = v_s[i], A = A[i], tau_star = tau_star[i])
        for i, d in enumerate(devices)}

    return Result(traj, FT_max, per_device, landing)
```

Note `triggered(state)` means *triggered but not yet stretched* — a device
leaves that set at line stretch. Reaching the end of the run still in it is the
second eq. (8b) failure.

### 11.9 Corner sweep — sweep, don't sample

Phase 1 has no random inputs. Corner-sweep the genuinely-unknown parameters and
take the worst:

$$C_x \in \{1.2,\ 1.8\},\quad n \in \{6,\ 12\},\quad
C_dS_{\text{body}} \in \{\text{axial},\ \text{broadside}\},\quad
v_{\text{rel}} \in \{5,\ 20\}$$

16 runs, milliseconds each. Monte Carlo belongs in Phase 2 with wind.

The three per-device parameters here — $C_x$, $n$, $v_{\text{rel}}$ — are swept
**in common across devices**, not independently. They are the same unmeasured
physics appearing in several places, so a corner where the drogue sits at
$C_x = 1.2$ while the main sits at $1.8$ is not a physical case, and sweeping
them independently would inflate $2^4 = 16$ runs to $2^{2N+2}$ for no added
coverage. Per-device values remain independent as *inputs*; the sweep perturbs
them together, applying each corner as an override across every device.

### 11.10 Design sweeps

Distinct from the uncertainty corners above. Those bound what you *don't know*;
these show how margin responds to what you *choose*. Each is plotted against
$F_{\text{allow}}$ as a horizontal line, so the safe region is read off directly
— cheaper than an inverse solver, with no convergence failures or
no-solution-exists cases, and it shows how *fast* margin degrades rather than
only where it reaches zero.

| sweep | $x$ | drives |
|---|---|---|
| drogue delay | seconds after apogee | drogue $F_\infty$ |
| drogue size | $(C_dS)_{\text{drogue}}$ | **main** $F_\infty$, via eq. (37) |

> **Deployment altitude is deliberately not a load sweep.** The main deploys
> from a stabilised drogue descent, so
> $q_s = \tfrac12\rho v_t^2 = mg/(C_dS)_{d+b}$ — density cancels exactly and the
> main's opening load is *independent of deployment altitude*. Verified on the
> §13 vehicle: **1613 N at 152 m, 300 m and 500 m**, identical to four
> figures, while $v_s$ rises with altitude and $\rho$ falls to
> compensate. Plotting it produces a horizontal line. Main deployment altitude
> still belongs in the tool because it drives descent time, drift and the
> deployed-too-low-to-reach-terminal check — just never on a load axis.
>
> The cancellation requires the vehicle to be *at* drogue terminal velocity when
> the main fires. Deploy high enough that it has not yet settled — above ~800 m
> for the §13 vehicle, which deploys its drogue at 895 m — and the load drops
> off, because $v_s$ has not yet reached $v_t$. So the curve is flat everywhere
> it matters and sags at the top, which is the one part worth checking rather
> than assuming.

The second sweep is the useful form of eq. (37). Solved through, it says

$$(C_dS)_{\text{drogue}} + (C_dS)_{\text{body}} \;\ge\; \frac{mg\,(C_dS)_{\text{main}}\,C_x}{F_{\text{allow}}}$$

with $\rho$ cancelling on both sides, so it is a density-free, altitude-free
design rule: **the drogue has a minimum size set by hardware ratings, not by
descent-rate preference.** Undersize it and the main opens too fast for the
weakest link regardless of how the descent rate looks on paper.

### 11.11 Roadmap

One phase, not two — the library and the interface are built together (§11.2).
Inside it there is still an order.

**v1 — the tool**

1. `schema.py` first. The Pydantic models are the contract both sides build
   against, so they precede both.
2. Stub `POST /api/simulate` returning a canned `Result` fixture, so the
   frontend can build the full figure on day one in parallel with the physics.
   Writing a *plausible* canned result is itself a check on the schema.
3. Physics replaces the stub endpoint by endpoint; the fixture survives as a
   frontend test double.
4. §12 assertions in CI from the start, headless.

**v2 — live data and depth**

5. **NWS integration.** Resolve pad state automatically from site coordinates:
   nearest reporting station lookup, METAR fetch, decode, and eq. (7b)
   conversion, replacing hand-entered $T_{\text{pad}}$ and $p_{\text{pad}}$.
   Source is the Aviation Weather Center API at `aviationweather.gov`
   (`/api/data/metar`, `/api/data/stationinfo`). Extends naturally to the
   §14 items that need more than a surface observation — radiosonde and model
   soundings for a real $T(H)$ profile, and winds aloft for drift. Note that
   station choice must be checked per site: `stationinfo` is the authoritative
   test of whether a field actually reports, since aggregator pages substitute
   the nearest reporting neighbour without saying so.
6. Device picker over the scraper DB (§11.3), sweep figures, tornado plot,
   saved presets.

Egress to `aviationweather.gov` must be reachable from wherever this runs; it is
blocked by policy in some sandboxes.

---

## 12. Validation

Assert these in the test suite. They are cheap and they catch real bugs.

**(41)** Constant-$\rho$, single-device descent must converge to eq. (18).

**(42)** Infinite-mass limit:

$$X_1 \to 1 \quad \text{as} \quad A \to \infty \qquad (X_1 = 0.987 \ \text{at}\ A=50)$$

**(43)** Analytic $X_1$, eq. (29), must match numerical integration of the
reduced opening ODE.

**(44)** With $s_f = nD_0$ fixed, $A$ is independent of $v_s$, so:

$$F \propto v_s^2 \quad \text{exactly}$$

**(45)** In the finite-mass regime, **at fixed $s_f$**:

$$X_1 \propto (C_dS)^{-2/3} \quad \Rightarrow \quad F \propto (C_dS)^{1/3}$$

Doubling drag area alone raises opening load only 26%.

The "at fixed $s_f$" clause is load-bearing and easy to drop. A canopy scaled
*geometrically* has $D_0 \propto \sqrt{C_dS}$ and therefore
$s_f \propto \sqrt{C_dS}$, which makes $A \propto (C_dS)^{-3/2}$,
$X_1 \propto (C_dS)^{-1}$ and $F$ **flat** — no increase at all. Both statements
are correct about different experiments; only the fixed-$s_f$ one is a property
of eq. (24) rather than of a particular way of growing a canopy. Test the
fixed-$s_f$ form, since it is the one the equation asserts.

**(46)** Geometric scaling by $\sigma$ (all lengths $\times\sigma$,
$m \propto \sigma^2$ at fixed descent rate):

$$\frac{F}{W} \propto \sigma^{-2/3}$$

Small vehicles see higher load factors than large ones. Flag this when a proven
design is scaled down.

**(47)** Sensitivity, for interpreting the sweep:

$$X_1 \propto s_f^{-2/3}$$

A 50% error in filling distance is a 30% error in load.

**(48)** The two independent load paths must agree. With eq. (21a) applied,
**per device $i$, over that device's own inflation window**
$t \in [t_{d,i},\ t_{d,i} + t_{f,i}]$:

$$0.8 \;<\; \frac{C_{x,i} \max_t F_T(t)}{F_{\max,i}} \;<\; 1.3$$

Divergence beyond this means the inflation law, the event timing, or the dense-
output sampling is wrong. This is the single most valuable test in the suite —
it cross-checks the numerical integrator against a closed form derived from
completely different assumptions.

**(49)** Raw numerical peak must come in *below* Pflanz over the same window,
since it lacks the overshoot:

$$\max_t F_T(t) < F_{\max,i}$$

If it does not, $C_x$ has leaked into eq. (12).

> **Both are per device, and both are skipped below the eq. (23) validity
> floor.** Two scoping rules, and neither is optional:
>
> A **global** $\max_t F_T$ is dominated by whichever device is largest, so
> comparing it against a drogue's $F_{\max}$ compares two unrelated events and
> fails for reasons that have nothing to do with correctness. Restrict the
> maximum to each device's own filling interval.
>
> And where $v_{s,i} < \sqrt{g\,s_{f,i}}$ the §8.2 validity note says
> $F_{\infty}$ is not a bound at all, so $F_{\max}$ is not a reference either
> — a near-apogee drogue sits exactly there. Assert only for devices that
> clear the floor, and report the rest as unbounded rather than failing them.
> Without this the suite fails on the drogue of any correct implementation.

**(50)–(51)** Pre-deployment ballistic phase. At constant $\rho$ and constant
$C_dS$, released from rest, eq. (17) has a closed solution — a direct test of
the integrator over the §6.1.2 phase:

$$v(t) = -v_t \tanh\!\left(\frac{g t}{v_t}\right)$$

$$z(t) = z_0 - \frac{v_t^2}{g}\ln\cosh\!\left(\frac{g t}{v_t}\right)$$

Both must reproduce to integrator tolerance. As $t \to 0$ these reduce to
$v \to -gt$ and $z \to z_0 - \tfrac12 g t^2$, confirming that vacuum free fall
is the small-time limit and *not* the model.

**(52)** Trigger equivalence. A device set to ALTITUDE $z_{d}$ and the same
device set to TIME $t_a$ must produce identical results when $t_a$ is the time
the altitude run reports for that crossing. Round-tripping this catches sign
errors, off-by-one segment handling, and delay double-counting.

**(57)** Delay sensitivity — the §6.1.4 regression. Run one device twice,
identical but for $\Delta t$. During the delay the vehicle is in the §6.1.2
ballistic phase, so eq. (50) gives the answer in closed form:

$$\frac{v_s(\Delta t)}{v_s(0)} = \frac{\tanh\!\big(g(t_x + \Delta t)/v_t\big)}{\tanh\!\big(g\,t_x/v_t\big)}
\qquad\Rightarrow\qquad
\frac{F_\infty(\Delta t)}{F_\infty(0)} = \left(\frac{v_s(\Delta t)}{v_s(0)}\right)^{2}$$

to within the density change over the fall, which is negligible. Both must
hold. Sampling $v_s$ at the trigger instead of at line stretch makes the ratio
identically 1, which is exactly the failure this assertion exists to catch —
and note that eq. (48) still passes in that state, so (48) does **not** cover
it.

**(58)** A device with $\Delta t = 0$ must be bit-identical to one where the
trigger and line-stretch events are resolved separately. This exercises the
degenerate collapse in §11.8 and guarantees the delay path is not a second
code path with its own arithmetic.

---

## 13. Worked example

**One vehicle, used by every worked number in this document.** §4.0, §6.1.2,
§6.1.3, §6.4, §8.7, §11.5 and §11.10 all quote results from these inputs — if a
number appears anywhere in this plan, it came from here. Every input is listed,
so the whole document is reproducible from one config and this section is the
regression fixture.

### 13.1 Inputs

| | | |
|---|---|---|
| $m$ | 5.67 kg (12.5 lb) | total descending mass |
| $h_a$ | 914 m AGL (3000 ft) | apogee |
| $z_{\text{site}}$ | **610 m MSL** | FAR pad elevation — a constant, not an input (§4.3) |
| $T_{\text{pad}}$ | 284.185 K | **= ISA at 610 m**, so eq. (7) re-fits to $L_0 = -6.5$ K/km exactly and the free regression test of §5 is live |
| $p_{\text{pad}}$ | 94 209 Pa | eq. (7a) default |
| $d_{\text{body}}$, $\ell_{\text{body}}$ | 0.1016 m (4 in), 1.44 m | fineness 14.2 |
| $C_dS_{\text{body}}$ | **0.00486 m² axial / 0.17556 m² broadside** | eqs. (14), (15) — a 36.1× band, run both |
| SF | 1.5 | |

Devices, both solid-cloth ($j = 2$), both $C_x = 1.8$, both $n = 8$,
both $\Delta t = 0$ (free-packed) unless a section says otherwise:

| | drogue | main |
|---|---|---|
| $(C_dS)_i$ | 0.15 m² | 2.489 m² (Iris Ultra IFC-48) |
| $D_{0,i}$ | 0.6 m | 1.601 m |
| $m_{c,i}$ | 0.060 kg | 0.213 kg |
| trigger | TIME, $t_a = 2.0$ s | ALTITUDE, $z_d = 152$ m |
| $k_{\text{eff},i}$ | 25 000 N/m | 17 400 N/m |
| $v_{\text{rel},i}$ | 10 m/s | 10 m/s |

giving $m_b = 5.397$ kg, and $\mu = 0.2049$ kg for the main, $0.0593$ kg for the
drogue.

The main's $k_{\text{eff}}$ is the eq. (32) series of a Kevlar shock cord at
44 545 N/m and nylon suspension lines at 28 556 N/m. Those two numbers are what
make §8.4's event-B ceiling $\sqrt{17400/44545} = 0.625$.

> **The drogue fires 2.0 s after apogee, not at it.** A trigger at exactly
> $h_a$ with $v_0 = 0$ makes $v_s = 0$, so eq. (10) divides by zero and eq. (23)
> returns a bound of zero for a load that is not zero. 2.0 s is a realistic
> apogee-detect lag and it keeps the example on the valid side of §8.2. See the
> guard in §6.1.1.

### 13.2 Outputs

From numerical integration of eqs. (16)–(17), reported at **both** airframe
bounds because §6.4 does not permit picking one:

| quantity | axial | broadside |
|---|---|---|
| drogue $v_s$ at line stretch | 19.49 m/s | 16.27 m/s |
| drogue $F_\infty$ | 54 N | 38 N |
| main deploy time | 31.3 s | 44.2 s |
| main $v_s$ | **25.16 m/s** | **17.34 m/s** |
| main $q_s$ | 360 Pa | 171 Pa |
| main filling time $t_f$ | 0.509 s | 0.739 s |
| main $A$, $X_1$ | 0.313, 0.268 | 0.313, 0.268 |
| **main $F_\infty$ (bound)** | **1613 N — load factor 29.0** | **766 N — load factor 13.8** |
| main $F_{\max}$ (Pflanz) | 433 N | 206 N |
| numerical $\max F_T$, raw | 266 N | 133 N |
| numerical $\times\,C_x$, eq. (21a) | 479 N | 240 N |
| $F_{\text{snatch}}$, main / drogue | 597 N / 385 N | 597 N / 385 N |
| descent rate under main | 6.04 m/s (19.8 fps) | 5.85 m/s (19.2 fps) |
| total descent time | 54.8 s | 68.8 s |
| impact KE | 103 J | 97 J |
| **$F_{\text{design}}$, eq. (36)** | **2420 N (544 lbf)** | **1149 N (258 lbf)** |

$A$ and $X_1$ are identical across the two columns because eq. (24) contains no
$v_s$ — the attitude band moves the *load* but not the finite-mass credit, which
is eq. (44) visible in a table.

### 13.3 What this example demonstrates

1. **The airframe attitude band is worth 2.1× on the design load** (2420 vs
   1149 N) and 26% on descent time. It is a single unmeasured binary, and it
   outranks everything except $C_x$. This is §15.5 made concrete, and it is the
   argument for §6.4's "run both, do not pick one."
2. **Snatch (597 N) exceeds the realistic opening load** at both bounds
   (476 N axial, 239 N broadside). If you model only opening you under-report
   the peak by 1.3–2.5×. That is the argument for including §8.4 in Phase 1
   rather than deferring it — and note it governs eq. (36) in neither column,
   because the *bound* is larger still.
3. **Numerical and Pflanz agree to 11%** (476 vs 430 N axial) once eq. (21a) is
   applied. The residual is gravity during inflation, which Pflanz omits and the
   integration does not. This is the eq. (48) cross-check passing, and it is the
   main evidence both load paths are implemented correctly.
4. **The bound is 3.73× the Pflanz value.** Fine for Phase 1 sizing, but report
   both (§8.7) so nobody over-builds a bulkhead fourfold without knowing it.
5. **The drogue keeps flying after main deployment.** Descent rate uses
   $C_dS = 2.489 + 0.15 + C_dS_{\text{body}}$, giving 19.8 fps rather than the
   20.4 fps the main alone would give at this site. Easy to get wrong by hand;
   eq. (13) handles it.

Cross-check against the vendor: Fruity Chutes claims 19.8 fps at 12.5 lb, and
eq. (18) with the main alone **at sea-level density** (1.225 kg/m³, the
condition the vendor quotes) gives 19.81 fps. Spec sheet and model agree to
0.05%. Note this is deliberately not the site-elevation number above — at 500 m
the same canopy alone gives 20.3 fps, and the difference is density, not
disagreement.

---

## 14. Phase 2

In rough priority order:

1. Wind profile (power law + tabulated sounding, PCHIP-interpolated) and drift

2. **Drogue load from relative airspeed and angle of attack.** Phase 1 carries a
   1-D vertical state, so at apogee $v \to 0$, the drogue's $q_s \to 0$, and the
   eq. (23) bound degenerates — see the validity note in §8.2. The vehicle is
   not stationary at apogee. It retains horizontal velocity from weathercocking
   during ascent, and the air itself is moving. What the canopy responds to is
   the **relative** airspeed:

   **(53)**

   $$\vec{v}_{\text{rel}} = \vec{v}_{\text{veh}} - \vec{v}_{\text{wind}}(z), \qquad v_{s} = \lvert\vec{v}_{\text{rel}}\rvert$$

   with $\vec{v}_{\text{veh}}$ at apogee taken from the ascent simulation rather
   than assumed zero. Because $F \propto v_s^2$, a horizontal component that is
   irrelevant to descent rate is decisive for the drogue's opening load — and it
   is the only thing keeping $v_s$ above the $\sqrt{g\,s_f}$ floor at which the
   bound stops being a bound.

   The same vector fixes the §6.4 attitude band. With $\hat{a}$ the vehicle axis:

   **(54)**

   $$\alpha = \arccos\!\left(\frac{\vec{v}_{\text{rel}}\cdot\hat{a}}{\lvert\vec{v}_{\text{rel}}\rvert}\right)$$

   **(55)**

   $$C_dS_{\text{body}}(\alpha) \approx C_dS_{\text{axial}}\cos^2\alpha + C_dS_{\text{broadside}}\sin^2\alpha$$

   Eq. (55) is a first-order interpolation between eqs. (14) and (15), not a
   validated model, and should be checked against measured attitude before being
   trusted. But §6.1.2 already identifies the axial-versus-broadside band as the
   dominant error of the pre-deployment phase, and *any* defensible attitude
   estimate collapses two orders of magnitude into a number. Near apogee the
   vehicle is tipping over with the freestream increasingly broadside, so the
   axial bound is the wrong one to be sizing against there.

   Depends on the 2-D state from item 1, so it lands with the wind work rather
   than before it.

3. Landing dispersion via Monte Carlo over wind and $C_dS$ uncertainty
4. Flight-measured $C_x$, $t_f$, $n$, and $v_{\text{rel}}$ from a high-rate
   accelerometer — collapses every band in §11 into measured numbers
5. Canopy oscillation as a stochastic tilt (drives dispersion, not mean drift)
6. Reefing, with the eq. (35) check at each disreef
7. Observed pad pressure in place of the eq. (7a) standard-column estimate,
   either from a METAR altimeter setting via eq. (7b) or from a logged pad
   barometer reading — worth about 1.5% in density, so it ranks below
   everything above it

Item 4 is the highest value per unit effort. One instrumented flight replaces
every table lookup in this document with a measurement of your actual hardware.
Item 2 is the highest value per unit *correctness* — it is the only one that
repairs a case Phase 1 gets structurally wrong rather than merely imprecisely.

### 14.1 Candidates the §2 cross-check surfaced

Three more, added after porting OpenRocket and the mastersheets and finding out
what they carry that this does not:

8. **Drift under wind.** The mastersheets estimate it as descent time × wind
   speed and this tool does not estimate it at all, so the Cross-check tab has
   a row only one of the three models can fill. Crude as their version is, it is
   the constraint that actually picks a canopy at a range with a waiver box —
   and it lands in the same place as item 1 above, so it is really an argument
   for prioritising that.
9. **Ejection-charge and shear-pin sizing.** Both mastersheets carry black
   powder mass against bay pressure, force on the bulkhead, and how many nylon
   screws that shears. Entirely outside this document's scope today, and
   entirely inside the recovery engineer's job.
10. **A sharper axial bound from OpenRocket's own drag terms.**
    `BarrowmanDragCalculator.calculateBaseCD(M)` (`0.12 + 0.13M²` subsonic,
    `0.25/M` above) and `calculateStagnationCD(M)` are static, Mach-only and
    about ten lines each — they need no component tree, unlike the rest of
    Barrowman. They are real closed forms where eq. (14)'s `0.6·πd²/4` is a
    round number. Worth having for the *axial* bound only: §6.4's whole
    argument is that attitude under canopy is unknown, and nothing here should
    be used to collapse the band.

---

## 15. Assumptions register

Every approximation the model makes, with its cost where we have quantified it.
This is the section to read first when reviewing a number this tool produced.
Direction is **cons** (errs safe), **non-cons** (errs unsafe), or **?** (sign
unknown, bracketed by the §11.9 corner sweep).

### 15.1 Scope

| assumption | cost | § |
|---|---|---|
| 1-D vertical motion, no wind or drift | drift absent entirely | §3 |
| Point mass — no attitude, rotation, or recontact | recontact unrepresentable | §3 |
| Rigid harness, DAF $\approx 1$ | $\le 2\%$ for a main; see §8.5 | §8.5 |
| All devices share one attachment point | single $F_T$ | §8.1 |
| Constant mass | exact | — |
| Run starts at apogee, $v_0 = 0$ | early deployment is a load bound only | §4.0 |

### 15.2 Atmosphere

| assumption | cost | dir |
|---|---|---|
| ISA piecewise-linear $T(H)$ | structural | — |
| $L_0$ empirical, or re-fit from $T_{\text{pad}}$ | 3% density at 3 km | ? |
| Tropopause anchor fixed at 216.65 K | 0.8% per 10 K | ? |
| Dry air, humidity neglected | $\le 1.5\%$ density | **non-cons** |
| $p_{\text{pad}}$ from eq. (7a) standard column | ~2% | ? |
| Geopotential correction retained | 1.5 m at 10k ft | negligible |
| $g(z)$ inverse-square | 0.09% at 3 km | negligible |

### 15.3 Inflation

| assumption | cost | dir |
|---|---|---|
| $\tau^{j}$ growth law, empirical | structural | — |
| $j = 2$ solid / $1$ slotted | modeling choice | ? |
| **$n$ swept 6–12, never measured** | $X_1 \times 0.63$ on a main | ? |
| $v_s$ frozen — $\tau$ advances in time, not distance | **23% in $t_f$** | absorbed into $n$ |
| Monotonic growth, no overshoot represented | requires $C_x$ | — |
| $\Delta t = 0.3$–$1.0$ s when bagged | **+55% drogue load at 0.5 s** | ? |

### 15.4 Loads

| assumption | cost | dir |
|---|---|---|
| **$C_x \in [1.2, 1.8]$, unmeasured** | **$\pm20\%$ — dominant term** | ? |
| $C_x$ applied uniformly though it acts at $\tau = 1$ | ~10% | **cons** |
| Pflanz omits gravity | +11% vs numerical | cons |
| Pflanz omits airframe drag | $-6\%$ vs numerical | non-cons |
| $F_\infty$ bounds only for $v_s \gg \sqrt{g s_f}$ | fails below ~11 m/s | **non-cons there** |
| Springs linear to break, no hysteresis | unquantified | cons |
| Snatch by energy conservation, undamped | — | cons |
| Snatch and opening do not superpose | 16 harness periods apart | cons |
| $\varepsilon_{\text{rated}}$ usually unpublished | $k$ estimated | ? |
| $F_{\max}$ used as harness tension, ignoring $m_c$ | 3.9% | cons |
| SF stacked on a conservative $C_x$ | compounds | cons |

### 15.5 Airframe

| assumption | cost | dir |
|---|---|---|
| **Attitude unknown, axial vs broadside** | **$2.55\,\ell/d$ — 36.1× at $\ell/d = 14.2$; 2.1× on $F_{\text{design}}$** | ? |
| $C_d = 0.6$ axial | rule of thumb | probably low |
| $C_d = 1.2$ broadside | textbook cylinder in crossflow | solid |
| Single $C_d$ across the descent | descent spans the drag crisis | non-cons at speed |
| Fins in neither reference area | unquantified | non-cons |

### 15.6 Data

| assumption | dir |
|---|---|
| Vendor $C_dS$ taken as published | ? |
| **Canopy assumed stronger than the hardware** | **untested — no published rating exists** |

### 15.7 What actually moves the answer

$$\underbrace{C_dS_{\text{body}}}_{2.1\times\ \text{on}\ F_{\text{design}}} \;>\; \underbrace{C_x}_{\pm20\%} \;>\; \underbrace{\Delta t}_{+55\%} \;>\; \underbrace{v_{\text{rel}}}_{4\times} \;>\; \underbrace{n}_{0.63\times} \;\gg\; \underbrace{\text{atmosphere}}_{1\text{–}3\%}$$

$C_dS_{\text{body}}$ moves to the front once §13 is run at both bounds: the
attitude band is a 36× swing in the input and a **2.1× swing in the design
load**, against $C_x$'s 1.5×. It also cannot be swept away — it is a binary
about which way the vehicle is pointing, not a tolerance — which is why §14
item 2 is ranked as the correctness fix rather than a refinement.

**§5 is the longest section in this document and contributes the least.** The
atmosphere is worth 1–3% on descent rate and *exactly zero* on the main's
opening load, which cancels density entirely. Recorded here so nobody chases a
sounding while $C_x$ remains a guess.

Three measurements collapse the top of that list:

| measurement | removes | cost |
|---|---|---|
| static ejection filmed at 240 fps | $\Delta t$ **and** $v_{\text{rel}}$ | an afternoon |
| known load hung on the harness | $k_{\text{eff}}$ | ten minutes |
| accelerometer in the av bay | $C_x$, $n$, $t_f$ | one flight |

### 15.8 Where it errs unsafely

These do not announce themselves, so they are listed separately:

1. **The bound below $v_s \approx \sqrt{g s_f}$** — a drogue near apogee has
   $F_\infty \to 0$ while the real load does not. Mitigated by eq. (36) taking a
   max over three candidates rather than trusting the bound.
2. **Canopy strength** — the last link in the load path carries no number, and
   the design implicitly assumes it exceeds the hardware.
3. **Recontact** — a point mass cannot see it, and it is a real failure mode.
4. **Reynolds at speed** — $C_d = 1.2$ broadside is optimistic above
   $Re \approx 3\times10^5$, which the descent crosses.
5. **Dry air** — small, but always in the same direction.

Everything else errs conservative or has unknown sign, and unknown-sign terms
are bracketed by the corner sweep.
