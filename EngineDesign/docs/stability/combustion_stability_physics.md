# Combustion and Feed-System Stability for a Pressure-Fed LOX/CH₄ Unlike-Doublet Engine

**Working physics reference for the STAR Layer-1/Final-report stability model**
Status: draft **v0.2** — physics basis and modeling choices, with sources and stated uncertainties.
Scope: 8 kN-class, pressure-fed (dome-regulated), unlike-impinging-doublet, LOX/methane.

> **v0.2 review-pass changes (pre-implementation):** fixed θ_c prefactor (1/Γ², not 1/γ); rewrote the
> chug characteristic eq (3.3) in dimensionally-consistent **impedance form** and separated the
> regulator's **impedance role** (poles/α) from its **forcing role** (excursion bound); distinguished
> the **conversion/transport lag** τ_conv (chug) from the **sensitive lag** τ_sens (acoustic n–τ); fixed
> the §4.1 heading; demoted "±14 psi" to an explicit assumption everywhere.

> This document is the *physics* companion to `stability_model_rebuild_plan.md`. Section numbers
> here are referenced by the plan so the two stay in lockstep. Where the literature is thin or the
> modeling step is a judgement call, it is flagged **[UNCERTAINTY]** rather than asserted.

---

## Nomenclature

| Symbol | Meaning | Units |
|---|---|---|
| $p'$ | Acoustic/oscillatory pressure perturbation | Pa |
| $q'$ | Oscillatory volumetric heat-release rate | W/m³ |
| $P_c$ | Mean chamber pressure | Pa |
| $T_c$ | Mean chamber (combustion) temperature | K |
| $c^*$ | Characteristic velocity | m/s |
| $\gamma$ | Ratio of specific heats of combustion gas | – |
| $R_g$ | Specific gas constant of combustion products | J/(kg·K) |
| $a = \sqrt{\gamma R_g T_c}$ | Chamber sound speed | m/s |
| $V_c$ | Chamber gas volume (injector face → throat) | m³ |
| $A_t$ | Throat area | m² |
| $L^*=V_c/A_t$ | Characteristic length | m |
| $L_{ch},\,D_{ch}$ | Cylindrical chamber length, diameter | m |
| $\dot m,\ \dot m_O,\ \dot m_F$ | Total / oxidizer / fuel mass flow | kg/s |
| $\mathrm{MR}$ | Mixture ratio $\dot m_O/\dot m_F$ | – |
| $\Delta P_{inj}$ | Injector pressure drop (manifold → chamber) | Pa |
| $\eta_{inj}=\Delta P_{inj}/P_c$ | Injector stiffness ratio | – |
| $C_d$ | Orifice discharge coefficient | – |
| $A_{or}$ | Total orifice area of a stream | m² |
| $u_j$ | Jet (orifice) velocity | m/s |
| $\rho_O,\rho_F$ | Liquid propellant densities | kg/m³ |
| $D_{32}$ (SMD) | Sauter mean diameter of spray | m |
| $K_v$ | $d^2$-law evaporation constant | m²/s |
| $B$ | Spalding transfer number (heat or mass) | – |
| $\tau$ | Crocco *sensitive time lag* (pressure-sensitive part) | s |
| $\tau_{tot}$ | Total conversion time (atomize→vaporize→mix→react) | s |
| $\tau_{vap}$ | Droplet vaporization lifetime | s |
| $n$ | Crocco *interaction index* (pressure sensitivity of burning) | – |
| $\theta_c$ | Chamber gas-dynamic time constant (residence time) | s |
| $\Gamma$ | Choked-flow (Vandenkerckhove) function $\sqrt{\gamma}\,(2/(\gamma+1))^{\frac{\gamma+1}{2(\gamma-1)}}$; $\Gamma^2\approx0.4$ at $\gamma{\approx}1.2$ | – |
| $\tau_{conv}$ | Total conversion/transport lag (injection→heat release, ≈$\tau_{vap}$) | s |
| $\mathcal{I}=\ell/A_{line}$ | Feed-line inertance (**mass-flow convention**) | 1/m |
| $\mathcal{R}$ | Feed-line resistance (mass-flow) | Pa·s/kg |
| $G_{inj}=\dot m/(2\eta_{inj}P_c)$ | Injector flow conductance $\partial\dot m/\partial\Delta P$ | kg/(s·Pa) |
| $Z=\Delta P'/\dot m'$ | Generic impedance, through-variable = mass flow $\dot m'$ | Pa·s/kg |
| $Z_{feed}=Z_{reg}+\mathcal I s+\mathcal R+1/G_{inj}$ | Series feed+injector impedance | Pa·s/kg |
| $K_c=c^*/A_t$ | Chamber gain (burned-flow→chamber pressure) | Pa·s/kg |
| $Y_{ch}(s)=K_c/(\theta_c s+1)$ | Chamber transfer function | Pa·s/kg |
| $f$ | Frequency | Hz |
| $\omega=2\pi f$ | Angular frequency | rad/s |
| $\alpha$ | Modal growth rate (Re of complex eigenvalue) | 1/s |
| $P_{set}$ | Dome-regulator setpoint (mean manifold pressure) | Pa |
| $P_{feed}'$ | Manifold pressure perturbation downstream of regulator | Pa |
| $Z_{reg},Y_{reg}$ | Regulator dynamic impedance / admittance (in series with feed) | Pa·s/kg, kg/(s·Pa) |
| $\Delta P_{reg,\max}$ | Bounded regulator excursion — **forcing** amplitude (assumed; measure T6) | Pa |

