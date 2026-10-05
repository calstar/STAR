"""Layer X start transient: Fire to settled flow, as a reduced-order model of its own.

``start_from_run(prep, result, config=None, settings=StartSettings())`` -> ``diagnostics.start``
(DATA-CONTRACT 3). ``run_start(ox, fuel, chamber, ...)`` is the model on plain inputs.

The main burn does not change. The twin's network is algebraic: its first firing step is
already at full flow (AUDIT 9.5 §1, §5), so the start is a diagnostic beside the burn and a
correction estimate (the impulse the start costs), never an edit of the burn.

The model
---------
Each side is one liquid column, tank outlet to injector orifices, in lumped (rigid-column)
form, the inertance-resistance line of AUDIT 7 item 1:

    I dm/dt = p_tank - p_end - R m|m|            I = sum L/A    [1/m],  R [Pa/(kg/s)^2]

* **Valve.** The drawing's main valve opens on command as a linear travel over its drawn
  ``travel_time``; its Cv follows the valve's own inherent characteristic (feedtwin
  ``Valve.effective_cv``), and its loss is feedtwin's (``fluids`` Cv-to-K), so
  ``R_valve(x) = R_valve(1) (Cv(1)/Cv(x))^2``.
* **Lines.** Each element's quadratic loss is the twin's own ``pressure_drop`` (Darcy with the
  drawing's friction correlation and ``K_minor``) at the main burn's first settled flow, divided
  by that flow squared: the friction factor is frozen there.
* **Priming.** Downstream of the main valve the line, the injector manifold and the orifices are
  gas-filled at Fire (AUDIT 9.5 §4: the twin holds them liquid at 101 kPa, which would flash).
  The liquid front fills that volume; the gas it displaces vents through the orifices into the
  chamber. While it fills, the column's inertance grows with the length of downstream tube it
  occupies, its end pressure is the chamber's (ambient before ignition: the displaced gas's
  orifice drop, ``rho_g/2 (Q/A_orifices)^2``, is under 7 kPa at LE4's arrival flows against ~3.9 MPa of
  drive, and is neglected), and the liquid
  entering the gas volume loses ``K_exit_prime`` velocity heads at the last drawn tube's bore (1: the
  "1" of Liou & Hunt's ``(1 + K)``, the velocity head the growing column carries, which is also the
  Borda dump of a front entering a larger volume; their entrance ``K`` is the drawing's tank-exit
  ``K_minor``, already in the line loss). This is the
  rigid-column filling model: the unsteady Bernoulli/momentum balance on a column of growing
  length entering from a reservoir, ``rho l dv/dt = p_res - p_front - (1 + K) rho v^2/2 - f l rho v^2/(2D)``
  (Liou & Hunt, "Filling of pipelines with undulating elevation profiles", J. Hydraul. Eng.
  122(10), 1996, rigid-column model). Once the manifold is full the injector's capacity takes
  over: ``m = phi sqrt(p_line_exit - Pc)`` (the engine card's capacity, which owns the dump and
  the orifices, engine/layerx/card.py), and the orifice passages add their inertance.
* **Ignition** is when both manifolds are primed, plus ``ignition_delay_s`` (an explicit input:
  0 = the igniter is lit and propellant ignites on arrival). Before it the chamber is at
  ambient (cold flow through the throat costs ~1 kPa).
* **Chamber filling** after ignition: ``dPc/dt = (R T / V)(m_in - Pc A_t / c*)`` with
  ``R T = (Gamma c*)^2`` (the ideal-rocket identity c* = sqrt(R T)/Gamma, Sutton & Biblarz,
  Rocket Propulsion Elements, the characteristic-velocity relation), c* from the engine card at the instantaneous O/F and
  flow, and propellant burning on arrival (no vaporisation lag; the chug model owns that lag).
  The chamber's time constant is ``L* / (Gamma^2 c*)`` (AUDIT 9.5 §1: 2.1 ms on LE4).
* **Thrust** is the card's vacuum exhaust velocity times the nozzle flow, less ``p_a A_e``,
  floored at zero (a separated nozzle at low Pc is not modelled; it would give more thrust than
  this, so the deficit here is the larger figure).

Integration is backward Euler on each column with the quadratic loss solved exactly (stable for
any valve opening, exact for an inertance-only line), and backward Euler on the chamber, at a
fixed ``dt`` (10 us default, 200x below the shortest line constant on LE4).

What it reports
---------------
* ``prime_ox_s``, ``prime_fuel_s``, ``ignition_s``; Pc, flows and O/F through the start.
* ``impulse_deficit_Ns``: the total impulse a burn with this start delivers less than the main
  burn, at a **fixed propellant load**. The start window (Fire to settled) is credited at the
  main burn's first settled thrust in the main burn (its first firing step is at full flow and
  is copied back to Fire, replay.timeseries_payload); the propellant the start did not spend is
  burned at the end at the main burn's end-of-burn exhaust velocity, limited by whichever tank
  runs dry, so a fuel lead that eats into fuel the main burn strands costs less than its mass.
  The mass that fills the downstream line and manifold is not charged: like the twin's massless
  lines, it is pushed through at burnout.
* ``hard_start``: a **heuristic** (no cited criterion): propellant both sides have injected and
  not yet burned at ignition, paired at the design O/F, against the chamber's own steady gas
  inventory ``Pc V / (Gamma c*)^2``. Over ``hard_start_ratio`` (1.0) of it, burning that pair at
  once in the chamber volume would by itself exceed the steady chamber pressure.

Limits (stated in the model block): tank pressure held at its T-0 value through the start; the
line is incompressible (the arrival surge at the orifices is reported as the rigid-column
orifice back-pressure; its compressible part is water hammer, ``diag.waterhammer``); the
manifold fills before any orifice flows; the friction factor is frozen at the settled flow; the
engine card is clipped to its table (flagged by how often).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

PSI = 6894.757293168361
G0 = 9.80665
SIDES = (("oxidiser", "ox"), ("fuel", "fuel"))

MODEL_NAME = "start_transient_rigid_column"


# ------------------------------------------------------------------ shared helpers


def inp(value: Any, unit: str, provenance: str) -> Dict[str, Any]:
    """One entry of a model block's ``inputs`` (DATA-CONTRACT)."""
    if isinstance(value, float) and not math.isfinite(value):
        value = None
    return {"value": value, "unit": unit, "provenance": provenance}


def model_block(name: str, source: str, assumptions: Sequence[str],
                inputs: Mapping[str, Dict[str, Any]]) -> Dict[str, Any]:
    """DATA-CONTRACT ``model``: what produced a block, so the run record can list it."""
    return {"name": name, "source": source, "assumptions": list(assumptions), "inputs": dict(inputs)}


