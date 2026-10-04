"""Layer X shutdown: which tank runs dry first, and what the tail-off feeds the chamber.

``shutdown_from_run(prep, result, config=None, settings=ShutdownSettings(), outflow=None)``
-> ``diagnostics.shutdown`` (DATA-CONTRACT 3). ``tail_off(a, b, ...)`` is the model on plain inputs.

The main burn ends on depletion (``end_on_depletion``): the first tank reaches the dry mass and
the twin stops. It has no tail. This module takes that instant (or, when ``diag.outflow`` says
the outlet starts drawing gas earlier, that onset; or a timed cutoff) and follows each side's
**liquid** into the chamber from there, so the run says whether the engine shuts down
oxidiser-rich or fuel-rich, and how much of one propellant arrives with none of the other.

The model (a bounding timeline, every rule stated in the block)
---------------------------------------------------------------
* **The dry side.** Its tank is empty, but the line from the tank outlet to the orifices is full
  of liquid. The pressurant pushes that column through at the pre-dry flow (the ullage is still
  at tank pressure; gas behind a liquid slug). Its liquid ends when the line's contents
  ``rho (V_up + V_dn)`` have gone, or, once the main valve is shut, when the liquid that was
  downstream of the seat has gone.
* **The wet side** keeps flowing at its pre-dry rate until its main valve shuts.
* **The valves** are commanded shut ``delay_s`` after the first dry-out (default 0: commanded at
  it; the stand's actual cutoff logic is not on the drawing) and close over the drawing's travel
  time along the valve's own characteristic. Through the closing valve the flow is quasi-steady
  at the pre-shutdown driving pressure: ``m = m0 sqrt(R0 / (R_rest + R_valve(1)/f(x)^2))``,
  ``R0 = R_rest + R_valve(1)``, with ``R_rest`` the line and injector losses at the pre-shutdown
  point (the line's own time constant, 1-7 ms, is short against 50 ms of travel; AUDIT 9.5 §1).
* **After the seat shuts** the liquid downstream of it (tube, manifold, orifice passages) drains
  into the chamber. Its **mass** is exact; its **rate** is taken as the pre-shutdown flow, the
  fastest it can go, so the duration is a lower bound (the real drain decays with the chamber
  pressure, and LOX at ambient pressure flashes).
* **Mode**: the side whose liquid ends last is the one entering the chamber alone at the end:
  **LOX-rich** if LOX, **fuel-rich** if fuel. ``tail_mr_max`` is the O/F of everything that enters
  from the first dry-out to the end of flow (cumulative; once one side has stopped the
  instantaneous O/F is unbounded, so the cumulative figure and ``alone_kg``/``alone_s`` carry it).

A LOX-rich tail feeds oxygen with no fuel into a chamber whose walls are at their hottest: the
copper injector face and the graphite throat insert are both attacked by oxidiser-rich gas (the
replay's own graphite model counts O2 and O among the oxidisers, AUDIT 5.1). That is a graded note,
not a computed recession; no face thermal model exists (AUDIT 7 item 8).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

import numpy as np

from engine.layerx.diag.start import (
    PSI, SIDES, feed_line, finite, inp, linear_characteristic, manifold_volumes, model_block, unavailable,
)

MODEL_NAME = "shutdown_tail_timeline"


@dataclass(frozen=True)
class TailSide:
    key: str
    """``ox`` or ``fuel``."""
    rho: float
    mdot0: float
    """Flow just before the first dry-out (or the cutoff) [kg/s]."""
    V_up: float
    """Liquid volume tank outlet -> main valve seat [m^3]."""
    V_dn: float
    """Liquid volume seat -> orifices: tube, manifold, passages [m^3]."""
    travel_s: float
    R_valve_open: float = 0.0
    R_rest: float = 0.0
    wet: bool = True
    """The tank still holds liquid (False: this is the side that ran dry)."""
    cv_fraction: Callable[[float], float] = linear_characteristic
    inputs: Dict[str, Dict[str, Any]] = field(default_factory=dict)

    def closing_fraction(self, x: float) -> float:
        """Flow through the valve at travel ``x`` over the full-open flow (quasi-steady)."""
        if x >= 1.0:
            return 1.0
        f = self.cv_fraction(max(x, 0.0))
        if f <= 0.0:
            return 0.0
        r0 = self.R_rest + self.R_valve_open
        if r0 <= 0.0:
            return 1.0
        return math.sqrt(r0 / (self.R_rest + self.R_valve_open / (f * f)))


@dataclass(frozen=True)
class ShutdownSettings:
    delay_s: float = 0.0
    """First dry-out (or cutoff) to the main valves' shut command [s]. 0 = commanded at it."""
    cutoff_s: Optional[float] = None
    """A timed cutoff [s, Fire = 0] before depletion: both tanks wet. None = burn to depletion."""
    tie_frac: float = 0.01
    """The other tank's residual under this fraction of its load reads as a tie."""
    dt: float = 1.0e-5


