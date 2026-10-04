"""Chug margin over the burn, on the drawing's feed impedance: ``diagnostics.stability``.

DATA-CONTRACT section 3, ``stability``. Layer X audit D7 and appendix 9.4.

What Layer X's replay reports today (the ``config`` basis) is EngineDesign's chug gate at 28
replay points: the Nyquist gain margin of the lumped feed / injector / chamber loop with a double
time lag (Leonardi et al. 2017), taken at the worst point of the unmeasured mixing-lag band. Three
of its inputs do not come from the stand that is burning (audit 9.4 sections 1-3):

* the feed **inertance** is ``feed_system.<side>.length / A_hydraulic`` from the engine config,
  not the drawing's lines;
* the feed **resistance** is the Borda exit dump alone, because the replay runs on the line-exit
  copy of the config (``engine/layerx/card.py``), which zeroes K0;
* **A_t and L*** are the design point's, while the chamber erodes.

This module re-evaluates the same loop at the same points and offers the drawing's basis:

``basis="drawing"`` (D7 B+C)
    I = sum of L/A over the drawing's lines from the tank outlet to the injector inlet (the
    assembled network's path, each line's own bore); R = 2 dp/mdot with dp = the twin's own
    tank-outlet -> line-exit drop at that instant, plus the Borda dump EngineDesign prices at the
    line exit (the same dump the config basis carries). A side whose drawing declares no line, or
    a run with no outlet pressures, keeps the config's value for that side and says so: turned on
    against a drawing that declares nothing, the basis changes nothing.
``eroded=True`` (D7 D)
    The stability call sees each point's eroded geometry (A_t, V, L*, bore, A_e) instead of the
    design point's, exactly what ``TimeVaryingCoupledSolver(chug_eroded_geometry=True)`` does.
``start_window`` (D7 E)
    The margin is *graded* from the first fully-open step: the main valves' travel (the drawing's
    ``travel_time``, else the twin's ``Setup.valve_travel_s``) plus ``settle_tau`` line time
    constants. Steps inside that window are evaluated and reported (``worst``) but not graded
    (``settled_min``): every one of them is a quasi-steady part-open state of an algebraic network
    whose number is set by ``dt`` (audit 5.1: 1.367 / 1.308 / 1.161 / 0.797 at 50 / 10 / 5 / 2 ms).

The config basis at the replay points reproduces the replay's ``chug_margin`` exactly (the chamber
is re-solved on the replay's own geometry at the replay's own line-exit pressures, and the gate is
EngineDesign's own ``_chug_fast`` + ``chug_band``); ``check`` in the output says by how much.

Public functions
----------------
``stability_block(prep, result, config=None, basis="config", eroded=False, start_window="auto")``
    -> the ``diagnostics.stability`` dict. Never raises: ``{"available": False, "error": ...}``.
``drawing_feed(prep)`` -> per side, the drawing's lines on the propellant path and their inertance.
"""

from __future__ import annotations

import copy
import math
from dataclasses import replace
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

PSI = 6894.757293168361

#: Line time constants allowed after the mains are fully open before the margin is graded.
#: Assumed: 1 - e^-3 = 95 % of a first-order (R-L) line's response to the valve's last step. The
#: twin's network is algebraic, so this is a statement about the real line, not the model.
SETTLE_TAU = 3.0
#: At most this many firing steps inside the start window are evaluated (first and last kept).
START_POINTS_MAX = 24
#: Points in the combustion-lag sweep across the model's mixing-lag band.
TAU_SWEEP_POINTS = 41
#: Nyquist plot frequency grid [Hz]: the chug model's own scan range, log spaced.
NYQUIST_HZ = (2.0, 2000.0, 400)
#: A line mode within this fraction of the chug frequency is flagged.
NEAR_CHUG = 0.20

SIDES = (("oxidiser", "oxidizer", "O", "ox"), ("fuel", "fuel", "F", "fuel"))

#: Young's modulus of the feed tube [Pa] for the Korteweg wave-speed correction. Type 316
#: stainless at room temperature: 28.0e6 psi (193 GPa), the producers' published value (e.g. the
#: AK Steel 316/316L product data bulletin); ASME BPVC Section II Part D Table TM-1 gives 28.3e6
#: psi (195 GPa) for austenitic stainless at 70 F. The same number as
#: engine/pipeline/stability/analysis.py ``_TUBE_E_STAINLESS``. The drawing has no material field:
#: "316" appears only in its wall-thickness reference text, so this is an assumption, and E rises
#: a few per cent at 90 K, which is not modelled. +-10 % in E moves the LE4 wave speeds by
#: ~+-0.3 % (audit 9.4 section 4).
TUBE_MODULUS_PA = 193.0e9
TUBE_MODULUS_SOURCE = ("assumed: type 316 stainless, 28.0e6 psi (193 GPa) room temperature (producers' data; "
                       "ASME BPVC II-D Table TM-1: 28.3e6 psi at 70 F); the drawing names no material, "
                       "only '316' in its wall reference text")


# ---------------------------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------------------------


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _param_record(param: Any, si: Optional[float], unit: str, fallback: str) -> Dict[str, Any]:
    """``{value, unit, provenance}`` for one drawn number (a feedtwin ``Param``), in SI."""
    if param is None:
        return {"value": si, "unit": unit, "provenance": fallback}
    src = getattr(getattr(param, "source", None), "value", None) or str(getattr(param, "source", ""))
    ref = str(getattr(param, "reference", "") or "")
    return {"value": si, "unit": unit,
            "provenance": f"drawing ({src}): {param.value:g} {param.unit}" + (f" -- {ref}" if ref else "")}


def _runner(prep: Any, config: Any) -> Any:
    link = getattr(prep, "link", None)
    sampler = getattr(link, "sampler", None) if link is not None else None
    if sampler is not None:
        return sampler.runner
    if config is None:
        raise ValueError("no EngineDesign link and no config")
    from engine.core.runner import PintleEngineRunner
    from engine.layerx.card import line_exit_config

    return PintleEngineRunner(line_exit_config(config))


# ---------------------------------------------------------------------------------------------
# the drawing's feed path
# ---------------------------------------------------------------------------------------------


