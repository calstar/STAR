"""The dome regulator's operating point and the press solenoids' drops, per twin step.

``build_regulator(result, prep, config=None, ...)`` -> ``diagnostics.regulator``;
``build_solenoids(result, prep=None, config=None, ...)`` -> ``diagnostics.solenoids``
(DATA-CONTRACT 3). Both read ``result["network"]`` (node pressures and temperatures, branch flows)
and, for the regulator, the drawing's own regulator parameters from the prepared model.

Two models, each named in its block:

* **The regulator's outlet law is feedtwin's** (``feedtwin.comps.regulator.Regulator``,
  ``outlet_setpoint``): ``p_set + S (p_ref - p_in) - D |m| / m_rated`` with ``p_set = dome + bias``
  and the dome from the control regulator's zero-flow outlet. It is evaluated here on the
  recorded inlet and flow, so the supply-pressure effect (``spe_psi``) and the droop
  (``droop_psi``) are split out of the outlet the twin produced, and ``residual_psi`` (recorded
  outlet minus that law) shows when the regulator was not on it. In feedtwin a flowing regulator
  leaves its law only when its seat's drop exceeds inlet minus target (``Regulator.is_saturated``,
  no band), which puts the outlet *under* the law, so under the law while flowing is **wide open**.
  A tolerance of 0.5 % of the setpoint is allowed before calling it (the size of the band feedtwin's
  ``Regulator.is_choked`` uses between shut and regulating), so solver noise is not read as
  saturation; the recorded residual is there for anything finer.
* **Capacity is IEC 60534-2-1 gas sizing** at the inlet node's state: the mass flow the seat
  passes wide open at this instant's inlet and outlet pressures,
  ``W = N6 Fp Kv Y sqrt(x p1 rho1)``, ``Y = 1 - x / (3 F_gamma x_T)``, ``F_gamma = gamma / 1.40``,
  ``x`` capped at ``F_gamma x_T`` where the flow chokes (IEC 60534-2-1:2011, the compressible-flow
  sizing equations; constants and the choke test from ``fluids.control_valve``). ``rho1`` and
  ``gamma`` (real gas, cp/cv) are CoolProp's at the regulator inlet node. ``use_frac`` is the
  recorded flow over that capacity. Feedtwin's own seat law is incompressible (no Y, no choke;
  AUDIT 9.6 C1), so this is the physics check the twin does not make.

The solenoids' drops are the twin's (the branch's recorded ``dp_psi``), set against the
regulator-outlet-to-tank drop on the same side (``share_of_reg_to_tank``), with the IEC 60534
drop at the recorded flow alongside, and the drop the same flow would cost through a valve of
twice the Cv (the "upgrade the 1.7 Cv solenoids?" question, AUDIT 9.6 D).
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Mapping, Optional, Tuple

import numpy as np
from feedtwin.comps.regulator import SUPPLY_ZERO

from engine.layerx.diag.ladder import (
    PSI, SIDES, arr, inp, model_block, network_of, node_p, node_T, out, scalar, series_t, unavailable,
)

IEC_SOURCE = ("IEC 60534-2-1:2011, Industrial-process control valves - Part 2-1: Flow capacity - Sizing "
              "equations for fluid flow under installed conditions; compressible flow, turbulent, no "
              "attached fittings (Fp = 1): W = N6 Fp Kv Y sqrt(x p1 rho1), Y = 1 - x/(3 F_gamma x_T), "
              "F_gamma = gamma/1.40, choked at x >= F_gamma x_T. Constants (N6, Cv->Kv) and the choke test "
              "from fluids.control_valve.")

DEFAULT_XT = 0.7
"""x_T for a valve with no declared value. The 1092's x_T is unpublished; 0.7 is feedtwin's
``Valve`` default and the value AUDIT 9.6 C3 used (it swept 0.5 as well)."""

MODE_BAND = 0.005
"""Fraction of the setpoint by which the outlet must sit under the law, while flowing, to read as
wide open. A tolerance, assumed: it is the size of the band feedtwin's ``Regulator.is_choked`` puts
between shut and regulating; feedtwin's own saturation test (``is_saturated``) has no band."""

