# Discharge Coefficient (Cd) Calculation Methodology

Cd models **injector orifice** flow only. Feed-system losses use `feed_system` (K0, K1, hydraulic area) separately.

---

## Overview

The discharge coefficient is the ratio of actual to ideal incompressible orifice flow:

$$\dot{m} = C_d \cdot A \cdot \sqrt{2 \rho \Delta P_{inj}}$$

Cd is computed **dynamically** from:

1. **Orifice diameter** `d_hyd` (jet `d_jet` for impinging; orifice OD / annulus hydraulic diameter for pintle)
2. **Reynolds number** at the hole
3. Optional pressure / temperature corrections (off by default)

---

## Geometry-based Cd_inf (impinging jets)

For **matched LOX/fuel impinging holes**, both streams use the same correlation with baseline **Cd_inf = 0.60** at **d_ref = 2 mm**.

Research basis:

| Source | Finding |
|--------|---------|
| ASME MFC-3M / ISO 5167 thin-plate sharp orifice | Cd ≈ **0.595–0.602** at Re > 10⁴ |
| Rocket injector handbooks (Huzel & Huang, Sutton) | Drilled / EDM holes **0.55–0.65** depending on edge radius and L/t |
| Idelchik | Small L/d sharp holes ≈ 0.60; long tubes add friction |

Model in `engine/core/discharge.py`:

- **d = d_ref (2 mm):** `Cd_inf = 0.60`
- **d < d_ref:** `Cd_inf = 0.60 × (d/d_ref)^0.20` (small-hole penalty, floor **0.48**)
- **d > d_ref:** `Cd_inf = 0.60 + 0.015 × ln(d/d_ref)`, cap **0.62**
- Then Re correction: `Cd(Re) = Cd_inf,eff − a_Re / √Re`, clamped to `[Cd_min, Cd_inf,eff]`

Set `use_geometry_cd: false` on `discharge` to use a fixed `Cd_inf` (legacy behaviour).

---

## Reynolds number

$$Re = \frac{\rho \, u \, d_{hyd}}{\mu}$$

---

## Configuration (`configs/default.yaml`)

LOX and fuel share the same discharge block shape:

```yaml
discharge:
  oxidizer:
    Cd_inf: 0.6          # baseline at d_ref_m
    use_geometry_cd: true
    d_ref_m: 0.002
    cd_small_hole_exponent: 0.20
    cd_large_hole_log_gain: 0.015
    cd_inf_max: 0.62
    cd_inf_min_geom: 0.48
    a_Re: 0.18
    Cd_min: 0.35
  fuel: { same structure }
```

---

## Manufacturing levers (what to machine to hit the model)

| Feature | Effect |
|---------|--------|
| Inlet edge radius | Largest lever: sharp square edge → Cd ≈ 0.55–0.60; radiused → up to ~0.62 |
| Hole diameter `d_jet` | Drives `Cd_inf` via geometry model and Re at operating ΔP |
| Plate thickness / L/d | Fixed in correlation via small-hole penalty below d_ref |
| Surface finish in bore | Secondary; matters most at low Re |

Hot-fire calibration: fit `Cd_inf` or `d_ref_m` from measured ṁ vs ΔP at one diameter, then scale other holes with the geometry law.

---

## Source files

| File | Role |
|------|------|
| `engine/core/discharge.py` | `cd_inf_from_orifice_diameter`, `cd_from_re` |
| `engine/core/injectors/impinging.py` | Passes `d_jet` into Cd each closure iteration |
| `engine/pipeline/config_schemas.py` | `DischargeConfig` |
