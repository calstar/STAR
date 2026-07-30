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
| $T_{\text{pad}}$ | pad temperature | K | measured — the one atmospheric input worth an instrument |
| $p_{\text{pad}}$ | pad station pressure | Pa | ISA at site elevation by default, eq. (7a); pad barometer if recorded. Never a raw METAR altimeter setting — see eq. (7b) |
| $C_dS_{\text{body}}$ | airframe drag area | m² | geometry, banded |
| $(C_dS)_i$ | device drag area | m² | vendor spec |
| $D_{0,i}$ | device nominal diameter | m | vendor spec |
| $m_{c,i}$ | canopy + lines mass | kg | vendor spec |
| $j_i$ | area growth exponent | — | 2 solid, 1 slotted |
| $C_{x,i}$ | opening force coefficient | — | 1.2–1.8 band |
| $n$ | filling constant | — | sweep 6–12 |
| $z_{d,i}$ **or** $t_{a,i}$ | deploy altitude AGL **or** time after apogee | m **or** s | design choice, §6.1 |
| $\Delta t_i$ | charge-to-canopy delay | s | 0 free-packed; **0.3–1.0 s bagged** — first-order for a drogue, see §6.1.3 |
| $v_{\text{rel}}$ | separation velocity | m/s | ground test, 5–20 |
| $k_{\text{eff}}$ | harness stiffness | N/m | eq. (32) |

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
is flying nose-first, not in the tumbling attitude assumed for descent.

Report both bounds for every device. For the worked vehicle with a 1000 lbf
weakest link: the drogue survives to 156 m/s (10.6 s before apogee), the main
only to 38 m/s (3.8 s). **The main is the binding constraint by roughly 3×** — a
delay grain four seconds long destroys it while the drogue would shrug it off.

Two properties of eq. (56) are worth knowing. Doubling hardware strength barely
moves the time bound (1000 → 2000 lbf takes the main from 3.8 s to 5.1 s),
because $\arctan$ saturates. And that saturation gives a hard ceiling

$$\Delta t_{\max} \to \frac{v_c}{g}\cdot\frac{\pi}{2} = 17.3\ \text{s}$$

beyond which no deployment survives at any hardware strength. It is set by coast
dynamics, not by what you build.

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

### 6.1.3 Bagged deployment

A deployment bag does not change the inflation law. It changes **when inflation
starts**, which is exactly what $\Delta t_i$ in eq. (8a) is for — cord pays out,
stows release in sequence, canopy strips from the bag, and only then does eq.
(11) start its clock.

$\Delta t$ is not a rounding term. The vehicle keeps accelerating throughout,
and $F \propto v_s^2$:

| $\Delta t$ | $v_s$ | drogue $F_\infty$ |
|---|---|---|
| 0 | 18.7 m/s | 42 N |
| 0.25 s | 20.7 m/s | +23% |
| 0.50 s | 22.7 m/s | **+48%** |
| 1.00 s | 26.4 m/s | **+100%** |

A bag extraction plausibly runs 0.3–1.0 s, so bagging roughly **doubles the
drogue opening load** for the same trigger — not because the bag is worse, but
because the vehicle is falling faster by the time the canopy sees air.

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

Two events, and in a bagged deployment they are **sequential rather than
alternative** — the cord goes taut first with only the Kevlar in the path, then
the lines pay out and the nylon enters it:

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

For the IFC-48 main, $A = 0.356$ gives $1/X_1 = 3.4$: the structure is sized to
**3.4× the expected load**. For a drogue at $A = 15$, $1/X_1 = 1.05$ and the
bound is nearly free. Which regime a device sits in is what decides whether
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
    star_recovery/            physics core -- numpy/scipy only, NO web imports
        atmosphere.py    eqs (1)-(7b)
        pad_state.py     §5 resolution, METAR/ISA
        devices.py       eqs (8)-(15)   device dataclass, CdS(t), triggers
        dynamics.py      eqs (16)-(18)  derivative function
        loads.py         eqs (19)-(37)  tension, Pflanz, snatch, design load
        solver.py        §10            segmented RK45 driver
        figures.py       matplotlib, headless -- export artifacts
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

**`star_recovery` must never import FastAPI.** It is a library with a CLI; the
web app is one consumer, the test suite and notebooks are others. The §12
assertions run headless in CI with no server, and

```
python -m star_recovery config.json
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
| devices | repeatable 1..N: picker selection, $(C_dS)$, $D_0$, $m_c$, $j$, $C_x$, trigger (ALTITUDE $z_d$ or TIME $t_a$), delay $\Delta t_i$ |
| harness | $v_{\text{rel}}$, and either $k_{\text{eff}}$ directly or the eq. (30)/(31) members |
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
    result.json       full Result object
    report.txt        human-readable summary
    report.md         same, for pasting into design docs
    trajectory.csv    t, z, v, a, F_T, CdS_tot   (nominal)
    figures/
        nominal/flight.png          5-panel history
        simultaneous/flight.png     off-nominal 1, §11.5
        no_main/flight.png          off-nominal 2
        no_drogue/flight.png        off-nominal 3
        sweep_drogue_delay.png
        sweep_drogue_cds.png
        tornado.png
    meta.json         version, git SHA, schema version, timestamp
```