def unavailable(error: str) -> Dict[str, Any]:
    """DATA-CONTRACT: a block that could not be computed. It never raises."""
    return {"available": False, "error": str(error)}


def finite(x: Any) -> Optional[float]:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def param_provenance(param: Any, note: str = "") -> str:
    """``"<source>: <reference>"`` for a feedtwin ``Param`` (a drawing value), plus a note."""
    if param is None:
        return note or "not drawn"
    src = getattr(getattr(param, "source", None), "value", getattr(param, "source", ""))
    ref = getattr(param, "reference", "") or ""
    text = f"drawing, {src}" + (f": {ref}" if ref else "")
    return text + (f" -- {note}" if note else "")


# ------------------------------------------------------------------ the column and the chamber


def column_step(m: float, dp: float, inertance: float, resistance: float, dt: float) -> float:
    """One backward-Euler step of ``I dm/dt = dp - R m|m|``, the quadratic solved exactly.

    ``I (m' - m)/dt = dp - R m'|m'|``. Unconditionally stable for ``R >= 0`` (a nearly shut
    valve is a huge R and a tiny time constant ``I/(2 R m)``), and exact when ``R = 0``.
    With no inertance it is the quasi-steady ``m = sign(dp) sqrt(|dp|/R)``.
    """
    if resistance <= 0.0:
        if inertance <= 0.0:
            raise ValueError("a column needs an inertance or a resistance")
        return m + dp * dt / inertance
    b = inertance / dt if inertance > 0.0 else 0.0
    drive = dp + b * m
    if drive == 0.0:
        return 0.0
    s = 1.0 if drive > 0.0 else -1.0
    a = abs(drive)
    # R m^2 + b m - a = 0 for m >= 0, written without cancellation.
    return s * 2.0 * a / (b + math.sqrt(b * b + 4.0 * resistance * a))


def chamber_step(pc: float, mdot_in: float, rt_over_v: float, at_over_cstar: float, dt: float) -> float:
    """One backward-Euler step of ``dPc/dt = (RT/V)(m_in - Pc A_t/c*)``."""
    k = rt_over_v * dt
    return (pc + k * mdot_in) / (1.0 + k * at_over_cstar)


def gamma_function(gamma: float) -> float:
    """Vandenkerckhove's Gamma = sqrt(g) (2/(g+1))^((g+1)/(2(g-1))); the ideal-rocket mass-flow function (Sutton & Biblarz, Rocket Propulsion Elements)."""
    return math.sqrt(gamma) * (2.0 / (gamma + 1.0)) ** ((gamma + 1.0) / (2.0 * (gamma - 1.0)))


def linear_characteristic(x: float) -> float:
    return min(max(x, 0.0), 1.0)


# ------------------------------------------------------------------ inputs


@dataclass(frozen=True)
class StartLine:
    """One side's column, tank outlet to injector orifices. SI throughout."""

    key: str
    """``ox`` or ``fuel``."""
    rho: float
    p_tank: float
    """Ullage pressure held through the start [Pa abs]."""
    I_up: float
    """Inertance upstream of the main valve, sum L/A [1/m]."""
    R_up: float
    """Quadratic loss upstream of the main valve [Pa/(kg/s)^2]."""
    R_valve_open: float
    travel_s: float
    t_open: float
    """Valve command time [s, Fire = 0]."""
    I_dn: float = 0.0
    """Inertance of the downstream tube when full [1/m]."""
    V_dn_line: float = 0.0
    """Downstream tube volume [m^3] (the part whose inertance grows as it fills)."""
    R_dn: float = 0.0
    V_manifold: float = 0.0
    """Manifold, orifice passages and valve-body volume downstream of the seat [m^3]."""
    A_exit: float = 0.0
    """Bore area the liquid enters the gas volume through [m^2] (for the priming dump)."""
    K_exit_prime: float = 1.0
    """Velocity heads lost by the liquid entering the gas volume while priming."""
    I_inj: float = 0.0
    phi: float = math.inf
    """Injector capacity m/sqrt(p_line_exit - Pc) [kg/s/sqrt(Pa)]; inf = no injector loss."""
    dp_static: float = 0.0
    """Static head helping the flow, -rho g dz summed along the line [Pa]."""
    cv_fraction: Callable[[float], float] = linear_characteristic
    inputs: Dict[str, Dict[str, Any]] = field(default_factory=dict)

    @property
    def V_prime(self) -> float:
        return max(self.V_dn_line, 0.0) + max(self.V_manifold, 0.0)

    @property
    def R_head(self) -> float:
        if self.K_exit_prime <= 0.0 or self.A_exit <= 0.0:
            return 0.0
        return self.K_exit_prime / (2.0 * self.rho * self.A_exit ** 2)

    @property
    def R_inj(self) -> float:
        return 0.0 if not math.isfinite(self.phi) else 1.0 / self.phi ** 2


@dataclass(frozen=True)
class StartChamber:
    volume: float
    throat_area: float
    exit_area: float
    ambient_pa: float
    gamma: float
    cstar: Callable[[float, float], float]
    """``(O/F, total mass flow) -> c*`` [m/s]."""
    vvac: Callable[[float, float], float]
    """``(O/F, total mass flow) -> vacuum exhaust velocity`` [m/s]."""
    ignition_delay_s: float = 0.0
    mr_design: float = 1.5
    hard_start_ratio: float = 1.0
    retained_fraction: float = 1.0
    """Fraction of the propellant injected before ignition still in the chamber at ignition."""
    inputs: Dict[str, Dict[str, Any]] = field(default_factory=dict)


@dataclass(frozen=True)
class StartSettings:
    """What a person chooses for the start model. Every default is today's behaviour or stated."""

    fuel_lead_s: float = 0.0
    """Fuel main commanded this long before the LOX main (LOX main at Fire = 0). 0 = today's
    DAQ table, both mains together in ``Fire``. The team's real sequence has a heavy lead."""
    ignition_delay_s: float = 0.0
    """From both manifolds primed to ignition. 0 = ignites on arrival. Unmeasured."""
    valve_travel_s: Optional[float] = None
    """Both mains' opening travel [s], restated for this diagnostic. None = each main's drawn
    ``travel_time`` (the burn's own)."""
    valve_body_volume_L: Tuple[float, float] = (0.0, 0.0)
    """(LOX, fuel) valve-body volume downstream of the seat [L]: not drawn."""
    K_exit_prime: float = 1.0
    hard_start_ratio: float = 1.0
    retained_fraction: float = 1.0
    dt: float = 1.0e-5
    horizon_s: float = 0.25
    """Integrated this long past the last main reaching full travel."""
    settle_tol: float = 0.01
    record_every_s: float = 5.0e-4


