"""The chamber and nozzle hardware along a Layer X burn (DATA-CONTRACT ``diagnostics.hardware``).

Everything here is read off EngineDesign's erosion replay (:mod:`engine.layerx.replay`): the coupled
time-varying solver's wall stations, the geometry it rebuilt from them at each replay point, and its
nozzle state. Nothing is solved again except two table look-ups: the ideal vacuum thrust coefficient
from the CEA cache for the Isp breakdown, and the as-built contour from the thermal geometry module.

The block follows the replay's points, not the twin's steps (``t`` and ``index``, the series index
of each point): the replay solves the engine at those points only, and everything between them is an
interpolation (audit 5.3, "never imply 50 ms resolution").

What it reports, per replay point:

* the throat: diameter, area ratio to as built, ``eps = A_e / A_t(t)`` (A_e is fixed: LE4's nozzle
  does not ablate), ``L* = V(t) / A_t(t)`` with V including the liner's recession, and the
  contraction ratio ``A_c / A_t`` at the eroded barrel and throat;
* the wall: the thinnest liner left over the liner stations, and the graphite insert's back-face
  temperature, labelled an *adiabatic upper bound* when no case is declared (D17);
* the contour as built, and the wall at each replay point: the as-built radius plus each station's
  recession, interpolated between stations the way the solver integrates the volume;
* nozzle separation against the ambient the nozzle actually exhausts into (Summerfield; Schmucker);
* the delivered Isp as a waterfall: ideal, less the c* loss, less the nozzle loss;
* the soak-back after shutdown, when :func:`engine.layerx.replay.soak_back` ran.

``hardware_block`` never raises: a block it cannot build is ``{available: False, error}``.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

PSI = 6894.757293168361
G0 = 9.80665

#: Summerfield's criterion: an overexpanded nozzle runs full while p_e/p_a stays above ~0.4.
#: Summerfield, M., Foster, C. R. & Swan, W. C., "Flow separation in overexpanded supersonic exhaust
#: nozzles", Jet Propulsion 24 (1954). A correlation of their test data, not a law; the same number is
#: the repo's existing threshold (engine/pipeline/handcheck.py, frontend plume.ts, diag/limits.py).
SUMMERFIELD_PE_PA = 0.4
#: Schmucker's criterion, p_sep/p_a = (1.88 M - 1)^-0.64, with M the Mach number just upstream of
#: separation: Schmucker, R. H., 1973 (Technische Universitaet Muenchen), in the form given by the
#: review Oestlund, J. & Muhammad-Klingmann, B., "Supersonic flow separation with application to rocket
#: engine nozzles", Applied Mechanics Reviews 58(3), 2005 (the review is the reference checked here;
#: Schmucker's original report is not). Applied at the exit plane, M = M_e.
SCHMUCKER_A = 1.88
SCHMUCKER_N = -0.64


def _num(v: Any, scale: float = 1.0) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f * scale if math.isfinite(f) else None


def _col(rp: Dict[str, Any], key: str) -> List[Optional[float]]:
    return [_num(v) for v in (rp.get(key) or [])]


def _r(v: Optional[float], digits: int = 6) -> Optional[float]:
    return None if v is None else round(float(v), digits)


def _config_of(prep_or_config: Any) -> Any:
    """The engine the replay ran: the line-exit runner's config for a ``Prepared`` (its geometry is
    the design's), the object itself otherwise."""
    link = getattr(prep_or_config, "link", None)
    sampler = getattr(link, "sampler", None) if link is not None else None
    if sampler is not None and getattr(sampler, "runner", None) is not None:
        return sampler.runner.config
    if hasattr(prep_or_config, "chamber_geometry"):
        return prep_or_config
    raise ValueError("hardware_block needs a Prepared with an EngineDesign link, or an engine config")


def _cea_of(prep_or_config: Any, config: Any, cea_cache: Any) -> Any:
    if cea_cache is not None:
        return cea_cache
    link = getattr(prep_or_config, "link", None)
    sampler = getattr(link, "sampler", None) if link is not None else None
    runner = getattr(sampler, "runner", None) if sampler is not None else None
    if runner is not None:
        return runner.cea_cache
    from engine.core.runner import PintleEngineRunner

    return PintleEngineRunner(config).cea_cache


