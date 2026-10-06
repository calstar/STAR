"""How flat the delivered thrust is, and where its change over the burn comes from.

``build_thrust_shape(result, prep=None, config, *, sampler=None, target_N=None)`` ->
``diagnostics.thrust_shape`` (DATA-CONTRACT 3).

**Shape.** Over the delivered thrust (``delivered.thrust_N``, the replay's eroded engine at the
twin's line-exit pressures) from the first settled step (``settle_s`` after Fire, 0.2 s: the same
window ``replay.delivered`` takes its minimum over): the mean (``delivered.summary.mean_thrust_N``,
the headline), the largest and the RMS deviation from it in percent, the spread, and against a
target when there is one (the config's ``design_requirements.target_thrust``, or ``target_N``).

**Breakdown**, on the replay's own points (the delivered thrust is interpolated between them),
of the change from the first settled point k0, ``dF(t) = F_del(t) - F_del(k0)``:

* ``erosion_N`` = ``[F_del - F_ab](t) - [F_del - F_ab](k0)``, where ``F_ab`` is the **as-built**
  engine (EngineDesign at the line exit, ``engine.layerx.card.EngineSampler``: the replay's model
  with no recession) at the same line-exit pressures. Geometry is the only difference between
  the two, so this is exact.
* ``tank_pressure_N`` = ``F_T(p_pad(t)) - F_T(p_pad(k0))``: the as-built engine fed through the
  drawn lines **held at k0** -- each side's line loss as ``K mdot^2`` with ``K`` the twin's own
  ``(outlet - inlet) / mdot^2`` at k0 -- from the tank outlet pressure on a one-g basis,
  ``p_pad = p_ullage + head g0 / a``. The feed loop ``inlet = p_out - K mdot(inlet)^2`` is solved
  (fixed point; its slope is the line drop over the orifice drop, ~0.1-0.2 here, and the solve
  reports its own convergence).
* ``accel_head_N`` (flown runs) = ``[F_T(p_out) - F_T(p_pad)](t) - [same](k0)``: the liquid
  column's head at the flight's specific force ``a(t)`` (``flight.schedule.accel_m_s2``) against
  the same column at one g. Zero on the pad.
* ``residual_N`` = ``dF - (tank + erosion + accel)`` = ``[F_ab(t) - F_ab(k0)] - [F_T(p_out(t)) -
  F_T(p_out(k0))]``: what the twin's feed did beyond a fixed-K line -- the line's K drifting with
  Reynolds number, the network's coupling -- plus the fixed-point tolerance.

The components are differences of one model, so they add exactly to ``dF`` by construction; the
residual is the measure of how much the fixed-K feed explains.
"""

from __future__ import annotations

import math
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

import numpy as np

from engine.layerx.diag.ladder import PSI, arr, inp, model_block, out, scalar, unavailable

G0 = 9.80665
SETTLE_S = 0.2
"""Seconds after Fire before the shape is graded: ``replay.delivered`` takes its minimum over
t >= 0.2 s for the same reason (the valve ramp and the first replay point)."""

FEED_TOL = 1e-9
FEED_ITERS = 60


def _sampler(config: Any, ambient_pa: float) -> Callable[[float, float], Optional[Dict[str, float]]]:
    from engine.layerx.card import EngineSampler

    return EngineSampler(config, ambient_pa)


def feed_solve(sampler: Callable[[float, float], Optional[Dict[str, float]]], p_out_O: float, p_out_F: float,
               K_O: float, K_F: float, m0: Tuple[float, float]) -> Tuple[Optional[Dict[str, float]], int, float]:
    """The as-built engine fed through fixed-K lines from tank-outlet pressures [Pa]:
    ``inlet = p_out - K mdot^2`` (K in Pa/(kg/s)^2), solved by fixed point on the two flows.
    Returns (engine point, iterations, last relative change)."""
    mO, mF = m0
    point = None
    change = math.inf
    for it in range(1, FEED_ITERS + 1):
        point = sampler(p_out_O - K_O * mO * mO, p_out_F - K_F * mF * mF)
        if point is None:
            return None, it, change
        nO, nF = float(point["mdot_O"]), float(point["mdot_F"])
        change = max(abs(nO - mO) / max(nO, 1e-12), abs(nF - mF) / max(nF, 1e-12))
        mO, mF = nO, nF
        if change < FEED_TOL:
            return point, it, change
    return point, FEED_ITERS, change


def _target(config: Any, target_N: Optional[float]) -> Tuple[Optional[float], str]:
    if target_N is not None:
        return float(target_N), "restated for this run"
    req = getattr(config, "design_requirements", None)
    tgt = getattr(req, "target_thrust", None) if req is not None else None
    if tgt:
        return float(tgt), "config design_requirements.target_thrust"
    return None, "no target"


