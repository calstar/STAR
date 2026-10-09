# Physical parameters that are hard to reach

A running list of numbers that describe real hardware or real physics, change the answer, and
are not easy for a user to see or set. Add to it as you find them. Each entry says where the
number lives, how to change it today, and what it moves.

Status key: **form** = has a field in a purpose-built form · **config** = only in the
Configuration editor or the YAML · **code** = a module constant; no way to change it without
editing source.

---

## Injector holes and Cd

### Hole L/d (`discharge.<side>.orifice_l_over_d`)

- **Status:** form (Chamber Geometry → Injector hardware → *Holes and Cd*), and config.
- **What it moves:**
  - the Cd, but only when an inlet treatment is set (see the next entry);
  - with channels on the back, how far each hole runs before it opens into its channel, and so
    the channel depth.

  One number per propellant does both, so the drawing and the Cd cannot disagree.
- **How Cd depends on it:** `engine/core/discharge.py` `cd_length_factor`. The default
  `piecewise` model is flat from L/d 2 to 5, so 4 → 5 changes nothing. Above 5 it drops
  1.2 %/L/d, with a floor of 0.85. `lichtarowicz` uses the published sharp-inlet fit
  (Cd = 0.827 − 0.0085 L/d, valid 2–10) and has a slope everywhere.
- **What a change does to Δp.** The holes keep their diameter, so the injector drop scales as
  (Cd_before / Cd_after)² at the same mass flow. At the same drop, flow scales as
  Cd_after / Cd_before. The Injector hardware form shows both as you type. The Cd it shows
  comes from the backend's own model (`layout._report_cd`), not a copy in the frontend.
- **Forward solve:** tank pressures are held, so a lower Cd means less flow and a lower Pc.
  The real change falls between the two numbers above.
- **Layer 1:** L/d is **not** a design variable. It reads this value, evaluates every
  candidate with that Cd (`runner.evaluate`), and scores the achieved Δp/Pc against its band
  (next section). If you change L/d and re-run, Layer 1 resizes the holes and tank pressures
  to put Δp back in the band.

### Inlet treatment (`discharge.<side>.inlet_geometry`, `inlet_radius_ratio`)

- **Status:** `inlet_geometry` is in the form; `inlet_radius_ratio` is config only (and
  overrides the named treatment when set).
- **What it moves:** the short-tube Cd — sharp 0.80, chamfered 0.84, conical 0.86, light
  radius 0.85, rounded 0.88, bellmouth 0.95. **Without an inlet, Cd comes from the hole
  diameter and L/d has no effect at all.** The form says so when that is the case.
- **Table:** `INLET_GEOMETRY_CD` in `engine/core/discharge.py` (code). These are
  practitioner anchors at Re > 1e4, L/d 2–5.

### Diameter-scaled Cd (`Cd_inf`, `a_Re`, `Cd_min`, `use_geometry_cd`, `d_ref_m`, `cd_small_hole_exponent`, `cd_large_hole_log_gain`, `cd_inf_max`, `cd_inf_min_geom`)

- **Status:** config.
- **What it moves:** the Cd when no inlet is set. It is a thin-plate model (0.60 at 2 mm).
  A drilled hole with a sharp entry and L/d 2–5 is closer to 0.80, so this path under-predicts
  a real injector by about 24 % unless an inlet is set.

### Counterbore entrance loss (`COUNTERBORE_ENTRANCE_K = 0.5`)

- **Status:** code (`engine/core/discharge.py`).
- **What it moves:** Cd of a hole fed through a counterbore (plenum-back plates only), through
  the velocity-of-approach term.

### Reynolds and cavitation constants

- `a_Re` (config) sets Cd(Re) = Cd∞ − a_Re/√Re. It is negligible at injector Re.
- Nurick's contraction coefficient Cc0 = 0.62, used for the cavitation margin report
  (`engine/core/discharge.py`, code). This is reporting only; it moves no flow.

---

## Pressure budget

### Injector Δp/Pc band (`injector_dp_ratio_O_min/max`, `injector_dp_ratio_F_min/max`)

- **Status:** config (design_requirements). The Layer 1 tab shows the achieved ratio against
  the band, but there is no field to set the band.
- **Default:** 0.20–0.40 for both sides (`_LAYER1_DEFAULT_DP_O_BAND` in
  `layer1_static_optimization.py`).
- **What it moves:** where Layer 1 puts the holes and tank pressures. `W_DP_CENTER` (500)
  pulls toward the middle of the band, `W_DP` (160) and `W_DP_HIGH` (480) penalise leaving
  it. The weights are config (Layer 1 constants) with no UI.

### Feed-line losses (`feed_system.*`: `line_size`, `d_inlet`, `A_hydraulic`, `length`, `phi_type`)

- **Status:** config.
- **What it moves:** the pressure left at the injector inlet for a given tank pressure. So it
  sets how much of the tank-to-chamber budget the injector actually gets. `length` also feeds
  the chug (low-frequency stability) model, whose verdict is sensitive to it.

---

## Injector geometry defaults (layout)

All in `engine/core/injectors/layout.py` (code unless noted):

| constant | value | what it is |
|---|---|---|
| `PLATE_THICKNESS_DEFAULT` | 12.7 mm | plug thickness when `layer1_injector_plate_thickness_m` is unset (form field exists) |
| `EXIT_LAND_DEFAULT` | 0.5 mm | metal around each exit on its flank, and between a hole and its channel wall (form: *Land around exits*) |
| `ORIFICE_LD_MIN` | 4 | SP-8089's minimum hole L/d for a jet that leaves on axis (warning threshold) |
| `DRILL_LD_PRACTICE_MAX` | 10 | twist-drill practice limit (warning threshold) |
| `FREE_JET_MAX_D` | 7 | free-jet length before breakup, in diameters (warning threshold) |
| `FACE_HEATING_INCLUDED_DEG` | 90° | included angle past which SP-8089 warns of face heating |
| `DRILL_ENTRY_MAX_OFF_SQUARE_DEG` | 10° | drill-maker limit for entering a surface off square |

### Igniter wall (`layer1_injector_min_web_m`)

- **Status:** config (design requirement).
- **What it moves:** the minimum web between holes on a ring, and now also the wall around the
  igniter thread. That sets the centre keep-out (thread OD + 2 × web) and the width of a
  thickened centre boss.

---

## How to add an entry

Name the parameter by its config key or constant. Give where it lives, how to change it today
(form / config / code), what it moves, and anything surprising, e.g. "does nothing unless X".
If you fix the access problem, change the status rather than deleting the entry, so the list
shows what was reachable when.
