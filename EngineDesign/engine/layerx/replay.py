"""Phase 3: EngineDesign replays the twin's burn, with the chamber eroding as it goes.

The engine card (phase 2) is EngineDesign's injector and chamber at the geometry they were
built with. A real burn does not keep that geometry. The graphite throat and the ablative liner
recede, and on the 6.8 kN engine EngineDesign's coupled solver puts the throat ~5-6 % larger in
area by burnout. At the same line pressures that is ~3 % more flow and ~2.5 % less chamber
pressure late in the burn: the card alone cannot see it, and the feed system feels it, because
more flow drains the tanks faster and droops the regulator harder.

So the burn is closed in two passes that are iterated to agreement:

pass 1, the twin
    The feed system burns against the card. The card's chamber divides by the throat area,
    so the throat history from the previous replay is applied step by step (the first pass
    uses the as-built throat).
pass 2, EngineDesign
    The coupled time-varying solver (``TimeVaryingCoupledSolver``) runs at the line-exit
    pressures the twin delivered, with ablative and graphite recession integrated through
    the burn. The config is the line-exit copy (``engine/layerx/card.py``), so its "tank"
    pressures are exactly the twin's injector-face pressures.

Iterate until the throat history stops moving, which is usually two passes. The feed-system
answers (tank pressures, depletion time) are the twin's last pass. The engine answers (chamber
pressure, flow, thrust, Isp, recession) are EngineDesign's replay of that pass. Where the two
overlap, flow at the same inlet pressures, the disagreement is reported as the agreement, so
the hand-off between them is checked rather than assumed.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from engine.layerx.prepare import PSI, Prepared

#: Replay points across the firing window. Thrust and recession are smooth after the first
#: tenth of a second, so this is resolution to spare. Each point costs ~0.1 s.
REPLAY_POINTS = 28
#: The agreement loop stops when the applied throat history moved less than this (relative).
THROAT_TOLERANCE = 2.0e-4
#: Passes allowed before the loop reports that it did not settle.
MAX_PASSES = 4


def replay_indices(firing: Sequence[bool], n: int = REPLAY_POINTS) -> List[int]:
    """Indices of firing steps to replay: evenly spread, first and last always included."""
    fire = [i for i, f in enumerate(firing) if f]
    if len(fire) <= n:
        return fire
    picks = [fire[round(k * (len(fire) - 1) / (n - 1))] for k in range(n)]
    return sorted(dict.fromkeys(picks))


def erodes(config: Any) -> bool:
    """True when the engine has a wall that recedes: a graphite throat insert or an ablative liner.
    Such an engine is replayed on EngineDesign's coupled time-varying solver, and only on it."""
    gr = getattr(config, "graphite_insert", None)
    abl = getattr(config, "ablative_cooling", None)
    return bool((gr is not None and getattr(gr, "enabled", False)) or (abl is not None and getattr(abl, "enabled", False)))


def _number(v: Any, scale: float = 1.0) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f * scale if math.isfinite(f) else None


def _dig(d: Any, path: str) -> Any:
    for part in path.split("."):
        if not isinstance(d, dict):
            return None
        d = d.get(part)
    return d


#: Per-step scalars the chamber solve computes and the replay used to drop (audit 5.2), as
#: ``key -> (dotted path in the step's diagnostics, scale)``. Missing on an injector type that does
#: not compute one: the column is then all None.
DIAGNOSTIC_COLUMNS = {
    "momentum_ratio": ("momentum_ratio_R", 1.0),
    "rupe_M": ("rupe_M", 1.0),
    "rupe_Em": ("cstar_efficiency.rupe_Em", 1.0),
    "eta_vap": ("cstar_efficiency.eta_vaporization", 1.0),
    "eta_mix": ("cstar_efficiency.eta_mixing", 1.0),
    "eta_heat_loss": ("cstar_efficiency.eta_heat_loss", 1.0),
    "kappa": ("stagnation_loss_kappa", 1.0),
    "Cd_O": ("Cd_O", 1.0),
    "Cd_F": ("Cd_F", 1.0),
    "Cd_eff_O": ("Cd_eff_manifold_O", 1.0),
    "Cd_eff_F": ("Cd_eff_manifold_F", 1.0),
    "smd_O_um": ("D32_O", 1e6),
    "smd_F_um": ("D32_F", 1e6),
    "v_O_m_s": ("u_O", 1.0),
    "v_F_m_s": ("u_F", 1.0),
    "dp_injector_O_psi": ("delta_p_injector_O", 1.0 / PSI),
    "dp_injector_F_psi": ("delta_p_injector_F", 1.0 / PSI),
}