def shape_stats(t: np.ndarray, F: np.ndarray, mean: float, settle_t: float,
                target: Optional[float]) -> Dict[str, Any]:
    """Deviation statistics of ``F`` about ``mean`` over ``t >= settle_t`` (trapezoid weights)."""
    ok = np.isfinite(F) & (t >= settle_t - 1e-9)
    if ok.sum() < 2:
        ok = np.isfinite(F)
    tt, ff = t[ok], F[ok]
    w = np.zeros(tt.size)
    if tt.size >= 2:
        d = np.diff(tt)
        w[:-1] += d / 2.0
        w[1:] += d / 2.0
    else:
        w[:] = 1.0
    dev = ff - mean
    res: Dict[str, Any] = {
        "dev_max_pct": scalar(np.max(np.abs(dev)) / mean * 100.0),
        "dev_rms_pct": scalar(math.sqrt(float(np.sum(w * dev * dev) / np.sum(w))) / mean * 100.0),
        "spread_pct": scalar((np.max(ff) - np.min(ff)) / mean * 100.0),
        "min_N": scalar(np.min(ff)), "max_N": scalar(np.max(ff)),
        "end_minus_start_N": scalar(ff[-1] - ff[0]),
        "window": [scalar(tt[0]), scalar(tt[-1])],
    }
    if target:
        within = np.abs(ff - target) <= 0.02 * target
        above = np.flatnonzero(ff >= target)
        res.update({
            "mean_minus_target_N": scalar(mean - target),
            "within_2pct_steps": int(within.sum()), "steps": int(ff.size),
            "t_first_at_target": scalar(tt[above[0]]) if above.size else None,
        })
    return res


