# Combustion Efficiency Redesign — Rupe Mixing Model

**Status:** design for review (step a). No code changed yet.
**Goal:** make `eta_cstar` reflect real, design-sensitive physics instead of a hardcoded
step-function. Most-accurate, not RPA-matching.

---

## 1. What's wrong today

`eta_cstar = eta_Lstar × eta_kinetics × eta_mixing × eta_turbulence × cooling`

For a well-designed impinging engine (large L*, hot chamber) the first three saturate to **1.0**,
so the entire haircut is `eta_turbulence`, which is:

```python
if turbulence_intensity < 0.05:    # always true for impinging
    eta_turbulence = 0.9           # → every impinging engine = 0.90, flat
```

driven by `turbulence_intensity = 0.16·Re^(-1/8)` — the **fully-developed pipe-flow inlet**
correlation describing the liquid stream *inside the orifice* (~3%), misapplied as (a) the chamber
mixing turbulence and (b) a standalone c* multiplier. Two defects:

1. **No standard basis.** Liquid-rocket c* efficiency = vaporization × mixing × kinetics. There is no
   independent "turbulence efficiency" axis; turbulence acts *through* mixing/atomization.
2. **Double-count + always-on floor.** The same `ti` feeds `eta_mixing`'s k-ε closure *and*
   `eta_turbulence`; and because the pipe correlation is structurally ~3%, the 0.05 step always fires.

`eta_mixing` itself is also broken-by-saturation: its near-field k-ε Damköhler is huge, so it returns
1.0 — i.e., **perfect mixing**, which no real injector achieves.

---

## 2. Target architecture

$$\eta_{c^*} = \eta_{vap}\;\cdot\;\eta_{kin}\;\cdot\;\eta_{mix}\;\cdot\;\eta_{cool}$$

| term | source | change |
|---|---|---|
| `eta_vap` (= current `eta_Lstar`) | Priem–Heidmann-style finite-rate gasification | **keep** |
| `eta_kin` | Damköhler (τ_res/τ_chem) | **keep** |
| `eta_mix` | **NEW — Rupe momentum-ratio mixing efficiency** | **replace** the saturating k-ε model |
| `eta_turbulence` | step-function | **delete** |
| `eta_cool` | external cooling factor | keep |

Net: one term changes (`eta_mix`), one is deleted (`eta_turbulence`). `eta_vap`/`eta_kin` already
land at 1.0 here for the right reasons (L* large, T high), so the new `eta_mix` becomes the dominant —
and *design-sensitive* — efficiency driver.

---

## 3. The new mixing model (Rupe E_m)

### 3.1 Physical basis
Rupe (JPL, 1956) defined the **mixing efficiency E_m** as the uniformity of the local mixture-ratio
distribution across the spray. E_m = 1 ⇒ every fluid element is at the overall MR; E_m < 1 ⇒
fuel-rich and ox-rich pockets coexist, and off-MR pockets release less chemical energy ⇒ lower c*.

For **impinging doublets**, the controlling design variable is the **momentum (dynamic-pressure)
ratio** of the impinging streams. Balanced momenta ⇒ the resultant spray fan is axial and symmetric
⇒ most uniform mass distribution ⇒ peak E_m. Imbalance deflects the combined jet toward the stronger
stream and stratifies MR. (Rupe 1956; Elverum & Morey; **NASA SP-8089** *Liquid Rocket Engine
Injectors*; Sutton & Biblarz Ch. 9.)

We already compute the exact governing quantity:
`momentum_ratio_R = √(ρ_O·v_O² / ρ_F·v_F²)`  (≈1.0 at the current design; the Layer-1 optimizer
already targets `0.9 ≤ R ≤ 1.1`).

### 3.2 Model form (log-Gaussian about the balanced point)

$$\eta_{mix} = E_{m,\text{peak}} \cdot \exp\!\left[-\frac{\left(\ln(R/R_{opt})\right)^2}{2\,\sigma^2}\right]$$

- `R` = `momentum_ratio_R`
- `R_opt` = balanced-impingement optimum
- `σ` = sensitivity width
- `E_m,peak` = best achievable mixing efficiency for the injector class

**Why log-Gaussian:** symmetric in *ratio* space — an ox/fuel imbalance of 2× is penalized exactly
like 0.5× (physically correct), smooth (no steps/floors), single clear peak at `R_opt`.

### 3.3 `R_opt` — geometric, not a magic constant
For an unlike doublet the transverse momenta cancel when
`ṁ_O u_O sinθ_O = ṁ_F u_F sinθ_F`. With the code's √(dynamic-pressure) convention this corresponds to

$$R_{opt} = \sqrt{\frac{\sin\theta_F}{\sin\theta_O}}$$

