"""Layer X water hammer: the pressure a main valve's closing (and the start's arrival) puts on each
liquid line, against the ratings on the drawing.

``waterhammer_from_run(prep, result, config=None, settings=HammerSettings(), start=None)``
-> ``diagnostics.water_hammer`` (a list, one row per liquid feed line; DATA-CONTRACT 3).

Three numbers per line, each with its source:

* **Joukowsky** (Joukowsky 1898): an instantaneous stop of a column moving at ``v0`` raises the
  pressure at the valve by ``dp = rho a v0``. The upper bound for any closure faster than the
  line's round trip ``2L/a``.
* **Slow closure** (Michaud's formula; J. Michaud, "Coups de bélier dans les conduites", Bull. Soc.
  Vaud. Ing. Arch., 1878): a closure that brings the velocity down linearly over
  ``t_c > 2L/a`` raises it by ``2 rho L v0 / t_c`` at most: each part of the velocity change sends a
  ``rho a dv`` wave up the line, and the tank's reflection cancels it after ``2L/a``, so the peak is
  ``rho a (v0/t_c)(2L/a)``. Checked here against the MOC with a prescribed linear-velocity closure
  (tests/test_layerx_transients.py), not against a book's printed equation.
* **The closure as drawn**, by the method of characteristics on the reservoir-pipe-valve system
  (Wylie & Streeter 1993, the MOC for a single pipeline with a reservoir upstream and a valve
  downstream): the tank holds its pressure behind the outlet loss; the pipe has the drawing's bore,
  length and friction; the main valve closes linearly in travel over ``closure_s`` along its own Cv
  characteristic, in series with the downstream line and the injector, quasi-steady, discharging
  into the chamber held at its pre-closure pressure. A linear-*travel* closure does most of its
  velocity change at the end of the stroke, so it can exceed Michaud's linear-*velocity* figure;
  in a line this short (no line packing) its first wave does not exceed Joukowsky. The MOC's step
  is ``L/(N a)`` with ``N`` at least ``n_reaches`` and enough reaches that the step is under
  ``max_step_s``: the effective closure of a large valve is a few ms, and 16 reaches on the 0.91 m
  fuel line (50 us) read the LE4 peak 1.3 % low against the converged value.

If the valve-end pressure falls below the liquid's vapour pressure the column separates; the MOC
is not valid past that instant and the cavity's collapse is not computed. The collapse can put a
short pulse on the line above the Joukowsky value (A. Bergant, A. R. Simpson and A. S. Tijsseling,
"Water hammer with column separation: a historical review", J. Fluids Struct. 22(2), 2006), so the
row then carries the Joukowsky value as the figure it is graded on and says it is not a bound.

The wave speed carries the Korteweg correction for the tube's elasticity,
``a = a_f / sqrt(1 + c1 K D / (E e))``, ``K = rho a_f^2`` (Korteweg 1878, in the form of Wylie &
Streeter 1993), with the liquid's own sound speed from CoolProp (feedtwin ``Fluid``), the bore and
wall from the drawing, ``E`` of 316 stainless (an input: 193 GPa, AK Steel 316/316L product data
bulletin, 28.0e6 psi, room temperature) and ``c1`` (1: a pipe free to move axially; an input).

The **opening surge** is the start's: the liquid filling the gas-filled manifold arrives at the
orifices at the flow ``diag.start`` computes (rigid column) and must slow to what the orifices pass.
Treated as the MOC valve boundary appearing instantly at the front: ``p = p_front + B (m_arr - m)``
with ``m = phi sqrt(p - Pc)``, ``B = a/A``. The gas cushion the last of the manifold gas gives is
ignored, so this is an upper bound.

Ratings: the drawing rates only the tanks (MAWP, estimated) and the bottle; no line, valve or
manifold carries a rating. Each line is graded against its tank's MAWP, read as gauge on the
standard atmosphere as feedtwin's trip reads it, and the row says so.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional

from engine.layerx.diag.start import (
    PSI, SIDES, feed_line, inp, linear_characteristic, model_block, unavailable,
)

MODEL_NAME = "water_hammer_moc"
STD_ATM_PSI = 14.695948775513449
E_316_PA = 193.0e9
E_316_SOURCE = ("assumed 193 GPa (28.0 x 10^6 psi): the room-temperature modulus producers' 316/316L data sheets "
                "list (the AK Steel 316/316L product data bulletin was cited from memory and not re-checked; a "
                "distributor's 316/316L technical data sheet gives 193 GPa); not corrected to LOX temperature "
                "(by Korteweg, a 10 % higher E moves the LE4 LOX wave speed by +0.3 %)")


# ------------------------------------------------------------------ closed forms


def wave_speed(a_fluid: float, rho: float, bore: float, wall: float, E: float = E_316_PA, c1: float = 1.0) -> float:
    """Korteweg: pressure-wave speed in a liquid-filled elastic tube [m/s]."""
    K = rho * a_fluid ** 2
    if wall <= 0.0 or not math.isfinite(E):
        return a_fluid
    return a_fluid / math.sqrt(1.0 + c1 * K * bore / (E * wall))


def joukowsky(rho: float, a: float, dv: float) -> float:
    """Joukowsky 1898: dp = rho a dv [Pa]."""
    return rho * a * dv


def michaud(rho: float, length: float, v0: float, closure_s: float, a: float) -> float:
    """Slow-closure bound for a linear velocity decrease over ``closure_s`` [Pa]; Joukowsky when
    the closure is inside the round trip 2L/a."""
    if closure_s <= 2.0 * length / a:
        return joukowsky(rho, a, v0)
    return 2.0 * rho * length * v0 / closure_s


def _solve_boundary(R: float, B: float, rhs: float) -> float:
    """``R m|m| + B m = rhs`` for m (monotone in m; written without cancellation)."""
    if rhs == 0.0:
        return 0.0
    s = 1.0 if rhs > 0.0 else -1.0
    a = abs(rhs)
    if R <= 0.0:
        return rhs / B
    return s * 2.0 * a / (B + math.sqrt(B * B + 4.0 * R * a))


# ------------------------------------------------------------------ method of characteristics


@dataclass(frozen=True)
class Pipeline:
    """Reservoir -> one pipe -> valve -> (quasi-steady downstream) -> chamber. SI."""

    rho: float
    a: float
    bore: float
    length: float
    p_tank: float
    mdot0: float
    R_entry: float = 0.0
    """Tank-outlet loss, Pa/(kg/s)^2 (K/(2 rho A^2))."""
    R_friction: float = 0.0
    """The pipe's whole friction loss, Pa/(kg/s)^2, spread over its reaches."""

    @property
    def area(self) -> float:
        return math.pi * self.bore ** 2 / 4.0