def _provenance(obj: Any, field: str, path: str) -> str:
    """Where a config number came from: the schema's default (left unset, or written out equal to
    it), or a value the config sets. The config carries no source for either."""
    if obj is None:
        return f"absent: {path} not declared"
    fields_set = getattr(obj, "model_fields_set", None)
    if fields_set is not None and field not in fields_set:
        return f"schema default ({path}); no source recorded"
    info = (getattr(type(obj), "model_fields", None) or {}).get(field)
    default = getattr(info, "default", None) if info is not None else None
    value = getattr(obj, field, None)
    if default is not None and value is not None and not callable(default):
        try:
            if float(value) == float(default):
                return f"config {path}, equal to the schema default; no source recorded"
        except (TypeError, ValueError):
            pass
    return f"config {path}; no source recorded"


def _inp(value: Any, unit: str, provenance: str) -> Dict[str, Any]:
    return {"value": value, "unit": unit, "provenance": provenance}


# ------------------------------------------------------------------ the pieces


def eroded_radius(x: np.ndarray, r0: np.ndarray, stations: Dict[str, Dict[str, Any]], k: int,
                  x_liner_end: float, x_insert_end: float = 0.0) -> np.ndarray:
    """The wall at replay point ``k``: ``r0(x) + s(x)``, with ``s`` the stations' recession: along the
    liner (``x <= x_liner_end``) linear between liner stations and held flat beyond the first and
    last; over the whole graphite insert (``x_liner_end < x <= x_insert_end``) the throat station's.

    The insert's downstream half recedes too, though ``TimeVaryingCoupledSolver._geometry`` counts
    only the upstream half in the chamber volume: the solver's throat is ``D_t0 + 2 s_throat``, so
    the drawn wall's narrowest point must be that diameter. Left at the as-built radius, the
    downstream half kept the drawn throat at its as-built size while the run reported the throat
    area growing 5.7 % (2026-10-03). Downstream of the insert nothing recedes (the solver moves
    only the exit area, and only when the nozzle ablates). Lengths in the units of ``x``, ``r0``."""
    s = np.zeros_like(r0, dtype=float)
    liner = sorted((st["x_mm"], (st["recession_mm"] or [None])[k]) for name, st in stations.items()
                   if st.get("kind") == "liner" and name.startswith("liner") and st.get("x_mm") is not None)
    liner = [(xs, ss) for xs, ss in liner if ss is not None]
    if liner:
        xs = np.array([p[0] for p in liner], float)
        ss = np.array([p[1] for p in liner], float)
        lined = x <= x_liner_end + 1e-9
        s[lined] = np.interp(x[lined], xs, ss)
    thr = stations.get("throat")
    if thr is not None and (thr.get("recession_mm") or [None])[k] is not None:
        insert = (x > x_liner_end + 1e-9) & (x <= max(x_insert_end, 0.0) + 1e-9)
        s[insert] = float(thr["recession_mm"][k])
    return r0 + s