def drawing_feed(prep: Any) -> Dict[str, Dict[str, Any]]:
    """Per side (``oxidiser``/``fuel``), the drawing's path from the tank outlet to the injector
    inlet as the twin assembled it.

    Returns ``{side: {"lines": [...], "others": [...], "inertance": I [1/m] or None,
    "flags": [str]}}``. Each line: ``id, label, length_m, bore_m, area_m2, wall_m, inertance``
    and the provenance of each number. ``others`` are the inline components on the path (valves,
    fittings) with their ``travel_s`` where they are actuated. Read only: the drawing is the feed
    system. A line the drawing gives no length or bore keeps the number the twin burned with
    (feed-twin's fallback) and is flagged.
    """
    from engine.layerx.flight import _path_to_tank

    model = prep.model
    built = model.built
    net = built.network
    diagram = getattr(model, "diagram", None)
    edges = {e.id: e for e in (diagram.edges if diagram is not None else ())}
    nodes = {n.id: n for n in (diagram.nodes if diagram is not None else ())}
    owner: Dict[str, str] = {}
    for did, bids in (built.branches_of or {}).items():
        for b in bids:
            owner[b] = did
    setup_travel = _num(getattr(getattr(prep, "setup", None), "valve_travel_s", None))

    out: Dict[str, Dict[str, Any]] = {}
    for side, _, _, _ in SIDES:
        path = _path_to_tank(model, prep.inlet_nodes.get(side, ""), prep.roles.get(side, ""))
        lines: List[Dict[str, Any]] = []
        others: List[Dict[str, Any]] = []
        flags: List[str] = []
        seen_edges: set = set()
        for bid in path:
            did = owner.get(bid, bid)
            br = net.branches[bid]
            p = dict(getattr(br.component, "p", {}) or {})
            edge = edges.get(did)
            if edge is not None:
                if did in seen_edges:
                    continue        # a segmented line is several branches of one edge
                seen_edges.add(did)
                segs = list(getattr(edge.segments, "segments", ()) or ())
                if segs:
                    for k, seg in enumerate(segs):
                        L = float(seg.tube_length())
                        d = float(seg.bore_si)
                        lines.append(_line_record(f"{did}#{k}", did, L, d, edge, seg.length, seg.bore,
                                                  elevation=getattr(seg, "elevation_change", None)))
                else:
                    L = _num(p.get("length"))
                    d = _num(p.get("bore"))
                    lines.append(_line_record(did, did, L, d, edge, edge.params.get("length"),
                                              edge.params.get("bore")))
                continue
            node = nodes.get(did)
            travel_param = (node.params.get("travel_time") if node is not None else None)
            travel = _num(p.get("travel_time"))
            rec: Dict[str, Any] = {"id": did, "label": getattr(node, "label", did) if node else did,
                                   "type": getattr(node, "type", type(br.component).__name__) if node else
                                   type(br.component).__name__,
                                   "bore_m": _num(p.get("bore")),
                                   "actuated": did in (built.actuators or {})}
            if rec["actuated"]:
                if travel is not None and travel > 0:
                    rec["travel"] = _param_record(travel_param, travel, "s", "feed-twin component default")
                else:
                    rec["travel"] = {"value": setup_travel, "unit": "s",
                                     "provenance": "feed-twin Setup.valve_travel_s (the drawing gives no travel_time)"}
            others.append(rec)
            flags.append(f"{rec['label']}: no length on the drawing, so its body's inertance is not counted")
        for ln in lines:
            if ln["length_m"] is None or ln["bore_m"] is None or ln["bore_m"] <= 0:
                flags.append(f"{ln['label']}: no usable length/bore; left out of the inertance")
            elif ln["defaulted"]:
                flags.append(f"{ln['label']}: length or bore not on the drawing; the twin's fallback is used")
        usable = [ln for ln in lines if ln["inertance"] is not None]
        inertance = float(sum(ln["inertance"] for ln in usable)) if usable else None
        guessed = [ln["label"] for ln in lines if (ln.get("length_provenance") or "").startswith("drawing (estimated)")]
        if guessed and len(guessed) == len(lines):
            flags.append("every length on this path is 'estimated' on the drawing: measure the runs")
        elif guessed:
            flags.append(f"lengths 'estimated' on the drawing: {', '.join(guessed)}")
        out[side] = {"lines": lines, "others": others, "inertance": inertance, "flags": flags,
                     "path": list(path)}
    return out


def _line_record(rid: str, did: str, L: Optional[float], d: Optional[float], edge: Any,
                 length_param: Any, bore_param: Any, elevation: Any = None) -> Dict[str, Any]:
    wall_param = edge.params.get("wall_thickness") if edge is not None else None
    wall = _num(getattr(wall_param, "si", None)) if wall_param is not None else None
    area = math.pi * d * d / 4.0 if (d is not None and d > 0) else None
    inert = (L / area) if (L is not None and L > 0 and area) else None
    lp = _param_record(length_param, L, "m", "feed-twin fallback (not on the drawing)")
    bp = _param_record(bore_param, d, "m", "feed-twin fallback (not on the drawing)")
    wp = _param_record(wall_param, wall, "m", "not on the drawing")
    elev = elevation if elevation is not None else (edge.params.get("elevation_change") if edge is not None else None)
    return {
        "id": rid, "edge": did, "label": did, "length_m": L, "bore_m": d, "area_m2": area,
        "wall_m": wall, "inertance": inert,
        "elevation_m": _num(getattr(elev, "si", None)) if elev is not None else None,
        "length_provenance": lp["provenance"], "bore_provenance": bp["provenance"],
        "wall_provenance": wp["provenance"],
        "wall_reference": str(getattr(wall_param, "reference", "") or "") if wall_param is not None else "",
        "defaulted": length_param is None or bore_param is None,
    }


# ---------------------------------------------------------------------------------------------
# the evaluation points
# ---------------------------------------------------------------------------------------------


def _replay_geometry(rp: Dict[str, Any], design: Any) -> Optional[Dict[str, np.ndarray]]:
    """The replay's geometry at its points, with the as-built geometry prepended at Fire (t = 0).

    Newer replays carry V, A_e and the bore; an older one has A_t, L*, eps and the barrel
    recession, from which the same numbers follow."""
    t = rp.get("t") or []
    n = len(t)
    at = rp.get("A_throat_m2")
    if not n or not at or len(at) != n:
        return None

    def col(key: str) -> Optional[List[Optional[float]]]:
        v = rp.get(key)
        return list(v) if isinstance(v, list) and len(v) == n else None

    at = [float(v) for v in at]
    V = col("V_chamber_m3")
    if V is None and col("Lstar_m") is not None:
        V = [ls * a if ls is not None else None for ls, a in zip(col("Lstar_m"), at)]
    Ae = col("A_exit_m2")
    if Ae is None and col("eps") is not None:
        Ae = [e * a if e is not None else None for e, a in zip(col("eps"), at)]
    D = col("D_chamber_mm")
    D = [v * 1e-3 if v is not None else None for v in D] if D is not None else None
    if D is None and col("recession_chamber_mm") is not None:
        D = [float(design.chamber_diameter) + 2e-3 * (r or 0.0) for r in col("recession_chamber_mm")]

    def fill(vals: Optional[List[Optional[float]]], v0: float) -> np.ndarray:
        if vals is None:
            vals = [v0] * n
        return np.array([v0] + [float(v) if v is not None else v0 for v in vals])

    return {
        "t": np.array([0.0] + [float(v) for v in t]),
        "A_throat": fill(at, float(design.A_throat)),
        "volume": fill(V, float(design.volume)),
        "A_exit": fill(Ae, float(design.A_exit)),
        "chamber_diameter": fill(D, float(design.chamber_diameter)),
    }