def tail_off(a: TailSide, b: TailSide, *, t0: float, t_cmd: float, dt: float = 1.0e-5,
             horizon_s: float = 2.0) -> Dict[str, Any]:
    """Each side's liquid flow into the chamber from ``t0`` (the first dry-out) with the valves
    commanded shut at ``t_cmd``. Returns per side the flow history, the mass delivered after
    ``t0`` and when its liquid ended."""
    out: Dict[str, Any] = {"t0": t0, "t_cmd": t_cmd, "sides": {}}
    t_stop = t_cmd + max(a.travel_s, b.travel_s)
    for s in (a, b):
        hist_t: List[float] = []
        hist_m: List[float] = []
        delivered = 0.0
        t_end = None
        up = math.inf if s.wet else s.rho * s.V_up     # liquid upstream of the seat [kg]
        dn = s.rho * s.V_dn                            # liquid downstream of the seat [kg]
        n = 0
        while True:
            t = t0 + n * dt
            if t > t_stop + horizon_s:
                break
            tm = t + 0.5 * dt                          # the step [t, t + dt) at its midpoint
            x = 1.0 if tm <= t_cmd else (0.0 if s.travel_s <= 0.0 else 1.0 - (tm - t_cmd) / s.travel_s)
            shut = tm > t_cmd and x <= 0.0
            if not shut:
                want = s.mdot0 * s.closing_fraction(x) * dt
                through_seat = min(want, up)           # liquid crossing the seat
                up -= through_seat
                # Liquid in = liquid out while the column is whole; once the gas front has crossed
                # the seat the pressurant pushes the downstream column out at the same rate.
                from_dn = min(want - through_seat, dn)
                dn -= from_dn
                step = through_seat + from_dn
            else:
                # Seat shut: the liquid downstream of it drains, at most at the pre-shutdown rate.
                step = min(s.mdot0 * dt, dn)
                dn -= step
            m = step / dt
            hist_t.append(t)
            hist_m.append(m)
            delivered += step
            if m > 0.0:
                t_end = t + dt
            if (shut or up <= 0.0) and dn <= 0.0:
                break
            n += 1
        out["sides"][s.key] = {"t": hist_t, "mdot": hist_m, "delivered_kg": delivered,
                               "t_end": t_end if t_end is not None else t0}
    return out


def classify(tail: Mapping[str, Any], *, end_tol_s: float = 1.0e-3) -> Dict[str, Any]:
    """Mode, the propellant alone at the end, LOX alone, and the cumulative tail O/F."""
    ox, fu = tail["sides"]["ox"], tail["sides"]["fuel"]
    t_ox, t_fu = ox["t_end"], fu["t_end"]
    if abs(t_ox - t_fu) <= end_tol_s:
        mode, alone_side = "simultaneous", None
    elif t_ox > t_fu:
        mode, alone_side = "LOX-rich", "ox"
    else:
        mode, alone_side = "fuel-rich", "fuel"

    def mass_after(side: Mapping[str, Any], t_from: float) -> float:
        dt = (side["t"][1] - side["t"][0]) if len(side["t"]) > 1 else 0.0
        return sum(m * dt for t, m in zip(side["t"], side["mdot"]) if t >= t_from - 1e-12)

    alone_kg, alone_s = 0.0, 0.0
    if alone_side == "ox":
        alone_kg, alone_s = mass_after(ox, t_fu), t_ox - t_fu
    elif alone_side == "fuel":
        alone_kg, alone_s = mass_after(fu, t_ox), t_fu - t_ox
    m_ox, m_fu = ox["delivered_kg"], fu["delivered_kg"]
    return {
        "mode": mode, "alone_side": alone_side, "alone_kg": alone_kg, "alone_s": alone_s,
        "lox_alone_kg": alone_kg if alone_side == "ox" else 0.0,
        "lox_alone_s": alone_s if alone_side == "ox" else 0.0,
        "tail_ox_kg": m_ox, "tail_fuel_kg": m_fu,
        "tail_mr_max": (m_ox / m_fu) if m_fu > 0 else None,
        "end_ox_s": t_ox, "end_fuel_s": t_fu,
    }


def _note(mode: str, cls: Mapping[str, Any]) -> Dict[str, str]:
    if mode == "LOX-rich":
        return {"grade": "warn", "text": (
            f"LOX-rich tail-off: {1e3 * cls['alone_kg']:.0f} g of LOX enters the hot chamber with no fuel over at "
            f"least {1e3 * cls['alone_s']:.0f} ms. Oxidiser-rich gas attacks the copper injector face and oxidises "
            "the graphite throat insert; a fuel-rich shutdown (fuel valve closing last, or less fuel-side volume "
            "downstream of the LOX seat) avoids it.")}
    if mode == "fuel-rich":
        return {"grade": "info", "text": (
            f"Fuel-rich tail-off: fuel flows alone for at least {1e3 * cls['alone_s']:.0f} ms "
            f"({1e3 * cls['alone_kg']:.0f} g) after the LOX stops; the face and throat see fuel-rich gas.")}
    return {"grade": "info", "text": "Both propellants stop within 1 ms of each other."}