> **Sign/through-variable convention.** All impedances use the **mass-flow perturbation** $\dot m'$ as
> the through-variable: $Z=\Delta P'/\dot m'$ [Pa·s/kg]. This keeps the chug algebra (§3.2) dimensionally
> consistent and matches what the solver outputs ($\dot m$). (Inertance in this convention is
> $\mathcal I=\ell/A_{line}$, not $\rho\ell/A$ — the $\rho$ only appears with a volume-flow through-variable.)

---

## 1. The governing principle: the Rayleigh criterion

All thermoacoustic instability is governed by **Rayleigh's criterion** (Rayleigh, *The Theory of
Sound*, Vol. 2, 1896 [1]): an oscillation gains energy over a cycle when unsteady heat release is
in phase with the pressure oscillation. In the integral form used in modern analyses (Culick [4]):

$$
\dot E_{mode} \;\propto\; \underbrace{\frac{\gamma-1}{\gamma P_c}\oint_T \!\!\int_{V_c} p'\,q'\,\mathrm dV\,\mathrm dt}_{\text{driving}} \;-\; \underbrace{\oint_T \!(\text{damping})\,\mathrm dt}_{\text{losses}} .
$$

A mode **grows** ($\alpha>0$) when driving exceeds damping. Every named instability below is a
special case distinguished by (i) *which* mode supplies $p'$ (a feed-system oscillation, a chamber
acoustic mode), and (ii) *how* the combustion produces a $q'$ that is correlated with that $p'$.

The practical consequence — and the central design lever — is **phase**: $q'$ lags the flow/pressure
perturbation by the conversion time of the propellant. That lag is the subject of §2 and §5.

---

## 2. The combustion response: Crocco's sensitive time lag ($n$–$\tau$)

Crocco & Cheng [2] model the pressure-sensitive part of combustion with two lumped parameters:

- a **sensitive time lag** $\tau$ — the portion of the total conversion time during which the
  burning rate is sensitive to chamber pressure, and
- an **interaction index** $n$ — how strongly the instantaneous burning rate responds to pressure.

The linearized burning-rate response is

