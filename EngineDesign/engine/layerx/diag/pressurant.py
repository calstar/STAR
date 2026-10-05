"""The pressurant: what the bottle held, what the burn took, what it needed, and the
Joule-Thomson temperature change across the regulator.

``build_pressurant(result, prep=None, config=None, ...)`` -> ``diagnostics.pressurant``
(DATA-CONTRACT 3).

* **Mass** comes from the bottle's vessel state (``series.copv_mass_kg``, ``series.copv_psia``),
  never from network nodes (AUDIT 5.5: vessel states and node values differ). ``loaded_kg`` is
  the first recorded sample (the bottle at the start of the lead-in; Layer X assumes it full after
  the tanks are pressed, AUDIT D13), ``residual_kg`` the sample at the last firing step,
  ``used_kg`` their difference.
* **Bottle gas temperature** is the vessel's own: CoolProp T at (rho = m / V, p) with V the
  drawing's bottle volume. It is a state the twin integrates; this recovers it from the two it
  records.
* **Required mass to burnout** = used + what must stay in the bottle for the regulator still to
  pass the burnout flow at the burnout outlet pressure. The floor at the regulator inlet is the
  larger of (outlet + the drawing's ``min_inlet_differential``) and the inlet pressure at which the
  wide-open seat's IEC 60534-2-1 capacity (``engine.layerx.diag.regulator.iec_gas_flow``) equals
  the burnout flow. The bottle is taken on from its burnout state to that floor **adiabatically**:
  for a rigid vessel with outflow only and no heat, the first law ``d(m u) = h dm`` with
  ``v = V/m`` gives ``du = -p dv``, i.e. ``ds = 0`` for the gas left inside, so the bottle follows
  its burnout isentrope ``T_b(p) = T(p, s(p_end, T_end))`` (CoolProp). The regulator inlet gas is
  that bottle gas throttled isenthalpically through the bottle-to-regulator line (the twin's own
  adiabatic-line walk), and the line's drop, recorded at burnout, is carried to the floor at the
  same flow as a loss-coefficient drop ``K mdot^2 / (2 rho A^2)``: scaled by the inlet density at
  burnout over that at the floor. The three are solved together (fixed point). ``unusable_kg`` is
  CoolProp's density at the floor bottle state, times V; ``margin_kg`` = loaded - required =
  residual - unusable. Holding the bottle at its burnout temperature and the line at its burnout
  drop instead (``unusable_held_T_kg``) is the other bound: it is what a bottle wall that kept the
  gas at its burnout temperature would give, and it understates the unusable mass (the LE4 He
  bottle tracks its isentrope to ~2 % over the burn, ``bottle_T_end_isentropic_K``).
* **Joule-Thomson** across the regulator is an isenthalpic throttle: the steady-flow energy
  equation with no heat, no work and the kinetic-energy change neglected gives h_out = h_in, so
  ``T_out = T(p_out, h(p_in, T_in))`` (CoolProp). Helium above its inversion temperature (~40 K)
  warms on throttling; nitrogen at room temperature cools. ``jt_dT_K`` is computed on the
  regulator's inlet node state and outlet node pressure; ``twin_dT_K`` is the twin's own walked
  temperature change across the same branch, for comparison.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Mapping, Optional

import numpy as np

from engine.layerx.diag.ladder import (
    PSI, arr, firing_mask, inp, model_block, node_p, node_T, out, scalar, series_t, unavailable,
)
from engine.layerx.diag.regulator import (
    DEFAULT_XT, _built, _provenance, coolprop_name, gas_state, iec_gas_flow, regulator_id,
)

COOLPROP_SOURCE = ("CoolProp (Bell, Wronski, Quoilin & Lemort, 'Pure and Pseudo-pure Fluid Thermophysical "
                   "Property Evaluation and the Open-Source Thermophysical Property Library CoolProp', "
                   "Ind. Eng. Chem. Res. 53(6), 2498-2508, 2014)")


def _cp_version() -> str:
    try:
        import CoolProp

        return str(CoolProp.__version__)
    except Exception:  # noqa: BLE001
        return "?"


def jt_temperature_change(fluid: str, p_in_pa: float, T_in_K: float, p_out_pa: float) -> float:
    """Isenthalpic throttle from (p_in, T_in) to p_out: T_out - T_in [K] (CoolProp). NaN if out of
    range."""
    import CoolProp.CoolProp as CP

    try:
        name = coolprop_name(fluid)
        h = CP.PropsSI("HMASS", "P", p_in_pa, "T", T_in_K, name)
        return float(CP.PropsSI("T", "P", p_out_pa, "HMASS", h, name) - T_in_K)
    except Exception:  # noqa: BLE001
        return math.nan


def density(fluid: str, p_pa: float, T_K: float) -> float:
    import CoolProp.CoolProp as CP

    try:
        return float(CP.PropsSI("D", "P", p_pa, "T", T_K, coolprop_name(fluid)))
    except Exception:  # noqa: BLE001
        return math.nan


def temperature_from_state(fluid: str, rho: float, p_pa: float) -> float:
    import CoolProp.CoolProp as CP

    try:
        return float(CP.PropsSI("T", "D", rho, "P", p_pa, coolprop_name(fluid)))
    except Exception:  # noqa: BLE001
        return math.nan


def isentropic_temperature(fluid: str, p0_pa: float, T0_K: float, p_pa: float) -> float:
    """T [K] at ``p`` on the isentrope through (p0, T0) (CoolProp); NaN out of range. The gas left
    in a rigid vessel discharging with no heat follows it (first law: ``d(mu) = h dm`` -> ``ds = 0``)."""
    import CoolProp.CoolProp as CP

    try:
        name = coolprop_name(fluid)
        s0 = CP.PropsSI("SMASS", "P", p0_pa, "T", T0_K, name)
        return float(CP.PropsSI("T", "P", p_pa, "SMASS", s0, name))
    except Exception:  # noqa: BLE001
        return math.nan


FLOOR_ITERS = 50
FLOOR_TOL_PA = 1.0


def bottle_floor(fluid: str, mdot: float, p_out_pa: float, cv: float, xT: float, min_differential_pa: float,
                 p_b_end_pa: float, T_b_end_K: float, p_in_end_pa: float, T_in_end_K: float,
                 line_drop_end_pa: float) -> Dict[str, float]:
    """The bottle state at which the regulator, wide open, just passes ``mdot`` to ``p_out``.

    Solves together (fixed point on the regulator inlet pressure):

    * regulator inlet ``p_in`` = :func:`regulator_inlet_floor` at the inlet gas temperature ``T_in``;
    * bottle ``p_b = p_in + dp_line``, ``dp_line = line_drop_end * rho_in_end / rho_in`` (a
      loss-coefficient drop at the same mass flow scales as 1/rho);
    * bottle ``T_b`` on the burnout isentrope (:func:`isentropic_temperature`);
    * ``T_in = T(p_in, h(p_b, T_b))``: the bottle gas throttled through the adiabatic line.

    Returns {p_b, T_b, p_in, T_in, line_drop, iterations, converged} in Pa and K.
    """
    import CoolProp.CoolProp as CP

    name = coolprop_name(fluid)
    rho_in_end = density(fluid, p_in_end_pa, T_in_end_K)
    drop_end = max(line_drop_end_pa, 0.0)
    T_in = T_in_end_K
    p_in = math.nan
    p_b = T_b = drop = math.nan
    converged = False
    it = 0
    for it in range(1, FLOOR_ITERS + 1):
        p_new = regulator_inlet_floor(fluid, mdot, p_out_pa, T_in, cv, xT, min_differential_pa)
        if not math.isfinite(p_new):
            break
        rho_in = density(fluid, p_new, T_in)
        drop = drop_end * rho_in_end / rho_in if (drop_end > 0 and rho_in > 0) else drop_end
        p_b = p_new + drop
        T_b = isentropic_temperature(fluid, p_b_end_pa, T_b_end_K, p_b)
        try:
            h_b = CP.PropsSI("HMASS", "P", p_b, "T", T_b, name)
            T_in = float(CP.PropsSI("T", "P", p_new, "HMASS", h_b, name))
        except Exception:  # noqa: BLE001
            break
        done = math.isfinite(p_in) and abs(p_new - p_in) < FLOOR_TOL_PA
        p_in = p_new
        if done:
            converged = True
            break
    return {"p_b": p_b, "T_b": T_b, "p_in": p_in, "T_in": T_in, "line_drop": drop,
            "iterations": float(it), "converged": float(converged)}


def regulator_inlet_floor(fluid: str, mdot: float, p_out_pa: float, T_in_K: float, cv: float,
                          xT: float = DEFAULT_XT, min_differential_pa: float = 0.0) -> float:
    """Lowest regulator inlet pressure [Pa] at which the wide-open seat (IEC 60534-2-1) still
    passes ``mdot`` to ``p_out``, and at least ``p_out + min_differential``."""
    from scipy.optimize import brentq

    base = p_out_pa + max(0.0, min_differential_pa)
    if not (math.isfinite(mdot) and mdot > 0 and math.isfinite(cv) and cv > 0):
        return base

    def excess(p_in: float) -> float:
        rho, gamma = gas_state(fluid, p_in, T_in_K)
        return iec_gas_flow(p_in, p_out_pa, rho, gamma, cv, xT)["mdot"] - mdot

    lo = p_out_pa * (1.0 + 1e-9)
    if excess(lo) >= 0.0:
        return base
    hi = 2.0 * p_out_pa
    while excess(hi) < 0.0:
        hi *= 2.0
        if hi > 1e10:
            return math.nan
    return max(base, float(brentq(excess, lo, hi, xtol=1.0, rtol=1e-12)))


def _derived(prep: Any, result: Mapping[str, Any]) -> Mapping[str, Any]:
    d = getattr(prep, "derived", None) if prep is not None else None
    if d:
        return d
    return ((result.get("provenance") or {}).get("derived")) or {}


def build_pressurant(result: Mapping[str, Any], prep: Any = None, config: Any = None, *,
                     gas: Optional[str] = None, volume_m3: Optional[float] = None,
                     regulator: Optional[Mapping[str, Any]] = None,
                     xT: Optional[float] = None) -> Dict[str, Any]:
    """``diagnostics.pressurant``. Never raises.

    ``gas`` and ``volume_m3`` default to the drawing's (``derived.pressurant_gas``,
    ``derived.copv_volume_L``, from ``prep`` or the result's provenance). ``regulator`` is
    ``diagnostics.regulator`` when already built (its Cv and x_T are reused). Needs
    ``result["network"]`` only for the regulator's inlet state (JT, floor); without it, those
    keys are null and the mass budget stands.
    """
    try:
        series = result.get("series") or {}
        t = series_t(result)
        n = t.size
        derived = _derived(prep, result)
        fluid = gas or derived.get("pressurant_gas")
        if not fluid:
            return unavailable("the pressurant species is unknown")
        vol = volume_m3 if volume_m3 is not None else (
            float(derived["copv_volume_L"]) / 1e3 if derived.get("copv_volume_L") else None)
        mass = arr(series.get("copv_mass_kg"), n)
        p_b = arr(series.get("copv_psia"), n) * PSI
        if not np.isfinite(mass).any():
            return unavailable("series.copv_mass_kg is missing")
        firing = firing_mask(result, n)
        end = int(np.flatnonzero(firing)[-1]) if firing.any() else n - 1
        start = 0
        loaded = float(mass[start])
        residual = float(mass[end])
        used = loaded - residual

        T_b = np.full(n, math.nan)
        if vol:
            for k in range(n):
                if math.isfinite(mass[k] + p_b[k]) and mass[k] > 0:
                    T_b[k] = temperature_from_state(fluid, mass[k] / vol, p_b[k])

        # The burn's own check on the adiabatic-bottle assumption the floor makes: the isentrope from
        # the loaded state to the burnout pressure, against the twin's bottle temperature there.
        T_end_isentropic = (isentropic_temperature(fluid, p_b[start], T_b[start], p_b[end])
                            if math.isfinite(T_b[start] + p_b[start] + p_b[end]) else math.nan)

        net = result.get("network")
        jt = np.full(n, math.nan)
        twin_dT = np.full(n, math.nan)
        floor = None
        floor_reg_in = None
        unusable = None
        unusable_held = None
        fl: Dict[str, float] = {}
        reg_basis = "no network recorded: no regulator inlet state"
        cv = x_t = None
        line_drop = None
        min_diff = 0.0
        min_diff_prov = "assumed 0: no min_inlet_differential on the drawing"
        if isinstance(net, Mapping) and net.get("branches"):
            rid = (regulator or {}).get("id") or regulator_id(net)
            if rid is not None:
                br = net["branches"][rid]
                p_in = node_p(net, br["from"], n) * PSI
                p_out = node_p(net, br["to"], n) * PSI
                T_in = node_T(net, br["from"], n)
                T_out = node_T(net, br["to"], n)
                for k in range(n):
                    if math.isfinite(p_in[k] + T_in[k] + p_out[k]):
                        jt[k] = jt_temperature_change(fluid, p_in[k], T_in[k], p_out[k])
                twin_dT = T_out - T_in
                reg_basis = f"regulator {rid}: inlet node {br['from']} state, outlet node {br['to']} pressure"
                cv = (regulator or {}).get("cv") or br.get("cv")
                x_t = xT if xT is not None else DEFAULT_XT
                built = _built(prep)
                if built is not None:
                    try:
                        comp = built.network.branches[rid].component
                        cv = cv or comp.p.get("Cv")
                        if "min_inlet_differential" in comp.p:
                            min_diff = float(comp.p["min_inlet_differential"])
                            min_diff_prov = _provenance(comp, "min_inlet_differential")
                    except Exception:  # noqa: BLE001
                        pass
                if regulator and regulator.get("model"):
                    x_t = xT if xT is not None else float(
                        ((regulator["model"].get("inputs") or {}).get("xT") or {}).get("value") or DEFAULT_XT)
                mdot_end = float(arr(br.get("mdot"), n)[end])
                # bottle node -> regulator inlet node, the line(s) between them, at burnout
                path = (net.get("paths") or {}).get("ox") or (net.get("paths") or {}).get("fuel") or []
                bottle_node = net["branches"][path[0]]["from"] if path else br["from"]
                line_drop = float((node_p(net, bottle_node, n) * PSI - p_in)[end])
                if cv and math.isfinite(T_in[end]) and math.isfinite(p_out[end]):
                    # the other bound: bottle held at its burnout temperature, line at its burnout drop
                    held_in = regulator_inlet_floor(fluid, mdot_end, p_out[end], T_in[end], float(cv), x_t, min_diff)
                    if vol and math.isfinite(T_b[end]) and math.isfinite(held_in):
                        unusable_held = density(fluid, held_in + max(line_drop, 0.0), T_b[end]) * vol
                    if math.isfinite(T_b[end] + p_b[end]):
                        fl = bottle_floor(fluid, mdot_end, p_out[end], float(cv), x_t, min_diff, p_b[end], T_b[end],
                                          p_in[end], T_in[end], line_drop)
                        if math.isfinite(fl["p_b"] + fl["T_b"]):
                            floor_reg_in = fl["p_in"]
                            floor = fl["p_b"]
                            if vol:
                                unusable = density(fluid, floor, fl["T_b"]) * vol
        required = used + unusable if unusable is not None else None
        margin = loaded - required if required is not None else None
        live = firing & np.isfinite(jt)
        model = model_block(
            "pressurant budget + isenthalpic regulator throttle",
            COOLPROP_SOURCE + f", version {_cp_version()}; steady-flow energy equation (adiabatic, no work, "
            "kinetic energy neglected: h_out = h_in); first law for a rigid vessel discharging with no heat "
            "(d(mu) = h dm -> ds = 0 for the gas left inside); IEC 60534-2-1:2011 for the seat capacity floor",
            [
                "mass from the bottle's vessel state; loaded = first recorded sample (bottle assumed full "
                "after the tanks were pressed, AUDIT D13), residual = last firing step",
                "bottle gas temperature = CoolProp T(rho = m/V, p) of the vessel state",
                "required = used + the mass left when the bottle reaches the floor, the bottle taken on from "
                "its burnout state along its isentrope (no wall heat after burnout: the conservative bound; "
                "unusable_held_T_kg holds the burnout temperature and line drop instead)",
                "floor at the regulator inlet = max(regulator outlet at burnout + min_inlet_differential, inlet "
                "at which the wide-open seat's IEC capacity equals the burnout flow), at the inlet temperature "
                "of the bottle gas throttled isenthalpically through the bottle-to-regulator line",
                "bottle-to-regulator line drop carried from burnout to the floor at the same flow as a "
                "loss-coefficient drop (scales as 1/rho at the regulator inlet; friction factor held)",
                "JT: regulator inlet node (p, T) to outlet node p at constant enthalpy; no heat exchange "
                "in the regulator body",
            ],
            {
                "gas": inp(fluid, "", "drawing (KBOTTLE fluid)"),
                "bottle_volume": inp(vol * 1e3 if vol else None, "L", "drawing (KBOTTLE volume)"),
                "regulator_Cv": inp(scalar(cv) if cv else None, "US gpm/psi^0.5", "drawing (regulator Cv)"),
                "regulator_xT": inp(x_t, "-", "restated for this diagnostic" if xT is not None else
                                    "assumed: unpublished; feedtwin Valve default (AUDIT 9.6 C3)"),
                "min_inlet_differential": inp(min_diff / PSI, "psi", min_diff_prov),
            },
        )
        return {
            "species": str(fluid),
            "t": out(t),
            "loaded_kg": scalar(loaded),
            "used_kg": scalar(used),
            "residual_kg": scalar(residual),
            "required_kg": scalar(required) if required is not None else None,
            "margin_kg": scalar(margin) if margin is not None else None,
            "unusable_kg": scalar(unusable) if unusable is not None else None,
            "unusable_held_T_kg": scalar(unusable_held) if unusable_held is not None else None,
            "floor_psia": scalar(floor / PSI) if floor is not None else None,
            "floor_regulator_inlet_psia": scalar(floor_reg_in / PSI) if floor_reg_in is not None else None,
            "floor_bottle_T_K": scalar(fl.get("T_b")) if fl else None,
            "floor_regulator_inlet_T_K": scalar(fl.get("T_in")) if fl else None,
            "floor_line_drop_psi": scalar(fl["line_drop"] / PSI) if fl and math.isfinite(fl["line_drop"]) else None,
            "floor_converged": bool(fl.get("converged")) if fl else None,
            "bottle_end_psia": scalar(p_b[end] / PSI),
            "bottle_T_end_isentropic_K": scalar(T_end_isentropic),
            "margin_psi": scalar((p_b[end] - floor) / PSI) if floor is not None else None,
            "line_drop_end_psi": scalar(line_drop / PSI) if line_drop is not None else None,
            "t_end": scalar(t[end]),
            "bottle_T_K": out(T_b),
            "jt_dT_K": out(jt),
            "twin_dT_K": out(twin_dT),
            "jt_dT_range_K": ([scalar(np.nanmin(jt[live])), scalar(np.nanmax(jt[live]))] if live.any() else None),
            "jt_basis": reg_basis,
            "model": model,
        }
    except Exception as exc:  # noqa: BLE001
        return unavailable(f"{type(exc).__name__}: {exc}")
