"""Phase 5: which unmeasured input moves the burn, and by how much.

A burn rests on inputs nobody has measured yet. Each is varied on its own, from the low end
of its plausible range to the high end, with everything else held at nominal. This is a
tornado. It answers two questions:

* how wide the answer is: the band on impulse, burn time, thrust and margins, as the
  root-sum-square of the one-at-a-time swings;
* which measurement narrows it most: the factors ranked by how far they move the burn.

A one-at-a-time sweep assumes the effects are roughly independent and linear over their
ranges, which is what the RSS assumes too. It costs 2N burns rather than the hundreds a Monte
Carlo needs, and it says *which* input, which a Monte Carlo cloud does not.

The factors, and where their ranges come from
----------------------------------------------
Feed, from the drawing:

* **Dome regulator supply-pressure effect, ×0.5–1.5.** One GN2 back-fit plus the vendor's sheet.
* **Dome regulator droop, ×0.5–1.5.** Same basis.
* **Ullage collapse, off → on.** A model choice. The collapse model is a stated lower bound.

Engine, through EngineDesign's own measurement fields, so the engine card is rebuilt by
EngineDesign under each perturbation rather than scaled by a guessed sensitivity:

* **LOX and fuel orifice Cd, ±3 %.** The scatter of the Lichtarowicz correlation the plate is
  sized with. Replace it with a cold-flow Cd.
* **Rupe mixing E_m_opt, 0.70 / 0.85.** The literature range the spray report uses
  (engine/core/injectors/spray_report.py). On the 6.5 kN engine that range is 6242–6601 N.
* **Nozzle efficiency, ±0.02 about the config's value.** Assumed.

A factor that has been measured uses its stated uncertainty instead. A measured value with
no uncertainty is treated as exact and dropped from the sweep, which the result says.

Burns run without the erosion replay. The replay moves every case the same way, and the
question here is the difference between cases. They run in parallel worker processes, each
seeded with the nominal engine card, so only the engine perturbations pay for a new card.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Dict, List, Optional, Tuple

from engine.layerx.diag.limits import THRESHOLDS as _LIMITS  # noqa: E402 - the one copy of the thresholds

#: The bottle above the tanks at burnout below which a case is said to break the margin [psi]: the
#: shared limits' ``copv_headroom_psi`` (engine/layerx/diag/limits.py), which a run is graded by.
SPARE_PSI = float(_LIMITS["copv_headroom_psi"]["value"])
#: The injector dP/Pc floor when the design states no band: the shared limits' ``stiffness_floor``.
STIFFNESS_FLOOR = float(_LIMITS["stiffness_floor"]["value"])

#: Outputs every case reports, and the summary path each is read from.
METRICS: Dict[str, Tuple[str, ...]] = {
    "total_impulse_Ns": ("total_impulse_Ns",),
    "burn_time_s": ("burn_time_s",),
    "mean_thrust_N": ("mean_thrust_N",),
    "pc_mean_psia": ("pc_mean_psia",),
    "of_mean": ("of_mean",),
    "ox_min_psia": ("ox", "min_psia"),
    "fuel_min_psia": ("fuel", "min_psia"),
    "ox_stiffness_min": ("ox", "stiffness_min"),
    "fuel_stiffness_min": ("fuel", "stiffness_min"),
    "copv_end_psia": ("copv_end_psia",),
}


@dataclass
class Case:
    """One perturbation: what changes, and how it is described."""

    factor: str
    side: str
    """``low`` or ``high`` (or ``on`` for a switch)."""
    label: str
    overrides: List[Any] = field(default_factory=list)
    settings: Dict[str, Any] = field(default_factory=dict)
    engine: Dict[str, Any] = field(default_factory=dict)
    """``{"measure": key, "value": x}`` or ``{"field": dotted path, "value": x}``."""


@dataclass
class Factor:
    key: str
    label: str
    group: str
    basis: str
    cases: List[Case]
    nominal: Optional[float] = None
    unit: str = ""


def _get(obj: Any, path: str) -> Any:
    for part in path.split("."):
        obj = obj[part] if isinstance(obj, dict) else getattr(obj, part)
    return obj


def factors(prep: Any, config: Any) -> Tuple[List[Factor], List[str]]:
    """The factors for this burn, each with its low and high cases, and notes about any dropped."""
    from engine.layerx.measurements import Override

    out: List[Factor] = []
    notes: List[str] = []
    measured = {o["key"]: o for o in prep.overrides if o.get("provenance") == "measured"}

    # ---- the dome regulator, from the drawing ----
    domes = [n for n in prep.model.diagram.nodes if n.type == "PR" and n.options.get("domeLoaded") == "yes"]
    for node in domes[:1]:
        for param, label in (("supply_coefficient", "Regulator supply-pressure effect"), ("flow_droop", "Regulator droop")):
            p = node.params.get(param)
            if p is None:
                continue
            key = f"node:{node.id}.{param}"
            value, unit = float(p.value), str(p.unit)
            m = measured.get(key)
            if m is not None and m.get("uncertainty") is None:
                notes.append(f"{label} is measured with no uncertainty stated; held exact.")
                continue
            if m is None and p.source.value == "measured":
                # The drawing itself says measured: its provenance stands, as a restatement's would.
                notes.append(f"{label} ({value:g} {unit}) is marked measured on the drawing with no uncertainty "
                             f"stated; held exact. Restate it with a ± under Parameters and measurements to sweep it.")
                continue
            if m is not None:
                lo, hi = value - float(m["uncertainty"]), value + float(m["uncertainty"])
                basis = f"measured {value:g} ± {m['uncertainty']:g} {unit} ({m['source']})"
            else:
                lo, hi = 0.5 * value, 1.5 * value
                basis = (f"×0.5–1.5 of the drawing's {value:g} {unit} ({p.source.value}); the range is assumed, "
                         "wide enough for a regulator nobody has flow-tested")
            def case(side: str, v: float, param=param, unit=unit, key=key) -> Case:
                return Case(key, side, f"{v:g} {unit}", overrides=[Override(
                    target=f"node:{node.id}", parameter=param, value=v, unit=unit,
                    source=f"Layer X uncertainty sweep ({side})", provenance="estimated")])
            out.append(Factor(key, label, "feed", basis, [case("low", lo), case("high", hi)], value, unit))

    # ---- ullage collapse: a model choice ----
    collapse_on = bool(getattr(getattr(prep, "setup", None), "ullage_collapse", prep.settings.ullage_collapse))
    out.append(Factor("ullage_collapse", "Ullage collapse", "feed",
                      f"the collapse model switched {'off' if collapse_on else 'on'} (the feed twin's semi-infinite "
                      "conduction; a stated lower bound)",
                      [Case("ullage_collapse", "off" if collapse_on else "on", "off" if collapse_on else "on",
                            settings={"ullage_collapse": not collapse_on})]))

    # ---- the engine, through EngineDesign's own measurement fields ----
    ref = prep.link.reference if prep.link is not None else {}
    ms = getattr(config, "measurements", None)
    model_cd: Dict[str, float] = {}
    if prep.link is not None and prep.link.sampler is not None:
        # The model's Cd at T-0, from EngineDesign's full solve at the line exit (the card's fast
        # path does not report it).
        try:
            full = prep.link.sampler.runner.evaluate(ref["p_O"], ref["p_F"], silent=True,
                                                     P_ambient=prep.ambient_pa)
            model_cd = {"O": float(full.get("Cd_O", float("nan"))), "F": float(full.get("Cd_F", float("nan")))}
        except Exception as exc:  # noqa: BLE001
            notes.append(f"Orifice Cd left out: EngineDesign's solve at T-0 failed ({type(exc).__name__}).")
    for side, key, label in (("O", "cd_O", "LOX orifice Cd"), ("F", "cd_F", "Fuel orifice Cd")):
        mv = getattr(ms, key, None) if ms is not None else None
        nominal = float(mv.value) if mv is not None else model_cd.get(side, float("nan"))
        if not math.isfinite(nominal):
            notes.append(f"{label} left out: no nominal value to vary.")
            continue
        if mv is not None and mv.uncertainty is None:
            notes.append(f"{label} is measured with no uncertainty stated; held exact.")
            continue
        d = float(mv.uncertainty) if mv is not None else 0.03 * nominal
        basis = (f"measured {nominal:.3f} ± {d:.3f} ({mv.source})" if mv is not None
                 else f"±3 % of the model's {nominal:.3f}: the Lichtarowicz correlation's scatter")
        out.append(Factor(f"engine.{key}", label, "engine", basis, [
            Case(f"engine.{key}", "low", f"{nominal - d:.3f}", engine={"measure": key, "value": nominal - d}),
            Case(f"engine.{key}", "high", f"{nominal + d:.3f}", engine={"measure": key, "value": nominal + d}),
        ], nominal))
    em = getattr(ms, "em", None) if ms is not None else None
    if em is not None and em.uncertainty is None:
        notes.append("Mixing E_m is measured with no uncertainty stated; held exact.")
    elif em is not None:
        e, u = float(em.value), float(em.uncertainty)
        out.append(Factor("engine.em", "Mixing E_m", "engine", f"measured {e:.3f} ± {u:.3f} ({em.source})", [
            Case("engine.em", "low", f"{e - u:.3f}", engine={"measure": "em", "value": e - u}),
            Case("engine.em", "high", f"{e + u:.3f}", engine={"measure": "em", "value": e + u})], e))
    else:
        e0 = float(config.combustion.efficiency.rupe_Em_opt)
        out.append(Factor("engine.em", "Mixing E_m", "engine",
                          f"Rupe E_m_opt 0.70 / 0.85 about the config's {e0:.2f}: the literature range the spray report uses", [
            Case("engine.em", "low", "0.70", engine={"field": "combustion.efficiency.rupe_Em_opt", "value": 0.70}),
            Case("engine.em", "high", "0.85", engine={"field": "combustion.efficiency.rupe_Em_opt", "value": 0.85})], e0))
    zn = getattr(ms, "nozzle_efficiency", None) if ms is not None else None
    cfg_z = getattr(config.chamber_geometry, "nozzle_efficiency", None)
    z0 = float(zn.value) if zn is not None else (float(cfg_z) if cfg_z else None)
    if z0 is None:
        notes.append("Nozzle efficiency left out: the config states none to vary about.")
    elif zn is not None and zn.uncertainty is None:
        notes.append("Nozzle efficiency is measured with no uncertainty stated; held exact.")
    else:
        if zn is not None:
            dz = float(zn.uncertainty)
            lo_z, hi_z = z0 - dz, z0 + dz
            basis = f"measured {z0:.3f} ± {dz:.3f} ({zn.source})"
        else:
            # Unsourced: from the config's value down 0.02, up to 0.99. An 80 % bell at this area
            # ratio is typically 0.975-0.985 (divergence 0.983 alone), so the range must reach it.
            lo_z, hi_z = z0 - 0.02, min(max(z0 + 0.02, 0.99), 0.995)
            basis = f"{lo_z:.2f}–{hi_z:.2f} about the config's unsourced {z0:.2f}; an 80 % bell is typically 0.975–0.985"
        out.append(Factor("engine.nozzle", "Nozzle efficiency", "engine", basis, [
            Case("engine.nozzle", "low", f"{lo_z:.3f}", engine={"measure": "nozzle_efficiency", "value": lo_z}),
            Case("engine.nozzle", "high", f"{hi_z:.3f}", engine={"measure": "nozzle_efficiency", "value": hi_z})], z0))

    # ---- the drawing's own guesses: every estimated flow resistance, as one factor per kind ----
    # Impulse cannot see these (a fixed load burns dry whatever the flow), but thrust, O/F, which
    # tank runs dry and the injector's stiffness can: valve Cv 26 -> 8 moved thrust 1.3 % and
    # flipped depletion on the 6.8 kN stand.
    def guessed(param: Any, key: str) -> bool:
        return (str(getattr(param.source, "value", param.source)).lower() in ("estimated", "default")
                and key not in measured)

    diagram = prep.model.diagram
    groups = (
        ("valve_cv", "Valve Cv", "Cv", [(f"node:{n.id}", n.params["Cv"]) for n in diagram.nodes
                                       if n.type == "SOL" and "Cv" in n.params and guessed(n.params["Cv"], f"node:{n.id}.Cv")]),
        ("line_k", "Line fitting losses", "K_minor", [(f"edge:{e.id}", e.params["K_minor"]) for e in diagram.edges
                                                      if "K_minor" in (e.params or {}) and float(e.params["K_minor"].value) > 0
                                                      and guessed(e.params["K_minor"], f"edge:{e.id}.K_minor")]),
        ("line_length", "Line lengths", "length", [(f"edge:{e.id}", e.params["length"]) for e in diagram.edges
                                                    if "length" in (e.params or {}) and guessed(e.params["length"], f"edge:{e.id}.length")]),
    )
    for key, label, param, items in groups:
        if not items:
            continue

        def scaled(side: str, k: float, param=param, items=items, key=key) -> Case:
            return Case(f"drawing.{key}", side, f"×{k:g}", overrides=[Override(
                target=t, parameter=param, value=float(p.value) * k, unit=str(p.unit),
                source=f"Layer X uncertainty sweep ({side})", provenance="estimated") for t, p in items])
        # More resistance is the "low" case for a Cv (smaller) and the "high" case for K and length.
        cases = [scaled("low", 0.5), scaled("high", 1.5)]
        out.append(Factor(f"drawing.{key}", label, "feed",
                          f"×0.5–1.5 of every estimated {param} on the drawing together ({len(items)} of them); "
                          "measure them, or restate them, to drop this", cases, unit=""))

    # ---- the bottle's wall, which sets how much the expanding gas is warmed ----
    copv_id = (getattr(prep, "derived", None) or {}).get("copv_id")
    for b in [n for n in diagram.nodes if n.type == "KBOTTLE" and (copv_id is None or n.id == copv_id)][:1]:
        p = b.params.get("wall_conductance")
        if p is not None and guessed(p, f"node:{b.id}.wall_conductance"):
            v = float(p.value)
            out.append(Factor("drawing.bottle_wall", "Bottle wall heat transfer", "feed",
                              f"×0.25–2 of the drawing's estimated {v:g} {p.unit}: the bottle's spare at burnout moves with it",
                              [Case("drawing.bottle_wall", side, f"{v * k:g} {p.unit}", overrides=[Override(
                                  target=f"node:{b.id}", parameter="wall_conductance", value=v * k, unit=str(p.unit),
                                  source=f"Layer X uncertainty sweep ({side})", provenance="estimated")])
                               for side, k in (("low", 0.25), ("high", 2.0))], v, str(p.unit)))

    # ---- model switches the burn runs without: each one-sided ----
    # Each against what the burn actually ran: the feed twin's Setup, or the run's override of it.
    for flag, label, why in (("line_walls", "Line-wall heat", "tubes and fittings warming the pressurant"),
                             ("ullage_vapour", "Propellant vapour", "boil-off into the ullage")):
        on = bool(getattr(getattr(prep, "setup", None), flag, getattr(prep.settings, flag, False)))
        out.append(Factor(flag, label, "feed", f"switched {'off' if on else 'on'}: {why}",
                          [Case(flag, "off" if on else "on", "off" if on else "on", settings={flag: not on})]))

    # ---- the stand on the day: how well the operator can set what the rail says ----
    lockup = float(prep.derived["target_lockup_psia"])
    fill = float(prep.derived["copv_psig"])
    out.append(Factor("op.lockup", "Tank pressure as set", "operation",
                      "±5 psi: the dome set by hand against a gauge (assumed)",
                      [Case("op.lockup", "low", f"{lockup - 5:.0f} psia", settings={"tank_pressure_psia": lockup - 5}),
                       Case("op.lockup", "high", f"{lockup + 5:.0f} psia", settings={"tank_pressure_psia": lockup + 5})], lockup, "psia"))
    out.append(Factor("op.fill", "Bottle fill as filled", "operation",
                      "−150 / +0 psig: a fill that stops short, or cools after filling (assumed)",
                      [Case("op.fill", "low", f"{fill - 150:.0f} psig", settings={"copv_pressure_psig": fill - 150})], fill, "psig"))
    return out, notes


def _perturbed_config(config: Any, engine: Dict[str, Any]) -> Any:
    if not engine:
        return config
    from engine.pipeline.config_schemas import MeasuredValue, MeasurementsConfig

    cfg = config.model_copy(deep=True)
    if "measure" in engine:
        ms = cfg.measurements or MeasurementsConfig()
        ms = ms.model_copy(update={engine["measure"]: MeasuredValue(value=float(engine["value"]),
                                                                    source="Layer X uncertainty sweep")})
        cfg.measurements = ms
    else:
        *head, last = engine["field"].split(".")
        target = cfg
        for part in head:
            target = target[part] if isinstance(target, dict) else getattr(target, part)
        setattr(target, last, float(engine["value"]))
    return cfg


def _metrics(summary: Dict[str, Any]) -> Dict[str, Optional[float]]:
    out: Dict[str, Optional[float]] = {}
    for name, path in METRICS.items():
        v: Any = summary
        for part in path:
            v = v.get(part) if isinstance(v, dict) else None
        out[name] = float(v) if isinstance(v, (int, float)) and math.isfinite(v) else None
    return out


# ------------------------------------------------------------------ workers

_SEED: Dict[Any, Any] = {}


# The pool and its worker seeding live in engine/layerx/pool.py; the names stay for old callers.
from engine.layerx.pool import _init_worker  # noqa: E402,F401


def _burn_case(args: Tuple[Any, Any, Any, List[Any], Dict[str, Any]]) -> Dict[str, Any]:
    """One case, start to finish, in whatever process runs it."""
    config, drawing, settings, overrides, case = args
    from engine.layerx.analysis import run_prepared
    from engine.layerx.prepare import prepare

    started = time.perf_counter()
    try:
        cfg = _perturbed_config(config, case.get("engine") or {})
        # On the pad: a flown pass per case would multiply the sweep by the flight loop, and what
        # ranks the inputs is the burn. The flight's own effect is the run's pad-against-flight table.
        st = replace(settings, flight=False, **(case.get("settings") or {}))
        prep = prepare(cfg, None, drawing, st, list(overrides) + list(case.get("overrides") or []))
        if not prep.ok:
            failing = [c.label for c in prep.checks if c.status == "fail"]
            return {"ok": False, "error": "preflight: " + "; ".join(failing), "case": case["id"]}
        res = run_prepared(prep, replay=False)
        if res.get("tripped"):
            # A burn stopped by a vessel trip is a failed case, not a short one: its totals end at the
            # trip, and as a swing they would read as the input's effect on the burn.
            return {"ok": False, "case": case["id"], "tripped": res["tripped"], "error": _trip_words(res["tripped"]),
                    "wall_s": time.perf_counter() - started}
        s = res["summary"]
        thrust = [(t, f) for t, f, on in zip(res["series"]["t"], res["series"]["chamber"]["thrust_N"],
                                               res["series"]["firing"]) if on]
        return {"ok": True, "case": case["id"], "metrics": _metrics(s), "thrust": thrust,
                "depleted": s.get("depleted_side") or "", "lockup_psia": prep.derived.get("target_lockup_psia"),
                "wall_s": time.perf_counter() - started}
    except Exception as exc:  # noqa: BLE001 - one failed case is reported, the sweep goes on
        out = {"ok": False, "case": case["id"], "error": f"{type(exc).__name__}: {exc}"}
        record = getattr(exc, "record", None)          # analysis.StandTripped: tripped in the settle
        if isinstance(record, dict):
            out.update({"tripped": record, "error": _trip_words(record)})
        return out


def _trip_words(trip: Dict[str, Any]) -> str:
    """A tripped case, in the words a crossing lists it with."""
    who = trip.get("label") or trip.get("vessel") or "a vessel"
    p, m, t = trip.get("p_psia"), trip.get("mawp_psia"), trip.get("t")
    at = f" at t = {float(t):.2f} s" if isinstance(t, (int, float)) else ""
    over = f" ({float(p):.1f} psia, trips at {float(m):.1f})" if isinstance(p, (int, float)) and isinstance(m, (int, float)) else ""
    return f"vessel trip: {who}{over}{at}"


def run_sweep(config: Any, drawing: Any, settings: Any, overrides: List[Any], *,
              progress: Optional[Callable[[str, float], None]] = None,
              cancelled: Callable[[], bool] = lambda: False,
              workers: Optional[int] = None) -> Dict[str, Any]:
    """The nominal burn and every factor's cases, in parallel; the tornado and the band."""
    from engine.layerx.pool import WorkerPool, default_workers
    from engine.layerx.prepare import prepare

    say = progress or (lambda stage, fraction: None)
    started = time.perf_counter()
    say("Preparing the nominal burn", 0.02)
    flown = bool(getattr(settings, "flight", False))
    st = replace(settings, replay=False, flight=False) if hasattr(settings, "replay") else settings
    nominal_prep = prepare(config, None, drawing, st, overrides)
    if not nominal_prep.ok:
        raise ValueError("preflight has failing checks; fix them before sweeping")
    found, notes = factors(nominal_prep, config)
    if flown:
        notes.append("Swept on the pad at one g: the flight's own effect is the run's pad-against-flight table.")

    tasks: List[Dict[str, Any]] = [{"id": "nominal"}]
    for f in found:
        for c in f.cases:
            tasks.append({"id": f"{f.key}|{c.side}", "overrides": c.overrides, "settings": c.settings,
                          "engine": c.engine})
    n_workers = default_workers(len(tasks), workers)
    args = [(config, drawing, st, overrides, t) for t in tasks]
    say(f"Burning {len(tasks)} cases on {n_workers} workers", 0.05)
    with WorkerPool(n_workers) as pool:
        done = pool.map(_burn_case, args, cancelled=cancelled,
                        on_result=lambda k, r: say(f"Case {k} of {len(args)} done", 0.05 + 0.9 * k / len(args)))
    results: Dict[str, Dict[str, Any]] = {r["case"]: r for r in done}

    base = results.get("nominal")
    if not base or not base.get("ok"):
        # A nominal burn that trips has no swings to measure against (base["error"] says which vessel).
        raise RuntimeError(f"the nominal case failed: {base.get('error') if base else 'no result'}")
    nominal = base["metrics"]
    rows = []
    for f in found:
        entry = {"key": f.key, "label": f.label, "group": f.group, "basis": f.basis, "cases": {}}
        for c in f.cases:
            r = results.get(f"{f.key}|{c.side}") or {"ok": False, "error": "no result"}
            if not r.get("ok"):
                entry["cases"][c.side] = {"label": c.label, "ok": False, "error": r.get("error")}
                if r.get("tripped"):
                    entry["cases"][c.side]["tripped"] = r["tripped"]
                continue
            delta = {k: (v - nominal[k]) if v is not None and nominal.get(k) is not None else None
                     for k, v in r["metrics"].items()}
            entry["cases"][c.side] = {"label": c.label, "ok": True, "metrics": r["metrics"], "delta": delta,
                                      "thrust": r["thrust"]}
        swing = {}
        for k in METRICS:
            ds = [abs(cs["delta"][k]) for cs in entry["cases"].values() if cs.get("ok") and cs["delta"].get(k) is not None]
            swing[k] = max(ds) if ds else None
        entry["swing"] = swing
        rows.append(entry)
    rows.sort(key=lambda e: -(e["swing"].get("total_impulse_Ns") or 0.0))
    band = {}
    band_low: Dict[str, Optional[float]] = {}
    band_high: Dict[str, Optional[float]] = {}
    for k in METRICS:
        parts = [e["swing"][k] for e in rows if e["swing"].get(k) is not None]
        band[k] = math.sqrt(sum(p * p for p in parts)) if parts else None
        # Each side on its own: a factor that only moves the answer down adds nothing above it.
        downs, ups = [], []
        for e in rows:
            ds = [cs["delta"][k] for cs in e["cases"].values() if cs.get("ok") and cs["delta"].get(k) is not None]
            if ds:
                downs.append(min(min(ds), 0.0))
                ups.append(max(max(ds), 0.0))
        band_low[k] = math.sqrt(sum(d * d for d in downs)) if downs else None
        band_high[k] = math.sqrt(sum(u * u for u in ups)) if ups else None

    # Every case graded against the limits a run is graded by: which inputs, at the end of their
    # range, break the injector's stiffness floor or the bottle's margin, or flip the tank that
    # runs dry first.
    band_cfg = nominal_prep.derived.get("stiffness_band") or {}
    floor = {"ox": (band_cfg.get("oxidiser") or [STIFFNESS_FLOOR])[0], "fuel": (band_cfg.get("fuel") or [STIFFNESS_FLOOR])[0]}
    nominal_side = base.get("depleted", "")
    crossings: List[Dict[str, Any]] = []
    for e in rows:
        for side, cs in e["cases"].items():
            if cs.get("tripped"):
                # The input, at this end of its range, trips the stand: the strongest crossing there is.
                cs["breaks"] = [cs.get("error") or "vessel trip"]
                crossings.append({"factor": e["label"], "side": side, "case": cs["label"], "breaks": cs["breaks"],
                                  "tripped": True})
                continue
            if not cs.get("ok"):
                continue
            r = results.get(f"{e['key']}|{side}") or {}
            m = cs["metrics"]
            breaks = []
            for name, key in (("LOX ΔP/Pc", "ox"), ("Fuel ΔP/Pc", "fuel")):
                v = m.get(f"{key}_stiffness_min")
                if v is not None and v < floor[key]:
                    breaks.append(f"{name} {v * 100:.1f} % < {floor[key] * 100:.0f} %")
            spare = (m["copv_end_psia"] - float(r.get("lockup_psia") or 0.0)) if m.get("copv_end_psia") is not None else None
            if spare is not None and spare < SPARE_PSI:
                breaks.append(f"bottle spare {spare:.0f} psi < {SPARE_PSI:.0f}")
            if r.get("depleted") and nominal_side and r["depleted"] != nominal_side:
                breaks.append(f"{'fuel' if r['depleted'] == 'fuel' else 'LOX'} runs dry first")
            cs["breaks"] = breaks
            if breaks:
                crossings.append({"factor": e["label"], "side": side, "case": cs["label"], "breaks": breaks})
    failed = [e["key"] + "|" + side for e in rows for side, cs in e["cases"].items()
              if not cs.get("ok") and not cs.get("tripped")]
    trips = [e["key"] + "|" + side for e in rows for side, cs in e["cases"].items() if cs.get("tripped")]
    say("Done", 1.0)
    return {
        "nominal": nominal,
        "nominal_thrust": base["thrust"],
        "factors": rows,
        "band": band,
        "band_low": band_low,
        "band_high": band_high,
        "crossings": crossings,
        "notes": notes + ([f"{len(failed)} case(s) failed: {', '.join(failed)}"] if failed else [])
        + ([f"{len(trips)} case(s) tripped the stand and are left out of the swings (see the crossings): "
            f"{', '.join(trips)}"] if trips else []),
        "cases": len(tasks),
        "workers": n_workers,
        "wall_s": time.perf_counter() - started,
        "basis": ("One factor at a time, low and high, everything else nominal. Below and above are each the "
                  "root-sum-square of the factors' swings that way; ranges are bounds unless a measurement "
                  "states a one-sigma. Burns on the pad, without the erosion replay."),
    }
