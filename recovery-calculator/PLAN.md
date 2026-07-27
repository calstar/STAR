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
| $n$ | filling constant — diameters fallen | — |
| $s_{f,i}$ | filling distance $= n D_{0,i}$ | m |
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
| $F_{\text{snatch}}$ | line-stretch peak force | N |
| $F_{\text{design}}$ | design load, incl. safety factor | N |
| $f$ | specific force (accelerometer reading) | m/s² |
| SF | safety factor, 1.5 | — |

**Harness** (§8.4)

| symbol | quantity | units |
|---|---|---|
| $v_{\text{rel}}$ | **separation** velocity between the two masses — not $v_s$ | m/s |
| $k_j$, $k_{\text{eff}}$ | member stiffness, series total | N/m |
| $F_{\text{rated},j}$ | rated strength of member $j$ | N |
| $\varepsilon_j$ | fractional elongation at rated load | — |
| $N_j$ | strands in parallel | — |
| $L_j$, $L_e$ | member length, suspension line length | m |
| $\theta$ | suspension line splay half-angle | rad |
| $\mu$ | reduced mass $m_b m_c/(m_b+m_c)$ | kg |
| $t_n$ | harness natural period | s |

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

Phase 1 fixes all three. It does not attempt anything OpenRocket does well.

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
| $T_{\text{pad}}, p_{\text{pad}}$ | pad temperature, station pressure | K, Pa | measured |
| $C_dS_{\text{body}}$ | airframe drag area | m² | geometry, banded |
| $(C_dS)_i$ | device drag area | m² | vendor spec |
| $D_{0,i}$ | device nominal diameter | m | vendor spec |
| $m_{c,i}$ | canopy + lines mass | kg | vendor spec |
| $j_i$ | area growth exponent | — | 2 solid, 1 slotted |
| $C_{x,i}$ | opening force coefficient | — | 1.2–1.8 band |
| $n$ | filling constant | — | sweep 6–12 |
| $z_{d,i}$ **or** $t_{a,i}$ | deploy altitude AGL **or** time after apogee | m **or** s | design choice, §6.1 |
| $\Delta t_i$ | charge-to-canopy delay | s | 0 unless known |
| $v_{\text{rel}}$ | separation velocity | m/s | ground test, 5–20 |
| $k_{\text{eff}}$ | harness stiffness | N/m | eq. (32) |

**Sign convention:** $z$ is positive up, AGL. Descent has $v < 0$.

### 4.0 Initial condition

The run starts at apogee by default:

$$z(0) = h_a, \qquad v(0) = 0$$

Both are overridable as $(z_0, v_0)$. This is the escape hatch for **early
deployment** — a motor ejection charge whose delay grain fires before apogee.
Phase 1 cannot integrate the powered/coast phase, so for that case start the run
at the ejection point with the actual altitude and velocity from your ascent
sim, rather than at apogee.

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

---

## 5. Atmosphere

Evaluated exactly at every call. No lookup grid — OpenRocket caches the ISA on
a 500 m table and interpolates, which is a ~0.6% density error near the ground
for no benefit.

**(1)** Geometric to geopotential altitude ($H$ geopotential, $z$ geometric):

$$H = \frac{R_e\, z_{\text{MSL}}}{R_e + z_{\text{MSL}}}, \qquad R_e = 6{,}356{,}766\ \text{m}$$

**(2)** Temperature within layer $b$:

$$T(H) = T_b + L_b\,(H - H_b)$$

**(3)** Pressure, sloped layer ($L_b \neq 0$):

$$p(H) = p_b\left(1 + \frac{L_b (H - H_b)}{T_b}\right)^{-g_0 / (R_d L_b)}$$

**(4)** Pressure, isothermal layer ($L_b = 0$):

$$p(H) = p_b \exp\left(\frac{-g_0 (H - H_b)}{R_d T_b}\right)$$

**(5)** Density (dry air — humidity is a <1% effect, deferred):

$$\rho(z) = \frac{p(H)}{R_d\, T(H)}, \qquad R_d = 287.053\ \text{J/(kg·K)}$$

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

**Guard** — a device that would fire after impact is a design error:

**(8b)**

$$\text{skip device } i \ \text{ and warn if } \ t_{d,i} \ge t_{\text{ground}}$$

Never silently ignore it.

The two types get different numerical treatment:

| | ALTITUDE | TIME |
|---|---|---|
| detection | root-find $z(t) - z_{d,i} = 0$ on the dense output | exact, known a priori |
| segment end | Brent on the interpolant | terminate at $t = t_{d,i}$ |
| cost | one root-find | free |

