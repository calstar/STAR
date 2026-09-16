# The chug conversion lag: double time lag, and how the model was chosen

**Status:** implemented and shipping as the default.
**Code:** `engine/pipeline/stability/timelag.py`, wired in `engine/pipeline/stability/analysis.py`.
**Benchmark:** `scripts/chug_timelag_benchmark.py` — run it before changing any number in this
document.

---

## 1. Why this exists

The chug loop (`chug.py`) needs exactly one number per propellant stream: the lag between an
injection-rate perturbation and the heat release it eventually produces. Everything else in the loop
— feed inertance, injector conductance, chamber gain — is geometry and can be measured. The lag is
where the *propellant* and the *injector* enter the stability problem, which makes it the one place
that must not quietly assume either.

Before this change it assumed both. `build_stability_inputs` ran

```python
core.lags_from_smd(D32, k_g=..., rho_l=..., cp_g=..., T_inf=Tc, T_boil=..., h_fg=..., chi=1.0)
```

on **both** streams unconditionally. That is the quiescent d²-law droplet lifetime, and it has three
problems that are invisible in the output:

1. **It has no notion of phase.** Run it on a gaseous propellant — GH2, GOX, gaseous methane — and it
   returns a droplet lifetime for something that has no droplets. The number is not wrong by a
   factor; it is a category error, and nothing in the payload said so.
2. **It is only the vaporization term.** Atomization and mixing are missing entirely, so the lag is
   systematically short and the chug margin systematically optimistic — the dangerous direction.
3. **It rides on `k_g`, the hot-gas thermal conductivity**, a property nobody on this program
   measures. Across a plausible band (0.35–0.70 W/m·K for H₂-rich products) the predicted lag moves
   by a factor of two.

## 2. The model

From Leonardi, Nasuti, Di Matteo & Steelant, *"A methodology to study the possible occurrence of
chugging in liquid rocket engines during transient start-up"*, **Acta Astronautica 139 (2017)
344–356** — hereafter **L17** — the conversion lag decomposes (L17 eq. 5) as

$$\tau_{tot} = \tau_{atom} + \tau_{vap} + \tau_{mix}$$

**Phase decides which terms exist at all.** L17 §3.2: the gaseous propellant carries only
$\tau_{mix}$, because a gas neither atomizes nor vaporizes. This is the structural fix, and it is
applied under *both* lag models — it is a correctness repair, not new physics.

### Atomization — L17 eq. 6–7

$$\tau_{atom} = 6\times10^{-4}\left(\frac{\rho_g}{\rho_l}\right)^{-0.32} We_g^{0.03}\, Re_l^{0.55}\,\frac{D_l}{u_l}$$

with $Re_l = u_l D_l \rho_l/\mu_l$ and $We_g = 2\rho_g (u_g-u_l)^2 D_l/\sigma_l$. $D_l$ is the liquid
post inner diameter and $u_l$ the injection velocity; both come from whichever injector the config
names (see §4).

### Vaporization — L17 eq. 9

$$\tau_{vap} = \frac{D_0^2}{k},\qquad k = 10^{-6}\left[\frac{1.01}{1+MR} + 1.16\times10^{-3}(T_\infty - T_{cr})^{0.93}\right]^{0.86}$$

$T_{cr}$ is the **liquid critical temperature** — a propellant property, so it lives on `FluidConfig`
(`critical_temperature`), sourced from the config, then CoolProp, then a handbook table, with every
fallback recorded.

$D_0$ is the initial drop size, taken from the injector's own spray solve (Ingebo for impinging,
Lefebvre for coaxial, the sheet model for pintle).

> **L17 eq. 10 is deliberately not implemented.** It is a $D_0$ correlation "specifically developed
> for coaxial injectors and liquid oxygen" — adopting it would hardcode one injector and one
> oxidizer into a multi-injector, multi-propellant tool, which is the coupling this work removes. It
> is also not dimensionally closed as printed (the exponents 2.25 and −2.65 do not cancel), so its
> units cannot be reconstructed from L17 alone.

### Mixing — calibrated ratio