def _geometry_at(geo: Optional[Dict[str, np.ndarray]], t: float, k: Optional[int]) -> Optional[Dict[str, float]]:
    """Geometry at replay point ``k`` (exact) or at time ``t`` (linear between replay points)."""
    if geo is None:
        return None
    if k is not None:
        return {key: float(geo[key][k + 1]) for key in ("A_throat", "volume", "A_exit", "chamber_diameter")}
    return {key: float(np.interp(t, geo["t"], geo[key])) for key in ("A_throat", "volume", "A_exit", "chamber_diameter")}


def _with_geometry(config: Any, g: Optional[Dict[str, float]]) -> Any:
    """A copy of ``config`` on geometry ``g``, set exactly as TimeVaryingCoupledSolver sets it."""
    from engine.pipeline.config_schemas import ensure_chamber_geometry

    c = copy.deepcopy(config)
    if g is None:
        ensure_chamber_geometry(c)
        return c
    cg = ensure_chamber_geometry(c)
    cg.volume = g["volume"]
    cg.A_throat = g["A_throat"]
    cg.A_exit = g["A_exit"]
    cg.expansion_ratio = g["A_exit"] / g["A_throat"]
    cg.Lstar = g["volume"] / g["A_throat"]
    cg.chamber_diameter = g["chamber_diameter"]
    return c


# ---------------------------------------------------------------------------------------------
# the gate at one point
# ---------------------------------------------------------------------------------------------


def _shift(streams: Sequence[Any], dtau: float) -> List[Any]:
    """Every stream's lag moved by ``dtau`` [s], floored at 0: chug_band's rule exactly."""
    return [replace(s, tau_conv=max(float(s.tau_conv) + dtau, 0.0)) for s in streams]


def _gate(inp: Dict[str, Any]) -> Dict[str, Any]:
    """EngineDesign's chug gate for one set of stability inputs, with the frequency *at the gate*.

    ``gate`` is exactly what ``compute_physical_stability`` reports as ``chug_gate_margin`` (the
    same ``_chug_fast`` and ``chug_band``). ``f_gate_hz`` is the chug frequency of the loop at the
    band point that sets the gate (the worst negative-real-axis crossing of L(iw) there), which is
    the frequency the engine would ring at if it chugged; ``f_nominal_hz`` is the one at the
    nominal lag, the only one the replay reported (audit 9.4 section 4: 34.6 vs ~22 Hz)."""
    from engine.pipeline.stability.analysis import _chug_fast, chug_band

    nominal = _chug_fast(inp["streams"], inp["chamber"])
    gm = float(nominal.get("gain_margin", float("nan")))
    band = chug_band(inp, gm)
    gate = band["min"] if band is not None else gm
    f_nom = _num(nominal.get("f_chug_hz"))
    frac = None
    f_gate = f_nom
    if band is not None:
        # chug_band's minimum includes the nominal point, but its ``at_min_fraction`` is the argmin
        # over the band's own samples only. When the nominal fraction is off that grid and sits
        # lower than every sample, the nominal *is* the gate: its lag and frequency are the gate's.
        finite = [g for g in band["gain_margins"] if math.isfinite(g)]
        if finite and math.isfinite(gm) and gm < min(finite):
            frac = float(inp["mixing_lag_fraction"])
        else:
            frac = float(band["at_min_fraction"])
        dtau = (frac - float(inp["mixing_lag_fraction"])) * float(inp["tau_mix_basis"])
        if abs(dtau) > 0.0:
            f_gate = _num(_chug_fast(_shift(inp["streams"], dtau), inp["chamber"]).get("f_chug_hz"))
    return {"gate": float(gate), "gm_nominal": gm, "f_gate_hz": f_gate, "f_nominal_hz": f_nom,
            "gate_fraction": frac, "band": band}


def _nyquist(inp: Dict[str, Any], gate: Dict[str, Any], t: float) -> Dict[str, Any]:
    """The open loop L(iw) of the chug model at one point, on a log frequency grid: at the lag
    that sets the gate (``re``/``im``) and at the nominal lag (``re_nominal``/``im_nominal``).

    The same transfer functions the gate is computed from (``chug._open_loop_grid``):
    L(s) = K_c/(theta_c s + 1) * sum_k exp(-s tau_k) / (Z_reg + I_k s + R_k + 1/G_k). The loop is
    open-loop stable, so the closed loop is stable when L does not encircle -1 (Nyquist); the gain
    margin is 1/|L| where L crosses the negative real axis."""
    from engine.pipeline.stability.chug import _open_loop_grid

    lo, hi, n = NYQUIST_HZ
    f = np.logspace(math.log10(lo), math.log10(hi), int(n))
    omega = 2.0 * math.pi * f
    dtau = 0.0
    if gate.get("gate_fraction") is not None:
        dtau = (float(gate["gate_fraction"]) - float(inp["mixing_lag_fraction"])) * float(inp["tau_mix_basis"])
    with np.errstate(over="ignore", invalid="ignore"):
        L = _open_loop_grid(omega, _shift(inp["streams"], dtau), inp["chamber"])
        Ln = _open_loop_grid(omega, inp["streams"], inp["chamber"])
    return {
        "t": float(t), "omega": [float(w) for w in omega],
        "re": [float(v) for v in L.real], "im": [float(v) for v in L.imag],
        "re_nominal": [float(v) for v in Ln.real], "im_nominal": [float(v) for v in Ln.imag],
        "lag_fraction": gate.get("gate_fraction"), "gain_margin": gate["gate"],
        "f_cross_hz": gate.get("f_gate_hz"),
    }


def _tau_sweep(inp: Dict[str, Any], n: int = TAU_SWEEP_POINTS) -> Dict[str, Any]:
    """Gate margin against the combustion time lag across the model's own band.

    The double-time-lag model's unmeasured input is the mixing-lag fraction f in [0, 1]: each
    stream's lag is tau_k(f) = tau_k(f0) + (f - f0) tau_mix_basis (``chug_band``). The axis is the
    total lag of the rate-limiting stream. A lag model with no band (the d^2-law) is swept over
    0.5-1.5 x its own lags instead, and says so."""
    from engine.pipeline.stability.analysis import _chug_fast

    streams, chamber = inp["streams"], inp["chamber"]
    rl = str(inp.get("rate_limiting_stream") or streams[0].name)
    st_rl = next((s for s in streams if s.name == rl), streams[0])
    band = inp.get("chug_band")
    out: Dict[str, Any] = {"stream": rl, "nominal_ms": float(st_rl.tau_conv) * 1e3}
    taus, gms, fr = [], [], []
    if band:
        f0, basis = float(inp["mixing_lag_fraction"]), float(inp["tau_mix_basis"])
        for f in np.linspace(float(band[0]), float(band[1]), int(n)):
            dtau = (float(f) - f0) * basis
            taus.append(max(float(st_rl.tau_conv) + dtau, 0.0) * 1e3)
            gms.append(float(_chug_fast(_shift(streams, dtau), chamber).get("gain_margin", float("nan"))))
            fr.append(float(f))
        out.update(parameter="mixing_lag_fraction", fraction=fr, basis_ms=basis * 1e3,
                   band="the model's mixing-lag band (stability.chug_band_mixing_lag_fraction_min/max)")
    else:
        for k in np.linspace(0.5, 1.5, int(n)):
            taus.append(float(st_rl.tau_conv) * float(k) * 1e3)
            gms.append(float(_chug_fast([replace(s, tau_conv=float(s.tau_conv) * float(k)) for s in streams],
                                        chamber).get("gain_margin", float("nan"))))
            fr.append(float(k))
        out.update(parameter="lag_scale", fraction=fr,
                   band="assumed 0.5-1.5 x the model's lags: this lag model has no mixing-lag band")
    out["tau_ms"] = taus
    out["margin"] = gms
    finite = [(g, t) for g, t in zip(gms, taus) if math.isfinite(g)]
    if finite:
        g, t = min(finite)
        out["min"] = {"margin": g, "tau_ms": t}
    return out