$$
\frac{\dot m_b'(t)}{\bar{\dot m}_b} \;=\; n\left[\frac{p'(t)}{P_c} - \frac{p'(t-\tau)}{P_c}\right],
\tag{2.1}
$$

i.e. mass is converted at a rate that depends on the pressure difference across the lag interval.
Substituted into the chamber mass/energy balance (§3) or the acoustic energy balance (§4), (2.1)
produces a transcendental characteristic equation whose roots give the modal frequency and growth
rate. Instability is favored when $\omega\tau$ places $q'$ within ±90° of $p'$ — classically near
$\omega\tau \approx \pi$ (heat release leading pressure) for the dominant mode [2,3].

**Why this matters for us:** the current STAR code computes mode *frequencies* but contains no $n$–$\tau$
response, so it can never evaluate the Rayleigh integral and therefore cannot distinguish a stable
chamber from an unstable one on physical grounds. $n$ and $\tau$ are the missing ingredients.

**[UNCERTAINTY]** $n$ and $\tau$ are notoriously hard to predict a priori; historically they were
*extracted* from hot-fire data (variable-frequency / pulse testing) [3, NASA SP-194]. We will
*estimate* $\tau$ from first-principles vaporization physics (§5) and treat $n$ as an $O(1)$
calibration parameter with a defensible default and a documented range. This is the largest single
modeling uncertainty in the whole effort and is called out again in §5 and §7.

---

## 3. Low-frequency instability (chug): feed-system ↔ chamber coupling

### 3.1 Mechanism

Chug is **not** a chamber-acoustic phenomenon. It is a lumped-element oscillation of the feed/chamber
system (Wenzel & Szuch [6]; Harrje & Reardon, NASA SP-194, ch. 5 [3]). When $P_c$ rises, the injector
pressure drop $\Delta P_{inj}=P_{feed}-P_c$ falls, throttling the propellant; after the conversion
lag the reduced flow lowers $P_c$, $\Delta P_{inj}$ recovers, and the cycle repeats. Three elements
set the dynamics:

1. **Chamber capacitance** — the chamber stores combustion gas. Linearizing the chamber mass balance
   with a choked nozzle ($\dot m_{out}=P_c A_t/c^*$) gives a first-order relaxation whose time constant
   is the **gas residence (stay) time** $m_{gas}/\dot m_{out}$:

   $$
   \theta_c \;=\; \frac{m_{gas}}{\dot m_{out}} \;=\; \frac{V_c}{\Gamma^2\,c^*\,A_t} \;=\; \frac{L^*}{\Gamma^2\,c^*},
   \qquad \Gamma^2\approx0.4\ (\gamma{\approx}1.2)\ \Rightarrow\ \theta_c\approx2.4\,\frac{L^*}{c^*}.
   \tag{3.1}
   $$

   (Derivation: $m_{gas}=P_cV_c/R_gT_c$, $\dot m_{out}=P_cA_t/c^*$, and $R_gT_c=\Gamma^2 c^{*2}$.) Note
   $L^*/c^*$ — the quantity the current code computes — is the *scale* of $\theta_c$, but it is the
   chamber **time constant**, not "the chug frequency"; the present model has the right ingredient
   assembled wrongly (plan §A2). **[UNCERTAINTY]** a mass-only vs mass+energy linearization shifts the
   prefactor by an O(1) ($\sim\gamma$) factor — pinned in `chug.py` (the earlier "$1/\gamma$" was wrong;
   the residence-time form gives $1/\Gamma^2$).

2. **Feed inertance and resistance** — the liquid column between the (dome-regulated, hence nearly
   constant-pressure) manifold and the injector face has inertance $\mathcal I=\rho\,\ell/A_{line}$
   and resistance $\mathcal R$. These set how fast flow can respond to a $\Delta P_{inj}$ change.

3. **Injector stiffness** — from Bernoulli, $\dot m_{inj}=C_d A_{or}\sqrt{2\rho\,\Delta P_{inj}}$, so

   $$
   \left.\frac{\partial \dot m_{inj}}{\partial P_c}\right|_{P_{feed}} \;=\; -\frac{\dot m_{inj}}{2\,\Delta P_{inj}} \;=\; -\frac{\dot m_{inj}}{2\,\eta_{inj}P_c}.
   \tag{3.2}
   $$

   The sensitivity scales as $1/\eta_{inj}$: a **stiffer injector (larger $\eta_{inj}=\Delta P_{inj}/P_c$)
   decouples flow from chamber pressure and is the primary chug suppressant.** This is the physical
   reason designers target $\eta_{inj}\gtrsim 0.15$–$0.25$ (Sutton & Biblarz [8]; Huzel & Huang [9]),
   and why the user's 25–40% target is conservative-good.

### 3.2 Lumped linear model (impedance form)

Build the loop from three transfer functions, all using the **mass-flow** through-variable
(nomenclature convention):

1. **Chamber** (3.1): burned-flow → chamber pressure, $p_c' = Y_{ch}(s)\sum_k \dot m_{b,k}'$ with
   $Y_{ch}(s)=K_c/(\theta_c s+1)$, $K_c=c^*/A_t$.
2. **Conversion lag:** burned flow lags injected flow by the **total conversion/transport lag**,
   $\dot m_{b,k}'=e^{-s\tau_{conv,k}}\,\dot m_{inj,k}'$, with $\tau_{conv}\approx\tau_{vap}$ (§5). *This is
   the transport lag, distinct from the n–τ sensitive lag used for acoustic driving in §4 — do not
   substitute one for the other.*
3. **Feed + injector + regulator** (series impedance): a chamber-pressure rise reduces injected flow,
   $\dot m_{inj,k}' = -\,(p_c'-P_{feed,k}')/Z_{feed,k}(s)$ with
   $Z_{feed,k}=Z_{reg,k}+\mathcal I_k s+\mathcal R_k+1/G_{inj,k}$ and $G_{inj,k}=\dot m_k/(2\eta_{inj,k}P_c)$ (3.2).

Setting the **setpoint** perturbation to zero ($P_{set}'=0$; the regulator's finite stiffness stays
inside $Z_{feed}$ via $Z_{reg}$), the homogeneous loop gives the **chug characteristic equation**

$$
1 \;+\; \frac{K_c}{\theta_c s + 1}\sum_{k\in\{O,F\}}\frac{e^{-s\tau_{conv,k}}}{Z_{reg,k}(s)+\mathcal I_k s+\mathcal R_k+1/G_{inj,k}} \;=\; 0 .
\tag{3.3}
$$

The dominant complex root $s=\alpha+i\omega$ gives the chug frequency $f=\omega/2\pi$ and growth rate
$\alpha$; **stable if $\alpha<0$**, with dimensionless margin

$$
\zeta_{chug} \equiv -\frac{\alpha}{\omega}\quad(\text{loop damping ratio}),\qquad \text{stable if } \zeta_{chug}>0.
\tag{3.4}
$$

Equation (3.3) recovers the classical limits: large $\eta_{inj}$ ⇒ small $G_{inj}$ ⇒ large $1/G_{inj}$ ⇒
weak loop gain ⇒ $\alpha<0$ (stable); long inertance $\mathcal I$ or long lag $\tau_{conv}$ relative to
$\theta_c$ ⇒ phase approaches the Rayleigh-driving condition ⇒ $\alpha>0$.

**The regulator has TWO separate roles — keep them distinct (this was muddled in v0.1):**
- **Impedance $Z_{reg}(s)$** sits *inside* $Z_{feed}$ (3.3) and therefore **shifts the poles / $\alpha$**
  — it is part of the *homogeneous* stability problem. A *perfect* constant-pressure source is the
  $Z_{reg}\!\to\!0$ limit; a real dome reg has $Z_{reg}>0$ (at chug frequencies ≈ the passive dome-gas
  compliance, §6.1).
- **Bounded excursion $\Delta P_{reg,\max}$** is the *forcing* term $P_{feed}'$ — it does **not** move
  the poles; it sets how hard a disturbance can *drive* the loop (limit-cycle amplitude, and whether
  noise can trip a marginally stable mode). It enters the *forced response*, not (3.3).

So $P_{feed}'\neq0$ matters for *triggering/amplitude*, while $Z_{reg}$ matters for *the stability
boundary*. Both come from the same hardware (§6.1) but enter the math in different places.

**Fast (Layer-1) form.** The inner loop does not root-find (3.3); it evaluates a closed-form proxy: the
**injector-stiffness criterion** plus a lag/capacitance phase check (Wenzel & Szuch [6]; Crocco [2]) —
chug margin rises with $\eta_{inj}$ and with $\theta_c/\tau_{conv}$. Plan §A2 fixes the exact closed form
and constants, calibrated to reproduce the **sign of $\alpha$** from (3.3) on a sweep, so the fast tier
is a documented reduction of the rich root-find.

> **Feed inertance is NOT monotonic (verified numerically, M2).** Adding inertance both *reduces* loop
> gain (stabilizing) and *adds* phase lag (destabilizing); which wins is regime-dependent. For a stiff,
> nearly-incompressible line (our case, no large feed compliance) the **gain-reduction effect dominates,
> so more inertance is mildly stabilizing** and always *lowers the chug frequency*. Inertance only turns
> destabilizing when it resonates with a feed compliance near the combustion lag. The earlier blanket
> "margin falls with inertance" was an oversimplification; the robust monotonic facts are
> $\eta_{inj}\!\uparrow\Rightarrow$ stable, $\tau_{conv}\!\uparrow\Rightarrow$ unstable, inertance$\,\uparrow\Rightarrow f_{chug}\!\downarrow$.

**[UNCERTAINTY]** The lumped capacitance (3.1) assumes a spatially uniform, quasi-steady chamber
(standard for chug, wavelength ≫ chamber); the O(1) prefactor (mass vs mass+energy) is pinned by
matching (3.3) against a 1-D acoustic limit in `chug.py`.

---

## 4. High-frequency instability (acoustic / "screech")

### 4.1 Mode frequencies (longitudinal ~OK; transverse-root bug to fix)

For a cylindrical chamber the eigenfrequencies are (Harrje & Reardon [3]; Culick [4]):

- **Longitudinal** (injector ≈ closed, choked throat ≈ near-closed/admittance end). The code uses the
  open–closed quarter-wave set $f_{nL}=(2n-1)\,a/(4L_{ch})$. A choked nozzle is closer to a *pressure
  node with finite admittance* than an ideal open end; the half-wave set $f_{nL}=n\,a/(2L_{ch})$ is
  the other bound. **[UNCERTAINTY]** the true longitudinal eigenvalue lies between these and depends
  on the nozzle admittance (Crocco–Monti); we will carry the nozzle-admittance correction in the rich
  model and keep the quarter-wave estimate (current behavior) for the fast model.
- **Tangential / radial** (transverse): $f_{mT}=\alpha_{mn}\,a/(\pi D_{ch})$ with $\alpha_{mn}$ the
  roots of $J_m'$. The first tangential (1T) uses $\alpha_{10}=1.8412$. **The current code uses the
  pressure-Bessel roots $J_m$ (2.405, …) rather than the hard-wall velocity roots $J_m'$ (1.841, …);
  for a rigid wall the correct set is $J_m'$.** This is a real bug to fix (plan §A3). The 1T mode is
  the most destructive in liquid engines [3,5].

### 4.2 Driving and damping → growth rate

Frequencies alone say nothing about stability. Following Culick's modal energy balance [4] and the
$n$–$\tau$ response (2.1), each mode's growth rate is

$$
\alpha \;=\; \underbrace{\frac{(\gamma-1)}{2\,E_m}\,\bar q\, n\,\sin(\omega\tau_{sens})\,\Lambda_{q\psi}}_{\text{combustion driving}} \;-\; \underbrace{\big(\alpha_{noz}+\alpha_{visc}+\alpha_{inj}+\alpha_{2\phi}\big)}_{\text{damping}},
\tag{4.1}
$$

*(Schematic — exact coefficients per Culick [4].)* Here $\tau_{sens}=\chi\tau_{vap}$ is the **sensitive**
lag (§5, not the chug transport lag), $\Lambda_{q\psi}\!\propto\!\int_{flame}\!\psi\,\hat q\,\mathrm dV/E_m$
is the heat-release–mode-shape overlap, $E_m$ the modal energy, and the damping terms are nozzle radiation
(Bell–Zinn nozzle admittance), viscous/boundary losses, injector-face acoustic admittance, and
two-phase (droplet drag/evaporation) damping. The combustion term carries the $\sin(\omega\tau)$
phase factor from (2.1): the same $\tau$ from §5 sets whether a mode is driven or damped.

**[UNCERTAINTY]** Quantitative damping coefficients (especially two-phase and injector admittance)
are the weakest part of a-priori acoustic prediction. The rich model will report **per-mode growth
rate with an explicit damping budget** and a sensitivity band on $n$ and the damping terms, rather
than a single false-precision "stable/unstable" verdict.

---

## 5. The sensitive time lag for an impinging LOX/CH₄ spray

This is the bridge between the spray/atomization model (already in the code: Ingebo SMD) and
stability. For a **liquid bipropellant with both propellants injected as liquid jets**, the rate-
limiting step of the conversion time is almost always **droplet vaporization** (Priem & Heidmann,
NASA TR R-67 [7]; Heidmann & Wieber, NASA TN D-3749 [10]). The conversion chain is

$$
\tau_{tot} \;=\; \tau_{atomize} + \tau_{vap} + \tau_{mix} + \tau_{chem},
$$

with $\tau_{chem}\ll$ the others for LOX/CH₄ at chamber conditions, and $\tau_{atomize},\tau_{mix}$
small for a well-impinged doublet. Thus $\tau_{tot}\approx\tau_{vap}$.

### 5.1 Vaporization time from the $d^2$-law

Single-droplet quasi-steady evaporation obeys the **$d^2$-law** (Godsave [11]; Spalding [12]; review
in Faeth [13]):

$$
d^2(t) = d_0^2 - K_v\,t, \qquad
K_v = \frac{8\,k_g}{\rho_\ell\,c_{p,g}}\,\ln(1+B),
\tag{5.1}
$$

so the **lifetime of a droplet of initial diameter $d_0$** is

$$
\tau_{vap} = \frac{d_0^2}{K_v}.
\tag{5.2}
$$

Here $k_g$ and $c_{p,g}$ are gas-phase conductivity and specific heat in the film, $\rho_\ell$ the
liquid density, and $B$ the Spalding transfer number. For an evaporating (sub-burning) droplet $B$ is
the heat-transfer number $B_T=c_{p,g}(T_c-T_{boil})/h_{fg}$; with envelope combustion the mass-
transfer $B_M$ form is used [13].

### 5.2 Linking $d_0$ to the spray SMD (the code's Ingebo $D_{32}$)

We take the population-representative initial diameter as the **Sauter mean diameter** $D_{32}$
produced by the impinging-jet breakup model already in the code. That model is the Ingebo
impinging-jet correlation as implemented in `config_schemas.py`/`spray.py`:
$D_{32}=C\,d_{jet}\,(We_g\,Re_l)^{-1/4}$ with $C\approx3.9$–$5.0$ and $We_g$ formed from the
impingement relative velocity and chamber gas density [14]. Then

$$
\boxed{\;\tau_{vap} \;=\; \frac{D_{32}^2}{K_v}\;=\;\frac{\rho_\ell\,c_{p,g}\,D_{32}^2}{8\,k_g\,\ln(1+B)}\;}
\tag{5.3}
$$

and the **sensitive** time lag is taken as a pressure-responsive fraction of this:

$$
\tau \;\equiv\; \tau_{sens} \;=\; \chi\,\tau_{vap}, \qquad \chi \in (0,1].
\tag{5.4}
$$

> **Two lags, two uses — do not conflate (implementation-critical):**
> - **Conversion/transport lag** $\tau_{conv}\approx\tau_{vap}$ (the *full* vaporization time, 5.3, ~ms)
>   is the delay from injection to heat release. **This is the delay in the chug loop** (eq. 3.3,
>   $e^{-s\tau_{conv}}$), where $\omega_{chug}\tau_{conv}\sim O(1)$ at ~100 Hz.
> - **Sensitive lag** $\tau_{sens}=\chi\,\tau_{vap}$ (5.4) is the *pressure-responsive sub-interval* — the
>   $\tau$ in the n–τ response (2.1) that drives the **acoustic** modes (§4). It is **much shorter** than
>   $\tau_{vap}$: for kHz modes the driving phase $\omega\tau_{sens}\sim O(\pi)$ needs $\tau_{sens}\sim$
>   tens of µs to ~1 ms, i.e. $\chi_{acoustic}\sim0.05$–$0.3$, **not** the $\chi\approx0.5$ used as a
>   generic default. So the chug and acoustic lags can differ by an order of magnitude and **$\chi$ must
>   be set per-regime** (the acoustic $\chi$ / $\tau_{sens}$ is a primary calibration target — tests
>   H3/H5). Using $\tau_{conv}$ where $\tau_{sens}$ belongs (or vice-versa) is a real modeling error.

The $D_{32}^2$ scaling is the physically important result: **both lags ∝ SMD²**, so atomization quality
is a *quadratic* lever on the time lag and therefore on stability. This is the same $D_{32}$ that the
Cd/momentum-ratio work drives — confirming that the injector ($\eta_{inj}$, $\mathrm R\!\approx\!1$,
$D_{32}$) and the stability model share variables and must be solved consistently.

### 5.3 Pressure dependence (why $\tau$ couples to $p'$ at all)

$K_v$ depends weakly on pressure through $k_g$, $c_{p,g}$ and $B$, but the dominant pressure coupling
enters through the convective ("$1+0.3\,Re^{1/2}Pr^{1/3}$" Ranz–Marshall) enhancement of vaporization
and through $D_{32}(P_c)$ from the atomization model. The interaction index $n$ in (2.1) encodes the
net $\partial(\text{burn rate})/\partial(\ln P_c)$. We will compute $\tau$ from (5.3)–(5.4) and treat
$n=O(1)$ as a calibrated constant (default $n\approx0.3$–0.6, range documented) [3].

**[UNCERTAINTY — largest in this document]**
1. $\chi$ (the sensitive fraction, 5.4) is not first-principles; Crocco-type analyses put the
   sensitive interval at a fraction of the total lag, but the value is propellant/injector specific.
   Default $\chi\approx0.5$, swept in the rich model.
2. Using a single $D_{32}$ ignores the droplet *size distribution*; vaporization of the large-tail
   droplets actually controls the longest lags. A distribution-weighted $\tau$ is a future refinement.
3. $B$ for LOX (cryogenic, high-$T_c$ environment, possible supercritical behavior above the LOX
   critical pressure $P_{crit,O_2}\approx5.04$ MPa) is genuinely uncertain near our $P_c\sim2$–4 MPa;
   close to / above critical the $d^2$-law degrades and a different model is needed [13]. At
   $P_c\approx2.4$ MPa we are sub-critical for O₂, so (5.1) is defensible but should be flagged.
4. Methane: $\rho_\ell$, $h_{fg}$, $T_{boil}$ are well known, but spray data for LOX/CH₄ impinging
   doublets is comparatively sparse vs LOX/RP-1 and LOX/H₂; quantitative $n$,$\tau$ validation data
   is limited (see §7).

---

## 6. Pressure-fed, dome-regulated specifics

### 6.1 The regulator is a *finite-stiffness* boundary, not a perfect source

A dome-loaded regulator holds the regulated manifold pressure near a setpoint, but it is **not** an
ideal constant-pressure source — it has finite dynamic stiffness, a static **droop** (setpoint shifts
with flow), and a finite response bandwidth. So $P_{feed}'\neq 0$. The correct boundary condition for
(3.3) is a regulator with admittance $Y_{reg}(\omega)$ relating manifold pressure perturbation to the
downstream flow perturbation it sees:

$$
P_{feed}'(\omega) \;=\; -\,Z_{reg}(\omega)\,\dot m_{inj}'(\omega), \qquad
|P_{feed}'| \le \Delta P_{reg,\max},
\tag{6.1}
$$

where $Z_{reg}=1/Y_{reg}$ is the regulator's dynamic impedance and $\Delta P_{reg,\max}$ is the peak
excursion the dome allows under downstream disturbance. **What is actually published for this unit**
(Aqua Environment Model 1092 datasheet [16]) vs. what we must *assume or measure*:

| Quantity | Value | Status |
|---|---|---|
| Supply-pressure effect (static droop vs **inlet** drop) | **~10 psi outlet rise / 1000 psi inlet drop** [16] | **published** (one reseller listing states 17; datasheet says 10 — use 10, flag spread) |
| Flow coefficient | $C_v=0.8$ (0.23″ orifice) [16] | **published** |
| Spring bias | up to 300 psi above dome (we run **50 psi** bias) | **published / our setting** |
| Droop **with flow** (outlet shift vs flow demand) | — | **NOT published → measure** (test T6) |
| **Dynamic** stiffness $Z_{reg}(\omega)$ / excursion at chug frequencies | — | **NOT published → measure** (test T6) |

**Corrected interpretation (this supersedes the earlier "±14 psi" claim).** The only specified droop is
*quasi-static*: as the dome supply (COPV) blows down over the burn, the regulated outlet **drifts up**
by $\approx0.010\times\Delta P_{inlet}$. Over an inlet blowdown of ~1000–1400 psi that is a **slow ~10–14
psi rise across the whole burn**, *not* a chug-frequency ripple. The earlier "$\pm14$ psi" was a
plausible magnitude but mis-cast as a symmetric dynamic fluctuation; the **dynamic** excursion that
couples to chug is genuinely unmeasured. We therefore split the regulator perturbation into:

$$
P_{feed}(t) = P_{set} + \underbrace{\delta P_{drift}(t)}_{\text{slow, }\approx+10\text{ psi}/1000\text{ psi inlet drop [16]}} + \underbrace{\delta P_{dyn}(t)}_{\text{dynamic, }|\delta P_{dyn}|\le \Delta P_{reg,\max}\ \textbf{[ASSUMED, measure T6]}} .
\tag{6.1b}
$$

**Why the dynamic part still matters even if small.** A manifold wobble $\delta P_{dyn}$ is referenced
not to $P_c$ but to the *injector drop* $\Delta P_{inj}=\eta_{inj}P_c\approx0.25$–$0.40\,P_c$. Since
injector flow $\propto\sqrt{\Delta P_{inj}}$, a fractional wobble $\delta P_{dyn}/\Delta P_{inj}$
modulates injected flow by half that fraction. Even a modest $\pm10$ psi on a $\sim150$–$230$ psi drop
is a $\sim2$–$3\%$ flow modulation — enough to seed/sustain a chug loop. This is why $P_{feed}'=0$ is
too optimistic, and why we must *bound* $\Delta P_{reg,\max}$ by test rather than guess it.
**[UNCERTAINTY]** $\Delta P_{reg,\max}$ and $Z_{reg}(\omega)$ are currently assumed; test T6 retires them.

- **Frequency dependence.** Dome regulators correct slowly (response typically ≲ a few–tens of Hz). At
  the chug frequency the regulator usually *cannot* keep up, so its **impedance $Z_{reg}$** tends to the
  passive **dome-gas compliance** (a gas spring) rather than an active controller — this is the $Z_{reg}$
  that enters $Z_{feed}$ in (3.3) and shifts $\alpha$. Separately, its **forcing bound**
  $\Delta P_{reg,\max}$ saturates the manifold excursion (§3.2 two-roles).
  **[UNCERTAINTY]** neither $Z_{reg}(\omega)$ nor $\Delta P_{reg,\max}$ is measured for this unit; the
  model defaults the dome compliance from the dome volume + a corner frequency (a few Hz) and uses an
  assumed excursion bound (the "±14 psi" placeholder), reporting sensitivity to both. **Test T6 (§9.1)
  measures them.**
- **Compliance source.** With a stiff regulated liquid feed and no turbopump, the dominant compliance
  is the chamber gas (3.1), the **dome volume** itself (gas spring behind the regulator), plus any
  *trapped ullage/cavitation/manifold gas* — the latter a strong chug driver if present. Manifold
  volume is outside the solver (a downstream design choice), so it is exposed as an *input knob* with a
  "would-dominate" warning.

### 6.2 Tank/manifold pressure vs. time: dome-reg ≠ blowdown

The current STAR time model (`layer2_pressure.py`) represents $P_{tank}(t)$ as **blowdown/linear
segments that decay** over the burn. That is correct for an *unregulated blowdown* system, but **not**
for this dome-regulated engine, where the regulator holds the setpoint and $P_{tank}(t)$ should be
**~constant at the regulated value with a bounded ripple**:

$$
P_{tank}(t) \;=\; P_{set} \;+\; \underbrace{0.010\,\big(P_{in,0}-P_{in}(t)\big)}_{\text{supply-pressure drift, rises as COPV blows down [16]}} \;+\; \delta P_{dyn}(t),
\qquad |\delta P_{dyn}|\le\Delta P_{reg,\max}\ \textbf{[measure T6]},
\tag{6.2}
$$

i.e. a **near-constant setpoint with a slow ~10 psi/1000-psi-inlet upward drift**, plus a bounded
dynamic ripple — *not* the monotonic decaying blowdown the code currently assumes. A genuine drop only
occurs at end-of-burn if the **COPV supply falls below the regulator's dropout/lockup** (it can no
longer maintain setpoint). The forward-mode and time-varying solvers must use (6.2), not the blowdown
decay, for this engine (plan §B). This is the modeling gap the user flagged.

