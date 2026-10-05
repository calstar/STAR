# Layer X result: data contract for the physics and GUI rebuild (2026-10-02, reconciled 2026-10-03)

The backend physics work and the GUI rebuild run in parallel. Both follow this file. Every key below is
**optional** in the TypeScript types: an old saved run has none of them, and the GUI shows
"not computed for this run" in that panel.

These rules apply throughout:
- Times are seconds on the twin's clock (`series.t`, Fire = 0) unless a block carries its own `t`.
- Pressures are **psia** (`*_psia`) or differences in **psi** (`*_psi`). Gauge is never stored in a
  run result: the GUI subtracts `provenance.derived.gauge_zero_pa`. (Exception, by design: the set
  point's `settings_card`, section 6, is what a person dials, so it is in psig and says so in its
  key names.)
- SI everywhere else.
- Every block that rests on a model carries `model: {name, source, assumptions: [str], inputs: {name: {value, unit, provenance}}}`,
  so the run record can list it. All of them are collected, flattened, in `provenance.models` (section 5).
- A block that failed is `{available: false, error: "..."}`. It never raises, and the burn stands.
  A block that is a list (`solenoids`, `water_hammer`, `outflow`, `ledger`) fails either whole (the
  `{available: false, error}` object in place of the list) or per row (a row carrying
  `available: false, error`).
- Lists that follow the series are as long as `series.t`, with `null` where undefined.

**Who computes what.** `engine/layerx/analysis.py: run_prepared(prep, ..., diagnostics=True, sidecars={})`
writes `diagnostics`, the soak-back, the stable event keys and the sidecar. The router asks for them on
every run a person starts (`POST /api/layerx/runs`). The tools that burn many candidates (uncertainty
sweep, set point, hardware, the legacy optimiser, injector holes) leave them off and grade their own
candidates. `limits`, `test_mode` and `provenance.models` are written on every result.

## 1. `result.limits`: one graded list, server-side

This replaces the three copies of the thresholds in `optimize.grade`, the `uncertainty` crossings and
the UI's `VERDICT`. The graders are `engine/layerx/diag/limits.py: grade(result) -> list`; the run's
list is `engine/layerx/analysis.py: grade_limits(result, prep, config, opts)`, which applies the
coordinator decisions below on top of it. Every threshold is in `diag/limits.py: THRESHOLDS`, with
its reasoning (the sweep reads the bottle and stiffness ones from there too).

```jsonc
[{
  "key": "chug_margin",          // stable id (the list below)
  "label": "Chug margin",        // stand words
  "group": "stability",          // stability | injector | tanks | pressurant | propellant | flight | hardware | model
  "value": 1.398,  "unit": "",   // SI or psi/psia as named; "%" for a percentage; "steps" for a count
  "limit": 1.0,    "warn": 1.2,  // the red line and the amber edge (either may be null)
  "direction": "min",            // "min": value must stay above the limit; "max": must stay below
  "grade": "ok",                 // ok | warn | bad | info ("info" is shown, never counted)
  "t_worst": 0.05, "index_worst": 12,   // series index (twin step) of the worst point; null if not time-resolved.
                                      // Flight entries are timed on RocketPy's samples: index_worst is the twin
                                      // step nearest t_worst, and series.t[index_worst] need not equal it
  "series_ref": "delivered.chug_margin",  // where the time history lives, for the margin bar jump
  "basis": "EngineDesign DTL chug model, config feed basis, ...",
  "hint": "one sentence: why this threshold",
  // optional, per entry:
  "decision": "D7",              // an AUDIT decision this entry waits on
  "review_pending": true,        // from a new diagnostic: graded amber at worst until reviewed
  "capped_from": "bad",          // the grade it would have had without that cap
  "frequency_hz": 21.8,          // chug entries: the frequency at the graded point
  "cap_source": "design_requirements" | "schema default",   // tank_cap_*
  "rating_source": "drawing" | "restated MEOP"              // tank_mawp_* / tank_meop_*
}]
```