#: Per-step arrays of the coupled solver's results the replay used to drop: ``key -> (results key,
#: scale)``. Wall temperatures on LE4 are adiabatic-backed (no case declared): see
#: ``engine/layerx/diag/hardware.py`` for how they are labelled.
RESULT_COLUMNS = {
    "M_exit": ("M_exit", 1.0),
    "D_throat_mm": ("D_throat", 1e3),
    "D_chamber_mm": ("D_chamber", 1e3),
    "V_chamber_m3": ("V_chamber", 1.0),
    "A_exit_m2": ("A_exit", 1.0),
    "contraction_ratio": ("contraction_ratio", 1.0),
    "cstar_ideal": ("cstar_ideal", 1.0),
    "chug_frequency_hz": ("chugging_frequency", 1.0),
    "T_graphite_back_K": ("T_graphite_back", 1.0),
    "T_bondline_K": ("T_bondline", 1.0),
    "T_bondline_peak_K": ("T_bondline_peak", 1.0),
    "char_depth_chamber_mm": ("char_depth_chamber", 1e3),
    "recession_liner_peak_mm": ("recession_liner_peak", 1e3),
    "x_liner_peak_mm": ("x_liner_peak", 1e3),
    "q_conv_throat_MW_m2": ("q_conv_throat", 1e-6),
    "q_rad_throat_MW_m2": ("q_rad_throat", 1e-6),
    "q_chem_throat_MW_m2": ("q_chem_throat", 1e-6),
    "q_conv_chamber_MW_m2": ("q_conv_chamber", 1e-6),
    "q_rad_chamber_MW_m2": ("q_rad_chamber", 1e-6),
    "graphite_recession_rate_mm_s": ("graphite_recession_rate", 1e3),
    "liner_recession_rate_mm_s": ("ablative_recession_rate", 1e3),
}

#: Per-station fields kept from the coupled solver's ``stations`` read-out: ``key -> (field, scale)``.
STATION_FIELDS = {
    "recession_mm": ("receded", 1e3),
    "remaining_mm": ("remaining", 1e3),
    "T_surface_K": ("T_surface", 1.0),
    "T_back_K": ("T_back", 1.0),
    "T_interface_K": ("T_interface", 1.0),
    "q_net_MW_m2": ("q_net", 1e-6),
    "q_conv_MW_m2": ("q_conv", 1e-6),
    "q_rad_MW_m2": ("q_rad", 1e-6),
    "q_chem_MW_m2": ("q_chem", 1e-6),
}


def _stations(steps: Sequence[Optional[Dict[str, Dict[str, Any]]]]) -> Dict[str, Dict[str, Any]]:
    """The solver's per-step station read-outs as one record per station, columns over the replay."""
    names: List[str] = []
    for s in steps:
        for name in (s or {}):
            if name not in names:
                names.append(name)
    out: Dict[str, Dict[str, Any]] = {}
    for name in names:
        first = next((s[name] for s in steps if s and name in s), {})
        rec: Dict[str, Any] = {"x_mm": _number(first.get("x"), 1e3), "kind": first.get("kind")}
        for key, (field, scale) in STATION_FIELDS.items():
            rec[key] = [_number(((s or {}).get(name) or {}).get(field), scale) for s in steps]
        out[name] = rec
    return out


