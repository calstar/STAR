"""Resize the injector so the design point holds under the drawing's feed system.

EngineDesign sizes the injector at the tank pressure less one loss per side (``feed_system.K0``).
The drawing's feed delivers something else: the tank sags below lockup while it flows, the lines
have their own valves and bends, and in flight every liquid column carries the vehicle's
acceleration. On the 6.8 kN stand the injector sees ~15 psi less LOX and ~13 psi less fuel than it
was sized for, so it under-flows and the chamber runs below its design point.

The reconciler holds everything that is built (chamber, throat, plate rings, channels, tank
pressure) and changes only what the plate's holes set:

* **hole diameters** (both rings), solved so the engine makes the target thrust at the target
  O/F through the drawing's feed. That restores the design flows, so chamber pressure and Isp come
  back with them. Each passage keeps its drilled length, so its L/d (and with it Cd) moves with the
  diameter;
* **jet angles** (optional, whole degrees, included angle held): the spray resultant's tilt depends
  on the two streams' momenta, which change with the hole areas. The angles bring it back.

The momentum-flux ratio R = (Cd_O/Cd_F) sqrt(dp_O/dp_F) is reported but not targeted: at fixed
flows through a fixed feed, the two injector drops are set, and hole size cannot move them apart.

The feed is the drawing's, as Layer X measures it (``engine.layerx.feedfit``): K0 per side fitted to
a burn. Because the fit depends on the flow (the regulator droops more at higher flow), the
reconciler burns, fits, resizes and burns again until the holes stop moving. The last burn is the
reconciled injector on the drawing, and its numbers are the ones reported.

Forward mode is the inner model: ``PintleEngineRunner.evaluate`` at the lockup, with the fitted K0.
"""

from __future__ import annotations

import copy
import math
import time
from dataclasses import dataclass, replace
from typing import Any, Callable, Dict, List, Optional, Tuple

from engine.layerx.prepare import PSI

Progress = Callable[[str, float], None]

#: Number drills, ASME B94.11M (diameter in inches): the range injector holes are drilled in.
NUMBER_DRILLS_IN = {
    40: 0.0980, 41: 0.0960, 42: 0.0935, 43: 0.0890, 44: 0.0860, 45: 0.0820, 46: 0.0810, 47: 0.0785,
    48: 0.0760, 49: 0.0730, 50: 0.0700, 51: 0.0670, 52: 0.0635, 53: 0.0595, 54: 0.0550, 55: 0.0520,
    56: 0.0465, 57: 0.0430, 58: 0.0420, 59: 0.0410, 60: 0.0400, 61: 0.0390, 62: 0.0380, 63: 0.0370,
    64: 0.0360, 65: 0.0350, 66: 0.0330, 67: 0.0320, 68: 0.0310, 69: 0.0292, 70: 0.0280,
}
#: Metric drills in the small-hole range come in 0.05 mm steps.
METRIC_STEP_MM = 0.05

SIDES = (("oxidizer", "O", "LOX"), ("fuel", "F", "Fuel"))


@dataclass
class ReconcileRequest:
    thrust_N: Optional[float] = None       # None: the design point's thrust
    of: Optional[float] = None             # None: the design point's O/F
    hold_spray_direction: bool = True
    max_passes: int = 4
    tolerance: float = 1.0e-3              # relative hole-diameter change between passes

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ReconcileRequest":
        return cls(**{k: d[k] for k in cls.__dataclass_fields__ if k in d and d[k] is not None})


# ------------------------------------------------------------------ the engine at one point