def _side_key(side: Optional[str]) -> Optional[str]:
    return {"oxidiser": "ox", "oxidizer": "ox", "ox": "ox", "fuel": "fuel"}.get(str(side)) if side else None


def shutdown_from_run(prep: Any, result: Mapping[str, Any], config: Any = None,
                      settings: ShutdownSettings = ShutdownSettings(),
                      outflow: Optional[Sequence[Mapping[str, Any]]] = None) -> Dict[str, Any]:
    """``diagnostics.shutdown`` for a finished run. ``outflow`` is ``diagnostics.outflow`` when it
    was computed: an earlier gas-ingestion onset is then the first dry-out. Never raises."""
    try:
        return _shutdown_from_run(prep, result, config, settings, outflow)
    except Exception as exc:  # noqa: BLE001
        return unavailable(f"shutdown: {exc}")


def _shutdown_from_run(prep: Any, result: Mapping[str, Any], config: Any, settings: ShutdownSettings,
                       outflow: Optional[Sequence[Mapping[str, Any]]]) -> Dict[str, Any]:
    series = result["series"]
    summary = result.get("summary") or {}
    t = [float(x) for x in series["t"]]
    firing = [bool(f) for f in series.get("firing") or []]
    fire_idx = [i for i, f in enumerate(firing) if f]
    if not fire_idx:
        raise ValueError("the burn never fired")
    first_dry = _side_key(summary.get("depleted_side"))
    t_dry = finite(summary.get("depletion_s")) or finite(summary.get("burn_time_s"))
    basis = "the twin's depletion (dry mass reached)"
    ingest: Dict[str, float] = {}
    for row in outflow or []:
        k = _side_key(row.get("side"))
        onset = finite(row.get("ingestion_onset_s"))
        if k and onset is not None:
            ingest[k] = onset
    if ingest:
        k_first = min(ingest, key=lambda k: ingest[k])
        if t_dry is None or ingest[k_first] < t_dry:
            first_dry, t_dry = k_first, ingest[k_first]
            basis = "gas-ingestion onset at the tank outlet (diag.outflow, Lubin & Springer)"
    cutoff = settings.cutoff_s is not None and (t_dry is None or settings.cutoff_s < t_dry)
    if cutoff:
        t0 = float(settings.cutoff_s)  # type: ignore[arg-type]
        basis = "timed cutoff with both tanks wet"
    elif t_dry is None:
        raise ValueError("no depletion time on this run")
    else:
        t0 = t_dry
    # The step at or before t0 for the pre-shutdown flows.
    i0 = max([i for i in fire_idx if t[i] <= t0 + 1e-9] or [fire_idx[0]])
    if config is None and prep.link is not None and getattr(prep.link, "sampler", None) is not None:
        config = prep.link.sampler.config
    man = manifold_volumes(config) if config is not None else None
    inputs: Dict[str, Dict[str, Any]] = {}
    sides: Dict[str, TailSide] = {}
    warnings: List[str] = []
    pc = float(series["chamber"]["pc_psia"][i0]) * PSI
    for side, key in SIDES:
        sub = series[key]
        m0 = float(sub["mdot"][i0])
        p_tank = float(sub["tank_psia"][i0]) * PSI
        T = float(sub["liquid_K"][i0])
        feed = feed_line(prep, side, mdot_ref=m0, p_ref=p_tank, T_ref=T)
        if feed.valve is None:
            raise ValueError(f"{side}: no main valve with a travel time on the drawn path")
        warnings.extend(feed.warnings)
        p_in = float(sub["inlet_psia"][i0]) * PSI
        phi = m0 / math.sqrt(max(p_in - pc, 1.0))
        v_man = man[key]["V_m3"] if man else 0.0
        if man is None:
            warnings.append("no engine config: manifold volume taken as 0")
        V_up = feed.sum("up", "volume")
        V_dn = feed.sum("dn", "volume") + v_man
        wet = cutoff or key != first_dry
        sides[key] = TailSide(
            key=key, rho=feed.rho, mdot0=m0, V_up=V_up, V_dn=V_dn, travel_s=float(feed.valve.travel_s or 0.0),
            R_valve_open=feed.valve.R, R_rest=feed.sum("up", "R") + feed.sum("dn", "R") + 1.0 / phi ** 2,
            wet=wet, cv_fraction=feed.valve.cv_fraction or linear_characteristic)
        inputs[f"{key}.mdot0"] = inp(m0, "kg/s", f"main burn series at t = {t[i0]:.3f} s (last step before the first dry-out)")
        inputs[f"{key}.V_up"] = inp(V_up * 1e3, "L", "drawn tube volume, tank outlet to the main valve")
        inputs[f"{key}.V_dn"] = inp(V_dn * 1e3, "L", "drawn tube volume after the main valve + injector ring and passages "
                                    "(config layout); valve body not drawn")
        inputs[f"{key}.rho"] = inp(feed.rho, "kg/m^3", f"feedtwin Fluid('{feed.fluid}') at the pre-shutdown tank state")
        inputs[f"{key}.travel_s"] = inp(sides[key].travel_s, "s", "drawing main-valve travel_time")
        for e in (feed.valve,):
            inputs.update(e.inputs)
    t_cmd = t0 + settings.delay_s
    tail = tail_off(sides["ox"], sides["fuel"], t0=t0, t_cmd=t_cmd, dt=settings.dt)
    cls = classify(tail)
    # A tie: the other tank holds a small fraction of its load when the first runs dry.
    tie = False
    resid: Optional[float] = None
    if not cutoff and first_dry:
        other = "fuel" if first_dry == "ox" else "ox"
        load = finite((summary.get(other) or {}).get("loaded_kg"))
        liq = [float(x) for x in series[other]["liquid_kg"]]
        resid = float(np.interp(t0, t, liq))
        if load and resid < settings.tie_frac * load:
            tie = True
            warnings.append(f"near tie: the {other} tank holds {resid:.3f} kg ({100 * resid / load:.2f} % of its load) "
                            "when the first runs dry; a small O/F or head change flips the order")
    inputs.update({
        "delay_s": inp(settings.delay_s, "s", "assumed 0: valves commanded at the first dry-out; the stand's cutoff "
                       "detection is not on the drawing. Unmeasured"),
        "cutoff_s": inp(settings.cutoff_s, "s", "setting: a timed cutoff before depletion (None = burn to depletion)"),
        "t0": inp(t0, "s", basis),
    })
    model = model_block(
        MODEL_NAME,
        "Bounding tail-off timeline: the dry side's line contents pushed through by the pressurant, the wet side "
        "at its pre-dry flow, quasi-steady flow through the closing main valves (drawing travel and Cv "
        "characteristic), then the liquid downstream of each seat drained at the pre-shutdown rate.",
        [
            "the first dry-out is the twin's depletion, or the earlier gas-ingestion onset from diag.outflow",
            "the dry side's line contents are pushed through at the pre-dry flow (ullage still at tank pressure)",
            "the wet side keeps its pre-dry flow although the chamber pressure falls once the other side stops "
            "(its injector drop rises, up to sqrt((p_tank - p_a)/(p_tank - Pc)) in flow), so alone_kg is a lower bound",
            "valves commanded shut delay_s after the first dry-out (default 0) and closing along their drawn travel",
            "flow through a closing valve is quasi-steady at the pre-shutdown driving pressure",
            "the liquid downstream of a shut seat drains at the pre-shutdown rate: its mass is exact, its duration a "
            "lower bound (the real drain decays with Pc; LOX at ambient flashes)",
            "the side whose liquid ends last enters the chamber alone; tail_mr_max is the cumulative O/F after the "
            "first dry-out (the instantaneous O/F is unbounded once one side stops)",
            "the attack on the copper face and graphite throat is qualitative: no face thermal or oxidation model",
        ],
        inputs)
    note = _note(cls["mode"], cls)
    return {
        "available": True,
        "first_dry": None if cutoff else first_dry,
        "first_dry_s": None if cutoff else t_dry,
        "first_dry_basis": basis,
        "mode": cls["mode"],
        "tail_mr_max": cls["tail_mr_max"],
        "alone_side": cls["alone_side"], "alone_kg": cls["alone_kg"], "alone_s": cls["alone_s"],
        "lox_alone_kg": cls["lox_alone_kg"], "lox_alone_s": cls["lox_alone_s"],
        "tail_ox_kg": cls["tail_ox_kg"], "tail_fuel_kg": cls["tail_fuel_kg"],
        "end_ox_s": cls["end_ox_s"], "end_fuel_s": cls["end_fuel_s"],
        "valve_command_s": t_cmd,
        "tie": tie,
        "other_kg_at_first_dry": resid,
        "note": note,
        "warnings": warnings,
        "unmeasured": ["delay_s (cutoff detection / sequence)",
                       f"main valve travel ({max(sides['ox'].travel_s, sides['fuel'].travel_s):g} s, no test cited)",
                       "valve body volume downstream of the seat", "injector feed-port and back-passage volume"],
        "model": model,
    }