# ------------------------------------------------------------------ the model


def _interp_time(t0: float, dt: float, v0: float, v1: float, target: float) -> float:
    if v1 == v0:
        return t0 + dt
    return t0 + dt * min(max((target - v0) / (v1 - v0), 0.0), 1.0)


def run_start(ox: StartLine, fuel: StartLine, chamber: StartChamber, *, dt: float = 1.0e-5,
              horizon_s: float = 0.25, settle_tol: float = 0.01,
              record_every_s: float = 5.0e-4) -> Dict[str, Any]:
    """Integrate the start. Returns the time histories and the event times (SI, Pa)."""
    lines = (ox, fuel)
    opened = [ln for ln in lines if math.isfinite(ln.t_open)]
    if not opened:
        raise ValueError("neither main valve is ever commanded open")
    t_begin = min(min(ln.t_open for ln in opened), 0.0)
    t_full = max(ln.t_open + max(ln.travel_s, 0.0) for ln in opened)
    t_end = t_full + horizon_s
    n_steps = int(math.ceil((t_end - t_begin) / dt))
    every = max(1, int(round(record_every_s / dt)))
    Gam = gamma_function(chamber.gamma)
    pa = chamber.ambient_pa

    m = [0.0, 0.0]              # line flow
    vf = [0.0, 0.0]             # liquid volume downstream of the seat
    primed = [ln.V_prime <= 0.0 for ln in lines]
    t_prime: List[Optional[float]] = [None, None]
    arrival_m: List[Optional[float]] = [None, None]
    pre_ign = [0.0, 0.0]        # injected before ignition [kg]
    injected = [0.0, 0.0]       # injected over the whole start [kg]
    pc = pa
    ignited = False
    t_ign: Optional[float] = None
    spike_pa = 0.0
    pair_kg = 0.0
    clipped = 0
    burning_steps = 0

    rec: Dict[str, List[Any]] = {k: [] for k in ("t", "pc", "m_ox", "m_fu", "line_ox", "line_fu", "mr", "F",
                                                 "x_ox", "x_fu")}
    thrust_trace: List[Tuple[float, float, float, float]] = []   # (t, F, m_inj_ox, m_inj_fu) every step

    for n in range(n_steps + 1):
        t = t_begin + n * dt
        m_inj = [0.0, 0.0]
        xs = [0.0, 0.0]
        for i, ln in enumerate(lines):
            if t <= ln.t_open:
                continue
            if t_prime[i] is None and primed[i]:
                t_prime[i] = ln.t_open        # nothing to fill: primed the moment it opens
                arrival_m[i] = 0.0
            x = 1.0 if ln.travel_s <= 0.0 else min((t - ln.t_open) / ln.travel_s, 1.0)
            xs[i] = x
            frac = ln.cv_fraction(x)
            if frac <= 0.0:
                m[i] = 0.0
                continue
            r_valve = ln.R_valve_open / (frac * frac)
            p_end = pc
            if not primed[i]:
                f = min(vf[i] / ln.V_dn_line, 1.0) if ln.V_dn_line > 0.0 else 1.0
                inert = ln.I_up + f * ln.I_dn
                res = ln.R_up + r_valve + f * ln.R_dn + ln.R_head
            else:
                inert = ln.I_up + ln.I_dn + ln.I_inj
                res = ln.R_up + r_valve + ln.R_dn + ln.R_inj
            m_old = m[i]
            m[i] = column_step(m_old, ln.p_tank + ln.dp_static - p_end, inert, res, dt)
            if not primed[i]:
                v_old = vf[i]
                vf[i] = v_old + 0.5 * (m_old + m[i]) / ln.rho * dt
                if vf[i] >= ln.V_prime:
                    primed[i] = True
                    t_prime[i] = _interp_time(t - dt, dt, v_old, vf[i], ln.V_prime)
                    arrival_m[i] = m[i]
                    # The liquid past the manifold this step has reached the orifices.
                    m_inj[i] = m[i] * (vf[i] - ln.V_prime) / max(vf[i] - v_old, 1e-300)
            else:
                m_inj[i] = m[i]
            injected[i] += m_inj[i] * dt

        both = primed[0] and primed[1] and t_prime[0] is not None and t_prime[1] is not None
        if not ignited:
            for i in range(2):
                pre_ign[i] += m_inj[i] * dt
            if both and t >= max(t_prime[0], t_prime[1]) + chamber.ignition_delay_s:  # type: ignore[arg-type]
                ignited = True
                t_ign = max(t_prime[0], t_prime[1]) + chamber.ignition_delay_s  # type: ignore[arg-type]
                mr_d = chamber.mr_design
                acc_ox = chamber.retained_fraction * pre_ign[0]
                acc_fu = chamber.retained_fraction * pre_ign[1]
                pair_kg = min(acc_ox, mr_d * acc_fu) * (1.0 + 1.0 / mr_d)
                cs0, _ = _call(chamber.cstar, mr_d, max(m[0] + m[1], 1e-9))
                spike_pa = pair_kg * (Gam * cs0) ** 2 / chamber.volume
                pc = pa + spike_pa
        F = 0.0
        mdot_in = m_inj[0] + m_inj[1]
        mr = (m_inj[0] / m_inj[1]) if m_inj[1] > 0.0 else (None if m_inj[0] <= 0.0 else math.inf)
        if ignited:
            burning_steps += 1
            mr_eval = mr if (mr is not None and math.isfinite(mr)) else chamber.mr_design
            cs, was_clipped = _call(chamber.cstar, mr_eval, mdot_in)
            clipped += was_clipped
            rt_v = (Gam * cs) ** 2 / chamber.volume
            pc = chamber_step(pc, mdot_in, rt_v, chamber.throat_area / cs, dt)
            m_noz = pc * chamber.throat_area / cs
            vv, _ = _call(chamber.vvac, mr_eval, m_noz)
            F = max(0.0, vv * m_noz - pa * chamber.exit_area)
        else:
            pc = pa
        thrust_trace.append((t, F, m_inj[0], m_inj[1]))
        if n % every == 0 or n == n_steps:
            rec["t"].append(t)
            rec["pc"].append(pc)
            rec["m_ox"].append(m_inj[0])
            rec["m_fu"].append(m_inj[1])
            rec["line_ox"].append(m[0])
            rec["line_fu"].append(m[1])
            rec["mr"].append(None if mr is None or not math.isfinite(mr) else mr)
            rec["F"].append(F)
            rec["x_ox"].append(xs[0])
            rec["x_fu"].append(xs[1])

    # Settling: the last instant any of Pc and the two injected flows is outside the band of
    # its final value.
    final = thrust_trace[-1]
    pc_end, F_end = pc, final[1]
    m_end = (final[2], final[3])
    t_settle = None
    if ignited:
        t_settle = _settle_time(thrust_trace, m_end, F_end, settle_tol, t_ign or 0.0)
    return {
        "t_begin": t_begin, "t_end": t_end, "dt": dt, "trace": thrust_trace, "rec": rec,
        "t_prime": t_prime, "arrival_mdot": arrival_m, "t_ignition": t_ign, "ignited": ignited,
        "pre_ignition_kg": pre_ign, "injected_kg": injected, "pair_kg": pair_kg, "spike_pa": spike_pa,
        "pc_end": pc_end, "F_end": F_end, "mdot_end": m_end, "t_settle": t_settle,
        "card_clipped_frac": (clipped / burning_steps) if burning_steps else 0.0,
        "gamma_fn": Gam, "line_end": tuple(m),
    }