def _coolprop_liquid(fluid: str, T: float, p: float) -> Tuple[float, float, str]:
    """(rho [kg/m3], a [m/s], CoolProp name) of the propellant at (T, p). CoolProp (Bell et al.
    2014, Ind. Eng. Chem. Res. 53(6) 2498-2508): the speed of sound of the reference equation of
    state at that state, not a handbook constant."""
    import CoolProp.CoolProp as CP

    name = str(CP.get_fluid_param_string(str(fluid), "name"))
    return float(CP.PropsSI("D", "T", T, "P", p, name)), float(CP.PropsSI("A", "T", T, "P", p, name)), name


def korteweg(a0: float, rho: float, bore: float, wall: float, E: float) -> float:
    """Pressure-wave speed in a liquid-filled elastic tube [m/s].

    a = a0 / sqrt(1 + K D / (E e)), K = rho a0^2 the liquid's bulk modulus, D the bore, e the wall,
    E the tube's Young's modulus: Korteweg, D. J., "Ueber die Fortpflanzungsgeschwindigkeit des
    Schalles in elastischen Roehren", Annalen der Physik und Chemie 241(12), 525-542 (1878); the
    thin-walled wavespeed of Wylie, Streeter & Suo, Fluid Transients in Systems (Prentice Hall,
    1993), with its pipe-support factor c1 = 1 (expansion joints throughout). A tube anchored
    against axial movement has c1 = 1 - nu^2 (0.91 for steel), a ~0.3 % faster wave in LE4's
    1/2 x 0.035 in. lines: immaterial here, and the slower c1 = 1 is the conservative side for
    the near-chug flag. A wall of 0 or less, or no E, is a rigid tube (a = a0)."""
    if not (wall and wall > 0 and E and E > 0 and bore and bore > 0):
        return float(a0)
    K = rho * a0 * a0
    return float(a0 / math.sqrt(1.0 + K * bore / (E * wall)))


def _wall_copied(prep: Any) -> Optional[str]:
    """A flag when every line on the drawing carries the same wall thickness with the same
    reference across different bores: a value copied from line to line, not measured."""
    diagram = getattr(getattr(prep, "model", None), "diagram", None)
    if diagram is None:
        return None
    seen: Dict[Tuple[float, str], set] = {}
    total = 0
    for e in diagram.edges:
        w = e.params.get("wall_thickness")
        b = e.params.get("bore")
        if w is None:
            continue
        total += 1
        key = (round(float(w.si), 9), str(w.reference or ""))
        seen.setdefault(key, set()).add(round(float(b.si), 6) if b is not None else None)
    if not seen:
        return None
    (wall, ref), bores = max(seen.items(), key=lambda kv: len(kv[1]))
    count = sum(1 for e in diagram.edges if e.params.get("wall_thickness") is not None
                and (round(float(e.params["wall_thickness"].si), 9), str(e.params["wall_thickness"].reference or "")) == (wall, ref))
    if len(bores) >= 2 and count >= 3:
        return (f"wall_thickness {wall * 1e3:.3f} mm with the same reference ('{ref[:60]}') on {count} of "
                f"{total} lines across {len(bores)} bores ({', '.join(f'{b * 1e3:.3f}' for b in sorted(x for x in bores if x))} mm): "
                "copied line to line, not measured; the Korteweg correction rests on it")
    return None


def acoustics(prep: Any, series: Dict[str, Any], feed_path: Dict[str, Dict[str, Any]], i: int,
              f_chug: Sequence[float], E: float = TUBE_MODULUS_PA) -> Dict[str, Any]:
    """Quarter- and half-wave frequencies of every liquid line on each propellant path, and of the
    whole path, at series step ``i``; a mode within ``NEAR_CHUG`` of the chug band is flagged.

    Each line: CoolProp's speed of sound at the tank's liquid temperature and the line's mean
    pressure (tank outlet and line exit at that step), Korteweg-corrected for the drawing's bore
    and wall. f_1/4 = a/(4L) (open at the tank, closed at the injector), f_1/2 = a/(2L). Which end
    condition holds is set by the injector's impedance 2 dP_inj/mdot against the line's a/A: on LE4
    that ratio is ~0.13 (1.5e6 vs 1.2e7 Pa s/kg on the fuel side), nearer an open end, so the first
    mode lies between the two and the quarter-wave is the lower bound -- the side the near-chug
    flag should err on. The path
    uses its travel time sum(L_i/a_i). ``lumped_error`` is tan(kL)/kL - 1 at the top of the chug
    band: how far the lumped inertance L/A the chug model uses is from the line's distributed
    impedance there."""
    lo = min(f_chug) if f_chug else float("nan")
    hi = max(f_chug) if f_chug else float("nan")
    rows: List[Dict[str, Any]] = []
    flags: List[str] = []
    inputs: Dict[str, Any] = {}
    nodes = {n.id: n for n in getattr(getattr(prep.model, "diagram", None), "nodes", ())}

    def near(*fs: float) -> bool:
        return bool(math.isfinite(lo) and any(math.isfinite(f) and (1.0 - NEAR_CHUG) * lo <= f <= (1.0 + NEAR_CHUG) * hi
                                              for f in fs))

    for side, _, _, skey in SIDES:
        tank = nodes.get(prep.roles.get(side, ""))
        fluid = getattr(tank, "fluid", "") if tank is not None else ""
        s = series.get(skey) or {}
        T = _num((s.get("liquid_K") or [None] * (i + 1))[i])
        p_in = _num((s.get("inlet_psia") or [None] * (i + 1))[i])
        p_out = _num((s.get("outlet_psia") or [None] * (i + 1))[i]) or p_in
        if not fluid or T is None or p_in is None:
            flags.append(f"{side}: no fluid, liquid temperature or line pressure at this step; acoustics skipped")
            continue
        p = 0.5 * (p_in + p_out) * PSI
        try:
            rho, a0, name = _coolprop_liquid(fluid, T, p)
        except Exception as exc:  # noqa: BLE001 - a fluid CoolProp cannot state loses this side's rows, not the margin
            flags.append(f"{side}: CoolProp has no liquid state for {fluid!r} at {T:.1f} K, {p / PSI:.1f} psia "
                         f"({type(exc).__name__}); acoustics skipped")
            continue
        if not (math.isfinite(rho) and math.isfinite(a0) and a0 > 0):
            flags.append(f"{side}: CoolProp gave no finite sound speed for {name}; acoustics skipped")
            continue
        inputs[f"{side}.liquid"] = {"value": {"rho": rho, "a0": a0, "T_K": T, "p_psia": p / PSI}, "unit": "SI",
                                    "provenance": f"CoolProp {name} at the tank's liquid temperature and the line's mean pressure"}
        travel, length = 0.0, 0.0
        for ln in (feed_path.get(side) or {}).get("lines", []):
            L, d, e = ln.get("length_m"), ln.get("bore_m"), ln.get("wall_m")
            if not L or not d:
                continue
            a = korteweg(a0, rho, d, e or 0.0, E)
            if not e:
                flags.append(f"{ln['label']}: no wall thickness on the drawing; treated as rigid (a = a0, an upper bound)")
            fq, fh = a / (4.0 * L), a / (2.0 * L)
            rows.append({"line": ln["label"], "side": side, "length_m": L, "bore_m": d, "wall_m": e,
                         "a0_m_s": a0, "a_m_s": a, "f_quarter_hz": fq, "f_half_hz": fh, "near_chug": near(fq, fh),
                         "length_provenance": ln.get("length_provenance"), "wall_provenance": ln.get("wall_provenance")})
            travel += L / a
            length += L
        if travel > 0:
            fq, fh = 1.0 / (4.0 * travel), 1.0 / (2.0 * travel)
            kl = 2.0 * math.pi * hi * travel if math.isfinite(hi) else float("nan")
            rows.append({"line": f"{prep.roles.get(side, side)} outlet -> injector (whole path)", "side": side,
                         "length_m": length, "a_m_s": length / travel, "f_quarter_hz": fq, "f_half_hz": fh,
                         "near_chug": near(fq, fh),
                         "lumped_error": (math.tan(kl) / kl - 1.0) if (math.isfinite(kl) and 0 < kl < math.pi / 2) else None})
    copied = _wall_copied(prep)
    if copied:
        flags.append(copied)
    if any(r["near_chug"] for r in rows):
        flags.append("a feed-line mode sits within 20 % of the chug band: the lumped (no-compliance) line model is "
                     "not adequate there")
    inputs["tube_modulus"] = {"value": E, "unit": "Pa", "provenance": TUBE_MODULUS_SOURCE}
    inputs["near_chug_fraction"] = {"value": NEAR_CHUG, "unit": "-",
                                    "provenance": "assumed: reporting threshold, a line mode within this fraction "
                                                  "of the chug band is flagged"}
    return {"lines": rows, "flags": flags, "inputs": inputs, "chug_band_hz": [lo, hi]}


