# High-Fidelity Combustion Stability Analysis of Liquid Rocket Engines via Thermoacoustic Global Modes and Krylov Eigensolvers: Formulation and Preliminary Implementation Plan

**EngineDesign Combustion Stability Suite — Design Document / Preliminary Paper (v0.1)**

*Prepared July 2026. Status: formulation and implementation plan; no computational results yet. This document specifies the "rich acoustic model" (plan §A3) anticipated by `docs/stability/combustion_stability_physics.md` [35] and by the lumped-model implementation in `engine/pipeline/stability/` (`core.py`, `chug.py`, `acoustic.py`): it computes from first principles the quantities that model must assume — mode frequencies in the true geometry, mode-shape/heat-release overlap, and the acoustic damping budget.*

---

## Abstract

Combustion instability — the resonant coupling of unsteady heat release with the acoustic modes of a combustion chamber — remains the highest-consequence failure mode in liquid rocket engine development. The EngineDesign suite currently carries a documented lumped-parameter stability model [35]: Crocco $n$–$\tau$ modal driving with vaporization-derived time lags, an itemized acoustic damping budget, and an impedance-form chug characteristic equation. That model is physically sound but structurally zero-dimensional: mode frequencies come from uniform-cylinder closed forms, the mode-shape/heat-release overlap is a per-mode assumed scalar, and the damping coefficients are flagged first-cut fractions. This document develops the spatially-resolved tier that computes those assumed quantities from first principles. We formulate combustion stability as a **global linear stability problem**: the compressible reacting flow equations are linearized about a computed mean flow, a modal ansatz $q'(\mathbf{x},t) = \hat{q}(\mathbf{x})\,e^{\lambda t}$ reduces the dynamics to an eigenvalue problem, and the complex eigenvalue $\lambda = \sigma + i\omega$ delivers the growth rate ($\sigma > 0 \Rightarrow$ unstable) and frequency of every relevant chamber mode. Rather than attack the full linearized Navier–Stokes operator at once, we exploit the low-Mach character of the chamber to reduce the perturbation dynamics to an **inhomogeneous thermoacoustic Helmholtz equation** with an active flame closure, discretized by finite elements on the true chamber geometry. Because the mean flow of an axisymmetric thrust chamber is (to engineering accuracy) axisymmetric, the eigenmodes separate as $\hat{p}(x,r,\theta) = \tilde{p}(x,r)\,e^{im\theta}$, converting one intractable 3-D eigenproblem into a family of small 2-D problems indexed by azimuthal wavenumber $m$ — giving longitudinal ($m=0$), tangential ($m=1,2,\dots$), and radial mode families at two-dimensional cost. Flame–acoustic coupling through time-delayed response models and frequency-dependent boundary impedances renders the eigenproblem **nonlinear in $\lambda$**; we present a solver hierarchy (frozen-delay fixed point, bordered Newton, Beyn contour integration, SLEPc NLEIGS) built around a shift-invert Krylov–Schur kernel. Mean flows are produced by a two-stage pipeline: a parametric generator (CEA/Cantera equilibrium chemistry + vaporization-limited heat-release correlations, with injector-specific flame-shape models for unlike-impinging doublets and pintles, and propellant support for LOX/CH₄, LOX/ethanol, and LOX/RP-1) that warm-starts an axisymmetric SU2 RANS solve. Because the flame response parameters are the dominant epistemic uncertainty, the deliverable of an analysis campaign is not a single eigenvalue but a **stability map**: growth-rate contours over the flame-parameter envelope for each mode family, with margins defined as distance-to-neutral-curve. A verification ladder (analytic cylinder modes, temperature-jump ducts, Rijke tube benchmarks, cross-code comparison, time-domain growth-rate extraction) and a validation plan against the Purdue CVRC and DLR BKD experiments are specified. The framework is designed as a post-design verification tool: one campaign per candidate design, roughly one hour end-to-end on a workstation, with no fidelity compromise driven by optimizer-loop cost.

---

## I. Nomenclature

| Symbol | Meaning |
|---|---|
| $\mathbf{w}$ | flow state vector (conservative or primitive variables) |
| $\bar{q},\ \bar{\rho},\ \bar{p},\ \bar{T},\ \bar{\mathbf{u}}$ | mean (base) state: generic, density, pressure, temperature, velocity |
| $q'(\mathbf{x},t)$ | infinitesimal perturbation about the mean state |
| $\hat{q}(\mathbf{x})$ | complex mode shape (spatial eigenfunction) |
| $\lambda = \sigma + i\omega$ | complex eigenvalue; $\sigma$ growth rate [1/s], $\omega$ angular frequency [rad/s] |
| $f = \omega/2\pi$ | mode frequency [Hz] |
| $\mathbf{r}(\mathbf{w};\mathbf{x}_d)$ | bottom-level (mean flow) residual; $\mathbf{x}_d$ design variables |
| $J$ | Jacobian of the discretized residual, $\partial \mathbf{r}/\partial \mathbf{w}\big|_{\bar{\mathbf{w}}}$ |
| $B,\ M$ | mass matrix of the discretization |
| $c(\mathbf{x})$ | local sound speed, $\sqrt{\gamma R T}$ |
| $\gamma,\ R$ | ratio of specific heats, specific gas constant |
| $\dot{q}',\ \hat{\dot{q}}$ | heat-release-rate perturbation and its mode shape [W/m³] |
| $\bar{\dot{q}}(\mathbf{x})$ | mean volumetric heat release [W/m³] |
| $n,\ \tau$ | flame interaction index and time lag (Crocco $n$–$\tau$ model) |
| $z(\lambda)$ | specific acoustic impedance, $\hat{p}/(\bar{\rho}\bar{c}\,\hat{\mathbf{u}}\cdot\mathbf{n})$ |
| $y = 1/z$ | specific admittance |
| $m$ | azimuthal wavenumber; modes vary as $e^{im\theta}$ |
| $\tilde{p}(x,r)$ | meridional (2-D) pressure mode shape |
| $K,\ K_m,\ C,\ M_2,\ F$ | FEM stiffness, azimuthal, boundary-damping, mass, and flame matrices |
| $N(\lambda)$ | nonlinear eigenvalue operator, $N(\lambda)\tilde{p} = 0$ |
| $L^*$ | characteristic chamber length, $V_c/A_t$ |
| $P_c,\ \mathrm{MR}$ | chamber pressure, oxidizer-to-fuel mixture ratio |
| $\psi(x)$ | burned (energy-released) fraction profile along the chamber axis |
| $L_v$ | vaporization/consumption length |
| $d_{32}$ | Sauter mean droplet diameter |
| $E_m$ | Rupe mixing-uniformity factor |
| $\mathcal{Z}$ | mixture fraction (flamelet coordinate) |
| $\Sigma$ | flame-parameter envelope in $(n,\tau)$ space |

Acronyms: LRE (liquid rocket engine), LNSE (linearized Navier–Stokes equations), LEE (linearized Euler equations), NLEVP (nonlinear eigenvalue problem), GEVP (generalized eigenvalue problem), FTF/FDF (flame transfer/describing function), FEM (finite element method), RANS (Reynolds-averaged Navier–Stokes), FGM (flamelet-generated manifold), IRAM (implicitly restarted Arnoldi method), CVRC (Continuously Variable Resonance Combustor), MOC (method of characteristics).

Convention: perturbations evolve as $e^{\lambda t}$ with $\lambda = \sigma + i\omega$. Literature using $e^{-i\omega_c t}$ with complex $\omega_c$ maps as $\omega_c = i\lambda$, i.e., $\mathrm{Im}(\omega_c) = \sigma$. All eigenvalues are reported dimensionally ([1/s], [Hz]) and nondimensionally ($\lambda^* = \lambda L_{\mathrm{ref}}/c_{\mathrm{ref}}$); see Appendix D.

---

## II. Introduction

### A. Motivation and the current state of the suite

High-frequency combustion instability has destroyed more liquid rocket engine development programs than any other single phenomenon; the F-1 program required over 2,000 full-scale tests to stabilize the injector against the first tangential (1T) mode [1, 2]. The mechanism is classical: unsteady heat release $\dot{q}'$ adds energy to an acoustic field wherever it is positively correlated with the pressure fluctuation — Rayleigh's criterion,

$$
\frac{dE_{ac}}{dt} \;\propto\; \int_V \overline{p'(\mathbf{x},t)\,\dot{q}'(\mathbf{x},t)}\; dV \;-\; \text{(boundary and volumetric losses)},
$$

and instability results when the flame-driven gain of any chamber mode exceeds its damping. Prediction therefore requires three ingredients simultaneously: (i) the chamber's acoustic eigenstructure in its true geometry with its true (nonuniform) sound-speed field, (ii) a model for how the combustion process responds to acoustic fluctuations, and (iii) the damping supplied by the nozzle, injector face, and walls.