Ordering: at each segment, integrate to the **earliest** of {any pending
altitude crossing, the next pending TIME trigger, ground hit}. Fire that one,
restart. Because triggers can interleave, resolve them one at a time rather
than pre-sorting.

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
contributing drag after the main opens — see eq. (13) and §13, note 4.

### 6.1.2 The phase before first deployment

Between apogee (or $z_0$) and the first deployment the vehicle is **not** in
vacuum free fall — it falls on airframe drag alone, eq. (14)/(15), with
$C_dS_{\text{tot}} = C_dS_{\text{body}}$. That distinction is not academic:

$$\text{no drag, } 3\ \text{s}: \ v = gt = 29.4\ \text{m/s}$$

$$\text{with } C_dS_{\text{body}} = 0.05\ \text{m}^2,\ m = 5.67\ \text{kg}: \ v = 25.7\ \text{m/s}$$

13% lower at 3 s, and the gap widens with delay because the ballistic terminal
velocity here is only 44 m/s. Since $F \propto v_s^2$, treating this phase as
vacuum free fall overstates drogue opening load by ~30% at 3 s — conservative,
but enough to distort a trade study. Use the real drag.

This phase is also where the airframe-attitude band (§6.4) does the most
damage: tumbling versus nose-down changes $C_dS_{\text{body}}$ by two orders of
magnitude, and therefore changes the drogue's $v_s$ substantially. Run both
bounds.

### 6.2 Filling time

Airspeed is frozen at the deployment instant — standard practice, and it makes
`CdS(t)` an analytic function within each integration segment.

**(9)**

$$s_{f,i} = n\, D_{0,i} \qquad \text{(filling distance)}$$

**(9a)**

$$v_{s,i} \equiv |v(t_{d,i})|$$

the freestream speed at line stretch — **frozen**, a single scalar per device,
and an *output* of the integration rather than an input.

**(10)**

$$t_{f,i} = \frac{s_{f,i}}{v_{s,i}}$$

