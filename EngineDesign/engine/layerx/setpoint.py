"""Set point: the dome dial, lockup and bottle fill that give a target mean thrust.

The old optimiser searched lockup and fill for the most impulse, and the answer was always its cap:
impulse at a fixed load rises steadily with lockup (docs/layerx/AUDIT.md D6, 9.10). The operator's
question is the inverse one -- "which dome and fill give 7.2 kN, and what O/F and tank peak do I get
there" -- and it has a root, not an optimum. This solves it.

**Unknowns.** Tank lockup [psia] (the dome dial follows from it exactly: ``prepare.dome_for_lockup``
is affine in the dial) and the bottle fill [psig].

**Equations.**

1. Mean thrust of the burn (impulse over burn time, on the replay basis by default) equals the
   target, within ``thrust_tol_rel``.
2. With ``solve_fill``: the bottle over lockup at burnout lies between ``margin_psi`` and
   ``margin_psi + margin_tol_psi`` -- the least fill that keeps the margin. The band is one-sided
   (the solve aims at its middle) so an accepted fill never sits under the margin the shared
   limit grades ``bottle_margin`` against.

**Method.** Every point is a whole Layer X burn with the rail's settings: no surrogate, and the
answer is the last burn, never an interpolation.

* Lockup alone (fill held): the current settings and a proportional first guess burn in parallel,
  then Newton steps whose slope is the least-squares slope of mean thrust against lockup over the
  burns so far (with two burns this is the secant method; Press et al., *Numerical Recipes*, 3rd ed.,
  2007, sec. 9.2). On LE4 thrust is linear in lockup (10.0-10.2 N/psi, AUDIT 9.10 3.2), so this is
  three burns.
* Then lockup and fill together: Broyden's method (C. G. Broyden, "A class of methods for solving
  nonlinear simultaneous equations", *Mathematics of Computation* 19(92), 577-593, 1965). Its first
  Jacobian takes the lockup column from the burns above (measured) and the fill column from a stated
  assumption (spare rises 1 psi per psi of fill; fill does not move mean thrust), then each burn
  updates it.

**What it cannot do.** One dome regulator presses both tanks, so the set point cannot move O/F
(AUDIT 9.10 3.1: -0.087 % over 578-625 psia). It reports O/F and its offset from a stated design
O/F and points at Hardware mode (holes, line resistance, a trim orifice). Fuel lead is not modelled:
both mains open together at Fire (AUDIT 9.10 3.6).

**Limits.** Every burn is graded with the shared limits (``engine.layerx.diag.limits.grade`` when it
exists; until then a fallback built on ``optimize.grade`` plus each tank's peak against its MAWP, its
MEOP when given, and the design's cap), and a vessel trip ends the burn and fails it. The set point
is a root, not a search, so a limit does not bend the answer: a solution that breaks one is reported
as infeasible with the lockup where the binding limit is reached (linear through the burns,
labelled an estimate).
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

PSI = 6894.757293168361

Progress = Callable[[str, float], None]

#: First Jacobian column for the fill (Broyden updates it from the burns). Spare at burnout rises
#: one psi per psi of fill when the gas drawn is independent of the fill (AUDIT 9.10 3.4 measured
#: 0.83 psi/psi between 3700 and 4500 psig on LE4, less near dropout); fill does not move the mean
#: thrust except through the regulator's supply-pressure effect and dropout (-12 N over 800 psi).
D_SPARE_D_FILL_GUESS = 1.0
D_THRUST_D_FILL_GUESS = 0.0

#: A Newton step on lockup is capped at this fraction of the lockup: the burns are linear over
#: +-8 % on LE4, and a step past that is outside what the slope was measured on.
MAX_LOCKUP_STEP = 0.15

#: The parameters a set point leaves unmeasured: what the integrator puts in the uncertainty sweep,
#: because each one moves the answer.
UNMEASURED = [
    {"key": "regulator.supply_pressure_effect", "where": "drawing PR_D supply_coefficient",
     "why": "sets the in-burn tank rise, so the lockup for a mean thrust and the tank peak (17 psi/1000 psi "
            "drawing vs 10 in EngineDesign's 1092 note, AUDIT D9)"},
    {"key": "regulator.droop", "where": "drawing PR_D droop (He value is a GN2 back-fit tagged measured)",
     "why": "moves the delivered lockup under flow and the bottle spare (AUDIT D14)"},
    {"key": "tank.MAWP", "where": "drawing tank MAWP (1000 psi, estimated)", "why": "a limit the answer is graded on"},
    {"key": "tank.MEOP", "where": "request meop_psi (user-stated 750 psi fuel; LOX unstated)",
     "why": "a limit the answer is graded on (AUDIT D11)"},
    {"key": "margin_psi", "where": "request", "why": "assumed 100 psi bottle over lockup at burnout; sets the fill"},
    {"key": "design_requirements.target_thrust", "where": "config",
     "why": "the target itself; the YAML says 6500 N, the stated goal is ~7.2 kN (AUDIT 9.10 6)"},
    {"key": "design_requirements.optimal_of_ratio", "where": "config",
     "why": "the O/F the offset is reported against (1.5 vs Forward mode's 1.523, AUDIT D12)"},
    {"key": "nozzle_efficiency", "where": "config (0.95 schema default, no source)",
     "why": "scales thrust directly, so the lockup for a target (AUDIT D16)"},
    {"key": "erosion inputs (Bartz coefficient, wall O/F)", "where": "replay",
     "why": "the replay's mean thrust carries the eroding throat (AUDIT finding 10)"},
]


@dataclass(frozen=True)
class SetpointRequest:
    target_thrust_N: Optional[float] = None
    """The mean thrust to reach [N]. ``None``: ``design_requirements.target_thrust``."""
    thrust_tol_rel: float = 1.0e-3
    solve_fill: bool = True
    margin_psi: float = 100.0
    """Bottle over lockup at burnout [psi]: the least fill that keeps it. 100 psi is the margin the
    old optimiser and the uncertainty sweep use, for the regulator model's single back-fit."""
    margin_tol_psi: float = 20.0
    """Width of the accepted band above the margin [psi]: the answer's spare is in
    [margin_psi, margin_psi + margin_tol_psi], never under the margin."""
    meop_psi: Optional[Dict[str, float]] = None
    """Per tank side (``oxidiser``/``fuel``), a maximum expected operating pressure across the wall
    [psi], graded as a limit on the tank's peak."""
    design_of: Optional[float] = None
    """The O/F the offset is reported against. ``None``: ``design_requirements.optimal_of_ratio``."""
    max_burns: int = 10
    replay: bool = True
    """Burn the search on the replay basis (the Burn tab's). Off: search without the replay, then
    verify the answer with it and correct once for the offset."""
    verify: bool = True
    """With ``replay`` off: burn the answer again with the replay (and correct once)."""
    lockup_bounds_psia: Optional[Tuple[float, float]] = None
    """Hard window for the lockup. ``None``: 50 %-150 % of the starting lockup, and never above the
    lowest tank MAWP on the drawing."""

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "SetpointRequest":
        known = set(cls.__dataclass_fields__)
        out = cls(**{k: (tuple(v) if k == "lockup_bounds_psia" and v is not None else v)
                     for k, v in raw.items() if k in known and v is not None})
        if out.max_burns < 1:
            raise ValueError("max_burns must be at least 1")
        if not 0.0 < out.thrust_tol_rel < 0.5:
            raise ValueError("thrust_tol_rel must be between 0 and 0.5")
        return out