def moc(pipe: Pipeline, *, t_end: float, n_reaches: int = 16,
        valve_R: Optional[Callable[[float], float]] = None,
        valve_flow: Optional[Callable[[float], float]] = None,
        R_down0: Optional[float] = None) -> Dict[str, Any]:
    """Method of characteristics on the reservoir-pipe-valve line, in pressure and mass flow:

        C+:  p_P = p_A - B (m_P - m_A) - Rf m_A|m_A|        C-:  p_P = p_B + B (m_P - m_B) + Rf m_B|m_B|

    with ``B = a/A`` and ``Rf`` the reach's friction (Pa/(kg/s)^2). The valve end is either a
    resistance ``valve_R(t)`` [Pa/(kg/s)^2, inf = shut] to a downstream pressure set so the initial
    state is steady (``R_down0`` is its value at t = 0), or a prescribed flow ``valve_flow(t)``.
    Returns the valve-end pressure and flow histories and their extremes."""
    A = pipe.area
    B = pipe.a / A
    N = max(2, int(n_reaches))
    dx = pipe.length / N
    dt = dx / pipe.a
    Rf = pipe.R_friction / N
    m0 = pipe.mdot0
    p = [0.0] * (N + 1)
    m = [m0] * (N + 1)
    p[0] = pipe.p_tank - pipe.R_entry * m0 * abs(m0)
    for i in range(1, N + 1):
        p[i] = p[i - 1] - Rf * m0 * abs(m0)
    if valve_flow is None:
        if valve_R is None:
            raise ValueError("a valve resistance or a prescribed flow is needed")
        r0 = valve_R(0.0) if R_down0 is None else R_down0
        p_down = p[N] - r0 * m0 * abs(m0)
    else:
        p_down = 0.0
    ts, pv, mv = [0.0], [p[N]], [m0]
    steps = int(math.ceil(t_end / dt))
    for n in range(1, steps + 1):
        t = n * dt
        pn = [0.0] * (N + 1)
        mn = [0.0] * (N + 1)
        for i in range(1, N):
            cp = p[i - 1] + B * m[i - 1] - Rf * m[i - 1] * abs(m[i - 1])
            cm = p[i + 1] - B * m[i + 1] + Rf * m[i + 1] * abs(m[i + 1])
            mn[i] = (cp - cm) / (2.0 * B)
            pn[i] = 0.5 * (cp + cm)
        # Reservoir: p_0 = p_tank - R_entry m|m| on the C- characteristic.
        cm = p[1] - B * m[1] + Rf * m[1] * abs(m[1])
        mn[0] = _solve_boundary(pipe.R_entry, B, pipe.p_tank - cm)
        pn[0] = cm + B * mn[0]
        # Valve on the C+ characteristic.
        cp = p[N - 1] + B * m[N - 1] - Rf * m[N - 1] * abs(m[N - 1])
        if valve_flow is not None:
            mn[N] = valve_flow(t)
        else:
            R = valve_R(t)  # type: ignore[misc]
            mn[N] = 0.0 if not math.isfinite(R) else _solve_boundary(R, B, cp - p_down)
        pn[N] = cp - B * mn[N]
        p, m = pn, mn
        ts.append(t)
        pv.append(p[N])
        mv.append(m[N])
    return {"t": ts, "p_valve": pv, "m_valve": mv, "p0_valve": pv[0], "p_max": max(pv), "p_min": min(pv),
            "dt": dt, "B": B, "p_down": p_down, "n_reaches": N}


