"""Layer X outflow: when each tank outlet starts drawing pressurant (the surface dip), and what is
left in the tank then.

``outflow_from_run(prep, result, settings=OutflowSettings(), accel=None)`` -> ``diagnostics.outflow``
(a list, one row per propellant tank; DATA-CONTRACT 3).

The twin burns each tank to its dry mass (1 g, ``LayerXSettings.dry_kg``): its outlet never draws
gas. A real outlet does, once the liquid over it is shallow enough that the flow converging on the
outlet pulls the surface down into it.

The model: Lubin & Springer (1967)
----------------------------------
B. T. Lubin and G. S. Springer, "The formation of a dip on the surface of a liquid draining from a
tank", J. Fluid Mech. 29(2), 385-390, 1967. With no swirl, a dip forms over a bottom outlet, and
gas is drawn into it, when the liquid height over the outlet falls to

    h_c = 0.69 (Q^2 / g')^(1/5),        g' = g (1 - rho_gas / rho_liquid)

``Q`` the volumetric outflow and ``g`` the specific force along the tank axis. Independent of the
outlet diameter and of the initial height. The constant and the form ``0.69 (Q^2/g)^(1/5)`` are as
restated by M. Wollen and C. Ostoich, "Design of a low gravity vane liquid acquisition device for
cryogenic liquids ...", TFAWS 2024, paper TFAWS24-CR-1 ("Classic analytical result by Lubin and
Springer"; checked against the slides). The buoyancy factor ``1 - rho_gas/rho_liquid`` on ``g`` is
this module's (the restatement has none; the paper's own text was not available to check): it is
the reduced gravity of a gas-over-liquid surface, and on LE4 (helium at ~600 psia over LOX) it moves
``h_c`` by under 0.2 %. The constant is also what the point-sink analysis behind it gives: with the
surface over a hemispherical sink of velocity
``Q/(2 pi z^2)``, Bernoulli gives ``h = z + Q^2/(8 pi^2 g' z^4)``, which has no solution for ``h``
below its minimum ``h_c = 1.25 (Q^2/(2 pi^2 g'))^(1/5) = 0.688 (Q^2/g')^(1/5)``
(``point_sink_constant``; tested). **The constant 0.574 quoted in docs/layer-x.md could not be
verified against the paper and is not used**; it would put the dip 17 % lower.

What the run has to supply, and does not have
---------------------------------------------
* **Outlet diameter**: the drawing's line leaving the tank (its bore is the outlet).
  It does not enter ``h_c``; it sets the outlet Froude number and the check that ``h_c`` is large
  against the outlet (the sink approximation).
* **Tank diameter**: the drawing's (estimated, "not measured").
* **Bottom head shape**: not drawn. ``flat`` (default) puts the most liquid under ``h_c`` and is the
  upper bound on the residual; ``hemispherical`` the least; ``ellipsoidal_2to1`` between. The row
  carries all three.
* **Swirl** raises the onset height (a vortex instead of a dip). Not modelled.

The residual at onset is an upper bound on the unusable propellant: past the onset the outlet draws
gas with the liquid rather than stopping at once.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from engine.layerx.diag.start import G0, PSI, SIDES, finite, inp, model_block, param_provenance, unavailable

MODEL_NAME = "lubin_springer_dip"
LS_CONSTANT = 0.69
LS_SOURCE = ("Lubin & Springer, 'The formation of a dip on the surface of a liquid draining from a tank', "
             "J. Fluid Mech. 29(2) 385-390 (1967): h_c = 0.69 (Q^2/g)^(1/5), no swirl, as restated by Wollen & "
             "Ostoich (TFAWS 2024, TFAWS24-CR-1) and as the point-sink analysis gives it (0.688); g reduced by "
             "the buoyancy factor (1 - rho_g/rho_l) here (not from the restatement; < 0.2 % on h_c for LE4)")
HEADS = {"flat": 0.0, "ellipsoidal_2to1": 0.5, "hemispherical": 1.0}
"""Bottom head depth over the tank radius."""


# ------------------------------------------------------------------ the correlation and the tank


def point_sink_constant() -> float:
    """1.25 (2 pi^2)^(-1/5): the minimum of ``h(z) = z + Q^2/(8 pi^2 g z^4)`` over ``(Q^2/g)^(1/5)``."""
    return 1.25 * (2.0 * math.pi ** 2) ** -0.2


def critical_height(Q: float, accel: float, rho_liquid: float, rho_gas: float = 0.0,
                    constant: float = LS_CONSTANT) -> float:
    """Lubin & Springer's dip height [m] for a volumetric outflow ``Q`` [m^3/s] at specific force
    ``accel`` [m/s^2]."""
    g_eff = accel * (1.0 - rho_gas / rho_liquid)
    if Q <= 0.0 or g_eff <= 0.0:
        return 0.0 if Q <= 0.0 else math.inf
    return constant * (Q * Q / g_eff) ** 0.2


def volume_below(h: float, radius: float, head_depth: float) -> float:
    """Liquid volume [m^3] up to height ``h`` over the outlet in a vertical cylinder of ``radius``
    with a semi-ellipsoidal bottom head of depth ``head_depth`` (0 = flat, radius = hemisphere).
    In the head, the cross-section at height y is ``pi R^2 (2 b y - y^2)/b^2``."""
    if h <= 0.0:
        return 0.0
    R, b = radius, head_depth
    if b <= 0.0:
        return math.pi * R * R * h
    if h <= b:
        return math.pi * R * R / (b * b) * (b * h * h - h ** 3 / 3.0)
    return (2.0 / 3.0) * math.pi * R * R * b + math.pi * R * R * (h - b)


def liquid_height(V: float, radius: float, head_depth: float) -> float:
    """Inverse of :func:`volume_below` (bisection: monotone)."""
    if V <= 0.0:
        return 0.0
    lo, hi = 0.0, max(head_depth, 0.0) + V / (math.pi * radius * radius) + 1e-9
    while volume_below(hi, radius, head_depth) < V:
        hi *= 2.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if volume_below(mid, radius, head_depth) < V:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-12:
            break
    return 0.5 * (lo + hi)


def onset(t: Sequence[float], liquid_kg: Sequence[float], mdot: Sequence[float], accel: Sequence[float], *,
          rho_liquid: Sequence[float], rho_gas: Sequence[float], radius: float, head_depth: float,
          constant: float = LS_CONSTANT) -> Dict[str, Any]:
    """First instant the liquid height falls to the dip height, interpolated between steps.
    Inputs are per step over the firing steps (mdot > 0)."""
    margin_prev = None
    rows: List[Tuple[float, float, float, float]] = []
    for k in range(len(t)):
        rl = rho_liquid[k]
        h = liquid_height(liquid_kg[k] / rl, radius, head_depth)
        hc = critical_height(mdot[k] / rl, accel[k], rl, rho_gas[k], constant)
        rows.append((t[k], h, hc, liquid_kg[k]))
        margin = h - hc
        if margin <= 0.0:
            if margin_prev is None:
                return {"t": t[k], "residual_kg": liquid_kg[k], "h_c": hc, "h": h, "index": k, "rows": rows}
            f = margin_prev / (margin_prev - margin)
            t_on = t[k - 1] + f * (t[k] - t[k - 1])
            m_on = liquid_kg[k - 1] + f * (liquid_kg[k] - liquid_kg[k - 1])
            hc_on = rows[k - 1][2] + f * (hc - rows[k - 1][2])
            return {"t": t_on, "residual_kg": m_on, "h_c": hc_on, "h": hc_on, "index": k, "rows": rows}
        margin_prev = margin
    return {"t": None, "residual_kg": None, "h_c": rows[-1][2] if rows else None,
            "h": rows[-1][1] if rows else None, "index": None, "rows": rows}


# ------------------------------------------------------------------ from a run


@dataclass(frozen=True)
class OutflowSettings:
    outlet_d_mm: Tuple[Optional[float], Optional[float]] = (None, None)
    """(LOX, fuel) outlet bore [mm]. None = the first drawn line's bore (assumed)."""
    head: str = "flat"
    """Bottom head shape for the reported residual: flat | ellipsoidal_2to1 | hemispherical."""
    constant: float = LS_CONSTANT