The stability module currently shipped in EngineDesign (`engine/pipeline/stability/`: `core.py`, `chug.py`, `acoustic.py`) supplies all three ingredients in **lumped** form, with its assumptions documented in the companion physics reference [35]: (i) acoustic frequencies from uniform-property cylinder closed forms (quarter-wave longitudinal set; hard-wall $J'_m$ transverse eigenvalues); (ii) combustion response via the Crocco $n$–$\tau$ gain with the sensitive lag $\tau_{sens} = \chi\,\tau_{vap}$ built from the spray SMD through the Spalding $d^2$-law; (iii) damping as an itemized first-cut budget (nozzle, viscous, injector, two-phase). Per-mode growth is then $\alpha = \alpha_{drive} - \alpha_{damp}$ with $\alpha_{drive} = \tfrac{\omega}{2}(\gamma{-}1)\,\Lambda\, n \sin(\omega\tau_{sens})$, where $\Lambda$ is a mode-shape/heat-release **overlap factor taken from a documented lookup table** (`DEFAULT_OVERLAP`), and the chug loop is closed properly through an impedance-form characteristic equation solved by Nyquist margin and complex root-find.

This is a defensible level-1/level-2 design-guidance model (Section II.B taxonomy), and its own documentation identifies precisely what it cannot do [35, §4.2, §8]: the overlap factors $\Lambda$, the damping fractions, and the uniform-cylinder frequencies are *assumed inputs*, uncertain to factors of several, and no spatial mode information exists at all — no mode shapes, no Rayleigh-integrand localization, no geometry or temperature-stratification effects, no impedance boundary conditions. The present document specifies the planned rich tier (plan §A3 of [35]) that replaces exactly those assumptions with computed quantities: eigenfrequencies and mode shapes on the true chamber contour with the true sound-speed field, the overlap emerging as the computed flame-matrix/eigenfunction inner product rather than a table entry, and the damping budget emerging as boundary-flux integrals under physical impedance conditions. The lumped chug model is *retained* as the authoritative feed-coupling analysis (its lags and primitives also seed this framework's flame-parameter envelope, Section VI), and the lumped acoustic tier remains the in-loop screen.

### B. Approaches to instability prediction

Four families of methods exist, in increasing fidelity and cost:

1. **Empirical margins and similarity rules**: frequency spacing checks, $L^*$ ranges, injector $\Delta p/P_c$ rules of thumb [1]. Cheap, but they cannot distinguish a stable design from a marginally unstable one, and carry no mode-shape or growth-rate information — precisely the criticism leveled at empirical buffet-onset criteria by Kanchi et al. [3], whose linear-stability formulation for transonic buffet this document deliberately parallels.
2. **Low-order lumped and network (two-port) models** (the current module's class): the chamber, injector, and feed system are represented as lumped elements or transfer matrices; the suite's chug characteristic equation [35, §3.2] is of this family, as are OSCILOS [4] and taX [5]. Excellent for chug and useful for longitudinal modes; for transverse modes in a real chamber they must *assume* the mode structure (the overlap-factor table of [35, §4.2]) rather than compute it.
3. **Inhomogeneous Helmholtz / linearized Euler eigenproblems on the true geometry** with an active-flame closure: the approach of AVSP at CERFACS [6], subsequent FEM implementations [7, 8], and LEE extensions applied to rocket combustors by Schulze and Sattelmayer [9]. This resolves 3-D mode structure in the real geometry with nonuniform properties, distributed flame response, and impedance boundary conditions, at a cost measured in minutes.
4. **Full linearized Navier–Stokes global modes** about a RANS/LES mean flow [10, 11], and ultimately nonlinear LES of the instability itself [12]. Research-grade; mean-flow generation dominates the cost.

The framework specified here enters at level 3, with the interfaces designed so that level-4 operators (LEE, then LNSE) can replace the Helmholtz operator without changing the eigensolver machinery, the mean-flow pipeline, or the campaign/reporting layer. This mirrors the two-level structure of [3]: a *bottom-level* nonlinear problem defines the mean state; a *top-level* eigenvalue problem, whose operator is the Jacobian of the bottom level (or a physics-reduced surrogate of it), defines stability.

### C. Scope, requirements, and contributions

Requirements established for the tool:

- **R1 — Post-design verification, not in-loop screening.** One analysis campaign per candidate design; wall-clock budget ~1 hour on a workstation; fidelity is not to be compromised for speed.
- **R2 — Propellant coverage:** LOX/CH₄ (primary), LOX/ethanol, LOX/RP-1, through a chemistry interface (CEA/Cantera) that is propellant-agnostic.
- **R3 — Injector coverage:** unlike-impinging doublets (primary) and pintles, entering the formulation only through the mean heat-release distribution and the flame-response parameterization.
- **R4 — Mode coverage:** longitudinal, tangential (standing and spinning), radial, and mixed modes up to at least the 3T/2L family; feed-coupled (chug) modes retained by the existing low-frequency module and, later, by network-element boundary conditions.
- **R5 — Honest uncertainty treatment:** flame-response parameters are swept over an envelope; the deliverable is a stability map with margins, not a point verdict.
- **R6 — Non-invasive integration:** delivered as a new package (`engine/stability_hifi/`), leaving the existing module untouched.

The contributions of this document: (i) a complete mathematical formulation from the reacting LNSE down to the discrete NLEVP, with every reduction and its validity conditions stated; (ii) an azimuthal-decomposition formulation that obtains 3-D transverse-mode fidelity at 2-D cost; (iii) a solver hierarchy for the NLEVP with algorithms specified to pseudocode; (iv) a two-stage mean-flow pipeline (parametric generator → warm-started SU2 axisymmetric RANS) covering R2/R3; (v) a verification ladder and validation plan with acceptance criteria; (vi) cost estimates and a tiered roadmap to LEE, FDF/limit-cycle, resolvent, and adjoint-sensitivity extensions.

---

## III. Linear stability formulation

### A. Bottom level: the mean flow problem

Following the notation of [3], the semi-discretized compressible reacting flow equations are

$$
B\,\frac{\partial \mathbf{w}}{\partial t} + \mathbf{r}(\mathbf{w};\mathbf{x}_d) = 0,
$$

where $\mathbf{w} \in \mathbb{R}^{N}$ collects density, momentum, energy, and species (or progress-variable) unknowns, $B$ is the mass matrix of the discretization, and $\mathbf{x}_d$ are design parameters (geometry, $P_c$, MR, injector pattern). The **mean flow** $\bar{\mathbf{w}}$ is an equilibrium of the *modeled* (Reynolds-averaged) system:

$$
\mathbf{r}(\bar{\mathbf{w}};\mathbf{x}_d) = 0. \tag{1}
$$

Two remarks specific to rocket chambers. First, no steady laminar solution exists; Eq. (1) is meaningful only for the RANS-closed system, and the linearization below inherits the closure (we adopt the *frozen eddy viscosity* assumption standard in mean-flow global stability [10, 13]: turbulent transport coefficients are evaluated at the mean state and not perturbed). Second, for the Helmholtz-level analysis of Section III.C, only scalar fields of Eq. (1)'s solution are consumed — $\bar{\rho}(\mathbf{x})$, $\bar{c}(\mathbf{x})$, $\gamma(\mathbf{x})$, $\bar{\dot{q}}(\mathbf{x})$ — so the bottom level may be satisfied approximately by the parametric generator of Section V.B during development, and by SU2 RANS (Section V.C) in production.

### B. Top level: linearized dynamics and the modal ansatz

Perturbing $\mathbf{w} = \bar{\mathbf{w}} + \mathbf{w}'$ with $\|\mathbf{w}'\| \ll \|\bar{\mathbf{w}}\|$ and retaining first order,

$$
B\,\frac{\partial \mathbf{w}'}{\partial t} = -J\,\mathbf{w}', \qquad J \equiv \frac{\partial \mathbf{r}}{\partial \mathbf{w}}\bigg|_{\bar{\mathbf{w}}}. \tag{2}
$$

The modal ansatz $\mathbf{w}'(t) = \hat{\mathbf{q}}\,e^{\lambda t}$ yields the **generalized eigenvalue problem**

$$
J\,\hat{\mathbf{q}} = -\lambda\, B\,\hat{\mathbf{q}}, \tag{3}
$$

with $\lambda = \sigma + i\omega$. The equilibrium is linearly stable iff every eigenvalue satisfies $\sigma < 0$; the design-relevant output is the set of eigenvalues nearest the imaginary axis in the frequency band of the chamber's low-order acoustic modes, together with their mode shapes $\hat{\mathbf{q}}$ (which identify the mode family and localize the driving via the Rayleigh integrand $\mathrm{Re}[\hat{p}^*\hat{\dot{q}}]$).

Three structural facts drive the entire numerical design, exactly as in [3]:

1. $N$ is large (10⁵–10⁸ depending on tier), so $O(N^3)$ dense methods (QR/QZ) are excluded; Krylov projection onto a small upper-Hessenberg matrix (Arnoldi and its implicitly-restarted and Krylov–Schur variants [14, 15]) is mandatory.
2. The eigenvalues of engineering interest are **not** extremal in modulus — the spectrum's largest-modulus members are heavily damped fine-grid acoustic/diffusive modes — so a **spectral transformation** (shift-invert, Section IV.E) or a time-stepper/Cayley propagator [3, 16] is required to make them extremal.
3. $J$ is strongly **non-normal**: eigenvalues govern only asymptotic behavior, and finite-amplitude "triggering" of linearly stable states — well documented in both rocket history [1] and modern thermoacoustics [17] — is a transient-growth/nonlinear phenomenon. The linear tool is therefore necessary but not sufficient; resolvent analysis over the same operator is a planned extension (Section X), and linear stability verdicts are reported alongside this caveat.

### C. Reduction to the thermoacoustic Helmholtz equation

The full reacting LNSE requires a field mean flow and a resolved-flame linearization of stiff chemistry — both beyond present scope (and, at RANS resolution, of questionable meaning for the chemistry source terms). The classical and well-validated reduction [6, 18] exploits the rocket-chamber ordering: chamber Mach number $\bar{M} \lesssim 0.2$–$0.3$, acoustic wavelengths comparable to chamber dimensions, mean pressure nearly uniform. Linearizing the Euler equations about a quiescent-to-leading-order mean state ($\bar{\mathbf{u}} \approx 0$, $\bar{p} \approx$ const, $\bar{\rho}(\mathbf{x})$, $\bar{T}(\mathbf{x})$ nonuniform) with a heat-release source:

$$
\bar{\rho}\,\frac{\partial \mathbf{u}'}{\partial t} = -\nabla p', \qquad
\frac{\partial p'}{\partial t} + \gamma \bar{p}\,\nabla\!\cdot\!\mathbf{u}' = (\gamma - 1)\,\dot{q}'. \tag{4}
$$

Eliminating $\mathbf{u}'$ (take $\partial_t$ of the second equation, insert the first, use $\bar{c}^2 = \gamma\bar{p}/\bar{\rho}$ with $\gamma\bar{p}$ spatially constant):

$$
\frac{\partial^2 p'}{\partial t^2} \;-\; \nabla\!\cdot\!\left(\bar{c}^2(\mathbf{x})\,\nabla p'\right) \;=\; (\gamma-1)\,\frac{\partial \dot{q}'}{\partial t}. \tag{5}
$$

With $p' = \hat{p}(\mathbf{x})\,e^{\lambda t}$, $\dot{q}' = \hat{\dot{q}}(\mathbf{x})\,e^{\lambda t}$:

$$
\boxed{\;\lambda^2\,\hat{p} \;-\; \nabla\!\cdot\!\left(\bar{c}^2\,\nabla\hat{p}\right) \;=\; (\gamma-1)\,\lambda\,\hat{\dot{q}}.\;} \tag{6}
$$

Velocity mode shapes are recovered from the linearized momentum equation, $\hat{\mathbf{u}} = -\nabla\hat{p}/(\lambda\bar{\rho})$.

**Validity and consequences.** The neglected mean-flow terms are $O(\bar{M})$; their leading physical effect is convective damping, chiefly through the nozzle, which is reinstated through the boundary admittance (Section III.E). Entropy-wave/nozzle interaction (indirect noise driving of longitudinal modes) is likewise absent at this tier and is the principal physics motivating the LEE upgrade (Section X). Within these limits, Eq. (6) with a distributed active flame is the workhorse of industrial thermoacoustics [6, 7, 8] and captures the geometry, temperature-stratification, and flame-placement physics entirely missing from the current module.

### D. Flame response closure

Equation (6) is unclosed until $\hat{\dot{q}}$ is expressed in terms of the acoustic field. We adopt the time-delayed response family, in both classic couplings:

**Pressure coupling** (Crocco's pressure interaction index [19]; the natural first model for LRE injector-plane-dominated response):

$$
\hat{\dot{q}}(\mathbf{x}) \;=\; n_p(\mathbf{x})\;\frac{\bar{\dot{q}}(\mathbf{x})}{\bar{p}}\;e^{-\lambda\tau(\mathbf{x})}\;\hat{p}(\mathbf{x}_{\mathrm{ref}}). \tag{7a}
$$

**Velocity coupling** (the AVSP form [6], appropriate where the response is controlled by injection-velocity or mixing fluctuation):

$$
\hat{\dot{q}}(\mathbf{x}) \;=\; n_u(\mathbf{x})\;e^{-\lambda\tau(\mathbf{x})}\;\hat{\mathbf{u}}(\mathbf{x}_{\mathrm{ref}})\!\cdot\!\mathbf{n}_{\mathrm{ref}}
\;=\; -\,\frac{n_u(\mathbf{x})}{\lambda\,\bar{\rho}(\mathbf{x}_{\mathrm{ref}})}\;e^{-\lambda\tau(\mathbf{x})}\;\nabla\hat{p}\big|_{\mathbf{x}_{\mathrm{ref}}}\!\cdot\!\mathbf{n}_{\mathrm{ref}}. \tag{7b}
$$

Here $n_p, n_u \geq 0$ are interaction indices, $\tau(\mathbf{x})$ is the local time lag, and $\mathbf{x}_{\mathrm{ref}}$ a reference location (injection plane, per-element or per-ring; the implementation supports one reference per injector ring so that transverse modes sample the response at the correct radius and phase). The spatial weights are normalized so that $n$ retains its classical global meaning:

$$
\int_V n_{(\cdot)}(\mathbf{x})\, w(\mathbf{x})\,dV = n \int_V w(\mathbf{x})\,dV,
\qquad w(\mathbf{x}) = \bar{\dot{q}}(\mathbf{x}) \Big/ \int_V \bar{\dot{q}}\,dV,
$$

with $w(\mathbf{x})$ supplied by the mean-flow pipeline — this is precisely where the doublet-ring versus pintle-cone distinction, and the propellant-dependent vaporization length, enter the eigenproblem.

Two consequences. First, substituting (7) into (6) couples $\hat{p}$ at $\mathbf{x}$ to $\hat{p}$ (or $\nabla\hat{p}$) at $\mathbf{x}_{\mathrm{ref}}$ — the flame term is a **nonlocal rank-structured operator**, not a pointwise coefficient. Second, and centrally, the factor $e^{-\lambda\tau}$ makes the eigenproblem **nonlinear in $\lambda$**. Section IV is organized entirely around this fact.

The amplitude-dependent generalization — the flame *describing* function $n(\omega, |\hat{u}|)$, $\tau(\omega, |\hat{u}|)$ [20] — is deliberately deferred: within the framework it replaces the constant-parameter flame matrix by an amplitude-parameterized one, and the eigenvalue solve by a harmonic-balance fixed point over amplitude, predicting limit-cycle levels rather than only onset. Nothing upstream (mesh, mean flow, matrices, solvers) changes; see Section X.

**Where the parameters come from.** $\tau$ estimates follow from the physics that sets the lag, and the suite already computes them: the existing `core.lags_from_smd` chain (Ingebo SMD $\to$ Spalding $B_T$ $\to$ $d^2$-law $\to$ $\tau_{vap}$, $\tau_{sens} = \chi\,\tau_{vap}$) [35, §5] supplies the vaporization-controlled estimate for liquid–liquid doublets; for gas–gas methane elements, mixing/convection times from element exit to flame anchoring replace it. These estimates seed the *center* of the swept envelope $\Sigma$ (Section VI), with the sensitive fraction $\chi$ — identified in [35] as the single largest modeling uncertainty — spanned by the sweep rather than fixed; they are inputs to be swept, not trusted constants.

### E. Boundary conditions

On each boundary segment the linearized momentum equation converts an impedance statement into a Robin condition. With outward normal $\mathbf{n}$ and specific impedance $z(\lambda) = \hat{p}/(\bar{\rho}\,\bar{c}\;\hat{\mathbf{u}}\cdot\mathbf{n})$:

$$
\nabla\hat{p}\cdot\mathbf{n} \;=\; -\,\lambda\,\bar{\rho}\;\hat{\mathbf{u}}\cdot\mathbf{n} \;=\; -\,\frac{\lambda}{\bar{c}\,z(\lambda)}\;\hat{p}. \tag{8}
$$

- **Rigid wall** ($z \to \infty$): homogeneous Neumann, $\nabla\hat{p}\cdot\mathbf{n} = 0$. Default for chamber walls.
- **Choked nozzle**: the compact (short-nozzle) admittance of Marble and Candel [21] applied at the nozzle-entrance plane,
$$
y_{\mathrm{noz}} = \frac{1}{z} = \frac{\gamma - 1}{2}\,\bar{M}_e \;+\; O(\lambda\,\ell_{\mathrm{noz}}/\bar{c}),
$$
with $\bar{M}_e$ the entrance Mach number. This is the leading acoustic damping mechanism of the chamber and must be present for growth rates to be meaningful. For nozzles that are not acoustically compact at tangential-mode frequencies, the admittance is upgraded to the frequency-dependent solution of the quasi-1-D nozzle admittance ODE (Crocco–Sirignano / Bell–Zinn class [22]), integrated numerically per $\lambda$ — one more source of $\lambda$-nonlinearity, handled identically to the flame delay.
- **Injector face**: rigid by default; per-element or per-ring impedance $z_{\mathrm{inj}}(\lambda)$ from a feed/element transfer function when injector-coupled (intermediate-frequency) modes are of interest. This is the future hook for feed-system network coupling (R4).
- **Acoustic absorbers** (quarter-wave cavities, baffle damping): lumped $z(\lambda)$ patches on the boundary — the natural mechanism by which damping-device sizing enters the same analysis.

Axis regularity (meridional formulation): $\partial_r \tilde{p} = 0$ at $r=0$ for $m=0$; $\tilde{p}(r{=}0) = 0$ for $m \geq 1$.

### F. Azimuthal decomposition: 3-D modes at 2-D cost

For an axisymmetric mean state — exact for a single-element pintle, and correct to leading order for ring-pattern doublet faces once element-scale granularity is smeared azimuthally (valid because acoustic wavelengths $\sim D_c$ vastly exceed element spacing) — the operator in Eq. (6) is invariant under rotation, and eigenmodes separate:

$$
\hat{p}(x, r, \theta) = \tilde{p}(x, r)\,e^{im\theta}, \qquad m \in \mathbb{Z}_{\geq 0}.
$$

In cylindrical coordinates,

$$
\nabla\!\cdot\!(\bar{c}^2 \nabla \hat{p}) \;=\;
\left[\frac{\partial}{\partial x}\!\left(\bar{c}^2 \frac{\partial \tilde{p}}{\partial x}\right)
+ \frac{1}{r}\frac{\partial}{\partial r}\!\left(r\,\bar{c}^2 \frac{\partial \tilde{p}}{\partial r}\right)
- \frac{m^2 \bar{c}^2}{r^2}\,\tilde{p}\right] e^{im\theta},
$$

so each $m$ yields an independent 2-D eigenproblem on the meridional half-plane $\Omega$ (the revolved chamber contour — directly consumable from the existing `chamber_geometry` contour):

$$
\lambda^2 \tilde{p}
\;-\; \frac{\partial}{\partial x}\!\left(\bar{c}^2 \frac{\partial \tilde{p}}{\partial x}\right)
\;-\; \frac{1}{r}\frac{\partial}{\partial r}\!\left(r\,\bar{c}^2 \frac{\partial \tilde{p}}{\partial r}\right)
\;+\; \frac{m^2 \bar{c}^2}{r^2}\,\tilde{p}
\;=\; (\gamma - 1)\,\lambda\,\hat{\dot{q}}[\tilde{p}]. \tag{9}
$$

Mode families: $m=0$ contains all longitudinal (1L, 2L, …) and radial (1R, …) modes; $m=1$ the first tangential (1T) family and its longitudinal mixes (1T1L, …); $m=2$ the 2T family; etc. The historically dangerous modes for impinging-doublet LREs — 1T, 1T1L — are obtained from $m=1$ alone, on a 2-D mesh that can be made brutally fine at negligible cost. Mode identification is by construction ($m$ is an input; radial/longitudinal order is read off the meridional shape), eliminating the eigenvector-forensics of general 3-D solves. Spinning versus standing character is degenerate at the linear axisymmetric level ($\pm m$ pairs coincide); the distinction becomes dynamical only with symmetry-breaking (baffles) or at finite amplitude, both flagged as 3-D/FDF-tier topics.

### G. Weak form, discretization, and the discrete NLEVP

Multiply Eq. (9) by a test function $\phi$, integrate over $\Omega$ with the axisymmetric measure $r\,dr\,dx$, integrate the divergence term by parts, and insert the Robin condition (8):

$$
\underbrace{\int_\Omega \bar{c}^2\,\nabla\tilde{p}\cdot\nabla\bar{\phi}\;r\,d\Omega}_{\text{stiffness } K}
\;+\; m^2 \underbrace{\int_\Omega \frac{\bar{c}^2}{r}\,\tilde{p}\,\bar{\phi}\;d\Omega}_{K_m}
\;+\; \lambda \underbrace{\int_{\Gamma_z} \frac{\bar{c}}{z(\lambda)}\,\tilde{p}\,\bar{\phi}\;r\,d\Gamma}_{C(\lambda)}
\;+\; \lambda^2 \underbrace{\int_\Omega \tilde{p}\,\bar{\phi}\;r\,d\Omega}_{M_2}
\;=\; (\gamma-1)\,\lambda \int_\Omega \hat{\dot{q}}[\tilde{p}]\,\bar{\phi}\;r\,d\Omega. \tag{10}
$$

Discretizing with $P^2$ Lagrange elements (FEniCSx [23]; gmsh meshes generated by revolving/meshing the chamber contour) gives sparse $N_h \times N_h$ matrices and the **discrete nonlinear eigenvalue problem**

$$
\boxed{\;N(\lambda)\,\mathbf{p} \;=\; \Big[\,K + m^2 K_m \;+\; \lambda\,C(\lambda) \;+\; \lambda^2 M_2 \;-\; \lambda\,F(\lambda)\,\Big]\,\mathbf{p} \;=\; 0,\;} \tag{11}
$$

where the flame matrix from Eq. (7a) is the rank-$k$ (one per reference ring) outer-product structure

$$
F(\lambda) \;=\; (\gamma-1) \sum_{k} e^{-\lambda \tau_k}\, \mathbf{g}_k\,\mathbf{b}_k^{\!\top},
\qquad
\mathbf{g}_k = \Big[\textstyle\int_\Omega n_p \tfrac{\bar{\dot q}}{\bar p} N_i\, r\,d\Omega\Big]_i,\;\;
\mathbf{b}_k = \big[N_i(\mathbf{x}_{\mathrm{ref},k})\big]_i,
$$

(velocity coupling replaces $\mathbf{b}_k$ by the gradient-sampling functional and cancels one power of $\lambda$; the implementation treats both through a common `FlameOperator` abstraction). With passive flame ($F=0$) and constant $z$, Eq. (11) is a *quadratic* eigenproblem; delays and $z(\lambda)$ make it genuinely nonlinear but **holomorphic** in $\lambda$ — the property that licenses every solver in Section IV. All matrices except the scalar factors $e^{-\lambda\tau_k}$ and $1/z(\lambda)$ are assembled once per mean flow; a full $(n,\tau)$-envelope sweep therefore reuses the expensive objects wholesale.

Function-of-interest evaluation, mirroring [3] Section III.D: the campaign extracts, per $(m, n, \tau)$ point, the set $\{\lambda_j\}$ in the analysis window, the mode shapes, the Rayleigh-integrand field $\mathrm{Re}[\tilde{p}^*\hat{\dot{q}}]\,$ (localizing driving), and the boundary-flux damping budget (attributing loss to nozzle/absorbers) — the last two being the diagnostic quantities a stability engineer acts on.

---

## IV. Eigenvalue computation methodology

### A. Structure of the problem and solution strategy

We must find all eigenvalues of the holomorphic NLEVP (11) inside a target window $W = \{\lambda : |\mathrm{Im}\,\lambda|/2\pi \in [f_{\min}, f_{\max}],\ \mathrm{Re}\,\lambda \in [-\sigma_{\max}, +\sigma_{\max}]\}$ spanning the low-order mode families, *with certainty that none are missed* — a missed marginally-unstable mode is the worst failure of a stability tool. No single algorithm optimally provides speed, robustness, and completeness; we specify a hierarchy in which cheap iterations do the bulk of the work and a contour-integral method audits completeness.

### B. Frozen-coefficient fixed point (workhorse)

The AVSP strategy [6]: freeze the $\lambda$-dependence of the "slow" scalar factors at the current iterate and solve the resulting *quadratic* eigenproblem by linearization.

**Algorithm 1 — Frozen-delay fixed point for mode $j$ at wavenumber $m$.**
```
Input:  matrices K, Km, M2; flame factors {g_k, b_k, τ_k}; z(λ); shift s0
        (from passive-flame mode or previous sweep point); tol η.
1: λ⁰ ← s0
2: for it = 0, 1, 2, ... do
3:     Freeze D_k ← exp(−λ^it τ_k),  ζ ← z(λ^it)
4:     Assemble quadratic pencil Q(λ) = K̃(D,ζ) + λ C̃(ζ) + λ² M2
5:     Companion-linearize to GEVP of size 2N_h  (SLEPc PEP)
6:     Solve by shift-invert Krylov–Schur, target s = λ^it   ▷ Section IV.E
7:     λ^{it+1} ← eigenvalue of Q nearest λ^it
8:     if |λ^{it+1} − λ^it| < η |λ^{it+1}| : return (λ, p)
9: end for
```
Convergence is linear with rate $\sim |n\,\tau\,\partial_\lambda(\cdot)|$; in practice 3–8 outer iterations for realistic LRE parameters [6]. Continuation through the $(n,\tau)$ sweep (warm-starting from the neighboring grid point) typically cuts this to 1–3.

### C. Bordered Newton (polish and continuation)

Given a good iterate, quadratic convergence is recovered by Newton on the extended system with normalization $\mathbf{c}^H\mathbf{p} = 1$:

$$
\begin{bmatrix} N(\lambda) & N'(\lambda)\,\mathbf{p} \\ \mathbf{c}^H & 0 \end{bmatrix}
\begin{bmatrix} \Delta\mathbf{p} \\ \Delta\lambda \end{bmatrix}
= -\begin{bmatrix} N(\lambda)\,\mathbf{p} \\ \mathbf{c}^H\mathbf{p} - 1 \end{bmatrix},
\qquad
N'(\lambda) = C + \lambda\,\partial_\lambda C + 2\lambda M_2 - \partial_\lambda(\lambda F),
$$

with the bordered solve performed by block elimination against the cached sparse factorization of $N(\lambda)$ (bordering algorithm; one back-solve pair per step). This is also the natural engine for **neutral-curve tracing**: appending the constraint $\mathrm{Re}\,\lambda = 0$ and freeing one flame parameter (say $n$) turns the same bordered system into a pseudo-arclength continuation for the stability boundary $n_{\mathrm{crit}}(\tau)$ directly — far cheaper than gridding the whole envelope when only the boundary is wanted.

### D. Beyn contour integration (completeness audit)

Missed-mode insurance is provided by the contour-integral method of Beyn [24]: for a contour $\Gamma \subset W$ enclosing the eigenvalues of interest and a random probe block $V \in \mathbb{C}^{N_h \times \ell}$,

$$
A_0 = \frac{1}{2\pi i}\oint_\Gamma N(z)^{-1} V \, dz, \qquad
A_1 = \frac{1}{2\pi i}\oint_\Gamma z\,N(z)^{-1} V \, dz,
$$

followed by an SVD-based rank reveal of $A_0$ and a small dense eigenproblem, returns **all** eigenpairs inside $\Gamma$ (holomorphy of $N$ guarantees it, up to quadrature error, which decays exponentially with node count for trapezoid rule on smooth contours). Cost: one sparse LU + $\ell$ back-solves per quadrature node ($\sim$16–32 nodes per window). Role: executed once per campaign per $m$-window at the envelope's worst-case corner, cross-checking the fixed-point/Newton mode census. SLEPc's NEP module with NLEIGS rational approximation [25] provides an alternative production path for the delay-type nonlinearity and will be benchmarked against the in-house Beyn implementation.

### E. Shift-invert Krylov–Schur kernel

All linearized solves reduce to: eigenvalues of a sparse pencil $(A, B)$ nearest a shift $s \in \mathbb{C}$. As in [3] (their Algorithm 3), we use shift-invert Krylov–Schur:

$$
(A - sB)^{-1} B\, \mathbf{q} = \theta\, \mathbf{q}, \qquad \lambda = s + 1/\theta,
$$

which maps the interior window around $s$ to the *exterior* (largest $|\theta|$) of the transformed spectrum, where Arnoldi converges in $O(10)$ iterations. The operator is applied via a **one-time complex sparse LU factorization** of $(A - sB)$ (MUMPS/SuperLU_DIST through PETSc); every Arnoldi step is then a mat-vec plus two triangular back-solves. At Helmholtz-tier sizes ($N_h \sim 10^5$, 2-D sparsity) factorization takes seconds and memory is trivial; the GMRES/BiCGSTAB inner-solver fallback becomes relevant only at the 3-D LNSE tier, where the factorization no longer fits — the interface (a `ShiftedSolve` protocol) is designed so direct and iterative applications are interchangeable. The time-stepper/Cayley alternative of [3], which avoids shift selection by spectral-transforming through a Crank–Nicolson propagator, is noted as the migration path for matrix-free LNSE tiers where $J$ is never assembled.

Shift placement is not guesswork here — passive-flame acoustic frequencies (computable instantly, and validated against the existing module's duct formulas as a smoke test) seed one shift per expected mode family per $m$.

### F. Campaign-level algorithm

**Algorithm 2 — Stability campaign for one design.**
```
Input: design config x_d (geometry, propellants, Pc, MR, injector pattern),
       flame-parameter envelope Σ ⊂ (n, τ) space, wavenumbers m ∈ {0,1,2,3},
       frequency window [f_min, f_max].
1:  MeanFlowSpec ← parametric generator(x_d)              ▷ Section V.B
2:  MeanFlowSpec ← SU2 axisym RANS warm-started from (1)  ▷ Section V.C  [skippable in fast mode]
3:  for m in {0,1,2,3}:
4:      Assemble K, Km, M2, C-structure, flame vectors on meridional mesh
5:      Solve passive problem (F=0) → mode census, frequencies, shapes  ▷ seeds + sanity vs. duct formulas
6:      for (n, τ) in Σ-grid (parallel):
7:          for each tracked mode j: Algorithm 1 + Newton polish → λ_j(m; n, τ)
8:      Trace neutral curves n_crit(τ) per mode by bordered continuation  ▷ Section IV.C
9:      Beyn audit on worst-case corner of Σ → assert census complete
10: Report: σ-maps over Σ per mode; margins (Sec. VI); mode shapes;
           Rayleigh-integrand and damping-budget fields; JSON + plots.
```

---

## V. Mean flow generation

### A. The `MeanFlowSpec` interface

All eigensolver inputs pass through one container, decoupling mean-flow fidelity from stability machinery:

```python
@dataclass
class MeanFlowSpec:
    mesh:   MeridionalMesh          # (x, r) triangulation of revolved contour
    rho:    Field                   # mean density [kg/m^3]
    c:      Field                   # sound speed [m/s]
    gamma:  Field                   # specific heat ratio
    qbar:   Field                   # mean volumetric heat release [W/m^3]
    ubar:   Optional[VectorField]   # mean velocity (None at Helmholtz tier; required for LEE)
    refs:   list[FlameReference]    # per-ring reference points/normals for Eq. (7)
    meta:   ProvenanceRecord        # generator, propellants, Pc, MR, residuals, hashes
```

Adapters populate it from (i) the parametric generator, (ii) an SU2 restart/solution file, or (iii, future) any external CFD/LES average. `ProvenanceRecord` makes every eigenvalue traceable to its mean flow — a professional-suite requirement.

### B. Stage 1: parametric generator (all propellants, all injector types)

Purpose: physically-consistent fields sufficient to (a) warm-start RANS reliably and (b) drive the eigensolver in fast/development mode. Construction:

**Axial energy-release profile.** A burned-fraction profile $\psi(x)$ with vaporization/consumption length $L_v$:

$$
\psi(x) = 1 - \exp\!\big[-(x/L_v)^{k}\big], \qquad
\bar{\dot{q}}_{\mathrm{axial}}(x) \propto \frac{d\psi}{dx}, \qquad
\int_V \bar{\dot{q}}\, dV = \eta_{c^*}\,\dot{m}_p\,\Delta h_c,
$$

with $k \in [1,2]$ a spreading parameter and the total normalized to the delivered (efficiency-corrected) heat release. $L_v$ is propellant- and injector-specific:

- *Liquid–liquid (LOX/RP-1, LOX/ethanol doublets):* vaporization-limited. Droplet $d_{32}$ from unlike-doublet impingement correlations (Dickerson-class [26]; inputs: orifice diameters, jet velocities, momentum ratio, impingement angle), droplet lifetime from the $d^2$-law with Spalding transfer number — directly reusing the suite's existing `spalding.py` — and $L_v \approx \bar{u}_d\, \tau_{vap}$ with axial drag-decelerated drop velocity. This is the Priem–Heidmann vaporization-limited chamber-length logic [27] recast as a profile generator.
- *Gas–gas / gas-centered (LOX/GCH₄):* mixing-limited; $L_v$ from turbulent jet-flame length scaling on element exit diameter and momentum-flux ratio. Methane's well-characterized kinetics (GRI-Mech 3.0 [28] via Cantera [29]) matter at Stage 2; at Stage 1 only $L_v$ and equilibrium properties enter.

**Radial/pattern distribution.** Injector-type-specific weight $g(r)$ (azimuthally smeared per Section III.F):

- *Unlike doublets in rings at radii $\{r_k\}$:* $g(r) = \sum_k w_k\, \mathcal{N}(r; r_k, s_k)$ — Gaussian annuli with widths set by element spacing and spray fan spreading; $w_k$ from per-ring mass flow. Ring-level mixture-ratio bias from Rupe mixing-uniformity $E_m$ [30] shifts local equilibrium temperature via CEA at the local MR (film-cooling/barrier rings thus appear naturally as cool outer strata — which measurably shift tangential-mode frequencies and damping).
- *Pintle:* single annular release zone at the impingement cone radius/angle, parameterized by the existing impingement-zone code.

**Thermodynamic fields.** With local burned fraction $\Phi(x,r) \propto \psi(x)g(r)$ (normalized), blend injection-end and equilibrium states:

$$
\bar{T}(x,r) = T_{\mathrm{inj}} + \big[T_{ad}(\mathrm{MR}_{\mathrm{local}}, P_c) - T_{\mathrm{inj}}\big]\,\Phi(x,r),\quad
\bar{c} = \sqrt{\gamma R \bar{T}}, \quad \bar{\rho} = \frac{P_c}{R\,\bar{T}},
$$

with $(T_{ad}, \gamma, R)(\mathrm{MR}, P_c)$ from the existing CEA cache. Every propellant/injector specialization above is a *submodel behind one interface*; adding a propellant is a chemistry-table entry plus (if liquid) property data for the $d^2$-law.

### C. Stage 2: warm-started SU2 axisymmetric RANS

Stage 1 fields, interpolated to the CFD mesh and written as an SU2 restart file, initialize a compressible axisymmetric RANS solve (SU2 [31]; SST closure) of chamber + nozzle on the revolved contour. Two combustion treatments, in order of implementation:

1. **Prescribed heat source:** impose $\bar{\dot{q}}(x,r)$ from Stage 1 as a volumetric source; SU2 then returns *conservation-consistent* $\bar{\rho}, \bar{T}, \bar{u}$ fields (boundary layers, recirculation, nozzle acceleration) without any combustion-model risk. Fastest robust upgrade over Stage 1; flame *placement* remains modeled.
2. **FGM/flamelet species transport:** Cantera-built flamelet tables (GRI-3.0 for CH₄; ethanol mechanism; RP-1 surrogate) with SU2's species-transport/FGM machinery, letting the CFD position the flame. Higher fidelity, higher care: transcritical LOX injection at high $P_c$ is knowingly approximated (ideal-gas mixing with matched enthalpy flux) — acceptable for acoustic mean fields, flagged in provenance.

Warm-starting is load-bearing, not cosmetic: steady reacting RANS initialized from uniform states routinely diverges; initialized from Stage 1 fields with CFL ramping it converges reliably and *faster*, and the Stage-1-vs-converged-RANS discrepancy is logged as calibration feedback to the parametric flame-shape submodels. Budget: 100–300k cells, deep convergence, ≲30 min on the target workstation (R1).

---

## VI. Stability maps and margin definition

Because $(n, \tau)$ carry the dominant uncertainty, the campaign sweeps an envelope $\Sigma$ (default: $n \in [0.3, 3]$, $\tau$ spanning $0.3\times$–$3\times$ the physics-based estimate of Section III.D, log-spaced grid, refined near neutral curves by the continuation of Section IV.C) and reports, per mode $j$:

- growth-rate map $\sigma_j(n, \tau)$ and neutral curve $\mathcal{N}_j = \{(n,\tau): \sigma_j = 0\}$;
- **parametric margin** $\mathcal{M}_j = \min_{(n,\tau)\in\mathcal{N}_j} \big\| (n,\tau) - (\hat{n},\hat{\tau}) \big\|_{\Sigma}$ — the scaled distance from the nominal estimate to instability (signed: negative if the nominal point is already unstable);
- worst-case growth rate over $\Sigma$, $\sigma_j^{\max}$, and the fraction of $\Sigma$ that is unstable;
- classical interpretability check: the $\tau$-bands of instability for each mode should straddle $\tau \approx (2k{+}1)/(2f_j)$ (Rayleigh phase criterion) — a built-in physical sanity assertion on every map.

A design verdict is then a table over mode families $\{$1L, 2L, 1T, 1T1L, 2T, 1R$\}$ × $\{\mathcal{M}_j, \sigma_j^{\max}, f_j\}$, plus mode-shape and Rayleigh-integrand plots — replacing the current module's scalar `stability_margin` with an artifact of the kind stability review boards actually consume [1]. The sweep is embarrassingly parallel and reuses all $\lambda$-independent matrices (Section III.G).

---

## VII. Verification and validation plan

Verification (math/code) is separated from validation (physics), each with acceptance criteria. All verification cases become permanent CI regression tests.

### A. Verification ladder

| # | Case | Reference | Checks | Acceptance |
|---|---|---|---|---|
| V1 | Uniform closed–closed cylinder, passive | Analytic: $f = \frac{c}{2\pi}\sqrt{(\alpha'_{mn}/R_c)^2 + (k\pi/L)^2}$, $J'_m(\alpha'_{mn})=0$ | FEM correctness, $m$-decomposition, axis conditions, convergence order | eigenvalue error $<0.1\%$ on production mesh; observed $O(h^{2p})$ convergence |
| V2 | 1-D duct with temperature jump, passive | Analytic dispersion relation (interface matching) | nonuniform-$\bar c$ handling | $<0.1\%$ |
| V3 | Duct with compact flame, $n$–$\tau$, closed/choked ends | Semi-analytic transcendental dispersion relation; Rijke-tube literature [17, 32] | active flame term, delay nonlinearity, complex $\lambda$, all three solvers agree | $|\Delta\lambda|/|\lambda| < 10^{-6}$ between solvers; $<1\%$ vs. dispersion relation |
| V4 | Published Helmholtz benchmark (AVSP-class annular/longitudinal config [6]; helmholtz-x examples [8]) | cross-code | end-to-end 2-D/3-D machinery, impedance BCs | frequencies $<1\%$, growth rates $<5\%$ |
| V5 | Time-domain cross-check: linearized Eq. (5) marched in time from impulse; $\sigma, \omega$ fitted from the linear-growth phase | self-consistency (mirrors Appendix G of [3]) | independent path to the same eigenvalue; catches sign/convention bugs | fitted vs. eigensolver $\lambda$: $<1\%$ |
| V6 | Nozzle admittance: compact limit vs. quasi-1-D admittance ODE as $\ell_{\mathrm{noz}}\to$ compact | [21, 22] | boundary-condition module | monotone convergence to Marble–Candel value |

### B. Validation targets

| Case | Facility/data | Why it fits | Success measure |
|---|---|---|---|
| CVRC | Purdue Continuously Variable Resonance Combustor: single-element CH₄/decomposed-H₂O₂, self-excited longitudinal instability, stability boundary vs. translating oxidizer-post length; extensively published [33] | public data; longitudinal ($m{=}0$) exercises flame + nozzle + impedance BCs; methane-relevant | predicted stable/unstable classification vs. post length reproduces the experimental boundary within the swept flame-parameter envelope; frequency within ~5% |
| BKD | DLR LOX/H₂ research thruster, injector-coupled 1T instability with published spectral/mode data [34]; LES-based analyses available for cross-reference [12] | transverse ($m{=}1$) validation on a real multi-element LRE | 1T frequency within ~5%; instability window qualitatively reproduced under documented flame-response assumptions |
| In-house | Future hot-fire campaigns (LOX/CH₄ doublet) | closes the loop on our own hardware | post-test: measured mode frequencies/growth vs. prediction; pre-test: margin table informs instrumentation |

An explicit non-goal at this tier: quantitative growth-rate accuracy better than factor-~2 against experiment. The literature consensus [6, 9, 17] is that frequencies are predicted well, growth rates to leading order, and stable/unstable classification usefully — *provided* flame-parameter uncertainty is swept, which is exactly the campaign design.

---

## VIII. Computational cost estimates

Per design campaign on an Apple-Silicon workstation (estimates to be replaced by measurements; all stages checkpointed):

| Stage | Size | Estimated cost |
|---|---|---|
| Stage-1 parametric fields | analytic + CEA cache | seconds |
| SU2 axisym RANS (warm-started) | 100–300k cells | ≲30 min (R1 budget) |
| FEM assembly per $m$ | $N_h \sim 5\times10^4$–$2\times10^5$ ($P^2$) | seconds |
| One sparse complex LU | 2-D sparsity | 1–10 s |
| One eigen-solve (Alg. 1 + Newton) | few LUs + Krylov | 5–60 s |
| Full campaign: 4 $m$'s × ~200 $\Sigma$-points × ~4 tracked modes, warm-started continuation, 8-way parallel | ~10³ eigen-solves, heavy reuse | 15–40 min |
| Beyn audits | 4 windows × ~24 nodes | minutes |

Total: **~1 hour**, dominated by RANS — consistent with R1 and leaving headroom for mesh refinement or wider envelopes. Memory is trivial at 2-D sizes (<8 GB throughout).

---

## IX. Software architecture and integration

New package, existing code untouched (R6):

```
engine/stability_hifi/
    meanflow/     spec.py (MeanFlowSpec, adapters)
                  parametric.py (Sec. V.B; injector & propellant submodels)
                  su2_driver.py (restart writer, config gen, run, extract)
    acoustics/    mesh.py (contour → meridional mesh via gmsh)
                  assembly.py (FEniCSx forms: K, Km, M2, C, flame ops)
                  bcs.py (impedance library: rigid, Marble–Candel, quasi-1D nozzle ODE, absorber patches)
    eigen/        nlevp.py (N(λ) protocol), fixed_point.py, newton.py,
                  beyn.py, slepc_backend.py (PEP/NEP-NLEIGS), shifts.py
    campaign/     sweep.py (Σ grids, continuation, parallel map)
                  margins.py, report.py (JSON + plots), provenance.py
    validation/   cases/ (V1–V6 as CI tests), cvrc/, bkd/
```

Dependency policy: `numpy/scipy` mandatory; `FEniCSx + SLEPc/PETSc` for production FEM/eigen (a `scipy.sparse + ARPACK` fallback backend keeps V1–V3 runnable in minimal environments); `gmsh`, `cantera` required; `SU2` optional (Stage 2). Entry point: `enginedesign stability-hifi run <design.yaml>` producing a versioned report directory. The existing lumped module keeps two permanent roles: `chug.py` remains the authoritative feed-coupled (low-frequency) analysis, and `acoustic.py`/`core.py` remain the in-loop screen, with their closed-form frequencies seeding Algorithm 2 step 5 and `core.lags_from_smd` seeding the $\Sigma$-envelope center. Cross-checks between the lumped overlap/damping assumptions and this framework's computed values are reported per campaign — each run of the rich tier calibrates the fast tier.

Implementation phasing:

- **P0 (eigensolver core):** V1–V3 on synthetic `MeanFlowSpec` fields; scipy backend; fixed-point + Newton. *Exit: V1–V3 green.*
- **P1 (real geometry + parametric mean flow):** contour meshing, Stage-1 generator (doublet + pintle, 3 propellants), Marble–Candel BC, campaign/report layer; V4–V6. *Exit: full campaign on a current in-house design, fast mode.*
- **P2 (CFD anchoring):** SU2 driver, heat-source then FGM; CVRC validation. *Exit: CVRC boundary reproduced.*
- **P3 (hardening):** Beyn audit productionized, SLEPc NEP benchmark, BKD case, documentation.

---

## X. Roadmap beyond the Helmholtz tier

| Tier | Physics added | Formulation change | Reuse |
|---|---|---|---|
| LEE | mean-flow convection, refraction, entropy/vorticity waves, intrinsic nozzle damping | 5-equation linearized Euler operator on $(\bar\rho,\bar{\mathbf u},\bar p)$; same $e^{im\theta}$ reduction; $\hat{q}$-vector grows to 4 fields/point (meridional) | mesh, `MeanFlowSpec` (now consuming $\bar{\mathbf u}$), all NLEVP solvers, campaign layer |
| FDF / limit cycle | amplitude-dependent flame response; limit-cycle amplitude & hysteresis prediction | harmonic-balance fixed point over amplitude wrapping the existing eigensolve; FDF tables from LES/experiment/correlations | everything; adds one outer loop |
| Non-normal / resolvent | transient growth, triggering susceptibility, forced response to injector noise | SVD of $(\lambda I - L)^{-1}$ via the same shift-invert kernel | operator assembly, Krylov kernel |
| 3-D | baffle sectors, discrete absorber arrays, azimuthally nonuniform patterns | full 3-D FEM; $m$ no longer separable (Bloch reduction where sector-periodic) | solvers, flame ops, campaign |
| LNSE | full linearized RANS global modes (the direct analogue of [3]) | matrix-free time-stepper/Cayley Arnoldi on the CFD Jacobian | eigensolver strategy, reporting |
| Adjoint sensitivities | $d\sigma/d\mathbf{x}_d$ for geometry/injector parameters — stability-constrained *design*, closing the loop back to [3]'s program | coupled adjoint of bottom+top levels; block back-substitution exactly as [3] Eq. (14)–(17) | entire two-level structure, by construction |

The two-level architecture was chosen with the last row in mind: because the mean-flow residual does not depend on the eigenpair ($\partial\mathbf{r}/\partial\mathbf{v} = 0$), the coupled stability adjoint back-substitutes into two sequential adjoint solves [3] — meaning the eventual gradient capability requires no re-architecture, only differentiation of components that are, at the Helmholtz tier, small and mostly linear-algebraic.

---

## XI. Conclusions

We have specified, to implementation readiness, a first-principles combustion stability analysis capability for the EngineDesign suite: a thermoacoustic global-mode eigensolver on the true chamber geometry with distributed, time-delayed flame response and physical boundary damping; an azimuthal decomposition delivering the tangential modes that dominate LRE risk at 2-D cost; a nonlinear-eigenproblem solver hierarchy with a completeness audit; a propellant- and injector-agnostic two-stage mean-flow pipeline culminating in warm-started axisymmetric RANS; and an uncertainty-honest campaign product — per-mode stability maps and parametric margins — with a concrete verification ladder and public-data validation plan (CVRC, BKD). The formulation deliberately mirrors the two-level linear-stability architecture of Kanchi et al. [3], both because the mathematical structure (steady base state; Jacobian eigenvalue; shift-invert Krylov solution; eventual coupled adjoint) transfers intact from transonic buffet to thermoacoustics, and because that structure is what keeps every planned extension — LEE, describing functions, resolvent, adjoints — an upgrade rather than a rewrite. The result, when implemented, replaces heuristic scoring with the spectrum of the linearized dynamics: mode-by-mode growth rates, shapes, driving mechanisms, and margins, at a per-design cost of about an hour.

---

## Appendix A. Real formulation of the complex eigenproblem

Solvers operating in real arithmetic (and the future adjoint, following [3] Appendix A) use the split $\hat{\mathbf{q}} = \mathbf{q}_r + i\mathbf{q}_i$, $\lambda = \lambda_r + i\lambda_i$ applied to Eq. (3):

$$
\begin{aligned}
J\mathbf{q}_r + \lambda_r B\mathbf{q}_r - \lambda_i B\mathbf{q}_i &= 0,\\
J\mathbf{q}_i + \lambda_r B\mathbf{q}_i + \lambda_i B\mathbf{q}_r &= 0,
\end{aligned}
$$

closed by two normalization conditions (e.g., $\mathbf{e}_k^\top\mathbf{q}_r = 1$, $\mathbf{e}_k^\top\mathbf{q}_i = 0$, fixing scale and phase), giving the top-level residual $\hat{\mathbf{r}}(\mathbf{v}) = 0$ with $\mathbf{v} = [\mathbf{q}_r^\top, \mathbf{q}_i^\top, \lambda_r, \lambda_i]^\top$ — the form required for bordered Newton and for eigenpair adjoints. Our production Helmholtz solvers work directly in complex arithmetic; this form is recorded for the adjoint tier.

## Appendix B. Derivation assumptions for Eq. (6)

From the reacting Euler equations, linearized: (i) $\bar{M}^2 \ll 1$ (dropped mean-convection terms are $O(\bar M)$ in the momentum/energy balances); (ii) $\gamma\bar p$ spatially uniform (chamber pressure drop $\ll P_c$); (iii) calorically-perfect perturbations about locally-varying mean properties ($\gamma(\mathbf{x})$ retained in coefficients, its perturbation neglected); (iv) species/entropy perturbations enter only through $\dot q'$ (no entropy-wave transport — restored at LEE tier); (v) frozen turbulent transport. Under (i)–(v), continuity+energy give $\partial_t p' + \gamma\bar p \nabla\!\cdot\!\mathbf{u}' = (\gamma-1)\dot q'$ and momentum gives $\bar\rho\,\partial_t\mathbf{u}' = -\nabla p'$; cross-differentiation yields Eq. (5) since $\gamma\bar p\,\nabla\!\cdot\!(\bar\rho^{-1}\nabla p') = \nabla\!\cdot\!(\bar c^2\nabla p')$.

## Appendix C. Compact-nozzle admittance

For a choked nozzle short relative to the acoustic wavelength, mass-flux conservation of the perturbed choking condition gives the chamber-side relation $\frac{\hat u}{\bar c} = \frac{\gamma-1}{2}\,\bar M_e\,\frac{\hat p}{\gamma \bar p}$ [21], i.e., specific admittance $y = (\gamma-1)\bar M_e/2$ (purely resistive: the compact choked nozzle always damps). Finite-length corrections make $y(\lambda)$ complex and are obtained by integrating the quasi-1-D admittance ODE through the convergent section [22]; the BC module exposes both behind one interface.

## Appendix D. Units and nondimensionalization

Assembled matrices use SI; reported eigenvalues are $f = \omega/2\pi$ [Hz] and $\sigma$ [1/s], plus nondimensional $\lambda^* = \lambda L_{\mathrm{ref}}/\bar c_{\mathrm{ref}}$ with $L_{\mathrm{ref}} = R_c$, $\bar c_{\mathrm{ref}} = \bar c(\text{nozzle entrance})$ for cross-design comparison. A useful engineering translation also reported per mode: the cycle increment $g_c = e^{2\pi\sigma/\omega} - 1$ (fractional amplitude growth per cycle), the quantity most directly comparable to bomb-test damp rates [1].

## Appendix E. Doublet flame-shape submodel data flow

$(d_o, V_j, \theta_{\mathrm{imp}}, \mathrm{MR}_{\mathrm{ring}}, \dot m_{\mathrm{ring}}) \xrightarrow{\text{[26]}} d_{32} \xrightarrow{\ d^2\text{-law, } B_M\ (\texttt{spalding.py})} \tau_{vap} \xrightarrow{\ \bar u_d(x)\ } L_v \Rightarrow \psi(x)$; $(r_k, s_k, w_k)$ from face layout; $E_m$ [30] $\Rightarrow \mathrm{MR}_{\mathrm{local}} \Rightarrow T_{ad}$ stratification. Each arrow is a replaceable submodel; each output feeds both $\bar{\dot q}(x,r)$ (hence the flame matrix weights) and the $\tau$-envelope center.

---

## References

[1] Harrje, D. T., and Reardon, F. H. (eds.), *Liquid Propellant Rocket Combustion Instability*, NASA SP-194, 1972.

[2] Oefelein, J. C., and Yang, V., "Comprehensive Review of Liquid-Propellant Combustion Instabilities in F-1 Engines," *Journal of Propulsion and Power*, Vol. 9, No. 5, 1993, pp. 657–677.

[3] Kanchi, R. S., He, S., Jonsson, E., and Martins, J. R. R. A., "Buffet Alleviation via Linear Stability Adjoint," (reference paper for this document; formulation, shift-invert Krylov–Schur and Cayley time-stepper eigensolvers, coupled linear-stability adjoint).

[4] Li, J., Yang, D., Luzzato, C., and Morgans, A. S., "OSCILOS: the open-source combustion instability low-order simulator," Imperial College London, technical report/software.

[5] Emmert, T., Meindl, M., Jaensch, S., and Polifke, W., "Linear State Space Interconnect Modeling of Acoustic Systems (taX)," *Acta Acustica united with Acustica*, Vol. 102, 2016.

[6] Nicoud, F., Benoit, L., Sensiau, C., and Poinsot, T., "Acoustic Modes in Combustors with Complex Impedances and Multidimensional Active Flames," *AIAA Journal*, Vol. 45, No. 2, 2007, pp. 426–441.

[7] Camporeale, S. M., Fortunato, B., and Campa, G., "A Finite Element Method for Three-Dimensional Analysis of Thermo-acoustic Combustion Instability," *Journal of Engineering for Gas Turbines and Power*, Vol. 133, No. 1, 2011.

[8] Ekici, E., et al., *helmholtz-x*: open-source FEniCSx-based thermoacoustic Helmholtz solver (software), University of Cambridge.

[9] Schulze, M., and Sattelmayer, T., "Linear Stability Assessment of Cryogenic Rocket Engine Combustion via Linearized Euler Equations," papers in *Journal of Propulsion and Power* / CEAS Space Journal, 2015–2017.

[10] Theofilis, V., "Global Linear Instability," *Annual Review of Fluid Mechanics*, Vol. 43, 2011, pp. 319–352.

[11] Nichols, J. W., and Lele, S. K., "Global Modes and Transient Response of a Cold Supersonic Jet," *Journal of Fluid Mechanics*, Vol. 669, 2011, pp. 225–241.

[12] Urbano, A., Selle, L., Staffelbach, G., Cuenot, B., Schmitt, T., Ducruix, S., and Candel, S., "Exploration of Combustion Instability in a Liquid Propellant Rocket Engine with Large Eddy Simulation," *Combustion and Flame*, Vol. 169, 2016, pp. 129–140.

[13] Crouch, J. D., Garbaruk, A., and Magidov, D., "Predicting the Onset of Flow Unsteadiness Based on Global Instability," *Journal of Computational Physics*, Vol. 224, 2007, pp. 924–940.

[14] Lehoucq, R. B., Sorensen, D. C., and Yang, C., *ARPACK Users' Guide*, SIAM, 1998.

[15] Stewart, G. W., "A Krylov–Schur Algorithm for Large Eigenproblems," *SIAM Journal on Matrix Analysis and Applications*, Vol. 23, No. 3, 2002, pp. 601–614; Hernandez, V., Roman, J. E., and Vidal, V., "SLEPc: A Scalable and Flexible Toolkit for the Solution of Eigenvalue Problems," *ACM TOMS*, Vol. 31, No. 3, 2005.

[16] Bagheri, S., Åkervik, E., Brandt, L., and Henningson, D. S., "Matrix-Free Methods for the Stability and Control of Boundary Layers," *AIAA Journal*, Vol. 47, No. 5, 2009.

[17] Juniper, M. P., and Sujith, R. I., "Sensitivity and Nonlinearity of Thermoacoustic Oscillations," *Annual Review of Fluid Mechanics*, Vol. 50, 2018, pp. 661–689; Balasubramanian, K., and Sujith, R. I., "Thermoacoustic Instability in a Rijke Tube: Non-normality and Nonlinearity," *Physics of Fluids*, Vol. 20, 2008.

[18] Culick, F. E. C., *Unsteady Motions in Combustion Chambers for Propulsion Systems*, RTO AGARDograph AG-AVT-039, 2006.

[19] Crocco, L., and Cheng, S.-I., *Theory of Combustion Instability in Liquid Propellant Rocket Motors*, AGARDograph No. 8, Butterworths, 1956.

[20] Noiray, N., Durox, D., Schuller, T., and Candel, S., "A Unified Framework for Nonlinear Combustion Instability Analysis Based on the Flame Describing Function," *Journal of Fluid Mechanics*, Vol. 615, 2008, pp. 139–167.

[21] Marble, F. E., and Candel, S. M., "Acoustic Disturbance from Gas Non-uniformities Convected Through a Nozzle," *Journal of Sound and Vibration*, Vol. 55, No. 2, 1977, pp. 225–243.

[22] Bell, W. A., and Zinn, B. T., "The Prediction of Three-Dimensional Liquid-Propellant Rocket Nozzle Admittances," NASA CR-121129, 1973 (and Crocco–Sirignano quasi-1-D admittance theory).

[23] Alnaes, M. S., et al., "The FEniCS Project Version 1.5," *Archive of Numerical Software*, Vol. 3, 2015; and the DOLFINx successor (FEniCSx).

[24] Beyn, W.-J., "An Integral Method for Solving Nonlinear Eigenvalue Problems," *Linear Algebra and its Applications*, Vol. 436, No. 10, 2012, pp. 3839–3863.

[25] Güttel, S., Van Beeumen, R., Meerbergen, K., and Michiels, W., "NLEIGS: A Class of Fully Rational Krylov Methods for Nonlinear Eigenvalue Problems," *SIAM Journal on Scientific Computing*, Vol. 36, No. 6, 2014; Güttel, S., and Tisseur, F., "The Nonlinear Eigenvalue Problem," *Acta Numerica*, Vol. 26, 2017, pp. 1–94.

[26] Dickerson, R. A., et al., "Correlation of Spray Injector Parameters with Rocket Engine Performance," AFRPL-TR-68-147, 1968; see also NASA SP-8089, *Liquid Rocket Engine Injectors*, 1976.

[27] Priem, R. J., and Heidmann, M. F., "Propellant Vaporization as a Design Criterion for Rocket-Engine Combustion Chambers," NASA TR R-67, 1960.

[28] Smith, G. P., et al., "GRI-Mech 3.0," http://combustion.berkeley.edu/gri-mech/.

[29] Goodwin, D. G., Moffat, H. K., Schoegl, I., Speth, R. L., and Weber, B. W., *Cantera: An Object-Oriented Software Toolkit for Chemical Kinetics, Thermodynamics, and Transport Processes* (software).

[30] Rupe, J. H., "The Liquid-Phase Mixing of a Pair of Impinging Streams," JPL Progress Report 20-195, 1953.

[31] Economon, T. D., Palacios, F., Copeland, S. R., Lukaczyk, T. W., and Alonso, J. J., "SU2: An Open-Source Suite for Multiphysics Simulation and Design," *AIAA Journal*, Vol. 54, No. 3, 2016, pp. 828–846.

[32] Dowling, A. P., "The Calculation of Thermoacoustic Oscillations," *Journal of Sound and Vibration*, Vol. 180, No. 4, 1995, pp. 557–581; Juniper, M. P., "Triggering in the Horizontal Rijke Tube: Non-normality, Transient Growth and Bypass Transition," *Journal of Fluid Mechanics*, Vol. 667, 2011, pp. 272–308.

[33] Yu, Y. C., Sisco, J. C., Rosen, S., Madhav, A., and Anderson, W. E., "Spontaneous Longitudinal Combustion Instability in a Continuously-Variable Resonance Combustor," *Journal of Propulsion and Power*, Vol. 28, No. 5, 2012, pp. 876–887.

[34] Gröning, S., Hardi, J. S., Suslov, D., and Oschwald, M., "Injector-Driven Combustion Instabilities in a Hydrogen/Oxygen Rocket Combustor," *Journal of Propulsion and Power*, Vol. 32, No. 3, 2016, pp. 560–573.

[35] EngineDesign project, "Combustion and Feed-System Stability for a Pressure-Fed LOX/CH₄ Unlike-Doublet Engine," `docs/stability/combustion_stability_physics.md`, v0.2 (companion physics reference for the lumped model in `engine/pipeline/stability/`).