def _solve_point(runner: Any, cfg_now: Any, p_o: float, p_f: float) -> Tuple[float, Dict[str, Any]]:
    """EngineDesign's chamber at the line-exit pressures, on ``cfg_now``'s geometry, with the
    diagnostics the stability call reads (as ``TimeVaryingCoupledSolver.solve_time_step``)."""
    from engine.core.chamber_solver import ChamberSolver

    Pc, d = ChamberSolver(cfg_now, runner.cea_cache).solve(p_o, p_f, Pc_guess=None)
    MR, mt = d["MR"], d["mdot_total"]
    diag = {**d, "mdot_O": mt * MR / (1.0 + MR), "mdot_F": mt / (1.0 + MR), "P_tank_O": p_o, "P_tank_F": p_f}
    return float(Pc), diag


def _inputs(stab_config: Any, Pc: float, diag: Dict[str, Any], feed: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    from engine.pipeline.config_schemas import ensure_chamber_geometry
    from engine.pipeline.stability.analysis import build_stability_inputs

    return build_stability_inputs(stab_config, Pc, diag["MR"], diag["mdot_total"], diag["cstar_actual"],
                                  diag["gamma"], diag["R"], diag["Tc"], diag,
                                  ensure_chamber_geometry(stab_config), feed=feed)


def _step_point(series: Dict[str, Any], i: int) -> Dict[str, Any]:
    """An evaluation point at the twin's own step ``i`` (not a replay point)."""
    return {"t": float(series["t"][i]), "index": int(i), "k": None,
            "p_o": float(series["ox"]["inlet_psia"][i]) * PSI,
            "p_f": float(series["fuel"]["inlet_psia"][i]) * PSI}


def start_window_of(prep: Any, result: Dict[str, Any], feed_path: Dict[str, Dict[str, Any]],
                    start_window: Any = "auto", settle_tau: float = SETTLE_TAU) -> Dict[str, Any]:
    """When the chug margin starts to be graded [s after Fire] (audit D7-E).

    ``t_open``: the main valves on the propellant paths are fully open. From the recorded valve
    state when the run carries one (``result["network"]``), else Fire + the slowest main's travel
    (the drawing's ``travel_time``; the twin's ``Setup.valve_travel_s`` where the drawing has none).

    ``tau_line``: each side's line as an R-L element, tau = I mdot / (2 dP_leg), with I the
    drawing's sum of L/A and dP_leg the twin's tank-outlet -> chamber drop at the first fully-open
    step (audit 9.5: LOX 1.19 ms, fuel 4.94 ms on the helium drawing at t = 1.0 s). The injector
    passages' own inertance is not included (it adds ~10 % LOX, ~2 % fuel there).

    The window ends ``settle_tau`` line constants after ``t_open``. ``start_window`` given as a
    number overrides it (seconds after Fire)."""
    series = result["series"]
    t = [float(v) for v in series["t"]]
    fire = [i for i, f in enumerate(series["firing"]) if f]
    out: Dict[str, Any] = {"settle_tau": float(settle_tau), "t_fire": 0.0}
    travel: Dict[str, Dict[str, Any]] = {}
    for side, _, _, _ in SIDES:
        for o in (feed_path.get(side) or {}).get("others", []):
            if o.get("actuated") and o.get("travel"):
                travel[o["id"]] = o["travel"]
    t_open = None
    states = ((result.get("network") or {}).get("branches") or {})
    recorded = [states[v]["state"] for v in travel if isinstance(states.get(v), dict) and states[v].get("state")]
    if recorded and len(recorded) == len(travel) and fire and all(len(s) == len(t) for s in recorded):
        # The recording shows the opening only if some main is seen short of open at or before the
        # first firing step. feedtwin's trace reads a valve with no signal as fully open
        # (network_trace._opening), so "open from the first step" is no evidence: fall back to the
        # travel rule then, rather than grading from before Fire.
        def is_open(j: int) -> bool:
            return all((s[j] if s[j] is not None else 0.0) >= 0.999 for s in recorded)

        shut = next((j for j in range(fire[0] + 1) if not is_open(j)), None)
        k = next((j for j in range(shut, len(t)) if is_open(j)), None) if shut is not None else None
        if k is not None:
            t_open, out["t_open_basis"] = t[k], "recorded valve state"
    if t_open is None:
        slow = max((_num(v.get("value")) or 0.0 for v in travel.values()), default=0.0)
        t_open = slow
        out["t_open_basis"] = "Fire + the slowest main valve's travel"
    out["valve_travel"] = travel
    out["t_open"] = float(t_open)
    i_open = next((i for i in fire if t[i] >= t_open - 1e-9), fire[0] if fire else None)
    taus: Dict[str, Optional[float]] = {}
    pc = (series.get("chamber") or {}).get("pc_psia")
    for side, _, _, skey in SIDES:
        s = series.get(skey) or {}
        I = (feed_path.get(side) or {}).get("inertance")
        taus[side] = None
        if i_open is None or not I or not pc or not s.get("outlet_psia") or not s.get("mdot"):
            continue
        dp = (float(s["outlet_psia"][i_open]) - float(pc[i_open])) * PSI
        m = float(s["mdot"][i_open])
        if dp > 0 and m > 0:
            taus[side] = float(I * m / (2.0 * dp))
    out["tau_line_s"] = taus
    longest = max((v for v in taus.values() if v is not None), default=0.0)
    auto = float(t_open + settle_tau * longest)
    out["auto_s"] = auto
    if isinstance(start_window, (int, float)) and not isinstance(start_window, bool):
        out["start_window_s"] = float(start_window)
        out["window_basis"] = "given"
    else:
        out["start_window_s"] = auto
        out["window_basis"] = f"t_open + {settle_tau:g} x the longest line time constant"
    out["steps_inside"] = sum(1 for i in fire if t[i] < out["start_window_s"] - 1e-9)
    return out


# ---------------------------------------------------------------------------------------------
# the block
# ---------------------------------------------------------------------------------------------


def _drawing_feed_at(feed_path: Dict[str, Dict[str, Any]], series: Dict[str, Any], i: Optional[int],
                     diag: Dict[str, Any]) -> Tuple[Dict[str, Dict[str, float]], List[str]]:
    """The drawing basis's ``feed`` override at series index ``i``: per side, the drawing's
    inertance and dP = (tank outlet - line exit) + EngineDesign's exit dump. A side with nothing
    to give keeps the config's value (the key is left out)."""
    out: Dict[str, Dict[str, float]] = {}
    notes: List[str] = []
    for side, cside, key, skey in SIDES:
        f: Dict[str, float] = {}
        I = (feed_path.get(side) or {}).get("inertance")
        if I is not None and I > 0:
            f["inertance"] = float(I)
        else:
            notes.append(f"{side}: the drawing declares no line on the path; the config's inertance is kept")
        s = series.get(skey) or {}
        out_p, in_p = s.get("outlet_psia"), s.get("inlet_psia")
        dump = _num(diag.get(f"delta_p_feed_{key}"))
        if i is not None and out_p and in_p and dump is not None:
            line = (float(out_p[i]) - float(in_p[i])) * PSI
            if line < 0.0:
                notes.append(f"{side}: tank outlet below the line exit at t index {i} ({line / PSI:+.2f} psi); taken as 0")
                line = 0.0
            f["dP_feed"] = line + max(dump, 0.0)
        else:
            notes.append(f"{side}: no tank-outlet pressure in this run; the config's feed drop is kept")
        if f:
            out[cside] = f
    return out, notes


def stability_block(prep: Any, result: Dict[str, Any], config: Any = None, basis: str = "config",
                    eroded: bool = False, start_window: Any = "auto", *,
                    settle_tau: float = SETTLE_TAU, tube_modulus: float = TUBE_MODULUS_PA) -> Dict[str, Any]:
    """``diagnostics.stability`` (DATA-CONTRACT section 3) for one Layer X result.

    ``basis``: ``"config"`` (today's replay numbers, exactly) or ``"drawing"`` (the drawing's
    inertance and the twin's line drop as resistance). The other basis is always computed too and
    reported under ``other_basis``. ``eroded``: the stability call on each point's eroded geometry.
    ``start_window``: ``"auto"`` (valve travel + ``settle_tau`` line time constants) or a time
    after Fire [s]. Never raises; a failure is ``{"available": False, "error": ...}``.
    """
    try:
        return _block(prep, result, config, basis, bool(eroded), start_window, float(settle_tau),
                      float(tube_modulus))
    except Exception as exc:  # noqa: BLE001 - a failed diagnostic never takes the burn with it
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}