def target_thrust(config: Any, request: SetpointRequest) -> Tuple[float, str]:
    """The mean thrust to reach and where it came from. Raises ``ValueError`` when there is none."""
    if request.target_thrust_N:
        return float(request.target_thrust_N), "request"
    req = getattr(config, "design_requirements", None)
    value = getattr(req, "target_thrust", None) if req is not None else None
    if not value or not math.isfinite(float(value)) or float(value) <= 0:
        raise ValueError("No target thrust: the design states no design_requirements.target_thrust; enter one.")
    return float(value), ("design_requirements.target_thrust (the schema calls it a peak thrust; the set point "
                          "targets the burn's mean)")


def design_of_ratio(config: Any, request: Any) -> Tuple[Optional[float], str]:
    if getattr(request, "design_of", None):
        return float(request.design_of), "request"
    req = getattr(config, "design_requirements", None)
    value = getattr(req, "optimal_of_ratio", None) if req is not None else None
    return ((float(value), "design_requirements.optimal_of_ratio (AUDIT D12: Forward mode's O/F is the other "
                           "candidate reference)") if value else (None, "none stated"))


# ---------------------------------------------------------------------- one burn


def figures(res: Dict[str, Any], lockup_psia: Optional[float]) -> Dict[str, Any]:
    """A burn's graded figures, flat, on the delivered (replay) basis where there is one. The keys
    are the change list's (engine.layerx.diff.FIGURES)."""
    s = res.get("summary") or {}
    dv_all = res.get("delivered") or {}
    dv = dv_all.get("summary") or {}
    ox, fu = s.get("ox") or {}, s.get("fuel") or {}

    def pick(key: str) -> Any:
        v = dv.get(key)
        return v if v is not None else s.get(key)

    mean, peak, low = pick("mean_thrust_N"), pick("peak_thrust_N"), pick("min_thrust_N")
    thrust_series = dv_all.get("thrust_N") or []
    t0 = next((v for v in thrust_series if isinstance(v, (int, float)) and math.isfinite(v)), None)
    copv_end = s.get("copv_end_psia")
    # The bottle's spare on the shared limit's basis (diag.limits ``bottle_margin``): over the higher
    # tank's pressure at T-0 when the run reports it, else over the lockup asked for. One number, so
    # the fill the solve accepts is the one the limit grades.
    t0_tanks = [float(v) for v in (ox.get("t0_psia"), fu.get("t0_psia"))
                if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)]
    spare_over = max(t0_tanks) if t0_tanks else lockup_psia
    return {
        "mean_thrust_N": mean,
        "thrust_t0_N": t0 if t0 is not None else s.get("thrust_t0_N"),
        "peak_thrust_N": peak,
        "min_thrust_N": low,
        "thrust_spread_pct": ((peak - low) / mean * 100.0) if mean and peak is not None and low is not None else None,
        "total_impulse_Ns": pick("total_impulse_Ns"),
        "impulse_to_depletion_Ns": pick("impulse_to_depletion_Ns"),
        "burn_time_s": s.get("burn_time_s"),
        "of_mean": s.get("of_mean"),
        "pc_mean_psia": pick("pc_mean_psia"),
        "isp_mean_s": pick("isp_mean_s"),
        "ox_peak_psia": ox.get("peak_psia"),
        "fuel_peak_psia": fu.get("peak_psia"),
        "ox_stiffness_min": ox.get("stiffness_min"),
        "fuel_stiffness_min": fu.get("stiffness_min"),
        "ox_residual_kg": ox.get("residual_kg"),
        "fuel_residual_kg": fu.get("residual_kg"),
        "ox_used_kg": (ox["loaded_kg"] - ox["residual_kg"]) if ox.get("loaded_kg") is not None
        and ox.get("residual_kg") is not None else None,
        "fuel_used_kg": (fu["loaded_kg"] - fu["residual_kg"]) if fu.get("loaded_kg") is not None
        and fu.get("residual_kg") is not None else None,
        "copv_end_psia": copv_end,
        "copv_spare_psi": (copv_end - spare_over) if copv_end is not None and spare_over else None,
        "chug_margin_min": dv.get("chug_margin_min"),
        "throat_area_growth": dv.get("throat_area_growth"),
        "depleted_side": s.get("depleted_side"),
        "failed_steps": s.get("failed_steps"),
        "card_outside_steps": s.get("card_outside_steps"),
        "converged": res.get("converged", True),
        "replayed": bool(dv),
    }


def _row(key: str, label: str, group: str, value: Optional[float], limit: Optional[float], direction: str,
         unit: str, basis: str, hint: str, *, warn: Optional[float] = None, soft: bool = False) -> Dict[str, Any]:
    """One limit in the contract's shape (docs/layerx/DATA-CONTRACT.md 1). ``soft``: grades warn, not bad."""
    if value is None or limit is None:
        grade = "info"
    else:
        over = value > limit if direction == "max" else value < limit
        near = warn is not None and (value > warn if direction == "max" else value < warn)
        grade = ("warn" if soft else "bad") if over else ("warn" if near else "ok")
    return {"key": key, "label": label, "group": group, "value": value, "unit": unit, "limit": limit, "warn": warn,
            "direction": direction, "grade": grade, "t_worst": None, "index_worst": None, "series_ref": None,
            "basis": basis, "hint": hint}