def build_thrust_shape(result: Mapping[str, Any], prep: Any = None, config: Any = None, *,
                       sampler: Optional[Callable[[float, float], Optional[Dict[str, float]]]] = None,
                       target_N: Optional[float] = None, settle_s: float = SETTLE_S,
                       ambient_pa: Optional[float] = None) -> Dict[str, Any]:
    """``diagnostics.thrust_shape``. Never raises. ``sampler`` ((p_line_O, p_line_F) [Pa] ->
    {F, mdot_O, mdot_F, ...}) defaults to EngineDesign at the line exit on ``config``."""
    try:
        dl = result.get("delivered") or {}
        rep = result.get("replay") or {}
        series = result.get("series") or {}
        if not dl.get("thrust_N") or not rep.get("thrust_N"):
            return unavailable("no delivered thrust (the replay did not run)")
        t_d = arr(dl.get("t"))
        F_d = arr(dl.get("thrust_N"))
        mean = float((dl.get("summary") or {}).get("mean_thrust_N") or np.nanmean(F_d))
        fire_t = float(t_d[0]) if t_d.size else 0.0
        st = [k for k, f in enumerate(series.get("firing") or []) if f]
        if st:
            fire_t = float(series["t"][st[0]]) - float((series.get("dt") or [0.0] * len(series["t"]))[st[0]] or 0.0)
        target, target_src = _target(config, target_N)
        stats = shape_stats(t_d, F_d, mean, fire_t + settle_s, target)

        # ---- breakdown on the replay points --------------------------------------------------
        t_r = arr(rep.get("t"))
        F_del = arr(rep.get("thrust_N"))
        idx = [int(i) for i in rep.get("index") or []]
        if len(idx) != t_r.size:
            raise ValueError("replay.index does not follow replay.t")
        settled = np.flatnonzero(np.isfinite(F_del) & (t_r >= fire_t + settle_s - 1e-9))
        if settled.size < 2:
            raise ValueError("fewer than two settled replay points")
        k0 = int(settled[0])

        def side(key: str, field: str) -> np.ndarray:
            return arr([(series.get(key) or {}).get(field)[i] for i in idx])

        tank = {s: side(s, "tank_psia") * PSI for s in ("ox", "fuel")}
        outlet = {s: side(s, "outlet_psia") * PSI for s in ("ox", "fuel")}
        inlet = {s: side(s, "inlet_psia") * PSI for s in ("ox", "fuel")}
        mdot = {s: side(s, "mdot") for s in ("ox", "fuel")}
        # the replay's own inlet pressures are what F_del was solved at
        if rep.get("inlet_O_psia") is not None:
            inlet["ox"] = arr(rep["inlet_O_psia"]) * PSI
            inlet["fuel"] = arr(rep["inlet_F_psia"]) * PSI
        K = {s: (outlet[s][k0] - inlet[s][k0]) / mdot[s][k0] ** 2 for s in ("ox", "fuel")}

        flight = result.get("flight") or {}
        sched = flight.get("schedule") if flight.get("ok") else None
        if sched and sched.get("t"):
            a = np.interp(t_r, arr(sched["t"]), arr(sched["accel_m_s2"]))
            a_basis = "flight.schedule.accel_m_s2 (the flown pass's specific force)"
        else:
            a = np.full(t_r.size, G0)
            a_basis = "pad: one g"
        head = {s: outlet[s] - tank[s] for s in ("ox", "fuel")}
        p_pad = {s: tank[s] + head[s] * G0 / a for s in ("ox", "fuel")}

        if sampler is None:
            if config is None:
                return unavailable("the engine config is needed for the as-built engine")
            amb = ambient_pa or float(getattr(prep, "ambient_pa", 0.0) or 0.0) or float(
                ((result.get("provenance") or {}).get("derived") or {}).get("ambient_pa") or 101325.0)
            sampler = _sampler(config, amb)
        m0 = (float(mdot["ox"][k0]), float(mdot["fuel"][k0]))
        n = t_r.size
        F_ab = np.full(n, np.nan)
        F_T_out = np.full(n, np.nan)
        F_T_pad = np.full(n, np.nan)
        worst_change, iters = 0.0, 0
        for j in range(n):
            pt = sampler(float(inlet["ox"][j]), float(inlet["fuel"][j]))
            F_ab[j] = float(pt["F"]) if pt else math.nan
            for target_arr, p in ((F_T_out, outlet), (F_T_pad, p_pad)):
                if target_arr is F_T_pad and sched is None:
                    continue
                sol, it, ch = feed_solve(sampler, float(p["ox"][j]), float(p["fuel"][j]), K["ox"], K["fuel"], m0)
                target_arr[j] = float(sol["F"]) if sol else math.nan
                worst_change = max(worst_change, ch if math.isfinite(ch) else math.inf)
                iters = max(iters, it)
        if sched is None:
            F_T_pad = F_T_out.copy()
        dF = F_del - F_del[k0]
        erosion = (F_del - F_ab) - (F_del[k0] - F_ab[k0])
        tank_N = F_T_pad - F_T_pad[k0]
        accel = (F_T_out - F_T_pad) - (F_T_out[k0] - F_T_pad[k0])
        residual = dF - (tank_N + erosion + accel)
        live = np.arange(n) >= k0

        def mask(v: np.ndarray) -> List[Optional[float]]:
            return out(np.where(live, v, np.nan))

        end = int(settled[-1])
        return {
            "mean_N": scalar(mean),
            **stats,
            "target_N": scalar(target) if target else None,
            "target_source": target_src,
            "breakdown": {
                "t": out(t_r), "k0": k0, "t0": scalar(t_r[k0]),
                "dF_N": mask(dF), "tank_pressure_N": mask(tank_N), "erosion_N": mask(erosion),
                "accel_head_N": mask(accel), "residual_N": mask(residual),
                "as_built_N": mask(F_ab), "fixed_feed_N": mask(F_T_out),
                "at_end": {"t": scalar(t_r[end]), "dF_N": scalar(dF[end]), "tank_pressure_N": scalar(tank_N[end]),
                           "erosion_N": scalar(erosion[end]), "accel_head_N": scalar(accel[end]),
                           "residual_N": scalar(residual[end])},
                "feed_K_psi_per_kg2s2": {s: scalar(K[s] / PSI) for s in ("ox", "fuel")},
                "feed_solve": {"max_iterations": iters, "worst_relative_change": scalar(worst_change),
                               "converged": bool(worst_change < 1e-6)},
                "accel_basis": a_basis,
            },
            "model": model_block(
                "thrust-flatness decomposition (as-built engine at the line exit; fixed-K drawn feed)",
                "engine.layerx.card.EngineSampler (EngineDesign at the line exit, the replay's model without "
                "recession); the twin's line losses as K mdot^2 at the first settled replay point",
                ["erosion = eroded minus as-built engine at the twin's line-exit pressures (exact attribution)",
                 "tank pressure = as-built engine through a fixed-K feed from the tank-outlet pressure on a one-g "
                 "basis (ullage + head g0/a)",
                 "acceleration head = the same feed at the flown head against one g (zero on the pad)",
                 "residual = the twin's feed beyond a fixed K (Reynolds-dependent friction, coupling)",
                 "replay points only: the delivered series is interpolated between them",
                 f"shape over t >= {settle_s:g} s after Fire, about the delivered mean"],
                {"settle_s": inp(settle_s, "s", "replay.delivered's settled window"),
                 "target_N": inp(target, "N", target_src)}),
        }
    except Exception as exc:  # noqa: BLE001
        return unavailable(f"{type(exc).__name__}: {exc}")
