"""Spray and mixing of the unlike-doublet injector, as one report: what each jet does from its
orifice to where it is burnt, each number beside the band it is judged against and where that
band comes from, and how the answer moves across the inputs the literature does not pin down.

Presentation of the solve (``PintleEngineRunner.evaluate``) and the plate layout
(``layout_from_config``): the numbers are the solver's own, read back, except the few checks the
solver does not make (jet intact length, spray lean, the spray's reach against the chamber), which
are closed forms cited where they are made. Nothing here feeds back into the solve.

Rows: ``{"label", "value", "unit", "band", "status", "source", "note"}``; status is ``ok``,
``warn``, ``bad`` or ``info`` (a number with no band to hold it to).
"""
from __future__ import annotations

import copy
import math
from typing import Any, Dict, List, Mapping, Optional

PSI = 6894.757

#: Intact liquid core of a jet in the atomization regime, L = C d sqrt(rho_l / rho_g), C = 7-16
#: (Chehroudi, Chen, Bracco & Onuma, SAE 850126, 1985). The low end is the conservative one here:
#: the question is only whether the jets reach each other before they come apart.
CORE_C_LOW = 7.0

#: SP-8089 criterion 3.1.1.1.4 (p. 80): impingement distance along the jet no greater than 5-7 d.
FREE_JET_MAX_D = 7.0

#: Rupe's best mixing at M = rho_O v_O^2 d_O / (rho_F v_F^2 d_F) near 1 (Rupe 1953; Elverum &
#: Morey, JPL Memo 30-5, 1959); the band the hand-check holds it to.
RUPE_M_BAND = (0.8, 1.25)


def _row(label: str, value: Any, unit: str = "", band: str = "", status: str = "info",
         source: str = "", note: str = "") -> Dict[str, Any]:
    return {"label": label, "value": value, "unit": unit, "band": band, "status": status,
            "source": source, "note": note}