No turbopump ⇒ **no POGO in the pump sense**; the feed-coupled low-frequency mode is pure chug.
Water-hammer (Joukowsky $\Delta P=\rho a_\ell \Delta u$ [15]) remains relevant as a *valve-transient*
check but is **not** a combustion-stability metric and will be reported separately, not folded into
the combustion margin (correcting the current code's conflation).

---

## 7. Methalox-specific notes and open uncertainties

- **Faster chemistry, vaporization-limited.** CH₄ chemical times are short; both propellants are
  liquid-injected, so §5's vaporization-limited $\tau$ applies. Relative to LOX/H₂ (gaseous H₂, very
  different response) our case is closer to LOX/RP-1 phenomenology but with a more volatile fuel.
- **LOX near-critical behavior.** At higher $P_c$ the LOX droplet model weakens (§5.3 item 3).
- **Literature gap.** Classical $n$–$\tau$ databases (NASA SP-194 [3]) are dominated by LOX/RP-1,
  N₂O₄/UDMH, and LOX/H₂. Quantitative LOX/CH₄ instability parameters are sparser and largely from
  recent (2000s–2010s) development programs; we should treat any single literature $n$,$\tau$ for
  methalox as indicative, not authoritative, and lean on the physics-based $\tau$ (5.3) plus a
  documented sensitivity sweep.