def _axial(t: Sequence[float], stations: Dict[str, Dict[str, Any]], diags: Sequence[Any]) -> Dict[str, Any]:
    """The axial profiles over the burn, for the ``axial`` sidecar (DATA-CONTRACT §4).

    Two bases, kept apart because they are not the same physics:

    * the top-level arrays are the transient wall stations (x along the wall, one column per
      station, one row per replay point): the gas-side load at each station's own surface
      temperature, that temperature, and the recession. These are what the erosion integrates.
    * ``profile`` is the chamber solve's whole-contour Bartz + radiation flux (278 points face to
      exit) at the quasi-steady liner surface temperature (``ablative_cooling.liner_response``,
      ``with_profile``): a display of where the gas loads the wall, evaluated at one wall
      temperature everywhere, not the transient wall. Each step's profile is drawn on its own
      redrawn contour; it is interpolated here onto the first step's x so the rows line up.
    """
    order = sorted(stations, key=lambda n: (stations[n]["x_mm"] if stations[n]["x_mm"] is not None else 0.0))
    rows = range(len(t))

    def grid(key: str) -> List[List[Optional[float]]]:
        return [[stations[n][key][k] for n in order] for k in rows]

    out: Dict[str, Any] = {
        "x_mm": [stations[n]["x_mm"] for n in order],
        "station": order,
        "kind": [stations[n]["kind"] for n in order],
        "t": [float(v) for v in t],
        "layout": "rows are t, columns are x_mm",
        "q_MW_m2": grid("q_net_MW_m2"),
        "T_wall_K": grid("T_surface_K"),
        "recession_mm": grid("recession_mm"),
        "T_back_K": grid("T_back_K"),
        "basis": ("EngineDesign TimeVaryingCoupledSolver wall stations: 1-D transient conduction per "
                  "station under Bartz convection, Leckner H2O/CO2 radiation and (graphite) carbon "
                  "oxidation; q is the net gas-side load at the station's own surface temperature, "
                  "frozen over the next replay interval"),
    }
    prof = [(_dig(d, "cooling.ablative") or {}) for d in diags]
    if prof and all(p.get("segment_x") for p in prof):
        x0 = np.asarray(prof[0]["segment_x"], float)
        q = [np.interp(x0, np.asarray(p["segment_x"], float), np.asarray(p["segment_q_net"], float)) for p in prof]
        out["profile"] = {
            "x_mm": [round(float(v) * 1e3, 4) for v in x0],
            "r_mm": [round(float(v) * 1e3, 4) for v in prof[0]["segment_r"]],
            "q_MW_m2": [[round(float(v) * 1e-6, 5) for v in row] for row in q],
            "wall_K": [_number(p.get("profile_wall_temperature")) for p in prof],
            "basis": ("chamber solve, whole contour, quasi-steady liner surface at its ablation "
                      "temperature (blown convection + radiation, net); not the transient wall"),
        }
    return out


