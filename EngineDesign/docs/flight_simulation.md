# Flight Simulation: `/simulate`, tank capacity, and propellant regimes

This document covers the **Flight Simulation → Manual iteration** path: the `POST /api/flight/simulate`
endpoint, how loadable propellant mass is resolved from config, and how the response's
propellant diagnostics classify a run into one of three regimes.

For the constrained sizing question ("what burn time reaches a target apogee with the least
fuel?") see [`flight_altitude_optimization.md`](flight_altitude_optimization.md), which documents
`POST /api/flight/optimize-altitude`. Both endpoints share the request shape and tank-capacity
logic described here.

**Implementation:** `backend/routers/flight.py`, `engine/pipeline/tank_capacity.py`,
UI in `frontend/src/components/FlightSimulation.tsx`.

---

## Endpoints

| Method & path | Purpose |
|---|---|
| `POST /api/flight/simulate` | Fly a **fixed** time-series thrust/mass-flow curve with a given propellant load and rocket/environment config. Returns apogee, max velocity, trajectory, truncation info, and propellant diagnostics. |
| `POST /api/flight/optimize-altitude` | Search burn time for the minimum-fuel load that reaches a target apogee (see the altitude-optimization doc). |
| `GET /api/flight/check` | Probe whether RocketPy is importable in the backend environment. |

Flight sim is **time-series only**: the caller supplies `time_array`, `thrust_array`,
`mdot_O_array`, and `mdot_F_array` (from time-series analysis). The curve is fixed — burn time is
*how much of the profile you fly*, not an independent knob.

### `POST /api/flight/simulate`

Request (`FlightSimRequest`):

| Field | Type | Notes |
|---|---|---|
| `time_array`, `thrust_array`, `mdot_O_array`, `mdot_F_array` | `float[]` (≥2) | Fixed time-series curve: time [s], thrust [N], LOX/fuel mass flow [kg/s]. |
| `lox_mass_kg`, `fuel_mass_kg` | `float` > 0 | Requested propellant load (before tank caps). Defaults 18.0 / 4.0. |
| `lox_tank`, `fuel_tank` | `TankConfig?` | Tank geometry/volume for mass caps (see below). |
| `environment` | `EnvironmentConfig?` | Launch site elevation, latitude/longitude, etc. |
| `rocket` | `RocketConfig?` | Dry mass, radius, fins, nozzle position — RocketPy rocket build. |

Response (`FlightSimResponse`): `apogee_m` / `apogee_ft`, `max_velocity_m_s`, `flight_time_s`,
`trajectory` (time / altitude AGL / velocity), `truncation` (`TruncationInfo`), `propellant`
(`PropellantDiagnostics`, see below), `thrust_curve` actually flown, and a base64 `rocket_diagram`
PNG. On failure `status` is non-`"success"` and `error` carries the message.

---

## Tank capacity: max loadable propellant from config

Requested `lox_mass_kg` / `fuel_mass_kg` are **capped to what the tank can physically hold**.
`_apply_propellant_mass_caps` delegates to `engine/pipeline/tank_capacity.py`, which resolves the
per-tank maximum by this priority (`resolve_max_propellant_mass_kg`):

1. **Explicit mass cap** — `design_requirements.{lox,fuel}_tank_capacity_kg`, if set (> 0), is used
   directly as the max loadable mass.
2. **Volume × density × fill** — `tank_volume_m3 × density × fill_factor`, if `tank_volume_m3` is set.
3. **Cylinder geometry** — `π · radius² · height × density × fill_factor`, from the tank section's
   height/radius attributes (`lox_h`/`lox_radius`, `rp1_h`/`rp1_radius`).

`fill_factor` comes from `design_requirements.propellant_tank_fill_factor` (valid range `0 < ff ≤ 1`,
**default `0.90`**). It is still reported in diagnostics even when an explicit `*_tank_capacity_kg`
cap is used.

> **Note:** `flight.py` still contains a legacy `calculate_tank_capacity(...)` helper that defaults to
> a `0.95` fill factor. It is **superseded** by `tank_capacity.py` (default `0.90`), which is what the
> live `/simulate` and `/optimize-altitude` paths call. Treat `tank_capacity.py` as authoritative.

Public API (`engine/pipeline/tank_capacity.py`):

- `resolve_propellant_tank_fill_factor(config) -> float`
- `resolve_cylindrical_tank_volume_m3(tank_section, *, height_attr, radius_attr) -> float`
- `resolve_max_propellant_mass_kg(config, *, branch, density_kg_m3, tank_section, height_attr, radius_attr, capacity_kg_attr) -> (max_mass_kg, volume_m3, fill_factor, used_explicit_capacity)`
- `resolve_lox_tank_limits(config, density_kg_m3)` / `resolve_fuel_tank_limits(config, density_kg_m3)`

When a requested mass exceeds the resolved cap, the load is clamped and a `MassCapInfo` entry
(`requested_kg`, `effective_kg`, `max_fill_kg`, `fill_factor`, `tank_volume_m3`, `was_capped`) plus a
human-readable warning are attached to the diagnostics.

---

## Propellant regimes

`_compute_propellant_diagnostics` compares the **effective** loaded propellant against what the
(possibly truncated) burn actually requires — `lox_required` / `fuel_required` are the integrals of
`mdot_O`/`mdot_F` over the effective burn window — and classifies the run into one `regime`:

| Regime | Meaning | Typical fix |
|---|---|---|
| `truncated` | Loaded propellant (or a tank cap) ran out before the time-series burn completed. Burn cut off early at `effective_burn_time_s`. | Load more propellant, shorten the time-series burn, or enlarge the tank. |
| `full_burn` | Loaded propellant matches requirement within tolerance (both branches within ~0.5–2% of required) — the whole curve flies with no meaningful dead weight. | Nominal. |
| `excess_propellant` | Full burn completes but ≥1 branch carries >2% more than required; the extra mass lowers apogee. | Trim toward the required amounts to optimize altitude. |

The classification tolerances live in `_compute_propellant_diagnostics`: full-burn requires both
`effective ≥ required × 0.995`; excess is flagged when either `effective > required × 1.02`.

`PropellantDiagnostics` also reports `timeseries_burn_time_s` vs `effective_burn_time_s`,
`total_impulse_Ns`, per-branch required/requested/effective masses, tank maxima,
`propellant_tank_fill_factor`, the `mass_caps` map, and any `warnings` (tank-cap notes,
"tank max below full-burn requirement", truncation details).

---

## Related

- [`flight_altitude_optimization.md`](flight_altitude_optimization.md) — minimum-fuel burn-time search to a target apogee.
- [`CONFIG_SYSTEM.md`](CONFIG_SYSTEM.md) — config model and the `design_requirements` block these fields live in.
