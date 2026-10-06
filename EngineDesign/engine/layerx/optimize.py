"""Phase 4: the feed hardware that gets the most out of a fixed propellant load.

Layer 1 sizes the engine at one operating point. This searches the *hardware around it*, with
the whole burn simulated for every candidate. The decision variables are things a person can
set or buy:

* **tank lockup** [psia]: the dome dial, solved per candidate from the drawing's regulators;
* **COPV fill** [psig]: how full the bottle is at T-0;
* **COPV volume** [L], off by default: a different bottle. Its structure scales with its volume
  in the flight (``flight._flight_config``).

The pressurant gas is the drawing's, so to compare GN2 against helium, run each drawing.

The objective is **total impulse** (the tanks burnt dry) or, with the flight on, **apogee**, both at
the fixed load.
Every constraint is checked over the whole burn:

* **regulator headroom**: the bottle at burnout stays above the lockup by a stated margin;
* **injector stiffness**: each side's lowest ΔP/Pc stays above the config's band floor (chug);
* **O/F band** (optional): the burn's O/F within a stated fraction of the design O/F;
* **apogee ceiling**, when the config declares one (``design_requirements.max_apogee_m``);
* everything preflight fails on, such as a tank or bottle MAWP or a load that does not fit.

**Search.** A parallel compass search over the variables scaled to [0, 1]. Each iteration burns
the centre's 2k neighbours at once on a process pool. It moves to the best one when that beats
the centre; otherwise it halves the step. It stops when the step falls below 1/32 of the range or
the evaluation budget runs out. Candidates are ranked feasible-first, then by total constraint
violation, then by objective (Deb's rules), so no penalty weight has to be tuned. The search is
derivative-free because a burn's answer moves in steps: the burn ends on a time step, and a
regulator either holds lockup or drops out. Deterministic: the same request gives the same
path.

**Fidelity.** Candidates burn on one engine card, centred on the lockup range, without the
erosion replay. The replay moves every candidate by nearly the same amount, so leaving it out
does not reorder them. The winner is then **verified**: burned again with its own card, the
replay, and the flight if the objective is apogee. The verified numbers are the ones reported
as the answer.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Dict, List, Optional, Tuple

PSI = 6894.757293168361

#: Compass search: first step and stopping step, as fractions of each variable's range.
FIRST_STEP = 0.25
MIN_STEP = 1.0 / 32.0

#: A violation below this (relative) counts as satisfied: float noise, nothing more. The burn
#: ends on depletion (BurnPlan.end_on_depletion), so end-of-burn quantities are not quantised
#: to a step and need no allowance here.
FEASIBLE = 1e-6

OBJECTIVES = ("impulse", "apogee")


@dataclass(frozen=True)
class Variable:
    key: str
    label: str
    unit: str
    lo: float
    hi: float
    start: float
    enabled: bool = True
    basis: str = ""
    """Where the bounds came from."""


@dataclass(frozen=True)
class OptimizeRequest:
    objective: str = "impulse"
    variables: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    """``key -> {"enabled", "lo", "hi"}``; anything unsent keeps its default."""
    dropout_margin_psi: float = 100.0
    """Bottle above lockup at burnout [psi]. The twin's regulator already loses lockup by itself
    when the bottle runs down. This margin is for what the twin does not know: its regulator
    model comes from one back-fit."""
    stiffness: bool = True
    of_band_rel: Optional[float] = None
    max_evaluations: int = 40
    verify: bool = True

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "OptimizeRequest":
        known = set(cls.__dataclass_fields__)
        out = cls(**{k: v for k, v in raw.items() if k in known and v is not None})
        if out.objective not in OBJECTIVES:
            raise ValueError(f"objective {out.objective!r}; expected one of {', '.join(OBJECTIVES)}")
        return out


# ---------------------------------------------------------------------- variables


def default_variables(prep: Any, config: Any) -> List[Variable]:
    """The decision variables and their bounds, each bound with its reason."""
    d = prep.derived
    lockup = float(d["target_lockup_psia"])
    req = getattr(config, "design_requirements", None)
    caps: List[Tuple[float, str]] = [(lockup * 1.15, "+15 % of the current lockup")]
    for side, key in (("LOX", "max_lox_tank_pressure_psi"), ("fuel", "max_fuel_tank_pressure_psi")):
        cap = getattr(req, key, None) if req is not None else None
        if cap:
            caps.append((float(cap), f"design_requirements.{key} ({side})"))
    for tank_id, mawp in (d.get("tank_mawp_psi") or {}).items():
        # MAWP is across the wall: absolute cap is the MAWP over the site's atmosphere.
        caps.append((mawp + d["ambient_pa"] / PSI, f"{tank_id} MAWP on the drawing, over the site's atmosphere"))
    hi, hi_why = min(caps, key=lambda c: c[0])
    hi = round(hi, 1)
    lo = round(min(lockup * 0.85, hi * 0.95))
    out = [Variable("lockup_psia", "Tank pressure", "psia", lo, hi, min(max(lockup, lo), hi),
                    basis=f"Regulator lockup before firing. {lo:.0f} psia (−15 %, an assumed window) to {hi:.0f} psia "
                          f"({hi_why}). The dome setting is solved for each.")]

    copv = float(d["copv_psig"])
    drawn = d.get("copv_drawn_psig") or copv
    mawp = d.get("copv_mawp_psi")
    c_hi = float(drawn)
    c_lo = round(0.6 * c_hi, -1)
    out.append(Variable("copv_psig", "Bottle fill", "psig", c_lo, c_hi, min(max(copv, c_lo), c_hi),
                        basis=f"{c_lo:.0f} psig (an assumed floor, 60 % of the top) to {c_hi:.0f} psig, the bottle pressure "
                              "the drawing states: a fill above what the bottle is drawn for is not searched"
                              + (f" (its MAWP of {mawp:.0f} psi is a proof margin, not a fill)" if mawp else "") + "."))

    vol = d.get("copv_volume_L")
    if vol:
        out.append(Variable("copv_volume_L", "Bottle size", "L", round(0.5 * vol, 2), round(2.0 * vol, 2), vol, enabled=False,
                            basis=f"½× to 2× the drawing's {vol:.2f} L. A different bottle; its structure scales "
                                  "with its volume in the flight (estimate)."))
    return out


def resolve_variables(prep: Any, config: Any, request: OptimizeRequest) -> List[Variable]:
    out = []
    for v in default_variables(prep, config):
        raw = request.variables.get(v.key) or {}
        lo = float(raw.get("lo", v.lo))
        hi = float(raw.get("hi", v.hi))
        if hi < lo:
            lo, hi = hi, lo
        out.append(replace(v, lo=lo, hi=hi, start=min(max(v.start, lo), hi),
                           enabled=bool(raw.get("enabled", v.enabled)) and hi > lo))
    return out


# ---------------------------------------------------------------------- one candidate


def _candidate(settings: Any, variables: List[Variable], x: Dict[str, float], copv_id: Optional[str],
               objective: str, center_psia: float) -> Tuple[Any, List[Any]]:
    from engine.layerx.measurements import Override

    changes: Dict[str, Any] = {"replay": False, "flight": objective == "apogee", "card_center_psia": center_psia}
    if "lockup_psia" in x:
        changes["tank_pressure_psia"] = x["lockup_psia"]
    if "copv_psig" in x:
        changes["copv_pressure_psig"] = x["copv_psig"]
    extra: List[Any] = []
    volume = next((v for v in variables if v.key == "copv_volume_L"), None)
    if volume is not None and volume.enabled and "copv_volume_L" in x and copv_id:
        extra.append(Override(target=f"node:{copv_id}", parameter="volume", value=float(x["copv_volume_L"]),
                              unit="L", source="Layer X optimiser candidate", provenance="estimated"))
    return replace(settings, **changes), extra


def _figures(res: Dict[str, Any]) -> Dict[str, Any]:
    """What a candidate's burn says, flat."""
    s = res["summary"]
    f = res.get("flight") or {}
    out = {
        "total_impulse_Ns": s.get("total_impulse_Ns"),
        "impulse_to_depletion_Ns": s.get("impulse_to_depletion_Ns"),
        "burn_time_s": s.get("burn_time_s"),
        "depletion_s": s.get("depletion_s"),
        "mean_thrust_N": s.get("mean_thrust_N"),
        "pc_mean_psia": s.get("pc_mean_psia"),
        "of_mean": s.get("of_mean"),
        "isp_mean_s": s.get("isp_mean_s"),
        "copv_end_psia": s.get("copv_end_psia"),
        "ox_stiffness_min": s["ox"].get("stiffness_min"),
        "fuel_stiffness_min": s["fuel"].get("stiffness_min"),
        "ox_min_psia": s["ox"].get("min_psia"),
        "fuel_min_psia": s["fuel"].get("min_psia"),
        "ox_residual_kg": s["ox"].get("residual_kg"),
        "fuel_residual_kg": s["fuel"].get("residual_kg"),
        "depleted_side": s.get("depleted_side"),
        "failed_steps": s.get("failed_steps"),
        "card_outside_steps": s.get("card_outside_steps"),
        "converged": res.get("converged", True),
        "tripped": res.get("tripped"),
    }
    if f.get("ok"):
        out.update({"apogee_agl_m": f["apogee_agl_m"], "max_velocity_m_s": f["max_velocity_m_s"],
                    "max_accel_g": f["max_accel_g"], "ceiling": f.get("ceiling")})
    return out


