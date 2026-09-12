# P0/P1 progress notes: eigensolver core + verification cases V1, V2, V3 + contour path

**Status:** P0 verification ladder complete; P1 begun (real-geometry mesh path done).
V1 (uniform closed-closed cylinder, passive), V2 (temperature-jump duct, passive), and
V3 (n–τ flame duct with choked end, the first genuine NLEVP) are all green — the
paper's P0 exit criterion ("V1–V3 green") is met, with the caveat that the Beyn
completeness audit is P3 scope (see §9). The P1 contour→mesh path (§10) is green.
Package: `engine/stability_hifi/` (new, does not touch `engine/pipeline/stability/`).
Tests: `tests/test_stability_hifi_v1.py` (3 tests), `tests/test_stability_hifi_v2.py`
(3 tests), `tests/test_stability_hifi_v3.py` (6 tests),
`tests/test_stability_hifi_contour.py` (9 tests) — all passing.

This note walks through the math from the weak form (Eq. 10 of the stability paper)
down to the matrices actually assembled in code, so the derivation is checkable without
reading the source. It also records the review pass on the paper itself.

---

## 1. What V1 checks

A rigid-walled, uniform-property, closed-closed cylinder has a known closed-form
acoustic spectrum:

$$
f_{m,n,k} = \frac{c}{2\pi}\sqrt{\left(\frac{\alpha'_{m,n}}{R_c}\right)^2 + \left(\frac{k\pi}{L}\right)^2}
$$

where $\alpha'_{m,n}$ is the $n$-th zero of $J'_m$ (the hard-wall transverse
eigenvalue — same numbers as `engine.pipeline.stability.core.TRANSVERSE_EIGENVALUES`,
here obtained independently from a 2-D FEM solve rather than assumed) and $k$ is the
number of axial half-wavelengths ($k=0$ allowed). V1 is exactly this case with no flame
and no boundary admittance — it validates the mesh, the FEM assembly, the axis-regularity
handling, and the eigensolver, all at once, against a case with no free parameters.

## 2. From the weak form to three matrices

Passive, rigid-wall Eq. (10) reduces to

$$
\underbrace{\int_\Omega c^2\,\nabla\tilde p\cdot\nabla\bar\phi\; r\,d\Omega}_{K}
\;+\; m^2\underbrace{\int_\Omega \frac{c^2}{r}\,\tilde p\,\bar\phi\;d\Omega}_{K_m}
\;+\;\lambda^2\underbrace{\int_\Omega \tilde p\,\bar\phi\;r\,d\Omega}_{M_2} = 0,
$$

i.e. $(K + m^2 K_m)\,p = -\lambda^2 M_2\,p$. Writing $\mu = -\lambda^2$, this is an
ordinary **real-symmetric generalized eigenvalue problem** $A p = \mu M_2 p$ — no
flame delay, no frequency-dependent impedance, so none of the NLEVP machinery (Section
IV) is needed yet; $\mu \ge 0$ always (a lossless rigid cavity can't grow or decay), so
$\lambda$ is purely imaginary and $f = \sqrt{\mu}/2\pi$.

**Why K and M2 have closed forms but Km doesn't.** On a linear (P1) triangle, the shape
functions $N_i$ are the barycentric coordinates, and $\nabla N_i$ is *constant* over the
element. The radial coordinate $r$ is itself linear in position. So:
- $K$'s integrand is (constant) $\times$ (linear in $r$) — exact via the 1-point
  centroid rule, $\int_T r\,dA = \text{Area}\cdot \bar r$.
- $M_2$'s integrand $N_iN_j r$ is cubic (degree 2 from $N_iN_j$, degree 1 from $r$) —
  exact via the standard triangle monomial formula
  $\int_T L_1^aL_2^bL_3^c\,dA = \frac{a!b!c!}{(a+b+c+2)!}\,2\,\text{Area}$.
- $K_m$'s integrand $N_iN_j/r$ is **not polynomial** (r in the denominator) — no closed
  form exists, so it's the only piece evaluated by numerical (6-point Gauss) quadrature.

This means K and M2 carry *zero* quadrature error — only mesh discretization error —
which is why the convergence-order test below comes out so cleanly.

**Axis regularity** (Section III.E): for $m=0$ nothing is imposed — the $r\,d\Omega$
measure weakly enforces the Neumann condition automatically. For $m\ge1$, nodes on
$r=0$ are eliminated (essential Dirichlet $p=0$) before the solve.

## 3. Eigensolver

$A = K + m^2K_m$ and $M_2$ are both real, symmetric, positive semi-definite, so this is
solved with `scipy.sparse.linalg.eigsh` in shift-invert mode: one sparse factorization
of $(A - \sigma M_2)$, then symmetric Lanczos on its action. This is the real-symmetric
specialization of the shift-invert Krylov–Schur kernel the paper specifies for the
general (non-symmetric, delay-nonlinear) case — same mechanism, simpler because there's
no delay yet to make the problem nonlinear in $\lambda$.

## 4. Results

Cylinder: $c=1000$ m/s, $L=0.3$ m, $R=0.08$ m (arbitrary, chamber-scale). Mesh
100×50 nodes (5000 nodes, well under a second to assemble+solve for both $m=0,1$):

| mode | analytic (Hz) | FEM (Hz) | rel. error |
|---|---|---|---|
| m=0, axial k=1 | 1666.67 | 1666.74 | 0.0042% |
| m=0, axial k=2 | 3333.33 | 3333.89 | 0.0168% |
| m=0, axial k=3 | 5000.00 | 5001.89 | 0.0378% |
| m=0, radial 1R (α=3.8317), k=0 | 7622.94 | 7624.19 | 0.0164% |
| m=1 (1T), k=0 | 3662.92 | 3663.03 | 0.0031% |
| m=1, k=1 | 4024.27 | 4024.51 | 0.0060% |

(the 1R row above is a separate spot-check with the shift placed near 7 kHz, not part
of the automated test's lowest-4 comparison — at this geometry's chosen $L,R$ the true
lowest four m=0 modes are all pure-axial harmonics, so the automated test's "lowest 4"
doesn't happen to include a radial mode; the test still exercises the radial branch for
other geometries via `n_radial_max`.)

All entries above are **well under the paper's 0.1% acceptance bound**. Mesh-refinement
test: halving $h$ (40×20 → 80×40) shrinks the fundamental-mode error by a measured
factor of **~4.2×**, i.e. observed order $\approx \log_2(4.2) \approx 2.07$ — matching
the theoretical $O(h^{2p})$ for $p=1$ (linear) elements exactly as the paper's V1
acceptance criterion asks for.

## 5. One implementation note / one honest gap

- **Elements are linear (P1), not quadratic (P2) as the paper's production tier
  specifies.** This is a deliberate P0 simplicity choice (no FEniCSx dependency needed
  — see feasibility note below), not an oversight. It still clears the 0.1% bar
  comfortably at a 5000-node mesh solved in well under a second, so there's no pressure
  to upgrade to P2 for P0; P1/P2 (project phases, not element order — confusing overlap
  in terminology, sorry) can revisit if a finer accuracy/cost tradeoff is ever needed.
- **Mode matching pitfall (caught, not shipped):** my first pass at generating analytic
  comparison candidates truncated axial index $k$ at a small $k_\max$ *uniformly across
  radial branches*. That silently skips real modes (e.g. pure-axial $k=3,4,5$), so the
  truncated candidate list stops being the true sorted low end of the spectrum, and it
  was matching FEM's true lowest modes against the wrong analytic entries — a 30%+
  "error" that looked like a physics bug but was a test-harness bug. Fixed by generating
  a generously over-complete candidate set before truncating to the comparison count.
  Flagging this because it's the kind of mismatch that would be easy to miss silently in
  a more complex (non-analytic) validation case.

## 6. Feasibility check (for P1 planning)

Confirmed via `pip install --dry-run` on this machine (macOS arm64, Python 3.11):

| package | status |
|---|---|
| `gmsh`, `cantera` | pip wheels available (arm64 macOS) |
| `petsc4py`, `slepc4py` | pip wheels available (resolve to prebuilt `petsc`/`slepc` wheel packages) — better than expected |
| `fenics-dolfinx` | **no pip distribution at all** for macOS — needs conda-forge or a source/Docker build |
| `SU2` | no pip package — manual binary download or source build |

So P0's scipy-only path needed zero new dependencies (confirmed by this build). P1's
FEniCSx assumption needs revisiting: either accept the hand-rolled assembly style used
here (extended to P2 elements and the true chamber contour), or take on a conda-forge
dependency the rest of the repo doesn't have.

## 7. Paper review notes (asked-for critical pass)

- Section II.A's summary of the lumped model was checked line-by-line against
  `engine/pipeline/stability/{core,chug,acoustic}.py` — accurate, no misrepresentation.
- References: Bell & Zinn NASA CR-121129 (1973, Georgia Tech) and helmholtz-x
  (Ekrem Ekici, University of Cambridge, *Engineering with Computers* 2025) both
  verified correct.
- Robin BC (Eq. 8) and the Marble–Candel compact admittance (Appendix C) were
  re-derived from scratch — both correct and self-consistent.
- **Real issue found:** the velocity-coupling flame term (Eq. 7b) has its $\lambda$
  cancel against the $1/\lambda$ introduced by $\hat u = -\nabla\hat p/(\lambda\bar\rho)$
  substitution, so the assembled contribution is $\lambda$-independent. The paper's
  parenthetical claim that velocity coupling "replaces $b_k$ by the gradient-sampling
  functional" (implying a drop-in swap into the same $\lambda F(\lambda)p$ slot) is
  imprecise — $F(\lambda)$ itself needs an explicit $1/\lambda$ folded in for that
  coupling. Consequence: $N(\lambda)$ has a simple pole at $\lambda=0$ under velocity
  coupling, so it's holomorphic only on $\mathbb{C}\setminus\{0\}$, not entire — harmless
  for Beyn's method in practice (no acoustic mode of interest sits at the origin) but
  worth stating as an explicit caveat rather than an unqualified holomorphy claim.

---

## 8. Verification case V2: temperature-jump duct

The paper (Section VII.A) names this case ("1-D duct with temperature jump, passive...
checks: nonuniform-c̄ handling") but does not give its analytic solution, so the
reference formula below is an original derivation, not a transcription — worth being
extra careful with, and in fact I got it wrong on the first pass (kept below because
the mistake is as instructive as the fix).

**Setup.** A duct of length $L=L_1+L_2$, uniform sound speed $c_1$ on $[0,L_1]$ and
$c_2$ on $[L_1,L]$, rigid ("closed") ends at $x=0,L$. Only $\bar c$ is nonuniform —
same rigid BCs and no flame, isolating exactly the one new thing V2 is meant to test.

**First attempt (wrong).** In each uniform zone, Eq. (6) reduces to $\hat p''=-k_i^2\hat p$
with $k_i=\omega/c_i$, giving $\hat p_1=A_1\cos(k_1x)$, $\hat p_2=A_2\cos(k_2(x-L))$ (each
already satisfying its end's rigid condition). I assumed the interface matching condition
was continuity of **mass flux** $\bar\rho\hat u$ — the standard rule in general duct
acoustics when gas properties change. Using $\hat u=-\nabla\hat p/(\lambda\bar\rho)$, that
gives $\partial_x\hat p_1=\partial_x\hat p_2$, and eliminating $A_1,A_2$:
$k_1\tan(k_1L_1)+k_2\tan(k_2L_2)=0$.

**Why it was wrong, and how the error was caught.** This formula passed the obvious
sanity check (uniform limit $c_1=c_2$ recovers V1's $f=nc/2L$ spectrum) but disagreed
with the independently-built FEM solution by several percent — *and that error did not
shrink under mesh refinement*, which (per the V1 convergence test) is the signature of
a wrong reference answer, not discretization error. The mistake: "mass-flux continuity"
assumes a mean flow physically carrying mass across the interface, but Section III.C's
Helmholtz reduction assumes a *quiescent* mean flow ($\bar u\approx0$) — there is no
throughflow here, just still gas with a spatial temperature variation. Going back to
the pair of equations Eq. (6) was combined from (Eq. 4), the energy equation uses the
volumetric dilatation $\nabla\cdot u'$ directly (a kinematic quantity, not a mass flux),
under Appendix B's assumption that $\gamma\bar p$ (not $\bar\rho$) is spatially uniform.
Integrating that equation across a vanishingly thin control volume at the interface
forces **$\hat u$ itself** — not $\bar\rho\hat u$ — to be continuous. Equivalently
(since $\bar c^2=\gamma\bar p/\bar\rho$ with $\gamma\bar p$ the same both sides),
continuity of $\hat u$ is the same statement as continuity of $\bar c^2\partial_x\hat p$
— which is *also exactly the natural boundary condition the FEM weak form enforces on
its own* at any element edge where $c$ jumps. That the corrected physics argument and
the FEM's automatic behavior agree is a good consistency check in itself.

**Corrected relation:** $c_1\tan(k_1L_1)+c_2\tan(k_2L_2)=0$ (an extra factor of $c_i$
relative to the wrong version, since $c_i^2 k_i=c_i\omega$). This is why the uniform-
limit check alone didn't catch the bug: both forms collapse to the same thing when
$c_1=c_2$, since the check can't distinguish which power of $c_i$ belongs in the
formula — it's necessary but not sufficient. Root-found in the pole-free form
$g(\omega)=c_1\sin(k_1L_1)\cos(k_2L_2)+c_2\cos(k_1L_1)\sin(k_2L_2)=0$ (multiplying
through by $\cos(k_1L_1)\cos(k_2L_2)$ removes $\tan$'s poles, which otherwise look like
spurious sign changes to a naive root-finder).

**Implementation note: representing a genuine discontinuity in FEM.** A real jump in
$c$ can't live on a single shared mesh node (it would need two values at once), so
`assemble_passive` was extended to accept either a per-node field (existing V1 usage —
appropriate for any smoothly-varying mean flow, averaged per element via the P1
interpolant) or a **per-element** field (new — the material is piecewise-constant per
zone, assigned directly with no averaging). The mesh is built so the interface falls
exactly on a shared node column (`two_zone_duct_mesh`), so no element straddles it and
the per-element assignment is unambiguous.

**Results** ($c_1=900$, $c_2=1300$ m/s, $L_1=L_2=0.15$ m, $R=0.04$ m, 100×100×50-node
mesh): all four compared modes land under 0.02% error (analytic vs. FEM: 1718.69 vs
1718.71 Hz, 3640.49 vs 3640.67 Hz, 5215.64 vs 5216.14 Hz, 7167.01 vs 7168.43 Hz).
Mesh-refinement test again shows clean $O(h^2)$ convergence, confirming the per-element
material path doesn't degrade accuracy relative to V1's smooth per-node path.

---

## 9. Verification case V3: n–τ flame duct (the first real NLEVP)

**What's new:** everything that makes the problem the paper's actual subject. V3 is
the first case where $\lambda$ enters *nonlinearly* — through the flame delay
$e^{-\lambda\tau}$ (Eq. 7a/11) — so it is the first exercise of the Section IV solver
hierarchy: Algorithm 1 (frozen-delay fixed point) and the bordered Newton polish
(Section IV.C). It also brings in the boundary-admittance matrix $C$ (Robin condition,
Eq. 8, with the Marble–Candel compact choked-nozzle admittance
$y_{noz}=(\gamma{-}1)\bar M_e/2$ of Appendix C) and the rank-1 flame matrix
$F(\lambda) = \text{gain}\cdot e^{-\lambda\tau}\,\mathbf{g}\mathbf{b}^\top$ of Eq. 11.

**Scope choices, stated rather than hidden:** (i) the NLEVP path is *dense*
(`numpy`/`scipy.linalg`, companion linearization solved by full `eig`) — the sparse
shift-invert Krylov machinery is already validated on the linear problem by V1/V2, and
V3's job is the delay handling, an orthogonal concern; production-scale meshes will
need the sparse kernel under the same two algorithms. (ii) "All three solvers agree"
in the paper's V3 row is, at P0, *two* solvers: Beyn contour integration is a
completeness audit scheduled for P3 per the paper's own phasing. (iii) The flame is
compact (delta in $x$, uniform in $r$) with one reference point — Eq. 7a lumped to the
simplest structure that still has the full delay nonlinearity.

**Configuration:** rigid end at $x{=}0$, choked admittance at $x{=}L$, flame sheet at
$x_f = L/3$; discrete form
$N(\lambda)p = [K + \lambda C + \lambda^2 M_2 - \lambda\,\text{gain}\,e^{-\lambda\tau}\mathbf{g}\mathbf{b}^\top]p = 0$,
where $\mathbf{b}$ is a plain point sample of $\hat p$ at the flame reference and
$\mathbf{g}$ is the $r$-weighted disk load $\int N_i\,r\,dr$ at $x_f$. The analytic
reference is a two-zone dispersion relation with the flame as a slope-jump interface
condition, root-found in pole-free product form (V2's lesson applied from the start).

### Three bugs caught on the way (each instructive)

1. **Conflating the two flame vectors ($\mathbf{g} = \mathbf{b}$).** Eq. 11's
   $\mathbf{g}_k$ (energy-injection weight, carries the $r\,d\Omega$ measure) and
   $\mathbf{b}_k$ (dimensionless point sample) have different physical roles. Using
   the point sample for both made the flame coupling scale-inconsistent with $K, M_2,
   C$ (all $r$-weighted): the coupling strength then depends unphysically on chamber
   radius, and even "tiny" gains moved modes by hundreds of Hz. Caught by a smell test
   (a nominally small parameter with a huge, non-shrinking effect) and fixed with a
   dedicated `disk_load_vector`. The clean signature that the fix is right: the
   closed-form 1L sensitivity $d\lambda/d(\text{gain}) = e^{-\lambda_0\tau}
   \cos^2(\pi x_f/L)/L$, in which $R$ **cancels exactly** — asserted in the test suite.
2. **Double-counted $R^2/2$ in the analytic reference.** The 1-D reduction's flame
   jump is $[\hat p'] = -\lambda\beta e^{-\lambda\tau}\hat p(x_f)$ with
   $\beta = \text{gain}/c^2$ — *not* $\text{gain}\cdot(R^2/2)/c^2$. The disk load's
   $R^2/2$ is matched by the same factor in the $r$-weighted measure of every other
   matrix, so it cancels. With the wrong $\beta$ the reference's flame coupling was
   $1/(R^2/2) = 5000\times$ too weak — presenting as "FEM growth rate 5000× larger
   than analytic" *while frequencies agreed to 0.003%*. Diagnostic that settled which
   side was wrong: the FEM answer was (a) mesh-converged (σ: −85.60 → −85.54 → −85.53
   under refinement — a wrong-discretization error would shrink) and (b) confirmed by
   first-order eigenvalue perturbation theory applied directly to the discrete
   matrices, an independent third method. Same class of error as V2's interface
   condition: the by-hand reference, not the code.
3. **Admittance reflection-coefficient sign in the reference script.** The zone-2
   solution's coefficient is $r_2 = (1-y)/(1+y)$ ($\lambda$-independent for a compact
   nozzle); an early script had $(y-s')/(y+s')$ = the negative. Caught by checking the
   *passive limit* of the active dispersion relation against the independently
   verified $\tanh(sL) = -y$ spectrum ($\sigma \approx -yc/L$, $f \approx nc/2L$).
   Rule adopted: always validate the flame-off limit of an active-flame reference
   before using it to judge the active code.

   (A fourth, minor one: the first perturbation-theory cross-check itself omitted a
   factor of $\lambda_0$ in $\partial N/\partial(\text{gain})$, since the flame enters
   $N$ as $-\lambda\,\text{gain}\,e^{-\lambda\tau}\mathbf{g}\mathbf{b}^\top$. With it,
   perturbation theory, finite differencing, and the dispersion relation all agree.)

### A phase-convention finding worth carrying forward

With the paper's pure-delay pressure coupling (Eq. 7a), a mode's Rayleigh driving goes
as $+\cos(\omega\tau)$ — cycle-averaged $\overline{p'q'} \propto |\hat p|^2\cos(\omega\tau)$,
so in-phase heat release drives and anti-phase damps. Verified numerically across a
$\tau$ sweep (σ = +78.4 at $\omega\tau{=}0.1\pi$, +57.7 at $0.25\pi$, ≈0 at $0.5\pi$,
−57.6 at $0.75\pi$, −80.1 at $0.9\pi$; antisymmetric about $\pi/2$ as $\cos$ demands).
The lumped model's $\sin(\omega\tau)$ driving (`acoustic.mode_driving_rate`) belongs to
the *difference* form $n[p'(t)-p'(t-\tau)]$, whose transfer $n(1-e^{-i\omega\tau})$ has
imaginary part $n\sin(\omega\tau)$. Both are legitimate n–τ closures, but their
instability τ-bands sit a quarter-period apart. **Consequences:** (i) any cross-check
between this framework and the lumped tier must translate conventions first; (ii) the
paper's campaign sanity assertion that "instability τ-bands should straddle
$\tau \approx (2k{+}1)/(2f)$" (Section VI) needs re-examination against whichever
coupling form is in force — for pure-delay Eq. 7a with positive gain, those are the
maximally *damped* bands, not the unstable ones; (iii) this feeds directly into the
open FTF-for-doublets question: whatever flame response is eventually adopted, its
phase convention must be pinned explicitly, because the two standard forms disagree
about *where* in τ the danger zones sit.

### Results

At $c{=}1000$ m/s, $L{=}0.3$ m, $x_f{=}0.1$ m, gain $=100$, $\omega\tau\approx\pi$,
choked end ($y_{noz}{=}0.02$), on the (30, 40, 4) development mesh:

| quantity | value |
|---|---|
| fixed point (9 iters) | $\lambda = -154.0576 + 10473.6405i$ |
| Newton polish (2 iters) | same to 10 digits |
| solver agreement | $5.0\times10^{-10}$ (criterion: $<10^{-6}$) |
| NLEVP residual $\|N(\lambda)p\|/\|p\|$ | $4.8\times10^{-12}$ |
| dispersion relation | $\lambda = -154.0091 + 10472.6906i$ |
| FEM vs analytic | $9.1\times10^{-5}$ (criterion: $<1\%$) |

Physical decomposition checks out: total σ = −154.1 ≈ nozzle-only damping (−66.7,
itself matching the analytic $-y_{noz}c/L$) plus flame damping at anti-phase (−87.4).
The unstable-mode test (rigid end, $\omega\tau = 0.1\pi$) finds σ = **+78.4**, matching
the dispersion relation to the same accuracy — the tool demonstrably detects
instability, which is its entire purpose. Fixed-point iteration counts (4–9 observed)
sit in the paper's predicted 3–8 range; Newton then converges in ≤2 steps from the
fixed-point answer, exactly the intended division of labor.

---

## 10. P1 step 1: real chamber contour → meridional mesh

**What and why.** P1 replaces the synthetic rectangles with the true chamber shape.
The wall geometry deliberately *mirrors the hardware construction* in
`engine/core/chamber_geometry*.py` (the code behind the DXF export): cylindrical
section → straight 45° contraction cone → circular entrance arc of radius $1.5R_t$
tangent to both the cone and the throat (tangency at
$r = R_t[1 + 1.5(1-\cos\theta_c)]$, matching `contraction_length_horizontal_calc`
exactly). New module: `acoustics/contour.py`; checks in
`validation/contour_checks.py` + `tests/test_stability_hifi_contour.py`.

**Where the acoustic domain ends** (paper Section III.E). Never at the throat — the
mean flow is sonic there and the Helmholtz reduction requires low Mach. The domain is
truncated at a plane in the subsonic chamber and everything downstream is the
Marble–Candel compact admittance $y=(\gamma{-}1)\bar M_e/2$ *at that plane*, with
$\bar M_e$ from the subsonic branch of the isentropic area–Mach relation (implemented
and checked against γ=1.4 compressible-flow tables to 5 decimals). Two supported
conventions, chosen by `truncate_area_ratio`:
- `None` (default): truncate at the convergence-start plane — the classical treatment
  and the paper's own words ("nozzle-entrance plane"); the whole convergent section is
  part of "the compact nozzle". Lowest Mach at the BC plane (M ≈ 0.1 at CR 6), most
  comfortable for the Helmholtz assumptions; slightly overpredicts longitudinal
  frequencies since the convergent volume is excluded.
- A ratio in (1, CR): extend into the cone/arc to that area ratio (more accurate mode
  volumes; local Mach grows — keep the plane above area ratio ~1.6 (M ≲ 0.4) unless
  studying the sensitivity). Both conventions will be compared per-design; V6 later
  replaces the compact value with the quasi-1-D admittance ODE.

**Meshing a mapped domain.** The structured grid maps radially — node $(i,j)$ at
$(x_i,\ r_{wall}(x_i)\cdot j/(n_r{-}1))$ — with the *same* triangulation topology as
P0 (extracted into `mesh._grid_triangles`). Consequences: the axis row is exactly
$r=0$, every column is a constant-$x$ line (so `nodes_at_x(x_end)` finds the
admittance column exactly), segment breaks (cylinder/cone, cone/arc, truncation) are
exact node columns so no element straddles a wall-slope discontinuity, and *nothing*
in assembly/solvers changes. The rigid sloped wall is free: homogeneous Neumann is the
weak form's natural BC — imposed by not adding a boundary term.

**Verification** (four independent references, none of them the FEM itself):
| check | reference | result |
|---|---|---|
| area–Mach helper | γ=1.4 flow tables (M=0.5→1.33984, M=0.3→2.03507) | exact to 5 decimals |
| degenerate cylinder (default truncation) | V1 analytic formula, m=0 and 1T | <0.05% |
| revolved volume | adaptive quadrature of $\pi r_{wall}^2$; FEM side via $2\pi\sum_{ij}(M_2)_{ij}$ (rows of $M_2$ sum the shape functions to 1) | 3.6e-5 |
| gentle 10° taper modes | Webster horn equation $\frac{d}{dx}(A c^2 \frac{d\hat p}{dx}) + \omega^2 A \hat p = 0$ (the 1-D cross-section-averaged limit of Eq. 6; own model error O(tan²θ)≈3%) | 0.03–0.2% |

**One honest limitation, documented not hidden.** On the true 45° contour, the
cylinder→cone junction is a *reentrant corner* (fluid-side interior angle 225°): the
eigenfunction gradient has an $r^{\pi/\omega}$ singularity there ($\pi/\omega = 0.8$),
which classical corner theory says caps eigenvalue convergence near O($h^{1.6}$) on
uniform meshes — and the measured Richardson ratios indeed fall below the clean-O($h^2$)
value (compounded by per-segment column allocation not refining perfectly
proportionally on tiny segments). The convergence test therefore asserts monotone
convergence with a successive-difference ratio > 1.5 plus an *absolute* accuracy bound,
rather than pretending order 2. Practical impact is nil at engineering tolerances: the
coarse→fine 1L drift is ~1.5e-4 relative (0.6 Hz out of 3754), orders below
flame-parameter uncertainty. Graded corner meshes are the standard fix if ever needed.

**Physics sanity observed:** contraction raises the 1L frequency relative to a uniform
cylinder of the same total length (3754 Hz vs 3516 Hz here) — the narrowing end
stiffens the effective duct, consistent with Webster/horn intuition and with both
references agreeing on the gentle-taper case.

**Next (P1 continues):** the Stage-1 parametric mean-flow generator — burned-fraction
profile ψ(x) with vaporization length from the existing `spalding.py` chain, doublet
ring / pintle radial distributions, CEA-cache thermodynamics — producing a
`MeanFlowSpec` on these meshes; then the campaign layer (m-loop, Σ-sweep, margins,
report) per Algorithm 2.