COOLPROP_NAMES = {"helium": "Helium", "nitrogen": "Nitrogen", "oxygen": "Oxygen", "ethanol": "Ethanol",
                  "water": "Water", "argon": "Argon"}


def coolprop_name(fluid: str) -> str:
    return COOLPROP_NAMES.get(str(fluid).strip().lower(), str(fluid))


def gas_state(fluid: str, p_pa: float, T_K: float) -> Tuple[float, float]:
    """(rho [kg/m^3], gamma = cp/cv) from CoolProp; NaNs where CoolProp cannot answer."""
    import CoolProp.CoolProp as CP

    try:
        name = coolprop_name(fluid)
        rho = CP.PropsSI("D", "P", p_pa, "T", T_K, name)
        gamma = CP.PropsSI("CPMASS", "P", p_pa, "T", T_K, name) / CP.PropsSI("CVMASS", "P", p_pa, "T", T_K, name)
        return float(rho), float(gamma)
    except Exception:  # noqa: BLE001 - out of CoolProp's range: no answer, not a crash
        return math.nan, math.nan


# ---- IEC 60534-2-1 ------------------------------------------------------------------------------

def iec_gas_flow(p1_pa: float, p2_pa: float, rho1: float, gamma: float, cv: float,
                 xT: float = DEFAULT_XT) -> Dict[str, Any]:
    """Mass flow [kg/s] a valve of flow coefficient ``cv`` (US Cv) passes wide open from ``p1`` to
    ``p2``, by IEC 60534-2-1 (turbulent, Fp = 1). Returns {mdot, choked, Y, x, x_choke}."""
    from fluids.control_valve import N6, Cv_to_Kv, is_choked_turbulent_g

    if not all(math.isfinite(v) for v in (p1_pa, p2_pa, rho1, gamma, cv, xT)) or p1_pa <= 0 or rho1 <= 0 \
            or cv <= 0 or gamma <= 0:
        return {"mdot": math.nan, "choked": None, "Y": math.nan, "x": math.nan, "x_choke": math.nan}
    x = max(0.0, (p1_pa - p2_pa) / p1_pa)
    f_gamma = gamma / 1.40
    x_choke = f_gamma * xT
    choked = bool(is_choked_turbulent_g(x, f_gamma, xT)) if x > 0 else False
    x_eff = min(x, x_choke)
    Y = 1.0 - x_eff / (3.0 * f_gamma * xT)
    # N6 is for W in kg/h with p1 in kPa.
    w_kg_h = N6 * Cv_to_Kv(cv) * Y * math.sqrt(x_eff * (p1_pa / 1e3) * rho1)
    return {"mdot": w_kg_h / 3600.0, "choked": choked, "Y": Y, "x": x, "x_choke": x_choke}


def iec_gas_drop(mdot: float, p1_pa: float, rho1: float, gamma: float, cv: float,
                 xT: float = DEFAULT_XT) -> float:
    """Pressure drop [Pa] that passes ``mdot`` [kg/s] through a valve of ``cv`` by IEC 60534-2-1,
    the inverse of :func:`iec_gas_flow`. NaN when the flow exceeds the choked capacity."""
    if not (math.isfinite(mdot) and mdot >= 0.0):
        return math.nan
    if mdot == 0.0:
        return 0.0
    full = iec_gas_flow(p1_pa, 0.0, rho1, gamma, cv, xT)
    if not math.isfinite(full["mdot"]) or mdot > full["mdot"]:
        return math.nan
    from scipy.optimize import brentq

    x_hi = full["x_choke"]
    p2_hi = p1_pa * (1.0 - x_hi)
    f = lambda p2: iec_gas_flow(p1_pa, p2, rho1, gamma, cv, xT)["mdot"] - mdot  # noqa: E731
    if f(p2_hi) < 0.0:
        return math.nan
    p2 = brentq(f, p2_hi, p1_pa, xtol=1e-10 * p1_pa, rtol=4 * np.finfo(float).eps)
    return float(p1_pa - p2)


# ---- drawing parameters -------------------------------------------------------------------------