L17 reads $\tau_{mix}$ off Szuch's empirical curve of mixing time versus $L_{50}$, the length to
vaporize 50 % of the liquid (NASA TN-D-7026, L17 fig. 1). That curve is a figure, not a table, and is
not reproduced here — digitizing it by eye would be inventing a correlation.

What L17 *does* state numerically is its own calibration point: $\tau_{vap} = 4.4$ ms and
$\tau_{mix} = 2.2$ ms for the validation engine (L17 §3.1), a ratio of **0.5**. Since $L_{50}$ is
itself proportional to $\tau_{vap}$ at fixed droplet speed (`MASS_HALF_LIFE_FRACTION` = $1-2^{-2/3}$
= 0.370, a closed form under the d² law), a constant of proportionality is the faithful reduction of
that curve to one number.

So `stability.mixing_lag_fraction` defaults to 0.5 and carries L17's provenance. It is **shared by
every stream** and scales off the **slowest liquid** stream — with two liquids, mixing cannot
complete until both are vapour. To replace it with a digitized curve, replace
`timelag.resolve_mixing_lag`; do not tune the 0.5.

## 3. Which model is more accurate — the measurement

The anchor is L17's validation engine, itself a re-analysis of the NASA GH2/LOX chug rig of L17
ref. [25]: a **measured** chug frequency (66 Hz), a **measured** stability boundary
($\Delta p_{ox}/p_c \approx 0.35$ at $\Delta p_{fu}/p_c = 0.5$), and one propellant injected as a gas.

`scripts/chug_timelag_benchmark.py` scores each model end-to-end through `chug.py` on both measured
quantities. Score = |frequency error| + |boundary error|, in percent; lower is better.

| lags from | τ_O | τ_F | f pred | boundary | score |
|---|---|---|---|---|---|
| L17's own hand-calibrated lags *(reference)* | 6.60 ms | 2.20 ms | 58.6 Hz | 0.28 | **30** |
| **`leonardi_dtl`, `convection=none`** | 7.48 ms | 2.49 ms | 53.0 Hz | 0.30 | **35** |
| `leonardi_dtl`, `convection=leonardi_eq8` | 3.25 ms | 1.08 ms | 104.1 Hz | 0.20 | 102 |
| `leonardi_dtl`, `convection=ranz_marshall` | 1.65 ms | 0.55 ms | 183.3 Hz | 0.12 | 243 |
| `d2_law` + mixing, k_g = 0.35 | 3.86 ms | 1.29 ms | 90.5 Hz | 0.22 | 75 |
| `d2_law` + mixing, k_g = 0.70 | 1.93 ms | 0.64 ms | 160.6 Hz | 0.14 | 205 |
| `d2_law`, no mixing — **STAR before this change** | 1.80 ms | 0.00 ms | 170.2 Hz | 0.12 | **222** |

**`leonardi_dtl` with no convection correction wins by 6.3× over what STAR shipped**, and lands
within a few points of L17's own hand-tuned lags. It is therefore the default everywhere —
Layer-1's per-evaluation gate as well as the rich report — because the accuracy gap is not close
enough to justify running two different physics in the same program.

Two further points from the benchmark:

* **The single largest gain is including τ_mix at all.** Today's model has no mixing term, and the
  gaseous-fuel stream had *no lag whatsoever*.
* **`d2_law`'s score spans 75 → 205 across the k_g band alone.** `leonardi_dtl` has no k_g dependence:
  the hot-gas conductivity drops out of the lag entirely.

### Why the convection correction ships OFF

L17 eq. 8 divides the quiescent lifetime by $1+1.5\alpha$, $\alpha = 1-3\times10^{-3} p_c\,[\text{bar}]$.
Applying it makes the model worse, three ways:

1. **Against the anchor.** Eq. 9 in its quiescent form gives 4.98 ms at L17's own reference point
   (D₀ = 83 µm, MR 5, 44.8 bar, 2038 K) against the experiment-derived 4.4 ms — **+13 %**. With
   eq. 8 it becomes 2.17 ms, **−51 %**.