def _fallback_limits(res: Dict[str, Any], prep: Any, config: Any, grading: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The limits until ``engine/layerx/diag/limits.py`` exists: ``optimize.grade``'s (bottle margin,
    injector stiffness, a tank runs dry, every step solves) and each tank's peak against its MAWP and
    the design's cap."""
    from engine.layerx import optimize as opt

    d = prep.derived
    lockup = float(d["target_lockup_psia"])
    e = {"ok": True, "preflight": [], "figures": opt._figures(res), "x": {"lockup_psia": lockup}, "lockup_psia": lockup}
    req = opt.OptimizeRequest(dropout_margin_psi=float(grading.get("margin_psi", 100.0)), stiffness=True)
    graded = opt.grade(e, req, d.get("stiffness_band") or {}, None)
    groups = {"dropout": "pressurant", "stiffness_ox": "injector", "stiffness_fuel": "injector",
              "depletion": "propellant", "solve": "model"}
    rows = []
    for c in graded["constraints"]:
        if "value" in c:
            rows.append(_row(c["key"], c["label"], groups.get(c["key"], "model"), c["value"], c["limit"], c["kind"],
                             c.get("unit", ""), "optimize.grade (fallback)", "the old optimiser's constraint"))
        else:
            rows.append({**_row(c["key"], c["label"], groups.get(c["key"], "model"), None, None, "min", "",
                                "optimize.grade (fallback)", c.get("detail", "")), "grade": "bad"})
    ambient_psia = float(d.get("ambient_pa") or 101325.0) / PSI
    s = res.get("summary") or {}
    roles = getattr(prep, "roles", {}) or {}
    mawp = d.get("tank_mawp_psi") or {}
    dr = getattr(config, "design_requirements", None)
    for side, block, cap_key in (("oxidiser", "ox", "max_lox_tank_pressure_psi"), ("fuel", "fuel", "max_fuel_tank_pressure_psi")):
        peak = (s.get(block) or {}).get("peak_psia")
        tank = roles.get(side)
        word = "LOX" if side == "oxidiser" else "Fuel"
        if tank in mawp:
            rows.append(_row(f"tank_peak_mawp.{side}", f"{word} tank peak vs MAWP", "tanks", peak,
                             mawp[tank] + ambient_psia, "max", "psia", f"drawing {tank} MAWP over the site's atmosphere",
                             "MAWP is across the wall: held against the site's atmosphere"))
        cap = getattr(dr, cap_key, None) if dr is not None else None
        if cap:
            rows.append(_row(f"tank_peak_cap.{side}", f"{word} tank peak vs the design's cap", "tanks", peak, float(cap),
                             "max", "psia", f"design_requirements.{cap_key}, read as psia as the optimiser did",
                             "warn until AUDIT D11 decides whether the cap is a T-0 or a peak limit", soft=True))
    return rows


def grade_limits(res: Dict[str, Any], prep: Any, config: Any, grading: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], str]:
    """Every limit of one burn: the shared grade when it exists, else the fallback; plus the
    request's own MEOP and the vessel trip if the shared grade did not carry them."""
    rows: List[Dict[str, Any]] = []
    basis = ""
    try:
        from engine.layerx.diag.limits import grade as shared  # written alongside; may not exist yet
    except ImportError:
        shared = None
    meop = {k: float(v) for k, v in (grading.get("meop_psi") or {}).items() if v}
    if shared is not None:
        try:
            # The request's MEOP goes to the shared grade, so it is graded once, on the contract's
            # basis (psi across the wall, ``tank_meop_ox``/``tank_meop_fuel``).
            rows = [dict(r) for r in shared(res, prep=prep, config=config, meop_psi=meop or None) or []]
            basis = "engine.layerx.diag.limits.grade"
        except Exception as exc:  # noqa: BLE001 - the burn stands; the fallback grades it
            basis = f"diag.limits.grade failed ({type(exc).__name__}: {exc}); "
            rows = []
    if not rows:
        rows = _fallback_limits(res, prep, config, grading)
        basis += "fallback: optimize.grade, tank peaks vs MAWP and the design cap"
    keys = {r.get("key") for r in rows}
    d = prep.derived
    ambient_psia = float(d.get("ambient_pa") or 101325.0) / PSI
    s = res.get("summary") or {}
    for side, block in (("oxidiser", "ox"), ("fuel", "fuel")):
        m = meop.get(side)
        if m and f"tank_peak_meop.{side}" not in keys and f"tank_meop_{block}" not in keys:
            rows.append(_row(f"tank_peak_meop.{side}", f"{'LOX' if side == 'oxidiser' else 'Fuel'} tank peak vs MEOP",
                             "tanks", (s.get(block) or {}).get("peak_psia"), m + ambient_psia, "max", "psia",
                             "the request's MEOP over the site's atmosphere", "MEOP is across the wall"))
    if not any("trip" in str(k) for k in keys):
        tripped = res.get("tripped")
        rows.append({**_row("vessel_trip", "No vessel trips", "model", None, None, "max", "",
                            "result.tripped (feedtwin MAWP trip)", "a trip stops the burn; what follows is frozen"),
                     "grade": "bad" if tripped else "ok", "value": tripped or None})
    return rows, basis


def _dome_per_1000psi_fill(prep: Any, lockup_psia: float, fill_psig: float) -> Optional[float]:
    """d(dome dial)/d(fill) at this lockup [psi per 1000 psi], from the drawing's regulators on a copy
    of the model (the burn's own model is not touched)."""
    import copy

    from feedtwin.session.gauge import from_psig

    from engine.layerx.prepare import dome_for_lockup

    try:
        model = copy.deepcopy(prep.model)
        hi = dome_for_lockup(model, lockup_psia * PSI, from_psig(fill_psig + 250.0))
        lo = dome_for_lockup(model, lockup_psia * PSI, from_psig(max(fill_psig - 250.0, lockup_psia)))
        span = (fill_psig + 250.0) - max(fill_psig - 250.0, lockup_psia)
        if hi is None or lo is None or span <= 0:
            return None
        return (hi - lo) / span * 1000.0
    except Exception:  # noqa: BLE001 - a readout
        return None


def _stand_ids(prep: Any) -> Dict[str, Optional[str]]:
    """The drawing ids the stand settings belong to: the dome loader (the dial), the dome-loaded
    regulator (lockup), the bottle (fill)."""
    from engine.layerx.prepare import _dome_regulators

    out: Dict[str, Optional[str]] = {"loader": None, "regulator": None, "bottle": prep.derived.get("copv_id")}
    try:
        loaders = list(getattr(prep.model.built, "dome_loaders", {}).values())
        out["loader"] = loaders[0].id if loaders else None
        regs = _dome_regulators(prep.model)
        out["regulator"] = regs[0][0] if regs else None
    except Exception:  # noqa: BLE001 - labels only
        pass
    return out