def _call(fn: Callable[[float, float], float], a: float, b: float) -> Tuple[float, int]:
    """``fn(a, b)``; a function that clips (an engine card table) says so through a
    ``(value, clipped)`` tuple, a plain function returns a float."""
    out = fn(a, b)
    if isinstance(out, tuple):
        return float(out[0]), int(bool(out[1]))
    return float(out), 0


def _settle_time(trace: List[Tuple[float, float, float, float]], m_end: Tuple[float, float],
                 F_end: float, tol: float, t_ign: float) -> Optional[float]:
    """The last instant thrust or either injected flow is outside ``tol`` of its final value."""
    last_out = t_ign
    for t, F, mo, mf in trace:
        if t < t_ign:
            continue
        if (abs(F - F_end) > tol * abs(F_end) or abs(mo - m_end[0]) > tol * abs(m_end[0])
                or abs(mf - m_end[1]) > tol * abs(m_end[1])):
            last_out = t
    return last_out


# ------------------------------------------------------------------ the impulse the start costs


def fixed_load_deficit(*, trace: Sequence[Tuple[float, float, float, float]], t_window: float,
                       F_settled: float, mdot_settled: Tuple[float, float],
                       scale_F: float = 1.0, scale_m: Tuple[float, float] = (1.0, 1.0),
                       c_end: float, mr_end: float, residual_extra: Tuple[float, float]) -> Dict[str, float]:
    """Total impulse lost to the start at a fixed propellant load [N s].

    The main burn credits ``F_settled`` from Fire to ``t_window`` and spends ``mdot_settled``
    per side over it. The start delivers ``J_s`` and spends ``m_s`` (injected) over the same
    window. After the window the two burns are the same burn, except at the end: the real one
    has ``E = (mdot_settled t_w - m_s) + residual_extra`` more of each propellant than the main
    burn had when it ended, burned at O/F ``mr_end`` until the first side runs out, at
    ``c_end`` [m/s]. ``residual_extra`` is each side's main-burn residual over the dry mass.

        deficit = (F_settled t_w - J_s) - c_end * min(E_ox, mr_end E_fu) (1 + 1/mr_end)

    ``trace`` is ``(t, F, m_ox_injected, m_fuel_injected)`` at a fixed step from the start's
    first valve command; ``scale_*`` put the model's own steady state on the main burn's scale.
    """
    J_s, m_ox, m_fu, J_w = 0.0, 0.0, 0.0, 0.0
    for k in range(1, len(trace)):
        t0, F0, o0, f0 = trace[k - 1]
        t1, F1, o1, f1 = trace[k]
        if t0 >= t_window:
            break
        h = min(t1, t_window) - t0
        if h <= 0.0:
            continue
        J_s += 0.5 * (F0 + F1) * h
        m_ox += 0.5 * (o0 + o1) * h
        m_fu += 0.5 * (f0 + f1) * h
        lo = max(t0, 0.0)
        if min(t1, t_window) > lo:
            J_w += 0.5 * (F0 + F1) * (min(t1, t_window) - lo)
    J_s *= scale_F
    J_w *= scale_F
    m_ox *= scale_m[0]
    m_fu *= scale_m[1]
    window = F_settled * t_window - J_s
    E_ox = mdot_settled[0] * t_window - m_ox + residual_extra[0]
    E_fu = mdot_settled[1] * t_window - m_fu + residual_extra[1]
    extra = min(E_ox, mr_end * E_fu) * (1.0 + 1.0 / mr_end)
    return {
        "deficit_Ns": window - c_end * extra,
        "window_deficit_Ns": F_settled * t_window - J_w,
        "start_impulse_Ns": J_s,
        "start_ox_kg": m_ox,
        "start_fuel_kg": m_fu,
        "end_extension_Ns": c_end * extra,
        "extra_ox_kg": E_ox,
        "extra_fuel_kg": E_fu,
    }


# ------------------------------------------------------------------ the drawing and the engine


def feed_path(net: Any, inlet: str, tank: str) -> List[str]:
    """Branch ids from the tank down to the injector inlet (a breadth-first walk upstream, so a
    fill or vent tee meeting the path is not taken for the feed). Same walk as
    engine/layerx/flight.py ``_path_to_tank``."""
    parent: Dict[str, Tuple[str, str]] = {}
    frontier, seen = [inlet], {inlet}

    def is_tank(node: str) -> bool:
        return node == tank or node.split(".", 1)[0] == tank

    reached = None
    while frontier and reached is None:
        here = frontier.pop(0)
        for bid, br in net.branches.items():
            if br.downstream == here and br.upstream not in seen:
                seen.add(br.upstream)
                parent[br.upstream] = (here, bid)
                if is_tank(br.upstream):
                    reached = br.upstream
                    break
                frontier.append(br.upstream)
    if reached is None:
        return []
    out, node = [], reached
    while node != inlet:
        node, bid = parent[node]
        out.append(bid)
    return out


@dataclass(frozen=True)
class Element:
    """One drawn element on a feed path, as the transient modules need it."""

    id: str
    kind: str
    """``pipe``, ``valve`` or ``other``."""
    R: float
    """Quadratic loss at the reference flow over that flow squared [Pa/(kg/s)^2]."""
    length: float = 0.0
    bore: float = 0.0
    wall: Optional[float] = None
    dz: float = 0.0
    travel_s: Optional[float] = None
    cv_fraction: Optional[Callable[[float], float]] = None
    inputs: Dict[str, Dict[str, Any]] = field(default_factory=dict)

    @property
    def area(self) -> float:
        return math.pi * self.bore ** 2 / 4.0 if self.bore > 0.0 else 0.0

    @property
    def inertance(self) -> float:
        return self.length / self.area if self.area > 0.0 else 0.0

    @property
    def volume(self) -> float:
        return self.length * self.area