def replay(prep: Prepared, series: Dict[str, Any], n: int = REPLAY_POINTS, *,
           sidecars: Optional[Dict[str, Any]] = None, soak: bool = False,
           chug_eroded_geometry: bool = False) -> Dict[str, Any]:
    """EngineDesign's coupled time-varying solve at the twin's line-exit pressures.

    An engine with a graphite insert or an ablative liner (:func:`erodes`) is replayed on the
    coupled solver only (``track_ablative_geometry=True, strict_erosion=True``). The replay used to
    pass ``None``, which tracked geometry only when the liner was enabled *and* tracked: a
    graphite-only engine, or one with ``track_geometry_evolution: false``, replayed through the
    legacy constant-geometry loop with zero erosion and no warning (audit 5.3). If the coupled
    solve fails now, the replay is unavailable and says why.

    ``sidecars``, when a dict, receives ``sidecars["axial"]`` (:func:`_axial`), too large for the
    run record. ``soak`` adds the soak-back after this burn (:func:`soak_back`) as ``["soak"]``;
    pass it on the final replay of a run only (or call :func:`soak_back` after it).
    ``chug_eroded_geometry`` hands the chug analysis each step's eroded geometry (default off,
    the previous behaviour; D7-D).
    """
    if prep.link is None or prep.link.sampler is None:
        return {"available": False, "error": "no EngineDesign link"}
    idx = replay_indices(series["firing"], n)
    if len(idx) < 2:
        return {"available": False, "error": "too few firing steps to replay"}
    t = np.array([series["t"][i] for i in idx])
    p_o = np.array([series["ox"]["inlet_psia"][i] for i in idx]) * PSI
    p_f = np.array([series["fuel"]["inlet_psia"][i] for i in idx]) * PSI
    runner = prep.link.sampler.runner
    eroding = erodes(runner.config)
    # The walls start at Fire, not at the first firing sample: that sample closes the first step,
    # and starting there put the whole recession history a step late (throat growth 3.92 against
    # 4.05 % on the 6.8 kN burn). Fire is solved at the first step's pressures and dropped after.
    t_fire = float(t[0]) - float(prep.plan.dt)
    lead = t_fire < float(t[0]) - 1e-9
    try:
        out = runner.evaluate_arrays_with_time(
            np.concatenate([[t_fire], t]) if lead else t,
            np.concatenate([[p_o[0]], p_o]) if lead else p_o,
            np.concatenate([[p_f[0]], p_f]) if lead else p_f,
            track_ablative_geometry=eroding, use_coupled_solver=True,
            P_ambient=prep.ambient_pa, strict_erosion=eroding,
            chug_eroded_geometry=chug_eroded_geometry,
        )
    except Exception as exc:  # noqa: BLE001 - a failed replay is reported, the burn still stands
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}
    if eroding and "stations" not in out:
        # Belt and braces: whatever path answered, it was not the coupled solver.
        return {"available": False, "error": "the erosion replay did not run EngineDesign's coupled "
                                             "time-varying solver; recession would read as zero"}
    if lead:
        out = {k: (v[1:] if isinstance(v, (list, np.ndarray)) and len(v) == len(t) + 1 else v) for k, v in out.items()}

    def col(key: str, scale: float = 1.0) -> Optional[List[float]]:
        if key not in out:
            return None
        return [float(v) * scale if v is not None and np.isfinite(v) else None for v in np.asarray(out[key], float)]

    at = np.asarray(out.get("A_throat", np.full(len(t), np.nan)), float)
    a0 = float(prep.link.design.throat_area)
    data = {
        "available": True,
        "t": [float(v) for v in t],
        "index": idx,
        "inlet_O_psia": [float(v) / PSI for v in p_o],
        "inlet_F_psia": [float(v) / PSI for v in p_f],
        "pc_psia": col("Pc", 1.0 / PSI),
        "thrust_N": col("F"),
        "mdot_O": col("mdot_O"),
        "mdot_F": col("mdot_F"),
        "mr": col("MR"),
        "isp_s": col("Isp"),
        "cstar": col("cstar_actual"),
        "eta_cstar": col("eta_cstar"),
        "gamma": col("gamma_chamber"),
        "A_throat_m2": [float(v) for v in at],
        "throat_area_ratio": [float(v) / a0 if np.isfinite(v) and a0 > 0 else None for v in at],
        "recession_throat_mm": col("recession_throat", 1e3),
        "recession_chamber_mm": col("recession_chamber", 1e3),
        "eps": col("eps"),
        # The nozzle's state, for the plume: exit pressure and temperature, the exit gamma, and
        # the chamber's gas temperature.
        "p_exit_psia": col("P_exit", 1.0 / PSI),
        "t_exit_K": col("T_exit"),
        "gamma_exit": col("gamma_exit"),
        "tc_K": col("Tc"),
        "Lstar_m": col("Lstar"),
        "heat_flux_throat_MW_m2": col("heat_flux_throat", 1e-6),
        "heat_flux_chamber_MW_m2": col("heat_flux_chamber", 1e-6),
        "T_graphite_surface_K": col("T_graphite_surface"),
        "T_liner_surface_K": col("T_liner_surface"),
        "char_depth_peak_mm": col("char_depth_peak", 1e3),
        "chug_margin": col("chugging_stability_margin"),
        "throat_ablation": bool(getattr(prep.link.sampler.config.graphite_insert, "enabled", False)),
        "liner_ablation": bool(getattr(prep.link.sampler.config.ablative_cooling, "enabled", False)),
    }
    # What the replay computes at every point and used to drop (audit 5.2). Old keys above are
    # unchanged; everything below is new and optional to a reader.
    for key, (src, scale) in RESULT_COLUMNS.items():
        data[key] = col(src, scale)
    diags = list(out.get("diagnostics") or [])
    if len(diags) != len(t):
        diags = [None] * len(t)
    for key, (path, scale) in DIAGNOSTIC_COLUMNS.items():
        data[key] = [_number(_dig(d, path), scale) for d in diags]
    steps = list(out.get("stations") or [])
    data["stations"] = _stations(steps) if len(steps) == len(t) else {}
    data["wall_layers"] = out.get("wall_layers") or {}
    data["ambient_pa"] = float(prep.ambient_pa)
    data["nozzle_efficiency"] = _number(getattr(runner.config.chamber_geometry, "nozzle_efficiency", None))
    data["coupled_solver"] = "stations" in out
    data["chug_eroded_geometry"] = bool(chug_eroded_geometry)
    if sidecars is not None:
        sidecars["axial"] = _axial(data["t"], data["stations"], diags)
    if soak:
        data["soak"] = soak_back(prep, data)
    return data