def separation(t: Sequence[float], p_exit_pa: Sequence[Optional[float]], ambient_pa: Sequence[Optional[float]],
               M_exit: Sequence[Optional[float]], threshold: float = SUMMERFIELD_PE_PA) -> Dict[str, Any]:
    """Nozzle separation at each point, from the exit pressure, the ambient and the exit Mach number.

    * Summerfield: separated when ``p_e/p_a < threshold`` (~0.4).
    * Schmucker: separated when ``p_e/p_a < (1.88 M_e - 1)^-0.64``. ``schmucker_pa_crit_psia`` is the
      ambient above which Schmucker predicts separation at this ``p_e``, ``M_e``:
      ``p_e / (1.88 M_e - 1)^-0.64``; ``schmucker_pe_sep_psia`` the exit pressure below which it does
      at this ambient: ``p_a (1.88 M_e - 1)^-0.64``.
    """
    pe, pa, me = list(p_exit_pa), list(ambient_pa), list(M_exit)
    ratio: List[Optional[float]] = []
    crit: List[Optional[float]] = []
    for p, a, m in zip(pe, pa, me):
        ratio.append(p / a if p is not None and a else None)
        crit.append((SCHMUCKER_A * m - 1.0) ** SCHMUCKER_N if m is not None and SCHMUCKER_A * m > 1.0 else None)
    summer = [None if r is None else bool(r < threshold) for r in ratio]
    schm = [None if r is None or c is None else bool(r < c) for r, c in zip(ratio, crit)]
    ok = [j for j, r in enumerate(ratio) if r is not None]
    j = min(ok, key=lambda j: ratio[j]) if ok else None  # type: ignore[arg-type,return-value]
    return {
        "pe_pa": [_r(p, 3) for p in pe],
        "pe_psia": [_r(p / PSI, 5) if p is not None else None for p in pe],
        "ambient_psia": [_r(a / PSI, 5) if a is not None else None for a in pa],
        "ratio": [_r(r, 6) for r in ratio],
        "summerfield": summer,
        "M_exit": [_r(m, 6) for m in me],
        "schmucker_ratio": [_r(c, 6) for c in crit],
        "schmucker": schm,
        "schmucker_pa_crit_psia": [_r(p / c / PSI, 5) if p is not None and c else None for p, c in zip(pe, crit)],
        "schmucker_pe_sep_psia": [_r(a * c / PSI, 5) if a is not None and c else None for a, c in zip(pa, crit)],
        "flag": bool(any(summer[i] for i in ok) or any(schm[i] for i in ok if schm[i] is not None)),
        "min_ratio": _r(ratio[j], 6) if j is not None else None,
        "t_min": float(t[j]) if j is not None else None,
        "margin": _r(ratio[j] / threshold, 6) if j is not None else None,
        "model": {
            "name": "nozzle flow separation, Summerfield and Schmucker criteria at the exit plane",
            "source": ("Summerfield, Foster & Swan, Jet Propulsion 24 (1954): p_e/p_a < ~0.4; Schmucker 1973 "
                       "(TU Muenchen) p_sep/p_a = (1.88 M - 1)^-0.64, in the form given by Oestlund & "
                       "Muhammad-Klingmann, Appl. Mech. Rev. 58(3) (2005)"),
            "assumptions": [
                "steady, full-flowing nozzle at each replay point; start and shutdown transients are not "
                "modelled (the replay's first point is already at full chamber pressure), so separation "
                "during them is not assessed",
                "p_e and M_e are CEA shifting-equilibrium exit values at the replay's O/F, nozzle "
                "stagnation pressure and eps(t) (engine/core/nozzle.py); not a boundary-layer solution",
                "Schmucker applied with the exit Mach number: it predicts whether separation would sit "
                "inside the nozzle at the exit, not where",
                "ambient is the air the nozzle exhausts into: the site on the pad, the trajectory's in "
                "flight (delivered.ambient_psia), interpolated onto the replay points",
            ],
            "inputs": {
                "summerfield_threshold": _inp(threshold, "", "Summerfield, Foster & Swan 1954 (~0.4, a data "
                                              "correlation; unmeasured for this nozzle)"),
                "schmucker_a": _inp(SCHMUCKER_A, "", "Schmucker 1973 correlation constant"),
                "schmucker_n": _inp(SCHMUCKER_N, "", "Schmucker 1973 correlation exponent"),
            },
        },
    }