def _evaluate(args: Tuple[Any, ...]) -> Dict[str, Any]:
    """Burn one candidate, start to finish, in whatever process runs it."""
    config, drawing, settings, overrides, variables, x, copv_id, objective, center, index = args
    from engine.layerx.analysis import run_prepared
    from engine.layerx.prepare import prepare

    started = time.perf_counter()
    try:
        st, extra = _candidate(settings, variables, x, copv_id, objective, center)
        prep = prepare(config, None, drawing, st, list(overrides) + extra)
        if not prep.ok:
            failing = [f"{c.label}: {c.detail}" for c in prep.checks if c.status == "fail"]
            return {"index": index, "x": x, "ok": True, "preflight": failing, "figures": None,
                    "wall_s": time.perf_counter() - started}
        res = run_prepared(prep, replay=False, config=config if objective == "apogee" else None)
        return {"index": index, "x": x, "ok": True, "preflight": [], "figures": _figures(res),
                "lockup_psia": prep.derived["target_lockup_psia"], "dome_psig": prep.derived["dome_psig"],
                "wall_s": time.perf_counter() - started}
    except Exception as exc:  # noqa: BLE001 - one failed candidate is reported, the search goes on
        return {"index": index, "x": x, "ok": False, "error": f"{type(exc).__name__}: {exc}",
                "wall_s": time.perf_counter() - started}


# ---------------------------------------------------------------------- grading


def grade(e: Dict[str, Any], request: OptimizeRequest, band: Dict[str, Optional[List[float]]],
          design_of: Optional[float]) -> Dict[str, Any]:
    """Objective and constraints for one evaluated candidate. Violations are relative, so they add
    without weights; ``violation`` is their sum."""
    rows: List[Dict[str, Any]] = []
    if not e.get("ok"):
        return {"objective": None, "violation": math.inf, "constraints": [
            {"key": "burn", "label": "The burn runs", "ok": False, "detail": e.get("error", "failed")}]}
    if e["preflight"]:
        return {"objective": None, "violation": 1e3, "constraints": [
            {"key": "preflight", "label": "Preflight", "ok": False, "detail": "; ".join(e["preflight"])}]}
    f = e["figures"]

    def add(key: str, label: str, value: Optional[float], limit: float, kind: str, scale: float, unit: str) -> None:
        if value is None:
            rows.append({"key": key, "label": label, "ok": False, "violation": 1.0, "detail": "not computed"})
            return
        short = (limit - value) if kind == "min" else (value - limit)
        v = max(short, 0.0) / max(abs(scale), 1e-12)
        rows.append({"key": key, "label": label, "value": value, "limit": limit, "kind": kind, "unit": unit,
                     "ok": v <= FEASIBLE, "violation": v})

    lockup = float(e.get("lockup_psia") or e["x"].get("lockup_psia") or 0.0)
    add("dropout", "Bottle above the tanks at burnout", f["copv_end_psia"] - lockup if f["copv_end_psia"] is not None else None,
        request.dropout_margin_psi, "min", max(request.dropout_margin_psi, 1.0), "psi")
    if request.stiffness:
        for side, name in (("oxidiser", "ox"), ("fuel", "fuel")):
            b = band.get(side)
            if b:
                add(f"stiffness_{name}", f"{'LOX' if name == 'ox' else 'Fuel'} injector ΔP/Pc (lowest)",
                    f[f"{name}_stiffness_min"], float(b[0]), "min", float(b[0]), "")
    if request.of_band_rel is not None and design_of:
        of = f["of_mean"]
        rel = abs(of / design_of - 1.0) if of else None
        add("of", f"O/F within ±{request.of_band_rel * 100:.1f} % of {design_of:.3f}", rel, request.of_band_rel,
            "max", request.of_band_rel, "")
    ceiling = f.get("ceiling")
    if ceiling:
        add("ceiling", "Apogee under the ceiling", f["apogee_agl_m"], ceiling["limit_agl_m"], "max",
            ceiling["limit_agl_m"], "m")
    trip = f.get("tripped")
    if trip:
        # A vessel over its trip pressure stopped the burn (result.tripped): not a regulator dropout.
        rows.append({"key": "vessel_trip", "label": "No vessel trips", "ok": False, "violation": 1.0,
                     "detail": f"{trip.get('label') or trip.get('vessel')} reached {trip.get('p_psia', 0.0):.1f} psia "
                               f"against the {trip.get('mawp_psia', 0.0):.1f} psia it trips at, at "
                               f"t = {trip.get('t', 0.0):.2f} s; the burn stopped there"})
    elif f.get("impulse_to_depletion_Ns") is None:
        rows.append({"key": "depletion", "label": "A tank runs dry", "ok": False, "violation": 1.0,
                     "detail": "the burn reached the horizon with propellant in both tanks (a regulator that dropped "
                               "out, or a horizon too short)"})
    if f.get("failed_steps"):
        rows.append({"key": "solve", "label": "Every step solves", "ok": False, "violation": 1.0,
                     "detail": f"{f['failed_steps']} step(s) held their last flows"})
    # The burn ends on depletion (BurnPlan.end_on_depletion) and burns the tanks dry (dry_kg), so the
    # total impulse is continuous in the design and needs no extrapolation.
    objective = f.get("apogee_agl_m") if request.objective == "apogee" else f.get("total_impulse_Ns")
    violation = sum(r.get("violation", 0.0) for r in rows if not r["ok"])
    return {"objective": objective, "violation": violation if objective is not None else math.inf,
            "constraints": rows}


def _rank(g: Dict[str, Any]) -> Tuple[int, float, float]:
    feasible = g["violation"] <= FEASIBLE
    return (0 if feasible else 1, 0.0 if feasible else g["violation"], -(g["objective"] or -math.inf))


# ---------------------------------------------------------------------- the search