def _forward(config: Any, p_tank: Any, ambient: float) -> Dict[str, Any]:
    """Forward mode at the lockup: performance, the injector's split, and the spray tilt.
    ``p_tank`` is one pressure for both tanks or ``(p_O, p_F)`` [Pa]."""
    from engine.core.injectors.impinging import momentum_ratio_R_from_bulk_velocities
    from engine.core.runner import PintleEngineRunner
    from engine.optimizer.layers.layer1_static_optimization import _impinging_resultant_tilt_deg

    p_O, p_F = p_tank if isinstance(p_tank, tuple) else (p_tank, p_tank)
    r = PintleEngineRunner(copy.deepcopy(config)).evaluate(p_O, p_F, P_ambient=ambient, silent=True)
    g = config.injector.geometry
    rho_O = float(config.fluids["oxidizer"].density)
    rho_F = float(config.fluids["fuel"].density)
    n = float(g.oxidizer.n_elements)
    A_O = n * math.pi * float(g.oxidizer.d_jet) ** 2 / 4.0
    A_F = float(g.fuel.n_elements) * math.pi * float(g.fuel.d_jet) ** 2 / 4.0
    mO, mF, pc = float(r["mdot_O"]), float(r["mdot_F"]), float(r["Pc"])
    inj = r.get("injector_pressure") or {}
    dpO, dpF = inj.get("delta_p_injector_O"), inj.get("delta_p_injector_F")
    return {
        "thrust_N": float(r["F"]), "of": float(r["MR"]), "pc_psia": pc / PSI, "isp_s": float(r["Isp"]),
        "mdot_O": mO, "mdot_F": mF,
        "dp_O_psi": dpO / PSI if dpO is not None else None, "dp_F_psi": dpF / PSI if dpF is not None else None,
        "stiffness_O": dpO / pc if dpO is not None and pc > 0 else None,
        "stiffness_F": dpF / pc if dpF is not None and pc > 0 else None,
        "momentum_ratio": momentum_ratio_R_from_bulk_velocities(rho_O, rho_F, mO / (rho_O * A_O), mF / (rho_F * A_F)),
        "tilt_deg": _impinging_resultant_tilt_deg(
            mO, mF, rho_O, rho_F, n, float(g.oxidizer.d_jet), float(g.fuel.d_jet),
            float(g.oxidizer.impingement_angle), float(g.fuel.impingement_angle),
            spacing_O_m=float(g.oxidizer.spacing), spacing_F_m=float(g.fuel.spacing)),
        "d_O_mm": float(g.oxidizer.d_jet) * 1e3, "d_F_mm": float(g.fuel.d_jet) * 1e3,
        "angle_O_deg": float(g.oxidizer.impingement_angle), "angle_F_deg": float(g.fuel.impingement_angle),
    }


# ------------------------------------------------------------------ editing a config copy


def _with_feed(config: Any, fit: Dict[str, Any]) -> Any:
    """``config`` with each side's feed_system replaced by the fitted K0 (feedfit.design_update)."""
    from engine.layerx.feedfit import design_update

    cfg = copy.deepcopy(config)
    for side, upd in design_update(fit, run_id="")["feed_system"].items():
        cfg.feed_system[side] = cfg.feed_system[side].model_copy(update=upd)
    return cfg


def _passage_length(config: Any, side: str) -> Optional[float]:
    """The drilled passage length [m] (declared L/d x d), which a resized hole keeps."""
    dc = config.discharge.get(side) if isinstance(config.discharge, dict) else getattr(config.discharge, side, None)
    lod = getattr(dc, "orifice_l_over_d", None) if dc is not None else None
    if lod is None or getattr(dc, "l_over_d_source", "declared") != "declared":
        return None
    return float(lod) * float(getattr(config.injector.geometry, side).d_jet)


def _with_holes(config: Any, d: Dict[str, float], lengths: Dict[str, Optional[float]],
                angles: Optional[Dict[str, float]] = None) -> Any:
    cfg = copy.deepcopy(config)
    for side, _, _ in SIDES:
        geo = getattr(cfg.injector.geometry, side)
        setattr(geo, "d_jet", float(d[side]))
        if angles is not None:
            setattr(geo, "impingement_angle", float(angles[side]))
        L = lengths.get(side)
        if L is not None:
            cfg.discharge[side] = cfg.discharge[side].model_copy(update={"orifice_l_over_d": L / float(d[side])})
    return cfg


# ------------------------------------------------------------------ the inner solve