def _provenance(component: Any, name: str) -> str:
    """'<source>: <reference>' for one of a component's declared parameters."""
    try:
        prm = component.instance.params.get(name)
    except Exception:  # noqa: BLE001
        prm = None
    if prm is None:
        return "not on the drawing (library default)"
    src = getattr(prm, "source", None)
    src = getattr(src, "value", src)
    ref = getattr(prm, "reference", "") or ""
    return f"{src}: {ref}" if ref else str(src)


def _built(prep: Any) -> Any:
    return getattr(getattr(prep, "model", None), "built", None)


def regulator_id(net: Mapping[str, Any]) -> Optional[str]:
    """The regulator both feed paths pass through (the dome regulator), else the first one."""
    regs = [b for b, br in net["branches"].items() if br.get("kind") == "regulator"]
    paths = net.get("paths") or {}
    shared = [b for b in regs if all(b in (paths.get(s) or []) for s in SIDES if paths.get(s))]
    return (shared or regs or [None])[0]


def regulator_params(prep: Any, reg_id: str) -> Dict[str, Tuple[float, str]]:
    """{name: (SI value, provenance)} of the regulator branch's component on the prepared model,
    plus ``dome`` (the control regulator's loading at the dial) and the loader's own law."""
    built = _built(prep)
    if built is None:
        raise ValueError("the prepared model is needed for the regulator's drawing parameters")
    comp = built.network.branches[reg_id].component
    params: Dict[str, Tuple[float, str]] = {}
    for name in ("Cv", "bore", "supply_coefficient", "flow_droop", "rated_flow",
                 "dome_bias", "dome_pressure", "setpoint", "min_inlet_differential", "xT"):
        if name in comp.p:
            params[name] = (float(comp.p[name]), _provenance(comp, name))
    from feedtwin.session.gauge import from_psig

    setup = getattr(prep, "setup", None)
    dome_psig = getattr(setup, "dome_psi", None)
    if dome_psig is None:
        dome_psig = (getattr(prep, "derived", {}) or {}).get("dome_psig")
    loader = next((ld for ld in getattr(built, "dome_loaders", {}).values()
                   if str(getattr(ld, "signal", "")).startswith(f"{comp.id}.")), None)
    if dome_psig is not None:
        params["dial"] = (float(from_psig(float(dome_psig))),
                          "Layer X: the control-regulator dial solved for the target lockup (prepare.dome_for_lockup)")
    if loader is not None:
        lc = loader.component
        params["loader_bias"] = (float(lc.p.get("dome_bias", 0.0)), _provenance(lc, "dome_bias"))
        params["loader_supply_coefficient"] = (float(lc.p.get("supply_coefficient", 0.0)),
                                               _provenance(lc, "supply_coefficient"))
        params["_loader_supply_node"] = (math.nan, str(loader.supply_node))
        params["_loader_id"] = (math.nan, str(loader.id))
    return params


def _pressurant(prep: Any, net: Mapping[str, Any], node: str) -> str:
    built = _built(prep)
    if built is not None:
        try:
            return str(built.network.nodes[node].fluid)
        except Exception:  # noqa: BLE001
            pass
    gas = (getattr(prep, "derived", {}) or {}).get("pressurant_gas") if prep is not None else None
    if gas:
        return str(gas)
    raise ValueError("the pressurant species is unknown (no prepared model)")


# ---- the regulator ------------------------------------------------------------------------------