- **Doublet element response.** Unlike-doublet elements have a known sensitivity of mixing/atomization
  to the momentum ratio $\mathrm R$; near $\mathrm R\approx1$ the spray fan is roughly axial and
  mixing is good, which both improves performance and tends to shorten/steady $\tau$. A
  doublet-specific response correlation (Reardon-type) is a candidate refinement but is **[UNCERTAINTY]**
  and not in the first build.

---

## 8. What we will and won't claim

- **Will:** physically-grounded chug growth rate from a lumped feed↔chamber↔combustion model (§3);
  per-mode acoustic growth rate with an explicit, itemized damping budget and $n$–$\tau$ driving (§4);
  a vaporization-based $\tau\propto D_{32}^2$ tied to the existing spray model (§5); honest
  sensitivity bands.
- **Won't:** claim absolute stability prediction. A-priori $n$, $\tau$, and acoustic damping carry
  large uncertainty; the deliverable is **calibrated design guidance with margins and sensitivities**,
  re-validatable against hot-fire data, not a substitute for it.

---

## 9. Retiring the uncertainties — a collegiate ground & hot-fire test campaign

Every **[UNCERTAINTY]/[ASSUMED]** value above can be replaced with a measured number using equipment a
college team can realistically obtain. The model is built so each test feeds a specific coefficient, so
the stability prediction improves *monotonically* as tests are completed — you don't need all of them to
start, and each one tightens a named input. Run roughly cheap→hard.