2. **End-to-end**, it triples the combined error (35 → 102 in the table above).
3. **Against the textbook.** It depends on chamber pressure *alone* — no slip velocity, no drop size
   — and it *falls* as $p_c$ rises, while Ranz–Marshall does not. Benchmark C prints both.

The coherent reading is that eq. 9's $k$ was already calibrated against real chamber data (L17 routes
its 4.4 ms through Priem–Heidmann's $L_{50}/v_{inj}$), so it *contains* the convective enhancement and
eq. 8 double-counts it. That also reconciles L17's two otherwise-inconsistent statements about the
same working point — the paper reports D₀ = 83 µm *and* τ_vap = 4.4 ms, which eq. 8–9 as printed
cannot both satisfy (118 µm would be needed).

Both corrections stay available through `CONVECTION_MODELS` so the run report can say which one
produced the answer.

### What the benchmark does **not** establish

Both models underpredict the total lag against this one rig, and one rig is one rig. The GH2/LOX
anchor is the only published chug case found with a measured boundary *and* a gas-phase propellant;
no STAR-propellant (LOX/ethanol, LOX/CH₄, LOX/RP-1) chug measurement was available to score against.
Treat the absolute lag as good to roughly a factor of 1.5 and the *relative* ranking of designs as
the trustworthy output.

## 4. What stopped being hardcoded

| was | now |
|---|---|
| d²-law run on both streams regardless of phase | `injection_phase` per fluid (explicit or inferred from T vs critical point); a gas carries only τ_mix |
| `tau_sens = chi * tau_conv_O` — the oxidizer assumed rate-limiting | slowest **liquid** stream, whichever side it is |
| `D32_O or 80e-6`, `D32_F or 60e-6` | SMD from the injector's own spray model; a missing one is recorded via `assume()` |
| `rho_O = inp.get("rho_O", 1140.0)` (LOX behind every oxidizer) | config-sourced; missing value recorded |
| `Cd = ... else 0.6` | solved Cd; missing value recorded |
| η sweep fixed at 0.08–0.45 for every engine | window anchored to the design point (`_eta_window`) |
| `T_crit` absent — no model needed it | `FluidConfig.critical_temperature`, config → CoolProp → handbook, every fallback recorded |
| frontend legend hardcoded "O (LOX)" / "F (fuel)" | actual fluid names and phases from the payload |
| jet diameter unavailable to the lag model | `_jet_geometry` resolves it for impinging / coaxial / pintle, and returns NaN (recorded) rather than a stand-in when the injector type has no equivalent dimension |

## 5. The root locus

`chug.chug_root_locus` tracks the dominant eigenvalue of $1 + L(s) = 0$ through the s-plane as
$\eta_{inj}$ sweeps, by continuation from the softest injector upward. `report.py` emits it as
`chug.root_locus`, plus `chug.eta_critical` — where the branch crosses the imaginary axis, which is
the injector stiffness the engine has to beat.

The damping ratio was corrected to the standard $\zeta = -\sigma/|s|$ (it was $-\sigma/\omega$, which
is $\zeta/\sqrt{1-\zeta^2}$: indistinguishable below $\zeta \approx 0.1$, 15 % off at $\zeta = 0.5$,
and enough to put a plotted pole off its own constant-ζ ray).

**Caveat on the locus:** the sweep moves both streams to the same $\eta_{inj}$, while the design-point
eigenvalue is solved at each stream's own $\eta$ — so the design marker sits *near* the branch, not
exactly on it, whenever the two injector stiffnesses differ. The UI says so.

## 6. Running the benchmark

```bash
python3 scripts/chug_timelag_benchmark.py
```

Five benchmarks, all against external anchors: (A) `chug.py` vs the measured frequency and boundary
using L17's own lags, (B) each lag model vs the experiment-derived τ_vap, (C) L17 eq. 8 vs
Ranz–Marshall, (D) blast radius on STAR-class engines, (E) the decider — each model end-to-end
against both measured quantities. Exit code is non-zero if any criterion regresses.

Unit tests live in `tests/test_stability_timelag.py`. **Note that `tests/test_stability_*.py` is
gitignored repo-wide** (`.gitignore:93`, "local-only tests"), so neither these nor the pre-existing
stability tests run in CI.