def run_optimize(config: Any, drawing: Any, settings: Any, overrides: List[Any], request: OptimizeRequest, *,
                 progress: Optional[Callable[[str, float], None]] = None,
                 cancelled: Callable[[], bool] = lambda: False,
                 workers: Optional[int] = None) -> Dict[str, Any]:
    from engine.layerx.pool import Cancelled, WorkerPool, default_workers
    from engine.layerx.prepare import prepare

    say = progress or (lambda stage, fraction: None)
    started = time.perf_counter()
    say("Preparing", 0.01)
    base_settings = replace(settings, replay=False, flight=False, card_center_psia=None)
    nominal = prepare(config, None, drawing, base_settings, overrides)
    if not nominal.ok:
        raise ValueError("preflight has failing checks; fix them before optimising")
    variables = resolve_variables(nominal, config, request)
    free = [v for v in variables if v.enabled]
    if not free:
        raise ValueError("no variable is enabled")
    lock = next(v for v in variables if v.key == "lockup_psia")
    center_psia = 0.5 * (lock.lo + lock.hi) if lock.enabled else lock.start
    say("Building the engine card for the lockup range", 0.03)
    centred = prepare(config, None, drawing, replace(base_settings, card_center_psia=center_psia), overrides)
    if not centred.ok:
        raise ValueError("the engine card for the lockup range could not be built")
    band = nominal.derived.get("stiffness_band") or {}
    req_cfg = getattr(config, "design_requirements", None)
    design_of = getattr(req_cfg, "optimal_of_ratio", None) if req_cfg is not None else None
    copv_id = nominal.derived.get("copv_id")

    def to_x(u: Tuple[float, ...]) -> Dict[str, float]:
        x = {v.key: v.start for v in variables}
        for v, ui in zip(free, u):
            x[v.key] = v.lo + ui * (v.hi - v.lo)
        return x

    start_u = tuple((v.start - v.lo) / (v.hi - v.lo) for v in free)
    seen: Dict[Tuple[float, ...], Dict[str, Any]] = {}
    history: List[Dict[str, Any]] = []
    budget = max(int(request.max_evaluations), 2 * len(free) + 1)
    n_workers = default_workers(2 * len(free), workers)
    pool = WorkerPool(n_workers)

    def key(u: Tuple[float, ...]) -> Tuple[float, ...]:
        return tuple(round(min(max(ui, 0.0), 1.0), 6) for ui in u)

    def evaluate(batch: List[Tuple[float, ...]], iteration: int) -> None:
        fresh = []
        for u in batch:
            k = key(u)
            if k not in seen and k not in [key(f) for f in fresh] and len(seen) + len(fresh) < budget:
                fresh.append(k)
        if not fresh:
            return
        args = [(config, drawing, settings, overrides, variables, to_x(u), copv_id, request.objective,
                 center_psia, len(seen) + i) for i, u in enumerate(fresh)]
        done = pool.map(_evaluate, args, cancelled=cancelled)
        for u, e in zip(fresh, done):
            g = grade(e, request, band, design_of)
            entry = {**e, **g, "u": list(u), "iteration": iteration}
            seen[u] = entry
            history.append(entry)

    try:
        center = key(start_u)
        step = FIRST_STEP
        iteration = 0

        def neighbours(c: Tuple[float, ...], h: float) -> List[Tuple[float, ...]]:
            out = []
            for i in range(len(free)):
                for sgn in (1.0, -1.0):
                    u = list(c)
                    u[i] = min(max(u[i] + sgn * h, 0.0), 1.0)
                    out.append(key(tuple(u)))
            return out

        say(f"Burning the start and its {2 * len(free)} neighbours", 0.05)
        evaluate([center] + neighbours(center, step), iteration)
        while step >= MIN_STEP and len(seen) < budget:
            if cancelled():
                raise Cancelled()
            best = min(seen.values(), key=_rank)
            if tuple(best["u"]) != center and _rank(best) < _rank(seen[center]):
                center = tuple(best["u"])
            else:
                step /= 2.0
                if step < MIN_STEP:
                    break
            iteration += 1
            say(f"Iteration {iteration}: step {step:.3f} of the range, {len(seen)} burns",
                0.05 + 0.8 * min(len(seen) / budget, 1.0))
            before = len(seen)
            evaluate(neighbours(center, step), iteration)
            if len(seen) == before and step < MIN_STEP * 2:
                break
    finally:
        pool.close(cancelled())

    start_entry = seen.get(key(start_u))
    best = min(seen.values(), key=_rank)
    notes: List[str] = []
    if best["violation"] > FEASIBLE:
        notes.append("No candidate met every constraint; the one shown violates the least.")
    if any(v.enabled and (abs(best["x"][v.key] - v.lo) < 1e-9 or abs(best["x"][v.key] - v.hi) < 1e-9) for v in free):
        at = [v.label for v in free if abs(best["x"][v.key] - v.lo) < 1e-9 or abs(best["x"][v.key] - v.hi) < 1e-9]
        notes.append(f"{', '.join(at)} finished on a bound: the answer is the bound's reason, not an optimum.")
    if any((e.get("figures") or {}).get("card_outside_steps") for e in seen.values()):
        notes.append("Some candidates ran outside the engine card's sampled box; their engine is extrapolated.")
    if len(seen) >= budget:
        notes.append(f"Stopped at the {budget}-burn budget before the step reached 1/{int(1 / MIN_STEP)} of the range.")
    copv_var = next((v for v in free if v.key == "copv_psig"), None)
    if copv_var is not None and best["x"].get("copv_psig", copv_var.start) < copv_var.start - 1.0:
        # A short fill is the one answer the unmodelled cold LOX-tank wall can turn over: it raises
        # LOX-side gas use 7-60 % (estimate), and the bottle margin is what a short fill spends.
        notes.append("This fills the bottle short. The LOX tank's cold wall is not modelled and raises its gas use; "
                     "measure bottle use on a firing before relying on the bottle margin this answer keeps.")

    verified = None
    if request.verify and not cancelled():
        say("Verifying the winner: its own engine card, the erosion replay"
            + (", the flight" if request.objective == "apogee" else ""), 0.88)
        verified = _verify(config, drawing, settings, overrides, variables, best["x"], copv_id, request, band,
                           design_of, start_entry)
    say("Done", 1.0)
    clean = lambda e: {k: v for k, v in e.items() if k not in ("u",)}  # noqa: E731
    return {
        "objective": request.objective,
        "request": {"dropout_margin_psi": request.dropout_margin_psi, "stiffness": request.stiffness,
                    "of_band_rel": request.of_band_rel, "max_evaluations": budget},
        "variables": [{"key": v.key, "label": v.label, "unit": v.unit, "lo": v.lo, "hi": v.hi, "start": v.start,
                       "enabled": v.enabled, "basis": v.basis} for v in variables],
        "card_center_psia": center_psia,
        "start": clean(start_entry) if start_entry else None,
        "best": clean(best),
        "history": [clean(e) for e in history],
        "verified": verified,
        "notes": notes,
        "evaluations": len(seen),
        "workers": n_workers,
        "wall_s": time.perf_counter() - started,
        "summary": {"objective": request.objective, "best_x": best["x"], "best_objective": best["objective"]},
        "basis": ("Parallel compass search over the enabled variables scaled to their ranges; feasible "
                  "candidates first, then least violation, then objective. Candidates burn on one engine card "
                  "without the erosion replay; the winner is verified with both."),
    }


