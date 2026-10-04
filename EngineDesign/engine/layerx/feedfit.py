"""The drawing's feed, in the form the injector is designed with.

EngineDesign sizes the injector (Layer 1, forward mode) at a tank pressure, less one loss per side,
``K0`` velocity heads of the line plus the exit dump (``engine/pipeline/feed_loss.py``). The drawing
says otherwise in two places, measured on the 6.8 kN stand burn:

* **The tank does not hold its lockup while firing.** It holds lockup less the regulator's droop
  and the press line's loss into the ullage, partly given back by the supply-pressure effect as
  the bottle falls: 13 psi below lockup on average on the LOX side, 25 psi at worst. EngineDesign's
  tank pressure is the regulator's set point, flowing nothing.
* **The lines lose more than their K0 says**, because the drawing has the valves, the bends and
  the lengths: LOX 0.728 velocity heads against 0.643, fuel 2.16 against 2.02.

Together the manifolds sit 13–15 psi below what the injector was sized for, about 11 % of its
drop, and not by the same amount on the two sides.

``fit_feed`` reads both from a Layer X burn, per side, against EngineDesign's own velocity head
(its density, its ``A_hydraulic``) so the numbers drop straight into ``K0``:

* ``K_line``: the drawing's lines, tank to line exit, least squares over the settled burn. A
  velocity-head law is the lines' own form (Darcy plus fittings), so this one is physical.
* ``K_supply``: the burn-mean fall of the tank below lockup, expressed in the same velocity heads at
  the burn's mean flow. This one is not a velocity-head law (droop goes with flow, the
  supply-pressure effect with time), so it is exact at the flow it was fitted at and approximate
  away from it: a design that moves the flow 5 % moves it ~0.7 psi. Fit again after resizing the
  injector, and the two converge.

``K0 = K_line + K_supply`` is the whole loss from the lockup to the line exit at the design flow:
the drawing's, in the form Layer 1's solver already reads. The exit dump stays EngineDesign's
``K_exit``, which is the term the engine card uses too. Written into the design, it carries a
``derived_from`` record saying which drawing, which run and which flow.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from engine.layerx.prepare import PSI, Prepared

#: Steps after Fire left out of the fit: the ignition transient, as the other burn averages do.
SETTLED_S = 0.3

SIDES = (("ox", "oxidizer", "LOX"), ("fuel", "fuel", "Fuel"))


def fit_feed(prep: Prepared, result: Dict[str, Any], config: Any) -> Dict[str, Any]:
    """Per side: the drawing's feed against the design's, and the K0 that makes them agree."""
    from engine.pipeline.feed_loss import delta_p_feed

    series = result["series"]
    fire = [i for i, f in enumerate(series["firing"]) if f]
    if len(fire) < 4:
        return {"available": False, "error": "the burn is too short to fit"}
    t0 = series["t"][fire[0]]
    idx = [i for i in fire[:-1] if series["t"][i] - t0 >= SETTLED_S]
    if len(idx) < 3:
        return {"available": False, "error": "too few settled steps to fit"}
    flown = bool((result.get("flight") or {}).get("ok"))
    sides: Dict[str, Any] = {}
    for key, cside, label in SIDES:
        # Each side's own tank at T-0: on a drawing with two regulators they differ.
        lockup = float(result["summary"][key]["t0_psia"])
        fs = config.feed_system[cside]
        rho = float(config.fluids[cside].density)
        mu = getattr(config.fluids[cside], "viscosity", None)
        area = float(fs.A_hydraulic)
        s = series[key]
        rows = []
        for i in idx:
            m = float(s["mdot"][i])
            q = 0.5 * rho * (m / (rho * area)) ** 2 / PSI  # one velocity head of the design's line [psi]
            rows.append((m, q, lockup, float(s["tank_psia"][i]), float(s["inlet_psia"][i]), float(s["manifold_psia"][i])))
        m_mean = sum(r[0] for r in rows) / len(rows)
        q_mean = sum(r[1] for r in rows) / len(rows)
        sum_qq = sum(r[1] ** 2 for r in rows)
        # The lines: tank to line exit is a velocity-head law; least squares through the origin.
        k_line = sum((r[3] - r[4]) * r[1] for r in rows) / sum_qq
        # The supply: lockup to tank, the burn's mean, in velocity heads at its mean flow.
        deficit = sum(r[2] - r[3] for r in rows) / len(rows)
        k_supply = deficit / q_mean
        k0 = k_line + k_supply
        # The design today, at the same flows: lockup less its feed loss, exit dump included.
        def design_manifold(m: float, cfg: Any) -> float:
            return lockup - delta_p_feed(m, rho, cfg, lockup * PSI, mu=mu) / PSI
        fitted_cfg = fs.model_copy(update={"K0": k0, "roughness_m": None, "fittings": [], "K1": 0.0, "phi_type": "none"})
        twin_man = [r[5] for r in rows]
        today = [design_manifold(r[0], fs) for r in rows]
        fitted = [design_manifold(r[0], fitted_cfg) for r in rows]
        mean = lambda v: sum(v) / len(v)  # noqa: E731
        rms = lambda a, b: (sum((x - y) ** 2 for x, y in zip(a, b)) / len(a)) ** 0.5  # noqa: E731
        sides[cside] = {
            "label": label,
            "mdot_kg_s": m_mean,
            "velocity_head_psi": q_mean,
            "lockup_psia": lockup,
            "tank_firing_psia": mean([r[3] for r in rows]),
            "supply_deficit_psi": deficit,
            "supply_deficit_worst_psi": max(r[2] - r[3] for r in rows),
            "line_loss_psi": mean([r[3] - r[4] for r in rows]),
            "line_loss_design_psi": mean([delta_p_feed(r[0], rho, fs.model_copy(update={"K_exit": 0.0}), lockup * PSI, mu=mu) / PSI
                                          for r in rows]),
            "manifold_psia": mean(twin_man),
            "manifold_design_psia": mean(today),
            "manifold_gap_psi": mean(twin_man) - mean(today),
            "manifold_fitted_psia": mean(fitted),
            "fitted_rms_psi": rms(twin_man, fitted),
            "K_line": k_line,
            "K_supply": k_supply,
            "K0": k0,
            "K0_design": float(fs.K0),
            "design_path": ("friction (roughness_m) + fittings" if getattr(fs, "roughness_m", None) is not None
                            else "K0" + (" + fittings" if getattr(fs, "fittings", None) else "")),
        }
    return {
        "available": True,
        "flown": flown,
        "basis": (("In flight: every liquid column at the flight's acceleration. " if flown else "On the pad, one g. ")
                  + f"Settled firing steps ({len(idx)}, from {SETTLED_S:g} s after Fire, last step left out), "
                    "against the design's velocity head (its density, its A_hydraulic). Fit again after the "
                    "injector is resized: the supply term is exact only at the flow it was fitted at."),
        "sides": sides,
        "drawing": {"id": prep.drawing.id, "name": prep.drawing.name, "sha256": prep.drawing.sha256},
    }


def design_update(fit: Dict[str, Any], run_id: str, when: Optional[float] = None) -> Dict[str, Any]:
    """The ``feed_system`` update that writes the fit into the design: K0 per side on the lumped
    path (the method ladder's "measured K", here fitted from the drawing), with its record."""
    stamp = time.strftime("%Y-%m-%d", time.localtime(when or time.time()))
    out: Dict[str, Any] = {}
    for cside, s in fit["sides"].items():
        out[cside] = {
            "K0": round(s["K0"], 4),
            # The supply's part of K0, kept apart so the chug loop does not read the regulator's
            # droop as line resistance (config FeedSystemConfig.supply_K).
            "supply_K": round(max(s["K_supply"], 0.0), 4),
            "K1": 0.0,
            "phi_type": "none",
            "roughness_m": None,
            "fittings": [],
            "derived_from": {
                "by": "Layer X feed fit",
                "drawing": fit["drawing"]["name"],
                "drawing_sha256": fit["drawing"]["sha256"],
                "run": run_id,
                "date": stamp,
                "condition": "in flight" if fit.get("flown") else "on the pad",
                "K_line": round(s["K_line"], 4),
                "K_supply": round(s["K_supply"], 4),
                "supply_deficit_psi": round(s["supply_deficit_psi"], 2),
                "mdot_kg_s": round(s["mdot_kg_s"], 4),
                "lockup_psia": round(s["lockup_psia"], 2),
                "replaced_K0": s["K0_design"],
                "replaced_path": s["design_path"],
            },
        }
    return {"feed_system": out}


def summary_rows(fit: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Flat rows for a report."""
    return [{"side": s["label"], **{k: v for k, v in s.items() if k != "label"}} for s in fit.get("sides", {}).values()]