### 9.1 Ground tests (cold flow — no combustion)

| Test | What you do | Equipment | You compute | Retires (model input) |
|---|---|---|---|---|
| **T1 — Injector Cd (per stream)** | Flow **water** through the real injector (or one doublet coupon) to atmosphere; record ΔP and flow | Diff-pressure transducer manifold→ambient; **Coriolis/turbine flow meter** *or* timed catch-and-weigh | $C_d=\dot m/\big(A_{or}\sqrt{2\rho\,\Delta P}\big)$ per stream | $C_{d,O},C_{d,F}$ — **directly tests the $C_d{=}0.6$ assumption** from the optimizer work; validates `discharge.py`. Eq.(3.2) |
| **T2 — Feed resistance & losses** | Vary flow; record ΔP from tank tap → injector inlet across line+valves | Two pressure taps + flow meter | Feed resistance $\mathcal R$, loss coeffs $K_0,K_1$ | Feed model (`feed_loss.py`), $\mathcal R,\mathcal I$ in chug eq. §3.2 |
| **T3 — Spray pattern / R check** | Flow both streams together at scaled momentum ratio; image the impinging fans | High-speed or backlit camera; optional mechanical **patternator** | Impingement point, fan tilt/asymmetry, cone angle; confirm **R≈1 ⇒ axial fan** | Validates the $\mathrm R{\approx}1$ target & jet-alignment physics §7 |
| **T4 — Droplet size (SMD)** | Cold flow; size droplets vs velocity/ΔP | **Laser diffraction (Malvern Spraytec — often borrowable)**, high-speed shadowgraphy, or PDPA if accessible | $D_{32}(\Delta P)$ → calibrate **Ingebo prefactor $C$** | $C$ in $D_{32}$, hence $\tau\propto D_{32}^2$ — the **biggest $\tau$ input** §5.2. *No sizer?* breakup length+cone is a partial constraint |
| **T5 — Feed dynamics (water-hammer)** | Flow line at known $u$, snap a downstream valve shut; capture spike + ring | **Fast pressure transducer (≥10 kHz)** + fast DAQ | Joukowsky $\Delta P=\rho a\,\Delta u\Rightarrow a$; $K_{eff}=\rho a^2$; ring freq → line length | Hardcoded bulk modulus (1.5e9), feed inertance/compliance, POGO/surge freq §3.1,§6 |
| **T6 — Regulator characterization** ⭐ | **Static:** flow GN₂/water at several rates, record outlet vs flow & vs inlet. **Dynamic:** chop a downstream bleed (solenoid/pulse orifice), record manifold pressure | Flow meter + **fast** manifold transducer; pulsing solenoid/orifice | Static droop (verify 10 psi/1000 psi [16]); **dynamic excursion $\Delta P_{reg,\max}$**, corner freq, $Z_{reg}(\omega)$ | **The $\pm14$ psi assumption** & $Z_{reg}$ in (6.1)/(6.1b) — the one test that answers "is ±14 psi real?" |
| **T7 — Cold acoustic modal ping** *(optional)* | Excite assembled (unfired) chamber with speaker/impulse; record response | Speaker/impulse + microphone or pressure sensor | Measured 1L/1T freqs + cold ring-down (damping) | Validates the **Bessel-root fix** & mode freqs §4.1; baseline damping (scale by $\sqrt{T_{hot}/T_{cold}}$) |