@dataclass(frozen=True)
class FeedLine:
    """A side's feed path from the drawing: elements tank -> main valve -> line exit."""

    side: str
    key: str
    tank: str
    fluid: str
    rho: float
    mu: float
    a_fluid: float
    p_sat: float
    upstream: Tuple[Element, ...]
    valve: Optional[Element]
    downstream: Tuple[Element, ...]
    warnings: Tuple[str, ...] = ()

    def sum(self, which: str, attr: str) -> float:
        elems = self.upstream if which == "up" else self.downstream
        return float(sum(getattr(e, attr) for e in elems))


def _params_inputs(prefix: str, comp: Any, names: Sequence[str], notes: Mapping[str, str] = {}) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    inst = getattr(comp, "instance", None)
    params = getattr(inst, "params", {}) or {}
    for name in names:
        p = params.get(name)
        if p is None:
            continue
        out[f"{prefix}.{name}"] = inp(finite(p.value), str(p.unit), param_provenance(p, notes.get(name, "")))
    return out


def feed_line(prep: Any, side: str, *, mdot_ref: float, p_ref: float, T_ref: float) -> FeedLine:
    """The drawn feed path of ``side`` with each element's loss priced by the twin's own
    component at ``mdot_ref`` and the fluid's state at ``p_ref`` [Pa], ``T_ref`` [K]."""
    from feedtwin.comps.base import FlowConditions
    from feedtwin.props.fluid import Fluid

    net = prep.model.built.network
    tank = prep.roles[side]
    inlet = prep.inlet_nodes[side]
    species = (prep.derived.get("species") or {}).get(side)
    if not species:
        raise ValueError(f"no species for the {side} side")
    fl = Fluid(species)
    rho = fl.get("rho", p=p_ref, T=T_ref)
    mu = fl.get("mu", p=p_ref, T=T_ref)
    a_f = fl.get("a", p=p_ref, T=T_ref)
    try:
        p_sat = fl.get("p", T=T_ref, q=0.0)
    except Exception:  # noqa: BLE001 - a supercritical or unsupported state: no saturation
        p_sat = 0.0
    path = feed_path(net, inlet, tank)
    if not path:
        raise ValueError(f"no drawn path from {tank} to {inlet}")
    flow = FlowConditions(rho=rho, mu=mu, p_upstream=p_ref)
    m_ref = max(abs(mdot_ref), 1e-6)
    elems: List[Element] = []
    warnings: List[str] = []
    for bid in path:
        comp = net.branches[bid].component
        cls = type(comp).__name__
        p = getattr(comp, "p", {}) or {}
        try:
            R = float(comp.pressure_drop(m_ref, flow)) / m_ref ** 2
        except Exception as exc:  # noqa: BLE001
            R = 0.0
            warnings.append(f"{bid} ({cls}): loss not evaluated ({exc}); taken as lossless")
        if cls == "Pipe" or ("length" in p and "bore" in p):
            wall = p.get("wall_thickness")
            elems.append(Element(
                id=bid, kind="pipe", R=R, length=float(p["length"]), bore=float(p["bore"]),
                wall=float(wall) if wall else None, dz=float(p.get("elevation_change", 0.0) or 0.0),
                inputs=_params_inputs(bid, comp, ("length", "bore", "K_minor", "roughness", "wall_thickness",
                                                  "elevation_change"))))
        elif hasattr(comp, "effective_cv"):
            cv1 = float(comp.effective_cv(1.0))

            def frac(x: float, _c: Any = comp, _cv1: float = cv1) -> float:
                return float(_c.effective_cv(x)) / _cv1 if _cv1 > 0 else 0.0

            travel = p.get("travel_time")
            if travel is None:
                travel = getattr(prep.setup, "valve_travel_s", None)
            elems.append(Element(
                id=bid, kind="valve", R=R, bore=float(p.get("bore", 0.0) or 0.0),
                travel_s=float(travel) if travel is not None else None, cv_fraction=frac,
                inputs=_params_inputs(bid, comp, ("Cv", "bore", "travel_time"))))
        else:
            elems.append(Element(id=bid, kind="other", R=R, inputs={}))
            warnings.append(f"{bid} ({cls}): counted as a loss only (no inertance, no volume)")
    valves = [i for i, e in enumerate(elems) if e.kind == "valve" and e.travel_s is not None]
    key = dict(SIDES)[side]
    if not valves:
        return FeedLine(side, key, tank, species, rho, mu, a_f, p_sat, tuple(elems), None, (), tuple(
            warnings + ["no main valve with a travel time on the path"]))
    iv = valves[-1]
    return FeedLine(side, key, tank, species, rho, mu, a_f, p_sat, tuple(elems[:iv]), elems[iv],
                    tuple(elems[iv + 1:]), tuple(warnings))


def manifold_volumes(config: Any) -> Dict[str, Dict[str, Any]]:
    """Each side's injector volume downstream of its feed port, from the config's injector layout
    (engine/core/injectors/layout.py): the ring channel (cross-section x 2 pi r_center) and the
    orifice passages (n x pi/4 d^2 x through-length). Returns per ``ox``/``fuel``: ``V_m3``,
    ``I_inj`` (passage length over total passage area) and the inputs. The plate's feed ports and
    any back-cover passages are not in the layout and are not counted."""
    from engine.core.injectors.layout import layout_from_config

    lay = layout_from_config(config, drawings=False, checks=False)
    if lay is None:
        raise ValueError("the config's injector is not an impinging doublet with a layout")
    inputs = lay.get("inputs") or {}
    out: Dict[str, Dict[str, Any]] = {}
    for k, key, side in (("O", "ox", "oxidizer"), ("F", "fuel", "fuel")):
        ps = lay["passages"][k]
        n = int(round(float((inputs.get(side) or {}).get("n_elements", 0) or 0)))
        d = float(ps["bore"])
        thru = float(ps["thru"])
        a_or = n * math.pi * d * d / 4.0
        ch = ps.get("channel") or {}
        v_ring = float(ch.get("flow_area", 0.0)) * 2.0 * math.pi * float(ch.get("r_center", 0.0))
        v_or = a_or * thru
        src = "EngineDesign config injector layout (layout_from_config)"
        out[key] = {
            "V_m3": v_ring + v_or, "V_ring_m3": v_ring, "V_orifices_m3": v_or,
            "I_inj": thru / a_or if a_or > 0 else 0.0,
            "inputs": {
                f"{key}.channel_flow_area": inp(ch.get("flow_area"), "m^2", src + ": ring channel cross-section"),
                f"{key}.channel_r_center": inp(ch.get("r_center"), "m", src + ": ring channel centre radius"),
                f"{key}.n_orifices": inp(n, "-", src),
                f"{key}.orifice_d": inp(d, "m", src),
                f"{key}.orifice_length": inp(thru, "m", src + ": passage through-length"),
            },
        }
    return out