def _solve_holes(config: Any, lengths: Dict[str, Optional[float]], target: Tuple[float, float],
                 p_tank: Any, ambient: float, angles: Optional[Dict[str, float]] = None,
                 tol: float = 2.0e-5, max_iter: int = 12) -> Tuple[Dict[str, float], Dict[str, Any], int]:
    """Hole diameters that make (thrust, O/F) = ``target`` through ``config``'s feed: Newton on
    (ln d_O, ln d_F) with a finite-difference Jacobian, steps capped at 5 % per iteration."""
    F_t, of_t = target
    g = config.injector.geometry
    x = [math.log(float(g.oxidizer.d_jet)), math.log(float(g.fuel.d_jet))]

    def evaluate(xx: List[float]) -> Tuple[List[float], Dict[str, Any]]:
        d = {"oxidizer": math.exp(xx[0]), "fuel": math.exp(xx[1])}
        point = _forward(_with_holes(config, d, lengths, angles), p_tank, ambient)
        return [math.log(point["thrust_N"] / F_t), math.log(point["of"] / of_t)], point

    r, point = evaluate(x)
    it = 0
    for it in range(1, max_iter + 1):
        if max(abs(v) for v in r) < tol:
            break
        h = 1.0e-3
        J = [[0.0, 0.0], [0.0, 0.0]]
        for j in range(2):
            xp = list(x)
            xp[j] += h
            rp, _ = evaluate(xp)
            for i in range(2):
                J[i][j] = (rp[i] - r[i]) / h
        det = J[0][0] * J[1][1] - J[0][1] * J[1][0]
        if not math.isfinite(det) or abs(det) < 1e-12:
            raise ValueError("the hole sizes do not move thrust and O/F independently here")
        dx = [-(J[1][1] * r[0] - J[0][1] * r[1]) / det, -(-J[1][0] * r[0] + J[0][0] * r[1]) / det]
        cap = max(abs(v) for v in dx) / 0.05
        if cap > 1.0:
            dx = [v / cap for v in dx]
        x = [x[0] + dx[0], x[1] + dx[1]]
        r, point = evaluate(x)
    if max(abs(v) for v in r) >= 1e-3:
        raise ValueError(f"hole sizing did not converge (thrust {r[0] * 100:+.2f} %, O/F {r[1] * 100:+.2f} %)")
    return {"oxidizer": math.exp(x[0]), "fuel": math.exp(x[1])}, point, it


def _angles_for_tilt(config: Any, target_tilt: float, p_tank: Any, ambient: float,
                     point: Dict[str, Any]) -> Tuple[Dict[str, float], float]:
    """Whole-degree jet angles, the included angle held, that bring the resultant tilt nearest
    ``target_tilt`` at this point's flows. Returns the angles and the tilt they give."""
    from engine.optimizer.layers.layer1_static_optimization import _impinging_resultant_tilt_deg

    g = config.injector.geometry
    req = getattr(config, "design_requirements", None)
    a_O, a_F = float(g.oxidizer.impingement_angle), float(g.fuel.impingement_angle)
    included = a_O + a_F
    lo = float(getattr(req, "layer1_impinging_jet_angle_min_deg", None) or 0.0)
    asym = getattr(req, "layer1_impinging_jet_angle_max_asym_deg", None)
    rho_O, rho_F = float(config.fluids["oxidizer"].density), float(config.fluids["fuel"].density)

    def tilt(aO: float, aF: float) -> float:
        return _impinging_resultant_tilt_deg(
            point["mdot_O"], point["mdot_F"], rho_O, rho_F, float(g.oxidizer.n_elements),
            float(g.oxidizer.d_jet), float(g.fuel.d_jet), aO, aF,
            spacing_O_m=float(g.oxidizer.spacing), spacing_F_m=float(g.fuel.spacing))

    best = (a_O, a_F, tilt(a_O, a_F))
    for step in range(-8, 9):
        aO = round(a_O) + step
        aF = included - aO
        if aO < lo or aF < lo or (asym is not None and abs(aO - aF) > float(asym)):
            continue
        t = tilt(aO, aF)
        if math.isfinite(t) and abs(t - target_tilt) < abs(best[2] - target_tilt) - 0.25:
            best = (aO, aF, t)
    return {"oxidizer": best[0], "fuel": best[1]}, best[2]


# ------------------------------------------------------------------ fabrication


def drills(d_mm: float) -> Dict[str, Any]:
    """Nearest number drill (ASME B94.11M, #40-#70) and nearest 0.05 mm metric drill, with the
    flow-area error each gives against ``d_mm``."""
    out: Dict[str, Any] = {}
    no, inch = min(NUMBER_DRILLS_IN.items(), key=lambda kv: abs(kv[1] * 25.4 - d_mm))
    if abs(inch * 25.4 - d_mm) < 0.15:
        out["number"] = {"drill": f"#{no}", "d_mm": inch * 25.4, "area_error": (inch * 25.4 / d_mm) ** 2 - 1.0}
    m = round(d_mm / METRIC_STEP_MM) * METRIC_STEP_MM
    out["metric"] = {"drill": f"{m:.2f} mm", "d_mm": m, "area_error": (m / d_mm) ** 2 - 1.0}
    return out