**Keys.** `chug_margin`, `chug_margin_settled`, `chug_margin_other_basis`, `chug_margin_start`;
`stiffness_ox`, `stiffness_fuel`, `stiffness_ox_ignition`, `stiffness_fuel_ignition`;
`tank_mawp_ox|fuel`, `tank_meop_ox|fuel`, `tank_cap_ox|fuel`; `bottle_margin`; `regulator_wide_open`;
`tank_sag`; `depletion`, `depletion_tie`, `residual`; `saturation_<node id>`; `cavitation_ox|fuel`;
`water_hammer_<line id>`; `separation`; `rail_exit`, `static_margin_liftoff`, `static_margin_min`,
`max_q`, `apogee_ceiling`; `vessel_trip`, `unsettled`, `card_outside`, `engine_fit`, `solver`,
`conservation_mass_ox|fuel`, `conservation_pressurant`, `conservation_energy`; `limits_error` (a
block of the result that could not be graded; the others were).

**Coordinator decisions (2026-10-03), until the user decides:**
- **Chug (D7).** With `settings.chug_basis` unset or `config`, the graded `chug_margin` is today's:
  `delivered.chug_margin`'s whole-burn minimum, start included (`series_ref: delivered.chug_margin`).
  The stability block's settled minimum (from the first full-flow step) is listed beside it as
  `chug_margin_settled` and the drawing basis as `chug_margin_other_basis`, both `info`, both with
  `decision: "D7"`. With `chug_basis: drawing` (opt-in) the stability block is graded: its
  `settled_min` on the drawing basis, `chug_margin_start` (info) for the start window and
  `chug_margin_other_basis` (info) for the config basis.
- **New diagnostics grade amber at worst** (`review_pending: true`): `water_hammer_*`, `saturation_*`,
  `cavitation_*`, `separation`, `regulator_wide_open`, `outflow*`, `conservation_*`. Their ratings and
  thresholds are estimates. One that would have been red carries `capped_from: "bad"`.