def isp_breakdown(t: Sequence[float], rp: Dict[str, Any], cea_cache: Any, ambient_pa: float,
                  zeta_n: float, zeta_provenance: str) -> Dict[str, Any]:
    """Delivered Isp as ideal less two losses, at each replay point, closing exactly.

    EngineDesign's thrust (engine/core/nozzle.py ``calculate_thrust``) is
    ``F = zeta_n Cf_vac(P0, eps) P0 A_t - p_a A_e`` with ``P0 = Pc/kappa`` (the Rayleigh loss of a
    finite-area chamber), and its flow is ``mdot = P0 A_t / c*`` with ``c* = eta_c* c*_ideal(Pc)``
    (chamber_solver.py: c* is referenced to the nozzle's stagnation pressure). So, with
    ``Isp g0 = F/mdot = eta_c* c*_ideal [zeta_n Cf_vac(P0) - kappa p_a eps / Pc]``:

    * ``ideal_s``: the CEA shifting-equilibrium Isp at this point's Pc, O/F and eps(t), at the
      replay's ambient: ``c*_ideal (Cf_vac(Pc, eps) - p_a eps / Pc) / g0``;
    * ``cstar_loss_s = (1 - eta_c*) ideal_s``: at a fixed chamber pressure and throat the thrust is
      unchanged and the flow rises by 1/eta_c*, so the whole ideal Isp scales by eta_c*, the
      ambient term included;
    * ``nozzle_loss_s``: what remains, ``eta_c* ideal_s - delivered_s``, which is exactly
      ``zeta_n_loss_s = eta_c* c*_ideal (1 - zeta_n) Cf_vac(P0) / g0
      = (1 - zeta_n)/zeta_n (Isp + p_a A_e/(mdot g0))`` plus
      ``stagnation_loss_s = eta_c* c*_ideal [Cf_vac(Pc) - Cf_vac(P0) + (kappa - 1) p_a eps/Pc] / g0``.
      Because c* is referenced to P0, the stagnation loss reaches Isp only through the ambient
      term and the small shift of Cf_vac with pressure (~0.1 s on LE4); in vacuum it vanishes.
    """
    pc = [_num(v, PSI) for v in rp.get("pc_psia") or []]
    mr, eps = _col(rp, "mr"), _col(rp, "eps")
    eta, cs_id = _col(rp, "eta_cstar"), _col(rp, "cstar_ideal")
    isp, ae = _col(rp, "isp_s"), _col(rp, "A_exit_m2")
    mo, mf = _col(rp, "mdot_O"), _col(rp, "mdot_F")
    out: Dict[str, List[Optional[float]]] = {k: [] for k in (
        "ideal_s", "cstar_loss_s", "nozzle_loss_s", "delivered_s", "zeta_n_loss_s", "stagnation_loss_s",
        "Cf_vac_ideal", "eta_cstar")}
    clamped: List[str] = []
    for k in range(len(t)):
        vals = (pc[k], mr[k], eps[k], eta[k], cs_id[k], isp[k], ae[k], mo[k], mf[k])
        if any(v is None for v in vals):
            for key in out:
                out[key].append(None)
            continue
        Pc, MR, e, et, c_id, isp_d, A_e, m_o, m_f = vals  # type: ignore[misc]
        props = cea_cache.eval(MR, Pc, ambient_pa, e)
        clamped.extend(props.get("clamped") or ())
        cf_vac = float(props["Cf_vac"])
        ideal = c_id * (cf_vac - ambient_pa * e / Pc) / G0
        cstar_loss = (1.0 - et) * ideal
        nozzle = et * ideal - isp_d
        zeta_loss = (1.0 - zeta_n) / zeta_n * (isp_d + ambient_pa * A_e / ((m_o + m_f) * G0)) if zeta_n > 0 else None
        out["ideal_s"].append(ideal)
        out["cstar_loss_s"].append(cstar_loss)
        out["nozzle_loss_s"].append(nozzle)
        out["delivered_s"].append(isp_d)
        out["zeta_n_loss_s"].append(zeta_loss)
        out["stagnation_loss_s"].append(nozzle - zeta_loss if zeta_loss is not None else None)
        out["Cf_vac_ideal"].append(cf_vac)
        out["eta_cstar"].append(et)
    res: Dict[str, Any] = {k: [_r(v, 6) for v in vals] for k, vals in out.items()}
    res["zeta_n"] = zeta_n
    res["ambient_pa"] = float(ambient_pa)
    res["basis"] = ("at the replay's own ambient (the site's: EngineDesign's delivered thrust is at site "
                    "ambient, in flight too); ideal = CEA shifting equilibrium at the instantaneous Pc, O/F "
                    "and eps(t); delivered - (ideal - c* loss - nozzle loss) = 0 by construction")
    res["model"] = {
        "name": "delivered Isp waterfall: ideal, c* loss, nozzle loss",
        "source": ("EngineDesign thrust model (engine/core/nozzle.py calculate_thrust: F = zeta_n Cf_vac P0 A_t "
                   "- p_a A_e, the RPA delivered-thrust basis) and CEA tables (engine/pipeline/cea_cache.py)"),
        "assumptions": [
            "eta_c* is the chamber solve's eta_vap x eta_mix x eta_HL (combustion_eff.py); its breakdown is "
            "in the replay (eta_vap, eta_mix, eta_heat_loss)",
            "the nozzle loss is one lumped efficiency zeta_n plus the Rayleigh stagnation loss (which, with "
            "c* referenced to P0, acts only through the ambient term); there is no separate divergence, "
            "boundary-layer, kinetic or two-phase term in EngineDesign",
            f"zeta_n = {zeta_n:g}: {zeta_provenance}",
            "Cf_vac read from the CEA table at Pc (the ideal reference), EngineDesign's thrust reads it at "
            "P0 = Pc/kappa; the difference is inside stagnation_loss_s",
        ],
        "inputs": {
            "nozzle_efficiency": _inp(zeta_n, "", zeta_provenance),
            "ambient": _inp(float(ambient_pa), "Pa", "the replay's ambient (prep.ambient_pa: site)"),
        },
    }
    if clamped:
        res["model"]["assumptions"].append("CEA table clamped on " + ", ".join(sorted(set(clamped))) + " at some points")
    return res