def opening_surge(*, p_front: float, pc: float, mdot_arrival: float, phi: float, B: float) -> Dict[str, float]:
    """The liquid front meets the orifices at ``mdot_arrival``: the orifice boundary appears at the
    front, ``p = p_front + B (m_arr - m)``, ``m = phi sqrt(p - Pc)``. Returns the peak and the flow."""
    R = 0.0 if not math.isfinite(phi) else 1.0 / phi ** 2
    cp = p_front + B * mdot_arrival
    m = _solve_boundary(R, B, cp - pc)
    return {"p_peak": cp - B * m, "mdot_after": m}


# ------------------------------------------------------------------ from a run


@dataclass(frozen=True)
class HammerSettings:
    closure_s: Optional[float] = None
    """Main-valve closing time [s]. None = the drawing's ``travel_time``."""
    E_wall_pa: float = E_316_PA
    c1: float = 1.0
    """Korteweg anchoring factor: 1 for a pipe free to move axially (expansion joints); 1 - nu^2
    for one anchored throughout (Wylie & Streeter 1993)."""
    n_reaches: int = 16
    """The fewest MOC reaches on the line."""
    max_step_s: float = 2.5e-5
    """The MOC's largest time step ``L/(N a)``: more reaches are used on a long line, so the few-ms
    effective closure of a large valve is resolved (LE4 fuel line: 32 reaches, converged to 0.01 %
    against 64)."""
    after_closure_s: float = 0.02
    """Integrated this long past the closure."""


def waterhammer_from_run(prep: Any, result: Mapping[str, Any], config: Any = None,
                         settings: HammerSettings = HammerSettings(),
                         start: Optional[Mapping[str, Any]] = None) -> List[Dict[str, Any]]:
    """``diagnostics.water_hammer`` rows. ``start`` is ``diagnostics.start`` (for the opening surge).
    Never raises: a line that cannot be computed is a row ``{line, side, available: false, error}``."""
    rows: List[Dict[str, Any]] = []
    for side, key in SIDES:
        try:
            rows.append(_row(prep, result, side, key, settings, start))
        except Exception as exc:  # noqa: BLE001
            rows.append({"line": None, "side": key, **unavailable(f"water hammer: {exc}")})
    return rows