> Parameterize on filling **distance** $s_f$, not on $n$ and $D_0$ separately.
> With the velocity exponent at 1.0, $n$ is dimensionless ("diameters fallen
> during inflation") and unit-safe. A literature $n$ quoted with the $v^{0.85}$
> convention carries units and needs a $\times 1.195$ conversion from imperial.

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

Under a main this is noise. Under a drogue it can dominate descent rate.

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

**(22)** Dynamic pressure at deployment:

$$q_{s,i} = \tfrac{1}{2}\rho(z_{d,i})\, v_{s,i}^2$$

**(23)** Infinite-mass opening force:

$$F_{\infty,i} = q_{s,i}\,(C_dS)_i\, C_{x,i}$$

This is the case where the vehicle does not decelerate during inflation, so the
canopy sees full $q_s$ at full area. $C_x$ is the **opening force coefficient**
— the transient overshoot as the canopy inflates past its equilibrium diameter,
driven by the inertia of the entrained air. Because $C_x$ is empirical, the
added-mass physics is already inside it; adding an explicit apparent-mass term
would double-count.

Use $C_x = 1.8$ for the design number unless flight data says otherwise.

### 8.3 Opening load — Pflanz reference

Reported alongside the bound so you can see how much conservatism you are
carrying. The bound can run 3–5× the realistic value for a large main.

**(24)** Ballistic parameter:

$$A_i = \frac{2m}{\rho(z_{d,i})\,(C_dS)_i\, s_{f,i}}$$

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

**(30)** Stiffness of one member ($N$ strands in parallel):

$$k_j = \frac{N_j\, F_{\text{rated},j}}{\varepsilon_{\text{rated},j}\, L_j}$$

**(31)** Suspension lines splay from the skirt; only the axial component carries:

$$k_{\text{lines}} = \frac{N F_{\text{rated}}}{\varepsilon_{\text{rated}} L}\cos^2\theta,
\qquad \theta = \arcsin\!\left(\frac{D_p/2}{L_e}\right)$$

**(32)** Series combination — the load path is nylon lines **in series with** the
Kevlar shock cord, and the softer element dominates:

$$\frac{1}{k_{\text{eff}}} = \sum_j \frac{1}{k_j}$$

**(33)** Reduced mass:

$$\mu = \frac{m_b\, m_c}{m_b + m_c}$$

**(34)** Peak snatch force:

$$F_{\text{snatch}} = v_{\text{rel}}\sqrt{k_{\text{eff}}\, \mu}$$

Compute **two cases** and take the worse:

| case | when | $k$ |
|---|---|---|
| A — harness snatch | cord taut, canopy still bagged | Kevlar alone (stiffer, worse) |
| B — line stretch | lines paid out, both loaded | series, eq. (32) |

**Design lever:** $k \propto 1/L$, so $F_{\text{snatch}} \propto L^{-1/2}$.
Doubling harness length cuts snatch 29%, and longer harness reduces recontact
anyway. Conversely $F_{\text{snatch}} \propto v_{\text{rel}}$, so over-charging
the ejection buys shock load directly — ground-test down to the minimum charge
that reliably separates.

### 8.5 Rigid harness is justified

Dynamic amplification depends on load rise time versus harness natural period:

**(35)**

$$t_n = 2\pi\sqrt{\frac{\mu}{k_{\text{eff}}}}$$

For realistic hardware ($k \sim 10^4$–$10^5$ N/m, $\mu \sim 1$–3 kg),
$t_n \approx 0.02$–0.04 s against a filling time near 1 s. That is
$t_f/t_n \approx 30$ — deep in the quasi-static regime, so DAF $\approx 1$ and
eq. (20) is valid without a two-body elastic model.

*This holds only for smooth inflation.* If reefing is ever added, re-check
eq. (35) at each disreef, where the rise time can approach $t_n$.

### 8.6 Design load

**(36)**

$$F_{\text{design}} = \text{SF}\cdot\max\left(F_{\text{snatch}},\ \max_i F_{\infty,i},\ C_x\max_t F_T(t)\right), \qquad \text{SF} = 1.5$$

**(37)** Invert against the weakest link in the chain to get a speed limit:

$$v_{s,\max} = \sqrt{\frac{2 F_{\text{allow}}}{\rho\, (C_dS)\, C_x}}$$

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

## 11. Module structure

```
recovery-calculator/
    fruity-chute-scraper/         (exists) device data source, §4.1
    star_recovery/
    atmosphere.py    eqs (1)-(7)
    devices.py       eqs (8)-(15)   device dataclass, CdS(t), triggers
    dynamics.py      eqs (16)-(18)  derivative function
    loads.py         eqs (19)-(37)  tension, Pflanz, snatch, design load
    solver.py        §10             segmented RK45 driver
    report.py        eqs (38)-(39)  formatted output
    cli.py                          YAML/JSON config in, report out
tests/
    test_atmosphere.py
    test_inflation.py
    test_descent.py
    test_loads.py
```

### Driver pseudocode

```python
def simulate(vehicle, devices, site):
    atm  = Atmosphere(site.elevation, site.T_pad, site.p_pad)
    state = {i: DeviceState() for i in devices}
    y, t  = [vehicle.apogee, 0.0], 0.0
    segments = []

    while y[0] > 0:
        # ALTITUDE triggers become root-found events; TIME triggers just
        # cap the segment. Integrate to whichever comes first.  eq. (8)/(8a)
        events  = [ground_hit] + [alt_trigger(i) for i in pending_alt(state)]
        t_cap   = min([d.t_a + d.delay for d in pending_time(state)],
                      default=T_MAX)

        seg = solve_ivp(deriv, [t, t_cap], y,
                        events=events, dense_output=True,
                        rtol=1e-8, atol=1e-10)
        segments.append(seg)

        if seg.event is ground_hit:
            break

        if seg.event is None:            # hit t_cap -> a TIME trigger fired
            i = device_at(t_cap)
        else:                            # an ALTITUDE crossing fired
            i = seg.event.device

        # v_s is an OUTPUT of the integration, never an input
        state[i].t_deploy = seg.t[-1] + devices[i].delay
        state[i].v_s      = abs(seg.y[1, -1])
        state[i].t_f      = n * devices[i].D0 / state[i].v_s   # eqs (9),(9a),(10)
        record_opening_load(i, state[i].v_s,
                            atm.density(seg.y[0, -1] + site.elevation))
        t, y = seg.t[-1], seg.y[:, -1]

    # any device that never fired -> eq. (8b)
    for i in pending(state):
        warn(f"device {i} would deploy at or after ground impact")

    traj  = resample(segments, dt=0.005)
    FT_max = max(tension(s) for s in traj)         # eq. (20)
    return Result(traj, FT_max, opening_loads, snatch, landing)
```

### Sweep, don't sample

Phase 1 has no random inputs. Corner-sweep the genuinely-unknown parameters and
take the worst:

$$C_x \in \{1.2,\ 1.8\},\quad n \in \{6,\ 12\},\quad
C_dS_{\text{body}} \in \{\text{axial},\ \text{broadside}\},\quad
v_{\text{rel}} \in \{5,\ 20\}$$

16 runs, milliseconds each. Monte Carlo belongs in Phase 2 with wind.

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

**(45)** In the finite-mass regime:

$$X_1 \propto (C_dS)^{-2/3} \quad \Rightarrow \quad F \propto (C_dS)^{1/3}$$

Doubling canopy size raises opening load only 26%.

**(46)** Geometric scaling by $\sigma$ (all lengths $\times\sigma$,
$m \propto \sigma^2$ at fixed descent rate):

$$\frac{F}{W} \propto \sigma^{-2/3}$$

Small vehicles see higher load factors than large ones. Flag this when a proven
design is scaled down.

**(47)** Sensitivity, for interpreting the sweep:

$$X_1 \propto s_f^{-2/3}$$

A 50% error in filling distance is a 30% error in load.

**(48)** The two independent load paths must agree. With eq. (21a) applied:

$$0.8 \;<\; \frac{C_x \max_t F_T(t)}{F_{\max}} \;<\; 1.3$$

Divergence beyond this means the inflation law, the event timing, or the dense-
output sampling is wrong. This is the single most valuable test in the suite —
it cross-checks the numerical integrator against a closed form derived from
completely different assumptions.

**(49)** Raw numerical peak must come in *below* Pflanz, since it lacks the
overshoot:

$$\max_t F_T(t) < F_{\max}$$

If it does not, $C_x$ has leaked into eq. (12).

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

---

## 13. Worked example

Inputs:

| | |
|---|---|
| $m$ | 5.67 kg (12.5 lb) |
| apogee | 914 m AGL (3000 ft) |
| site elevation | 500 m MSL |
| drogue | $C_dS = 0.15$ m², $D_0 = 0.6$ m, at apogee |
| main | Iris Ultra IFC-48: $C_dS = 2.489$ m², $D_0 = 1.601$ m, at 152 m AGL |
| $C_dS_{\text{body}}$ | 0.05 m² (axial) |
| harness | $k_{\text{eff}} = 17{,}400$ N/m (series), $v_{\text{rel}} = 10$ m/s |

Expected outputs:

Outputs, from numerical integration of eqs. (16)–(17) with RK45 at
`rtol=1e-9`:

| quantity | value |
|---|---|
| drogue terminal rate | 22.4 m/s |
| drogue phase duration | 35.6 s |
| main deploy velocity $v_s$ | 22.0 m/s |
| filling time $t_f$ | 0.58 s |
| $q_s$ at deploy | 279 Pa |
| **$F_\infty$ (bound, $C_x{=}1.8$)** | **1249 N — load factor 22.5** |
| $F_{\max}$ (Pflanz, $X_1 = 0.266$) | 333 N — load factor 6.0 |
| numerical $\max F_T$, raw | 210 N |
| numerical $\times\, C_x$, eq. (21a) | 378 N |
| **$F_{\text{snatch}}$** | **597 N** |
| main descent rate | 5.95 m/s (19.5 fps) |
| total descent time | 59.6 s |
| impact KE | 100 J |
| **$F_{\text{design}}$ (bound × 1.5)** | **1874 N (421 lbf)** |

Four things this example demonstrates:

1. **Snatch (597 N) exceeds the realistic opening load (378 N).** If you only
   model opening, you under-report the peak by 1.6×. This is the argument for
   including §8.4 in Phase 1, not deferring it.
2. **Numerical and Pflanz agree within 14%** once eq. (21a) is applied
   (378 vs 333 N). The residual is gravity acting during inflation, which
   Pflanz neglects and the integration does not. That agreement is the main
   validation that both paths are implemented correctly.
3. **The bound is 3.8× the Pflanz value.** Fine for Phase 1 sizing, but report
   both so nobody over-builds a bulkhead fourfold without knowing it.
4. **The drogue keeps flying after main deployment.** Descent rate uses
   $C_dS = 2.489 + 0.15 + 0.05$, giving 19.5 fps rather than the 20.1 fps you
   would get from the main alone. Easy to get wrong by hand; eq. (13) handles it.

Cross-check against the vendor: Fruity Chutes claims 19.8 fps at 12.5 lb, and
eq. (18) at sea-level density with the main alone gives 19.81 fps. Spec sheet
and model agree to 0.05%.

---

## 14. Phase 2

In rough priority order:

1. Wind profile (power law + tabulated sounding, PCHIP-interpolated) and drift
2. Landing dispersion via Monte Carlo over wind and $C_dS$ uncertainty
3. Flight-measured $C_x$, $t_f$, $n$, and $v_{\text{rel}}$ from a high-rate
   accelerometer — collapses every band in §11 into measured numbers
4. Canopy oscillation as a stochastic tilt (drives dispersion, not mean drift)
5. Reefing, with the eq. (35) check at each disreef

Item 3 is the highest value per unit effort. One instrumented flight replaces
every table lookup in this document with a measurement of your actual hardware.