# ------------------------------------------------------------------ from a Layer X run


def _first_firing(series: Mapping[str, Any]) -> int:
    for i, f in enumerate(series.get("firing") or []):
        if f:
            return i
    raise ValueError("the burn never fired")


def _last_firing(series: Mapping[str, Any]) -> int:
    idx = [i for i, f in enumerate(series.get("firing") or []) if f]
    if not idx:
        raise ValueError("the burn never fired")
    return idx[-1]


def _card_fn(table: Any, label: str) -> Callable[[float, float], Tuple[float, bool]]:
    lo_x, hi_x = float(table.x0), float(table.x_max)
    lo_y, hi_y = float(table.y0), float(table.y_max)

    def fn(mr: float, mdot: float) -> Tuple[float, bool]:
        x = min(max(mr, lo_x), hi_x)
        y = min(max(mdot, lo_y), hi_y)
        return float(table(x, y)), (x != mr or y != mdot)

    return fn


def settled_point(result: Mapping[str, Any]) -> Dict[str, Any]:
    """The main burn's first settled operating point: the delivered (replay) first point when the
    replay ran, else the twin's first firing step."""
    series = result["series"]
    i0 = _first_firing(series)
    deliv = result.get("delivered") or {}
    out = {
        "index": i0, "t": float(series["t"][i0]),
        "p_inlet_ox": float(series["ox"]["inlet_psia"][i0]) * PSI,
        "p_inlet_fu": float(series["fuel"]["inlet_psia"][i0]) * PSI,
        "line_ox": float(series["ox"]["mdot"][i0]), "line_fu": float(series["fuel"]["mdot"][i0]),
        "pc_twin": float(series["chamber"]["pc_psia"][i0]) * PSI,
    }
    if deliv.get("thrust_N"):
        out.update(F=float(deliv["thrust_N"][0]), pc=float(deliv["pc_psia"][0]) * PSI,
                   m_ox=float(deliv["mdot_O"][0]), m_fu=float(deliv["mdot_F"][0]), basis="delivered (replay) first point")
    else:
        out.update(F=float(series["chamber"]["thrust_N"][i0]), pc=out["pc_twin"], m_ox=out["line_ox"],
                   m_fu=out["line_fu"], basis="twin first firing step")
    return out


def start_from_run(prep: Any, result: Mapping[str, Any], config: Any = None,
                   settings: StartSettings = StartSettings()) -> Dict[str, Any]:
    """``diagnostics.start`` for a finished Layer X run. Never raises."""
    try:
        return _start_from_run(prep, result, config, settings)
    except Exception as exc:  # noqa: BLE001 - a diagnostic never takes the burn down
        return unavailable(f"start transient: {exc}")