#: The soak-back window, in multiples of the slowest layer's conduction time L^2/alpha.
SOAK_FACTOR = 3.0


def soak_back(prep: Prepared, rp: Dict[str, Any], factor: float = SOAK_FACTOR) -> Dict[str, Any]:
    """The soak-back after the burn ``rp`` replayed (DATA-CONTRACT diagnostics.hardware.soak).

    Uses the wall state the coupled solver ended that replay with (the runner keeps its last
    solver), continued with the hot face adiabatic for ``factor`` x the slowest layer's L^2/alpha
    (:meth:`TimeVaryingCoupledSolver.soak_back_history`). Call it after the final replay of a run:
    a later replay replaces the wall state, and that is refused rather than reported.

    The back face is adiabatic in the wall model. With no case declared (LE4:
    ``stainless_steel_case: null``) the insert's back face is therefore an *adiabatic upper bound*:
    nothing behind it takes heat (audit D17). With a case declared it is the case's outer face,
    still adiabatic to the room."""
    if not rp.get("available"):
        return {"available": False, "error": "no replay"}
    runner = getattr(getattr(prep.link, "sampler", None), "runner", None) if prep.link is not None else None
    solver = getattr(runner, "last_time_varying_solver", None)
    if solver is None or not getattr(solver, "state_history", None):
        return {"available": False, "error": "the replay did not run the coupled solver; no wall state to soak"}
    # The runner keeps only its last solve: a later replay (another pass, another run on a shared
    # runner) replaces it. Its end time and end throat must both be this replay's.
    last = solver.state_history[-1]
    a_end = rp.get("A_throat_m2") or [None]
    if (abs(float(last.time) - float(rp["t"][-1])) > 1e-9 or a_end[-1] is None
            or not math.isclose(float(last.A_throat), float(a_end[-1]), rel_tol=1e-12)):
        return {"available": False, "error": "the runner's last coupled solve is not this replay's"}
    try:
        res = solver.soak_back_history(factor=factor)
    except Exception as exc:  # noqa: BLE001 - reported, the burn stands
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}
    case = getattr(runner.config, "stainless_steel_case", None)
    declared = bool(case is not None and getattr(case, "enabled", False))
    basis = "case outer face, adiabatic (upper bound)" if declared else "adiabatic upper bound"
    rows = []
    for name, s in res["stations"].items():
        rows.append({"station": name, "kind": s["kind"], "x_mm": s["x"] * 1e3,
                     "T_back_start_K": s["T_back_start"], "T_back_peak_K": s["T_back_peak"],
                     "t_back_peak_s": s["t_back_peak_s"], "t_back_95_s": s["t_back_95_s"],
                     "T_interface_peak_K": s["T_interface_peak"], "t_interface_peak_s": s["t_interface_peak_s"],
                     "back_basis": basis})
    if not rows:
        return {"available": False, "error": "the engine has no wall stations"}
    top = max(rows, key=lambda r: r["T_back_peak_K"])
    size = res["sizing"]
    return {
        "available": True,
        "peak_K": top["T_back_peak_K"],
        "t_peak_s": top["t_back_peak_s"],
        "t_95_s": top["t_back_95_s"],
        "station": top["station"],
        "duration_s": res["duration_s"],
        "clock": "seconds after the last replay point (burnout)",
        "back_basis": basis,
        "stations": rows,
        "model": {
            "name": "soak-back: 1-D transient conduction, hot face adiabatic after shutdown",
            "source": ("EngineDesign WallModel (engine/pipeline/thermal/wall_conduction.py), backward Euler "
                       "on the replay's final wall state; window sized from the slowest mode of an "
                       "insulated slab, exp(-pi^2 alpha t/L^2) (Carslaw & Jaeger 1959, ch. III)"),
            "assumptions": [
                "hot face adiabatic after shutdown: no convection to the cooling gas, no radiation out "
                "of the nozzle; an upper bound on the heat that reaches the back",
                "back face adiabatic: " + ("the declared case's outer face does not lose heat to the room"
                                           if declared else "no case or backing is declared, so nothing "
                                           "behind the liner or insert takes heat (D17)"),
                "no contact resistance between layers; each station 1-D through the wall, no axial "
                "conduction between stations",
                f"window {factor:g} x the slowest layer's L^2/alpha ({size['tau_s']:.4g} s, "
                f"{size['station']} {size['layer']})",
                "a peak's time is the first time within 0.05 K of it: a plateau is dated when it is reached",
                "properties as built (config); graphite cp(T) by its named model, every other property constant",
            ],
            "inputs": {
                "duration": {"value": res["duration_s"], "unit": "s",
                             "provenance": f"derived: {factor:g} x max L^2/alpha over the wall layers"},
                "slowest_L2_over_alpha": {"value": size["tau_s"], "unit": "s",
                                          "provenance": "derived from the wall layers' thickness, k, rho, cp (config)"},
                "case_declared": {"value": declared, "unit": "",
                                  "provenance": "config stainless_steel_case"},
            },
        },
    }