- **The design's tank cap** (`tank_cap_*`, `design_requirements.max_*_tank_pressure_psi`, read as psia)
  grades `warn`, not `bad`, until D11 says whether it applies at T-0 or at the peak; a cap the design
  does not state (the schema's default) is `info` with `cap_source: "schema default"`.
- Every other limit keeps the grade `diag/limits.py` gives it.

## 2. `result.network`: the full feed network, every twin step

**Recorded on every Layer X burn** (2026-10-03): `analysis._burn_once` sets
`Probes(network=True)` and `reduce_trace` writes `result["network"] = network_dict(trace)` (lib/feedtwin
`feedtwin.session.burn`), every pass, so the result's block is the final pass's. Recording only: it reads
the sample each step already produced and changes no number (bit-identical on LE4 he_pad and on a GN2
burn, `tests/test_layerx_wire.py`). It adds ~0.35 MB to a run (LE4 he_pad: ~1.0 MB with it, 0.67 MB
without). A run saved before then has no `network`, and the blocks that need it (`ladder`, `regulator`,
`solenoids`, `saturation`, the pressurant floor) are
`{available: false, error: "no feed network was recorded for this run (result.network)"}`.

```jsonc
{
  "basis": "node values of each step's last network solve; ...",   // what the numbers are
  "t": [...],                                  // == series.t
  "nodes": { "<id>": { "label": "LOX tank outlet", "kind": "tank|junction|manifold|bottle|chamber|ambient|...",
                       "side": "ox|fuel|gas|null", "p_psia": [...], "T_K": [...], "phase": "gas|liquid" } },
  "branches": { "<id>": { "label": "LOX line 1", "kind": "line|valve|solenoid|regulator|orifice|fitting|check|relief|injector",
                          "from": "<node>", "to": "<node>", "side": "ox|fuel|gas",
                          "mdot": [...], "dp_psi": [...], "cv": 1.7, "state": [...] /* 0..1 open fraction, if a valve */,
                          "reversed": true /* only when a path runs it against its drawn direction */ } },
  "paths": { "ox":   ["<branch id>", ...],    // bottle -> regulator -> solenoid -> tank -> lines -> injector -> chamber
             "fuel": ["<branch id>", ...] }
}
```

`dp_psi` is `p(from) - p(to)` of one solve, positive downstream; liquid nodes carry the lumped-K
convention's pressures (total, not wall-static). A tank's liquid column is its own element,
`<tank>.head` (kind `tank_head`, ullage node to outlet node; negative: a gain). Branch kinds also include
`tank_head`; node kinds are `bottle | tank (an ullage) | tank_outlet | chamber | injector_inlet | ambient
(any other fixed pressure) | manifold | junction | port (one side of an inline symbol)`. Node values are
node values, not vessel states: a vessel node is the boundary value its solve started from (a tank's
`series.ox.outlet_psia` is the vessel's and can differ from its outlet node by ~0.1 psi; the bottle node
read 1651.4 psia against the vessel's 1645.6 at LE4 burnout). The rungs of each path add up, step by
step, to the bottle node minus the chamber node. A node's `T_K` is the enthalpy walk's; the chamber
node's is the arriving liquids' (not a gas temperature), and 0.0 means the walk did not reach it.

## 3. `result.diagnostics`: derived, per step

Each block is its module's under `engine/layerx/diag/` (named after the block), computed in this
order, so a block may read the ones before it: stability, hardware, the feed blocks (ladder,
regulator, solenoids, pressurant, saturation, cavitation, injector, thrust_shape, ledger: one call,
`ledger.build_feed_diagnostics`), start, outflow, shutdown (reads outflow), water_hammer (reads
start), vv. Keys marked *extra* are beyond what the GUI needs; they may be shown in hovers.

```jsonc
{
  "ladder": {                                   // bottle -> chamber, per side, at every step
    "t": [...],
    "ox":   { "elements": [{ "id", "label", "kind", "from", "to", "dp_psi": [...], "share": [...] }], "total_psi": [...],
              /* extra */ "start", "end", "sum_psi": [...], "residual_psi": [...], "max_abs_residual_psi", "closes": true },
    "fuel": { ... }, "basis"
  },
  "regulator": { "id", "label", "t": [...], "inlet_psia": [...], "outlet_psia": [...], "mdot": [...], "capacity_mdot": [...],
                 "use_frac": [...], "droop_psi": [...], "spe_psi": [...], "choked": [bool...],
                 "wide_open": [bool...], "cv": 0.8, "model": {...},
                 /* extra */ "inlet_T_K", "inlet_rho_kg_m3", "setpoint_psia", "dome_psia", "target_psia", "residual_psi", "x",
                 "any_wide_open", "use_frac_max", "rise": { "t0", "t1", "outlet_rise_psi", "spe_psi", "droop_psi", "dome_psi", "residual_psi" } },
  "solenoids": [{ "id", "label", "side", "cv", "dp_psi": [...], "share_of_reg_to_tank": [...],
                  /* extra */ "cv_provenance", "reg_to_tank_psi", "dp_iec_psi", "dp_iec_2cv_psi", "dp_max_psi", "share_max" }],
  "pressurant": { "species": "helium", "t": [...], "loaded_kg", "used_kg", "residual_kg", "required_kg", "margin_kg",
                  "bottle_T_K": [...], "jt_dT_K": [...], "model": {...},
                  /* extra */ "unusable_kg", "unusable_held_T_kg", "floor_psia", "floor_regulator_inlet_psia", "floor_bottle_T_K",
                  "floor_regulator_inlet_T_K", "floor_line_drop_psi", "floor_converged", "bottle_end_psia",
                  "bottle_T_end_isentropic_K", "margin_psi", "line_drop_end_psi", "t_end", "twin_dT_K", "jt_dT_range_K", "jt_basis" },
  "saturation": { "nodes": [{ "id", "label", "side", "margin_psi": [...], "min_psi", "t_min",
                              /* extra */ "fluid", "T_source", "margin_static_psi": [...], "min_static_psi", "t_min_static", "flagged" }],
                  "worst": { "id", "min_psi", "min_static_psi", "t_min" }, "flag_margin_psi", "skipped": [...], "model": {...} },
  "cavitation": { "t": [...],
                  "ox":   { "K": [...], "K_incipient", "L_over_d", "flip_risk": false, "min_K", "t_min",
                            /* extra */ "K_crit": [...], "margin": [...], "Cd_eff": [...], "p_v_psia": [...], "Cc", "r_over_d",
                            "inlet", "cavitates", "near", "min_margin", "T_source" },
                  "fuel": { ... }, "model": {...} },
                  // K = (p_up - p_v)/(p_up - p_c); K_crit = (Cd/Cc)^2 (Nurick 1976), not 1/Cc^2.
  "injector": { "t": [...], "v_ox": [...], "v_fuel": [...], "momentum_ratio": [...], "design_momentum_ratio",
                "resultant_angle_deg": [...], "eta_cstar": [...], "model": {...},
                /* extra */ "rupe_M": [...], "design_rupe_M", "momentum_ratio_band", "design_resultant_angle_deg",
                "Cd_eff_ox": [...], "Cd_eff_fuel": [...], "design_Cd": { "ox", "fuel" }, "design_eta_cstar",
                "eta_cstar_replay": { "t", "values" }, "range": {...}, "design_basis" },
  "stability": { "basis": "config|drawing", "t": [...], "margin": [...], "frequency_hz": [...],
                 "worst": { "t", "index", "margin", "frequency_hz" },          // whole burn, start included
                 "settled_min": { "t", "index", "margin", "frequency_hz" },    // from the first full-flow step
                 "start_window_s",
                 "nyquist": { "t", "omega": [...] /* rad/s */, "re": [...], "im": [...] },
                 "tau_sweep": { "tau_ms": [...], "margin": [...], "nominal_ms" },
                 "acoustic": [{ "line", "side", "length_m", "f_quarter_hz", "f_half_hz", "near_chug": false }],
                 "other_basis": { "basis", "margin_min", "t", "frequency_hz" }, "model": {...},
                 /* extra */ "eroded", "index", "replay_point", "in_start", "frequency_nominal_hz", "margin_nominal",
                 "margin_other": [...], "start": {...}, "check", "feed", "flags", "acoustic_flags", "unmeasured" },
                 // `basis` is settings.chug_basis (default config); the other basis is always computed.
                 // `t` is the replay's points: `index` maps them to series steps. Only whole-path
                 // acoustic rows are system modes; interior segments' rows are not.
  "hardware": { "t": [...], "throat_d_mm": [...], "At_ratio": [...], "eps": [...], "Lstar_m": [...],
                "contraction": [...], "liner_min_mm": [...], "insert_back_K": [...], "insert_back_basis": "adiabatic upper bound",
                "contour": { "x_mm": [...], "r0_mm": [...], "frames": { "t": [...], "r_mm": [[...]] }, "liner_r_mm"?: [...],
                             /* extra */ "x_face_mm", "x_liner_end_mm", "x_insert_mm", "insert_r_mm" },
                "separation": { "pe_pa": [...], "summerfield": [bool...], "schmucker_pa_crit_psia": [...],
                                "schmucker_pe_sep_psia": [...], "flag": false,
                                /* extra */ "pe_psia", "ambient_psia", "ratio", "M_exit", "schmucker_ratio", "schmucker",
                                "min_ratio", "t_min", "margin", "ambient_basis" },
                "isp": { "ideal_s": [...], "cstar_loss_s": [...], "nozzle_loss_s": [...], "delivered_s": [...],
                         /* extra */ "zeta_n_loss_s", "stagnation_loss_s", "Cf_vac_ideal", "eta_cstar", "zeta_n", "ambient_pa", "basis" },
                "soak": { "available", "peak_K", "t_peak_s", "station", "duration_s",
                          /* extra */ "t_95_s", "clock", "back_basis", "basis", "stations": [...] },
                "heatmap": "sidecar:axial" , "model": {...},
                /* extra */ "index", "replay_point", "summary": {...}, "series_span" },
  "thrust_shape": { "mean_N", "dev_max_pct", "dev_rms_pct", "target_N"?,
                    "breakdown": { "t": [...], "tank_pressure_N": [...], "erosion_N": [...], "accel_head_N": [...],
                                   /* extra */ "residual_N", "as_built_N", "fixed_feed_N", "dF_N", "at_end", ... },
                    /* extra */ "spread_pct", "min_N", "max_N", "end_minus_start_N", "window", "mean_minus_target_N",
                    "within_2pct_steps", "steps", "t_first_at_target", "target_source" },
  "start":    { "available", "t": [...], "pc_psia": [...], "mdot_ox": [...], "mdot_fuel": [...], "mr": [...],
                "fuel_lead_s", "valve_travel_s", "prime_ox_s", "prime_fuel_s", "ignition_s",
                "impulse_deficit_Ns", "hard_start": false, "model": {...},
                /* extra */ "thrust_N", "line_mdot_*", "valve_*", "settle_s", "impulse_deficit_pct", "window_deficit_Ns",
                "accounting", "hard_start_detail", "lead_fuel_kg", "prime_volume_L", "arrival_mdot", "arrival_orifice_psia",
                "steady_check", "card_clipped_frac", "events": [{ "key", "t", "label" }], "warnings", "unmeasured" },
                // The start model's own clock (Fire = 0); `fuel_lead_s` and `valve_travel_s` are settings
                // of this diagnostic only (the burn opens both mains at Fire, over the drawing's travel).
  "shutdown": { "first_dry": "ox|fuel", "mode": "LOX-rich|fuel-rich|simultaneous", "tail_mr_max", "model": {...},
                /* extra */ "first_dry_s", "first_dry_basis", "alone_side", "alone_kg", "alone_s", "lox_alone_kg", "lox_alone_s",
                "tail_ox_kg", "tail_fuel_kg", "end_ox_s", "end_fuel_s", "valve_command_s", "tie", "other_kg_at_first_dry",
                "note": { "grade", "text" }, "warnings", "unmeasured" },
                // mode "simultaneous": both sides stop within 1 ms.
                // tail_mr_max: the CUMULATIVE O/F of everything that flows after the first dry-out (LOX
                // over fuel, kg/kg; 0.36 on LE4, fuel-rich). Not an instantaneous maximum, which is
                // unbounded once one side has stopped. The key name is kept for the GUI.
  "water_hammer": [{ "line", "side", "closure_s", "joukowsky_psi", "slow_close_psi", "peak_psia", "rating_psia", "ok",
                     /* extra */ "valve", "moc_surge_psi", "peak_source", "close_peak_psia", "min_psia", "column_separation",
                     "opening": {...}, "rating_basis", "wave_speed_m_s", "v0_m_s", "length_m", "round_trip_s", "at_s",
                     "warnings", "unmeasured", "model": {...} }],
                     // `rating_psia` is the tank's MAWP + 1 atm (the only rating drawn); when the column
                     // separates (`column_separation`), `peak_psia` is graded on Joukowsky, which is NOT an
                     // upper bound then (cavity collapse can exceed it).
  "outflow": [{ "tank", "side", "ingestion_onset_s", "residual_kg", "outlet_d_mm", "model": {...},
                /* extra */ "residual_frac", "residual_band_kg": { "flat", "ellipsoidal_2to1", "hemispherical" },
                "onset_band_s": {...}, "h_c_mm", "level_end_mm", "outlet_froude", "impulse_at_risk_Ns", "head",
                "warnings", "unmeasured" }],
                // `residual_kg` is the flat-bottom (worst) case; `outlet_d_mm` is settings.outlet_d_mm or the
                // first drawn line's bore.
  "vv": { "mass": { "ox": { "loaded_kg", "burned_kg", "residual_kg", "trapped_kg", "error_pct" }, "fuel": {...} },
          "pressurant": { "bottle_out_kg", "ullage_in_kg", "vented_kg", "error_pct" },
          "energy": { "error_pct", "basis" },
          "convergence": [{ "pass", "throat_residual", "accel_residual" }],
          "dt_check"?: { "dt_s", "half_dt_s", "impulse_delta_pct", ... }, "model": {...} },
  "ledger": [{ "key", "label", "design_value", "unit", "delivered": { "min", "max", "mean" },
               "series_ref", "replaced": "yes|partly|no", "note" }]
}
```

**Separation, precisely.** Schmucker's criterion is `p_sep / p_a = (1.88 M_e - 1)^-0.64`
(Östlund & Muhammad-Klingmann, Appl. Mech. Rev. 58(3), 2005). Both forms are reported, per replay
point, in psia:
- `schmucker_pa_crit_psia` = `p_e / (1.88 M_e - 1)^-0.64`: the **ambient** pressure above which the
  nozzle separates at this exit pressure (~34 psia on LE4). Compare with `ambient_psia`.
- `schmucker_pe_sep_psia` = `p_a (1.88 M_e - 1)^-0.64`: the **exit** pressure below which it separates
  in this ambient (~5.5 psia on LE4). Compare with `pe_psia`; this is the "separates below" line on a
  plot of the exit pressure.
`flag` is true when either Summerfield (`p_e / p_a < 0.4`) or Schmucker predicts separation at any point.

## 4. Other additions

- `result.events[]` gains `key` (a stable id): `t0`, `fuel_lead`, `fire`, `ignition`, `min_tank_ox`,
  `min_tank_fuel`, `min_chug` (the graded chug margin's worst point), `dry_ox`, `dry_fuel`, `burnout`
  (the end of the burn; it coincides with the `dry_*` event when a tank ran dry, and with `trip` when a
  vessel trip stopped it), `trip`, `warn:<n>` (warnings, numbered in time order). Every event has one.
  Kinds: `t0 | fire | min | end | warn | fail`; `fuel_lead` and `ignition` are kind `fire`, `min_chug`
  kind `min`, `burnout` kind `end`, `trip` kind `fail` (the burn stopped there).
- `result.flight` (when flown): `pressurant_gas` (the gas the ullage and the COPV refill were priced as:
  the drawing's), `stability: { t: [...], static_margin_cal: [...], cg_m: [...], cp_m: [...], max_q_pa,
  max_q_t, rail_exit_m_s, /* extra */ diameter_m, datum, liftoff_static_margin_cal, min_static_margin_cal,
  min_static_margin_t, max_q_mach, max_q_speed_m_s, max_q_altitude_agl_m, rail_exit_t, rail_exit_required_m_s,
  rail_exit_static_margin_cal, available, model }` (`t` is the burn's clock).
  With `settings.flight_coupling: inline`: `coupling: "inline"` and `inline: { available, t: [...],
  accel_m_s2: [...], accel_g: [...], liftoff_mass_kg, liftoff_mass: { value, source, parts, notes },
  liftoff_time_s, end_altitude_m, end_velocity_m_s, vs_rocketpy, model }` (`vs_rocketpy`: the largest
  relative difference against RocketPy's specific force on the settled burn).
- `result.tripped`: `{ vessel, label, kind, t, p_psia, mawp_psia, message }`, or absent (lib/feedtwin's
  `trip_record`; `mawp_psia` is the absolute pressure the stand trips at, MAWP + 14.696). When present the
  burn stopped on the step that tripped: `series.t[-1] == tripped.t` (Layer X stamps that last sample at
  the trip, where the session stopped, not at the end of the 50 ms step), `summary.burn_time_s`, the
  impulse and every integral end there, `delivered` (when replayed) ends there too, `converged` is
  false, `passes` has one entry with `tripped: true` (a tripped pass is replayed once if it fired, never
  iterated, never flown: `flight` is `{ok: false, error: "not flown: ..."}`), the events carry a `fail`
  event keyed `trip` (no `Horizon reached`), `limits` carries `vessel_trip` graded `bad`, and the
  shutdown diagnostic is a cutoff at the trip with both tanks wet. Every tool counts a tripped burn as
  failing: set point and hardware (`burn_point` -> `tripped`, `usable` false), the uncertainty sweep (the
  case is `ok: false` with `tripped`, left out of the swings, listed as a crossing), the legacy optimiser
  (`vessel_trip` constraint) and reconcile (refuses to fit it). A trip in the settle, before the burn
  records a step, raises `analysis.StandTripped` (its `record` is the same block): the run fails with the
  trip's message. The run listing's `summary.tripped` carries `{vessel, label, t, p_psia, mawp_psia}`.
- `result.test_mode`: `hotfire` (the only mode modelled; `coldflow_water | coldflow_ln2` are reserved).
- `result.sidecars`: the names of this run's sidecars (`["axial"]`), fetched with
  `GET /api/layerx/runs/{id}/sidecar/{name}`:
  `axial` = `{ x_mm: [...], t: [...], q_MW_m2: [[...]], T_wall_K: [[...]], profile? }`, rows on `t`. They are
  large and loaded lazily; a run without one answers 404.
- Exports: `GET /api/layerx/runs/{id}/export/{fmt}` with `fmt` in `csv` (every signal, `name [unit]`
  headers), `parquet` (the same table typed; 501 when the server has no pyarrow), `fea` (a zip of
  `pc_t.csv`, `thrust_t.csv`, `heatflux_xt.csv`, `heatflux_profile_xt.csv` when the sidecar has a
  profile, `loads.json` and `README.txt`). Only a finished burn (`kind: run`, `status: done`) exports.

## 5. Provenance additions

- `provenance.models`: every model block in the result, flattened:
  `[{ block: "diagnostics.stability", name, source, assumptions: [str], inputs: {...} }]`
  (`diagnostics.*`, `flight.*`, and `engine_card.chamber` when the opt-in card nozzle was on).
- `provenance.derived.options`: the opt-in choices as the run resolved them (section 7), whatever the
  defaults become later.
- `provenance.derived.tank_rise_estimate`: preflight's estimate of the tanks at burnout
  `{ end_psia, rise_psi, bottle_end_psia, gas_kg, converged, basis }` (section 7, `tank_rise`).
- `provenance.diagnostics_wall_s`: `{ burn, diagnostics, blocks: { stability, hardware, feed, start, outflow,
  shutdown, water_hammer, vv, soak } }` [s]. On LE4 he_pad the diagnostics cost 3.0-3.5 s against a
  77 s burn (4-4.5 %), most of it the feed blocks and the soak-back.

## 6. Tool results (set point, hardware, change list)

`kind: setpoint` (`POST /api/layerx/setpoint`, `engine/layerx/setpoint.py`):
```jsonc
{ "mode": "setpoint",
  "target": { "mean_thrust_N", "source": "request|design_requirements.target_thrust", "tol_rel", "margin_psi" },
  "converged", "fill_status": "solved|...", "feasible",
  "settings_card": { "dome_psig", "lockup_psia", "copv_fill_psig", "dome_per_1000psi_fill",   // psi of dome per 1000 psi of fill
                     "full_bottle_psig", "dome_at_full_bottle_psig", "fuel_lead_s", "fuel_lead",
                     "pressurant", "drawing": { "id", "name", "sha256" }, "config_sha256", "ids": { "loader", "regulator", "bottle" } },
                     // what a person dials: psig, said in the key names
  "solution": { /* the answer's burn figures */ "lockup_psia", "dome_psig", "mean_thrust_N", "total_impulse_Ns",
                "burn_time_s", "of_mean", "copv_end_psia", "copv_spare_psi", "ox_peak_psia", "fuel_peak_psia",
                "ox_stiffness_min", "fuel_stiffness_min", "chug_margin_min", "throat_area_growth", "replayed", ... },
  "before": { /* the same figures at the current settings */ },
  "of": { "settable_here": false, "design_of", "design_of_source", "of_mean", "offset_rel", "per_100psi_lockup", "note" },
                     // one regulator presses both tanks: O/F is Hardware mode's
  "limits": [ /* section 1 rows, the answer's burn */ ], "limits_basis", "binding": [...],
  "history": [{ "lockup_psia", "fill_psig", "dome_psig", "dome_per_1000psi_fill", "figures", "limits", "ok",
                "converged", "tripped", "replay", "asked", "stage", "index", "tag", "preflight", "wall_s" }],
  "change_list": { /* below */ }, "model", "unmeasured": [...], "notes": [...], "burns", "wall_s", "workers",
  "summary": { "mean_thrust_N", "total_impulse_Ns", "burn_time_s", "of_mean", "lockup_psia", "dome_psig", "copv_psig", "feasible" },
  "basis" }
```
LE4 He, 7,200 N, replay on (2026-10-03, through the API): 5 burns, 357 s; lockup 597.79 psia, dome
516.05 psig, fill 3,482.7 psig (116 psi of bottle spare at burnout); 7,199.5 N; tanks peak 635 psia
(`tank_cap_*` amber).

`kind: hardware` (`POST /api/layerx/hardware`, `engine/layerx/optimize.py run_hardware`):
```jsonc
{ "mode": "hardware", "objective", "components": [...], "baseline": { /* figures, limits */ },
  "candidates": [{ "rank", "label", "changes", "figures", "limits_bad", "trim"? /* K, C, K_by_taps */ }],
  "winner", "improves", "setpoint", "final",
  "change_list": { "changes", "effects", "exports": { "settings_patch", "design_write", "pid_designer" } },
  "needs_pid_designer": [...], "catalog_problems": [...], "model", "trim_model",
  "target", "summary", "burns", "wall_s", "workers", "basis" }
```
LE4 He, LOX-line trim, objective `of_error`, replay off (2026-10-03, through the API): 4 candidates,
456 s; the 10.25 mm drill (K +0.220) moves O/F 1.5212 -> 1.4994; the winner's set point is re-solved to
the design's `target_thrust` (6,500 N; the audit found it stale, the stand is set for a 7.2 kN mean, D10): lockup 532.33 psia, dome
467.88 psig, 6,499.3 N at O/F 1.5007. Pass `target_thrust_N` to verify at another thrust.

The **change list** (`engine/layerx/diff.py`, schema `layerx.change-list/1`), shared by Set point,
Hardware and Injector holes (`reconcile`'s `result.change_list`):
```jsonc
{ "schema": "layerx.change-list/1", "tool": "setpoint|hardware|reconcile",
  "changes": [{ "component", "pid_node_id", "field", "before", "after", "unit", "provenance",
                "effect": { "<figure>": after - before }, "effect_basis",
                "cad_impact": "none|re-drill|new plate|new part|setting only",
                "target": "node:<id>|edge:<id>|design:<path>|op:<name>|model:<path>",
                "domain": "operation|drawing|design|model", "label",
                "source": "measured|manufacturer|estimated|solved|catalog|fitted|assumed",
                "before_provenance", "catalog"?, "drill"?, "note"? }],
  "effects": [{ "key", "label", "unit", "before", "after", "delta" }],
  "basis": {...}, "notes": [...], "needs_pid_designer": [...], "counts": { "<domain>": n } }
```
Nothing is written by a tool: `exports.design_write` describes the `PUT /api/config?expect_sha256=` call
(409 if the design moved; `requires_confirmation`), `exports.pid_designer` the patched `{nodes, edges}`
graph for pid-designer, `exports.settings_patch` the Layer X rail.

`GET /api/layerx/catalog`: the parts Hardware mode chooses from, `{ <kind>: [rows], drills: [...],
problems: [str] }` (`engine/layerx/catalog.py`): the shipped rows with the user's own over them by id
(`origin: shipped|user`); a user file that does not read is listed in `problems` and the shipped rows
stand. Each row's params carry their own `source`.

Old runs of `kind: trade` (the removed study) and `kind: optimize` (the compass search Set point and
Hardware replace) are listed and readable with `legacy: true`, read-only.

## 7. Settings additions (`LayerXSettings`, the router's `Settings`, `api/layerx.ts`)

All opt-in: unset (`null`) is exactly the behaviour before the setting existed.

| setting | values | unset means | changes |
|---|---|---|---|
| `chug_basis` | `config` \| `drawing` | `config`, graded on the whole-burn minimum | the graded chug margin (D7) |
| `chug_eroded` | bool | off: design-point A_t, V, L* in the chug model | reported chug margins |
| `card_eroded_nozzle` | bool | off: the card's as-built nozzle | the twin's thrust once a throat schedule applies (D4-B) |
| `flight_coupling` | `outer` \| `inline` | `outer`: burn, fly, burn again | the flown burn (D5-C) |
| `fuel_lead_s` | s, 0-5 | 0 (the DAQ table) | the start diagnostic only |
| `valve_travel_s` | s, 0-5 | the drawing's `travel_time` | the start diagnostic only |
| `outlet_d_mm` | mm, one or `[LOX, fuel]` | the first drawn line's bore | the gas-ingestion diagnostic only |
| `ack_gn2_condensation` | bool | refuse | lets a nitrogen-over-LOX hot fire run (see below) |
| `test_mode` | `hotfire` | `hotfire` | reserved for cold flows |

**Preflight checks added.**
- `gn2_condensation` (**fail**): the bottle holds nitrogen, the oxidiser tank holds LOX, the run is a hot
  fire, and the ullage's nitrogen (lockup less LOX's vapour pressure) is above nitrogen's saturation
  pressure at the LOX temperature (CoolProp; ~52 psia at 90 K; the drawing's tank temperature, else LOX's
  normal boiling point). `warn` instead with `ack_gn2_condensation`. Replaces the old warning above
  492.5 psia (nitrogen's critical pressure).
- `tank_rise` (**warn** over a rating, `info` otherwise): the tanks at burnout, estimated before the
  burn from the drawing's regulator law at the bottle's expected end pressure (the gas the tanks need
  at the end pressure, the bottle on its isentrope from its drawn temperature, zero flow), against
  each tank's MAWP across the wall and the design's stated tank cap. LE4 he: ~625 psia (+47 psi;
  the burn reaches 618/619) over the 600 psi cap.
- `card_eroded_nozzle` (info/warn) when that option is on; `options` (fail) for a value an opt-in
  setting cannot take.