def _zeta(config: Any) -> tuple:
    cg = config.chamber_geometry
    zeta = float(cg.nozzle_efficiency)
    ms = getattr(config, "measurements", None)
    mv = getattr(ms, "nozzle_efficiency", None) if ms is not None else None
    if mv is not None:
        return zeta, f"measured: {mv.source}"
    fields_set = getattr(cg, "model_fields_set", set())
    if "nozzle_efficiency" not in fields_set:
        return zeta, ("schema default (ChamberGeometryConfig.nozzle_efficiency = 0.95, 'typical 0.94-0.98'); "
                      "unsourced (audit D16)")
    return zeta, "config chamber_geometry.nozzle_efficiency; no source recorded (audit D16)"


def _interp_onto(t: Sequence[float], ts: Sequence[float], ys: Sequence[Any]) -> List[Optional[float]]:
    pts = [(float(a), float(b)) for a, b in zip(ts, ys) if _num(b) is not None and _num(a) is not None]
    if not pts:
        return [None] * len(t)
    xa, ya = zip(*pts)
    return [float(v) for v in np.interp(np.asarray(t, float), xa, ya)]


# ------------------------------------------------------------------ the block


def hardware_block(prep_or_config: Any, replay_result: Optional[Dict[str, Any]],
                   delivered: Optional[Dict[str, Any]] = None, series: Optional[Dict[str, Any]] = None, *,
                   soak: Optional[Dict[str, Any]] = None, cea_cache: Any = None,
                   ambient_pa: Optional[float] = None) -> Dict[str, Any]:
    """``diagnostics.hardware`` for one burn (DATA-CONTRACT section 3).

    ``prep_or_config``: the run's ``Prepared`` (preferred: its runner's config and CEA cache are the
    replay's own) or the engine config. ``replay_result``: :func:`engine.layerx.replay.replay` of the
    final pass. ``delivered``: :func:`engine.layerx.replay.delivered` with ``ambient_psia`` set (the
    trajectory's air in flight); separation falls back to the replay's ambient without it.
    ``series``: the twin's series (only its ``t`` is read, to bound the block). ``soak``: the
    :func:`engine.layerx.replay.soak_back` result, else ``replay_result["soak"]``. ``cea_cache``
    overrides the CEA table (built from the config when neither it nor a runner is at hand).
    ``ambient_pa`` is a fallback for a replay that does not carry its own ``ambient_pa``: the Isp
    breakdown must use the ambient the replay's thrust was computed at, so the replay's wins.

    Never raises: ``{available: False, error}`` on failure.
    """
    try:
        return _hardware_block(prep_or_config, replay_result, delivered, series, soak, cea_cache, ambient_pa)
    except Exception as exc:  # noqa: BLE001 - a diagnostic that cannot be built is reported; the burn stands
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}