def build_regulator(result: Mapping[str, Any], prep: Any = None, config: Any = None, *,
                    reg_id: Optional[str] = None, xT: Optional[float] = None,
                    params: Optional[Mapping[str, Tuple[float, str]]] = None,
                    gas: Optional[str] = None) -> Dict[str, Any]:
    """``diagnostics.regulator``. Never raises.

    ``params`` ({name: (SI value, provenance)}, the names of :func:`regulator_params`) and ``gas``
    stand in for ``prep`` (tests, or a saved run re-read without its model). ``xT`` overrides the
    drawing's / :data:`DEFAULT_XT`.
    """
    try:
        net = network_of(result)
        t = series_t(result)
        n = t.size
        rid = reg_id or regulator_id(net)
        if rid is None:
            return unavailable("no regulator on the recorded network")
        br = net["branches"][rid]
        prm = dict(params) if params is not None else regulator_params(prep, rid)
        fluid = gas or _pressurant(prep, net, br["from"])
        p_in = node_p(net, br["from"], n) * PSI
        p_out = node_p(net, br["to"], n) * PSI
        T_in = node_T(net, br["from"], n)
        mdot = arr(br.get("mdot"), n)

        def val(name: str, default: float = 0.0) -> float:
            return float(prm[name][0]) if name in prm else default

        cv = val("Cv", float(br.get("cv") or math.nan))
        x_t = float(xT) if xT is not None else val("xT", DEFAULT_XT)
        x_t_prov = ("restated for this diagnostic" if xT is not None else
                    prm["xT"][1] if "xT" in prm else
                    "assumed: the regulator's x_T is not published or drawn; 0.7 is feedtwin's Valve default "
                    "and AUDIT 9.6 C3's value")

        # Dome: the control regulator's zero-flow outlet at its supply, as the session loads it.
        if "dial" in prm:
            dome = np.full(n, val("dial")) + val("loader_bias")
            s_l = val("loader_supply_coefficient")
            supply_node = prm.get("_loader_supply_node", (0, ""))[1]
            if s_l and supply_node:
                dome = dome + s_l * (SUPPLY_ZERO - node_p(net, supply_node, n) * PSI)
            dome_basis = prm["dial"][1]
        elif "dome_pressure" in prm and val("dome_pressure") > 0:
            dome = np.full(n, val("dome_pressure"))
            dome_basis = prm["dome_pressure"][1]
        else:
            dome = np.full(n, math.nan)
            dome_basis = "no dome: a hand-loaded setpoint"
        bias = val("dome_bias")
        p_set = np.where(np.isfinite(dome), dome + bias, val("setpoint", math.nan))
        S = val("supply_coefficient")
        spe = S * (SUPPLY_ZERO - p_in)
        D, rated = val("flow_droop"), val("rated_flow")
        droop = D * np.abs(mdot) / rated if rated > 0 else np.zeros(n)
        target = p_set + spe - droop
        residual = p_out - target
        flowing = np.nan_to_num(mdot) > 1e-9
        wide_open = flowing & (residual < -MODE_BAND * p_set)

        cap = np.full(n, math.nan)
        choked: List[Optional[bool]] = []
        x_series = np.full(n, math.nan)
        rho_in = np.full(n, math.nan)
        for k in range(n):
            rho, gamma = gas_state(fluid, p_in[k], T_in[k]) if math.isfinite(p_in[k] + T_in[k]) else (math.nan, math.nan)
            rho_in[k] = rho
            r = iec_gas_flow(p_in[k], p_out[k], rho, gamma, cv, x_t)
            cap[k] = r["mdot"]
            x_series[k] = r["x"]
            choked.append(r["choked"])
        with np.errstate(divide="ignore", invalid="ignore"):
            use = np.where(cap > 0, np.abs(mdot) / cap, np.nan)

        # Rise of the outlet over the burn split into its two drawn causes.
        firing = np.asarray([bool(x) for x in (result.get("series") or {}).get("firing") or [False] * n])
        idx = np.flatnonzero(firing & flowing)
        split = None
        if idx.size >= 2:
            a, b = idx[0], idx[-1]
            split = {"t0": scalar(t[a]), "t1": scalar(t[b]),
                     "outlet_rise_psi": scalar((p_out[b] - p_out[a]) / PSI),
                     "spe_psi": scalar((spe[b] - spe[a]) / PSI),
                     "droop_psi": scalar(-(droop[b] - droop[a]) / PSI),
                     "dome_psi": scalar((dome[b] - dome[a]) / PSI) if np.isfinite(dome[[a, b]]).all() else None,
                     "residual_psi": scalar(((p_out[b] - p_out[a]) - (target[b] - target[a])) / PSI)}

        def pv(name: str, unit: str, scale: float = 1.0) -> Dict[str, Any]:
            v, prov = prm.get(name, (math.nan, "not on the drawing (library default 0)"))
            return inp(v / scale if math.isfinite(v) else None, unit, prov)

        model = model_block(
            "dome regulator: drawn outlet law + IEC 60534-2-1 capacity",
            "feedtwin.comps.regulator.Regulator.outlet_setpoint (the drawing's coefficients); " + IEC_SOURCE,
            [
                "outlet law evaluated on the twin's recorded regulator-inlet node pressure and branch flow",
                "dome = control-regulator dial + its bias + its own supply effect at its supply node (zero flow), "
                "as feedtwin.session loads it",
                f"wide open = flowing and the outlet more than {MODE_BAND:.1%} of the setpoint under the law "
                "(an assumed tolerance, the size of feedtwin Regulator.is_choked's shut/regulating band; "
                "feedtwin's is_saturated itself has none)",
                "capacity at this instant's inlet and outlet node pressures, wide open; turbulent; Fp = 1 "
                "(no reducer data on the drawing)",
                "inlet density and gamma = cp/cv from CoolProp (real gas) at the inlet node's pressure and "
                "temperature",
                "supply effect measured from zero inlet (gauge): outlet = dome + bias - S x inlet, as "
                "feedtwin.comps.regulator.Regulator.supply_effect has it (the team, 2026-10-07)",
            ],
            {
                "Cv": pv("Cv", "US gpm/psi^0.5"),
                "xT": inp(x_t, "-", x_t_prov),
                "supply_coefficient": pv("supply_coefficient", "psi/psi"),
                "flow_droop": pv("flow_droop", "psi", PSI),
                "rated_flow": pv("rated_flow", "kg/s"),
                "dome_bias": pv("dome_bias", "psi", PSI),
                "dome": inp(scalar(np.nanmean(dome) / PSI) if np.isfinite(dome).any() else None, "psia", dome_basis),
                "gas": inp(fluid, "", "drawing (the regulator inlet node's fluid)"),
                "wide_open_band": inp(MODE_BAND, "fraction of setpoint",
                                      "assumed: tolerance before 'wide open'; the size of feedtwin "
                                      "Regulator.is_choked's band, no source for this use"),
            },
        )
        return {
            "id": rid,
            "label": br.get("label") or rid,
            "t": out(t),
            "inlet_psia": out(p_in / PSI),
            "outlet_psia": out(p_out / PSI),
            "inlet_T_K": out(T_in),
            "inlet_rho_kg_m3": out(rho_in),
            "mdot": out(mdot),
            "setpoint_psia": out(p_set / PSI),
            "dome_psia": out(dome / PSI),
            "target_psia": out(target / PSI),
            "residual_psi": out(residual / PSI),
            "capacity_mdot": out(cap),
            "use_frac": out(use),
            "x": out(x_series),
            "droop_psi": out(droop / PSI),
            "spe_psi": out(spe / PSI),
            "choked": choked,
            "wide_open": [bool(w) for w in wide_open],
            "any_wide_open": bool(wide_open.any()),
            "use_frac_max": scalar(np.nanmax(use)) if np.isfinite(use).any() else None,
            "rise": split,
            "cv": scalar(cv),
            "model": model,
        }
    except Exception as exc:  # noqa: BLE001
        return unavailable(f"{type(exc).__name__}: {exc}")