def throat_schedule(rp: Dict[str, Any]) -> Optional[tuple]:
    """``(t, A_throat)`` from a replay, for the next twin pass; ``None`` without one."""
    if not rp.get("available"):
        return None
    t = np.asarray(rp["t"], float)
    a = np.asarray(rp["A_throat_m2"], float)
    ok = np.isfinite(a) & np.isfinite(t)
    if ok.sum() < 2:
        return None
    if not ok.all():
        # A step the solver could not close leaves a gap, not a reason to drop the whole history.
        a = np.interp(t, t[ok], a[ok])
    return t, a


def schedule_change(old: Optional[tuple], new: Optional[tuple]) -> float:
    """Largest relative change of the throat history between two passes."""
    if new is None:
        # No history this pass: nothing to compare is "settled" only if there was none before.
        return 0.0 if old is None else math.inf
    t, a = new
    if old is None:
        return float(np.max(np.abs(a / a[0] - 1.0))) if len(a) else 0.0
    return float(np.max(np.abs(np.interp(t, old[0], old[1]) / a - 1.0)))


def agreement(rp: Dict[str, Any], series: Dict[str, Any]) -> Dict[str, Any]:
    """The twin's flows and chamber pressure against EngineDesign's replay at the same instants
    and inlet pressures: what the hand-off between the two passes leaves open."""
    if not rp.get("available"):
        return {"available": False}
    worst: Dict[str, float] = {}
    for key, twin, ed in (("mdot_O", series["ox"]["mdot"], rp["mdot_O"]),
                          ("mdot_F", series["fuel"]["mdot"], rp["mdot_F"]),
                          ("pc", series["chamber"]["pc_psia"], rp["pc_psia"])):
        vals = [abs(twin[i] / e - 1.0) for i, e in zip(rp["index"], ed or []) if e]
        worst[key] = max(vals) if vals else float("nan")
    return {"available": True, "worst": worst}


def _interp(t: Sequence[float], xs: Sequence[float], ys: Sequence[Optional[float]]) -> List[float]:
    pts = [(x, y) for x, y in zip(xs, ys) if y is not None and math.isfinite(y)]
    if not pts:
        return [float("nan")] * len(t)
    xa, ya = zip(*pts)
    return [float(v) for v in np.interp(t, xa, ya)]