def _block(prep: Any, result: Dict[str, Any], config: Any, basis: str, eroded: bool, start_window: Any,
           settle_tau: float, tube_modulus: float = TUBE_MODULUS_PA) -> Dict[str, Any]:
    from engine.pipeline.config_schemas import ensure_chamber_geometry

    if basis not in ("config", "drawing"):
        raise ValueError(f"basis must be 'config' or 'drawing', not {basis!r}")
    series = result["series"]
    rp = result.get("replay") or {}
    runner = _runner(prep, config)
    base = runner.config
    design = ensure_chamber_geometry(copy.deepcopy(base))
    replayed = bool(rp.get("available")) and bool(rp.get("t"))
    geo = _replay_geometry(rp, design) if replayed else None
    feed_path = drawing_feed(prep)

    # ---- the points: the replay's (or, with no replay, the twin's own steps the replay would
    # have taken), every firing step inside the start window, and the first step after it
    if replayed:
        pts = [{"t": float(t), "index": int(i), "k": k, "p_o": float(po) * PSI, "p_f": float(pf) * PSI}
               for k, (t, i, po, pf) in enumerate(zip(rp["t"], rp["index"], rp["inlet_O_psia"], rp["inlet_F_psia"]))]
    else:
        from engine.layerx.replay import replay_indices

        pts = [_step_point(series, i) for i in replay_indices(series["firing"])]
    win = start_window_of(prep, result, feed_path, start_window, settle_tau)
    have = {p["index"] for p in pts}
    fire = [i for i, f in enumerate(series["firing"]) if f]
    inside = [i for i in fire if float(series["t"][i]) < win["start_window_s"] - 1e-9]
    if len(inside) > START_POINTS_MAX:
        inside = [inside[round(j * (len(inside) - 1) / (START_POINTS_MAX - 1))] for j in range(START_POINTS_MAX)]
    after = next((i for i in fire if float(series["t"][i]) >= win["start_window_s"] - 1e-9), None)
    extra = [i for i in dict.fromkeys(inside + ([after] if after is not None else [])) if i not in have]
    pts = sorted(pts + [_step_point(series, i) for i in extra], key=lambda p: (p["t"], p["k"] is None))

    rows = []
    for pt in pts:
        g = _geometry_at(geo, pt["t"], pt["k"])
        cfg_now = _with_geometry(base, g)
        row: Dict[str, Any] = {"t": pt["t"], "index": pt["index"], "replay_point": pt["k"] is not None}
        try:
            Pc, diag = _solve_point(runner, cfg_now, pt["p_o"], pt["p_f"])
            stab_cfg = cfg_now if (eroded and g is not None) else base
            inp_c = _inputs(stab_cfg, Pc, diag)
            fd, notes = _drawing_feed_at(feed_path, series, pt["index"], diag)
            inp_d = _inputs(stab_cfg, Pc, diag, feed=fd) if fd else inp_c
            row.update(pc_psia=Pc / PSI, config=_gate(inp_c), drawing=_gate(inp_d), notes=notes,
                       inp={"config": inp_c, "drawing": inp_d}, feed=fd)
        except Exception as exc:  # noqa: BLE001 - one point that does not solve is reported, not fatal
            row["error"] = f"{type(exc).__name__}: {exc}"
        rows.append(row)

    ok = [r for r in rows if "error" not in r]
    if not ok:
        raise RuntimeError("no point solved: " + "; ".join(r["error"] for r in rows[:3]))

    def series_of(b: str, key: str) -> List[Optional[float]]:
        return [(_num(r[b][key]) if "error" not in r else None) for r in rows]

    t_win = float(win["start_window_s"])
    settled = [r for r in ok if r["t"] >= t_win - 1e-9]

    def low(b: str, among: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not among:
            return None
        r = min(among, key=lambda r: r[b]["gate"])
        return {"t": r["t"], "index": r["index"], "margin": r[b]["gate"], "frequency_hz": r[b]["f_gate_hz"]}

    other = "drawing" if basis == "config" else "config"
    o_set, o_all = low(other, settled), low(other, ok)
    out: Dict[str, Any] = {
        "available": True,
        "basis": basis,
        "eroded": bool(eroded and geo is not None),
        "t": [r["t"] for r in rows],
        "index": [r["index"] for r in rows],
        "replay_point": [bool(r["replay_point"]) for r in rows],
        "in_start": [r["t"] < t_win - 1e-9 for r in rows],
        "margin": series_of(basis, "gate"),
        "frequency_hz": series_of(basis, "f_gate_hz"),
        "frequency_nominal_hz": series_of(basis, "f_nominal_hz"),
        "margin_nominal": series_of(basis, "gm_nominal"),
        # Every evaluated point, the start included: what the replay's "minimum" has always been.
        "worst": low(basis, ok),
        # The graded figure: from the first fully-open step plus the line settling (D7-E).
        "settled_min": low(basis, settled),
        "start_window_s": t_win,
        "start": win,
        "other_basis": {"basis": other,
                        "margin_min": o_set["margin"] if o_set else None,
                        "t": o_set["t"] if o_set else None,
                        "frequency_hz": o_set["frequency_hz"] if o_set else None,
                        "worst": o_all},
        "margin_other": series_of(other, "gate"),
    }
    # The Nyquist plot and the lag sweep at the graded worst point (the start's worst when nothing
    # is graded), on the active basis.
    pick = min(settled or ok, key=lambda r: r[basis]["gate"])
    inp = pick["inp"][basis]
    out["nyquist"] = _nyquist(inp, pick[basis], pick["t"])
    out["tau_sweep"] = {"t": pick["t"], **_tau_sweep(inp)}
    f_band = [r[basis]["f_gate_hz"] for r in (settled or ok) if _num(r[basis]["f_gate_hz"])]
    ac = acoustics(prep, series, feed_path, pick["index"], f_band, tube_modulus)
    out["acoustic"] = ac["lines"]
    out["acoustic_flags"] = ac["flags"]
    out["check"] = _check(rows, rp, eroded)
    out["feed"] = _feed_summary(feed_path, pick)
    errs = [f"t={r['t']:.3f}: {r['error']}" for r in rows if "error" in r]
    if errs:
        out["errors"] = errs
    flags: List[str] = []
    for side, _, _, _ in SIDES:
        flags += [f"{side}: {f}" for f in (feed_path.get(side) or {}).get("flags", [])]
        if any((ln.get("elevation_m") or 0.0) != 0.0 for ln in (feed_path.get(side) or {}).get("lines", [])):
            flags.append(f"{side}: a line on the path has a height; the tank-outlet -> line-exit drop then carries "
                         "the column's head, which is not resistance (drawing basis R overstated by it)")
    flags += list(pick.get("notes") or [])
    flags += ac["flags"]
    out["flags"] = list(dict.fromkeys(flags))
    out["model"] = _model(basis, out["eroded"], win, pick, feed_path, ac, tube_modulus)
    out["unmeasured"] = _unmeasured(pick, feed_path, win, tube_modulus)
    return out


SOURCE = ("EngineDesign's chug loop (engine/pipeline/stability/chug.py): F(s) = 1 + K_c/(theta_c s + 1) "
          "sum_k exp(-s tau_k)/(I_k s + R_k + 1/G_k), Nyquist gain margin over the mixing-lag band; double "
          "time lag after Leonardi, Nasuti, Di Matteo & Steelant, Acta Astronautica 139 (2017) 344-356; feed "
          "line inertia in the constant-lag chug loop after Summerfield, J. American Rocket Society 21(5) "
          "(1951) 108-114. Line waves: Korteweg, Annalen der Physik 241(12) (1878) 525-542, with CoolProp "
          "sound speeds (Bell et al., Ind. Eng. Chem. Res. 53(6) (2014) 2498-2508).")


def _model(basis: str, eroded: bool, win: Dict[str, Any], pick: Dict[str, Any], feed_path: Dict[str, Dict[str, Any]],
           ac: Dict[str, Any], E: float) -> Dict[str, Any]:
    """The ``model`` block: what produced the margin, and every input with where it came from."""
    inp = pick["inp"][basis]
    ch = inp["chamber"]
    inputs: Dict[str, Any] = {}
    for side, cside, key, _ in SIDES:
        st = next(x for x in inp["streams"] if x.name == key)
        lines = (feed_path.get(side) or {}).get("lines", [])
        drawn = basis == "drawing" and "inertance" in (pick.get("feed") or {}).get(cside, {})
        inputs[f"inertance_{key}"] = {
            "value": st.inertance(), "unit": "1/m",
            "provenance": ("drawing: sum L/A of " + ", ".join(f"{ln['label']} {ln['length_m']:g} m [{ln['length_provenance']}]"
                                                              for ln in lines))
            if drawn else f"engine config: feed_system.{cside}.length {st.feed_length:.4g} m / A_hydraulic {st.feed_area:.4g} m2"}
        lined = basis == "drawing" and "dP_feed" in (pick.get("feed") or {}).get(cside, {})
        inputs[f"dP_feed_{key}"] = {
            "value": st.dP_feed / PSI, "unit": "psi",
            "provenance": (f"twin: tank outlet -> line exit at t = {pick['t']:.3f} s, plus EngineDesign's exit dump "
                           "(K_exit rho v^2/2); R = 2 dP / mdot") if lined else
                          ("EngineDesign: the line-exit config's exit dump only (K0 and supply_K zeroed by "
                           "engine/layerx/card.py line_exit_config); R = 2 dP / mdot")}
        inputs[f"eta_inj_{key}"] = {"value": st.eta_inj, "unit": "-", "provenance": "EngineDesign closure at this point"}
        inputs[f"tau_{key}_ms"] = {"value": st.tau_conv * 1e3, "unit": "ms",
                                   "provenance": f"{inp['lag_model']} lag (convection {inp['convection_model']}) "
                                                 f"from the closure's SMD {inp[f'D32_{key}'] * 1e6:.0f} um"}
    inputs["K_c"] = {"value": ch.K_c(), "unit": "Pa.s/kg",
                     "provenance": f"c*/A_t, A_t {ch.A_t:.6g} m2 ({'eroded, this point' if eroded else 'design point, frozen'})"}
    inputs["theta_c_ms"] = {"value": ch.theta_c() * 1e3, "unit": "ms",
                            "provenance": f"L* c*/(R Tc), L* {ch.Lstar:.4g} m ({'eroded' if eroded else 'design'})"}
    band = inp.get("chug_band")
    inputs["mixing_lag_fraction_band"] = {"value": list(band) if band else None, "unit": "-",
                                          "provenance": "engine config stability.chug_band_mixing_lag_fraction_min/max: unmeasured"}
    for vid, tr in (win.get("valve_travel") or {}).items():
        inputs[f"travel_{vid}"] = tr
    inputs["settle_tau"] = {"value": win["settle_tau"], "unit": "line time constants",
                            "provenance": "assumed: 95 % of a first-order line's response"}
    inputs["start_window"] = {"value": win["start_window_s"], "unit": "s after Fire", "provenance": win["window_basis"]}
    inputs["tube_modulus"] = {"value": E, "unit": "Pa", "provenance": TUBE_MODULUS_SOURCE}
    inputs.update(ac.get("inputs") or {})
    return {
        "name": f"Chug gate, lumped feed / injector / chamber loop, {basis} feed basis"
                + (", eroded geometry" if eroded else ", design-point geometry"),
        "source": SOURCE,
        "assumptions": [
            "lumped lines (inertance and linearised resistance, no compliance): the line modes are checked "
            "against the chug band (acoustic)",
            "R = 2 dP/mdot, the slope of a quadratic loss. Line friction is slightly flatter (fluids' "
            "Colebrook slope dln dP/dln mdot ~1.83 on LE4's fuel run, 1.93 on the LOX run, drawn-tube "
            "roughness 1.5 um assumed); taking it would lower the drawing basis's gate by ~0.002 on LE4",
            "the regulator and ullage are an ideal pressure source at chug frequencies (stability.regulator_Z_hf "
            "0; audit 9.4 section 5 bounds them below 0.005 in GM); no manifold compliance",
            "the gate is the minimum over 5 points of the mixing-lag band, as EngineDesign grades it; tau_sweep "
            "shows the band densely",
            "valve bodies carry no length on the drawing: their inertance is not counted",
            "each point is quasi-steady: the twin's network is algebraic, so the start window is graded out, "
            "not simulated",
            "the line time constant leaves out the injector passages' own inertance",
        ],
        "inputs": inputs,
    }


def _unmeasured(pick: Dict[str, Any], feed_path: Dict[str, Dict[str, Any]], win: Dict[str, Any],
                E: float) -> List[Dict[str, Any]]:
    """The inputs nobody has measured that move this margin: for the uncertainty sweep."""
    inp = pick["inp"]["config"]
    band = inp.get("chug_band")
    g = pick["config"]
    out: List[Dict[str, Any]] = [
        {"name": "stability.mixing_lag_fraction", "value": inp.get("mixing_lag_fraction"), "unit": "-",
         "range": list(band) if band else None,
         "why": (f"the gate is taken at fraction {g['gate_fraction']}: GM {g['gm_nominal']:.2f} at the nominal "
                 f"lag, {g['gate']:.2f} at the gate (config basis, t = {pick['t']:.3f} s; see tau_sweep)")},
        {"name": "D32_F (ethanol SMD)", "value": inp["D32_F"] * 1e6, "unit": "um",
         "why": "tau_vap scales with D32^2 and the fuel paces the lag"},
        {"name": "D32_O (LOX SMD)", "value": inp["D32_O"] * 1e6, "unit": "um", "why": "the LOX lag"},
    ]
    for side, cside, _, _ in SIDES:
        for ln in (feed_path.get(side) or {}).get("lines", []):
            if "measured" not in (ln.get("length_provenance") or ""):
                out.append({"name": f"{ln['label']}.length", "value": ln["length_m"], "unit": "m",
                            "why": f"{side} inertance on the drawing basis ({ln['length_provenance']})"})
        for o in (feed_path.get(side) or {}).get("others", []):
            out.append({"name": f"{o['label']} body length", "value": None, "unit": "m",
                        "why": "not on the drawing; its inertance is left out"})
    out += [
        {"name": "feed_system.<side>.K_exit", "value": None, "unit": "-",
         "why": "the exit dump is part of R on both bases (Borda-Carnot 1.0 assumed by the schema)"},
        {"name": "settle_tau", "value": win["settle_tau"], "unit": "-", "why": "where the graded window starts"},
        {"name": "tube wall thickness", "value": None, "unit": "m",
         "why": "copied on the drawing; moves the line wave speed (not the chug margin)"},
        {"name": "tube Young's modulus", "value": E, "unit": "Pa",
         "why": "material not on the drawing; moves the line wave speed by ~0.3 % per 10 %"},
    ]
    return out


def _check(rows: List[Dict[str, Any]], rp: Dict[str, Any], eroded: bool) -> Optional[Dict[str, Any]]:
    """The config basis against the replay's own ``chug_margin`` at the replay points: the
    re-evaluation is the replay's computation, so this should be zero."""
    ref = rp.get("chug_margin") or []
    if not ref or bool(rp.get("chug_eroded_geometry", False)) != bool(eroded):
        return None
    diffs: List[float] = []
    k = 0
    for r in rows:
        if not r.get("replay_point"):
            continue
        if "error" not in r and k < len(ref) and ref[k] is not None:
            diffs.append(abs(r["config"]["gate"] - float(ref[k])))
        k += 1
    if not diffs:
        return None
    return {"against": "replay.chug_margin (config basis)", "points": len(diffs),
            "max_abs_diff": float(max(diffs))}


def _feed_summary(feed_path: Dict[str, Dict[str, Any]], r0: Dict[str, Any]) -> Dict[str, Any]:
    """Per side, the two bases' feed impedance at point ``r0`` (the graded worst)."""
    out: Dict[str, Any] = {}
    for side, cside, key, _ in SIDES:
        sc = next(s for s in r0["inp"]["config"]["streams"] if s.name == key)
        sd = next(s for s in r0["inp"]["drawing"]["streams"] if s.name == key)
        fp = feed_path.get(side) or {}
        out[side] = {
            "config": {"inertance": sc.inertance(), "resistance": sc.resistance(), "dP_feed_psi": sc.dP_feed / PSI},
            "drawing": {"inertance": sd.inertance(), "resistance": sd.resistance(), "dP_feed_psi": sd.dP_feed / PSI},
            "lines": [{k: ln[k] for k in ("id", "length_m", "bore_m", "inertance", "length_provenance", "bore_provenance")}
                      for ln in fp.get("lines", [])],
            "flags": list(fp.get("flags", [])),
        }
    return out