def _f(v: Any, default: float = float("nan")) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def jet_rows(cfg: Any, result: Mapping[str, Any], lay: Optional[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """Each jet from its orifice to the impingement point."""
    d = result.get("diagnostics") or {}
    geo, fl = cfg.injector.geometry, cfg.fluids
    rho_g = _f(d.get("rho_gas_breakup"))
    rows: List[Dict[str, Any]] = []
    for k, side, name in (("O", "oxidizer", "LOX"), ("F", "fuel", "fuel")):
        st, f = getattr(geo, side), fl[side]
        dj = float(st.d_jet)
        v = _f(d.get(f"v_{k}_bulk"))
        rho, mu, sig = float(f.density), float(f.viscosity), float(f.surface_tension)
        Re = rho * v * dj / mu
        We_l = rho * v * v * dj / sig
        rows.append(_row(f"{name} jet velocity", v, "m/s", "10–60", "ok" if 10 <= v <= 60 else "warn",
                         "bulk mdot / (rho A)", f"Re {Re:.3g}, liquid We {We_l:.3g}"))
        if lay is not None:
            free = _f(lay["face"][f"free_jet_{k}"])
            ld = free / dj
            rows.append(_row(f"{name} free jet to impingement", ld, "d", f"≤ {FREE_JET_MAX_D:g}",
                             "ok" if ld <= FREE_JET_MAX_D else "warn",
                             "NASA SP-8089 3.1.1.1.4 (along the jet)", f"{free * 1000:.2f} mm"))
            if rho_g > 0:
                core = CORE_C_LOW * dj * math.sqrt(rho / rho_g)
                rows.append(_row(f"{name} intact core (low bound)", core / dj, "d",
                                 f"> free jet {ld:.1f} d", "ok" if core > free else "bad",
                                 "Chehroudi et al. SAE 850126: L = C d √(ρl/ρg), C 7–16",
                                 f"at ρg {rho_g:.2f} kg/m³: the jets meet before they come apart"
                                 if core > free else "the jet atomizes before it meets its pair"))
        cd = d.get(f"Cd_{k}")
        cd_eff = d.get(f"Cd_eff_manifold_{k}")
        if cd is not None:
            p = (lay or {}).get("passages", {}).get(k, {})
            rows.append(_row(f"{name} orifice Cd", _f(cd), "", "", "info",
                             (p.get("cd") or {}).get("model", "discharge model"),
                             f"L/d {_f(p.get('plate_l_over_d', p.get('land_ld'))):.2f}"
                             + (f"; {_f(cd_eff):.4f} through the manifold" if cd_eff is not None else "")))
    return rows


def impingement_rows(cfg: Any, result: Mapping[str, Any], lay: Optional[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    d = result.get("diagnostics") or {}
    geo = cfg.injector.geometry
    thO, thF = float(geo.oxidizer.impingement_angle), float(geo.fuel.impingement_angle)
    rows = [_row("included angle", thO + thF, "°", "60–100", "ok" if 60 <= thO + thF <= 100 else "warn",
                 "Sutton 8.3; Huzel & Huang 4.2 practice")]
    M = _f(d.get("rupe_M"))
    lo, hi = RUPE_M_BAND
    rows.append(_row("Rupe M", M, "", f"{lo:g}–{hi:g}", "ok" if lo <= M <= hi else "warn",
                     "ρO vO² dO / (ρF vF² dF); Rupe 1953, Elverum & Morey 1959",
                     "best mixing near 1"))
    rows.append(_row("momentum ratio R", _f(d.get("momentum_ratio_R")), "", "", "info",
                     "ṁO vO / ṁF vF per element"))
    # Resultant lean of the fan: the two jets' momenta added. The inner ring aims outward.
    vO, vF = _f(d.get("v_O_bulk")), _f(d.get("v_F_bulk"))
    pO, pF = _f(result.get("mdot_O")) * vO, _f(result.get("mdot_F")) * vF
    ox_inner = bool(lay["face"]["ox_is_inner"]) if lay is not None else True
    s = 1.0 if ox_inner else -1.0
    rad = s * (pO * math.sin(math.radians(thO)) - pF * math.sin(math.radians(thF)))
    ax = pO * math.cos(math.radians(thO)) + pF * math.cos(math.radians(thF))
    lean = math.degrees(math.atan2(rad, ax))
    rows.append(_row("spray lean", lean, "° (+ outward)", "≈ 0, inward allowed",
                     "ok" if lean <= 0.25 else "warn", "Sutton eq. 8-7 (momentum resultant)",
                     "toward the wall" if lean > 0 else "toward the axis"))
    if lay is not None:
        f = lay["face"]
        rb = float(lay["envelope"]["r_bore"])
        req = cfg.design_requirements.model_dump() if hasattr(cfg, "design_requirements") else {}
        frac, tol = req.get("layer1_injector_spray_radius_frac"), req.get("layer1_injector_spray_radius_tol")
        v = f["r_imp"] / rb
        if frac:
            ok = abs(v - frac) <= (tol or 0.08)
            rows.append(_row("impingement ring / bore radius", v, "", f"{frac:g} ± {tol or 0.08:g}",
                             "ok" if ok else "warn", "layer1_injector_spray_radius_frac (0.707 = equal area)",
                             f"⌀{2 * f['r_imp'] * 1000:.1f} mm, {f['z_imp'] * 1000:.2f} mm off the face"))
        else:
            rows.append(_row("impingement ring / bore radius", v, "", "", "info", "",
                             f"⌀{2 * f['r_imp'] * 1000:.1f} mm"))
    return rows


def atomization_rows(cfg: Any, result: Mapping[str, Any]) -> List[Dict[str, Any]]:
    d = result.get("diagnostics") or {}
    smd = cfg.spray.smd
    basis = (f"NACA TN 4222 (Ingebo 1958), carried to the propellants by {smd.smd_property_transfer}"
             if smd.smd_property_scaling else "NACA TN 4222 (Ingebo 1958), heptane in air")
    rows = []
    for k, name in (("O", "LOX"), ("F", "fuel")):
        rows.append(_row(f"{name} D32", _f(d.get(f"D32_{k}")) * 1e6, "µm", "", "info", basis,
                         f"× {smd.smd_scale:g} (smd_scale)" if smd.smd_scale != 1.0 else "uncalibrated: measure it"))
        rows.append(_row(f"{name} gas Weber", _f(d.get(f"We_{k}")), "", "", "info",
                         "ρg Vrel² d / σ at the breakup gas density"))
    rows.append(_row("sheet breakup length", _f(d.get("L_sheet_breakup")) * 1000, "mm", "", "info",
                     "h ~ d²/(4 L_imp), t_b ~ (h/u) √(ρl/ρg)"))
    return rows


def vaporization_rows(cfg: Any, result: Mapping[str, Any]) -> List[Dict[str, Any]]:
    d = result.get("diagnostics") or {}
    ce = d.get("cstar_efficiency") or {}
    L = _f(ce.get("L_chamber_equiv"))
    x0 = _f(ce.get("x_drop_formation"), 0.0)
    rows = []
    for k, name in (("O", "LOX"), ("F", "fuel")):
        # The march measures from where the drops form; this is from the face.
        x95 = _f(ce.get(f"x_vap95_{k}")) + x0
        fr = _f(ce.get(f"frac_vaporized_{k}"))
        rows.append(_row(f"{name} 95 % vaporized, from the face", x95 * 1000, "mm", f"< chamber {L * 1000:.0f} mm",
                         "ok" if x95 < L else "bad", "droplet march (blowing: "
                         f"{ce.get('blowing_model', '?')}; liquid: {ce.get(f'liquid_props_{k}', '?')})",
                         f"{fr * 100:.1f} % vaporized at the throat; {(L - x95) / L * 100:+.0f} % margin"))
    rows.append(_row("vaporized at the throat", _f(ce.get("fraction_vaporized")) * 100, "%", "", "info",
                     "the droplet march", f"O/F of the vapour {_f(ce.get('MR_vaporized')):.3f}"))
    # The older d²-law estimate and the fixed limit the solver still flags it against.
    xs = _f(d.get("x_star"))
    lim = _f(getattr(getattr(cfg.spray, "evaporation", None), "x_star_limit", None))
    rows.append(_row("x* (d²-law, Vrel τ_evap)", xs * 1000, "mm",
                     f"config limit {lim * 1000:.0f} mm" if lim == lim else "", "info",
                     "spray.evaporation.x_star_limit",
                     "a fixed number, not this chamber: the march above is what η_vap uses"))
    return rows


def mixing_rows(cfg: Any, result: Mapping[str, Any]) -> List[Dict[str, Any]]:
    d = result.get("diagnostics") or {}
    ce = d.get("cstar_efficiency") or {}
    eff = cfg.combustion.efficiency
    rows = [
        _row("Rupe E_m", _f(ce.get("rupe_Em")), "", f"optimum {eff.rupe_Em_opt:g}", "info",
             ce.get("mixing_basis", "Rupe, JPL TR 32-1546"), "cold-flow mixture-ratio uniformity"),
        _row("η mixing", _f(ce.get("eta_mixing")), "", "", "info", "stream-tube c* integral over the E_m spread",
             f"{ce.get('mixing_distribution', '')}; two-tube shape {_f(ce.get('eta_mixing_two_tube')):.4f}"),
        _row("η vaporization", _f(ce.get("eta_vaporization")), "", "", "info", "droplet march"),
        _row("η heat loss", _f(ce.get("eta_heat_loss")), "", "", "info", "wall heat to the liner"),
        _row("η c*", _f(result.get("eta_cstar", d.get("eta_cstar"))), "", "", "info",
             "η_vap × η_mix × η_HL"),
    ]
    lo, hi = d.get("element_mixture_ratio_min"), d.get("element_mixture_ratio_max")
    if lo is not None:
        rows.append(_row("element O/F spread", (hi - lo) / result["MR"] * 100, "%", "", "info",
                         "ring-manifold solve", f"{lo:.4f}–{hi:.4f}"))
    return rows


# ---- what the answer rests on -------------------------------------------------------------

#: The inputs the literature leaves open, and the range it gives for each.
SENSITIVITY_CASES = (
    ("SMD transfer: Dombrowski & Johns", ("spray", "smd", "smd_property_transfer"), "dombrowski_johns",
     "the three published transfers of TN 4222 to the propellants"),
    ("SMD transfer: none (heptane in air)", ("spray", "smd", "smd_property_transfer"), "none",
     "the three published transfers of TN 4222 to the propellants"),
    ("Rupe E_m opt 0.70", ("combustion", "efficiency", "rupe_Em_opt"), 0.70,
     "short or cavitating orifices (Nurick & McHale, JPL TR 32-1546)"),
    ("Rupe E_m opt 0.85", ("combustion", "efficiency", "rupe_Em_opt"), 0.85,
     "top of the circular 1-on-1 doublet band (JPL TR 32-1546 p. 1)"),
)


def _solve(cfg: Any) -> Mapping[str, Any]:
    from engine.core.runner import PintleEngineRunner
    return PintleEngineRunner(copy.deepcopy(cfg)).evaluate(
        cfg.lox_tank.initial_pressure_psi * PSI, cfg.fuel_tank.initial_pressure_psi * PSI, silent=True)


def _summary(r: Mapping[str, Any]) -> Dict[str, float]:
    ce = (r.get("diagnostics") or {}).get("cstar_efficiency") or {}
    return {"F": _f(r.get("F")), "Isp": _f(r.get("Isp")), "Pc_psia": _f(r.get("Pc")) / PSI,
            "OF": _f(r.get("MR")), "eta_cstar": _f(r.get("eta_cstar")),
            "eta_vap": _f(ce.get("eta_vaporization")), "eta_mix": _f(ce.get("eta_mixing")),
            "vap_F": _f(ce.get("frac_vaporized_F")), "vap_O": _f(ce.get("frac_vaporized_O"))}


def sensitivity(cfg: Any, base: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """Each open input moved to the end of its published range, the design re-solved AS WRITTEN
    (same tanks, same holes). The value each case actually ran with is read back from the
    solved config, so a case the model ignored cannot pass for one it honoured."""
    out = [{"case": "as configured", "why": "", **_summary(base), "applied": True}]
    for name, path, value, why in SENSITIVITY_CASES:
        c = copy.deepcopy(cfg)
        obj = c
        for p in path[:-1]:
            obj = getattr(obj, p)
        setattr(obj, path[-1], value)
        got = obj
        try:
            r = _solve(c)
        except Exception as e:  # a case that does not solve is a finding, not a crash
            out.append({"case": name, "why": why, "error": str(e), "applied": True})
            continue
        out.append({"case": name, "why": why, **_summary(r), "applied": getattr(got, path[-1]) == value})
    return out


def spray_mixing_report(cfg: Any, result: Optional[Mapping[str, Any]] = None, *,
                        with_sensitivity: bool = True) -> Dict[str, Any]:
    """The report for ``cfg`` at its own tank pressures (solved here unless ``result`` is given)."""
    from engine.core.injectors.layout import flows_from_result, layout_from_config
    r = result if result is not None else _solve(cfg)
    try:
        lay = layout_from_config(cfg, drawings=False, flows=flows_from_result(r, cfg))
    except Exception:
        lay = None
    rep = {
        "design": {"F": _f(r.get("F")), "Pc_psia": _f(r.get("Pc")) / PSI, "OF": _f(r.get("MR")),
                   "Isp": _f(r.get("Isp")), "P_tank_O_psi": cfg.lox_tank.initial_pressure_psi,
                   "P_tank_F_psi": cfg.fuel_tank.initial_pressure_psi},
        "sections": [
            {"title": "Jets", "rows": jet_rows(cfg, r, lay)},
            {"title": "Impingement", "rows": impingement_rows(cfg, r, lay)},
            {"title": "Atomization", "rows": atomization_rows(cfg, r)},
            {"title": "Vaporization", "rows": vaporization_rows(cfg, r)},
            {"title": "Mixing and c*", "rows": mixing_rows(cfg, r)},
        ],
        "sensitivity": sensitivity(cfg, r) if with_sensitivity else None,
    }
    return rep