def _hardware_block(prep_or_config: Any, rp: Optional[Dict[str, Any]], delivered: Optional[Dict[str, Any]],
                    series: Optional[Dict[str, Any]], soak: Optional[Dict[str, Any]], cea_cache: Any,
                    ambient_pa: Optional[float]) -> Dict[str, Any]:
    from engine.pipeline.config_schemas import ensure_chamber_geometry
    from engine.pipeline.thermal import gas_side

    if not rp or not rp.get("available"):
        return {"available": False, "error": (rp or {}).get("error") or "no erosion replay for this run"}
    if "stations" not in rp:
        return {"available": False, "error": "this replay predates the kept wall stations (re-run the burn)"}
    import copy as _copy

    config = _config_of(prep_or_config)
    t = [float(v) for v in rp["t"]]
    n = len(t)
    a_t = _col(rp, "A_throat_m2")
    a_e = _col(rp, "A_exit_m2")
    vol = _col(rp, "V_chamber_m3")
    d_t = _col(rp, "D_throat_mm")
    d_c = _col(rp, "D_chamber_mm")
    st: Dict[str, Dict[str, Any]] = rp.get("stations") or {}

    def ratio(a: Sequence[Optional[float]], b: Sequence[Optional[float]], p: float = 1.0) -> List[Optional[float]]:
        return [(x / y) ** p if x is not None and y else None for x, y in zip(a, b)]

    eps = ratio(a_e, a_t)
    lstar = ratio(vol, a_t)
    contraction = ratio(d_c, d_t, 2.0)
    liners = [s for name, s in st.items() if s.get("kind") == "liner" and name.startswith("liner")]
    liner_min = [min((s["remaining_mm"][k] for s in liners if s["remaining_mm"][k] is not None), default=None)
                 for k in range(n)] if liners else [None] * n
    gr = getattr(config, "graphite_insert", None)
    graphite = bool(gr is not None and getattr(gr, "enabled", False))
    case = getattr(config, "stainless_steel_case", None)
    case_declared = bool(case is not None and getattr(case, "enabled", False))
    back_basis = ("insert back face (its interface with the backing behind it: the liner's phenolic out to the "
                  "case, assumed); the case's outer face adiabatic to the room (upper bound)" if case_declared
                  else "adiabatic upper bound")
    thr = st.get("throat") or {}
    # The insert's back face is the graphite layer's back: the station's back face when nothing is
    # behind it (LE4), the graphite/case interface when a case is declared (the station's back face
    # is then the case's outer face, not the insert's).
    back_key = "T_interface_K" if case_declared else "T_back_K"
    insert_back = list(thr.get(back_key) or [None] * n) if graphite and thr.get("kind") == "graphite" else [None] * n

    # ---- the contour: as built, and the wall at each replay point
    cg0 = ensure_chamber_geometry(_copy.deepcopy(config))
    c0 = gas_side.contour_for(cg0)
    x_mm = np.asarray(c0.x, float) * 1e3
    r0_mm = np.asarray(c0.r, float) * 1e3
    if graphite:
        half = float(gr.axial_half_length or gr.axial_half_length_ratio * 2.0 * c0.R_t)
    else:
        half = 0.0
    x_liner_end = -half * 1e3
    frames = [eroded_radius(x_mm, r0_mm, st, k, x_liner_end, half * 1e3) for k in range(n)]
    abl = getattr(config, "ablative_cooling", None)
    lined = bool(abl is not None and getattr(abl, "enabled", False))
    contour: Dict[str, Any] = {
        "x_mm": [round(float(v), 4) for v in x_mm],
        "r0_mm": [round(float(v), 4) for v in r0_mm],
        "frames": {"t": t, "r_mm": [[round(float(v), 4) for v in f] for f in frames]},
        "x_face_mm": round(float(c0.x_face) * 1e3, 4),
        "x_liner_end_mm": round(x_liner_end, 4) if lined else None,
        "x_insert_mm": [round(-half * 1e3, 4), round(half * 1e3, 4)] if graphite else None,
    }
    if lined:
        t_l = float(abl.initial_thickness) * 1e3
        contour["liner_r_mm"] = [round(float(r + t_l), 4) if x <= x_liner_end + 1e-9 else None
                                 for x, r in zip(x_mm, r0_mm)]
    if graphite:
        t_g = float(gr.initial_thickness) * 1e3
        contour["insert_r_mm"] = [round(float(r + t_g), 4) if -half * 1e3 - 1e-9 <= x <= half * 1e3 + 1e-9 else None
                                  for x, r in zip(x_mm, r0_mm)]

    # ---- separation, on the replay points, against the air the nozzle exhausts into
    amb_rp = float(rp.get("ambient_pa") or ambient_pa or getattr(prep_or_config, "ambient_pa", 101325.0))
    if delivered and delivered.get("ambient_psia") and delivered.get("t"):
        amb_at = [None if a is None else a * PSI for a in _interp_onto(t, delivered["t"], delivered["ambient_psia"])]
        amb_basis = "delivered.ambient_psia (site on the pad, the trajectory's air in flight)"
    else:
        amb_at = [amb_rp] * n
        amb_basis = "the replay's ambient (site)"
    pe = [_num(v, PSI) for v in rp.get("p_exit_psia") or [None] * n]
    sep = separation(t, pe, amb_at, _col(rp, "M_exit"))
    sep["ambient_basis"] = amb_basis

    # ---- Isp waterfall
    zeta, zeta_prov = _zeta(config)
    cea = _cea_of(prep_or_config, config, cea_cache)
    isp = isp_breakdown(t, rp, cea, amb_rp, zeta, zeta_prov)

    # ---- soak-back
    sk = soak if soak is not None else rp.get("soak")
    if sk is None:
        sk = {"available": False, "error": "soak-back not run for this replay (engine.layerx.replay.soak_back)"}
    elif sk.get("available"):
        sk = {**sk, "basis": sk.get("back_basis", back_basis)}

    ar = _col(rp, "throat_area_ratio")
    out: Dict[str, Any] = {
        "available": True,
        "t": t,
        "index": list(rp.get("index") or []),
        "replay_point": [True] * n,
        "throat_d_mm": [_r(v, 5) for v in d_t],
        "At_ratio": [_r(v, 7) for v in ar],
        "eps": [_r(v, 6) for v in eps],
        "Lstar_m": [_r(v, 6) for v in lstar],
        "contraction": [_r(v, 6) for v in contraction],
        "liner_min_mm": [_r(v, 5) for v in liner_min],
        "insert_back_K": [_r(v, 3) for v in insert_back],
        "insert_back_basis": back_basis if graphite else None,
        "contour": contour,
        "separation": sep,
        "isp": isp,
        "soak": sk,
        "heatmap": "sidecar:axial",
        "summary": {
            "throat_growth": (ar[-1] - 1.0) if ar and ar[-1] is not None else None,
            "throat_d_end_mm": d_t[-1] if d_t else None,
            "eps_start": eps[0] if eps else None, "eps_end": eps[-1] if eps else None,
            "Lstar_start_m": lstar[0] if lstar else None, "Lstar_end_m": lstar[-1] if lstar else None,
            "liner_min_end_mm": liner_min[-1] if liner_min else None,
            "insert_back_end_K": insert_back[-1] if insert_back else None,
            # A_t at the first replay point over as built: the first step has already eroded (the
            # per-pass throat_growth is measured from this point, delivered's from as built).
            "first_point_area_ratio": ar[0] if ar else None,
        },
    }
    if series is not None and series.get("t"):
        out["series_span"] = [float(series["t"][0]), float(series["t"][-1])]
    out["model"] = _model(config, rp, graphite, lined, case_declared, half, back_basis)
    return out