# ---- the press solenoids ------------------------------------------------------------------------

def _gas_reach(net: Mapping[str, Any], side: str, reg: str) -> Tuple[List[str], Optional[str]]:
    """The branches from the regulator's outlet to the tank on one side, and the tank's node."""
    path = list((net.get("paths") or {}).get(side) or [])
    if reg not in path:
        return [], None
    seg: List[str] = []
    prev = None
    for bid in path[path.index(reg) + 1:]:
        br = net["branches"][bid]
        # the tank: the recorder's own head element (<tank>.head, kind tank_head) starts at the
        # ullage node; a recorder without one leaves a gap between the ullage and the outlet
        if br.get("kind") == "tank_head" or (prev is not None and br["from"] != prev):
            return seg, (br["from"] if br.get("kind") == "tank_head" else prev)
        seg.append(bid)
        prev = br["to"]
    return [], None


def build_solenoids(result: Mapping[str, Any], prep: Any = None, config: Any = None, *,
                    gas: Optional[str] = None, xT: Optional[float] = None) -> Any:
    """``diagnostics.solenoids``: one row per solenoid between the regulator and a tank. Never
    raises (a failure is ``{available: false, error}`` in place of the list)."""
    try:
        net = network_of(result)
        t = series_t(result)
        n = t.size
        reg = regulator_id(net)
        if reg is None:
            return unavailable("no regulator on the recorded network")
        built = _built(prep)
        rows: List[Dict[str, Any]] = []
        for side in SIDES:
            seg, tank = _gas_reach(net, side, reg)
            if not seg or tank is None:
                continue
            reg_out = net["branches"][reg]["to"]
            reg_to_tank = node_p(net, reg_out, n) - node_p(net, tank, n)
            for bid in seg:
                br = net["branches"][bid]
                if br.get("kind") not in ("solenoid", "valve"):
                    continue
                dp = arr(br.get("dp_psi"), n) if br.get("dp_psi") is not None else \
                    node_p(net, br["from"], n) - node_p(net, br["to"], n)
                cv = float(br.get("cv") or math.nan)
                x_t = xT
                cv_prov = "drawing (recorded network)"
                xt_prov = "restated for this diagnostic" if xT is not None else \
                    "assumed: feedtwin Valve default 0.7 (no x_T on the drawing)"
                if built is not None:
                    try:
                        comp = built.network.branches[bid].component
                        cv = float(comp.p.get("Cv", cv))
                        cv_prov = _provenance(comp, "Cv")
                        if x_t is None and "xT" in comp.p:
                            x_t = float(comp.p["xT"])
                            xt_prov = _provenance(comp, "xT")
                    except Exception:  # noqa: BLE001
                        pass
                x_t = DEFAULT_XT if x_t is None else x_t
                fluid = gas or _pressurant(prep, net, br["from"])
                mdot = arr(br.get("mdot"), n)
                p1 = node_p(net, br["from"], n) * PSI
                T1 = node_T(net, br["from"], n)
                iec = np.full(n, math.nan)
                iec2 = np.full(n, math.nan)
                for k in range(n):
                    if not (math.isfinite(mdot[k]) and mdot[k] > 1e-9 and math.isfinite(p1[k] + T1[k])):
                        if math.isfinite(mdot[k]) and abs(mdot[k]) <= 1e-9:
                            iec[k] = iec2[k] = 0.0
                        continue
                    rho, gamma = gas_state(fluid, p1[k], T1[k])
                    iec[k] = iec_gas_drop(mdot[k], p1[k], rho, gamma, cv, x_t) / PSI
                    iec2[k] = iec_gas_drop(mdot[k], p1[k], rho, gamma, 2.0 * cv, x_t) / PSI
                with np.errstate(divide="ignore", invalid="ignore"):
                    share = np.where(np.abs(reg_to_tank) > 1e-9, dp / reg_to_tank, np.nan)
                firing = np.asarray([bool(x) for x in (result.get("series") or {}).get("firing") or [False] * n])
                live = firing & np.isfinite(dp)
                rows.append({
                    "id": bid, "label": br.get("label") or bid, "side": side, "cv": scalar(cv),
                    "cv_provenance": cv_prov,
                    "dp_psi": out(dp), "share_of_reg_to_tank": out(share),
                    "reg_to_tank_psi": out(reg_to_tank),
                    "dp_iec_psi": out(iec), "dp_iec_2cv_psi": out(iec2),
                    "dp_max_psi": scalar(np.nanmax(dp[live])) if live.any() else None,
                    "share_max": scalar(np.nanmax(share[live])) if live.any() and np.isfinite(share[live]).any() else None,
                    "model": model_block(
                        "press solenoid drop: twin vs IEC 60534-2-1",
                        IEC_SOURCE,
                        ["dp_psi is the twin's own branch drop (feedtwin Valve, the Cv law at inlet density)",
                         "dp_iec_psi: IEC 60534 drop at the recorded flow and the inlet node's CoolProp state",
                         "dp_iec_2cv_psi: the same flow through twice the Cv (flows held: a first-order "
                         "what-if, not a re-burn)"],
                        {"Cv": inp(cv, "US gpm/psi^0.5", cv_prov),
                         "xT": inp(x_t, "-", xt_prov)}),
                })
        return rows
    except Exception as exc:  # noqa: BLE001
        return unavailable(f"{type(exc).__name__}: {exc}")