def burn_point(args: Dict[str, Any]) -> Dict[str, Any]:
    """Burn one point, start to finish, in whatever process runs it, and grade it.

    ``args``: config, drawing, settings, overrides, and optionally lockup_psia, fill_psig, replay,
    extra_overrides (drawing restatements for this point only), grading {margin_psi, meop_psi},
    index, tag. Never raises: a failure is ``ok: False`` with the error."""
    from engine.layerx.analysis import run_prepared
    from engine.layerx.prepare import prepare

    started = time.perf_counter()
    base = {"index": args.get("index"), "tag": args.get("tag"), "lockup_psia": args.get("lockup_psia"),
            "fill_psig": args.get("fill_psig"), "replay": bool(args.get("replay", True))}
    try:
        changes: Dict[str, Any] = {"replay": base["replay"], "card_center_psia": None}
        if args.get("lockup_psia") is not None:
            changes["tank_pressure_psia"] = float(args["lockup_psia"])
        if args.get("fill_psig") is not None:
            changes["copv_pressure_psig"] = float(args["fill_psig"])
        settings = replace(args["settings"], **changes)
        config = args["config"]
        prep = prepare(config, None, args["drawing"], settings,
                       list(args.get("overrides") or []) + list(args.get("extra_overrides") or []))
        d = prep.derived
        if not prep.ok:
            return {**base, "ok": False, "preflight": [f"{c.label}: {c.detail}" for c in prep.checks if c.status == "fail"],
                    "error": "preflight failed", "wall_s": time.perf_counter() - started}
        lockup, fill = float(d["target_lockup_psia"]), float(d["copv_psig"])
        dome_rate = _dome_per_1000psi_fill(prep, lockup, fill)
        ids = _stand_ids(prep)
        res = run_prepared(prep, replay=base["replay"], config=config)
        figs = figures(res, lockup)
        figs.update({"dome_psig": d["dome_psig"], "lockup_psia": lockup})
        limits, limits_basis = grade_limits(res, prep, config, args.get("grading") or {})
        return {**base, "ok": True, "preflight": [], "lockup_psia": lockup, "fill_psig": fill, "dome_psig": d["dome_psig"],
                "dome_per_1000psi_fill": dome_rate, "figures": figs, "limits": limits, "limits_basis": limits_basis,
                "tripped": res.get("tripped"), "converged": res.get("converged", True),
                "derived": {"copv_drawn_psig": d.get("copv_drawn_psig"), "tank_mawp_psi": d.get("tank_mawp_psi"),
                            "ambient_pa": d.get("ambient_pa"), "pressurant_gas": d.get("pressurant_gas"),
                            "copv_id": d.get("copv_id"), "config_sha256": prep.config_sha256, "stand_ids": ids,
                            "drawing": {"id": prep.drawing.id, "name": prep.drawing.name, "sha256": prep.drawing.sha256}},
                "wall_s": time.perf_counter() - started}
    except Exception as exc:  # noqa: BLE001 - one failed burn is reported; the solve decides what to do
        # A trip in the settle (analysis.StandTripped) is still a trip: the solve reads ``tripped``.
        record = getattr(exc, "record", None)
        return {**base, "ok": False, "preflight": [], "error": f"{type(exc).__name__}: {exc}",
                "tripped": record if isinstance(record, dict) else None, "wall_s": time.perf_counter() - started}


def usable(p: Optional[Dict[str, Any]]) -> bool:
    """A burn whose mean thrust can be used: it ran, passed preflight, did not trip, and reports one."""
    if not p or not p.get("ok") or p.get("preflight") or p.get("tripped"):
        return False
    m = (p.get("figures") or {}).get("mean_thrust_N")
    return isinstance(m, (int, float)) and math.isfinite(m)


def feasible(p: Optional[Dict[str, Any]]) -> bool:
    return usable(p) and not any(r.get("grade") == "bad" for r in p.get("limits") or [])


# ---------------------------------------------------------------------- the solve


Evaluate = Callable[[List[Tuple[float, Optional[float], bool]]], List[Dict[str, Any]]]


@dataclass
class _State:
    history: List[Dict[str, Any]] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)


def _fit_slope(points: Sequence[Tuple[float, float]]) -> Optional[float]:
    """Least-squares slope through ``(x, y)``; with two points it is the secant."""
    if len(points) < 2:
        return None
    n = float(len(points))
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    sxx = sum((p[0] - mx) ** 2 for p in points)
    if sxx <= 1e-12:
        return None
    return sum((p[0] - mx) * (p[1] - my) for p in points) / sxx