`meta.json` carries the **git SHA**. When a number from this tool reaches a
design review, which version of the physics produced it must be recoverable.
Cheap now, impossible to retrofit.

**Figures are rendered server-side with matplotlib, not exported from Recharts.**
Clean division: Recharts for interaction, matplotlib for artifacts. The CLI needs
headless figures regardless, so the plotting code is written once and both paths
use it.

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
category**, so no single pass/fail number covers them. For the worked vehicle:

| case | descent | impact | KE | max $F_{\infty}$ | fails on |
|---|---|---|---|---|---|
| nominal | 168 s | 5.8 m/s | 96 J | 1248 N | — |
| 1. simultaneous | **478 s** | 5.8 m/s | 96 J | 709 N | **drift** |
| 2. main fails | 132 s | **21.3 m/s** | **1290 J** | 43 N | **impact** |
| 3. drogue fails | 110 s | 6.0 m/s | 101 J | **5029 N** | **structure** |

Reading across:

**Case 1 is structurally the gentlest**, which is counterintuitive — the main
opens at 18.6 m/s instead of 21.6 because the vehicle has not yet reached drogue
terminal velocity, giving **57% of the nominal load**. Its danger is entirely
recovery-zone: 2.8× the descent time, and drift scales with it. Nothing in a
load report would flag this case, which is exactly why descent time has to be a
reported output and not a footnote.

**Case 2 loads nothing** — no main means no main opening — but lands at 21.3 m/s
for **13× the nominal impact energy**, equivalent to dropping the vehicle off a
23 m building.

**Case 3 is the structural one**, at 4× the nominal load and past the design
load. It is a single point of failure that breaks the main, so it warrants an
explicit decision: a redundant drogue charge, or a recorded acceptance that a
drogue failure loses the vehicle.

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

**Export.** The bundle carries a figure set per case:

```
figures/
    nominal/        flight.png
    simultaneous/   flight.png
    no_main/        flight.png
    no_drogue/      flight.png
```

and `result.json` carries all four under a `cases` key with the nominal one
duplicated at the top level, so existing consumers keep working.

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
tension panel at $F_\infty$, $F_{\text{snatch}}$, $F_{\text{design}}$ and
$F_{\text{allow}}$.

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
file is exactly what `python -m star_recovery` accepts, which is what makes the
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
single-point failure that exceeds the design load by ~2.7×.

### 11.8 Driver pseudocode

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

    # Per device, report all three load estimates -- not just the one that
    # sizes the hardware. F_pflanz can never govern eq. (36) since it is
    # F_inf * X1 with X1 <= 1, which is exactly why it must be reported:
    # F_inf / F_pflanz = 1 / X1 is the conservatism the design is carrying.
    per_device = {
        i: dict(F_inf    = q_s[i] * d.CdS * d.Cx,              # eq. (23)
                X1       = X1_of(A[i], d.j),                   # eq. (27)/(29)
                F_pflanz = q_s[i] * d.CdS * d.Cx * X1_of(A[i], d.j),   # eq. (28)
                ratio    = 1.0 / X1_of(A[i], d.j),             # §8.7
                v_s      = v_s[i], A = A[i], tau_star = tau_star[i])
        for i, d in enumerate(devices)}

    return Result(traj, FT_max, per_device, snatch, landing)
```

### 11.9 Corner sweep — sweep, don't sample

Phase 1 has no random inputs. Corner-sweep the genuinely-unknown parameters and
take the worst:

$$C_x \in \{1.2,\ 1.8\},\quad n \in \{6,\ 12\},\quad
C_dS_{\text{body}} \in \{\text{axial},\ \text{broadside}\},\quad
v_{\text{rel}} \in \{5,\ 20\}$$

16 runs, milliseconds each. Monte Carlo belongs in Phase 2 with wind.

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
> main's opening load is *independent of deployment altitude*. Verified: 1246 N
> at 150 m and 1246 N at 2400 m, a 16× altitude range. Plotting it produces a
> horizontal line. Main deployment altitude still belongs in the tool because it
> drives descent time, drift and the deployed-too-low-to-reach-terminal check —
> just never on a load axis.

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
| $\Delta t = 0.3$–$1.0$ s when bagged | **+48% drogue load at 0.5 s** | ? |

### 15.4 Loads

| assumption | cost | dir |
|---|---|---|
| **$C_x \in [1.2, 1.8]$, unmeasured** | **$\pm20\%$ — dominant term** | ? |
| $C_x$ applied uniformly though it acts at $\tau = 1$ | ~10% | **cons** |
| Pflanz omits gravity | +13% vs numerical | cons |
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
| **Attitude unknown, axial vs broadside** | **$2.55\,\ell/d$ — 36× at our fineness** | ? |
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

$$\underbrace{C_x}_{\pm20\%} \;>\; \underbrace{C_dS_{\text{body}}}_{36\times} \;>\; \underbrace{\Delta t}_{+48\%} \;>\; \underbrace{v_{\text{rel}}}_{4\times} \;>\; \underbrace{n}_{0.63\times} \;\gg\; \underbrace{\text{atmosphere}}_{1\text{–}3\%}$$

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