def delivered(rp: Dict[str, Any], series: Dict[str, Any], dt: float) -> Optional[Dict[str, Any]]:
    """The engine's answers over the burn, from the replay, on the twin's firing steps.

    Thrust, chamber pressure, flow and Isp are EngineDesign's (interpolated between replay
    points; they are smooth). Burn time and the propellant used are the twin's, whose last pass
    already ran with the eroding throat.
    """
    if not rp.get("available"):
        return None
    fire = [i for i, f in enumerate(series["firing"]) if f]
    t = [series["t"][i] for i in fire]
    out = {"t": t}
    for key in ("thrust_N", "pc_psia", "mdot_O", "mdot_F", "isp_s", "mr", "throat_area_ratio",
                "recession_throat_mm", "cstar", "gamma", "eps", "p_exit_psia", "t_exit_K", "gamma_exit", "tc_K",
                "chug_margin"):
        out[key] = _interp(t, rp["t"], rp.get(key) or [])
    # The first firing step is the ignition transient, inside the first replay point; the
    # interpolant holds its value there, which is the twin's own handling of that step too.
    # Each firing step's own length (the last may be cut to land on depletion).
    lengths = [float(series["dt"][i]) for i in fire] if series.get("dt") else [dt] * len(fire)
    impulse = sum(f * h for f, h in zip(out["thrust_N"], lengths) if math.isfinite(f))
    used = sum((mo + mf) * h for mo, mf, h in zip(out["mdot_O"], out["mdot_F"], lengths) if math.isfinite(mo + mf))
    burn = t[-1] if t else 0.0
    settled = [k for k, tt in enumerate(t) if tt >= 0.2] or list(range(len(t)))
    pick = lambda key, fn: fn([out[key][k] for k in settled if math.isfinite(out[key][k])])  # noqa: E731
    out["summary"] = {
        "total_impulse_Ns": impulse,
        "mean_thrust_N": impulse / burn if burn else None,
        "peak_thrust_N": max(out["thrust_N"]) if out["thrust_N"] else None,
        "min_thrust_N": pick("thrust_N", min),
        "pc_mean_psia": pick("pc_psia", lambda v: sum(v) / len(v)),
        "pc_min_psia": pick("pc_psia", min),
        "pc_max_psia": pick("pc_psia", max),
        "isp_mean_s": impulse / (used * 9.80665) if used > 0 else None,
        "propellant_burned_kg": used,
        "throat_area_growth": (out["throat_area_ratio"][-1] - 1.0) if out["throat_area_ratio"] else None,
        "throat_recession_mm": out["recession_throat_mm"][-1] if out["recession_throat_mm"] else None,
        # EngineDesign's chug gain margin (worst over the mixing-lag band), lowest over the whole
        # burn, ignition included: below 1 the feed-coupled loop is predicted unstable.
        "chug_margin_min": None,
        "chug_margin_min_t": None,
    }
    gm = [(v, tt) for v, tt in zip(out.get("chug_margin") or [], t) if math.isfinite(v)]
    if gm:
        low = min(gm)
        out["summary"]["chug_margin_min"], out["summary"]["chug_margin_min_t"] = low[0], low[1]
    return out