def drill_candidates(d_mm: float, n: int = 4) -> List[Dict[str, Any]]:
    """The drills nearest ``d_mm``: number drills (ASME B94.11M #40-#70) and 0.05 mm metric, each
    with the flow-area error it gives, nearest first."""
    out = [{"drill": f"#{no}", "d_mm": inch * 25.4} for no, inch in NUMBER_DRILLS_IN.items()]
    m0 = round(d_mm / METRIC_STEP_MM)
    out += [{"drill": f"{k * METRIC_STEP_MM:.2f} mm", "d_mm": k * METRIC_STEP_MM} for k in range(m0 - 2, m0 + 3) if k > 0]
    for c in out:
        c["area_error"] = (c["d_mm"] / d_mm) ** 2 - 1.0
    out.sort(key=lambda c: abs(c["d_mm"] - d_mm))
    seen, picked = set(), []
    for c in out:
        key = round(c["d_mm"], 4)
        if key not in seen:
            seen.add(key)
            picked.append(c)
    return picked[:n]


def drill_grid(fed: Any, lengths: Dict[str, Optional[float]], p_tank: Any, ambient: float,
               options: Dict[str, List[Dict[str, Any]]], angles: Optional[Dict[str, float]]) -> List[Dict[str, Any]]:
    """Forward mode through the fitted feed for every pairing of the drill options: what each pair
    of drills makes, before it is burned."""
    rows = []
    for o in options["oxidizer"]:
        for f in options["fuel"]:
            pt = _forward(_with_holes(fed, {"oxidizer": o["d_mm"] * 1e-3, "fuel": f["d_mm"] * 1e-3}, lengths, angles),
                          p_tank, ambient)
            rows.append({"oxidizer": o["drill"], "fuel": f["drill"], "d_O_mm": o["d_mm"], "d_F_mm": f["d_mm"],
                         **{k: pt[k] for k in ("thrust_N", "of", "pc_psia", "stiffness_O", "stiffness_F",
                                               "momentum_ratio", "tilt_deg")}})
    return rows