def _start_from_run(prep: Any, result: Mapping[str, Any], config: Any,
                    settings: StartSettings) -> Dict[str, Any]:
    series = result["series"]
    summary = result.get("summary") or {}
    sp = settled_point(result)
    i0 = sp["index"]
    if config is None and prep.link is not None and getattr(prep.link, "sampler", None) is not None:
        config = prep.link.sampler.config
    if config is None:
        raise ValueError("no engine config to take the injector manifold from")
    man = manifold_volumes(config)
    inputs: Dict[str, Dict[str, Any]] = {}
    lines: Dict[str, StartLine] = {}
    feeds: Dict[str, FeedLine] = {}
    for (side, key), vb in zip(SIDES, settings.valve_body_volume_L):
        sub = series["ox" if key == "ox" else "fuel"]
        # The tank outlet at the last step before Fire: the ullage plus the liquid's head over the
        # outlet, as the twin has it.
        i_pre = max(i0 - 1, 0)
        p_series = sub.get("outlet_psia")
        if p_series is None:
            p_series = sub["tank_psia"]
        p_tank = float(p_series[i_pre]) * PSI
        T_liq = float(sub["liquid_K"][i0])
        m_line = sp["line_ox"] if key == "ox" else sp["line_fu"]
        feed = feed_line(prep, side, mdot_ref=m_line, p_ref=p_tank, T_ref=T_liq)
        if feed.valve is None:
            raise ValueError(f"{side}: " + "; ".join(feed.warnings))
        feeds[key] = feed
        rho = feed.rho
        g = G0
        dz = sum(e.dz for e in feed.upstream + feed.downstream if e.kind == "pipe")
        dn_pipes = [e for e in feed.downstream if e.kind == "pipe"]
        p_in = sp["p_inlet_ox"] if key == "ox" else sp["p_inlet_fu"]
        dp_inj = p_in - sp["pc_twin"]
        if dp_inj <= 0:
            raise ValueError(f"{side}: no injector drop at the first firing step")
        phi = m_line / math.sqrt(dp_inj)
        mv = man[key]
        a_exit = dn_pipes[-1].area if dn_pipes else (
            [e for e in feed.upstream if e.kind == "pipe"][-1].area if feed.upstream else 0.0)
        lines[key] = StartLine(
            key=key, rho=rho, p_tank=p_tank,
            I_up=feed.sum("up", "inertance"), R_up=feed.sum("up", "R"),
            R_valve_open=feed.valve.R,
            travel_s=(float(settings.valve_travel_s) if settings.valve_travel_s is not None
                      else float(feed.valve.travel_s or 0.0)),
            t_open=(-settings.fuel_lead_s if key == "fuel" else 0.0),
            I_dn=feed.sum("dn", "inertance"), V_dn_line=feed.sum("dn", "volume"), R_dn=feed.sum("dn", "R"),
            V_manifold=mv["V_m3"] + float(vb) * 1e-3, A_exit=a_exit, K_exit_prime=settings.K_exit_prime,
            I_inj=mv["I_inj"], phi=phi, dp_static=-rho * g * dz,
            cv_fraction=feed.valve.cv_fraction or linear_characteristic)
        for e in feed.upstream + (feed.valve,) + feed.downstream:
            inputs.update(e.inputs)
        inputs.update(mv["inputs"])
        inputs[f"{key}.p_tank"] = inp(p_tank / PSI, "psia", "main burn tank outlet (ullage + liquid head) at the last "
                                      "step before Fire (series outlet_psia), held through the start")
        inputs[f"{key}.rho"] = inp(rho, "kg/m^3", f"feedtwin Fluid('{feed.fluid}') at T-0 tank pressure and {T_liq:.2f} K")
        inputs[f"{key}.phi"] = inp(phi, "kg/s/sqrt(Pa)", "engine card capacity at the main burn's first firing step: "
                                   "series mdot / sqrt(line-exit pressure - Pc)")
        inputs[f"{key}.valve_body_volume"] = inp(float(vb), "L", "assumed 0: the valve body volume downstream of the seat is not drawn")
        if settings.valve_travel_s is not None:
            inputs[f"{key}.valve_travel"] = inp(float(settings.valve_travel_s), "s",
                                                "setting valve_travel_s (restated for this diagnostic; the burn used "
                                                f"the drawing's {float(feed.valve.travel_s or 0.0):g} s)")
        inputs[f"{key}.V_manifold"] = inp(mv["V_m3"] * 1e3, "L", "ring channel + orifice passages from the config layout; "
                                          "feed ports and back passages not counted")
    link = prep.link
    card = getattr(link, "card", None)
    gamma_list = (result.get("replay") or {}).get("gamma") or []
    gamma = float(gamma_list[0]) if gamma_list else 1.2
    gamma_prov = ("main burn replay's chamber gamma at its first point (CEA, EngineDesign)" if gamma_list
                  else "assumed 1.2: no replay gamma on this run")
    At = float(link.design.throat_area)
    Vc = float(link.design.chamber_volume)
    pa = float(prep.ambient_pa)
    if card is not None:
        Ae = float(card.exit_area)
        cstar = _card_fn(card.chamber.cstar, "c*")
        vvac = _card_fn(card.chamber.vacuum_velocity, "v_vac")
        card_prov = "engine card (EngineDesign sampled at the line exit), clipped to its table"
    else:
        m_tot = sp["m_ox"] + sp["m_fu"]
        cs0 = sp["pc"] * At / m_tot
        Ae = float(getattr(link.design, "exit_area", 0.0) or 0.0)
        v0 = (sp["F"] + pa * Ae) / m_tot
        cstar = lambda mr, m, _c=cs0: _c  # noqa: E731
        vvac = lambda mr, m, _v=v0: _v  # noqa: E731
        card_prov = "constant at the main burn's first settled point (no engine card on this run)"
    mr_design = sp["m_ox"] / sp["m_fu"]
    ch = StartChamber(volume=Vc, throat_area=At, exit_area=Ae, ambient_pa=pa, gamma=gamma, cstar=cstar,
                      vvac=vvac, ignition_delay_s=settings.ignition_delay_s, mr_design=mr_design,
                      hard_start_ratio=settings.hard_start_ratio, retained_fraction=settings.retained_fraction)
    run = run_start(lines["ox"], lines["fuel"], ch, dt=settings.dt, horizon_s=settings.horizon_s,
                    settle_tol=settings.settle_tol, record_every_s=settings.record_every_s)
    if not run["ignited"]:
        raise ValueError("the start never ignited inside the horizon")

    # The model's steady state against the main burn's first settled point.
    F_end = run["F_end"]
    m_end = run["mdot_end"]
    Gam = run["gamma_fn"]
    steady = {
        "thrust_rel": F_end / sp["F"] - 1.0, "pc_rel": run["pc_end"] / sp["pc"] - 1.0,
        "mdot_ox_rel": m_end[0] / sp["m_ox"] - 1.0, "mdot_fuel_rel": m_end[1] / sp["m_fu"] - 1.0,
        "basis": sp["basis"],
    }
    scale_F = sp["F"] / F_end if F_end > 0 else 1.0
    scale_m = (sp["m_ox"] / m_end[0] if m_end[0] > 0 else 1.0, sp["m_fu"] / m_end[1] if m_end[1] > 0 else 1.0)

    # The main burn's totals, for the fixed-load accounting.
    il = _last_firing(series)
    deliv = result.get("delivered") or {}
    dsum = deliv.get("summary") or {}
    J_main = finite(dsum.get("total_impulse_Ns")) or finite(summary.get("total_impulse_Ns"))
    if deliv.get("thrust_N"):
        F_last = float(deliv["thrust_N"][-1])
        m_last = float(deliv["mdot_O"][-1]) + float(deliv["mdot_F"][-1])
        mr_last = float(deliv["mdot_O"][-1]) / float(deliv["mdot_F"][-1])
    else:
        F_last = float(series["chamber"]["thrust_N"][il])
        m_last = float(series["ox"]["mdot"][il]) + float(series["fuel"]["mdot"][il])
        mr_last = float(series["ox"]["mdot"][il]) / float(series["fuel"]["mdot"][il])
    c_end = F_last / m_last
    dry = float(((result.get("provenance") or {}).get("settings") or {}).get("dry_kg") or 0.001)
    res_ox = float((summary.get("ox") or {}).get("residual_kg") or dry)
    res_fu = float((summary.get("fuel") or {}).get("residual_kg") or dry)
    t_window = max(run["t_settle"] or 0.0, 0.0)
    acc = fixed_load_deficit(trace=run["trace"], t_window=t_window, F_settled=sp["F"],
                             mdot_settled=(sp["m_ox"], sp["m_fu"]), scale_F=scale_F, scale_m=scale_m,
                             c_end=c_end, mr_end=mr_last,
                             residual_extra=(max(res_ox - dry, 0.0), max(res_fu - dry, 0.0)))

    # Hard start (heuristic).
    cs_set = sp["pc"] * At / (sp["m_ox"] + sp["m_fu"])
    inventory = sp["pc"] * Vc / (Gam * cs_set) ** 2
    ratio = run["pair_kg"] / inventory if inventory > 0 else 0.0
    pair_rate = min(m_end[0], mr_design * m_end[1]) * (1.0 + 1.0 / mr_design)
    delay_threshold = settings.hard_start_ratio * inventory / pair_rate if pair_rate > 0 else None
    hard = ratio > settings.hard_start_ratio
    lead_fuel = run["pre_ignition_kg"][1] if settings.fuel_lead_s > 0 else 0.0

    rec = run["rec"]
    t_prime = run["t_prime"]
    surge = {}
    for i, key in enumerate(("ox", "fuel")):
        am = run["arrival_mdot"][i]
        ln = lines[key]
        surge[key] = (None if am is None or am <= 0 or not math.isfinite(ln.phi)
                      else (pa + (am / ln.phi) ** 2) / PSI)
    inputs.update({
        "fuel_lead_s": inp(settings.fuel_lead_s, "s", "setting; 0 = today's DAQ table (both mains in Fire). "
                           "The team's sequence has a heavy fuel lead: unmeasured"),
        "ignition_delay_s": inp(settings.ignition_delay_s, "s", "assumed 0: ignites when both manifolds are primed. Unmeasured"),
        "K_exit_prime": inp(settings.K_exit_prime, "velocity heads", "assumed 1: Borda dump of the liquid entering the gas volume"),
        "chamber_volume": inp(Vc, "m^3", "EngineDesign geometry (link.design.chamber_volume)"),
        "throat_area": inp(At, "m^2", "EngineDesign geometry, as built (link.design.throat_area)"),
        "exit_area": inp(Ae, "m^2", "engine card exit area"),
        "gamma": inp(gamma, "-", gamma_prov),
        "cstar_and_vvac": inp(None, "m/s", card_prov),
        "ambient": inp(pa / PSI, "psia", "site ambient (prep.ambient_pa)"),
        "hard_start_ratio": inp(settings.hard_start_ratio, "-", "heuristic threshold: accumulated pair over the chamber's steady gas inventory"),
        "retained_fraction": inp(settings.retained_fraction, "-", "assumed 1: upper bound, everything injected before ignition is still in the chamber"),
        "F_settled": inp(sp["F"], "N", f"main burn first settled thrust ({sp['basis']})"),
        "dt": inp(settings.dt, "s", "integration step"),
    })
    warnings: List[str] = []
    for f in feeds.values():
        warnings.extend(f.warnings)
    if run["card_clipped_frac"] > 0:
        warnings.append(f"engine card clipped to its table on {100 * run['card_clipped_frac']:.0f} % of burning steps "
                        "(low flow and O/F during the rise)")
    model = model_block(
        MODEL_NAME,
        "Rigid-column (lumped inertance) feed lines with a linear-travel main valve, the rigid-column filling "
        "model for the gas-filled downstream volume (Liou & Hunt, J. Hydraul. Eng. 122(10), 1996), and a "
        "lumped chamber dPc/dt = (RT/V)(m_in - Pc A_t/c*) with RT = (Gamma c*)^2 (Sutton & Biblarz, Rocket "
        "Propulsion Elements, ideal-rocket relations). Own module: the main burn is not changed.",
        [
            "tank outlet pressure held at its pre-Fire value through the start (the twin's ignition dip is 3-4 psi)",
            "lines incompressible; the friction factor frozen at the main burn's first settled flow",
            "downstream of each main valve the tube, manifold and orifices are gas at Fire; the manifold fills "
            "before any orifice flows; the displaced gas's orifice drop (under 7 kPa on LE4) is neglected",
            "the downstream hardware is taken as chilled: LOX boiling on a warm valve, tube or manifold (vapour "
            "pushing back on the front) is not modelled, so the LOX priming time is a lower bound and the "
            "LOX-before-fuel order holds only for a chilled-down manifold",
            "the injector's ring channel adds volume but no inertance (only the orifice passages' L/A is counted)",
            "the liquid entering the gas volume loses K_exit_prime velocity heads; once primed the engine card's "
            "capacity (which owns the dump) takes over, at its first-settled-step value",
            "ignition when both manifolds are primed plus ignition_delay_s; Pc is ambient before it",
            "propellant burns on arrival after ignition (no vaporisation lag); c* and vacuum exhaust velocity "
            "from the engine card at the instantaneous O/F and flow, clipped to the table",
            "thrust floored at zero; a separated nozzle at low Pc is not modelled (the deficit is the larger figure)",
            "the mass that fills the downstream line and manifold is pushed through at burnout, so it is not charged",
            "the propellant the start did not spend is burned at the end at the main burn's end-of-burn exhaust "
            "velocity and O/F until the first tank runs dry",
            "hard start is a heuristic (no cited criterion): injected-not-burned pair at ignition against the "
            "chamber's steady gas inventory. A single propellant pooled before the other arrives is not paired "
            "(ignition is at the second arrival), so a pooled lead does not trip it",
            "arrival_orifice_psia is the rigid-column orifice back-pressure at the arrival flow, an overestimate; "
            "the compressible figure is water_hammer[].opening (diag.waterhammer)",
        ],
        inputs)
    out: Dict[str, Any] = {
        "available": True,
        "t": [round(x, 6) for x in rec["t"]],
        "pc_psia": [p / PSI for p in rec["pc"]],
        "mdot_ox": rec["m_ox"], "mdot_fuel": rec["m_fu"],
        "line_mdot_ox": rec["line_ox"], "line_mdot_fuel": rec["line_fu"],
        "valve_ox": rec["x_ox"], "valve_fuel": rec["x_fu"],
        "thrust_N": [f * scale_F for f in rec["F"]],
        "mr": rec["mr"],
        "fuel_lead_s": settings.fuel_lead_s,
        "valve_travel_s": max(lines["ox"].travel_s, lines["fuel"].travel_s),
        "prime_ox_s": t_prime[0], "prime_fuel_s": t_prime[1],
        "ignition_s": run["t_ignition"], "settle_s": run["t_settle"],
        "impulse_deficit_Ns": acc["deficit_Ns"],
        "impulse_deficit_pct": (100.0 * acc["deficit_Ns"] / J_main) if J_main else None,
        "window_deficit_Ns": acc["window_deficit_Ns"],
        "accounting": acc,
        "hard_start": bool(hard),
        "hard_start_detail": {
            "pair_kg": run["pair_kg"], "spike_psi": run["spike_pa"] / PSI, "inventory_kg": inventory,
            "ratio": ratio, "threshold": settings.hard_start_ratio, "ignition_delay_threshold_s": delay_threshold,
            "pre_ignition_ox_kg": run["pre_ignition_kg"][0], "pre_ignition_fuel_kg": run["pre_ignition_kg"][1],
            "basis": "heuristic",
        },
        "lead_fuel_kg": lead_fuel,
        "prime_volume_L": {"ox": lines["ox"].V_prime * 1e3, "fuel": lines["fuel"].V_prime * 1e3},
        "arrival_mdot": {"ox": run["arrival_mdot"][0], "fuel": run["arrival_mdot"][1]},
        "arrival_orifice_psia": surge,
        "steady_check": steady,
        "card_clipped_frac": run["card_clipped_frac"],
        "events": [e for e in (
            {"key": "fuel_lead", "t": -settings.fuel_lead_s, "label": "Fuel main open"} if settings.fuel_lead_s > 0 else None,
            {"key": "fire", "t": 0.0, "label": "LOX main open" if settings.fuel_lead_s > 0 else "Mains open"},
            {"key": "ignition", "t": run["t_ignition"], "label": "Ignition (start model)"},
        ) if e is not None],
        "warnings": warnings,
        "unmeasured": ["fuel_lead_s", "ignition_delay_s", "valve_body_volume_L",
                       f"main valve travel ({max(lines['ox'].travel_s, lines['fuel'].travel_s):g} s, "
                       "'measured: fast solenoid', no test cited)", "K_exit_prime", "retained_fraction",
                       "feed port / back passage volume of the injector", "hard_start_ratio (heuristic threshold)",
                       "manifold chill-down state at Fire (LOX boiling while priming)"],
        "model": model,
    }
    return out