def _schedule_accel(result: Mapping[str, Any], accel: Optional[Mapping[str, Any]]) -> Tuple[Optional[Mapping[str, Any]], str]:
    if accel is not None:
        return accel, "given acceleration schedule"
    flight = result.get("flight") or {}
    sch = flight.get("schedule") if isinstance(flight, Mapping) else None
    if isinstance(sch, Mapping) and sch.get("t") and sch.get("accel_m_s2"):
        return sch, "the flight's acceleration (result.flight.schedule)"
    return None, "standard gravity (on the pad)"


def outflow_from_run(prep: Any, result: Mapping[str, Any], settings: OutflowSettings = OutflowSettings(),
                     accel: Optional[Mapping[str, Any]] = None) -> List[Dict[str, Any]]:
    """``diagnostics.outflow`` rows. Never raises."""
    rows: List[Dict[str, Any]] = []
    for (side, key), d_mm in zip(SIDES, settings.outlet_d_mm):
        try:
            rows.append(_row(prep, result, side, key, d_mm, settings, accel))
        except Exception as exc:  # noqa: BLE001
            rows.append({"tank": (getattr(prep, "roles", {}) or {}).get(side), "side": key,
                         **unavailable(f"outflow: {exc}")})
    return rows


def _row(prep: Any, result: Mapping[str, Any], side: str, key: str, d_mm: Optional[float],
         settings: OutflowSettings, accel: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    from feedtwin.props.fluid import Fluid

    from engine.layerx.diag.start import feed_path

    if settings.head not in HEADS:
        raise ValueError(f"unknown head shape {settings.head!r}; one of {', '.join(HEADS)}")
    series = result["series"]
    sub = series[key]
    tank = prep.roles[side]
    node = prep.model.diagram.node(tank)
    dparam = node.params.get("diameter")
    if dparam is None:
        raise ValueError(f"{tank} has no drawn diameter")
    D_tank = float(dparam.si)
    R = D_tank / 2.0
    # Outlet bore: the first drawn line out of the tank.
    net = prep.model.built.network
    path = feed_path(net, prep.inlet_nodes[side], tank)
    first = net.branches[path[0]].component if path else None
    bore_line = float((getattr(first, "p", {}) or {}).get("bore", 0.0) or 0.0) if first is not None else 0.0
    if d_mm is None:
        d_out = bore_line
        d_prov = f"drawing: the bore of the line leaving the tank ({path[0] if path else '?'})"
    else:
        d_out = float(d_mm) * 1e-3
        d_prov = "setting"
    species = (prep.derived.get("species") or {}).get(side)
    gas = prep.derived.get("pressurant_gas")
    gas_prov = f"feedtwin Fluid('{gas}') at the tank pressure and ullage temperature"
    if not gas:
        gas = "nitrogen"
        gas_prov = "assumed nitrogen: the run names no pressurant gas (it enters only the buoyancy factor)"
    fl, fg = Fluid(species), Fluid(gas)
    idx = [i for i, f in enumerate(series.get("firing") or []) if f]
    if not idx:
        raise ValueError("the burn never fired")
    t = [float(series["t"][i]) for i in idx]
    liq = [float(sub["liquid_kg"][i]) for i in idx]
    md = [float(sub["mdot"][i]) for i in idx]
    p = [float(sub["tank_psia"][i]) * PSI for i in idx]
    TL = [float(sub["liquid_K"][i]) for i in idx]
    TU = [float(sub["ullage_K"][i]) for i in idx]
    rho_l = [fl.get("rho", p=pi, T=ti) for pi, ti in zip(p, TL)]
    rho_g = [fg.get("rho", p=pi, T=ti) for pi, ti in zip(p, TU)]
    sch, accel_basis = _schedule_accel(result, accel)
    if sch is not None:
        a = [float(np.interp(ti, sch["t"], sch["accel_m_s2"])) for ti in t]
    else:
        a = [G0] * len(t)
    by_head: Dict[str, Dict[str, Any]] = {}
    for name, frac in HEADS.items():
        on = onset(t, liq, md, a, rho_liquid=rho_l, rho_gas=rho_g, radius=R, head_depth=frac * R,
                   constant=settings.constant)
        by_head[name] = on
    main = by_head[settings.head]
    load = finite((result.get("summary") or {}).get(key, {}).get("loaded_kg")) or liq[0]
    # The impulse the burn credits after the onset: flow past it rests on gas-free outflow.
    deliv = result.get("delivered") or {}
    at_risk = None
    if main["t"] is not None and deliv.get("t") and deliv.get("thrust_N"):
        dt_ = [float(x) for x in deliv["t"]]
        F = [float(x) for x in deliv["thrust_N"]]
        at_risk = 0.0
        for k in range(1, len(dt_)):
            lo, hi = max(dt_[k - 1], main["t"]), dt_[k]
            if hi > lo:
                f0 = float(np.interp(lo, dt_, F))
                at_risk += 0.5 * (f0 + F[k]) * (hi - lo)
    k_on = main["index"]
    i_ref = k_on if k_on is not None else len(t) - 1
    Q_ref = md[i_ref] / rho_l[i_ref]
    v_out = Q_ref / (math.pi * d_out ** 2 / 4.0) if d_out > 0 else None
    fr = v_out / math.sqrt(a[i_ref] * d_out) if (v_out and d_out > 0) else None
    hc = main["h_c"]
    warnings: List[str] = []
    if hc is not None and d_out > 0 and hc < 2.0 * d_out:
        warnings.append(f"h_c {1e3 * hc:.1f} mm is under two outlet diameters: the point-sink picture behind the "
                        "correlation is stretched")
    inputs = {
        "tank_diameter": inp(D_tank, "m", param_provenance(dparam, "flagged: estimated, not measured")),
        "outlet_d": inp(d_out, "m", d_prov),
        "head": inp(settings.head, "-", "assumed flat: the head shape is not drawn; flat puts the most liquid under "
                    "h_c (upper bound on the residual)"),
        "constant": inp(settings.constant, "-", LS_SOURCE),
        "rho_liquid": inp(rho_l[i_ref], "kg/m^3", f"feedtwin Fluid('{species}') at the tank state"),
        "rho_gas": inp(rho_g[i_ref], "kg/m^3", gas_prov),
        "accel": inp(a[i_ref], "m/s^2", accel_basis),
    }
    model = model_block(
        MODEL_NAME, LS_SOURCE,
        [
            "no swirl: a dip, not a vortex (a vortex forms higher)",
            "bottom-centre outlet; h measured from the outlet plane",
            "the tank is a vertical cylinder of the drawn diameter with the stated bottom head",
            "the residual at onset is an upper bound on what the outlet cannot deliver gas-free",
            "the specific force is standard gravity on the pad, or the flight's acceleration when flown",
            "g is reduced by the buoyancy factor (1 - rho_gas/rho_liquid): this module's, not the restatement's",
            "0.574 (docs/layer-x.md) could not be verified and is not used",
        ],
        inputs)
    return {
        "tank": tank, "side": key, "available": True,
        "ingestion_onset_s": main["t"],
        "residual_kg": main["residual_kg"],
        "residual_frac": (main["residual_kg"] / load) if (main["residual_kg"] is not None and load) else None,
        "residual_band_kg": {name: on["residual_kg"] for name, on in by_head.items()},
        "onset_band_s": {name: on["t"] for name, on in by_head.items()},
        "h_c_mm": 1e3 * hc if hc is not None else None,
        "level_end_mm": 1e3 * liquid_height(liq[-1] / rho_l[-1], R, HEADS[settings.head] * R),
        "outlet_d_mm": 1e3 * d_out,
        "outlet_froude": fr,
        "impulse_at_risk_Ns": at_risk,
        "head": settings.head,
        "warnings": warnings,
        "unmeasured": ["outlet bore", "tank bottom head shape", "tank diameter (estimated)", "swirl at the outlet",
                       "a weighed residual from a cold flow to depletion would replace all of these"],
        "model": model,
    }