so `R_opt` is **derived from the impingement angles** (your config: θ_O=76.4°, θ_F=71.7° ⇒
R_opt ≈ 0.985, essentially 1). Default to this geometric value; allow a config override. This keeps
the optimum tied to the actual injector geometry instead of a hardcoded 1.0.

### 3.4 Constants and how they're anchored (the honest part)
These are the *only* two free constants, and they must be **anchored, not invented**:

| const | proposed default | basis / how to calibrate |
|---|---|---|
| `E_m_peak` | **0.96** | SP-8089 / Sutton hot-fire energy-release mixing band (0.95–0.98) for a well-formed doublet with adequate L*. Calibrate to a measured c* efficiency if hot-fire data exists. |
| `sigma` (σ) | **1.5** | Shape anchor: ≤1% drop across the optimizer's 0.9–1.1 band; ~12% drop at R=2 (badly mismatched). See curve below. |

Resulting curve with these defaults:

| R (momentum ratio) | η_mix | interpretation |
|---|---|---|
| 1.0 (balanced) | 0.960 | peak |
| 0.9 / 1.1 | ~0.959 | in optimizer band — negligible loss |
| 1.5 | ~0.925 | noticeable |
| 2.0 | ~0.863 | badly mismatched |
| 3.0 | ~0.734 | poor |

> Both constants live in `CombustionEfficiencyConfig`; nothing hardcoded in the physics body.

### 3.5 Optional secondary refinement (NOT in v1)
Rupe also found finer patterns (more, smaller elements ⇒ shorter inter-element diffusion length) mix
better. Could add a weak `η_mix *= f(d_jet, spacing, L*)` term later. Deliberately **excluded from v1**
to keep one dominant, defensible physical driver (momentum ratio). Flagging only.

---

## 4. Expected result for the 8000 N / 600 psi engine

At R≈1.0: `eta_mix ≈ 0.96`, `eta_vap = eta_kin = 1.0` ⇒ **`eta_cstar ≈ 0.96`** (vs the artificial 0.90).

| quantity | now (eta=0.90) | new (eta≈0.96) | RPA / hand calc |
|---|---|---|---|
| Isp @600psi tank | ~241 s | ~**256 s** (est.) | ~278–285 s |
| mdot for 8000 N | ~3.3 kg/s | ~**2.9 kg/s** (est.) | ~2.86 kg/s |

This lands the model **between** the old over-penalty and RPA's optimistic flat efficiency — which is
the point: ~0.96 is the *mixing-limited* truth for a balanced doublet; if RPA assumed 0.98+, RPA was
optimistic. (Estimates pending the `E_m_peak` anchor.) 8000 N at 600 psi then needs only a small
throat bump, ΔP in window — feasible.

---

## 5. Config changes

Add to `CombustionEfficiencyConfig`:
```yaml
combustion:
  efficiency:
    mixing_model: rupe          # new; default 'rupe'. 'legacy_keps' kept for A/B only.
    Em_peak: 0.96               # peak mixing efficiency (calibratable)
    mixing_sigma: 1.5           # log-Gaussian width about R_opt
    R_opt: null                 # null ⇒ derive from impingement angles; else override
```
Deprecate/retire: `eta_turbulence` branch and `target_turbulence_intensity` /
`turbulence_penalty_exponent` (already marked deprecated). The pipe-flow `ti` stays computed as a
**diagnostic only** (verify it isn't consumed by the stability model before removing its efficiency
role — pre-implementation check).

---

## 6. Implementation plan (step b, after you approve)

1. Add the Rupe `eta_mix` function + config fields; default `mixing_model: rupe`.
2. Delete the `eta_turbulence` term from `calculate_combustion_efficiency_advanced`; remove its
   factor from the product.
3. Keep `legacy_keps` mixing reachable via config for one A/B cycle, then remove.
4. Confirm `turbulence_intensity_mix` has no downstream consumer besides the deleted terms
   (grep stability/closure); demote to diagnostic.
5. A/B on the 8000 N engine: print old vs new η_c*, Isp, mdot at 600/720 psi.
6. Re-baseline canonical anchors; update golden files intentionally (with a note that this is the
   efficiency-model correction, not a regression).
7. Native parity: the C kernel computes the same efficiency product — port the same change or confirm
   the Layer-1 native seam falls back/│matches. (Check `ed_combustion_physics.c`.)

## 7. Open questions for you
1. `E_m_peak` default: accept **0.96** (literature), or do you have a measured c* efficiency from a
   real doublet to calibrate against?
2. `R_opt`: derive from impingement angles (recommended) or pin to 1.0?
3. Keep `legacy_keps` selectable for a while, or hard-replace?