def _changes(config: Any, final: Any, lengths: Dict[str, Optional[float]]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for side, k, label in SIDES:
        g0, g1 = getattr(config.injector.geometry, side), getattr(final.injector.geometry, side)
        d0, d1 = float(g0.d_jet) * 1e3, float(g1.d_jet) * 1e3
        rows.append({
            "item": f"{label} orifice diameter", "unit": "mm", "from": d0, "to": d1, "delta": d1 - d0,
            "fabrication": "re-drill larger" if d1 > d0 + 1e-4 else ("new plate (smaller hole)" if d1 < d0 - 1e-4 else "no change"),
            "drills": drills(d1),
        })
        L = lengths.get(side)
        if L is not None:
            rows.append({"item": f"{label} passage L/d", "unit": "", "from": L / (d0 * 1e-3), "to": L / (d1 * 1e-3),
                         "delta": L / (d1 * 1e-3) - L / (d0 * 1e-3),
                         "fabrication": f"passage stays {L * 1e3:.2f} mm long"})
        a0, a1 = float(g0.impingement_angle), float(g1.impingement_angle)
        if abs(a1 - a0) > 1e-9:
            rows.append({"item": f"{label} jet angle", "unit": "deg", "from": a0, "to": a1, "delta": a1 - a0,
                         "fabrication": "new plate"})
    return rows


def design_update(final: Any, fit_update: Dict[str, Any], lengths: Dict[str, Optional[float]]) -> Dict[str, Any]:
    """What 'write into the design' sends: holes, angles, passage L/d, and the fitted feed that
    makes Forward mode agree with the burn."""
    geo: Dict[str, Any] = {}
    dis: Dict[str, Any] = {}
    for side, _, _ in SIDES:
        g = getattr(final.injector.geometry, side)
        geo[side] = {"d_jet": float(g.d_jet), "impingement_angle": float(g.impingement_angle)}
        if lengths.get(side) is not None:
            dis[side] = {"orifice_l_over_d": round(float(final.discharge[side].orifice_l_over_d), 4)}
    out: Dict[str, Any] = {"injector": {"geometry": geo}, **fit_update}
    if dis:
        out["discharge"] = dis
    return out


# ------------------------------------------------------------------ the loop


def _burn_figures(res: Dict[str, Any]) -> Dict[str, Any]:
    s = res.get("summary") or {}
    dv = (res.get("delivered") or {}).get("summary") or {}
    return {
        "mean_thrust_N": dv.get("mean_thrust_N") or s.get("mean_thrust_N"),
        "pc_mean_psia": dv.get("pc_mean_psia") or s.get("pc_mean_psia"),
        "of_mean": s.get("of_mean"),
        "total_impulse_Ns": dv.get("total_impulse_Ns") or s.get("total_impulse_Ns"),
        "burn_time_s": s.get("burn_time_s"),
    }


def run_reconcile(config: Any, drawing: Any, settings: Any, overrides: List[Any], request: ReconcileRequest,
                  progress: Optional[Progress] = None, cancelled: Callable[[], bool] = lambda: False) -> Dict[str, Any]:
    from engine.layerx.analysis import run_prepared
    from engine.layerx.prepare import prepare

    started = time.perf_counter()

    def say(stage: str, frac: float) -> None:
        if progress is not None:
            progress(stage, frac)

    settings = replace(settings, card_center_psia=None)
    prep = prepare(config, None, drawing, settings, overrides)
    if not prep.ok:
        raise ValueError("Preflight failed: " + "; ".join(c.label for c in prep.checks if c.status == "fail"))
    lockup_psia = float(prep.derived["target_lockup_psia"])
    p_tank, ambient = lockup_psia * PSI, float(prep.ambient_pa)
    lengths = {side: _passage_length(config, side) for side, _, _ in SIDES}

    say("Design point", 0.02)
    design = _forward(config, p_tank, ambient)
    target = (float(request.thrust_N or design["thrust_N"]), float(request.of or design["of"]))
    source = "custom" if request.thrust_N or request.of else "design point"

    cfg = copy.deepcopy(config)
    passes: List[Dict[str, Any]] = []
    before: Optional[Dict[str, Any]] = None
    before_burn: Optional[Dict[str, Any]] = None
    final_cfg, fit_update, final_point, last_burn = cfg, {}, None, None
    converged = False
    n = max(1, int(request.max_passes))
    for k in range(n):
        if cancelled():
            from engine.layerx.pool import Cancelled

            raise Cancelled()
        base = 0.05 + 0.9 * k / n
        say(f"Burning, pass {k + 1}", base)
        prep_k = prep if k == 0 else prepare(cfg, None, drawing, settings, overrides)
        if not prep_k.ok:
            raise ValueError("Preflight failed on pass " + str(k + 1) + ": "
                             + "; ".join(c.label for c in prep_k.checks if c.status == "fail"))
        res = run_prepared(prep_k, cancelled=cancelled, replay=settings.replay is not False, config=cfg)
        trip = res.get("tripped")
        if trip:
            # A burn stopped by a vessel trip is not the feed the holes would see: nothing to fit.
            raise ValueError(f"the burn tripped on pass {k + 1}: {trip.get('message') or trip.get('vessel')} "
                             f"(t = {float(trip.get('t') or 0.0):.2f} s); lower the lockup or restate the rating")
        fit = res.get("feed_fit") or {}
        if not fit.get("available"):
            raise ValueError(f"the feed could not be fitted on pass {k + 1}: {fit.get('error', 'no fit')}")
        last_burn = _burn_figures(res)
        if k == 0:
            before_burn = last_burn
        say(f"Sizing holes, pass {k + 1}", base + 0.6 / n)
        fed = _with_feed(cfg, fit)
        # The fit's sag is measured from each tank's own T-0 pressure: solve from there.
        p_fit = (fit["sides"]["oxidizer"]["lockup_psia"] * PSI, fit["sides"]["fuel"]["lockup_psia"] * PSI)
        if k == 0:
            before = _forward(fed, p_fit, ambient)
        d, point, iters = _solve_holes(fed, lengths, target, p_fit, ambient)
        angles = None
        if request.hold_spray_direction:
            trial = _with_holes(fed, d, lengths)
            angles, tilt = _angles_for_tilt(trial, design["tilt_deg"], p_fit, ambient, point)
            g = fed.injector.geometry
            if (angles["oxidizer"], angles["fuel"]) != (float(g.oxidizer.impingement_angle), float(g.fuel.impingement_angle)):
                # Angles move the mixing, and the mixing moves c*: size the holes again at the new angles.
                d, point, more = _solve_holes(fed, lengths, target, p_fit, ambient, angles)
                iters += more
            else:
                angles = None
        nxt = _with_holes(fed, d, lengths, angles)
        last_fed, last_p, last_angles = fed, p_fit, angles
        g0 = cfg.injector.geometry
        change = max(abs(d["oxidizer"] / float(g0.oxidizer.d_jet) - 1.0), abs(d["fuel"] / float(g0.fuel.d_jet) - 1.0))
        passes.append({
            "pass": k + 1, "burn": last_burn,
            "K0_O": fit["sides"]["oxidizer"]["K0"], "K0_F": fit["sides"]["fuel"]["K0"],
            # The burn against the target: the holes are sized to the burn-MEAN feed, so the burn's
            # mean thrust is the measure of whether they made the design point on the drawing (with
            # the erosion replay on, it also carries the eroding throat, ~+0.6 % at 3.5 s). A fit's
            # manifold gap is not a measure: from pass 2 the config carries the previous fit.
            "thrust_error": ((last_burn.get("mean_thrust_N") or float("nan")) / target[0] - 1.0),
            "d_O_mm": d["oxidizer"] * 1e3, "d_F_mm": d["fuel"] * 1e3, "change": change, "newton_iterations": iters,
        })
        from engine.layerx.feedfit import design_update as feed_update

        final_cfg, fit_update, final_point = nxt, feed_update(fit, run_id=""), point
        # The burn this pass made was of the injector it started with: once the holes stop moving,
        # that injector is the reconciled one and the burn verifies it.
        if change < request.tolerance:
            converged = True
            break
        cfg = nxt

    say("Drill options", 0.97)
    g = final_cfg.injector.geometry
    options = {"oxidizer": drill_candidates(float(g.oxidizer.d_jet) * 1e3),
               "fuel": drill_candidates(float(g.fuel.d_jet) * 1e3)}
    grid = drill_grid(last_fed, lengths, last_p, ambient, options, last_angles)
    say("Done", 1.0)
    fit_update["feed_system"] = {side: {**v, "derived_from": {**v["derived_from"], "by": "Layer X injector reconcile"}}
                                 for side, v in fit_update.get("feed_system", {}).items()}
    req = getattr(config, "design_requirements", None)
    band = {
        "stiffness_O": [getattr(req, "injector_dp_ratio_O_min", None), getattr(req, "injector_dp_ratio_O_max", None)],
        "stiffness_F": [getattr(req, "injector_dp_ratio_F_min", None), getattr(req, "injector_dp_ratio_F_max", None)],
        "momentum_ratio": [getattr(req, "impinging_momentum_R_min", None), getattr(req, "impinging_momentum_R_max", None)],
    }
    notes = []
    if not converged:
        notes.append(f"The holes still moved {passes[-1]['change'] * 100:.2f} % on the last of {n} passes; "
                     "the last burn is of the injector before that step.")
    if any(r["fabrication"].startswith("new plate (smaller") for r in _changes(config, final_cfg, lengths)):
        notes.append("A hole gets smaller: a drilled plate cannot be corrected; it needs a new plate.")
    result = {
        # The design these holes were sized from: writing them into a different one is refused.
        "config_sha256": prep.config_sha256,
        "condition": "in flight" if settings.flight else "on the pad",
        "lockup_psia": lockup_psia,
        "target": {"thrust_N": target[0], "of": target[1], "source": source},
        "design": design,
        "before": before,
        "after": final_point,
        "before_burn": before_burn,
        "after_burn": last_burn,
        "passes": passes,
        "converged": converged,
        "changes": _changes(config, final_cfg, lengths),
        "band": band,
        "design_update": design_update(final_cfg, fit_update, lengths),
        "drill_options": options,
        "drill_grid": grid,
        "passage_length_m": lengths,
        "angles": {side: float(getattr(g, side).impingement_angle) for side, _, _ in SIDES},
        "notes": notes,
        "wall_s": time.perf_counter() - started,
        "basis": ("Holes sized in Forward mode at the lockup through the drawing's feed (K0 fitted to a Layer X "
                  "burn), then burned again on the drawing until they stop moving. Chamber, throat, rings, channels "
                  "and tank pressure held."),
    }
    # The same answer in the change-list format Optimize uses (engine/layerx/diff.py). The keys above
    # stay: saved reconciles and the Injector page read them.
    from engine.layerx.diff import from_reconcile

    try:
        result["change_list"] = from_reconcile(result)
    except Exception as exc:  # noqa: BLE001 - the reconcile stands without its change list, and says so
        result["change_list"] = {"available": False, "error": f"{type(exc).__name__}: {exc}"}
    return result