def _verify(config: Any, drawing: Any, settings: Any, overrides: List[Any], variables: List[Variable],
            x: Dict[str, float], copv_id: Optional[str], request: OptimizeRequest,
            band: Dict[str, Optional[List[float]]], design_of: Optional[float],
            start_entry: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The winner, and the starting point, burned the way a Layer X run burns them."""
    from engine.layerx.analysis import run_prepared
    from engine.layerx.prepare import prepare

    out: Dict[str, Any] = {}
    for label, point in (("best", x), ("start", start_entry["x"] if start_entry else None)):
        if point is None:
            continue
        st, extra = _candidate(settings, variables, point, copv_id, request.objective, 0.0)
        st = replace(st, replay=True, card_center_psia=None)
        prep = prepare(config, None, drawing, st, list(overrides) + extra)
        if not prep.ok:
            out[label] = {"ok": False, "error": "; ".join(c.label for c in prep.checks if c.status == "fail")}
            continue
        res = run_prepared(prep, replay=True, config=config if request.objective == "apogee" else None)
        figures = _figures(res)
        dv = (res.get("delivered") or {}).get("summary") or {}
        if dv:
            # Graded on the replay's own numbers, the eroding nozzle included, not the card's.
            figures.update({"total_impulse_Ns": dv.get("total_impulse_Ns"), "mean_thrust_N": dv.get("mean_thrust_N"),
                            "pc_mean_psia": dv.get("pc_mean_psia"), "isp_mean_s": dv.get("isp_mean_s"),
                            "impulse_to_depletion_Ns": dv.get("impulse_to_depletion_Ns")})
        e = {"ok": True, "preflight": [], "figures": figures, "x": point,
             "lockup_psia": prep.derived["target_lockup_psia"], "dome_psig": prep.derived["dome_psig"]}
        out[label] = {**e, **grade(e, request, band, design_of)}
    return out


# ====================================================================== Hardware mode
#
# The compass search above is the legacy Optimise (kept for its saved runs and the page that still
# calls it). Hardware mode replaces it (docs/layerx/AUDIT.md D6, 9.10 4b): discrete parts only, from
# the catalogues in engine/layerx/catalog.py, each candidate a whole burn on an in-memory copy of
# the drawing (measurements.Override) or of the design (patch.apply_design_patch), graded with the
# same limits as Set point and ranked by the person's objective. The answer is a change list
# (engine/layerx/diff.py), never a write.

HW_OBJECTIVES = ("target_thrust_error", "thrust_flatness", "of_error", "impulse", "bottle_margin")

#: The trim orifice's discharge coefficient comes from Reader-Harris/Gallagher at these taps: the
#: permanent loss of a plate depends on its C (ISO 5167-2:2003 5.4), and the taps are where C is
#: defined. Corner taps are fluids' default; the audit's alternatives (flange 0.79, D-D/2 0.61)
#: bound it.
TRIM_TAPS = "corner"


@dataclass(frozen=True)
class HardwareRequest:
    components: Tuple[Dict[str, Any], ...] = ()
    """The components that may change: ``{"target": "node:<id>" | "edge:<id>" | "design:<side>.d_jet",
    "kind"?: "trim_orifice", "rows"?: [catalogue row ids]}``."""
    objective: str = "of_error"
    target_thrust_N: Optional[float] = None
    design_of: Optional[float] = None
    neighbours: int = 2
    combine: bool = False
    max_candidates: int = 8
    margin_psi: float = 100.0
    meop_psi: Optional[Dict[str, float]] = None
    verify: bool = True
    """Re-solve the set point (lockup only) for the winner, so its thrust is the target's."""
    trim_C: Optional[float] = None
    """A measured discharge coefficient for a trim orifice; ``None``: Reader-Harris/Gallagher."""

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "HardwareRequest":
        known = set(cls.__dataclass_fields__)
        vals = {k: v for k, v in raw.items() if k in known and v is not None}
        if "components" in vals:
            vals["components"] = tuple(dict(c) for c in vals["components"])
        out = cls(**vals)
        if out.objective not in HW_OBJECTIVES:
            raise ValueError(f"objective {out.objective!r}; expected one of {', '.join(HW_OBJECTIVES)}")
        if not out.components:
            raise ValueError("mark at least one component that may change")
        for c in out.components:
            t = str(c.get("target") or "")
            if not (t.startswith(("node:", "edge:")) or t in ("design:oxidizer.d_jet", "design:fuel.d_jet")):
                raise ValueError(f"component target {t!r}: node:<id>, edge:<id>, design:oxidizer.d_jet or design:fuel.d_jet")
            if c.get("kind") not in (None, "part", "trim_orifice"):
                raise ValueError(f"component kind {c.get('kind')!r}: 'part' or 'trim_orifice'")
            if c.get("kind") == "trim_orifice" and not t.startswith("edge:"):
                raise ValueError("a trim orifice goes in a line: target edge:<id>")
            rows = c.get("rows")
            if rows is not None and (not isinstance(rows, (list, tuple)) or not all(isinstance(r, str) for r in rows)):
                # A string here would be matched by substring ("id in rows"): refuse it.
                raise ValueError(f"component {t!r} rows: a list of catalogue row ids")
        return out


def _payload_with(prep: Any) -> Dict[str, Any]:
    """The drawing as this burn reads it: the person's restatements written in."""
    from engine.layerx.measurements import apply_overrides

    payload, _, _ = apply_overrides(prep.drawing.payload, list(prep.measurements or []))
    return payload


def _element(payload: Dict[str, Any], target: str) -> Optional[Dict[str, Any]]:
    from engine.layerx.measurements import _element as el

    return el(payload, target)


def _param(element: Dict[str, Any], name: str) -> Optional[Dict[str, Any]]:
    p = ((element.get("data") or {}).get("params") or {}).get(name)
    return p if isinstance(p, dict) else None


def _mm(p: Optional[Dict[str, Any]]) -> Optional[float]:
    if not p or not isinstance(p.get("value"), (int, float)):
        return None
    return float(p["value"]) * {"mm": 1.0, "m": 1e3, "in": 25.4}.get(str(p.get("unit") or "mm"), 1.0)


def _edge_side(payload: Dict[str, Any], edge: Dict[str, Any], species: Dict[str, str]) -> Optional[str]:
    nodes = {str(n.get("id")): n for n in payload.get("nodes") or [] if isinstance(n, dict)}
    for end in ("source", "target"):
        fluid = str(((nodes.get(str(edge.get(end))) or {}).get("data") or {}).get("fluid") or "").lower()
        for side, sp in (species or {}).items():
            if fluid and fluid == str(sp).lower():
                return side
    return None


def trim_orifice_K(line_bore_m: float, orifice_bore_m: float, C: float) -> float:
    """Permanent-loss coefficient of a thin orifice plate, referred to the line's velocity head:
    K = [sqrt(1 - beta^4 (1 - C^2)) / (C beta^2) - 1]^2 (``fluids.flow_meter.discharge_coefficient_to_K``,
    after ASME MFC-3M-2004 and ISO 5167-2:2003)."""
    from fluids.flow_meter import discharge_coefficient_to_K

    return float(discharge_coefficient_to_K(D=line_bore_m, Do=orifice_bore_m, C=C))


def trim_orifice_C(line_bore_m: float, orifice_bore_m: float, rho: float, mu: float, mdot: float,
                   taps: str = TRIM_TAPS) -> float:
    """Reader-Harris/Gallagher discharge coefficient (``fluids.flow_meter.C_Reader_Harris_Gallagher``,
    ISO 5167-2:2003). Outside its range here (D < 50 mm, beta > 0.75): an extrapolation."""
    from fluids.flow_meter import C_Reader_Harris_Gallagher

    return float(C_Reader_Harris_Gallagher(D=line_bore_m, Do=orifice_bore_m, rho=rho, mu=mu, m=mdot, taps=taps))


def _trim_model(line: str, D_m: float, rho: float, mu: float, mdot: float, C_given: Optional[float]) -> Dict[str, Any]:
    return {
        "name": "trim orifice: thin plate, permanent loss, as K_minor on the line",
        "source": ("fluids 1.3 flow_meter.discharge_coefficient_to_K (ASME MFC-3M-2004; ISO 5167-2:2003 permanent "
                   "pressure loss) with C from flow_meter.C_Reader_Harris_Gallagher (ISO 5167-2:2003), "
                   f"{TRIM_TAPS} taps"),
        "assumptions": [
            "The plate's permanent loss is charged as extra K_minor on the line it sits in (the drawing has no "
            "orifice element; feedtwin's OrificeCd/ISO5167 price the tap differential, ~6x the permanent loss here).",
            "Reader-Harris/Gallagher is used outside ISO 5167-2's range (D >= 50 mm, beta <= 0.75): its C is an "
            "extrapolation, and the taps it is taken at move the loss: corner against D and D/2 taps is 1.5x at "
            "beta 0.89 and 3x at beta 0.94 on l_ox1 (fluids 1.3; flange taps are meaningless on a 10.9 mm line, "
            "AUDIT 5.3). Each candidate carries both (trim.K_by_taps). Size the bore from a cold flow before "
            "drilling.",
            "C is evaluated at the baseline burn's mean flow on that side; K does not follow the flow during the burn.",
        ],
        "inputs": {
            "line": {"value": line, "unit": "", "provenance": "the person marked it"},
            "line_bore_m": {"value": D_m, "unit": "m", "provenance": "drawing (bore of the line)"},
            "rho": {"value": rho, "unit": "kg/m^3", "provenance": "feedtwin network conditions at the injector inlet"},
            "mu": {"value": mu, "unit": "Pa s", "provenance": "feedtwin network conditions at the injector inlet"},
            "mdot": {"value": mdot, "unit": "kg/s", "provenance": "baseline burn: propellant used over burn time"},
            "C": {"value": C_given, "unit": "", "provenance": "request (measured)" if C_given else
                  f"Reader-Harris/Gallagher, {TRIM_TAPS} taps (extrapolated)"},
        },
    }


def _option_from_row(target: str, element: Dict[str, Any], row: Dict[str, Any], label: str) -> Optional[Dict[str, Any]]:
    """A catalogue row as one option: the drawing restatements it makes, and the change records."""
    from engine.layerx.measurements import Override

    lengths = {"mm": 1.0, "m": 1e3, "in": 25.4}
    overrides, changes = [], []
    for name, p in (row.get("params") or {}).items():
        before = _param(element, name)
        b_val = float(before["value"]) if before and isinstance(before.get("value"), (int, float)) else None
        b_unit, a_unit = str((before or {}).get("unit") or ""), str(p["unit"])
        if b_val is not None and b_unit != a_unit and b_unit in lengths and a_unit in lengths:
            b_val, b_unit = b_val * lengths[b_unit] / lengths[a_unit], a_unit      # said in the row's unit
        if b_val is not None and b_unit == a_unit and abs(b_val - float(p["value"])) < 1e-9 * max(1.0, abs(b_val)):
            continue
        # A row's numbers need not share one provenance (a bottle's volume measured, its mass
        # estimated): a parameter's own ``source`` wins over the row's.
        src = str(p.get("source") or row["source"])
        overrides.append(Override(target=target, parameter=name, value=float(p["value"]), unit=str(p["unit"]),
                                  source=f"catalog {row['id']}: {row['provenance']}"[:300], provenance=src))
        changes.append({"field": name, "before": b_val, "before_unit": b_unit or None,
                        "before_provenance": (f"{before.get('source')}: {before.get('reference') or ''}".strip(": ")
                                              if before else "not on the drawing"),
                        "after": float(p["value"]), "unit": str(p["unit"]), "source": src})
    if not overrides:
        return None
    return {"target": target, "label": label, "row": {k: row.get(k) for k in ("id", "label", "source", "provenance", "origin")},
            "overrides": overrides, "design_patch": None, "changes": changes, "cad_impact": "new part",
            "summary": f"{label}: {row['label']}"}


def plan_candidates(prep: Any, config: Any, request: HardwareRequest, catalogs: Dict[str, Any],
                    baseline: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Every component's options, and the candidates (one option each, or combinations).

    Raises ``ValueError`` for a component the drawing or design does not have, or one no catalogue
    row fits. A trim orifice is sized from the ``baseline`` burn's flow; without one it is listed as
    pending."""
    from itertools import product

    from engine.layerx import catalog as cat
    from engine.layerx.reconcile import _passage_length

    payload = _payload_with(prep)
    species = {side: str(getattr(prep, "derived", {}).get("species", {}).get(side, "")) for side in ("oxidiser", "fuel")}
    per_component: List[Dict[str, Any]] = []
    needs_pid: List[Dict[str, Any]] = []
    notes: List[str] = []
    n = max(1, int(request.neighbours))
    for comp in request.components:
        target, kind, only = str(comp["target"]), comp.get("kind") or "part", comp.get("rows")
        options: List[Dict[str, Any]] = []
        if target.startswith("design:"):
            side = target.split(":", 1)[1].split(".")[0]
            d_mm = float(getattr(config.injector.geometry, side).d_jet) * 1e3
            rows = cat.rows_for(catalogs, "drills", "hole")
            if only:
                rows = [r for r in rows if r["id"] in only]
            L = _passage_length(config, side)
            word = "LOX" if side == "oxidizer" else "Fuel"
            for r in cat.neighbours(rows, "d", d_mm, n):
                d_new = cat.param_si(r, "d")
                patch: Dict[str, float] = {"d_jet": d_new * 1e-3}
                ch = [{"field": "d_jet", "before": round(d_mm, 5), "after": round(d_new, 5), "unit": "mm",
                       "before_provenance": "the design"}]
                if L is not None:
                    patch["orifice_l_over_d"] = L / (d_new * 1e-3)
                    ch.append({"field": "orifice_l_over_d", "before": round(L / (d_mm * 1e-3), 4),
                               "after": round(patch["orifice_l_over_d"], 4), "unit": "",
                               "before_provenance": "the design (passage length kept)"})
                options.append({"target": target, "label": f"{word} injector holes", "row": {k: r.get(k) for k in (
                    "id", "label", "source", "provenance", "drill")}, "overrides": [], "design_patch": {side: patch},
                    "changes": ch, "cad_impact": "re-drill" if d_new > d_mm else "new plate",
                    "summary": f"{word} holes {r['drill']} ({d_new:.4f} mm, was {d_mm:.4f})"})
        else:
            element = _element(payload, target)
            if element is None:
                raise ValueError(f"the drawing has no {target}")
            ctype = str((element.get("data") or {}).get("componentType") or "")
            label = str((element.get("data") or {}).get("label") or target.split(":", 1)[1])
            segs = (element.get("data") or {}).get("segments")
            if target.startswith("edge:") and isinstance(segs, list) and segs:
                # feedtwin.pid.network drops a segmented line's own bore and K_minor (the segments
                # carry the geometry), so a tube or trim restated on the line would burn as drawn.
                raise ValueError(f"{target} is itemised into {len(segs)} segment(s): its bore and K_minor are "
                                 "superseded by the segments, so a tube or trim change here would not be burned. "
                                 "Change the segment in pid-designer.")
            if kind == "trim_orifice":
                D_mm = _mm(_param(element, "bore"))
                side = _edge_side(payload, element, species)
                if D_mm is None or side is None:
                    raise ValueError(f"{target}: a trim orifice needs a liquid line with a bore")
                needs_pid.append({"target": target, "what": f"an orifice plate in {label}",
                                  "why": "the drawing has no orifice element; this run charges the plate's permanent "
                                         "loss as K_minor on the line. Add an orifice symbol in pid-designer to keep it."})
                if baseline is None:
                    options.append({"target": target, "label": f"Trim orifice in {label}", "pending": True,
                                    "summary": "sized after the baseline burn"})
                else:
                    options += _trim_options(prep, payload, element, target, label, side, D_mm, baseline, request,
                                             catalogs, n, notes)
            elif target.startswith("edge:"):
                rows = cat.rows_for(catalogs, "tubes", "line")
                if only:
                    rows = [r for r in rows if r["id"] in only]
                bore = _mm(_param(element, "bore"))
                if bore is None:
                    raise ValueError(f"{target} states no bore")
                for r in cat.neighbours(rows, "bore", bore, n):
                    o = _option_from_row(target, element, r, label)
                    if o:
                        o["cad_impact"] = "new part"
                        options.append(o)
                notes.append(f"{label}: a different tube changes the line only; if it is the line into the injector, "
                             "the design's feed_system d_exit still prices the manifold dump (preflight warns).")
            else:
                kind_rows = "bottles" if ctype == "KBOTTLE" else "valves"
                key = "volume" if ctype == "KBOTTLE" else "Cv"
                rows = cat.rows_for(catalogs, kind_rows, ctype)
                if only:
                    rows = [r for r in rows if r["id"] in only]
                cur = _param(element, key)
                if cur is None:
                    raise ValueError(f"{target} ({ctype}) states no {key}")
                for r in cat.neighbours(rows, key, float(cur["value"]), n):
                    o = _option_from_row(target, element, r, label)
                    if o:
                        options.append(o)
                if ctype == "KBOTTLE":
                    notes.append("A different bottle changes the drawing's bottle; the flight's mass comes from the "
                                 "config's press_tank, which this does not change.")
        if not options:
            raise ValueError(f"{target}: no catalogue row differs from what is drawn. Add rows to the catalogue "
                             f"(<userdata>/layerx/catalog/) with their data sheets.")
        per_component.append({"target": target, "kind": kind, "options": options})
    ready = [[o for o in c["options"] if not o.get("pending")] for c in per_component]
    if request.combine and len(ready) > 1:
        combos = [list(t) for t in product(*[r for r in ready if r])]
    else:
        combos = [[o] for r in ready for o in r]
    capped = combos[: max(1, int(request.max_candidates))]
    if len(combos) > len(capped):
        notes.append(f"{len(combos)} candidates; the {len(capped)} nearest the drawn parts are burned (max_candidates).")
    return {"components": per_component, "candidates": capped, "needs_pid_designer": needs_pid, "notes": notes,
            "pending": any(o.get("pending") for c in per_component for o in c["options"])}


def _trim_options(prep: Any, payload: Dict[str, Any], element: Dict[str, Any], target: str, label: str, side: str,
                  D_mm: float, baseline: Dict[str, Any], request: HardwareRequest, catalogs: Dict[str, Any],
                  n: int, notes: List[str]) -> List[Dict[str, Any]]:
    """Trim bores around the one that would take O/F to the design's, priced as K_minor."""
    from engine.layerx import catalog as cat
    from engine.layerx.measurements import Override

    f = baseline.get("figures") or {}
    burn_s = f.get("burn_time_s") or 0.0
    used = f.get("ox_used_kg" if side == "oxidiser" else "fuel_used_kg")
    if not burn_s or not used:
        raise ValueError(f"{target}: the baseline burn reports no flow on the {side} side to size a trim against")
    mdot = float(used) / float(burn_s)
    D = D_mm * 1e-3
    inlet = (getattr(prep, "inlet_nodes", None) or {}).get(side) or prep.derived.get("inlet_nodes", {}).get(side)
    cond = prep.model.built.network.conditions(inlet, float(prep.derived["target_lockup_psia"]) * PSI)
    rho, mu = float(cond.rho), float(cond.mu)
    v = mdot / (rho * math.pi * D * D / 4.0)
    q = 0.5 * rho * v * v
    # The loss that would take O/F to the design's at a fixed tank pressure and chamber pressure: the
    # side's flow scales as sqrt(drop), so the drop must fall by (target/current)^2 (fuel: inverted).
    of, design_of = f.get("of_mean"), baseline.get("design_of")
    p_drop = max(float(f.get("lockup_psia") or prep.derived["target_lockup_psia"]) - float(f.get("pc_mean_psia") or 0.0), 1.0)
    ratio = (design_of / of) if of and design_of else 0.99
    shrink = ratio ** 2 if side == "oxidiser" else (1.0 / ratio) ** 2
    if shrink >= 1.0:
        notes.append(f"A trim in the {side} line can only lower its flow: O/F {of:.4f} against {design_of} needs the "
                     "other side trimmed. Offered anyway, sized for 1 % less flow.")
        shrink = 0.98
    dp_needed = (1.0 - shrink) * p_drop * PSI
    K_needed = dp_needed / q

    def K_of(Do: float) -> float:
        C = request.trim_C or trim_orifice_C(D, Do, rho, mu, mdot)
        return trim_orifice_K(D, Do, C)

    lo_b, hi_b = 0.30 * D, 0.97 * D
    if K_of(hi_b) > K_needed:
        Do_star = hi_b
    else:
        for _ in range(60):
            mid = 0.5 * (lo_b + hi_b)
            lo_b, hi_b = (mid, hi_b) if K_of(mid) > K_needed else (lo_b, mid)
        Do_star = 0.5 * (lo_b + hi_b)
    rows = [r for r in cat.rows_for(catalogs, "drills", "orifice") if (cat.param_si(r, "d") or 0) < 0.97 * D_mm]
    k_old = _param(element, "K_minor")
    K0 = float(k_old["value"]) if k_old else 0.0
    out = []
    for r in cat.neighbours(rows, "d", Do_star * 1e3, n):
        Do = cat.param_si(r, "d") * 1e-3
        C = request.trim_C or trim_orifice_C(D, Do, rho, mu, mdot)
        K = trim_orifice_K(D, Do, C)
        # The extrapolated C's spread by tap location, as numbers (fluids' 'D' is D and D/2 taps).
        K_by_taps = None if request.trim_C else {
            t: trim_orifice_K(D, Do, trim_orifice_C(D, Do, rho, mu, mdot, taps=t)) for t in ("corner", "D")}
        prov = (f"trim orifice {r['drill']} ({Do * 1e3:.3f} mm, beta {Do / D:.3f}) in {label}: K {K:.4f} from fluids "
                f"(C {C:.3f}, {('given' if request.trim_C else TRIM_TAPS + ' taps, extrapolated')}) at {mdot:.3f} kg/s")
        out.append({
            "target": target, "label": f"Trim orifice in {label}", "row": {k: r.get(k) for k in ("id", "label", "source", "provenance", "drill")},
            "overrides": [Override(target=target, parameter="K_minor", value=K0 + K, unit="-", source=prov[:300],
                                   provenance="estimated")],
            "design_patch": None,
            "changes": [{"field": "K_minor", "before": K0, "after": K0 + K, "unit": "-",
                         "before_provenance": (f"{k_old.get('source')}: {k_old.get('reference') or ''}" if k_old else "none")}],
            "cad_impact": "new part",
            "trim": {"bore_mm": Do * 1e3, "beta": Do / D, "C": C, "K": K, "dp_psi_at_baseline": K * q / PSI,
                     "sized_for_psi": dp_needed / PSI, "K_by_taps": K_by_taps},
            "model": _trim_model(target, D, rho, mu, mdot, request.trim_C),
            "summary": f"trim {r['drill']} in {label} (K +{K:.3f}, ~{K * q / PSI:.1f} psi)",
        })
    return out


def _objective(figs: Optional[Dict[str, Any]], request: HardwareRequest, target_F: Optional[float],
               design_of: Optional[float]) -> Optional[float]:
    """Smaller is better."""
    if not figs:
        return None
    o = request.objective
    v: Any
    if o == "target_thrust_error":
        v = abs(figs["mean_thrust_N"] - target_F) if target_F and figs.get("mean_thrust_N") is not None else None
    elif o == "thrust_flatness":
        v = figs.get("thrust_spread_pct")
    elif o == "of_error":
        v = abs(figs["of_mean"] / design_of - 1.0) if design_of and figs.get("of_mean") else None
    elif o == "impulse":
        v = -figs["total_impulse_Ns"] if figs.get("total_impulse_Ns") is not None else None
    else:
        v = -figs["copv_spare_psi"] if figs.get("copv_spare_psi") is not None else None
    return float(v) if isinstance(v, (int, float)) and math.isfinite(v) else None


def _hw_rank(c: Dict[str, Any]) -> Tuple[int, int, float]:
    from engine.layerx.setpoint import usable

    if not usable(c.get("burn")):
        return (2, 0, math.inf)
    bad = sum(1 for r in c["burn"].get("limits") or [] if r.get("grade") == "bad")
    obj = c.get("objective_value")
    return (0 if bad == 0 else 1, bad, obj if obj is not None else math.inf)


def _hw_changes(options: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    from engine.layerx import diff

    out = []
    for o in options:
        for ch in o["changes"]:
            row = o.get("row") or {}
            is_design = o["target"].startswith("design:")
            own = ch.get("source") or row.get("source")
            src = "estimated" if o.get("trim") else (own if own in diff.SOURCES else "catalog")
            out.append(diff.change(
                component=o["label"], field=ch["field"], before=ch.get("before"), after=ch["after"], unit=ch["unit"],
                provenance=(f"catalog {row.get('id')}: {row.get('provenance')}" if not o.get("trim") else
                            f"{o['overrides'][0].source}"),
                cad_impact=o["cad_impact"] if ch["field"] != "orifice_l_over_d" else "none",
                target=(f"design:injector.geometry.{o['target'].split(':', 1)[1]}" if is_design and ch["field"] == "d_jet"
                        else f"design:discharge.{o['target'].split(':', 1)[1].split('.')[0]}.orifice_l_over_d"
                        if is_design else o["target"]),
                source=src, before_provenance=ch.get("before_provenance"),
                catalog=None if is_design or o.get("trim") else row,
                drill=({"drill": row.get("drill"), "d_mm": ch["after"]} if is_design and ch["field"] == "d_jet" else
                       ({"drill": row.get("drill"), **(o.get("trim") or {})} if o.get("trim") else None)),
                note=("trim orifice priced as K_minor: add an orifice symbol in pid-designer" if o.get("trim") else None)))
    return out


def _design_updates(options: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    geo: Dict[str, Any] = {}
    dis: Dict[str, Any] = {}
    for o in options:
        for side, fields in (o.get("design_patch") or {}).items():
            if "d_jet" in fields:
                geo.setdefault(side, {})["d_jet"] = float(fields["d_jet"])
            if "orifice_l_over_d" in fields:
                dis.setdefault(side, {})["orifice_l_over_d"] = round(float(fields["orifice_l_over_d"]), 4)
    if not geo and not dis:
        return None
    out: Dict[str, Any] = {}
    if geo:
        out["injector"] = {"geometry": geo}
    if dis:
        out["discharge"] = dis
    return out


def _merged_patch(options: List[Dict[str, Any]]) -> Optional[Dict[str, Dict[str, float]]]:
    patch: Dict[str, Dict[str, float]] = {}
    for o in options:
        for side, fields in (o.get("design_patch") or {}).items():
            patch.setdefault(side, {}).update(fields)
    return patch or None


def run_hardware(config: Any, drawing: Any, settings: Any, overrides: List[Any], request: HardwareRequest, *,
                 catalogs: Optional[Dict[str, Any]] = None, progress: Optional[Callable[[str, float], None]] = None,
                 cancelled: Callable[[], bool] = lambda: False, workers: Optional[int] = None,
                 evaluate: Optional[Callable[[List[Dict[str, Any]]], List[Dict[str, Any]]]] = None,
                 prep: Any = None) -> Dict[str, Any]:
    """Catalogue parts for the marked components, each a whole burn, ranked by ``request.objective``.

    ``evaluate(args_list)`` replaces the burns and ``prep`` the preflight (tests)."""
    from engine.layerx import diff
    from engine.layerx.catalog import load_catalogs
    from engine.layerx.patch import apply_design_patch
    from engine.layerx.pool import Cancelled, WorkerPool, default_workers
    from engine.layerx.setpoint import (SetpointRequest, burn_point, design_of_ratio, solve, target_thrust, usable)

    say = progress or (lambda stage, fraction: None)
    started = time.perf_counter()
    catalogs = catalogs or load_catalogs(None)
    if prep is None:
        from engine.layerx.prepare import prepare

        prep = prepare(config, None, drawing, replace(settings, card_center_psia=None), overrides)
        if not prep.ok:
            raise ValueError("Preflight failed: " + "; ".join(c.label for c in prep.checks if c.status == "fail"))
    design_of, of_source = design_of_ratio(config, request)
    try:
        target_F, target_source = target_thrust(config, SetpointRequest(target_thrust_N=request.target_thrust_N))
    except ValueError:
        target_F, target_source = None, "none"
    if request.objective == "target_thrust_error" and not target_F:
        raise ValueError("objective target_thrust_error needs a target thrust")
    if request.objective == "of_error" and not design_of:
        raise ValueError("objective of_error needs a design O/F: the design states no optimal_of_ratio; enter one")
    grading = {"margin_psi": request.margin_psi, "meop_psi": dict(request.meop_psi or {}), "design_of": design_of}
    plan = plan_candidates(prep, config, request, catalogs)

    pool = None
    counter = [0]
    if evaluate is None:
        n_workers = default_workers(1 + len(plan["candidates"]), workers)
        pool = WorkerPool(n_workers)

        def evaluate(args_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
            return pool.map(burn_point, args_list, cancelled=cancelled)
    else:
        n_workers = 1

    def args_for(options: List[Dict[str, Any]], **extra: Any) -> Dict[str, Any]:
        counter[0] += 1
        patch = _merged_patch(options)
        return {"config": apply_design_patch(config, patch) if patch else config, "drawing": drawing,
                "settings": settings, "overrides": list(overrides),
                "extra_overrides": [ov for o in options for ov in o.get("overrides") or []],
                "replay": bool(getattr(settings, "replay", True)), "grading": grading, "index": counter[0], **extra}

    try:
        say(f"Burning the drawn hardware and {len(plan['candidates'])} candidate(s)", 0.05)
        batch = [args_for([], tag="baseline")] + [args_for(c, tag=f"candidate {i + 1}") for i, c in enumerate(plan["candidates"])]
        burns = evaluate(batch)
        n_burns = len(batch)
        baseline = burns[0]
        if not usable(baseline):
            raise ValueError("the drawn hardware's own burn could not be used: "
                             + (baseline.get("error") or "; ".join(baseline.get("preflight") or []) or "tripped"))
        candidates = [{"options": c, "burn": b} for c, b in zip(plan["candidates"], burns[1:])]
        if plan["pending"]:
            if cancelled():
                raise Cancelled()
            say("Sizing the trim orifice from the baseline burn", 0.45)
            sized = plan_candidates(prep, config, request, catalogs, baseline={**baseline, "design_of": design_of})
            trims = [c for c in sized["candidates"] if any(o.get("trim") for o in c)]
            plan["components"], plan["notes"] = sized["components"], plan["notes"] + [
                n for n in sized["notes"] if n not in plan["notes"]]
            room = max(0, int(request.max_candidates) - len(candidates))
            trims = trims[:room] if room else []
            if trims:
                more = evaluate([args_for(c, tag=f"trim {i + 1}") for i, c in enumerate(trims)])
                n_burns += len(trims)
                candidates += [{"options": c, "burn": b} for c, b in zip(trims, more)]
        for c in candidates:
            c["objective_value"] = _objective((c["burn"] or {}).get("figures"), request, target_F, design_of)
        baseline_value = _objective(baseline.get("figures"), request, target_F, design_of)
        ranked = sorted(candidates, key=_hw_rank)
        best = ranked[0] if ranked else None
        notes = list(plan["notes"])
        def n_bad(b: Optional[Dict[str, Any]]) -> int:
            return sum(1 for r in (b or {}).get("limits") or [] if r.get("grade") == "bad")

        # A better objective bought by breaking a limit the drawn hardware keeps is not an improvement.
        improves = best is not None and usable(best["burn"]) and best["objective_value"] is not None \
            and baseline_value is not None and best["objective_value"] < baseline_value \
            and n_bad(best["burn"]) <= n_bad(baseline)
        if best is not None and not improves:
            notes.append("No candidate beats the drawn hardware on this objective within the limits the drawn "
                         "hardware keeps; the best one is shown.")
        setpoint = None
        final = best["burn"] if best else None
        if best is not None and request.verify and usable(best["burn"]) and request.objective != "target_thrust_error" \
                and target_F and not cancelled():
            say("Re-solving the set point for the best candidate", 0.6)
            base_args = args_for(best["options"])

            def evaluate_sp(points: List[Tuple[float, Optional[float], bool]]) -> List[Dict[str, Any]]:
                return evaluate([{**base_args, "lockup_psia": L, "fill_psig": F, "replay": rp,
                                  "index": base_args["index"] + k + 1} for k, (L, F, rp) in enumerate(points)])

            # The candidate's own burn is the first point; the solve burns a second and steps.
            sp_req = SetpointRequest(target_thrust_N=target_F, solve_fill=False, max_burns=4,
                                     replay=bool(getattr(settings, "replay", True)), margin_psi=request.margin_psi)
            L0 = float(best["burn"]["lockup_psia"])
            F0 = float(best["burn"]["fill_psig"])
            out = solve(evaluate_sp, start_lockup=L0, start_fill=F0, max_fill=F0, target=target_F, request=sp_req,
                        bounds=(0.5 * L0, 1.5 * L0),
                        first_guess=L0 * target_F / float(best["burn"]["figures"]["mean_thrust_N"]),
                        say=lambda s, f: say(s, 0.6 + 0.35 * f), cancelled=cancelled, seed=[best["burn"]])
            sp_burns = sum(1 for h in out["history"] if h.get("stage") != "seed")
            n_burns += sp_burns
            setpoint = {"converged": out["converged"], "burns": sp_burns, "notes": out["notes"],
                        "lockup_psia": out["final"].get("lockup_psia"), "dome_psig": out["final"].get("dome_psig"),
                        "fill_psig": out["final"].get("fill_psig")}
            if usable(out["final"]):
                final = out["final"]
    finally:
        if pool is not None:
            pool.close(cancelled())

    changes = _hw_changes(best["options"]) if best else []
    if setpoint and final is not None:
        for tgt, comp, field_, unit, b, a in (
                ("op:lockup_psia", "Tank lockup", "lockup_psia", "psia", baseline.get("lockup_psia"), final.get("lockup_psia")),
                ("op:dome_psig", "Dome loader (the dial)", "dome_psig", "psig", baseline.get("dome_psig"), final.get("dome_psig"))):
            if a is not None and b is not None and abs(float(a) - float(b)) >= 0.05:
                changes.append(diff.change(component=comp, field=field_, before=round(float(b), 2), after=round(float(a), 2),
                                           unit=unit, provenance="solved: Layer X set point re-solved for this hardware",
                                           cad_impact="setting only", target=tgt, source="solved"))
    before_fig = {**baseline["figures"], "dome_psig": baseline.get("dome_psig"), "lockup_psia": baseline.get("lockup_psia")}
    after_fig = ({**final["figures"], "dome_psig": final.get("dome_psig"), "lockup_psia": final.get("lockup_psia")}
                 if usable(final) else None)
    sha = str((baseline.get("derived") or {}).get("config_sha256") or getattr(prep, "config_sha256", "") or "")
    change_list = diff.build("hardware", changes, before=before_fig, after=after_fig,
                             limits=(final or {}).get("limits"), needs_pid_designer=plan["needs_pid_designer"],
                             basis={"config_sha256": sha, "drawing": (baseline.get("derived") or {}).get("drawing"),
                                    "objective": request.objective, "replay": baseline.get("replay")})
    updates = _design_updates(best["options"]) if best else None
    try:
        pid_export = diff.pid_designer_export(prep.drawing.payload, change_list,
                                              name=f"{prep.drawing.name} (Layer X hardware)", source=prep.drawing.id)
    except ValueError as exc:
        pid_export = {"error": str(exc)}
    change_list["exports"] = {"settings_patch": diff.settings_patch(change_list),
                              "design_write": diff.design_write(updates, sha) if updates and len(sha) == 64 else None,
                              "pid_designer": pid_export}
    say("Done", 1.0)

    def view(c: Dict[str, Any]) -> Dict[str, Any]:
        b = c.get("burn") or {}
        return {"summary": "; ".join(o["summary"] for o in c["options"]), "targets": [o["target"] for o in c["options"]],
                "ok": usable(b), "error": b.get("error") or ("; ".join(b.get("preflight") or []) or None),
                "figures": b.get("figures"), "objective_value": c.get("objective_value"),
                "limits_bad": [r.get("label") for r in b.get("limits") or [] if r.get("grade") == "bad"],
                "limits_warn": [r.get("label") for r in b.get("limits") or [] if r.get("grade") == "warn"],
                "rank": ranked.index(c) + 1 if c in ranked else None,
                "trim": next((o.get("trim") for o in c["options"] if o.get("trim")), None)}

    models = [o["model"] for c in candidates for o in c["options"] if o.get("model")][:1]
    return {
        "mode": "hardware",
        "objective": request.objective,
        "target": {"mean_thrust_N": target_F, "source": target_source, "design_of": design_of, "design_of_source": of_source},
        "components": [{"target": c["target"], "kind": c["kind"],
                        "options": [o.get("summary") for o in c["options"]]} for c in plan["components"]],
        "baseline": {"figures": baseline["figures"], "objective_value": baseline_value,
                     "limits_bad": [r.get("label") for r in baseline.get("limits") or [] if r.get("grade") == "bad"]},
        "candidates": [view(c) for c in candidates],
        "winner": view(best) if best else None,
        "improves": improves,
        "setpoint": setpoint,
        "final": {"figures": (final or {}).get("figures"), "limits": (final or {}).get("limits"),
                  "limits_basis": (final or {}).get("limits_basis")},
        "change_list": change_list,
        "needs_pid_designer": plan["needs_pid_designer"],
        "catalog_problems": list(catalogs.get("problems") or []),
        "model": {
            "name": "Layer X hardware mode: discrete catalogue parts, one whole burn each, ranked",
            "source": "catalogues: engine/layerx/catalog.py (drills: ASME B94.11M via reconcile.NUMBER_DRILLS_IN); "
                      "ranking: feasible first, then fewest broken limits, then the objective (after Deb's feasibility "
                      "rules, as the legacy search, with a count of broken limits in place of the violation sum)",
            "assumptions": [
                "Candidates burn at the rail's settings; the winner's set point is re-solved (lockup only) so its thrust "
                "is the target's" if request.verify else "Candidates burn at the rail's settings; no set point re-solve.",
                "A drawing change is a restatement on an in-memory copy (measurements.Override); the drawing is not written.",
                "A trim orifice is charged as K_minor on its line (no orifice element exists on the drawing).",
            ],
            "inputs": {
                "objective": {"value": request.objective, "unit": "", "provenance": "request"},
                "target_mean_thrust_N": {"value": target_F, "unit": "N", "provenance": target_source},
                "design_of": {"value": design_of, "unit": "", "provenance": of_source},
                "neighbours": {"value": request.neighbours, "unit": "", "provenance": "request"},
                "margin_psi": {"value": request.margin_psi, "unit": "psi", "provenance": "request (assumed 100 psi default)"},
            },
        },
        "trim_model": models[0] if models else None,
        "notes": notes,
        "burns": n_burns,
        "workers": n_workers,
        "wall_s": time.perf_counter() - started,
        "summary": {"objective": request.objective, "winner": view(best)["summary"] if best else None,
                    "improves": improves, "mean_thrust_N": ((final or {}).get("figures") or {}).get("mean_thrust_N"),
                    "of_mean": ((final or {}).get("figures") or {}).get("of_mean")},
        "basis": ("Each candidate is a whole Layer X burn of an in-memory copy of the drawing or design with the rail's "
                  "settings, graded with the shared limits; the change list's effects are baseline -> the winner's "
                  "final burn."),
    }