def solve(evaluate: Evaluate, *, start_lockup: float, start_fill: float, max_fill: float, target: float,
          request: SetpointRequest, bounds: Tuple[float, float], first_guess: Optional[float] = None,
          say: Progress = lambda s, f: None, cancelled: Callable[[], bool] = lambda: False,
          seed: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """The root, by whole burns through ``evaluate``. Pure in everything but ``evaluate``, so it is
    tested against a closed-form stand.

    ``evaluate([(lockup, fill, replay), ...])`` burns the points (in parallel when it can) and returns
    one :func:`burn_point`-shaped dict each. ``first_guess`` is the second lockup of the opening pair
    (burned alongside the starting point); ``None``: proportional to the thrust missing. ``seed``: burns
    already made at the starting point (Hardware mode's candidate), used instead of burning it again;
    they do not count against ``max_burns``."""
    from engine.layerx.pool import Cancelled

    st = _State()
    lo, hi = bounds
    replay = bool(request.replay)
    tol_F = request.thrust_tol_rel * target
    seeded = [{**p, "stage": "seed", "asked": {"lockup_psia": p.get("lockup_psia"), "fill_psig": p.get("fill_psig")}}
              for p in (seed or [])]
    st.history.extend(seeded)
    budget = max(1, int(request.max_burns)) + len(seeded)

    def burn(points: List[Tuple[float, float]], stage: str, *, rp: Optional[bool] = None) -> List[Dict[str, Any]]:
        if cancelled():
            raise Cancelled()
        left = budget - len(st.history)
        if left <= 0:
            return []
        points = points[:left]
        out = evaluate([(L, F, replay if rp is None else rp) for L, F in points])
        for (L, F), p in zip(points, out):
            p = {**p, "stage": stage, "asked": {"lockup_psia": L, "fill_psig": F}}
            st.history.append(p)
        return st.history[-len(points):]

    def thrust_err(p: Dict[str, Any]) -> float:
        return float(p["figures"]["mean_thrust_N"]) - target

    # The fill's band is one-sided, [margin, margin + tol]: aim at its middle and accept half the tol
    # either way, so a "solved" fill never leaves less than the margin (which the shared limit grades).
    half_band = 0.5 * float(request.margin_tol_psi)
    spare_aim = float(request.margin_psi) + half_band

    def spare_err(p: Dict[str, Any]) -> Optional[float]:
        s = p["figures"].get("copv_spare_psi")
        return None if s is None else float(s) - spare_aim

    def clamp(L: float, ref: float) -> float:
        step = L - ref
        cap = MAX_LOCKUP_STEP * ref
        if abs(step) > cap:
            L = ref + math.copysign(cap, step)
        return min(max(L, lo), hi)

    # ---- 1. lockup at the current fill ------------------------------------------------------
    L0, F0 = min(max(start_lockup, lo), hi), start_fill
    if first_guess is None or not math.isfinite(first_guess):
        first_guess = L0 * 1.03
    L1 = clamp(first_guess, L0)
    if abs(L1 - L0) < 0.5:
        L1 = clamp(L0 * 1.02, L0)
    say("Burning the current settings and a first guess", 0.05)
    pair = seeded + burn([(L1, F0)], "bracket") if seeded else burn([(L0, F0), (L1, F0)], "bracket")
    before = pair[0] if pair else None
    good = [p for p in pair if usable(p)]
    if not good:
        errs = "; ".join(p.get("error") or "; ".join(p.get("preflight") or []) or "tripped" for p in pair)
        raise ValueError(f"neither opening burn could be used: {errs}")

    def at_fill(F: float) -> List[Dict[str, Any]]:
        return [p for p in st.history if usable(p) and abs(float(p["fill_psig"]) - F) < 0.5 and p["replay"] == replay]

    def best_of(ps: List[Dict[str, Any]]) -> Dict[str, Any]:
        return min(ps, key=lambda p: abs(thrust_err(p)))

    current = best_of(good)
    bad_retries = 0
    while abs(thrust_err(current)) > tol_F and len(st.history) < budget:
        same = at_fill(F0)
        slope = _fit_slope([(float(p["lockup_psia"]), float(p["figures"]["mean_thrust_N"])) for p in same])
        if slope is None or slope <= 0:
            if slope is not None:
                st.notes.append(f"Mean thrust does not rise with lockup between the burns (slope {slope:.2f} N/psi); "
                                "the solve stopped.")
                break
            slope = float(current["figures"]["mean_thrust_N"]) / float(current["lockup_psia"])  # proportional
        anchor = best_of(same)
        L_a = float(anchor["lockup_psia"])
        L_new = clamp(L_a - thrust_err(anchor) / slope, L_a)
        # A lockup whose burn could not be used (a trip, a failed solve) bounds the next step: go no
        # further than halfway to it.
        failed = [float(p["asked"]["lockup_psia"]) for p in st.history
                  if not usable(p) and abs(float(p["asked"]["fill_psig"]) - F0) < 0.5]
        above = [L for L in failed if L > L_a]
        below = [L for L in failed if L < L_a]
        if above and L_new >= min(above):
            L_new = 0.5 * (L_a + min(above))
        if below and L_new <= max(below):
            L_new = 0.5 * (L_a + max(below))
        if any(abs(float(p["asked"]["lockup_psia"]) - L_new) < 1e-6 and abs(float(p["asked"]["fill_psig"]) - F0) < 0.5
               for p in st.history):
            st.notes.append("The next lockup is one already burned (a bound, or the slope's resolution): stopped.")
            break
        say(f"Lockup {L_new:.1f} psia (burn {len(st.history) + 1})", 0.1 + 0.5 * len(st.history) / budget)
        got = burn([(L_new, F0)], "lockup")
        if not got:
            break
        if usable(got[0]):
            current = best_of(at_fill(F0))
        else:
            bad_retries += 1
            st.notes.append(f"The burn at {L_new:.1f} psia could not be used ({got[0].get('error') or 'tripped'}); "
                            "stepping back toward the last good lockup.")
            if bad_retries > 2:
                break
    lockup_done = abs(thrust_err(current)) <= tol_F

    # ---- 2. lockup and fill together (Broyden) -------------------------------------------------
    fill_status = "held"
    if request.solve_fill and lockup_done and spare_err(current) is not None:
        x = [float(current["lockup_psia"]), float(current["fill_psig"])]
        r = [thrust_err(current), float(spare_err(current))]
        same = at_fill(F0)
        a = _fit_slope([(float(p["lockup_psia"]), float(p["figures"]["mean_thrust_N"])) for p in same])
        c = _fit_slope([(float(p["lockup_psia"]), float(p["figures"]["copv_spare_psi"])) for p in same
                        if p["figures"].get("copv_spare_psi") is not None])
        J = [[a if a and a > 0 else float(current["figures"]["mean_thrust_N"]) / x[0], D_THRUST_D_FILL_GUESS],
             [c if c is not None else -1.0, D_SPARE_D_FILL_GUESS]]
        fill_status = "solving"
        damp = 1.0
        while not (abs(r[0]) <= tol_F and abs(r[1]) <= half_band) and len(st.history) < budget:
            det = J[0][0] * J[1][1] - J[0][1] * J[1][0]
            if not math.isfinite(det) or abs(det) < 1e-12:
                st.notes.append("The fill and lockup no longer move thrust and spare independently: stopped.")
                break
            dx = [-damp * (J[1][1] * r[0] - J[0][1] * r[1]) / det, -damp * (-J[1][0] * r[0] + J[0][0] * r[1]) / det]
            F_new = x[1] + dx[1]
            f_floor = x[0] + request.margin_psi     # below this no burn can keep the margin
            if F_new > max_fill:
                if x[1] >= max_fill - 0.5 and r[1] + half_band < 0:      # a full bottle under the margin itself
                    fill_status = "bottle_short"
                    st.notes.append(f"A full bottle ({max_fill:.0f} psig, as drawn) leaves {r[1] + spare_aim:.0f} psi "
                                    f"at burnout, under the {request.margin_psi:.0f} psi margin: the drawn bottle cannot "
                                    "keep the margin at this thrust.")
                    break
                F_new = max_fill
            if F_new < f_floor:
                F_new = 0.5 * (x[1] + f_floor)
            L_new = clamp(x[0] + dx[0], x[0])
            say(f"Lockup {L_new:.1f} psia, fill {F_new:.0f} psig (burn {len(st.history) + 1})",
                0.1 + 0.8 * len(st.history) / budget)
            got = burn([(L_new, F_new)], "lockup+fill")
            if not got:
                break
            p = got[0]
            if not usable(p) or spare_err(p) is None:
                # A trip or a failed solve on the way down in fill: halve the step from the last good point.
                st.notes.append(f"The burn at {L_new:.1f} psia / {F_new:.0f} psig could not be used "
                                f"({p.get('error') or 'tripped'}); halving the step.")
                damp *= 0.5
                if damp < 0.2:
                    break
                continue
            damp = 1.0
            x_new = [float(p["lockup_psia"]), float(p["fill_psig"])]
            r_new = [thrust_err(p), float(spare_err(p))]
            s = [x_new[0] - x[0], x_new[1] - x[1]]
            ss = s[0] ** 2 + s[1] ** 2
            if ss > 1e-12:
                y = [r_new[0] - r[0], r_new[1] - r[1]]
                Js = [J[0][0] * s[0] + J[0][1] * s[1], J[1][0] * s[0] + J[1][1] * s[1]]
                for i in range(2):
                    for j in range(2):
                        J[i][j] += (y[i] - Js[i]) * s[j] / ss
            x, r, current = x_new, r_new, p
        if fill_status == "solving":
            fill_status = "solved" if abs(r[1]) <= half_band and abs(r[0]) <= tol_F else "unsolved"

    # ---- 3. verify on the replay basis (search burned without it) ------------------------------
    verified = None
    if not replay and request.verify and usable(current):
        say("Verifying the answer with the erosion replay", 0.92)
        L, F = float(current["lockup_psia"]), float(current["fill_psig"])
        got = burn([(L, F)], "verify", rp=True)
        if got and usable(got[0]):
            verified = got[0]
            offset = thrust_err(verified)
            slope = _fit_slope([(float(p["lockup_psia"]), float(p["figures"]["mean_thrust_N"]))
                                for p in at_fill(float(current["fill_psig"]))]) or \
                float(current["figures"]["mean_thrust_N"]) / L
            if abs(offset) > tol_F and slope > 0:
                # The replay moves every lockup by nearly the same amount: correct once for it.
                got = burn([(clamp(L - offset / slope, L), F)], "verify (corrected)", rp=True)
                if got and usable(got[0]):
                    verified = got[0]
            current = verified

    final = current
    converged = abs(thrust_err(final)) <= tol_F and (not request.solve_fill or fill_status in ("solved", "bottle_short"))
    if len(st.history) >= budget and not converged:
        st.notes.append(f"Stopped at the {budget}-burn budget before both targets were met; the last burn is shown.")
    return {"final": final, "before": before, "history": st.history, "notes": st.notes, "converged": converged,
            "lockup_converged": lockup_done or abs(thrust_err(final)) <= tol_F, "fill_status": fill_status}


# ---------------------------------------------------------------------- the job


def _binding_estimate(history: List[Dict[str, Any]], final: Dict[str, Any], target: float) -> List[Dict[str, Any]]:
    """For each limit the answer breaks: the lockup where it is reached, and the mean thrust there,
    linear through the burns at the answer's fill. An estimate: not burned."""
    out = []
    F = float(final["fill_psig"])
    same = [p for p in history if usable(p) and abs(float(p["fill_psig"]) - F) < 0.5]
    thrust_line = _fit_slope([(float(p["lockup_psia"]), float(p["figures"]["mean_thrust_N"])) for p in same])
    for row in final.get("limits") or []:
        if row.get("grade") != "bad" or row.get("limit") is None or row.get("value") is None:
            continue
        pts = [(float(p["lockup_psia"]), float(r["value"])) for p in same for r in p.get("limits") or []
               if r.get("key") == row["key"] and isinstance(r.get("value"), (int, float))]
        k = _fit_slope(pts)
        if not k:
            out.append({"key": row["key"], "label": row["label"], "lockup_psia_est": None,
                        "note": "the limit does not move with lockup between the burns"})
            continue
        L_lim = float(final["lockup_psia"]) + (float(row["limit"]) - float(row["value"])) / k
        F_lim = (float(final["figures"]["mean_thrust_N"]) + thrust_line * (L_lim - float(final["lockup_psia"]))
                 if thrust_line else None)
        out.append({"key": row["key"], "label": row["label"], "lockup_psia_est": L_lim, "mean_thrust_N_est": F_lim,
                    "note": "linear in lockup through the burns at this fill; not burned"})
    return out


def _model_block(target: float, target_source: str, request: SetpointRequest, start: Dict[str, Any],
                 max_fill: float, design_of: Optional[float], of_source: str) -> Dict[str, Any]:
    return {
        "name": "Layer X set point: lockup by secant (least-squares slope), then Broyden on (lockup, fill)",
        "source": ("Secant/false position: Press, Teukolsky, Vetterling & Flannery, Numerical Recipes, 3rd ed. "
                   "(2007), sec. 9.2. Broyden, C. G. (1965), 'A class of methods for solving nonlinear simultaneous "
                   "equations', Mathematics of Computation 19(92), 577-593."),
        "assumptions": [
            "Mean thrust rises monotonically with lockup at a fixed fill; the slope is measured from the burns "
            "(LE4: linear, 10.0-10.2 N/psi, docs/layerx/AUDIT.md 9.10 3.2).",
            f"First Broyden column for the fill: spare at burnout rises {D_SPARE_D_FILL_GUESS:g} psi per psi of fill, "
            f"and fill moves mean thrust {D_THRUST_D_FILL_GUESS:g} N/psi (AUDIT 9.10 3.4); each burn updates both.",
            "Every point is a whole Layer X burn with the rail's settings, graded with the shared limits; the answer "
            "is the last burn, not an interpolation.",
            "One dome regulator presses both tanks: the set point does not set O/F.",
            "Fuel lead is not modelled: both mains open together at Fire.",
            "The bottle cannot be filled above the pressure the drawing states for it.",
        ],
        "inputs": {
            "target_mean_thrust_N": {"value": target, "unit": "N", "provenance": target_source},
            "thrust_tol_rel": {"value": request.thrust_tol_rel, "unit": "",
                               "provenance": "request (default 1e-3: ~2x the engine card's fit error)"},
            "bottle_margin_psi": {"value": request.margin_psi if request.solve_fill else None, "unit": "psi",
                                  "provenance": ("request" if request.margin_psi != 100.0 else
                                                 "assumed: the 100 psi the old optimiser and the sweep use, for the "
                                                 "regulator model's single back-fit")},
            "margin_tol_psi": {"value": request.margin_tol_psi, "unit": "psi",
                               "provenance": "request: the accepted band above the margin (one-sided)"},
            "meop_psi": {"value": request.meop_psi, "unit": "psi",
                         "provenance": "request (user-stated)" if request.meop_psi else "not given"},
            "max_fill_psig": {"value": max_fill, "unit": "psig", "provenance": "drawing: the bottle's stated pressure"},
            "start_lockup_psia": {"value": start.get("lockup_psia"), "unit": "psia", "provenance": start.get("source")},
            "start_fill_psig": {"value": start.get("fill_psig"), "unit": "psig", "provenance": start.get("fill_source")},
            "design_of": {"value": design_of, "unit": "", "provenance": of_source},
        },
    }


def _changes(before: Dict[str, Any], final: Dict[str, Any], start: Dict[str, Any], history_n: int) -> List[Dict[str, Any]]:
    from engine.layerx import diff

    ids = (final.get("derived") or {}).get("stand_ids") or {}
    prov = f"solved: Layer X set point, {history_n} whole burns; the last one is this setting"
    rows = []
    for target, component, field_, unit, b, a, node in (
        ("op:dome_psig", "Dome loader (the dial)", "dome_psig", "psig", before.get("dome_psig"), final.get("dome_psig"),
         ids.get("loader")),
        ("op:lockup_psia", "Tank lockup (dome-loaded regulator)", "lockup_psia", "psia",
         before.get("lockup_psia"), final.get("lockup_psia"), ids.get("regulator")),
        ("op:copv_psig", "Bottle fill", "copv_psig", "psig", before.get("fill_psig"), final.get("fill_psig"),
         ids.get("bottle")),
    ):
        if a is None or (isinstance(b, (int, float)) and abs(float(a) - float(b)) < 0.05):
            continue
        rows.append(diff.change(component=component, field=field_, before=None if b is None else round(float(b), 2),
                                after=round(float(a), 2), unit=unit, provenance=prov, cad_impact="setting only",
                                target=target, pid_node_id=node, source="solved",
                                before_provenance=start.get("source") if field_ == "lockup_psia" else
                                start.get("fill_source") if field_ == "copv_psig" else "solved for the starting lockup"))
    return rows


def run_setpoint(config: Any, drawing: Any, settings: Any, overrides: List[Any], request: SetpointRequest, *,
                 progress: Optional[Progress] = None, cancelled: Callable[[], bool] = lambda: False,
                 workers: Optional[int] = None, evaluate: Optional[Evaluate] = None,
                 stand: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """The set point for ``request`` on this drawing and design.

    ``evaluate`` replaces the burns, and ``stand`` the preflight's readings of the drawing
    (``lockup_psia``, ``fill_psig``, ``max_fill_psig``, ``reference_thrust_N``, ``mawp_cap_psia``):
    both for tests, which hand it a closed-form stand."""
    from engine.layerx import diff
    from engine.layerx.pool import WorkerPool, default_workers

    say = progress or (lambda stage, fraction: None)
    started = time.perf_counter()
    target, target_source = target_thrust(config, request)
    design_of, of_source = design_of_ratio(config, request)
    grading = {"margin_psi": request.margin_psi, "meop_psi": dict(request.meop_psi or {}), "design_of": design_of}

    say("Preparing", 0.01)
    lockup0 = getattr(settings, "tank_pressure_psia", None)
    cfg_lockup = float(getattr(getattr(config, "lox_tank", None), "initial_pressure_psi", 0.0) or 0.0)
    start = {"lockup_psia": lockup0 or cfg_lockup,
             "source": "the rail's tank pressure" if lockup0 else "config lox_tank.initial_pressure_psi",
             "fill_psig": getattr(settings, "copv_pressure_psig", None),
             "fill_source": "the rail's bottle pressure" if getattr(settings, "copv_pressure_psig", None) is not None
             else "the drawing's bottle pressure"}
    reference_F = None
    max_fill = None
    mawp_cap = math.inf
    if evaluate is None:
        from engine.layerx.prepare import prepare

        nominal = prepare(config, None, drawing, replace(settings, card_center_psia=None), overrides)
        if not nominal.ok:
            raise ValueError("Preflight failed: " + "; ".join(c.label for c in nominal.checks if c.status == "fail"))
        d = nominal.derived
        start["lockup_psia"] = float(d["target_lockup_psia"])
        start["fill_psig"] = float(d["copv_psig"])
        max_fill = float(d.get("copv_drawn_psig") or d["copv_psig"])
        reference_F = float((nominal.link.reference or {}).get("F") or 0.0) if nominal.link else None
        amb = float(d.get("ambient_pa") or 101325.0) / PSI
        for v in (d.get("tank_mawp_psi") or {}).values():
            mawp_cap = min(mawp_cap, float(v) + amb)
    elif stand:
        start["lockup_psia"] = float(stand.get("lockup_psia") or start["lockup_psia"])
        if stand.get("fill_psig") is not None:
            start["fill_psig"] = float(stand["fill_psig"])
        max_fill = stand.get("max_fill_psig")
        reference_F = stand.get("reference_thrust_N")
        mawp_cap = float(stand.get("mawp_cap_psia") or math.inf)
    if start["fill_psig"] is None:
        raise ValueError("No bottle pressure: the rail and the drawing state none.")
    max_fill = max(max_fill or float(start["fill_psig"]), float(start["fill_psig"]))
    L0 = float(start["lockup_psia"])
    if not L0:
        raise ValueError("No starting tank pressure: the rail and the config state none.")
    lo, hi = request.lockup_bounds_psia or (0.5 * L0, 1.5 * L0)
    hi = min(hi, mawp_cap)
    # The first guess: thrust proportional to tank pressure, from EngineDesign's T-0 thrust at the
    # starting lockup (the mean is a few % above it; the secant corrects that on the next burn).
    guess = L0 * target / reference_F if reference_F else None

    pool = None
    if evaluate is None:
        n_workers = default_workers(2, workers)
        pool = WorkerPool(n_workers)
        base_args = {"config": config, "drawing": drawing, "settings": settings, "overrides": list(overrides),
                     "grading": grading}
        counter = [0]

        def evaluate(points: List[Tuple[float, Optional[float], bool]]) -> List[Dict[str, Any]]:
            args = []
            for L, F, rp in points:
                args.append({**base_args, "lockup_psia": L, "fill_psig": F, "replay": rp, "index": counter[0]})
                counter[0] += 1
            return pool.map(burn_point, args, cancelled=cancelled)
    else:
        n_workers = 1
    try:
        out = solve(evaluate, start_lockup=L0, start_fill=float(start["fill_psig"]), max_fill=max_fill, target=target,
                    request=request, bounds=(lo, hi), first_guess=guess, say=say, cancelled=cancelled)
    finally:
        if pool is not None:
            pool.close(cancelled())
    final, before, history = out["final"], out["before"], out["history"]
    notes = list(out["notes"])
    ok_final = usable(final)
    if not ok_final:
        raise ValueError("no usable burn: " + "; ".join(p.get("error") or "" for p in history))
    fig = final["figures"]
    of = fig.get("of_mean")
    # O/F against lockup, from the burns that share a fill (the lockup-only ones, usually).
    groups: Dict[float, List[Tuple[float, float]]] = {}
    for p in history:
        if usable(p) and p["figures"].get("of_mean") is not None:
            groups.setdefault(round(float(p["fill_psig"]), 0), []).append(
                (float(p["lockup_psia"]), float(p["figures"]["of_mean"])))
    lockup_pts = max(groups.values(), key=len) if groups else []
    of_block = {
        "of_mean": of, "design_of": design_of, "design_of_source": of_source,
        "offset_rel": (of / design_of - 1.0) if of and design_of else None,
        "per_100psi_lockup": (_fit_slope(lockup_pts) or 0.0) * 100.0 if len(lockup_pts) >= 2 else None,
        "settable_here": False,
        "note": ("One dome regulator presses both tanks through one manifold, so lockup and fill move O/F only "
                 "through second-order effects. O/F is set by hardware: the holes (Injector holes), the lines, or a "
                 "trim orifice (Hardware mode)."),
    }
    is_feasible = feasible(final)
    binding = _binding_estimate(history, final, target) if not is_feasible else []
    if not is_feasible:
        bad = [r["label"] for r in final.get("limits") or [] if r.get("grade") == "bad"]
        notes.append("The set point breaks " + ", ".join(bad) + ": the target cannot be met within the limits "
                     "on this drawing (see `binding` for where each limit is reached, estimated).")
    tripped_above = [float(p["asked"]["lockup_psia"]) for p in history
                     if p.get("tripped") and float(p["asked"]["lockup_psia"]) > float(final["lockup_psia"])]
    if tripped_above and not out["converged"]:
        notes.append(f"The target lies beyond a lockup that trips the stand ({min(tripped_above):.1f} psia trips): "
                     f"the highest usable lockup found, {float(final['lockup_psia']):.1f} psia, is shown.")
    if out["fill_status"] == "held" and request.solve_fill:
        notes.append("The fill was not solved: the lockup did not converge first.")
    if not request.replay:
        notes.append("The search burned without the erosion replay" + (
            "; the answer was verified with it." if request.verify else "; its numbers exclude the eroding throat."))
    if fig.get("card_outside_steps"):
        notes.append("The answer's burn asked the engine card about points outside its fitted box.")
    dome = final.get("dome_psig")
    dome_rate = final.get("dome_per_1000psi_fill")
    derived = final.get("derived") or {}
    card = {
        "dome_psig": dome,
        "lockup_psia": final.get("lockup_psia"),
        "copv_fill_psig": final.get("fill_psig"),
        "dome_per_1000psi_fill": dome_rate,
        "dome_at_full_bottle_psig": (dome + dome_rate * (max_fill - float(final["fill_psig"])) / 1000.0
                                     if dome is not None and dome_rate is not None else None),
        "full_bottle_psig": max_fill,
        "fuel_lead_s": getattr(settings, "fuel_lead_s", None),
        "fuel_lead": ("the rail's, burned as given (not solved)" if getattr(settings, "fuel_lead_s", None) is not None
                      else "not modelled: both mains open together at Fire"),
        "pressurant": derived.get("pressurant_gas"),
        "drawing": derived.get("drawing"),
        "config_sha256": derived.get("config_sha256"),
        "ids": derived.get("stand_ids"),
    }
    changes = _changes(before or {}, final, start, len(history))
    before_fig = (before or {}).get("figures") if usable(before) else None
    if before_fig is not None and before is not None:
        before_fig = {**before_fig, "dome_psig": before.get("dome_psig"), "lockup_psia": before.get("lockup_psia")}
    same_basis = before is not None and bool(before.get("replay")) == bool(final.get("replay"))
    change_list = diff.build("setpoint", changes, before=before_fig if same_basis else None, after=fig,
                             limits=final.get("limits"),
                             basis={"config_sha256": derived.get("config_sha256"), "drawing": derived.get("drawing"),
                                    "target_mean_thrust_N": target, "replay": final.get("replay")},
                             notes=[] if same_basis else ["The current settings burned on another basis: no effect "
                                                         "is quoted."])
    change_list["exports"] = {"settings_patch": diff.settings_patch(change_list), "design_write": None,
                              "pid_designer": None}
    say("Done", 1.0)
    return {
        "mode": "setpoint",
        "target": {"mean_thrust_N": target, "source": target_source, "tol_rel": request.thrust_tol_rel,
                   "margin_psi": request.margin_psi if request.solve_fill else None},
        "converged": out["converged"],
        "fill_status": out["fill_status"],
        "feasible": is_feasible,
        "settings_card": card,
        "solution": fig,
        "before": before_fig,
        "of": of_block,
        "limits": final.get("limits"),
        "limits_basis": final.get("limits_basis"),
        "binding": binding,
        "history": [{k: v for k, v in p.items() if k not in ("derived",)} for p in history],
        "change_list": change_list,
        "model": _model_block(target, target_source, request, start, max_fill, design_of, of_source),
        "unmeasured": UNMEASURED,
        "notes": notes,
        "burns": len(history),
        "workers": n_workers,
        "wall_s": time.perf_counter() - started,
        "summary": {"mean_thrust_N": fig.get("mean_thrust_N"), "total_impulse_Ns": fig.get("total_impulse_Ns"),
                    "burn_time_s": fig.get("burn_time_s"), "of_mean": of, "lockup_psia": final.get("lockup_psia"),
                    "dome_psig": dome, "copv_psig": final.get("fill_psig"), "feasible": is_feasible},
        "basis": ("Whole Layer X burns with the rail's settings" + (", the erosion replay on" if final.get("replay") else "")
                  + ": a secant on lockup for the mean thrust, then Broyden on lockup and fill for the bottle margin. "
                  "The answer is the last burn."),
    }
