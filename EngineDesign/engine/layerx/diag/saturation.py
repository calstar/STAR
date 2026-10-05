"""Saturation margin at every liquid node, and cavitation at the injector orifices.

``build_saturation(result, prep=None, config=None, ...)`` -> ``diagnostics.saturation``;
``build_cavitation(result, prep=None, config, ...)`` -> ``diagnostics.cavitation``
(DATA-CONTRACT 3).

**Saturation.** At each liquid node of the recorded network, per twin step,
``margin = p_node - P_sat(T_node)`` with ``P_sat`` CoolProp's (oxygen on the LOX side, ethanol on the
fuel side; the node's own fluid where the prepared model knows it). Node pressures are total
pressures in the twin's lumped-K convention (AUDIT 9.6 B4), so where the drawing gives the bores
of the branches at a node the static margin is reported too: the total less the largest dynamic
head ``mdot^2 / (2 rho A^2)`` of the flowing branches at that node, at the saturated-liquid
density (the twin's own liquid basis). The minimum and its time are taken over the firing steps:
before Fire the lines downstream of the shut mains are held at 101.325 kPa by the twin (they would
be gas-filled on the stand; AUDIT 9.5 4), which is not a margin anyone has. ``ENG.chamber`` is not a
liquid node and is never included.

**Cavitation.** Nurick (1976), "Orifice Cavitation and Its Effect on Spray Mixing", J. Fluids
Eng. 98(4): once the static pressure at the vena contracta reaches the vapour pressure, a sharp
orifice's flow follows ``Cd = Cc sqrt(K)`` with ``K = (p_up - p_v) / (p_up - p_c)``, so it cavitates
below ``K_crit = (Cd / Cc)^2``; ``Cc = (1/Cc0^2 - 11.4 r/d)^-1/2``. This module does not restate
that: it calls EngineDesign's own implementation, ``engine.core.discharge.cavitation_margin`` (the
same ``Cc0`` and r/d law the Forward report uses), per step, with ``p_up`` the manifold pressure
(``series.*.manifold_psia``), ``p_c`` the chamber's, ``p_v`` CoolProp's at the line-exit liquid
temperature, and ``Cd`` the orifices' effective Cd that step,
``mdot / (n A_jet sqrt(2 rho dp_inj))`` at the config density (the card's injector basis).
``K_incipient`` in the contract is that ``K_crit``: below it the vena contracta is at vapour
pressure in Nurick's model. Bubbles can appear somewhat above it; no allowance is added.

**Hydraulic flip.** A flip needs a cavitating orifice (K below K_crit) whose separated region
reaches the exit before the flow reattaches, which a long bore prevents. The L/d below which that
happens is taken as an explicit input, ``flip_l_over_d_max``, default 5.0 *assumed* (the repo's
injector plan, ``docs/injector_face_and_manifold_plan.md``: "L/d >= 5 preferred for a sharp
entry"); the value Nurick reports was not verified for this module and is not cited. ``flip_risk``
is true when an orifice cavitates on any firing step and its L/d is at or under that threshold.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Mapping, Optional

import numpy as np

from engine.layerx.diag.ladder import (
    PSI, SIDE_CONFIG, SIDE_ROLE, SIDES, arr, firing_mask, inp, model_block, node_T, out, scalar, series_t,
    unavailable,
)
from engine.layerx.diag.regulator import _built, coolprop_name

NURICK_SOURCE = ("Nurick, W. H. (1976), 'Orifice Cavitation and Its Effect on Spray Mixing', J. Fluids Eng. "
                 "98(4), 681-687: Cd = Cc sqrt(K), K = (p_up - p_v)/(p_up - p_c), cavitating below "
                 "K_crit = (Cd/Cc)^2; Cc = (1/Cc0^2 - 11.4 r/d)^-1/2 -- as implemented in "
                 "engine.core.discharge.cavitation_margin")

DEFAULT_FLAG_MARGIN_PSI = 25.0
"""Saturation margin under which a liquid node is flagged [psi]. Assumed: about one LOX-line
dynamic head at full flow (25.0 psi, AUDIT 9.6 B4), room for the transients the twin does not
resolve (valve opening, line acoustics); no source."""

DEFAULT_CAVITATION_MARGIN = 0.2
"""K / K_crit under 1 + this is flagged as near cavitation. Assumed: K_crit is a model value
(Nurick's onset for the vena contracta at vapour pressure) and incipient cavitation appears above
it; no source."""

DEFAULT_FLIP_LD_MAX = 5.0
"""L/d at or under which a cavitating sharp-entry orifice is counted at flip risk. Assumed from the
repo's injector plan ('L/d >= 5 preferred for a sharp entry'); set it from Nurick (1976) or a cold
flow."""


def saturation_pressure(fluid: str, T_K: float) -> float:
    """P_sat(T) [Pa] by CoolProp; NaN above the critical point or out of range."""
    import CoolProp.CoolProp as CP

    try:
        return float(CP.PropsSI("P", "T", T_K, "Q", 0, coolprop_name(fluid)))
    except Exception:  # noqa: BLE001
        return math.nan


def saturated_liquid_density(fluid: str, T_K: float) -> float:
    import CoolProp.CoolProp as CP

    try:
        return float(CP.PropsSI("D", "T", T_K, "Q", 0, coolprop_name(fluid)))
    except Exception:  # noqa: BLE001
        return math.nan


def _derived(prep: Any, result: Mapping[str, Any]) -> Mapping[str, Any]:
    d = getattr(prep, "derived", None) if prep is not None else None
    return d or ((result.get("provenance") or {}).get("derived")) or {}


def side_fluid(prep: Any, result: Mapping[str, Any], side: Optional[str]) -> Optional[str]:
    """The propellant on a network side (``ox``/``fuel``), from the drawing's roles."""
    if side not in SIDE_ROLE:
        return None
    return (_derived(prep, result).get("species") or {}).get(SIDE_ROLE[side])


def node_fluid(prep: Any, result: Mapping[str, Any], nid: str, side: Optional[str]) -> Optional[str]:
    built = _built(prep)
    if built is not None:
        try:
            return str(built.network.nodes[nid].fluid)
        except Exception:  # noqa: BLE001
            pass
    return side_fluid(prep, result, side)


def _branch_bore(prep: Any, bid: str) -> Optional[float]:
    built = _built(prep)
    if built is None:
        return None
    try:
        b = built.network.branches[bid].component.p.get("bore")
        return float(b) if b else None
    except Exception:  # noqa: BLE001
        return None


def build_saturation(result: Mapping[str, Any], prep: Any = None, config: Any = None, *,
                     flag_margin_psi: float = DEFAULT_FLAG_MARGIN_PSI) -> Dict[str, Any]:
    """``diagnostics.saturation``. Never raises."""
    try:
        net = result.get("network")
        if not isinstance(net, Mapping) or not net.get("nodes"):
            return unavailable("no feed network was recorded for this run (result.network)")
        t = series_t(result)
        n = t.size
        series = result.get("series") or {}
        firing = firing_mask(result, n)
        rows: List[Dict[str, Any]] = []
        skipped: List[str] = []
        for nid, nd in net["nodes"].items():
            if nd.get("phase") != "liquid" or nd.get("kind") == "chamber":
                continue
            side = nd.get("side")
            fluid = node_fluid(prep, result, nid, side)
            if not fluid:
                skipped.append(f"{nid} (fluid unknown)")
                continue
            p = arr(nd.get("p_psia"), n)
            T = node_T(net, nid, n)
            T_src = "node (twin's enthalpy walk)"
            if not np.isfinite(T).any() and side in SIDES:
                T = arr((series.get(side) or {}).get("liquid_K"), n)
                T_src = f"series.{side}.liquid_K (tank bulk liquid)"
            psat = np.array([saturation_pressure(fluid, x) if math.isfinite(x) else math.nan for x in T]) / PSI
            margin = p - psat
            # Static: subtract the largest velocity head of the flowing branches at this node.
            q = np.zeros(n)
            have_bore = False
            for bid, br in net["branches"].items():
                if nid not in (br.get("from"), br.get("to")) or br.get("kind") == "injector":
                    # the engine leg's "bore" is the orifices' total area: their velocity head belongs
                    # to the cavitation block, not to the line-exit node's static pressure
                    continue
                bore = _branch_bore(prep, bid)
                if not bore:
                    continue
                have_bore = True
                mdot = np.abs(np.nan_to_num(arr(br.get("mdot"), n)))
                rho = np.array([saturated_liquid_density(fluid, x) if math.isfinite(x) else math.nan for x in T])
                area = math.pi * bore * bore / 4.0
                with np.errstate(divide="ignore", invalid="ignore"):
                    qb = np.where(rho > 0, mdot * mdot / (2.0 * rho * area * area), 0.0) / PSI
                q = np.maximum(q, np.nan_to_num(qb))
            static = margin - q if have_bore else np.full(n, math.nan)
            live = firing & np.isfinite(margin)
            k_min = int(np.flatnonzero(live)[np.nanargmin(margin[live])]) if live.any() else None
            live_s = firing & np.isfinite(static)
            ks_min = int(np.flatnonzero(live_s)[np.nanargmin(static[live_s])]) if live_s.any() else None
            worst = static[ks_min] if ks_min is not None else (margin[k_min] if k_min is not None else math.nan)
            rows.append({
                "id": nid, "label": nd.get("label") or nid, "side": side, "fluid": fluid,
                "T_source": T_src,
                "margin_psi": out(margin), "margin_static_psi": out(static),
                "min_psi": scalar(margin[k_min]) if k_min is not None else None,
                "t_min": scalar(t[k_min]) if k_min is not None else None,
                "min_static_psi": scalar(static[ks_min]) if ks_min is not None else None,
                "t_min_static": scalar(t[ks_min]) if ks_min is not None else None,
                "flagged": bool(math.isfinite(worst) and worst < flag_margin_psi),
            })
        if not rows:
            return unavailable("no liquid node with a known fluid in result.network")
        worst_row = min((r for r in rows if r["min_psi"] is not None), default=None,
                        key=lambda r: r["min_static_psi"] if r["min_static_psi"] is not None else r["min_psi"])
        return {
            "nodes": rows,
            "worst": ({"id": worst_row["id"], "min_psi": worst_row["min_psi"],
                       "min_static_psi": worst_row["min_static_psi"],
                       "t_min": (worst_row["t_min_static"] if worst_row["t_min_static"] is not None
                                 else worst_row["t_min"])} if worst_row else None),
            "flag_margin_psi": flag_margin_psi,
            "skipped": skipped,
            "model": model_block(
                "saturation margin p - P_sat(T) at the liquid nodes",
                "CoolProp saturation curves (oxygen, ethanol); the twin's node pressures and walked temperatures",
                [
                    "node pressures are total (lumped K); the static margin subtracts the largest velocity head "
                    "mdot^2/(2 rho A^2) of the node's flowing branches, at the saturated-liquid density",
                    "min and t_min over the firing steps; before Fire the lines past the shut mains are held at "
                    "101.325 kPa by the twin (gas-filled on the stand), so those steps are not graded",
                    "no local accelerations below the line bore (valve throats, orifice vena contracta) -- the "
                    "orifices are graded by the cavitation block instead",
                    "pure anhydrous ethanol (no water fraction, AUDIT D15)",
                ],
                {"flag_margin_psi": inp(flag_margin_psi, "psi",
                                        "assumed: ~one LOX-line dynamic head (AUDIT 9.6 B4); no source")},
            ),
        }
    except Exception as exc:  # noqa: BLE001
        return unavailable(f"{type(exc).__name__}: {exc}")


# ---- the orifices -------------------------------------------------------------------------------

def orifice_geometry(config: Any, side: str) -> Dict[str, Any]:
    """The config's orifices on one network side: n, d_jet, area (all holes), angle, spacing, L/d,
    r/d, config density."""
    key = SIDE_CONFIG[side]
    g = getattr(config.injector.geometry, key)
    n_el = int(getattr(g, "n_elements"))
    d = float(getattr(g, "d_jet"))
    dc = (config.discharge or {}).get(key) if isinstance(config.discharge, Mapping) else None
    from engine.core.discharge import inlet_radius_ratio_of

    return {
        "n": n_el, "d_jet": d, "area": n_el * math.pi * d * d / 4.0,
        "angle_deg": float(getattr(g, "impingement_angle", math.nan)),
        "spacing": float(getattr(g, "spacing", math.nan) or math.nan),
        "l_over_d": float(getattr(dc, "orifice_l_over_d", math.nan) or math.nan) if dc is not None else math.nan,
        "r_over_d": float(inlet_radius_ratio_of(dc)) if dc is not None else 0.0,
        "inlet": getattr(dc, "inlet_geometry", None) if dc is not None else None,
        "rho": float(config.fluids[key].density),
    }


def cd_effective(mdot: np.ndarray, dp_psi: np.ndarray, area: float, rho: float) -> np.ndarray:
    """mdot / (A sqrt(2 rho dp)): the orifices' effective Cd on the twin's flow and orifice drop."""
    dp = dp_psi * PSI
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where((dp > 0) & (mdot > 0), mdot / (area * np.sqrt(2.0 * rho * dp)), np.nan)


def build_cavitation(result: Mapping[str, Any], prep: Any = None, config: Any = None, *,
                     flip_l_over_d_max: float = DEFAULT_FLIP_LD_MAX,
                     near_margin: float = DEFAULT_CAVITATION_MARGIN) -> Dict[str, Any]:
    """``diagnostics.cavitation``. Never raises. Needs ``config`` (the orifices) and the series;
    the network only for the line-exit liquid temperature (else ``series.*.liquid_K``)."""
    try:
        if config is None:
            return unavailable("the engine config is needed for the orifices")
        from engine.core.discharge import cavitation_margin

        series = result.get("series") or {}
        t = series_t(result)
        n = t.size
        firing = firing_mask(result, n)
        pc = arr((series.get("chamber") or {}).get("pc_psia"), n)
        net = result.get("network") if isinstance(result.get("network"), Mapping) else None
        inlets = (_derived(prep, result).get("inlet_nodes") or {})
        block: Dict[str, Any] = {"t": out(t)}
        inputs: Dict[str, Dict[str, Any]] = {}
        for side in SIDES:
            s = series.get(side) or {}
            if s.get("manifold_psia") is None:
                continue
            fluid = side_fluid(prep, result, side) or ("oxygen" if side == "ox" else "ethanol")
            geo = orifice_geometry(config, side)
            p_up = arr(s.get("manifold_psia"), n)
            mdot = arr(s.get("mdot"), n)
            dpi = arr(s.get("dp_injector_psi"), n)
            node = inlets.get(SIDE_ROLE[side])
            T = node_T(net, node, n) if net is not None and node and node in net["nodes"] else np.full(n, math.nan)
            T_src = f"line-exit node {node}" if np.isfinite(T).any() else f"series.{side}.liquid_K"
            if not np.isfinite(T).any():
                T = arr(s.get("liquid_K"), n)
            pv = np.array([saturation_pressure(fluid, x) if math.isfinite(x) else math.nan for x in T])
            cd = cd_effective(mdot, dpi, geo["area"], geo["rho"])
            K = np.full(n, math.nan)
            Kc = np.full(n, math.nan)
            Cc = math.nan
            for k in range(n):
                if not (firing[k] and math.isfinite(cd[k]) and math.isfinite(pv[k])):
                    continue
                m = cavitation_margin(P_in=p_up[k] * PSI, Pc=pc[k] * PSI, Pv=pv[k], Cd=cd[k],
                                      r_over_d=geo["r_over_d"])
                K[k], Kc[k], Cc = m["K"], m["K_crit"], m["Cc"]
            with np.errstate(divide="ignore", invalid="ignore"):
                ratio = K / Kc
            live = np.isfinite(ratio)
            k_min = int(np.flatnonzero(live)[np.nanargmin(ratio[live])]) if live.any() else None
            cavitates = bool(live.any() and np.nanmin(ratio[live]) < 1.0)
            ld = geo["l_over_d"]
            flip = bool(cavitates and math.isfinite(ld) and ld <= flip_l_over_d_max)
            block[side] = {
                "K": out(K), "K_crit": out(Kc), "margin": out(ratio), "Cd_eff": out(cd),
                "p_v_psia": out(pv / PSI),
                "K_incipient": scalar(Kc[k_min]) if k_min is not None else None,
                "Cc": scalar(Cc),
                "L_over_d": scalar(ld), "r_over_d": scalar(geo["r_over_d"]), "inlet": geo["inlet"],
                "flip_risk": flip, "cavitates": cavitates,
                "near": bool(live.any() and np.nanmin(ratio[live]) < 1.0 + near_margin),
                "min_K": scalar(K[k_min]) if k_min is not None else None,
                "min_margin": scalar(ratio[k_min]) if k_min is not None else None,
                "t_min": scalar(t[k_min]) if k_min is not None else None,
                "T_source": T_src,
            }
            key = SIDE_CONFIG[side]
            inputs[f"{side}_L_over_d"] = inp(ld, "-", f"config discharge.{key}.orifice_l_over_d "
                                             f"({getattr((config.discharge or {}).get(key), 'l_over_d_source', '?')})")
            inputs[f"{side}_r_over_d"] = inp(geo["r_over_d"], "-", f"config discharge.{key}.inlet_geometry "
                                             f"'{geo['inlet']}' (engine.core.discharge.INLET_GEOMETRY_RD)")
            inputs[f"{side}_density"] = inp(geo["rho"], "kg/m^3", f"config fluids.{key}.density (card basis)")
            inputs[f"{side}_area"] = inp(geo["area"] * 1e6, "mm^2", f"config injector.geometry.{key} "
                                         f"({geo['n']} x d_jet {geo['d_jet'] * 1e3:.4f} mm)")
        if not any(s in block for s in SIDES):
            return unavailable("series carries no manifold pressure")
        inputs["flip_l_over_d_max"] = inp(flip_l_over_d_max, "-",
                                          "assumed: repo injector plan 'L/d >= 5 preferred for a sharp entry' "
                                          "(docs/injector_face_and_manifold_plan.md); not taken from Nurick 1976")
        inputs["near_margin"] = inp(near_margin, "-", "assumed: no source")
        from engine.core.discharge import NURICK_CC0

        inputs["Cc0"] = inp(NURICK_CC0, "-", "engine.core.discharge.NURICK_CC0 (Nurick 1976 sharp-edge contraction)")
        block["model"] = model_block(
            "orifice cavitation number vs Nurick's critical K, and hydraulic-flip risk",
            NURICK_SOURCE,
            [
                "p_up = manifold pressure (line exit less the Borda dump), p_c = chamber, per twin step",
                "p_v = CoolProp saturation pressure at the line-exit liquid temperature",
                "Cd = the orifices' effective Cd on the twin's flow and orifice drop at the config density",
                "K_incipient = K_crit = (Cd/Cc)^2: the vena contracta at vapour pressure; no allowance for "
                "bubbles appearing above it",
                "flip risk = cavitating on some firing step and L/d <= flip_l_over_d_max",
                "start transient not modelled (both mains open together; no priming), so early steps carry "
                "full-flow pressures",
            ],
            inputs,
        )
        return block
    except Exception as exc:  # noqa: BLE001
        return unavailable(f"{type(exc).__name__}: {exc}")
