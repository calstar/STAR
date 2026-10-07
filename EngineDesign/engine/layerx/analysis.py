"""Run a prepared Layer X burn and reduce it to what a person reads.

The trace from :func:`feedtwin.session.burn.run_burn` is absolute SI, sampled at
every step. This module turns it into four things:

* **series**: every step in display units (psia, kg/s, N), one column per
  quantity, for the plots;
* **summary**: the numbers a design review asks for (burn time, total impulse,
  the pressure ladder at T-0 and at its lowest, injector stiffness at its
  lowest, residuals);
* **events**: when things happened (T-0 settle, ignition, lowest tank pressure,
  depletion);
* **provenance**: everything needed to say what this run was: the drawing's
  hash, the config's hash, the setup, the plan, the engine calibration, and every
  parameter the drawing did not state.

Integrals use the same rule the burn's mass bookkeeping uses: each step's value
times that step. The library's conservation test checks that rule against
tank inventory.
"""

from __future__ import annotations

import math
import time
from dataclasses import asdict
from typing import Any, Callable, Dict, List, Optional

from engine.layerx.prepare import PSI, Prepared

G0 = 9.80665

Progress = Callable[[str, float], None]


def _psia(values: List[float]) -> List[float]:
    return [v / PSI for v in values]


def _clean(value: Any) -> Any:
    """JSON-safe: NaN and inf become None, tuples become lists."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    return value


class StandTripped(RuntimeError):
    """The stand tripped before the burn recorded a single step -- in the settle to lockup, before
    the lead-in -- so there is no burn to reduce. ``record`` is the trip as ``result.tripped``
    carries it (DATA-CONTRACT 4, lib/feedtwin's ``trip_record``). A trip after the first recorded
    step is not an exception: the burn stops there and the result says so (``result.tripped``)."""

    def __init__(self, record: Dict[str, Any]) -> None:
        self.record = dict(record)
        what = self.record.get("message") or (f"{self.record.get('label') or self.record.get('vessel') or 'a vessel'} "
                                             f"over its {self.record.get('mawp_psia')} psia trip")
        super().__init__(f"the stand tripped in the settle to lockup, before T-0: {what}")


def _setup_dict(setup: Any) -> Dict[str, Any]:
    out = {}
    for key, value in asdict(setup).items():
        if isinstance(value, (int, float, str, bool)) or value is None:
            out[key] = value
    return out


def _burn_once(prep: Prepared, schedule: Optional[tuple], say: Progress, cancelled: Callable[[], bool],
               lo: float, hi: float, accel: Optional[Dict[str, Any]] = None, pass_no: int = 1,
               inline: Optional[Callable[..., Any]] = None) -> tuple:
    """One twin pass. ``schedule`` is ``(t, A_throat)`` from the previous replay, applied to the
    chamber before every step; ``None`` is the as-built throat. ``accel`` is the flight's proper
    acceleration on the burn's clock (``flight.fly``), applied to every liquid column once the
    engine fires; ``None`` is the pad's one g throughout.

    ``inline`` (AUDIT D5-C) builds a :class:`flight.InlineAscent`
    from the trace and session at Fire; it is then advanced at every later sample on that
    sample's thrust and propellant flow, and its specific force is the acceleration the next step
    burns at, exactly as ``accel`` is applied (one step of lag). A held vehicle reads exactly one
    g0, so the lead-in and a vehicle still on the pad are the pad's burn. The ascent is returned
    as the trace's ``inline_ascent`` record (``None`` without it)."""
    from dataclasses import replace

    from feedtwin.session.burn import BurnTrace, burn, find_probes, open_session, prime_at_t0

    import numpy as np

    model = prep.assembler() if prep.assembler is not None else prep.model
    chamber = model.chamber
    a0 = float(prep.link.design.throat_area) if prep.link is not None else float(chamber.throat_area)
    chamber.throat_area = a0
    hookup = None
    if prep.settings.dome_regulator:
        # The rail named the regulator the dome dial sets (2026-10-07): the session's dome knob drives
        # that one alone, as the feed twin's Hookup page would have it. Unnamed, the session drives
        # what its own dome knob always drove, exactly as before.
        from feedtwin.session.hookup import DOME, Hookup, Knob

        hookup = Hookup(knobs=(Knob(id=DOME, label="Layer X dome",
                                    regulators=(prep.settings.dome_regulator,),
                                    psig=float(prep.setup.dome_psi)),))
    session = open_session(model, prep.machine, setup=prep.setup, hookup=hookup)
    say("Settling to tank pressure", lo)
    settled = prime_at_t0(session, prep.plan)
    # The drawing's own transducers are read too, so a burn says what each DAQ channel should show.
    # And the whole network, every step (DATA-CONTRACT 2): recording only -- it reads the sample a
    # step already produced and changes no number (the LE4 golden burn is bit-identical with it).
    from dataclasses import replace as _replace

    probes = _replace(find_probes(session), network=True, instruments={
        i.id: i.node for i in getattr(session.model.built, "instruments", ()) if i.node in session.model.built.network.nodes})
    trace = BurnTrace(probes=probes, t0_settled=settled)
    own = trace.recorder(session)
    initial = {k: float(s.state.liquid_mass) for k, s in session.tanks.items()}
    watched = [t for t in (prep.plan.tanks or tuple(session.tanks)) if t in session.tanks]
    ascent: Dict[str, Any] = {"vehicle": None, "t": [], "accel_m_s2": []}

    def record(clock: float, sample: Any, firing: bool) -> None:
        own(clock, sample, firing)
        if schedule is not None and firing:
            # The throat the next step burns through: the replay's eroded throat at the end of
            # this one (one step of lag, ~0.08 % of area on this engine).
            chamber.throat_area = float(np.interp(clock, schedule[0], schedule[1]))
        if accel is not None and (firing or clock > -1e-6):
            # Likewise the acceleration: the flight's at the end of this step, for the next. The
            # last lead-in sample (clock 0) sets it for the first firing step, which otherwise
            # burned at the pad's one g.
            a = float(np.interp(clock, accel["t"], accel["accel_m_s2"]))
            session.setup = replace(session.setup, body_acceleration=a)
        elif inline is not None and (firing or clock > -1e-6):
            # The same, from the 1-DOF ascent this pass is flying as it burns: placed on the pad at
            # the last lead-in sample (Fire, clock 0) with the vehicle as Fire finds it.
            if ascent["vehicle"] is None:
                ascent["vehicle"] = inline(trace, initial, clock)
            ch = trace.chamber
            a = float(ascent["vehicle"].advance(clock, ch["thrust_N"][-1], ch["mdot_oxidiser"][-1] + ch["mdot_fuel"][-1]))
            ascent["t"].append(float(clock))
            ascent["accel_m_s2"].append(a)
            session.setup = replace(session.setup, body_acceleration=a)
        if firing and watched:
            used = max(1.0 - session.tanks[t].state.liquid_mass / max(initial[t], 1e-9) for t in watched)
            say(f"Burning, pass {pass_no}" if pass_no > 1 else "Burning", lo + (hi - lo) * min(max(used, 0.0), 1.0))

    try:
        trace.end = burn(session, prep.plan, record, cancelled=cancelled)
    finally:
        chamber.throat_area = a0
    trace.notes = list(dict.fromkeys(session.assumptions))
    if trace.end.cancelled:
        from engine.layerx.pool import Cancelled

        raise Cancelled()
    trip = getattr(trace.end, "tripped", None)
    if trip is not None and not trace.t:
        from feedtwin.session.burn import trip_record

        raise StandTripped(trip_record(trace) or {})
    if trip is not None and trace.t[-1] - float(trip.t) > 1e-12 and (len(trace.t) < 2 or float(trip.t) > trace.t[-2]):
        # The tripping step's sample is the stand as it tripped: Session.step stops its inner
        # live-step loop on the trip (core.py), so that frame is at the trip's instant, but burn()
        # stamps it with the full step's clock (25 ms late at a 50 ms step and a 25 ms live step).
        # Stamped at the trip, the last step's length -- and the impulse, burn time and every
        # integral over it -- end where the stand stopped.
        trace.t[-1] = float(trip.t)
    trace.inline_ascent = ascent if inline is not None else None  # type: ignore[attr-defined]
    return trace, initial


def run_prepared(
    prep: Prepared,
    *,
    progress: Optional[Progress] = None,
    cancelled: Callable[[], bool] = lambda: False,
    runner: Any = None,
    replay: bool = True,
    config: Any = None,
    diagnostics: bool = False,
    sidecars: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Burn ``prep`` and return the reduced result.

    With ``replay`` (and an EngineDesign engine), the burn is closed against EngineDesign's
    time-varying solve with the chamber eroding (:mod:`engine.layerx.replay`): twin pass,
    replay, twin pass again with the replay's throat history, until that history stops moving.
    ``runner`` (EngineDesign's, through its own feed lines) is used for the Forward-mode
    cross-check; without it that check is skipped.

    With ``prep.settings.flight`` and the engine ``config``, the burn first settles on the pad (the
    stand's answer), then flies: a 1-DOF ascent stepped inside each further pass, from the pad's
    throat history until it stops moving, and RocketPy flies the settled burn once. The RocketPy
    outer loop this replaced gave the same burn (LE4 He: impulse 0.006 %, apogee 0.01 m) in 5
    passes and 247 s against 2 and 100 s. ``result["flight"]`` carries the flight and the
    pad-against-flight comparison.

    ``diagnostics`` (DATA-CONTRACT 3): after the burn has settled, every diagnostic that reads it
    (:func:`diagnostics_of`) into ``result["diagnostics"]``, the soak-back after the final replay,
    and the stable event keys. They read the burn and change nothing in it; each one that fails
    is ``{available: false, error}`` and the burn stands. The router asks for them on every run a
    person starts; the tools that burn many candidates (sweep, set point, optimiser, reconcile)
    leave them off and grade their candidates themselves. ``result["limits"]`` (the graded list,
    :func:`grade_limits`) is written either way.

    ``sidecars``, a dict, receives the final replay's axial heat-flux grids as ``["axial"]``
    (DATA-CONTRACT 4): too large for the run record, so the caller stores it beside it.

    Every pass records the whole feed network (``result["network"]``, DATA-CONTRACT 2): recording
    only, no number moves. A vessel over the trip pressure its drawing declares ends the burn on
    that step (lib/feedtwin ``burn``): the result carries ``tripped``, a ``fail`` event keyed
    ``trip``, ``converged: False``, and totals that stop at the trip. That pass is replayed for its
    delivered figures if it fired, and neither iterated nor flown. A trip in the settle, before
    the burn recorded a step, raises :class:`StandTripped`.
    """
    from feedtwin import __version__ as feedtwin_version

    from engine.layerx import flight as flt
    from engine.layerx import replay as rpl
    from engine.layerx.prepare import options

    if not prep.ok:
        raise ValueError("preflight has failing checks; fix them before running")
    say = progress or (lambda stage, fraction: None)
    started = time.perf_counter()
    opts = options(prep.settings)
    loop = replay and prep.link is not None and prep.link.sampler is not None
    feedback = loop and prep.link.mode in ("card", "calibrated")
    flying = bool(prep.settings.flight) and config is not None
    # The ascent is stepped inside the burn (``_inline_factory``); RocketPy flies the settled burn once.
    # Flown, the burn first settles on the pad -- the stand's answer, kept for the pad-against-flight
    # comparison -- and then flies, starting from the pad's throat history.
    inline = flying
    on_pad = flying
    passes: List[Dict[str, Any]] = []
    schedule = None
    accel: Optional[Dict[str, Any]] = None
    flown: Optional[Dict[str, Any]] = None
    ground: Optional[Dict[str, Any]] = None
    rp: Dict[str, Any] = {"available": False}
    axial: Optional[Dict[str, Any]] = None
    ascent: Optional[Dict[str, Any]] = None
    make_ascent = _inline_factory(prep, config) if inline else None
    budget = (rpl.MAX_PASSES if feedback else 1) * (2 if flying else 1)
    pad_passes = 0
    span = 0.8 / budget
    for n in range(1, budget + 1):
        lo = 0.03 + (n - 1) * span
        trace, initial = _burn_once(prep, schedule, say, cancelled, lo, lo + 0.8 * span, accel, pass_no=n,
                                    inline=None if on_pad else make_ascent)
        result = reduce_trace(prep, trace, initial)
        ascent = getattr(trace, "inline_ascent", None)
        # A vessel trip ends the burn on the step that found it (lib/feedtwin ``burn``): this pass is
        # the answer, a failed one. It is replayed for its delivered figures when it fired at all, and
        # neither iterated nor flown -- a later pass would trip again, and a flight of a burn cut
        # short by a trip is not the vehicle's.
        tripped = result.get("tripped") is not None
        if not (loop or flying):
            break
        entry: Dict[str, Any] = {"pass": n, "throat_applied": schedule is not None, "accel_applied": accel is not None,
                                 "burn_time_s": result["summary"]["burn_time_s"]}
        if inline and not on_pad:
            entry["accel_inline"] = True
        if tripped:
            entry["tripped"] = True
        passes.append(entry)
        new = None
        throat_done = True
        dv = None
        if loop and tripped and not any(result["series"]["firing"]):
            # Tripped in the lead-in: nothing fired, so there is no burn to erode.
            rp = {"available": False, "error": "the stand tripped before Fire: no firing steps to replay"}
        elif loop:
            say(f"Nozzle erosion, pass {n}", lo + 0.85 * span)
            kept: Dict[str, Any] = {}
            rp = rpl.replay(prep, result["series"], sidecars=kept, chug_eroded_geometry=opts["chug_eroded"])
            axial = kept.get("axial")
            if not rp.get("available"):
                # Said once, by name: otherwise a failed replay reads as an unsettled throat.
                result["events"].append({"t": result["series"]["t"][-1], "kind": "warn", "label": "Erosion replay failed",
                                         "detail": f"{rp.get('error') or 'unavailable'}; thrust and Pc are the as-built "
                                                   "throat's, not the eroding nozzle's."})
            new = rpl.throat_schedule(rp)
            change = rpl.schedule_change(schedule, new)
            entry.update({"throat_growth": (float(new[1][-1] / new[1][0] - 1.0) if new is not None else None),
                          "schedule_change": change, "agreement": rpl.agreement(rp, result["series"])})
            throat_done = not feedback or new is None or (schedule is not None and change < rpl.THROAT_TOLERANCE)
            dv = _delivered(rp, result, prep.plan.dt)
        if tripped:
            break
        if on_pad:
            pad_passes += 1
            if throat_done or pad_passes >= budget // 2:
                # The pad's answer, settled: what the stand will see. The flight starts from its throat.
                ground = _pass_figures(result, dv)
                entry.update(ground)
                on_pad = False
        elif throat_done:
            if flying:
                entry.update(_pass_figures(result, dv))
            break
        if feedback and new is not None:
            schedule = new

    soak_s = None
    if diagnostics and loop and rp.get("available"):
        # Straight after the final replay: the soak continues the wall state its coupled solve
        # ended with, and the runner keeps only its last one (replay.soak_back refuses another's).
        say("Soak-back", 0.86)
        t_soak = time.perf_counter()
        rp["soak"] = rpl.soak_back(prep, rp)
        soak_s = time.perf_counter() - t_soak
    if inline and config is not None and not tripped:
        # The burn flew its own ascent in every pass; RocketPy flies the settled burn once, for
        # the apogee, the vehicle's stability and the rail exit (AUDIT D5-C).
        say("Flight", 0.87)
        dv_now = _delivered(rp, result, prep.plan.dt) if loop and rp.get("available") else None
        flown = flt.fly(config, _flight_curve(result, dv_now), _loads(result), prep.ambient_pa,
                        pressurant_kg=_pressurant_kg(result), copv_volume_L=prep.derived.get("copv_volume_L"),
                        liftoff_mass_kg=prep.settings.liftoff_mass_kg,
                        ullage_gas_kg=_safe(_ullage_gas_kg, prep, result),
                        pressurant_gas=prep.derived.get("pressurant_gas"))
        if not flown.get("ok"):
            result["events"].append({"t": result["series"]["t"][-1], "kind": "warn", "label": "Flight failed",
                                     "detail": str(flown.get("error") or "the flight simulation did not fly")})

    say("Checking", 0.9)
    if passes:
        result["passes"] = passes
        last = passes[-1]
        # A replay that was asked for and failed leaves the as-built throat's burn: not settled.
        replay_failed = loop and not rp.get("available")
        throat_settled = (not feedback and not replay_failed) or (not replay_failed and (
            (len(passes) >= 2 and last["schedule_change"] < rpl.THROAT_TOLERANCE)
            or (len(passes) == 1 and last.get("throat_growth") is not None
                and abs(last["throat_growth"]) < rpl.THROAT_TOLERANCE)))
        # A flight that failed on the first try leaves the pad's burn, which is settled as such; one
        # that failed later leaves a burn carrying the previous flight's acceleration, which is not.
        # Inline, the ascent is solved inside every pass: the acceleration settles with the throat.
        late_failure = bool(last.get("flight_error")) and bool(last.get("accel_applied"))
        accel_settled = (not flying) or inline or (bool(last.get("flight_error")) and not late_failure) or \
            (last.get("accel_change", math.inf) < flt.ACCEL_TOLERANCE)
        result["converged"] = bool(throat_settled and accel_settled)
        if not result["converged"] and not tripped:
            what = []
            if replay_failed:
                what.append("the erosion replay failed, so thrust and Pc are the as-built throat's")
            elif not throat_settled:
                what.append(f"the throat history still moved {(last.get('schedule_change') or 0.0) * 100:.3f} %")
            if late_failure:
                what.append("the flight failed, so this burn carries the previous flight's acceleration")
            elif not accel_settled:
                what.append(f"the flight's acceleration still moved {last.get('accel_change', math.inf) * 100:.3f} %")
            result["events"].append({"t": result["series"]["t"][-1], "kind": "warn",
                                     "label": "Burn did not settle",
                                     "detail": f"After {len(passes)} passes " + " and ".join(what) + "."})
    if tripped:
        # Stopped at a vessel trip (the ``trip`` event says where and why): a failed burn, whatever
        # the passes did. Every tool that grades burns reads ``tripped`` as failing.
        result["converged"] = False
    if loop:
        result["replay"] = rp
        result["delivered"] = _delivered(rp, result, prep.plan.dt)
    if flying and tripped:
        trip = result["tripped"]
        result["flight"] = {"ok": False, "error": (
            f"not flown: the burn stopped at a vessel trip ({trip.get('label') or trip.get('vessel')}) at "
            f"t = {float(trip.get('t') or 0.0):.3f} s, so its thrust curve is not the vehicle's")}
    elif flying:
        result["flight"] = _flight_block(prep, flown, ground, passes[-1] if passes else None)
        if inline and isinstance(result["flight"], dict):
            result["flight"].update(_inline_block(ascent, flown, flt))
    dv = result.get("delivered")
    if dv is not None:
        # The air the nozzle exhausts into, step by step: the site's on the pad; in flight, the air
        # at the vehicle's altitude. The plume's expansion state is the exit pressure against it.
        ambient = [prep.ambient_pa / PSI] * len(dv["t"])
        trajectory = (flown or {}).get("trajectory") if flying and (result.get("flight") or {}).get("ok") else None
        if trajectory and config is not None and dv["t"]:
            import numpy as np

            from engine.core.runner import compute_ambient_pressure_from_elevation

            site = float(getattr(getattr(config, "environment", None), "elevation", 0.0) or 0.0)
            heights = np.interp(dv["t"], trajectory["t"], trajectory["altitude_m"])
            ambient = [compute_ambient_pressure_from_elevation(site + float(h)) / PSI for h in heights]
        dv["ambient_psia"] = ambient
    if config is not None:
        # The engine's size and dry mass, for the .eng export (engine/layerx/eng.py): a run does not
        # keep its config, and the design may have moved by the time the curve is exported.
        from engine.layerx.eng import motor_header

        try:
            result["motor"] = motor_header(config)
        except Exception as exc:  # noqa: BLE001 - the export then asks for the dimensions
            result["motor"] = {"error": f"{type(exc).__name__}: {exc}"}
        # The drawing's feed against the design's, per side, and the K0 that makes them agree.
        from engine.layerx.feedfit import design_update, fit_feed

        try:
            result["feed_fit"] = fit_feed(prep, result, config)
            if result["feed_fit"].get("available"):
                # What "write into the design" sends (PUT /api/config, merged); the UI adds the run id.
                result["feed_fit"]["design_update"] = design_update(result["feed_fit"], run_id="")
        except Exception as exc:  # noqa: BLE001 - a fit that cannot run is reported, the burn stands
            result["feed_fit"] = {"available": False, "error": f"{type(exc).__name__}: {exc}"}
    if prep.link is not None and prep.link.sampler is not None:
        say("Checking", 0.93)
        result["engine_check"] = engine_check(prep, result)
    if runner is not None:
        say("Checking", 0.96)
        result["cross_check"] = cross_check(prep, result, runner)
    result["test_mode"] = opts["test_mode"]
    burn_wall = time.perf_counter() - started - (soak_s or 0.0)
    if diagnostics:
        say("Diagnostics", 0.97)
        t_diag = time.perf_counter()
        result["diagnostics"], wall = diagnostics_of(prep, result, config, runner, opts)
        if soak_s is not None:
            wall["soak"] = soak_s
        result["provenance"]["diagnostics_wall_s"] = {
            "burn": burn_wall, "diagnostics": time.perf_counter() - t_diag + (soak_s or 0.0), "blocks": wall}
        if axial is not None and sidecars is not None:
            sidecars["axial"] = axial
    # The grading, the event keys and the record read the finished result; none may cost the burn.
    try:
        result["limits"] = grade_limits(result, prep, config, opts)
    except Exception as exc:  # noqa: BLE001 - a run that cannot be graded is still a run
        result["limits"] = _failed(exc)
    try:
        _key_events(result, prep, opts)
    except Exception as exc:  # noqa: BLE001
        result["events"].append({"t": result["series"]["t"][-1], "kind": "warn", "key": "warn:events",
                                 "label": "Event keys", "detail": f"{type(exc).__name__}: {exc}"})
    try:
        result["provenance"]["models"] = model_record(result, prep)
    except Exception as exc:  # noqa: BLE001
        result["provenance"]["models"] = _failed(exc)
    # The hand-off is the curve the flight flies, so the Flight tab flying it gets the apogee this
    # run reports.
    result["timeseries"] = _flight_curve(result, result.get("delivered"))
    result["provenance"]["wall_s"] = time.perf_counter() - started
    result["provenance"]["feedtwin_version"] = feedtwin_version
    result["provenance"]["phase"] = 6 if prep.settings.flight else 3
    say("Done", 1.0)
    return _clean(result)


# ---------------------------------------------------------------- the inline ascent (D5-C)


def _trace_ullage_gas_kg(prep: Prepared, trace: Any) -> Optional[float]:
    """The gas in both tanks' ullages at the trace's latest sample [kg]: as :func:`_ullage_gas_kg`
    prices it (the drawing's tank volumes, the twin's fill, pressure and gas temperature,
    CoolProp's density), read live from the trace instead of a finished result."""
    import CoolProp.CoolProp as CP

    gas = prep.derived.get("pressurant_gas")
    volumes = prep.derived.get("tank_volumes_L") or {}
    if not gas:
        return None
    total = 0.0
    for role in ("oxidiser", "fuel"):
        tank = prep.roles.get(role, "")
        v_L = volumes.get(tank)
        col = trace.tank.get(tank) or {}
        if not v_L or not col.get("fill_fraction"):
            return None
        ullage = v_L * 1e-3 * (1.0 - float(col["fill_fraction"][-1]))
        rho = CP.PropsSI("D", "P", float(col["pressure_Pa"][-1]), "T", float(col["ullage_temperature_K"][-1]), str(gas))
        total += rho * max(ullage, 0.0)
    return total


def _inline_factory(prep: Prepared, config: Any) -> Callable[[Any, Dict[str, float], float], Any]:
    """What :func:`_burn_once` calls at Fire to place the inline ascent's vehicle on the pad: the
    vehicle the RocketPy flight would fly (``flight.liftoff_mass`` books it the same way), with
    the loads, the bottle's gas and the ullage gas the trace holds at that instant. A weighed
    liftoff mass (``settings.liftoff_mass_kg``) wins."""
    from engine.layerx import flight as flt

    def make(trace: Any, initial: Dict[str, float], clock: float) -> Any:
        loads = {"oxidiser": float(initial[prep.roles["oxidiser"]]), "fuel": float(initial[prep.roles["fuel"]])}
        bottle = trace.probes.bottles[0] if trace.probes.bottles else ""
        mass = (trace.bottle.get(bottle) or {}).get("mass_kg") or []
        booked = flt.liftoff_mass(config, loads, ambient_pa=prep.ambient_pa,
                                  pressurant_kg=float(mass[-1]) if mass and mass[-1] else None,
                                  copv_volume_L=prep.derived.get("copv_volume_L"),
                                  ullage_gas_kg=_safe(_trace_ullage_gas_kg, prep, trace),
                                  pressurant_gas=prep.derived.get("pressurant_gas"),
                                  weighed_kg=prep.settings.liftoff_mass_kg)
        vehicle = flt.InlineAscent.from_config(config, float(booked["value"]), prep.ambient_pa)
        vehicle.booked = booked  # type: ignore[attr-defined] - the run record's liftoff mass
        return vehicle

    return make


def _inline_block(ascent: Optional[Dict[str, Any]], flown: Optional[Dict[str, Any]], flt: Any) -> Dict[str, Any]:
    """``result.flight`` additions for the inline ascent: the acceleration the final
    pass burned at, the vehicle it flew, and how far it is from RocketPy's on the same burn."""
    out: Dict[str, Any] = {"coupling": "inline"}
    if not ascent or ascent.get("vehicle") is None:
        out["inline"] = {"available": False, "error": "the burn never reached Fire"}
        return out
    vehicle = ascent["vehicle"]
    sched = {"t": list(ascent["t"]), "accel_m_s2": list(ascent["accel_m_s2"])}
    booked = getattr(vehicle, "booked", {}) or {}
    rocketpy = (flown or {}).get("schedule") if (flown or {}).get("ok") else None
    out["inline"] = {
        "available": True,
        "t": sched["t"],
        "accel_m_s2": sched["accel_m_s2"],
        "accel_g": [a / G0 for a in sched["accel_m_s2"]],
        "liftoff_mass_kg": booked.get("value"),
        "liftoff_mass": booked,
        "liftoff_time_s": vehicle.liftoff_time_s,
        "end_altitude_m": vehicle.z,
        "end_velocity_m_s": vehicle.v,
        # The largest relative difference against RocketPy's specific force on the settled burn, over
        # the firing samples: the inline model's own check (AUDIT D5-C; 0.46 % on LE4 He).
        "vs_rocketpy": _schedule_gap(sched, rocketpy) if rocketpy else None,
        "vs_rocketpy_basis": ("max |a_inline - a_RocketPy| / a_RocketPy over the firing samples, RocketPy's "
                              "interpolated onto the burn's; Fire (clock 0) and the last sample left out: at Fire "
                              "the inline vehicle is still held (1 g0, no thrust yet) where RocketPy reads the "
                              "first firing sample's thrust, and the last sample is the depletion instant"),
        "model": {
            "name": "inline_vertical_1dof",
            "source": flt.INLINE_SOURCE,
            "assumptions": [
                "vertical flight from the pad: the rail's inclination, wind and attitude are ignored",
                "standard gravity g0 throughout (Somigliana at the site is ~0.11 % less)",
                "advanced inside every burn pass on that pass's thrust and flow; each step burns at the "
                "previous sample's specific force (one step of lag, as the outer coupling applies it)",
                "RocketPy flies the settled burn once afterwards for the apogee, stability and rail exit; it does "
                "not feed back",
            ],
            "inputs": {
                "liftoff_mass_kg": {"value": booked.get("value"), "unit": "kg",
                                    "provenance": booked.get("source") or "flight.liftoff_mass"},
            },
        },
    }
    return out


def _schedule_gap(inline: Dict[str, Any], rocketpy: Dict[str, Any]) -> Optional[float]:
    """See ``vs_rocketpy_basis`` in :func:`_inline_block`."""
    import numpy as np

    t = np.asarray(inline["t"], float)
    a = np.asarray(inline["accel_m_s2"], float)
    ref = np.interp(t, np.asarray(rocketpy["t"], float), np.asarray(rocketpy["accel_m_s2"], float))
    keep = (t > 1e-9) & (np.arange(len(t)) < len(t) - 1) & (np.abs(ref) > 0.0)
    if not keep.any():
        return None
    return float(np.max(np.abs(a[keep] - ref[keep]) / np.abs(ref[keep])))


# ---------------------------------------------------------------- diagnostics (DATA-CONTRACT 3)

#: The diagnostics blocks, in the order they are computed (each may read the ones before it).
DIAGNOSTIC_KEYS = ("stability", "hardware", "ladder", "regulator", "solenoids", "pressurant", "saturation",
                   "cavitation", "injector", "thrust_shape", "ledger", "start", "outflow", "shutdown",
                   "water_hammer", "vv")
#: The keys ``engine.layerx.diag.ledger.build_feed_diagnostics`` produces together.
FEED_KEYS = ("ladder", "regulator", "solenoids", "pressurant", "saturation", "cavitation", "injector",
             "thrust_shape", "ledger")


def _failed(exc: BaseException) -> Dict[str, Any]:
    return {"available": False, "error": f"{type(exc).__name__}: {exc}"}


def diagnostics_of(prep: Prepared, result: Dict[str, Any], config: Any, runner: Any,
                   opts: Optional[Dict[str, Any]] = None) -> tuple:
    """Every DATA-CONTRACT 3 block for a settled burn: ``(diagnostics, wall_s per block)``.

    Each block is its module's (``engine/layerx/diag``), called on the finished result; the
    order lets a block read the ones before it (the shutdown reads the gas-ingestion onsets, the
    water hammer the start's arrival). A block that raises is ``{available: false, error}``; none
    can take the burn down. ``opts`` are :func:`engine.layerx.prepare.options` (the run's)."""
    from engine.layerx.prepare import options

    opts = opts or options(prep.settings)
    out: Dict[str, Any] = {}
    wall: Dict[str, float] = {}
    link = prep.link
    sampler = getattr(link, "sampler", None) if link is not None else None

    def block(name: str, fn: Callable[[], Any]) -> Any:
        t0 = time.perf_counter()
        try:
            value = fn()
        except Exception as exc:  # noqa: BLE001 - a diagnostic never takes the burn with it
            value = _failed(exc)
        wall[name] = time.perf_counter() - t0
        return value

    from engine.layerx.diag import hardware as hw
    from engine.layerx.diag import ledger as fd
    from engine.layerx.diag import outflow as of
    from engine.layerx.diag import shutdown as sd
    from engine.layerx.diag import stability as stab
    from engine.layerx.diag import start as st
    from engine.layerx.diag import vv
    from engine.layerx.diag import waterhammer as wh

    # The chug margin on the chosen feed basis; the other basis rides along as ``other_basis``.
    out["stability"] = block("stability", lambda: stab.stability_block(
        prep, result, config, basis=opts["chug_basis"], eroded=opts["chug_eroded"]))
    out["hardware"] = block("hardware", lambda: hw.hardware_block(
        prep, result.get("replay"), result.get("delivered"), result.get("series")))
    feed = block("feed", lambda: fd.build_feed_diagnostics(result, prep, config, runner=runner, sampler=sampler))
    for key in FEED_KEYS:
        value = feed.get(key) if isinstance(feed, dict) and feed.get("available", True) is not False else None
        out[key] = value if value is not None else (feed if isinstance(feed, dict) and feed.get("available") is False
                                                    else {"available": False, "error": f"{key}: not built"})
    out["start"] = block("start", lambda: st.start_from_run(prep, result, config, st.StartSettings(
        fuel_lead_s=opts["fuel_lead_s"], valve_travel_s=opts["valve_travel_s"])))
    out["outflow"] = block("outflow", lambda: of.outflow_from_run(prep, result, of.OutflowSettings(
        outlet_d_mm=tuple(opts["outlet_d_mm"]))))
    # A burn a vessel trip stopped ended with both tanks wet: its tail-off is a cutoff at the trip, the
    # mains taken as commanded shut there (the stand's own abort sequence is not modelled).
    trip = result.get("tripped") if isinstance(result.get("tripped"), dict) else None
    cut = float(trip["t"]) if trip and isinstance(trip.get("t"), (int, float)) and trip["t"] > 0 else None

    def shutdown() -> Any:
        # No tank ran dry, so the burn time is the trip's and not a dry-out: hidden from the block,
        # which otherwise reads it as one (a gas-ingestion onset before the trip still counts).
        view = result if cut is None else {
            **result, "summary": {**(result.get("summary") or {}), "burn_time_s": None, "depletion_s": None}}
        value = sd.shutdown_from_run(prep, view, config, sd.ShutdownSettings(cutoff_s=cut),
                                     outflow=out["outflow"] if isinstance(out["outflow"], list) else None)
        if cut is not None and isinstance(value, dict) and value.get("first_dry_basis") == "timed cutoff with both tanks wet":
            value["first_dry_basis"] = (f"the vessel trip at t = {cut:.3f} s, taken as the mains commanded shut there "
                                        "with both tanks wet (the stand's abort sequence is not modelled)")
        return value

    out["shutdown"] = block("shutdown", shutdown)
    out["water_hammer"] = block("water_hammer", lambda: wh.waterhammer_from_run(
        prep, result, config, start=out["start"] if isinstance(out["start"], dict) else None))
    # Last: the balances read the whole result, the network record when there is one.
    out["vv"] = block("vv", lambda: vv.check(result, prep))
    return out, wall


# ---------------------------------------------------------------- limits (DATA-CONTRACT 1)

#: Limits a new diagnostic grades, held at amber at worst until the team has reviewed them: their
#: ratings and thresholds are estimates (coordinator decision, 2026-10-03). ``key`` prefixes.
REVIEW_PENDING = ("water_hammer", "saturation", "cavitation", "separation", "regulator_wide_open", "outflow",
                  "conservation")
REVIEW_NOTE = ("Graded amber at worst until the team has reviewed this check: the rating or threshold it is "
               "held against is an estimate (Layer X integration, 2026-10-03).")
#: What the graded chug margin is on, and why: AUDIT D7, the user's decision.
CHUG_DECISION = ("D7: the graded chug margin stays on today's basis (EngineDesign's feed_system) and today's "
                 "whole-burn minimum, start included, until the user decides; the drawing basis and the "
                 "settled minimum (from the first full-flow step) are shown alongside.")


def _review_pending(key: str) -> bool:
    return any(key == p or key.startswith(p + "_") for p in REVIEW_PENDING)


def grade_limits(result: Dict[str, Any], prep: Any = None, config: Any = None,
                 opts: Optional[Dict[str, Any]] = None, *,
                 meop_psi: Optional[Dict[str, float]] = None) -> List[Dict[str, Any]]:
    """``result["limits"]``: :func:`engine.layerx.diag.limits.grade` with the run's choices.

    * **Chug** (D7). On the ``config`` basis (the default) the graded ``chug_margin`` is today's:
      the delivered whole-burn minimum, start included, as before the diagnostics existed. The
      stability block's settled minimum is added beside it as ``chug_margin_settled`` and the
      other basis as ``chug_margin_other_basis``, both ``info``. On ``drawing`` the stability
      block is graded as ``diag.limits`` grades it (the settled minimum on the drawing basis).
    * **Review pending.** A limit from a new diagnostic (:data:`REVIEW_PENDING`) grades ``warn``
      at worst; one that would have been ``bad`` says so (``capped_from``).
    * The design's tank cap grades ``warn`` (D11), as ``diag.limits`` already grades it.
    """
    from engine.layerx.diag.limits import grade

    if opts is None:
        from engine.layerx.prepare import options

        opts = options(prep.settings) if prep is not None else {"chug_basis": "config"}
    diag = result.get("diagnostics") if isinstance(result.get("diagnostics"), dict) else None
    stab = (diag or {}).get("stability")
    on_drawing = opts.get("chug_basis") == "drawing"
    if on_drawing or not isinstance(stab, dict) or stab.get("available") is False:
        entries = grade(result, prep, config, meop_psi=meop_psi)
    else:
        # Today's chug grade: the result as it was before the stability block existed.
        without = {**result, "diagnostics": {k: v for k, v in diag.items() if k != "stability"}}
        entries = [e for e in grade(without, prep, config, meop_psi=meop_psi)]
        alongside = [e for e in grade({**result, "diagnostics": {"stability": stab}}, prep, config, meop_psi=meop_psi)
                     if str(e.get("key", "")).startswith("chug_margin")]
        at = next((i for i, e in enumerate(entries) if e.get("key") == "chug_margin"), len(entries) - 1)
        extra = []
        for e in alongside:
            if e.get("key") == "chug_margin":
                e = {**e, "key": "chug_margin_settled", "label": "Chug margin, settled (from full flow)",
                     "grade": "info", "decision": "D7",
                     "hint": (e.get("hint") or "") + " Reported, not graded: " + CHUG_DECISION}
            elif e.get("key") == "chug_margin_start":
                continue  # the graded minimum above already includes the start window
            else:
                e = {**e, "decision": "D7"}
            extra.append(e)
        for e in entries:
            if e.get("key") == "chug_margin":
                e["decision"] = "D7"
                e["hint"] = (e.get("hint") or "") + " " + CHUG_DECISION
        entries[at + 1:at + 1] = extra
    out = []
    for e in entries:
        e = dict(e)
        if _review_pending(str(e.get("key", ""))):
            e["review_pending"] = True
            if e.get("grade") == "bad":
                e["capped_from"] = "bad"
                e["grade"] = "warn"
                e["hint"] = (e.get("hint") or "") + " " + REVIEW_NOTE
        out.append(e)
    return out


# ---------------------------------------------------------------- events with stable keys

def _key_events(result: Dict[str, Any], prep: Prepared, opts: Dict[str, Any]) -> None:
    """Give every event a stable ``key`` (DATA-CONTRACT 4) and add the ones the diagnostics and
    the limits know: the fuel lead and ignition (start), the graded chug minimum, burnout and a
    vessel trip (kind ``fail``; :func:`reduce_trace` writes it first). Warnings are ``warn:<n>``,
    numbered in time order."""
    events: List[Dict[str, Any]] = result.setdefault("events", [])
    diag = result.get("diagnostics") or {}
    have = {e.get("key") for e in events if e.get("key")}

    def add(key: str, t: Optional[float], kind: str, label: str, detail: str) -> None:
        if key in have or t is None or not math.isfinite(float(t)):
            return
        events.append({"t": float(t), "kind": kind, "label": label, "detail": detail, "key": key})
        have.add(key)

    start = diag.get("start") if isinstance(diag.get("start"), dict) else {}
    if start.get("available", True) is not False:
        lead = start.get("fuel_lead_s")
        if lead:
            add("fuel_lead", -float(lead), "fire", "Fuel lead", f"Fuel main commanded {float(lead) * 1e3:.0f} ms before "
                "the LOX main (the start diagnostic's sequence; the burn opens both at Fire)")
        ign = start.get("ignition_s")
        if ign is not None:
            add("ignition", ign, "fire", "Ignition",
                f"Both manifolds primed (LOX {float(start.get('prime_ox_s') or 0) * 1e3:.1f} ms, fuel "
                f"{float(start.get('prime_fuel_s') or 0) * 1e3:.1f} ms after Fire); start transient model")
    chug = next((e for e in result.get("limits") or [] if e.get("key") == "chug_margin"), None)
    if chug and chug.get("t_worst") is not None and chug.get("value") is not None:
        add("min_chug", chug["t_worst"], "min", "Lowest chug margin",
            f"{float(chug['value']):.3f} ({chug.get('basis') or 'graded basis'})")
    s = result.get("summary") or {}
    trip = result.get("tripped")
    before_fire = isinstance(trip, dict) and isinstance(trip.get("t"), (int, float)) and trip["t"] < 0.0
    if s.get("burn_time_s") is not None and not before_fire:   # a trip in the lead-in: nothing burned out
        side = {"oxidiser": "LOX", "fuel": "fuel"}.get(s.get("depleted_side") or "", "")
        add("burnout", s["burn_time_s"], "end", "Burnout",
            f"{side} tank dry" if side else
            "Stopped by the vessel trip, with propellant in both tanks" if isinstance(trip, dict) else "End of the burn")
    if isinstance(trip, dict) and trip.get("t") is not None:
        add("trip", trip["t"], "fail", f"Vessel trip ({trip.get('label') or trip.get('vessel') or 'vessel'})",
            str(trip.get("message") or f"{trip.get('p_psia')} psia against {trip.get('mawp_psia')} psia"))
    events.sort(key=lambda e: e["t"])
    n = 0
    for e in events:
        if not e.get("key"):
            if e.get("kind") == "warn":
                e["key"] = f"warn:{n}"
                n += 1
            else:
                e["key"] = str(e.get("kind") or "event")


# ---------------------------------------------------------------- the run record's models

def model_record(result: Dict[str, Any], prep: Optional[Prepared] = None) -> List[Dict[str, Any]]:
    """Every model block in the result, flattened for the run record (DATA-CONTRACT rules: each
    block that rests on a model carries ``model: {name, source, assumptions, inputs}``):
    ``[{block, name, source, assumptions, inputs}]``, so Record lists every assumption, default
    and source in one place. Also the opt-in card chamber's (D4-B) when it was on."""
    found: List[Dict[str, Any]] = []

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            m = node.get("model")
            if isinstance(m, dict) and (m.get("name") or m.get("source")):
                found.append({"block": path, "name": m.get("name"), "source": m.get("source"),
                              "assumptions": list(m.get("assumptions") or []), "inputs": m.get("inputs") or {}})
            for k, v in node.items():
                if k != "model" and isinstance(v, (dict, list)):
                    walk(v, f"{path}.{k}" if path else str(k))
        elif isinstance(node, list):
            for i, v in enumerate(node):
                if isinstance(v, (dict, list)):
                    walk(v, f"{path}[{i}]")

    # The replay's own soak model is the hardware block's soak, already walked there.
    for key in ("diagnostics", "flight"):
        if isinstance(result.get(key), (dict, list)):
            walk(result[key], key)
    chamber = getattr(getattr(prep, "link", None), "chamber", None) if prep is not None else None
    if chamber is not None and hasattr(chamber, "model_block"):
        try:
            m = chamber.model_block()
            found.append({"block": "engine_card.chamber", "name": m.get("name"), "source": m.get("source"),
                          "assumptions": list(m.get("assumptions") or []), "inputs": m.get("inputs") or {}})
        except Exception:  # noqa: BLE001 - the record lists what it can
            pass
    return found

def _loads(result: Dict[str, Any]) -> Dict[str, float]:
    s = result["summary"]
    return {"oxidiser": float(s["ox"]["loaded_kg"]), "fuel": float(s["fuel"]["loaded_kg"])}


def _delivered(rp: Dict[str, Any], result: Dict[str, Any], dt: float) -> Optional[Dict[str, Any]]:
    """The replay's answers on the twin's steps (``replay.delivered``), plus its impulse to
    depletion: the replay's impulse carried to depletion in the same proportion as the twin's,
    so a comparison graded on the replay is graded on a smooth number too."""
    from engine.layerx import replay as rpl

    dv = rpl.delivered(rp, result["series"], dt)
    if dv is None:
        return None
    s = result["summary"]
    twin, to_dep = s.get("total_impulse_Ns"), s.get("impulse_to_depletion_Ns")
    dv["summary"]["impulse_to_depletion_Ns"] = (dv["summary"]["total_impulse_Ns"] * to_dep / twin
                                                if twin and to_dep else None)
    return dv


def _flight_curve(result: Dict[str, Any], dv: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The burn as the flight flies it and as Forward and the Flight tab receive it: the
    Time-Series payload. It starts with a sample at Fire and ends on the last step, which the
    burn already cut to land on depletion (BurnPlan.end_on_depletion), so its impulse moves
    smoothly with the design and nothing past the burn's own end is flown."""
    from engine.layerx import replay as rpl

    return rpl.timeseries_payload({**result, "delivered": dv})


def _safe(fn: Callable[..., Any], *args: Any) -> Any:
    try:
        return fn(*args)
    except Exception:  # noqa: BLE001 - an estimate that cannot be made falls back to the flight's own
        return None


def _ullage_gas_kg(prep: Prepared, result: Dict[str, Any]) -> Optional[float]:
    """The gas already in both tanks' ullages at Fire [kg]: the drawing's tank volumes, the twin's
    fill, pressure and gas temperature, CoolProp's density. It flies with the vehicle; the flight's
    own figure comes from the config's (smaller) tanks."""
    import CoolProp.CoolProp as CP

    gas = prep.derived.get("pressurant_gas")
    volumes = prep.derived.get("tank_volumes_L") or {}
    series = result["series"]
    fire = next((i for i, f in enumerate(series["firing"]) if f), None)
    if not gas or fire is None:
        return None
    total = 0.0
    for side, role in (("ox", "oxidiser"), ("fuel", "fuel")):
        v_L = volumes.get(prep.roles.get(role, ""))
        s = series[side]
        if not v_L or not s.get("fill_fraction"):
            return None
        i = max(fire - 1, 0)          # the last lead-in sample: the tank as Fire found it
        ullage = v_L * 1e-3 * (1.0 - float(s["fill_fraction"][i]))
        rho = CP.PropsSI("D", "P", float(s["tank_psia"][i]) * PSI, "T", float(s["ullage_K"][i]), str(gas))
        total += rho * max(ullage, 0.0)
    return total


def _pressurant_kg(result: Dict[str, Any]) -> Optional[float]:
    """The bottle's gas at the first firing step."""
    series = result["series"]
    mass = series.get("copv_mass_kg") or []
    fire = next((i for i, f in enumerate(series["firing"]) if f), None)
    return float(mass[fire]) if fire is not None and fire < len(mass) and mass[fire] else None


def _pass_figures(result: Dict[str, Any], dv: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """What a pass delivered, for the pad-against-flight comparison."""
    s = result["summary"]
    d = (dv or {}).get("summary") or {}
    out = {
        "total_impulse_Ns": d.get("total_impulse_Ns", s.get("total_impulse_Ns")),
        "mean_thrust_N": d.get("mean_thrust_N", s.get("mean_thrust_N")),
        "pc_mean_psia": d.get("pc_mean_psia", s.get("pc_mean_psia")),
        "isp_mean_s": d.get("isp_mean_s", s.get("isp_mean_s")),
        "burn_time_s": s.get("burn_time_s"),
        "of_mean": s.get("of_mean"),
        "ox_dp_injector_min_psi": None,
        "fuel_dp_injector_min_psi": None,
    }
    series = result["series"]
    fire = [i for i, f in enumerate(series["firing"]) if f]
    settled = [i for i in fire if series["t"][i] >= series["t"][fire[0]] + 0.2] if fire else []
    for side, key in (("ox", "ox_dp_injector_min_psi"), ("fuel", "fuel_dp_injector_min_psi")):
        vals = [series[side]["dp_injector_psi"][i] for i in settled if series[side]["dp_injector_psi"][i] is not None]
        out[key] = min(vals) if vals else None
        inlet = [series[side]["manifold_psia"][i] for i in settled if series[side].get("manifold_psia")]
        out[f"{side}_manifold_mean_psia"] = (sum(inlet) / len(inlet)) if inlet else None
    return out


def _flight_block(prep: Prepared, flown: Optional[Dict[str, Any]], ground: Optional[Dict[str, Any]],
                  last: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if flown is None:
        return {"ok": False, "error": "the burn was not flown"}
    if not flown.get("ok"):
        return flown
    out = dict(flown)
    final = {k: last.get(k) for k in (ground or {})} if last else None
    out["pad"] = ground
    out["in_flight"] = final
    out["vehicle_lines"] = prep.vehicle_lines
    return out


def _impulse_to_depletion(trace: Any, fire_idx: List[int], steps: Any, ox_tank: str, fuel_tank: str,
                          ch: Dict[str, List[float]]) -> tuple:
    """The impulse the load delivers if the burn ends exactly when the first tank empties [N·s],
    and when that is [s from Fire]: ``(impulse, t)``, or ``(None, None)`` for a burn too short.

    The burn stops on a step: the step in which a tank goes dry counts in full, so ``total_impulse_Ns``
    moves by up to a step's worth (~330 N·s at 6.7 kN and 50 ms) as a design change slides the
    depletion across a step boundary. Any comparison between designs reads that as signal. This
    does not. It is the burn's own impulse per kilogram up to its last full step, times
    everything it could burn: what it burned up to that step, plus what is left at the O/F it was
    running, until the first tank empties.
    """
    if len(fire_idx) < 3:
        return None, None
    body = fire_idx[:-1]
    k = body[-1]
    step = (lambda i: float(steps)) if isinstance(steps, (int, float)) else (lambda i: float(steps[i]))
    impulse = sum(ch["thrust_N"][i] * step(i) for i in body)
    burned = sum((ch["mdot_oxidiser"][i] + ch["mdot_fuel"][i]) * step(i) for i in body)
    mo, mf = ch["mdot_oxidiser"][k], ch["mdot_fuel"][k]
    if burned <= 0.0 or mo <= 0.0 or mf <= 0.0:
        return None, None
    of = mo / mf
    left_o = max(trace.tank[ox_tank]["liquid_mass_kg"][k], 0.0)
    left_f = max(trace.tank[fuel_tank]["liquid_mass_kg"][k], 0.0)
    rest = min(left_f, left_o / of) * (1.0 + of)
    return impulse / burned * (burned + rest), float(trace.t[k]) + rest / (mo + mf)


def _dump_coefficients(prep: Prepared) -> Dict[str, float]:
    """``K_exit / (2 rho A_exit^2)`` per side [Pa/(kg/s)^2]: the dump of the feed line's velocity
    head into the manifold, as EngineDesign prices it (its config density and exit bore). Zero
    for the twin's native engine, whose injector leg starts at the line exit with no manifold."""
    if prep.link is None or prep.link.mode == "native" or prep.link.sampler is None:
        return {}
    import math as _m

    config = prep.link.sampler.config
    feeds = config.feed_system
    out: Dict[str, float] = {}
    for side, key in (("oxidiser", "oxidizer"), ("fuel", "fuel")):
        feed = feeds[key] if isinstance(feeds, dict) else getattr(feeds, key)
        fluid = config.fluids[key]
        rho = float(fluid.density if hasattr(fluid, "density") else fluid["density"])
        d_exit = getattr(feed, "d_exit", None)
        area = _m.pi * (float(d_exit) / 2.0) ** 2 if d_exit else float(feed.A_hydraulic)
        out[side] = float(getattr(feed, "K_exit", 0.0) or 0.0) / (2.0 * rho * area * area)
    return out


def _card_outside(prep: Prepared, series: Dict[str, Any], fire_idx: List[int]) -> Optional[int]:
    """Firing steps at which the burn asked the engine card about a point outside what it was
    fitted to: an injector (flow, inlet pressure) or a chamber (O/F, flow) beyond its sample hull.
    ``None`` when there is no card."""
    card = prep.link.card if prep.link is not None else None
    if card is None:
        return None
    out = 0
    for i in fire_idx:
        mo, mf = series["ox"]["mdot"][i], series["fuel"]["mdot"][i]
        p_o, p_f = series["ox"]["inlet_psia"][i] * PSI, series["fuel"]["inlet_psia"][i] * PSI
        if not (card.oxidiser.covers(mo, p_o) and card.fuel.covers(mf, p_f)
                and card.chamber.covers(mo / mf if mf > 0 else 0.0, mo + mf)):
            out += 1
    return out


#: Instrument types that read temperature; every other instrument reads pressure.
THERMAL_INSTRUMENTS = frozenset({"TC", "RTD"})


def _instrument_series(prep: Prepared, trace: Any) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    built = prep.model.built if prep.model is not None else None
    for inst in getattr(built, "instruments", ()) or ():
        thermal = str(inst.type).upper() in THERMAL_INSTRUMENTS
        column = (trace.temperature if thermal else trace.pressure).get(inst.node)
        if not column:
            continue
        out[inst.id] = {"tag": inst.tag or inst.id, "type": inst.type, "unit": "K" if thermal else "psia",
                        "values": list(column) if thermal else _psia(column)}
    return out


def reduce_trace(prep: Prepared, trace: Any, initial: Dict[str, float]) -> Dict[str, Any]:
    ox_tank, fuel_tank = prep.roles["oxidiser"], prep.roles["fuel"]
    probes = trace.probes
    n = len(trace.t)
    firing = trace.firing
    dt = prep.plan.dt
    # Each step's own length: the plan's, except a last step cut to land on depletion
    # (BurnPlan.end_on_depletion).
    steps = [dt] + [trace.t[i] - trace.t[i - 1] for i in range(1, n)]
    ch = trace.chamber
    inlet = {side: trace.pressure[node] for side, node in probes.injector_inlet.items()}

    dumps = _dump_coefficients(prep)

    def side_series(side: str, tank: str, mdot_key: str) -> Dict[str, List[float]]:
        tank_col = trace.tank[tank]
        # The line exit is the twin's last node; the still manifold is downstream of the dump of
        # the line's velocity head into it (EngineDesign's Borda term, K_exit rho v^2/2). Injector
        # stiffness is manifold to chamber, as EngineDesign and the chug model define it.
        k = dumps.get(side, 0.0)
        dump = [k * ch[mdot_key][i] ** 2 if firing[i] else 0.0 for i in range(n)]
        manifold = [inlet[side][i] - dump[i] for i in range(n)]
        dp = [
            (manifold[i] - ch["pressure_Pa"][i]) if firing[i] else 0.0 for i in range(n)
        ]
        stiffness = [
            (dp[i] / ch["pressure_Pa"][i]) if firing[i] and ch["pressure_Pa"][i] > 0 else 0.0
            for i in range(n)
        ]
        return {
            "tank_psia": _psia(tank_col["pressure_Pa"]),
            "outlet_psia": _psia(tank_col["outlet_pressure_Pa"]),
            "inlet_psia": _psia(inlet[side]),
            "dump_psi": _psia(dump),
            "manifold_psia": _psia(manifold),
            "dp_injector_psi": _psia(dp),
            "stiffness": stiffness,
            "mdot": list(ch[mdot_key]),
            "liquid_kg": list(tank_col["liquid_mass_kg"]),
            "ullage_K": list(tank_col["ullage_temperature_K"]),
            "liquid_K": list(tank_col["liquid_temperature_K"]),
            "fill_fraction": list(tank_col["fill_fraction"]),
        }

    bottle_id = probes.bottles[0] if probes.bottles else ""
    bottle = trace.bottle.get(bottle_id, {})
    series = {
        "t": list(trace.t),
        "dt": steps,
        "firing": list(firing),
        "converged": list(trace.converged),
        "copv_psia": _psia(bottle.get("pressure_Pa", [])),
        "copv_mass_kg": list(bottle.get("mass_kg", [])),
        "copv_wall_K": list(bottle.get("wall_temperature_K", [])),
        "regulators": {
            reg: {"label": probes.regulator_label.get(reg, reg), "outlet_psia": _psia(trace.pressure.get(node, []))}
            for reg, node in probes.regulator_outlet.items()
            if node in trace.pressure
        },
        # What each instrument on the drawing reads, in its own quantity: transducers in psia,
        # thermocouples and RTDs in K. Keyed by the drawing's id; ``tag`` is what the stand calls it.
        "instruments": _instrument_series(prep, trace),
        "ox": side_series("oxidiser", ox_tank, "mdot_oxidiser"),
        "fuel": side_series("fuel", fuel_tank, "mdot_fuel"),
        "chamber": {
            "pc_psia": _psia(ch["pressure_Pa"]),
            "mr": list(ch["mixture_ratio"]),
            "thrust_N": list(ch["thrust_N"]),
            "isp_s": list(ch["isp_s"]),
            "cstar": list(ch["cstar"]),
            "extrapolated": list(ch["extrapolated"]),
        },
    }

    fire_idx = [i for i in range(n) if firing[i]]
    lead_idx = [i for i in range(n) if not firing[i]]
    t0 = lead_idx[-1] if lead_idx else 0
    settled_idx = [i for i in fire_idx if trace.t[i] >= 0.2] or fire_idx
    settled_set = set(settled_idx)

    def pick(values: List[float], idx: List[int], fn: Callable[[List[float]], float]) -> Optional[float]:
        chosen = [values[i] for i in idx if math.isfinite(values[i])]
        return fn(chosen) if chosen else None

    thrust = ch["thrust_N"]
    impulse = sum(thrust[i] * steps[i] for i in fire_idx)
    used_ox = initial[ox_tank] - trace.tank[ox_tank]["liquid_mass_kg"][-1]
    used_fuel = initial[fuel_tank] - trace.tank[fuel_tank]["liquid_mass_kg"][-1]
    used = used_ox + used_fuel
    end = trace.end
    burn_time = end.depleted_s if end and end.depleted_s is not None else (trace.t[fire_idx[-1]] if fire_idx else 0.0)
    ox_s, fuel_s = series["ox"], series["fuel"]

    def tank_block(s: Dict[str, List[float]], tank: str) -> Dict[str, Any]:
        return {
            "t0_psia": s["tank_psia"][t0],
            "min_psia": pick(s["tank_psia"], fire_idx, min),
            "end_psia": s["tank_psia"][-1],
            "ignition_dip_psi": (s["tank_psia"][t0] - (pick(s["tank_psia"], [i for i in fire_idx if trace.t[i] <= 0.5], min) or s["tank_psia"][t0])),
            "inlet_mean_psia": pick(s["inlet_psia"], settled_idx, lambda v: sum(v) / len(v)),
            "dp_injector_min_psi": pick(s["dp_injector_psi"], settled_idx, min),
            "stiffness_min": pick(s["stiffness"], settled_idx, min),
            # The first 0.2 s, which stiffness_min leaves out: ignition, where chug starts if it does.
            "stiffness_min_ignition": pick(s["stiffness"], [i for i in fire_idx if i not in settled_set], min),
            # The highest the vessel sees, hold and burn: what its rating must clear.
            "peak_psia": max(s["tank_psia"]) if s["tank_psia"] else None,
            "stiffness_mean": pick(s["stiffness"], settled_idx, lambda v: sum(v) / len(v)),
            "loaded_kg": initial[tank],
            "residual_kg": trace.tank[tank]["liquid_mass_kg"][-1],
        }

    pc = series["chamber"]["pc_psia"]
    mr = ch["mixture_ratio"]
    depleted = bool(trace.end and trace.end.depleted_s is not None)
    to_depletion, depletion_s = (_impulse_to_depletion(trace, fire_idx, steps, ox_tank, fuel_tank, ch)
                                 if depleted else (None, None))
    summary = {
        "burn_time_s": burn_time,
        "depleted_tank": end.tank if end else "",
        "depleted_side": ("oxidiser" if end and end.tank == ox_tank else "fuel" if end and end.tank == fuel_tank else ""),
        "total_impulse_Ns": impulse,
        "mean_thrust_N": impulse / burn_time if burn_time else None,
        "peak_thrust_N": pick(thrust, fire_idx, max),
        "min_thrust_N": pick(thrust, settled_idx, min),
        "thrust_t0_N": thrust[fire_idx[0]] if fire_idx else None,
        "pc_mean_psia": pick(pc, settled_idx, lambda v: sum(v) / len(v)),
        "pc_min_psia": pick(pc, settled_idx, min),
        "pc_max_psia": pick(pc, settled_idx, max),
        "of_mean": (used_ox / used_fuel) if used_fuel > 0 else None,
        "of_min": pick(mr, settled_idx, min),
        "of_max": pick(mr, settled_idx, max),
        "isp_mean_s": (impulse / (used * G0)) if used > 0 else None,
        "propellant_used_kg": used,
        "impulse_to_depletion_Ns": to_depletion,
        "depletion_s": depletion_s,
        "ox": tank_block(ox_s, ox_tank),
        "fuel": tank_block(fuel_s, fuel_tank),
        "copv_t0_psia": series["copv_psia"][t0] if series["copv_psia"] else None,
        "copv_end_psia": series["copv_psia"][-1] if series["copv_psia"] else None,
        "copv_used_kg": (series["copv_mass_kg"][t0] - series["copv_mass_kg"][-1]) if series["copv_mass_kg"] else None,
        "regulators": {
            reg: {"label": v["label"], "t0_psia": v["outlet_psia"][t0], "min_psia": pick(v["outlet_psia"], fire_idx, min)}
            for reg, v in series["regulators"].items()
        },
        "steps": end.steps if end else n,
        "failed_steps": end.failed_steps if end else sum(1 for c in trace.converged if not c),
        "extrapolated_steps": sum(1 for i in fire_idx if ch["extrapolated"][i] > 0.5),
        "engine_model": prep.link.mode if prep.link else "",
        "card_outside_steps": _card_outside(prep, series, fire_idx),
        "t0_settled": trace.t0_settled,
        "dt": dt,
    }

    # ---- events ---------------------------------------------------------------
    tripped = _trip_of(trace)
    events: List[Dict[str, Any]] = []
    # Stamped where its numbers come from: the last lead-in sample, at Fire.
    events.append({"t": trace.t[t0], "kind": "t0", "key": "t0", "label": "T-0 state",
                   "detail": (f"Tanks at lockup ({ox_s['tank_psia'][t0]:.1f} / {fuel_s['tank_psia'][t0]:.1f} psia), "
                              f"bottle {summary['copv_t0_psia']:.0f} psia") if summary["copv_t0_psia"] else "Primed"})
    if not trace.t0_settled:
        events.append({"t": trace.t[0] - dt, "kind": "warn", "label": "T-0 did not settle",
                       "detail": "The tanks were still moving at T-0; the trace opens off its datum."})
    events.append({"t": 0.0, "kind": "fire", "key": "fire", "label": "Fire", "detail": "Mains commanded open"})
    for side, key, s in (("LOX", "ox", ox_s), ("Fuel", "fuel", fuel_s)):
        if fire_idx:
            i_min = min(fire_idx, key=lambda i: s["tank_psia"][i])
            events.append({"t": trace.t[i_min], "kind": "min", "key": f"min_tank_{key}", "label": f"{side} tank lowest",
                           "detail": f"{s['tank_psia'][i_min]:.1f} psia"})
    if end and end.depleted_s is not None:
        side = "LOX" if end.tank == ox_tank else "Fuel"
        other = fuel_tank if end.tank == ox_tank else ox_tank
        events.append({"t": end.depleted_s, "kind": "end", "key": "dry_ox" if end.tank == ox_tank else "dry_fuel",
                       "label": f"{side} tank dry",
                       "detail": f"{trace.tank[other]['liquid_mass_kg'][-1]:.3f} kg of the other propellant left"})
    elif tripped is not None:
        # Not the horizon: the stand stopped here, and nothing after this instant was burned.
        events.append({"t": float(tripped["t"]), "kind": "fail", "key": "trip",
                       "label": f"Vessel trip ({tripped.get('label') or tripped.get('vessel') or 'vessel'})",
                       "detail": (f"{tripped.get('message') or ''} The burn stopped on this step "
                                  f"({tripped['p_psia']:.1f} psia against the {tripped['mawp_psia']:.1f} psia the "
                                  "stand trips at); its totals end here.").strip()})
    elif end:
        events.append({"t": trace.t[-1], "kind": "warn", "label": "Horizon reached",
                       "detail": "No tank ran dry before the burn horizon."})
    if summary.get("card_outside_steps"):
        events.append({"t": trace.t[-1], "kind": "warn", "label": "Outside the engine card",
                       "detail": f"{summary['card_outside_steps']} firing steps asked the engine card about a "
                                 "flow or pressure outside the EngineDesign solves it was fitted to."})
    if summary["failed_steps"]:
        events.append({"t": trace.t[-1], "kind": "warn", "label": "Unconverged steps",
                       "detail": f"{summary['failed_steps']} of {summary['steps']} steps held their last good flows."})
    events.sort(key=lambda e: e["t"])

    # ---- provenance -----------------------------------------------------------
    report = prep.model.report
    provenance = {
        "drawing": {"id": prep.drawing.id, "name": prep.drawing.name, "source": prep.drawing.source,
                    "sha256": prep.drawing.sha256},
        "config_sha256": prep.config_sha256,
        "settings": asdict(prep.settings),
        "derived": prep.derived,
        "setup": _setup_dict(prep.setup),
        "plan": {k: v for k, v in asdict(prep.plan).items()},
        "calibration": prep.link.calibration if prep.link else None,
        "engine_reference": prep.link.reference if prep.link else None,
        "assembly": {
            "symbols": report.symbols, "lines": report.lines, "nodes": report.nodes,
            "branches": report.branches, "unstated": report.unchecked,
            "assumptions": [asdict(a) for a in report.assumptions],
            "warnings": list(report.warnings),
        },
        "notes": list(trace.notes),
        "probes": {
            "tank_ullage": dict(probes.tank_ullage), "injector_inlet": dict(probes.injector_inlet),
            "chamber": probes.chamber, "regulator_outlet": dict(probes.regulator_outlet),
            "bottles": list(probes.bottles),
        },
        "created": time.time(),
        "phase": 2,
    }
    out = {"series": series, "summary": summary, "events": events, "provenance": provenance,
           "checks": [asdict(c) for c in prep.checks]}
    # Every node and branch, every step (DATA-CONTRACT 2), when the burn recorded them.
    network = _network_of(trace)
    if network is not None:
        out["network"] = network
    if tripped is not None:
        out["tripped"] = tripped
    return out


def _network_of(trace: Any) -> Optional[Dict[str, Any]]:
    """``result["network"]`` (DATA-CONTRACT 2) from a trace recorded with ``Probes(network=True)``;
    ``None`` for a trace without one (a caller's own, or one recorded before the recorder)."""
    if getattr(trace, "network", None) is None:
        return None
    from feedtwin.session.burn import network_dict

    return network_dict(trace)


def _trip_of(trace: Any) -> Optional[Dict[str, Any]]:
    """``result["tripped"]`` (DATA-CONTRACT 4): lib/feedtwin's ``trip_record`` of the vessel trip
    that ended the burn, ``None`` when nothing tripped."""
    if getattr(getattr(trace, "end", None), "tripped", None) is None:
        return None
    from feedtwin.session.burn import trip_record

    return trip_record(trace)


def _line_exit_psia(prep: Prepared, side: str, mdot: float, p_tank: float, dp_feed: Optional[float]) -> float:
    """EngineDesign's pressure at the end of its feed line [psia]: the tank, less every feed loss
    except the exit dump into the manifold. Its ``P_injector`` is downstream of that dump (the
    still manifold), which is not where the twin's line ends, so comparing the two directly
    compares two different places."""
    if dp_feed is None:
        return float("nan")
    from engine.pipeline.feed_loss import delta_p_feed

    config = prep.link.sampler.config if prep.link is not None and prep.link.sampler is not None else None
    if config is None:
        return float("nan")
    feeds = config.feed_system
    feed = feeds[side] if isinstance(feeds, dict) else getattr(feeds, side)
    fluid = config.fluids["oxidizer" if side == "oxidizer" else "fuel"]
    rho = float(fluid.density if hasattr(fluid, "density") else fluid["density"])
    dump = delta_p_feed(mdot, rho, feed, p_tank)
    return (p_tank - (float(dp_feed) - dump)) / PSI


def cross_check(prep: Prepared, result: Dict[str, Any], runner: Any) -> Dict[str, Any]:
    """Layer X against EngineDesign's own forward solve at the same tank pressures.

    Taken at the first step after the ignition transient. The difference has
    two sources, and the table says which is which:
      * the feed lines: EngineDesign's ``feed_system`` (one K per side) against
        the drawing's line-by-line network, visible as the injector-inlet
        pressure;
      * the engine away from its calibration point (none at T-0 when calibrated).
    """
    series = result["series"]
    t = series["t"]
    idx = next((i for i, (tt, f) in enumerate(zip(t, series["firing"])) if f and tt >= 0.25), None)
    if idx is None:
        return {"available": False}
    p_o = series["ox"]["tank_psia"][idx] * PSI
    p_f = series["fuel"]["tank_psia"][idx] * PSI
    try:
        res = runner.evaluate(p_o, p_f, silent=True)
    except Exception as exc:  # noqa: BLE001 - a failed check is reported, not raised
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}
    d = res.get("diagnostics") or {}
    ed = {
        "pc_psia": res["Pc"] / PSI, "mdot_O": res["mdot_O"], "mdot_F": res["mdot_F"], "mr": res["MR"],
        "thrust_N": res["F"], "isp_s": res["Isp"],
        "inlet_O_psia": _line_exit_psia(prep, "oxidizer", res["mdot_O"], p_o, d.get("delta_p_feed_O")),
        "inlet_F_psia": _line_exit_psia(prep, "fuel", res["mdot_F"], p_f, d.get("delta_p_feed_F")),
    }
    lx = {
        "pc_psia": series["chamber"]["pc_psia"][idx], "mdot_O": series["ox"]["mdot"][idx],
        "mdot_F": series["fuel"]["mdot"][idx], "mr": series["chamber"]["mr"][idx],
        "thrust_N": series["chamber"]["thrust_N"][idx], "isp_s": series["chamber"]["isp_s"][idx],
        "inlet_O_psia": series["ox"]["inlet_psia"][idx], "inlet_F_psia": series["fuel"]["inlet_psia"][idx],
    }
    rows = []
    labels = {
        "inlet_O_psia": ("LOX line exit", "psia"), "inlet_F_psia": ("Fuel line exit", "psia"),
        "pc_psia": ("Chamber pressure", "psia"), "mdot_O": ("LOX flow", "kg/s"), "mdot_F": ("Fuel flow", "kg/s"),
        "mr": ("O/F", ""), "thrust_N": ("Thrust", "N"), "isp_s": ("Isp", "s"),
    }
    for key, (label, unit) in labels.items():
        a, b = lx[key], ed[key]
        rows.append({"key": key, "label": label, "unit": unit, "layerx": a, "enginedesign": b,
                     "rel": ((a - b) / b) if b and math.isfinite(b) else None})
    return {
        "available": True,
        "t": t[idx],
        "tank_psia_O": p_o / PSI,
        "tank_psia_F": p_f / PSI,
        "rows": rows,
        "basis": ("EngineDesign's forward solve at Layer X's tank pressures at this instant, through its "
                  "own feed_system K; Layer X through the drawing's lines. Line exit is the pressure where "
                  "the feed line meets the injector, before the dump into the manifold, in both columns. "
                  "The engine itself is the same in both (see the engine check), so a difference here "
                  "is the feed lines."),
    }


def engine_check(prep: Prepared, result: Dict[str, Any], points: int = 12) -> Dict[str, Any]:
    """The engine the twin burned, against EngineDesign at the same injector-inlet pressures.

    At ``points`` instants across the firing window, EngineDesign is solved at the line exit
    (its feed losses zeroed, its exit dump kept) at exactly the inlet pressures the twin's
    network delivered. Same boundary, same pressures, so any difference is the engine model and
    nothing else: the card's tabulation error, the T-0 fit's drift away from T-0, or the native
    engine's whole gap. The feed system is the twin's in both columns, and this does not test it.
    """
    series = result["series"]
    t = series["t"]
    rp = result.get("replay") or {}
    if rp.get("available"):
        return _engine_check_from_replay(prep, series, rp)
    firing = [i for i, f in enumerate(series["firing"]) if f and t[i] >= 0.1]
    if not firing:
        return {"available": False}
    step = max(len(firing) // max(points - 1, 1), 1)
    picks = firing[::step]
    if picks[-1] != firing[-2 if len(firing) > 1 else -1]:
        picks.append(firing[-2] if len(firing) > 1 else firing[-1])
    sampler = prep.link.sampler
    rows = []
    worst: Dict[str, float] = {"pc": 0.0, "thrust": 0.0, "mdot_O": 0.0, "mdot_F": 0.0}
    for i in picks:
        p_O = series["ox"]["inlet_psia"][i] * PSI
        p_F = series["fuel"]["inlet_psia"][i] * PSI
        ed = sampler(p_O, p_F)
        if ed is None:
            rows.append({"t": t[i], "available": False})
            continue
        lx = {"pc": series["chamber"]["pc_psia"][i] * PSI, "thrust": series["chamber"]["thrust_N"][i],
              "mdot_O": series["ox"]["mdot"][i], "mdot_F": series["fuel"]["mdot"][i]}
        want = {"pc": ed["Pc"], "thrust": ed["F"], "mdot_O": ed["mdot_O"], "mdot_F": ed["mdot_F"]}
        rel = {k: (lx[k] / want[k] - 1.0) if want[k] else None for k in lx}
        for k, v in rel.items():
            if v is not None:
                worst[k] = max(worst[k], abs(v))
        rows.append({"t": t[i], "available": True, "inlet_O_psia": p_O / PSI, "inlet_F_psia": p_F / PSI,
                     "layerx": {**lx, "pc": lx["pc"] / PSI},
                     "enginedesign": {**want, "pc": want["pc"] / PSI}, "rel": rel})
    return {
        "available": True,
        "mode": prep.link.mode,
        "rows": rows,
        "worst": worst,
        "basis": ("EngineDesign at the line exit (feed losses zeroed, exit dump kept), solved at the "
                  "injector-inlet pressures the twin's network delivered at each instant."),
    }


def _engine_check_from_replay(prep: Prepared, series: Dict[str, Any], rp: Dict[str, Any]) -> Dict[str, Any]:
    """As :func:`engine_check`, against EngineDesign's replay of this very burn: same instants,
    same line-exit pressures, the chamber eroded as far as EngineDesign says it had by then. With
    the replay's throat history applied to the twin, this is what the agreement loop closed."""
    rows = []
    worst: Dict[str, float] = {"pc": 0.0, "thrust": 0.0, "mdot_O": 0.0, "mdot_F": 0.0}
    for k, i in enumerate(rp["index"]):
        if series["t"][i] < 0.1:
            continue
        want = {"pc": rp["pc_psia"][k], "thrust": rp["thrust_N"][k], "mdot_O": rp["mdot_O"][k],
                "mdot_F": rp["mdot_F"][k]}
        if any(v is None for v in want.values()):
            rows.append({"t": series["t"][i], "available": False})
            continue
        lx = {"pc": series["chamber"]["pc_psia"][i], "thrust": series["chamber"]["thrust_N"][i],
              "mdot_O": series["ox"]["mdot"][i], "mdot_F": series["fuel"]["mdot"][i]}
        rel = {key: (lx[key] / want[key] - 1.0) if want[key] else None for key in lx}
        for key, v in rel.items():
            if v is not None:
                worst[key] = max(worst[key], abs(v))
        rows.append({"t": series["t"][i], "available": True, "inlet_O_psia": rp["inlet_O_psia"][k],
                     "inlet_F_psia": rp["inlet_F_psia"][k], "layerx": lx, "enginedesign": want, "rel": rel})
    return {
        "available": True,
        "mode": prep.link.mode,
        "against": "replay",
        "rows": rows,
        "worst": worst,
        "basis": ("EngineDesign's coupled time-varying solve (ablative and graphite recession on) at the "
                  "line-exit pressures the twin delivered, at each instant. Thrust on the Layer X side "
                  "is the card's at its as-built nozzle; the delivered thrust is EngineDesign's."),
    }