def _model(config: Any, rp: Dict[str, Any], graphite: bool, lined: bool, case_declared: bool, half: float,
           back_basis: str) -> Dict[str, Any]:
    abl = getattr(config, "ablative_cooling", None)
    gr = getattr(config, "graphite_insert", None)
    inputs: Dict[str, Any] = {}
    if lined:
        inputs["liner_thickness"] = _inp(float(abl.initial_thickness), "m",
                                         _provenance(abl, "initial_thickness", "ablative_cooling.initial_thickness"))
        inputs["liner_coverage_fraction"] = _inp(float(abl.coverage_fraction), "",
                                                 _provenance(abl, "coverage_fraction", "ablative_cooling.coverage_fraction")
                                                 + "; scales the volume change only")
        for f, u in (("thermal_conductivity", "W/(m K)"), ("material_density", "kg/m^3"), ("specific_heat", "J/(kg K)"),
                     ("ablation_surface_temperature", "K"), ("heat_of_ablation", "J/kg")):
            inputs[f"liner_{f}"] = _inp(float(getattr(abl, f)), u, _provenance(abl, f, f"ablative_cooling.{f}"))
    if graphite:
        inputs["insert_thickness"] = _inp(float(gr.initial_thickness), "m",
                                          _provenance(gr, "initial_thickness", "graphite_insert.initial_thickness"))
        inputs["insert_half_length"] = _inp(half, "m",
                                            _provenance(gr, "axial_half_length", "graphite_insert.axial_half_length")
                                            if gr.axial_half_length else
                                            _provenance(gr, "axial_half_length_ratio",
                                                        "graphite_insert.axial_half_length_ratio") + " x D_t")
        inputs["insert_conductivity"] = _inp(float(gr.thermal_conductivity), "W/(m K)",
                                             _provenance(gr, "thermal_conductivity", "graphite_insert.thermal_conductivity"))
    inputs["case_declared"] = _inp(case_declared, "", _provenance(config, "stainless_steel_case", "stainless_steel_case"))
    return {
        "name": "chamber and nozzle hardware along the burn (EngineDesign erosion replay)",
        "source": ("engine/pipeline/time_varying_solver.py (wall stations, 1-D transient conduction per station; "
                   "geometry rebuilt from cumulative recession) and engine/pipeline/thermal/gas_side.py "
                   "wall_contour (barrel, 45 deg cone, 1.5 R_t arc, Rao bell)"),
        "assumptions": [
            "eroded frames are the as-built contour plus each station's recession, linear between the liner "
            "stations and flat beyond them, the throat station's over the insert's upstream half: the "
            "recession the solver integrates the volume from. The solver's own gas loads use a contour "
            "redrawn from (A_t, bore, V) each step (gas_side.contour_for), which is not this drawing: at the "
            "liner end the redraw moves the wall ~0.2 mm where the station receded ~2 mm (audit 5.4)",
            "the insert's downstream half and the divergent nozzle do not recede in the model; A_e is fixed "
            "unless the nozzle ablates, so eps = A_e/A_t(t) falls as the throat opens",
            "liner and insert drawn as radial offsets of the as-built contour by their initial thickness",
            "L* = V(t)/A_t(t), with V(t) the as-built volume plus the liner recession times its coverage "
            "fraction plus the insert's upstream-half recession",
            "contraction ratio = (D_barrel(t)/D_t(t))^2, at the barrel station",
            f"insert back face: {back_basis}" + ("" if case_declared else
                                                 "; no case or backing is declared, so nothing behind the "
                                                 "insert takes heat (audit D17)"),
            "values at the replay points only; the twin's steps between them are interpolations",
        ],
        "inputs": inputs,
    }