**Honest caveats:** water vs cryogenic Cd differ slightly — match **Reynolds number** in T1, or flow LN₂
on the LOX side if you can. SMD sizing (T4) is the hardest to instrument; partial data still constrains
$C$. T6's *dynamic* part is the novel, highest-value cold-flow measurement — it's what makes the chug
model honest.

### 9.2 Hot-fire tests (rare — instrument heavily; every fire is a data point)

| Want | Measure | Figure out |
|---|---|---|
| **H1 — Combustion oscillation spectrum** | Flush/recess-mounted **high-frequency $P_c$ transducer (≥10–20 kHz, PCB/Kistler)** → FFT | Which modes are live (chug, 1L, 1T) and their amplitudes ⇒ stable/marginal/unstable |
| **H2 — Feed-coupled dynamics** | Fast transducer on **each manifold** | Real dynamic $\Delta P_{inj}$; in-fire regulator excursion (validates T6); confirms chug is feed-coupled |
| **H3 — Pulse / bomb test** *(if possible)* | Fire a calibrated pressure pulse (pulse gun / small pyro), watch the response | **Decay/growth rate $\alpha$** ⇒ direct damping margin & $n,\tau$ behavior — the classic stability measurement |
| **H4 — c\* efficiency** | $P_c,\dot m_O,\dot m_F,A_t$ | $\eta_{c^*}=c^*_{actual}/c^*_{ideal}$ ⇒ vaporization completeness ⇒ realism of $\tau$ §5 |
| **H5 — Boundary mapping** | Vary $P_c$/MR slightly across fires | Where roughness/instability onsets ⇒ bounds on $n,\tau$; validates the stability map |

