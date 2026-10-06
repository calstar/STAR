"""Forward mode's result, one number per quantity.

``forward_report(cfg, result)`` turns a solve (``PintleEngineRunner.evaluate``) into what forward mode
shows: a headline, verdicts, and sections of quantities. Every quantity is read from the solve
ONCE, here, with its unit, what it is (``basis``) and which unmeasured inputs it rests on
(``assumed``). The frontend draws these and computes nothing: two cards cannot disagree about a
number neither of them computes.

A verdict carries its own status and threshold, decided here, so no card grades anything.

Quantity:  {key, label, value, unit, digits, basis, assumed: [calibration keys], status?, band?, detail?}
Verdict:   {key, label, value, unit, digits, status: ok|warn|bad|unknown, threshold, basis, assumed}
Section:   {key, title, summary: [quantity keys], quantities: [Quantity]}
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Mapping, Optional, Sequence

PSI = 6894.757
G0 = 9.80665


# ---- the inputs nobody has measured -------------------------------------------------------------

#: Every assumed input a displayed number can rest on: what it is, where the config holds it and
#: what the literature allows. A quantity lists the keys it depends on; the frontend marks it.
#: ``measurements.<key>`` in the config (not yet in the schema) will replace one when it is measured.
CALIBRATION: Dict[str, Dict[str, str]] = {
    "cd": {"label": "Orifice Cd", "where": "discharge.<side>",
           "basis": "Lichtarowicz (1965) Cd(Re, L/d) for a sharp inlet; not flow-tested"},
    "em": {"label": "Mixing factor E_m", "where": "combustion.efficiency.rupe_Em_opt",
           "basis": "Rupe, JPL TR 32-1546: 0.70–0.85 for 1-on-1 unlike doublets"},
    "smd": {"label": "Spray D32", "where": "spray.smd",
            "basis": "NACA TN 4222 carried to the propellants; three published transfers disagree"},
    "mix_lag": {"label": "Chug mixing lag", "where": "stability.mixing_lag_fraction",
                "basis": "Leonardi 2017 double time lag; fraction unmeasured, gate takes the worst"},
    "n_chi": {"label": "Combustion response n, χ", "where": "stability",
              "basis": "Crocco n–τ constants; no measurement for this propellant pair"},
    "ac_damping": {"label": "Acoustic damping", "where": "stability.damping_*_frac",
                   "basis": "injector-face and two-phase damping as fixed fractions of πf"},
    "nozzle": {"label": "Nozzle efficiency ζ_n", "where": "chamber_geometry.nozzle_efficiency",
               "basis": "divergence and boundary-layer loss taken as one factor"},
    "manifold": {"label": "Manifold losses", "where": "injector.plate.channel_entry_K / _pressure_regain",
                 "basis": "Idelchik entry K and Acrivos regain; not flow-tested"},
    "wall_heat": {"label": "Wall heat transfer", "where": "ablative_cooling",
                  "basis": "Bartz-type convection and gas radiation; liner not tested"},
}

# What the headline numbers rest on: flow through Cd, c* through E_m and SMD, thrust through zeta_n.
_FLOW = ("cd", "manifold")
_CSTAR = ("em", "smd")
_THRUST = _FLOW + _CSTAR + ("nozzle",)


def _f(v: Any) -> Optional[float]:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def Q(key: str, label: str, value: Any, unit: str = "", *, digits: int = 3, basis: str = "",
      assumed: Sequence[str] = (), status: Optional[str] = None, band: Optional[str] = None,
      detail: bool = False) -> Dict[str, Any]:
    v = value if isinstance(value, str) else _f(value)
    out = {"key": key, "label": label, "value": v, "unit": unit, "digits": digits, "basis": basis,
           "assumed": list(assumed)}
    if status:
        out["status"] = status
    if band:
        out["band"] = band
    if detail:
        out["detail"] = True
    return out


def V(key: str, label: str, value: Any, unit: str, status: str, threshold: str, basis: str,
      assumed: Sequence[str] = (), digits: int = 2) -> Dict[str, Any]:
    return {"key": key, "label": label, "value": _f(value), "unit": unit, "digits": digits,
            "status": status, "threshold": threshold, "basis": basis, "assumed": list(assumed)}


def _grade(value: Optional[float], ok: float, warn: Optional[float] = None, *, higher_is_better: bool = True) -> str:
    """ok at/past ``ok``; warn between ``warn`` and ``ok``; bad beyond. unknown without a value."""
    if value is None:
        return "unknown"
    if higher_is_better:
        if value >= ok:
            return "ok"
        return "warn" if (warn is not None and value >= warn) else "bad"
    if value <= ok:
        return "ok"
    return "warn" if (warn is not None and value <= warn) else "bad"


# ---- sections -------------------------------------------------------------------------------------

def _headline(r: Mapping[str, Any]) -> List[Dict[str, Any]]:
    return [
        Q("F", "Thrust", _f(r.get("F")) and r["F"] / 1000.0, "kN", digits=2, basis="F = Cf · Pc · At",
          assumed=_THRUST),
        Q("Isp", "Isp", r.get("Isp"), "s", digits=1, basis="F / (ṁ g0)", assumed=_THRUST),
        Q("Pc", "Chamber pressure", _f(r.get("Pc")) and r["Pc"] / PSI, "psia", digits=1,
          basis="the chamber solve: feed + injector flow = nozzle flow", assumed=_FLOW + _CSTAR),
        Q("OF", "O/F", r.get("MR"), "", digits=3, basis="ṁ_O / ṁ_F", assumed=_FLOW),
        Q("mdot", "Mass flow", r.get("mdot_total"), "kg/s", digits=3, basis="ṁ_O + ṁ_F", assumed=_FLOW),
        Q("eta_cstar", "η c*", r.get("eta_cstar"), "", digits=3, basis="η_vap · η_mix · η_heat-loss",
          assumed=_CSTAR),
    ]


def _verdicts(cfg: Any, r: Mapping[str, Any], sr: Mapping[str, Any]) -> List[Dict[str, Any]]:
    d = r.get("diagnostics") or {}
    out: List[Dict[str, Any]] = []
    # Chug: the gate (worst mixing lag) against min_stability_margin.
    ch = (sr or {}).get("chug") or {}
    summ = (sr or {}).get("summary") or {}
    gate = _f(summ.get("gate_margin_threshold")) or 1.05
    gm = _f(ch.get("margin"))
    out.append(V("chug", "Chug", gm, "", _grade(gm, gate, 1.0), f"≥ {gate:g}",
                 "Nyquist gain margin of the feed–chamber loop at the worst mixing lag",
                 assumed=("mix_lag", "smd")))
    # Vaporization: where the slowest stream is 95 % vapour, against the chamber.
    vap = (sr or {}).get("vaporization") or {}
    frac = _f(vap.get("frac_vaporized_end"))
    lv, lch = _f(vap.get("L_vap_m")), _f(vap.get("L_ch_m"))
    st = "unknown" if frac is None else ("ok" if (lv is not None and lch and lv <= lch) else "warn")
    out.append(V("vaporized", "Vaporized", frac and 100.0 * frac, "%", st, "95 % inside L_ch",
                 "the droplet march that sets η_vap, slowest stream at the chamber end", assumed=("smd",),
                 digits=1))
    # Cavitation: the worse hole.
    cav = r.get("injector_cavitation") or {}
    margins = [_f((cav.get(k) or {}).get("margin")) for k in ("O", "F")]
    margins = [m for m in margins if m is not None]
    m = min(margins) if margins else None
    out.append(V("cavitation", "Cavitation", m, "×", _grade(m, 1.2, 1.0), "K / K_crit ≥ 1",
                 "Nurick (1976): cavitation margin of the worse orifice", assumed=("cd",)))
    # Injector stiffness: the softer side, against Huzel & Huang's 15 %.
    Pc = _f(r.get("Pc"))
    eta = [(_f(d.get(f"delta_p_injector_{k}")) or 0.0) / Pc for k in ("O", "F")] if Pc else []
    e = min(eta) if eta else None
    out.append(V("stiffness", "Injector ΔP/Pc", e and 100.0 * e, "%", _grade(e, 0.15, 0.10), "≥ 15 %",
                 "the softer injector's drop over Pc (Huzel & Huang 4.2)", assumed=_FLOW, digits=0))
    return out


def _chamber(cfg: Any, r: Mapping[str, Any]) -> Dict[str, Any]:
    ci = r.get("chamber_intrinsics") or {}
    At = _f(r.get("A_throat"))
    cg = cfg.chamber_geometry
    Dc = _f(getattr(cg, "chamber_diameter", None))
    CR = (Dc / math.sqrt(4 * At / math.pi)) ** 2 if (Dc and At) else None
    qs = [
        Q("Pc", "Chamber pressure", _f(r.get("Pc")) and r["Pc"] / PSI, "psia", digits=1, assumed=_FLOW + _CSTAR),
        Q("Tc", "Chamber temperature", r.get("Tc"), "K", digits=0, basis="CEA at Pc and O/F"),
        Q("Lstar", "L*", _f(ci.get("Lstar")) and ci["Lstar"] * 1000.0, "mm", digits=0, basis="V_c / A_t"),
        Q("theta_c", "Gas residence", _f(ci.get("residence_time")) and ci["residence_time"] * 1000.0, "ms",
          digits=2, basis="ρ_c V_c / ṁ"),
        Q("CR", "Contraction ratio", CR, "", digits=2, basis="(D_c / D_t)²"),
        Q("M_c", "Chamber Mach", ci.get("mach_number_chamber"), "", digits=3, basis="mean gas speed / a"),
        Q("cstar", "c*", r.get("cstar_actual"), "m/s", digits=0, basis="η c* · c*_CEA", assumed=_CSTAR),
        Q("cstar_ideal", "c* ideal", r.get("cstar_ideal"), "m/s", digits=0, basis="CEA", detail=True),
        Q("gamma", "γ", r.get("gamma"), "", digits=4, basis="CEA, chamber", detail=True),
        Q("R", "R", r.get("R"), "J/(kg·K)", digits=1, basis="CEA, chamber", detail=True),
        Q("rho_c", "Gas density", ci.get("density"), "kg/m³", digits=2, detail=True),
        Q("a_c", "Sound speed", ci.get("sound_speed"), "m/s", digits=0, detail=True),
    ]
    return {"key": "chamber", "title": "Chamber", "summary": ["Tc", "Lstar", "theta_c", "CR"], "quantities": qs}


def _nozzle(cfg: Any, r: Mapping[str, Any]) -> Dict[str, Any]:
    Pa = _f(r.get("P_ambient"))
    pe = _f(r.get("P_exit"))
    sep = pe / Pa if (pe and Pa) else None
    qs = [
        Q("Cf", "Cf", r.get("Cf_actual"), "", digits=4, basis="ζ_n · Cf_vac − pa ε / Pc", assumed=("nozzle",)),
        Q("Cf_ideal", "Cf ideal", r.get("Cf_ideal"), "", digits=4, basis="CEA", detail=True),
        Q("eps", "Expansion ratio", r.get("eps"), "", digits=2, basis="A_e / A_t"),
        Q("P_exit", "Exit pressure", pe and pe / PSI, "psia", digits=2, basis="CEA Pc/Pe at ε"),
        Q("pe_pa", "Exit / ambient", sep, "", digits=2, basis="Summerfield: separation below ~0.4",
          status=_grade(sep, 0.4) if sep is not None else None),
        Q("v_exit", "Exit velocity", r.get("v_exit"), "m/s", digits=0, detail=True),
        Q("M_exit", "Exit Mach", r.get("M_exit"), "", digits=2, detail=True),
        Q("At", "Throat area", _f(r.get("A_throat")) and r["A_throat"] * 1e6, "mm²", digits=1, detail=True),
    ]
    return {"key": "nozzle", "title": "Nozzle", "summary": ["Cf", "eps", "pe_pa"], "quantities": qs}


def _injector(cfg: Any, r: Mapping[str, Any]) -> Dict[str, Any]:
    d = r.get("diagnostics") or {}
    Pc = _f(r.get("Pc"))
    cav = r.get("injector_cavitation") or {}
    tag = {"O": "LOX", "F": "fuel"}
    per: Dict[str, List[Dict[str, Any]]] = {}
    for k in ("O", "F"):
        dp = _f(d.get(f"delta_p_injector_{k}"))
        eta = dp / Pc if (dp and Pc) else None
        per[k] = [
            Q(f"dpPc_{k}", f"ΔP/Pc {tag[k]}", eta and 100.0 * eta, "%", digits=1, basis="injector drop over Pc",
              assumed=_FLOW, status=_grade(eta, 0.15, 0.10)),
            Q(f"dp_inj_{k}", f"ΔP injector {tag[k]}", dp and dp / PSI, "psi", digits=1, assumed=_FLOW),
            Q(f"dp_feed_{k}", f"ΔP feed {tag[k]}", _f(d.get(f"delta_p_feed_{k}")) and d[f"delta_p_feed_{k}"] / PSI,
              "psi", digits=1, basis="tank to injector: line friction, fittings, manifold", assumed=("manifold",)),
            Q(f"Cd_{k}", f"Cd {tag[k]}", r.get(f"Cd_{k}"), "", digits=3, assumed=("cd",),
              basis="hole Cd at the solved Re (cavitation limited)"),
            Q(f"v_{k}", f"Jet velocity {tag[k]}", d.get(f"v_{k}_bulk"), "m/s", digits=1,
              basis="ṁ / (ρ A_hole): the jet fills the bore (attached, L/d ≥ 2)", assumed=_FLOW),
            Q(f"cav_{k}", f"Cavitation margin {tag[k]}", (cav.get(k) or {}).get("margin"), "×", digits=2,
              basis="K / K_crit (Nurick 1976)", assumed=("cd",),
              status=_grade(_f((cav.get(k) or {}).get("margin")), 1.2, 1.0)),
            Q(f"mdot_{k}", f"ṁ {tag[k]}", r.get(f"mdot_{k}"), "kg/s", digits=3, assumed=_FLOW, detail=True),
            Q(f"P_inj_{k}", f"P injector {tag[k]}", _f(d.get(f"P_injector_{k}")) and d[f"P_injector_{k}"] / PSI,
              "psia", digits=1, detail=True),
        ]
    # The lines themselves: their own acoustic modes and the valve-slam spike.
    lines = ((((r.get("stability") or {}).get("feed_system")) or {}).get("feed_lines")) or {}
    for k, side in (("O", "oxidizer"), ("F", "fuel")):
        ln = lines.get(side) or {}
        per[k] += [
            Q(f"line_qw_{k}", f"Line quarter-wave {tag[k]}", ln.get("pogo_frequency"), "Hz", digits=0,
              basis="a / 4L, tank end open; for spotting a coincidence with chug or the chamber", detail=True),
            Q(f"hammer_{k}", f"Water hammer {tag[k]}",
              _f(ln.get("water_hammer_pressure")) and ln["water_hammer_pressure"] / PSI, "psi", digits=0,
              basis="Joukowsky ρ·a·v for an instantaneous valve stop (upper bound)", detail=True),
        ]
    # LOX and fuel side by side: the view lays quantities out two to a row.
    qs: List[Dict[str, Any]] = [q for pair in zip(per["O"], per["F"]) for q in pair]
    lo, hi = _f(d.get("element_mixture_ratio_min")), _f(d.get("element_mixture_ratio_max"))
    MR = _f(r.get("MR"))
    if lo is not None and hi is not None and MR:
        qs.append(Q("of_spread", "Element O/F spread", 100.0 * (hi - lo) / MR, "%", digits=2,
                    basis="ring-manifold solve, around each ring", assumed=("manifold",)))
    return {"key": "injector", "title": "Feed & injector",
            "summary": ["dpPc_O", "dpPc_F", "Cd_O", "cav_O"], "quantities": qs}


def _spray(cfg: Any, r: Mapping[str, Any], sr: Mapping[str, Any]) -> Dict[str, Any]:
    d = r.get("diagnostics") or {}
    ce = d.get("cstar_efficiency") or {}
    vap = (sr or {}).get("vaporization") or {}
    M = _f(d.get("rupe_M"))
    qs = [
        Q("D32_O", "D32 LOX", _f(d.get("D32_O")) and d["D32_O"] * 1e6, "µm", digits=0, basis="NACA TN 4222",
          assumed=("smd",)),
        Q("D32_F", "D32 fuel", _f(d.get("D32_F")) and d["D32_F"] * 1e6, "µm", digits=0, basis="NACA TN 4222",
          assumed=("smd",)),
        Q("rupe_M", "Rupe M", M, "", digits=3, basis="ρO vO² dO / (ρF vF² dF); best mixing near 1",
          status=("ok" if M is not None and 0.8 <= M <= 1.25 else "warn") if M is not None else None, assumed=_FLOW),
        Q("Em", "Mixing factor E_m", ce.get("rupe_Em"), "", digits=3, basis="Rupe, at this element's M",
          assumed=("em",)),
        Q("eta_mix", "η mixing", ce.get("eta_mixing"), "", digits=4, basis="stream-tube c* over the E_m spread",
          assumed=("em",)),
        Q("eta_vap", "η vaporization", ce.get("eta_vaporization"), "", digits=4, basis="droplet march",
          assumed=("smd",)),
        Q("L_vap", "95 % vaporized at", _f(vap.get("L_vap_m")) and vap["L_vap_m"] * 1000.0, "mm", digits=0,
          basis=f"slowest stream ({vap.get('fluid', '')}), from the face", assumed=("smd",)),
        Q("L_ch", "Chamber (L*·At/Ac)", _f(vap.get("L_ch_m")) and vap["L_ch_m"] * 1000.0, "mm", digits=0,
          basis="the chamber the droplet march runs in"),
        Q("eta_hl", "η heat loss", ce.get("eta_heat_loss"), "", digits=4, detail=True, assumed=("wall_heat",)),
    ]
    return {"key": "spray", "title": "Spray & mixing", "summary": ["rupe_M", "Em", "L_vap", "eta_vap"],
            "quantities": qs}


def _cooling(cfg: Any, r: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    ab = ((r.get("cooling") or {}).get("ablative")) or {}
    if not ab.get("enabled"):
        return None
    qs = [
        Q("recession", "Recession rate", _f(ab.get("recession_rate_mean")) and ab["recession_rate_mean"] * 1e6,
          "µm/s", digits=0, basis="liner mean", assumed=("wall_heat",)),
        Q("recession_peak", "Peak recession", _f(ab.get("recession_rate_peak")) and ab["recession_rate_peak"] * 1e6,
          "µm/s", digits=0, basis="at the liner's hottest station", assumed=("wall_heat",)),
        Q("q_incident", "Incident heat flux", _f(ab.get("incident_heat_flux")) and ab["incident_heat_flux"] / 1e6,
          "MW/m²", digits=2, basis="convective + radiative", assumed=("wall_heat",)),
        Q("T_surface", "Surface temperature", ab.get("surface_temperature"), "K", digits=0, detail=True),
        Q("cooling_power", "Heat to the liner", _f(ab.get("cooling_power")) and ab["cooling_power"] / 1000.0, "kW",
          digits=0, assumed=("wall_heat",), detail=True),
    ]
    return {"key": "cooling", "title": "Cooling", "summary": ["recession", "recession_peak", "q_incident"],
            "quantities": qs}


def _stability(sr: Mapping[str, Any]) -> Dict[str, Any]:
    ch = (sr or {}).get("chug") or {}
    ac = (sr or {}).get("acoustic") or {}
    worst = min((m.get("margin_worst_phase") for m in ac.get("modes", []) if m.get("margin_worst_phase") is not None),
                default=None)
    qs = [
        Q("chug_gate", "Chug gain margin (gate)", ch.get("margin"), "", digits=2,
          basis="worst mixing lag in its band", assumed=("mix_lag", "smd")),
        Q("chug_nominal", "Chug gain margin (nominal)", ch.get("gain_margin_nominal"), "", digits=2,
          assumed=("mix_lag", "smd")),
        Q("chug_f", "Chug frequency", ch.get("freq_hz"), "Hz", digits=0, assumed=("mix_lag", "smd")),
        Q("ac_worst", "Acoustic, worst phase", worst, "", digits=2,
          basis="report only: damping over the most driving any lag could give",
          assumed=("n_chi", "ac_damping")),
    ]
    return {"key": "stability", "title": "Stability", "summary": ["chug_gate", "chug_f", "ac_worst"],
            "quantities": qs}


def _calibration(cfg: Any, used: Sequence[str]) -> Dict[str, Dict[str, Any]]:
    """The inputs this result rests on, each assumed or measured (engine/pipeline/measurements.py)."""
    from engine.pipeline.measurements import calibration_state
    st = calibration_state(cfg)
    out = {}
    for k in used:
        s = st.get(k, {"state": "assumed", "sources": []})
        out[k] = {**CALIBRATION[k], "state": s["state"], "sources": s["sources"]}
    return out


def _references(cfg: Any, sr: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """Measurements that are compared with the model rather than fed into it."""
    ms = getattr(cfg, "measurements", None)
    out = []
    cf = getattr(ms, "chug_frequency_hz", None) if ms is not None else None
    if cf is not None:
        out.append({"key": "chug_frequency", "label": "Chug frequency", "unit": "Hz", "measured": cf.value,
                    "uncertainty": cf.uncertainty, "source": cf.source,
                    "model": _f(((sr or {}).get("chug") or {}).get("freq_hz"))})
    return out


# ---- the report -----------------------------------------------------------------------------------

def forward_report(cfg: Any, r: Mapping[str, Any], *, handcheck_rows: Optional[Mapping[str, Any]] = None
                   ) -> Dict[str, Any]:
    """Forward mode's view of solve ``r`` of ``cfg``. ``r`` must carry ``stability_rich``."""
    sr = r.get("stability_rich") or {}
    sections = [_chamber(cfg, r), _nozzle(cfg, r), _injector(cfg, r), _spray(cfg, r, sr), _cooling(cfg, r),
                _stability(sr)]
    sections = [s for s in sections if s is not None]
    # A hot-fire chug frequency sits beside the model's, in the Stability section.
    for ref in _references(cfg, sr):
        if ref["key"] == "chug_frequency":
            st = next(s for s in sections if s["key"] == "stability")
            st["quantities"].append(Q("chug_f_measured", "Chug frequency, measured", ref["measured"], "Hz", digits=0,
                                      basis=f"hot fire: {ref['source']}"))
            st["summary"].append("chug_f_measured")
    used = sorted({a for s in sections for q in s["quantities"] for a in q["assumed"]}
                  | {a for q in _headline(r) for a in q["assumed"]})
    return {
        "headline": _headline(r),
        "verdicts": _verdicts(cfg, r, sr),
        "sections": sections,
        "calibration": _calibration(cfg, used),
        "measured_reference": _references(cfg, sr),
        "stability": sr,
        "handcheck": handcheck_rows,
    }