def timeseries_payload(result: Dict[str, Any]) -> Dict[str, Any]:
    """The burn in the shape the Time-Series tab stores (``api/client.ts TimeSeriesData``), so
    Forward mode's burn view and the Flight tab read a Layer X run exactly as they read a
    Time-Series run. Engine quantities from the replay when there is one; feed-system
    quantities from the twin. Time starts at the Fire command, with a sample there."""
    series = result["series"]
    fire = [i for i, f in enumerate(series["firing"]) if f]
    dv = result.get("delivered")

    def engine(key_rp: str, key_twin: List[float], scale: float = 1.0) -> List[float]:
        if dv is not None and dv.get(key_rp) is not None:
            return [float(v) * scale for v in dv[key_rp]]
        return [float(key_twin[i]) * scale for i in fire]

    thrust_kN = engine("thrust_N", series["chamber"]["thrust_N"], 1e-3)
    mo = engine("mdot_O", series["ox"]["mdot"])
    mf = engine("mdot_F", series["fuel"]["mdot"])
    data = {
        "time": [float(series["t"][i]) for i in fire],
        "P_tank_O_psi": [float(series["ox"]["tank_psia"][i]) for i in fire],
        "P_tank_F_psi": [float(series["fuel"]["tank_psia"][i]) for i in fire],
        "Pc_psi": engine("pc_psia", series["chamber"]["pc_psia"]),
        "thrust_kN": thrust_kN,
        "Isp_s": engine("isp_s", series["chamber"]["isp_s"]),
        "MR": engine("mr", series["chamber"]["mr"]),
        "mdot_O_kg_s": mo,
        "mdot_F_kg_s": mf,
        "mdot_total_kg_s": [a + b for a, b in zip(mo, mf)],
        "cstar_actual_m_s": engine("cstar", series["chamber"]["cstar"]),
        "gamma": engine("gamma", [float("nan")] * len(series["t"])),
        "lox_mass_remaining_kg": [float(series["ox"]["liquid_kg"][i]) for i in fire],
        "fuel_mass_remaining_kg": [float(series["fuel"]["liquid_kg"][i]) for i in fire],
        "delta_P_injector_O_psi": [float(series["ox"]["dp_injector_psi"][i]) for i in fire],
        "delta_P_injector_F_psi": [float(series["fuel"]["dp_injector_psi"][i]) for i in fire],
        "copv_pressure_psi": [float(series["copv_psia"][i]) for i in fire] if series["copv_psia"] else None,
    }
    if dv is not None:
        data["recession_cumulative_throat_um"] = [float(v) * 1e3 for v in dv["recession_throat_mm"]]
    s = result["summary"]
    # Each sample closes its step: the first is stamped one step after Fire, and every reader of
    # this shape (backend/routers/flight.py, the Flight tab, flight.fly) puts t = 0 at the first
    # sample. Without a sample at Fire the first step's thrust was dropped: 340 N·s and ~70 m of
    # apogee on the 6.8 kN burn. The step holds its values across itself, so the Fire sample
    # carries the first step's, with the tanks still at their load.
    dt = float(s.get("dt") or 0.0)
    if data["time"] and dt > 0.0 and data["time"][0] - dt > -1e-9:
        loaded = {"lox_mass_remaining_kg": s["ox"]["loaded_kg"], "fuel_mass_remaining_kg": s["fuel"]["loaded_kg"]}
        for key, values in data.items():
            if not values:
                continue
            if key == "time":
                values.insert(0, round(values[0] - dt, 9))
            else:
                values.insert(0, float(loaded[key]) if key in loaded else values[0])
    d = (dv or {}).get("summary") or {}
    summary = {
        "avg_thrust_kN": (d.get("mean_thrust_N") or s.get("mean_thrust_N") or 0.0) * 1e-3,
        "peak_thrust_kN": (d.get("peak_thrust_N") or s.get("peak_thrust_N") or 0.0) * 1e-3,
        "min_thrust_kN": (d.get("min_thrust_N") or s.get("min_thrust_N") or 0.0) * 1e-3,
        "avg_Pc_psi": d.get("pc_mean_psia") or s.get("pc_mean_psia"),
        "peak_Pc_psi": d.get("pc_max_psia") or s.get("pc_max_psia"),
        "avg_Isp_s": d.get("isp_mean_s") or s.get("isp_mean_s"),
        "total_impulse_kNs": (d.get("total_impulse_Ns") or s.get("total_impulse_Ns") or 0.0) * 1e-3,
        "total_propellant_kg": s.get("propellant_used_kg"),
        "burn_time_s": s.get("burn_time_s"),
        "lox_propellant_kg": s["ox"]["loaded_kg"] - s["ox"]["residual_kg"],
        "fuel_propellant_kg": s["fuel"]["loaded_kg"] - s["fuel"]["residual_kg"],
    }
    return {"data": data, "summary": summary, "source": "layerx"}