The highest-value hot-fire datum is **H3**: a pulse that decays gives a measured $\alpha$ — the one
number the whole growth-rate model is trying to predict. Even a qualitative "recovered vs diverged"
calibrates the gate threshold (plan §5).

---

## References

[1] Rayleigh, J.W.S. *The Theory of Sound*, Vol. 2, 2nd ed., Macmillan, 1896 (Rayleigh criterion).
[2] Crocco, L., and Cheng, S.-I. *Theory of Combustion Instability in Liquid Propellant Rocket Motors*, AGARDograph No. 8, Butterworths, 1956.
[3] Harrje, D.T., and Reardon, F.H. (eds.). *Liquid Propellant Rocket Combustion Instability*, NASA SP-194, 1972.
[4] Culick, F.E.C. *Unsteady Motions in Combustion Chambers for Propulsion Systems*, RTO AGARDograph RTO-AG-AVT-039, 2006.
[5] Yang, V., and Anderson, W.E. (eds.). *Liquid Rocket Engine Combustion Instability*, Progress in Astronautics and Aeronautics, Vol. 169, AIAA, 1995.
[6] Wenzel, L.M., and Szuch, J.R. *Analysis of Chugging in Liquid-Bipropellant Rocket Engines Using Propellant Feed-System Dynamics*, NASA TN D-3080, 1965.
[7] Priem, R.J., and Heidmann, M.F. *Propellant Vaporization as a Design Criterion for Rocket-Engine Combustion Chambers*, NASA TR R-67, 1960.
[8] Sutton, G.P., and Biblarz, O. *Rocket Propulsion Elements*, 9th ed., Wiley, 2017 (injector stiffness guidance).
[9] Huzel, D.K., and Huang, D.H. *Modern Engineering for Design of Liquid-Propellant Rocket Engines*, AIAA, 1992.
[10] Heidmann, M.F., and Wieber, P.R. *Analysis of Frequency Response Characteristics of Propellant Vaporization*, NASA TN D-3749, 1966.
[11] Godsave, G.A.E. "Studies of the combustion of drops in a fuel spray—the burning of single drops of fuel," *4th Symposium (Int.) on Combustion*, 1953, pp. 818–830.
[12] Spalding, D.B. "The combustion of liquid fuels," *4th Symposium (Int.) on Combustion*, 1953, pp. 847–864.
[13] Faeth, G.M. "Current status of droplet and liquid combustion," *Progress in Energy and Combustion Science*, Vol. 3, 1977, pp. 191–224.
[14] Ingebo, R.D. Drop-size correlations for atomizing liquid jets in airstreams, NASA technical reports (e.g., the $D_{32}\propto d\,(We\,Re)^{-1/4}$ family). The STAR code implements $D_{32}=C\,d_{jet}\,(We_g Re_l)^{-1/4}$, $C\approx3.9$–$5.0$ (`config_schemas.py` `SMDConfig`, `model: ingebo`). The exact NASA TN backing the prefactor should be pinned during M1.
[15] Joukowsky, N. "Über den hydraulischen Stoss in Wasserleitungsrohren," 1900 (water-hammer $\Delta P=\rho a\,\Delta u$).
[16] Aqua Environment Co., Inc. *Model 1092 High-Flow Dome-Loaded Reducing Regulator* (0–6000 psi, non-vented), product datasheet/listing. Published specs used here: supply-pressure effect **~10 psi outlet rise / 1000 psi inlet drop**, $C_v=0.8$ (0.23 in orifice), spring bias optional up to 300 psi above dome. `aquaenvironmentinc.com` / `valvesandregulators.aquaenvironment.com` (item 1783). *Droop-with-flow and dynamic stiffness are not published — see §9.1 T6.* (One reseller listing quotes 17 psi/1000 psi; the manufacturer item datasheet quotes 10 — spread flagged.)

> **Citation honesty note:** references [1]–[13],[15] are standard, verifiable works used for the
> specific results attributed. [14] (Ingebo) is cited as the correlation family the code implements;
> pin the exact NASA TN during M1. [16] is the regulator vendor datasheet — the published numbers
> (supply-pressure effect, $C_v$) are verified; the **dynamic** ±-excursion the chug model needs is
> *not* a published spec and is explicitly an assumption to be retired by test T6, not a vendor figure.