def _row(prep: Any, result: Mapping[str, Any], side: str, key: str, settings: HammerSettings,
         start: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    series = result["series"]
    firing = [i for i, f in enumerate(series.get("firing") or []) if f]
    if not firing:
        raise ValueError("the burn never fired")
    sub = series[key]
    # Worst instant for a closure: the largest line flow while firing (the end of a rising burn).
    i = max(firing, key=lambda j: float(sub["mdot"][j]))
    m0 = float(sub["mdot"][i])
    p_tank = float(sub["tank_psia"][i]) * PSI
    T = float(sub["liquid_K"][i])
    pc = float(series["chamber"]["pc_psia"][i]) * PSI
    feed = feed_line(prep, side, mdot_ref=m0, p_ref=p_tank, T_ref=T)
    if feed.valve is None:
        raise ValueError("no main valve with a travel time on the drawn path")
    pipes = [e for e in feed.upstream if e.kind == "pipe"]
    if not pipes:
        raise ValueError("no drawn tube between the tank and the main valve")
    warnings: List[str] = list(feed.warnings)
    bores = {round(e.bore, 6) for e in pipes}
    if len(bores) > 1:
        warnings.append("the upstream tube changes bore; taken as one pipe at the bore nearest the valve")
    pipe0 = pipes[-1]
    L = sum(e.length for e in pipes)
    A = pipe0.area
    wall = pipe0.wall or 0.0
    a = wave_speed(feed.a_fluid, feed.rho, pipe0.bore, wall, settings.E_wall_pa, settings.c1)
    v0 = m0 / (feed.rho * A)
    closure = settings.closure_s if settings.closure_s is not None else float(feed.valve.travel_s or 0.0)
    # Split each upstream element's loss into the tank-outlet K (at the reservoir) and friction.
    comp = prep.model.built.network.branches[pipes[0].id].component
    inst_params = getattr(comp, "p", {}) or {}
    K_entry = float(inst_params.get("K_minor", 0.0) or 0.0)
    R_entry = K_entry / (2.0 * feed.rho * pipes[0].area ** 2)
    R_up_total = feed.sum("up", "R")
    R_fric = max(R_up_total - R_entry, 0.0)
    # Downstream of the seat, quasi-steady: the drawn tube after the valve and the injector (card
    # capacity at this step).
    p_in = float(sub["inlet_psia"][i]) * PSI
    phi = m0 / math.sqrt(max(p_in - pc, 1.0))
    R_rest = feed.sum("dn", "R") + 1.0 / phi ** 2
    R_v = feed.valve.R
    frac = feed.valve.cv_fraction or linear_characteristic

    def valve_R(t: float) -> float:
        if closure <= 0.0:
            return math.inf if t > 0.0 else R_v + R_rest
        x = 1.0 - t / closure
        f = frac(max(x, 0.0)) if x < 1.0 else 1.0
        return math.inf if f <= 0.0 else R_v / (f * f) + R_rest

    pipeline = Pipeline(rho=feed.rho, a=a, bore=pipe0.bore, length=L, p_tank=p_tank, mdot0=m0,
                        R_entry=R_entry, R_friction=R_fric)
    n_step = int(math.ceil(L / (a * settings.max_step_s))) if settings.max_step_s > 0 else 0
    n_reaches = max(int(settings.n_reaches), n_step)
    sim = moc(pipeline, t_end=max(closure, 0.0) + settings.after_closure_s, n_reaches=n_reaches,
              valve_R=valve_R, R_down0=R_v + R_rest)
    surge_moc = sim["p_max"] - sim["p0_valve"]
    jouk = joukowsky(feed.rho, a, v0)
    slow = michaud(feed.rho, L, v0, closure, a)
    separation = sim["p_min"] < feed.p_sat
    # Opening surge from the start model.
    opening: Dict[str, Any] = {"available": False}
    if start and start.get("available"):
        arr = (start.get("arrival_mdot") or {}).get(key)
        if arr:
            dn_pipes = [e for e in feed.downstream if e.kind == "pipe"]
            A_front = dn_pipes[-1].area if dn_pipes else A
            a_front = wave_speed(feed.a_fluid, feed.rho, dn_pipes[-1].bore if dn_pipes else pipe0.bore,
                                 (dn_pipes[-1].wall if dn_pipes else pipe0.wall) or 0.0, settings.E_wall_pa, settings.c1)
            phi_s = (((start.get("model") or {}).get("inputs") or {}).get(f"{key}.phi") or {}).get("value") or phi
            pa = float(prep.ambient_pa)
            o = opening_surge(p_front=pa, pc=pa, mdot_arrival=float(arr), phi=float(phi_s), B=a_front / A_front)
            opening = {"available": True, "peak_psia": o["p_peak"] / PSI, "arrival_mdot": float(arr),
                       "mdot_after": o["mdot_after"],
                       "basis": "start model's rigid-column arrival flow meeting the orifices (gas cushion ignored: "
                                "upper bound); at the manifold, which carries no rating"}
    tank = feed.tank
    mawp = ((prep.derived or {}).get("tank_mawp_psi") or {}).get(tank)
    rating = (float(mawp) + STD_ATM_PSI) if mawp is not None else None
    mawp_param = None
    try:
        mawp_param = prep.model.diagram.node(tank).params.get("MAWP")
    except Exception:  # noqa: BLE001
        pass
    rating_prov = (f"{tank} MAWP {mawp:.0f} psi, " + (f"{getattr(getattr(mawp_param, 'source', None), 'value', '')}"
                   if mawp_param is not None else "drawing") + "; read as gauge on the standard atmosphere "
                   "(feedtwin's trip); no line, valve or manifold rating is drawn") if mawp is not None else "no rating drawn"
    peak_close = sim["p_max"]
    peak_open = opening["peak_psia"] * PSI if opening.get("available") else 0.0
    peak, peak_source = (peak_close, "closure") if peak_close >= peak_open else (peak_open, "opening")
    if separation:
        # Below vapour pressure the column parts and the MOC no longer holds; the cavity's collapse
        # can put a spike on the line that this run does not compute. Grade on the larger of the
        # computed peak and the Joukowsky peak instead.
        warnings.append("column separation: the valve-end pressure falls below the liquid's vapour pressure after "
                        "the closure; the MOC is not valid past it and the cavity collapse is not computed. Graded on "
                        "the larger of the computed peak and the Joukowsky value, which is not an upper bound here: "
                        "a cavity's collapse can exceed it (Bergant, Simpson & Tijsseling, J. Fluids Struct. 22, 2006)")
        bound = sim["p0_valve"] + jouk
        if bound > peak:
            peak, peak_source = bound, "closure (Joukowsky value, column separation; the collapse can exceed it)"
    ok = None if rating is None else bool(peak / PSI <= rating)
    characteristic = str((getattr(prep.model.built.network.branches[feed.valve.id].component, "opt", {}) or {})
                         .get("characteristic", "linear"))
    inputs = {
        "length": inp(L, "m", "drawn tube, tank outlet to the main valve: " + " + ".join(e.id for e in pipes)),
        "bore": inp(pipe0.bore, "m", (pipe0.inputs.get(f"{pipe0.id}.bore") or {}).get("provenance", "drawing")),
        "wall": inp(wall, "m", ((pipe0.inputs.get(f"{pipe0.id}.wall_thickness") or {}).get("provenance", "drawing"))
                    + " -- flagged (AUDIT 6): one wall value is copy-pasted on every edge of the LE4 drawings"),
        "E_wall": inp(settings.E_wall_pa, "Pa", E_316_SOURCE),
        "c1": inp(settings.c1, "-", "assumed 1: tube free to move axially (Wylie & Streeter 1993)"),
        "a_fluid": inp(feed.a_fluid, "m/s", f"CoolProp via feedtwin Fluid('{feed.fluid}') at {p_tank / PSI:.1f} psia, {T:.2f} K"),
        "rho": inp(feed.rho, "kg/m^3", f"CoolProp via feedtwin Fluid('{feed.fluid}')"),
        "mdot0": inp(m0, "kg/s", f"largest line flow while firing (series, t = {float(series['t'][i]):.3f} s)"),
        "p_tank": inp(p_tank / PSI, "psia", "tank at that step (series)"),
        "closure_s": inp(closure, "s", ((feed.valve.inputs.get(f"{feed.valve.id}.travel_time") or {}).get(
                             "provenance", "drawing main-valve travel_time") + " (AUDIT 6: no test cited)")
                         if settings.closure_s is None else "setting"),
        "n_reaches": inp(sim["n_reaches"], "-", f"MOC reaches: at least {settings.n_reaches}, and a step under "
                         f"{settings.max_step_s:g} s"),
        "K_entry": inp(K_entry, "-", "drawing K_minor of the first tube (tank exit)"),
        "characteristic": inp(characteristic, "-", "the main valve's Cv characteristic as the twin builds it (the drawn "
                              "mains declare none, so feedtwin's default; AUDIT 9.5 §5). With a valve this large against "
                              "the line and injector, the flow falls only in the last few % of travel, so the effective "
                              "closure is a few ms, not the full travel"),
        "p_sat": inp(feed.p_sat / PSI, "psia", "vapour pressure at the liquid temperature (feedtwin Fluid)"),
    }
    model = model_block(
        MODEL_NAME,
        "Joukowsky (1898) dp = rho a dv; Michaud's (1878) slow-closure figure 2 rho L v0 / t_c; the method of "
        "characteristics for a reservoir-pipe-valve line and the Korteweg wave speed (Wylie & Streeter, Fluid "
        "Transients in Systems, 1993); opening surge as the MOC orifice boundary at the arriving front.",
        [
            "the tank holds its pressure behind the outlet loss (ullage compliance >> line compliance)",
            "the upstream tube is one pipe at the bore nearest the valve; friction steady (frozen factor)",
            "the valve closes linearly in travel along its Cv characteristic; downstream of the seat the tube and "
            "injector are quasi-steady and discharge to the chamber held at its pre-closure pressure (a Pc that "
            "decays during the closure keeps more flow through the last of the travel and steepens the stop, so "
            "the computed peak can be low; Joukowsky is the first-wave limit)",
            "the liquid column downstream of the seat is not followed: its own suction and column separation at "
            "the seat's downstream face are not computed",
            "worst instant: the largest line flow of the burn, at that step's tank pressure",
            "column separation (pressure below vapour) ends the MOC's validity; it is flagged, not modelled, and "
            "graded on the Joukowsky value, which a cavity's collapse can exceed",
            "the opening surge ignores the gas cushion in the manifold (upper bound)",
            "ratings: only the tanks are rated on the drawing (MAWP, estimated); lines are graded against them",
        ],
        inputs)
    return {
        "line": "+".join(e.id for e in pipes), "side": key, "valve": feed.valve.id, "available": True,
        "closure_s": closure,
        "joukowsky_psi": jouk / PSI,
        "slow_close_psi": slow / PSI,
        "moc_surge_psi": surge_moc / PSI,
        "peak_psia": peak / PSI,
        "peak_source": peak_source,
        "close_peak_psia": peak_close / PSI,
        "min_psia": sim["p_min"] / PSI,
        "column_separation": bool(separation),
        "opening": opening,
        "rating_psia": rating,
        "rating_basis": rating_prov,
        "ok": ok,
        "wave_speed_m_s": a, "v0_m_s": v0, "length_m": L, "round_trip_s": 2.0 * L / a,
        "at_s": float(series["t"][i]),
        "warnings": warnings,
        "unmeasured": [f"closure time (travel {closure:g} s, no test cited)", "main valve Cv characteristic (not drawn)",
                       "tube wall (copy-pasted on the drawing)",
                       "E at LOX temperature", "c1 (tube anchoring)", "line and manifold pressure ratings",
                       "manifold gas cushion at priming"],
        "model": model,
    }
