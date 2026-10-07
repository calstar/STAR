"""Everything a Layer X burn needs, assembled and checked before anything runs.

A burn takes seconds to a minute, and the ways it can be wrong before it starts
are cheap to find and expensive to discover afterwards. Examples: a drawing
whose tanks hold the wrong propellant, a load that does not fit, a main valve
the DAQ table cannot find, a target tank pressure above the drawing's MAWP. So
preparation does all of the setup work and grades it. The preflight endpoint
returns exactly what a run would start from.

What is decided here
--------------------
* **Which tank is which.** Matched by species against the engine config's
  propellants, never by a tag.
* **The propellant load.** The config's tank masses by default, because the
  load is fixed by rule rather than by a fill level. A drawing fill fraction
  is used only on request.
* **The dome setting.** It is solved from the drawing's own regulators, so the
  tanks lock up at the requested pressure. The tank pressure is the target;
  the dome is the knob that produces it.
* **The engine.** The live config, imported into the twin and calibrated to
  EngineDesign at T-0 (:mod:`engine.layerx.link`).
* **The chamber's ambient pressure.** The site's, from the config's elevation.
  It is not the gauge zero.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from engine.layerx.link import EngineLink, link_engine, twin_injector_check
from engine.layerx.sources import Drawing, cea_table_path, machines_dir

PSI = 6894.757293168361

#: The test modes a run can declare. Only a hot fire is modelled; the field is reserved for the
#: cold flows (water, LN2) the stand also runs (DATA-CONTRACT 4, ``result.test_mode``).
TEST_MODES = ("hotfire",)
#: The values the opt-in choices take. ``None`` in a setting is always the first: today's behaviour.
CHUG_BASES = ("config", "drawing")
FLIGHT_COUPLINGS = ("outer", "inline")

#: Layer X's chamber closure tolerance [psi]. The twin's default (0.5 psi, 0.13 % of a 380 psia
#: chamber) is larger than the engine card's whole error; 0.02 psi is 0.005 %.
CHAMBER_TOLERANCE_PSI = 0.02

#: Layer X's network solve tolerance (scaled residual). The console's 1e-4 is ~3 kPa on every
#: branch against a full COPV and left the card's injector drop 0.47 % off its own relation. It
#: used to be a floor: below it the solve failed (41 of 51 steps held at 3e-5), because a carded
#: injector leg signed its reverse-flow drop twice and a regulator at lockup stepped by its supply
#: effect at zero flow. With both fixed and ``regulator_lockup_supply`` on, 1e-6 converges at every
#: step and the injector drop sits 0.007 % off. Measured on the 6.8 kN burn: +6.7 N·s (0.03 %) of
#: impulse, +5 s of wall time.
NETWORK_TOLERANCE = 1e-6


@dataclass(frozen=True)
class LayerXSettings:
    """What a person chooses for a Layer X burn. Everything else is derived."""

    drawing_id: str
    tank_pressure_psia: Optional[float] = None
    """Tank lockup at T-0 [psia]; the dome is solved for it. Ignored when ``dome_psia`` is set.
    ``None`` (and no ``dome_psia``): the dial the drawing states on the dome regulator, else the
    config's ``lox_tank.initial_pressure_psi``."""
    copv_pressure_psig: Optional[float] = None
    """Bottle at T-0 [psig], as the optimiser and settings saved before 2026-10-07 write it. The
    rail writes ``copv_pressure_psia``, which wins. ``None`` (both): the drawing's bottle pressure."""
    copv_pressure_psia: Optional[float] = None
    """Bottle at T-0 [psia] (2026-10-07: every pressure on the rail absolute)."""
    dome_psia: Optional[float] = None
    """The dome dial [psia] on the regulator ``dome_regulator`` names; the tank lockup follows from
    it. ``None``: ``tank_pressure_psia`` if set (the dome solved for it), else the drawing's dial."""
    dome_regulator: Optional[str] = None
    """Drawing id of the regulator the dome dial sets: a dome loader, a dome-loaded regulator with no
    loader drawn, or a plain regulator. ``None``: the feed twin's own choice
    (``feedtwin.session.hookup.suggest``), the one its cockpit's dome knob drives."""
    load: str = "config"
    """``config``: the config's propellant masses. ``fill``: ``fill_fraction`` of each tank."""
    fill_fraction: float = 0.95
    dry_kg: float = 0.001
    """Liquid left in a tank when the burn is over [kg]: the propellant the vehicle cannot use
    (sump, outlet line, vortex pull-through). Nobody has measured it, so the default burns the
    tanks dry; 1 g is the solver's resolution, not an estimate. With it the simulated impulse
    agrees with the twin's own extrapolation to empty within 3 N·s on the 6.8 kN burn, so there is
    one impulse, not two. Enter a measured trapped mass here to charge for it."""
    engine_model: str = "card"
    """``card``: EngineDesign's injector and chamber across the burn (an engine card).
    ``calibrated``: the twin's engine fitted to EngineDesign at T-0. ``native``: the twin's own."""
    # The feed twin's thermal models (2026-10-03: "it's called feed twin cause it's supposed to be an
    # exact twin of the feed system, so you genuinely need to just pull from it and trust it"). None
    # takes the feed twin's own Setup, exactly as its cockpit runs; a value overrides it for this burn
    # (the uncertainty sweep does that).
    ullage_collapse: Optional[bool] = None
    ullage_vapour: Optional[bool] = None
    chilldown: Optional[float] = None
    line_walls: Optional[bool] = None
    hold_s: float = 300.0
    dt: float = 0.05
    horizon_s: float = 14.0
    settle: bool = True
    replay: bool = True
    """Close the burn against EngineDesign's time-varying replay with the chamber eroding
    (phase 3, engine/layerx/replay.py). Off: the twin's pass alone, as-built throat."""
    card_center_psia: Optional[float] = None
    """Centre the engine card here rather than at the lockup [psia]. The optimiser sets it once for
    all its candidates; a run on its own leaves it unset."""
    flight: bool = False
    """Fly the delivered burn and feed the vehicle's acceleration back into it (phase 6,
    engine/layerx/flight.py): every liquid column at thrust-less-drag over mass, and the
    drawing's own line heights. Without ``replay`` the twin's own engine-card thrust is flown."""
    liftoff_mass_kg: Optional[float] = None
    """The vehicle as weighed on the rail, loaded and pressed [kg]. ``None``: the config's airframe
    plus the motor, propellants and gases. Given, the airframe is what is left of it, so the flight
    (and the acceleration it feeds back into the burn) is at this mass."""
    pressurant: Optional[str] = None
    """``nitrogen`` or ``helium``: the gas in the bottle and everything it presses, swapped on the
    drawing for this burn (every component holding the drawing's pressurant). ``None``: as drawn."""

    # ---- opt-in choices (2026-10-03). Every one defaults to ``None``, which is exactly the
    # behaviour before it existed; :func:`options` resolves them. They are ``None`` rather than
    # their resolved value so the settings a saved run records, and the baseline's list of
    # defaults (tests/test_layerx_golden.py), are unchanged by their arrival.
    chug_basis: Optional[str] = None
    """Which feed impedance the *graded* chug margin uses: ``config`` (EngineDesign's
    ``feed_system``, graded on the whole burn's minimum, start included, as before) or ``drawing``
    (the drawing's line inertance and the twin's line drop as resistance, graded from the first
    full-flow step; AUDIT D7 C+E). Both are always computed and shown. ``None``: ``config``."""
    chug_eroded: Optional[bool] = None
    """Give the chug model each replay point's eroded throat, chamber volume and L* instead of the
    design point's (AUDIT D7-D). Changes the reported chug margins only. ``None``: off."""
    card_eroded_nozzle: Optional[bool] = None
    """Scale the engine card's vacuum velocity with Cf_vac(eps(t))/Cf_vac(eps0) as the replay's
    throat opens (AUDIT D4-B, ``engine/layerx/card.py``). Changes the twin's thrust (not Pc or
    flow) once a throat schedule is applied. ``None``: off, the card's as-built nozzle."""
    flight_coupling: Optional[str] = None
    """Retired (2026-10-03): the ascent is always stepped inside the burn. Accepted from saved
    settings and ignored."""
    fuel_lead_s: Optional[float] = None
    """The start diagnostic only: fuel main commanded this long before the LOX main [s]. The
    burn itself opens both mains in ``Fire`` (the DAQ table). ``None``: 0, the table's."""
    valve_travel_s: Optional[float] = None
    """The start diagnostic only: the main valves' opening travel [s]. ``None``: the drawing's
    ``travel_time`` on each main."""
    outlet_d_mm: Optional[Any] = None
    """The gas-ingestion diagnostic only: the tank outlet bore [mm], one number for both tanks or
    ``[LOX, fuel]``. ``None``: the first drawn line's bore (an assumption, said so)."""
    ack_gn2_condensation: Optional[bool] = None
    """Run a hot fire with nitrogen over LOX anyway. Without it preflight refuses one whose
    nitrogen partial pressure is over nitrogen's saturation pressure at the LOX temperature: the
    gas condenses into the propellant and on the cold wall, which the twin does not model.
    ``None``: refuse."""
    test_mode: Optional[str] = None
    """What the stand is doing: only ``hotfire`` is modelled (the field is reserved for cold
    flows). ``None``: ``hotfire``."""

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "LayerXSettings":
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in raw.items() if k in known and (v is not None or k == "drawing_id")})


def _outlet_pair(value: Any) -> Tuple[Optional[float], Optional[float]]:
    """``outlet_d_mm`` as ``(LOX, fuel)``: one number is both tanks'."""
    if value is None:
        return (None, None)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return (float(value), float(value))
    pair = list(value)
    if len(pair) != 2:
        raise ValueError("outlet_d_mm is one bore for both tanks or [LOX, fuel]")
    return tuple(None if v is None else float(v) for v in pair)  # type: ignore[return-value]


def feed_twin_setup(**changes: Any) -> Any:
    """The feed twin's Setup, as its cockpit runs the stand, with only what a recorded burn needs
    changed on top: no automatic vent at burnout (the trace is read past depletion), a burn's Newton
    room and no wall-clock budget (``burn_setup``'s numerics), and the ``changes`` given.

    Unlike :func:`feedtwin.session.burn.burn_setup`, the thermal closures are the twin's own (the
    cockpit's: collapse, vapour, chilldown, stratification, boiling onset, nucleate boiling, wall
    boiling), not switched off: Layer X trusts the twin (2026-10-03, AUDIT D1). ``burn_setup`` keeps
    them off for the benchmark Study, whose expectations were set before they existed.
    """
    from dataclasses import fields

    from feedtwin.session.core import Setup

    base: Dict[str, Any] = {"auto_vent": False, "max_iterations": 120, "tick_budget": 1.0e9}
    base.update(changes)
    known = {f.name for f in fields(Setup)}
    return Setup(**{k: v for k, v in base.items() if k in known})


def options(settings: LayerXSettings) -> Dict[str, Any]:
    """The opt-in choices with ``None`` resolved to today's behaviour: what a run actually did.
    Recorded as ``provenance.derived.options`` so a saved run says it, whatever the defaults
    become."""
    return {
        # D7, decided 2026-10-03 ("if it removes a time step artifact then yes do it"): the chug loop
        # on the drawing's own lines, the eroded engine, graded from the first full-flow step.
        # Physics, not options (the team, 2026-10-03: "there should never be options for wrong
        # physics, just physics"): the chug on the drawing's own lines and the eroded engine, and the
        # card's nozzle following the eroding throat, always. The fields stay readable on old runs.
        "chug_basis": "drawing",
        "chug_eroded": True,
        "card_eroded_nozzle": True,
        # The ascent stepped inside the burn (2026-10-03): on LE4 He it matches the outer RocketPy
        # loop to 0.006 % impulse and 0.01 m apogee in 2 passes and 100 s against 5 passes and 247 s.
        "flight_coupling": "inline",
        "fuel_lead_s": float(settings.fuel_lead_s or 0.0),
        # The main valves' travel and the tank outlets are on the drawing: never restated here.
        "valve_travel_s": None,
        "outlet_d_mm": [None, None],
        "ack_gn2_condensation": bool(settings.ack_gn2_condensation),
        "test_mode": settings.test_mode or "hotfire",
    }


def _option_problems(settings: LayerXSettings) -> List[str]:
    """Values an opt-in choice cannot take (the router validates them too; a script may not)."""
    bad: List[str] = []
    if settings.chug_basis not in (None,) + CHUG_BASES:
        bad.append(f"chug_basis {settings.chug_basis!r} is not one of {', '.join(CHUG_BASES)}")
    if settings.flight_coupling not in (None,) + FLIGHT_COUPLINGS:
        bad.append(f"flight_coupling {settings.flight_coupling!r} is not one of {', '.join(FLIGHT_COUPLINGS)}")
    if settings.test_mode not in (None,) + TEST_MODES:
        bad.append(f"test_mode {settings.test_mode!r}: only {', '.join(TEST_MODES)} is modelled (the field is "
                   "reserved for the cold flows)")
    for name in ("fuel_lead_s", "valve_travel_s"):
        v = getattr(settings, name)
        if v is not None and not (isinstance(v, (int, float)) and 0.0 <= float(v) < 10.0):
            bad.append(f"{name} {v!r} must be a time in seconds, 0-10")
    try:
        for v in _outlet_pair(settings.outlet_d_mm):
            if v is not None and not 0.5 <= v <= 500.0:
                bad.append(f"outlet_d_mm {v!r} must be a bore in mm, 0.5-500")
    except (TypeError, ValueError) as exc:
        bad.append(str(exc))
    for name in ("dome_psia", "copv_pressure_psia", "tank_pressure_psia"):
        v = getattr(settings, name)
        if v is not None and not (isinstance(v, (int, float)) and 0.0 < float(v) < 20000.0):
            bad.append(f"{name} {v!r} must be an absolute pressure in psia")
    return bad


def gn2_on_lox(pressurant: Optional[str], ox_tank: Any, lockup_pa: float, *, test_mode: str = "hotfire",
               acknowledged: bool = False) -> Optional[Dict[str, str]]:
    """Preflight's nitrogen-over-LOX check: ``{status, detail}``, or ``None`` when it does not apply.

    The physical criterion (AUDIT D3-B/C, decided 2026-10-03): nitrogen condenses on liquid oxygen
    when its partial pressure in the ullage is above its own saturation pressure at the LOX
    temperature, ~52 psia at 90 K. The ullage's nitrogen is the lockup less LOX's vapour pressure
    (Dalton, the ullage saturated with oxygen at the surface). Both saturation pressures are
    CoolProp's (Bell, Wronski, Quoilin & Lemort, Ind. Eng. Chem. Res. 53(6), 2014). The LOX
    temperature is the drawing's oxidiser tank ``temperature``; without one, LOX's normal boiling
    point. At or above nitrogen's critical temperature nothing condenses.

    A hot fire over the line is a ``fail``: the twin models neither the condensation into the
    propellant nor on the cold wall, so its pressurant use and tank pressure would be wrong on the
    unsafe side. ``acknowledged`` (``ack_gn2_condensation``) makes it a ``warn`` and lets it run.
    This replaces a warning above nitrogen's critical pressure (492.5 psia), which said nothing
    for a 300-490 psia nitrogen lockup that condenses just the same."""
    if (pressurant or "").lower() != "nitrogen" or ox_tank is None or (ox_tank.fluid or "").lower() != "oxygen":
        return None
    if test_mode != "hotfire":
        return None
    import CoolProp.CoolProp as CP

    param = ox_tank.params.get("temperature") if getattr(ox_tank, "params", None) else None
    if param is not None:
        T = float(param.si)
        source = str(getattr(param.source, "value", param.source) or "unstated")
        t_src = f"the drawing's {ox_tank.id} temperature, {source}"
    else:
        T = float(CP.PropsSI("T", "P", 101325.0, "Q", 0, "Oxygen"))
        t_src = "LOX's normal boiling point (CoolProp): the drawing states no tank temperature"
    t_crit = float(CP.PropsSI("Tcrit", "Nitrogen"))
    if T >= t_crit:
        return {"status": "info", "detail": f"LOX at {T:.1f} K ({t_src}) is above nitrogen's critical temperature "
                                            f"({t_crit:.1f} K): nitrogen cannot condense on it."}
    psat_n2 = float(CP.PropsSI("P", "T", T, "Q", 0, "Nitrogen"))
    try:
        pv_o2 = float(CP.PropsSI("P", "T", T, "Q", 0, "Oxygen"))
    except Exception:  # noqa: BLE001 - outside oxygen's two-phase range: count the ullage as all nitrogen
        pv_o2 = 0.0
    p_n2 = lockup_pa - pv_o2
    state = (f"LOX at {T:.1f} K ({t_src}); nitrogen condenses there above {psat_n2 / PSI:.1f} psia, its saturation "
             f"pressure (CoolProp). At {lockup_pa / PSI:.0f} psia lockup the ullage's nitrogen is at "
             f"{p_n2 / PSI:.0f} psia (lockup less LOX's {pv_o2 / PSI:.1f} psia vapour pressure)")
    if p_n2 <= psat_n2:
        return {"status": "info", "detail": state + ": below it, so nothing condenses on the liquid."}
    if acknowledged:
        return {"status": "warn", "detail": state + ", so it condenses into the propellant and on the cold tank "
                "wall. Run anyway as asked (ack_gn2_condensation): the condensation is not modelled, so the "
                "pressurant use and the LOX tank's pressure read optimistic."}
    return {"status": "fail", "detail": state + ", so it condenses into the propellant and on the cold tank wall, "
            "which the twin does not model: the pressurant use and the LOX tank's pressure it would report for "
            "this hot fire are wrong on the unsafe side. Fire on helium (the helium drawing, or pressurant: "
            "helium); nitrogen is for the water flows. To burn it anyway, set ack_gn2_condensation (run anyway, "
            "condensation unmodelled)."}


def _stated_requirement(config: Any, key: str) -> Optional[float]:
    """``design_requirements.<key>`` when the design states it; ``None`` when it is absent or only
    the schema's default (pydantic's ``model_fields_set``), which has no source to check against."""
    req = getattr(config, "design_requirements", None)
    if req is None:
        return None
    stated = getattr(req, "model_fields_set", None)
    if stated is not None and key not in stated:
        return None
    value = getattr(req, key, None)
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def expected_tank_rise(model: Any, *, dome_psig: float, gas: str, bottle_pa: float, bottle_K: float,
                       bottle_m3: float, lockup_pa: float, ullage_m3: float, expelled_m3: float,
                       iterations: int = 12) -> Dict[str, Any]:
    """The tank pressure at burnout the drawing's regulator law predicts before anything burns.

    The regulator's outlet climbs as its supply falls (the supply-pressure effect), so the tanks end
    the burn above their lockup. This estimates by how much:

    * the gas the tanks need: CoolProp density at the end pressure times the ullage the burn ends
      with (the T-0 ullage plus the liquid expelled), less what the T-0 ullage already holds at
      lockup, both at the bottle's temperature;
    * the bottle after giving it: its T-0 gas less that, expanded on the T-0 isentrope (a rigid
      vessel with no heat: the largest drop, so the largest rise);
    * the tank pressure: the drawing's own regulator law (:func:`lockup_for_dome`) at that supply,
      at zero flow (droop would lower it).

    Iterated, since the end pressure prices the gas. Returns ``{end_pa, rise_pa, bottle_end_pa,
    gas_kg, converged}``; ``bottle_end_pa`` is ``None`` when the bottle cannot supply it."""
    import CoolProp.CoolProp as CP

    rho0 = float(CP.PropsSI("D", "P", bottle_pa, "T", bottle_K, gas))
    s0 = float(CP.PropsSI("S", "P", bottle_pa, "T", bottle_K, gas))
    m0 = rho0 * bottle_m3
    rho_lock = float(CP.PropsSI("D", "P", lockup_pa, "T", bottle_K, gas))
    end_pa, bottle_end, need = lockup_pa, None, 0.0
    converged = False
    for _ in range(iterations):
        rho_end = float(CP.PropsSI("D", "P", end_pa, "T", bottle_K, gas))
        need = rho_end * (ullage_m3 + expelled_m3) - rho_lock * ullage_m3
        left = m0 - need
        if left <= 0.0:
            return {"end_pa": None, "rise_pa": None, "bottle_end_pa": None, "gas_kg": need, "converged": False}
        bottle_end = float(CP.PropsSI("P", "D", left / bottle_m3, "S", s0, gas))
        new = lockup_for_dome(model, dome_psig, bottle_end)
        if new is None:
            return {"end_pa": None, "rise_pa": None, "bottle_end_pa": bottle_end, "gas_kg": need, "converged": False}
        converged = abs(new - end_pa) < 0.01 * PSI
        end_pa = new
        if converged:
            break
    return {"end_pa": end_pa, "rise_pa": end_pa - lockup_pa, "bottle_end_pa": bottle_end, "gas_kg": need,
            "converged": converged}


#: CoolProp's names for the pressurants a drawing's bottle holds.
_COOLPROP_GAS = {"nitrogen": "Nitrogen", "helium": "Helium"}


def _burnout_tank_check(model: Any, dome: float, bottle: Any, copv_psig: float, lockup_pa: float,
                        roles: Dict[str, str], tanks: List[Any], volumes: Dict[str, Optional[float]],
                        loads: Optional[Dict[str, float]], rho: Dict[str, float], settings: LayerXSettings,
                        ambient: float, config: Any) -> Optional[Dict[str, Any]]:
    """Preflight's ``tank_rise`` check: :func:`expected_tank_rise` against each tank's MAWP (across
    the wall, at the site's atmosphere) and the design's stated tank cap (read as psia, as
    ``diag.limits`` reads it until AUDIT D11 is decided). ``warn`` over either, ``info`` otherwise."""
    from feedtwin.session.gauge import from_psig

    gas = _COOLPROP_GAS.get((bottle.fluid or "").lower())
    t_param, v_param = bottle.params.get("temperature"), bottle.params.get("volume")
    if gas is None or t_param is None or v_param is None or len(roles) != 2:
        return {"status": "info", "detail": "No estimate of the tanks' rise over the burn: the drawing's bottle states "
                                            "no gas CoolProp knows, temperature or volume."}
    expelled = ullage = 0.0
    for side, tank_id in roles.items():
        vol = volumes.get(tank_id)
        if vol is None:
            return {"status": "info", "detail": f"No estimate of the tanks' rise over the burn: {tank_id} has no volume "
                                                "on the drawing."}
        liquid = loads[tank_id] / rho[side] if loads else settings.fill_fraction * vol
        expelled += liquid
        ullage += max(vol - liquid, 0.0)
    est = expected_tank_rise(model, dome_psig=dome, gas=gas, bottle_pa=from_psig(copv_psig), bottle_K=float(t_param.si),
                             bottle_m3=float(v_param.si), lockup_pa=lockup_pa, ullage_m3=ullage, expelled_m3=expelled)
    if est["end_pa"] is None:
        if est["bottle_end_pa"] is None:
            return {"status": "warn", "detail": f"The bottle ({from_psig(copv_psig) / PSI:.0f} psia, {v_param.si * 1e3:.2f} L of {gas}) holds "
                                                f"less than the ~{est['gas_kg']:.3f} kg the tanks need to stay at lockup "
                                                "through the burn: it will fall below lockup."}
        return {"status": "info", "detail": "No estimate of the tanks' rise: the drawing has no dome-loaded regulator."}
    end, rise = float(est["end_pa"]), float(est["rise_pa"])
    over = []
    for t in tanks:
        if t.id not in roles.values():
            continue
        mawp = t.params.get("MAWP")
        if mawp is not None and end - ambient > mawp.si:
            over.append(f"{t.label or t.id}'s MAWP ({mawp.si / PSI:.0f} psi; {(end - ambient) / PSI:.0f} psi across the wall)")
    for key, name in (("max_lox_tank_pressure_psi", "LOX"), ("max_fuel_tank_pressure_psi", "fuel")):
        cap = _stated_requirement(config, key)
        if cap is not None and end / PSI > cap:
            over.append(f"the design's {name} tank cap ({cap:g} psi, design_requirements.{key}, read as psia until "
                        "AUDIT D11 is decided)")
    detail = (f"Locked up at {lockup_pa / PSI:.1f} psia from a {from_psig(copv_psig) / PSI:.0f} psia bottle, the bottle should end near "
              f"{est['bottle_end_pa'] / PSI:.0f} psia after giving the tanks ~{est['gas_kg']:.3f} kg of {gas}; the "
              f"regulator's supply-pressure effect then lifts the tanks to ~{end / PSI:.0f} psia (+{rise / PSI:.0f} psi). "
              "Estimated from the drawing's regulator law at zero flow, the bottle on its isentrope and the gas at the "
              "bottle's temperature: an upper estimate; the burn grades the real peak.")
    if over:
        detail += " That is over " + "; ".join(over) + "."
    estimate = {"end_psia": end / PSI, "rise_psi": rise / PSI, "bottle_end_psia": est["bottle_end_pa"] / PSI,
                "gas_kg": est["gas_kg"], "converged": est["converged"],
                "basis": "drawing regulator law at zero flow; bottle isentropic from its drawn temperature; tank gas at "
                         "the bottle's temperature (prepare.expected_tank_rise)"}
    return {"status": "warn" if over else "info", "detail": detail, "estimate": estimate}


def _vehicle_dry_kg(config: Any) -> Optional[float]:
    from engine.layerx.flight import config_dry_kg

    try:
        return config_dry_kg(config)
    except Exception:  # noqa: BLE001 - a readout, never a reason to refuse the burn
        return None


@dataclass
class Check:
    key: str
    label: str
    status: str
    """``ok``, ``info``, ``warn`` or ``fail``. A ``fail`` blocks the run."""
    detail: str = ""


@dataclass
class Prepared:
    """A burn ready to run: the model, the plan, the engine link, and the checks."""

    settings: LayerXSettings
    drawing: Drawing
    checks: List[Check] = field(default_factory=list)
    derived: Dict[str, Any] = field(default_factory=dict)
    model: Any = None
    machine: Any = None
    setup: Any = None
    plan: Any = None
    link: Optional[EngineLink] = None
    roles: Dict[str, str] = field(default_factory=dict)
    """``oxidiser``/``fuel`` -> tank id."""
    inlet_nodes: Dict[str, str] = field(default_factory=dict)
    overrides: List[Dict[str, Any]] = field(default_factory=list)
    """Drawing parameters restated for this burn (engine/layerx/measurements.py)."""
    assembler: Optional[Callable[[], Any]] = None
    """A fresh model, identical to ``model``, for each burn: a session consumes the model it
    runs (feedtwin.session.burn.open_session)."""
    config_sha256: str = ""
    ambient_pa: float = 101325.0
    measurements: List[Any] = field(default_factory=list)
    """The Override objects this burn was prepared with (the router's store), as given."""
    vehicle_lines: List[Dict[str, Any]] = field(default_factory=list)
    """Phase 6: each side's tank-to-injector drop and the line it was put on."""

    @property
    def ok(self) -> bool:
        return self.model is not None and not any(c.status == "fail" for c in self.checks)

    def preflight(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "checks": [asdict(c) for c in self.checks],
            "derived": self.derived,
            "calibration": self.link.calibration if self.link else None,
            "reference": self.link.reference if self.link else None,
        }


PRESSURANTS = ("nitrogen", "helium")


def swap_pressurant(payload: Dict[str, Any], gas: str) -> Tuple[Dict[str, Any], int, str]:
    """``payload`` with the bottle's gas replaced by ``gas`` wherever the drawing holds it (the
    bottle, regulators, press lines' valves and vents): a copy, the count, and the gas it was."""
    import copy

    if gas not in PRESSURANTS:
        raise ValueError(f"pressurant must be one of {PRESSURANTS}")
    nodes = payload.get("nodes") or []
    # The bottle as feedtwin reads it, not only as drawn: a COPV drawn with the tank symbol (a gas
    # above its critical temperature) is the pressurant bottle too. Looking for KBOTTLE alone found
    # nothing on such a drawing and swapped nothing, silently.
    # Only the vehicle's gas is swapped (engine.layerx.vehicle): GSE K-bottles on the drawing's
    # other page keep theirs; they fill the bottle on the pad and are not the burn's pressurant.
    vehicle = None
    try:
        from feedtwin.pid import read_diagram

        from engine.layerx.vehicle import vehicle_ids

        read = read_diagram(payload, name="swap")
        read_as_bottle = {n.id for n in read.nodes if n.type == "KBOTTLE"}
        vehicle = vehicle_ids(read)
    except Exception:  # noqa: BLE001 - a drawing feedtwin cannot read is the preflight's to report
        read_as_bottle = set()
    bottle = next((n for n in nodes if isinstance(n, dict)
                   and (vehicle is None or str(n.get("id", "")) in vehicle)
                   and (str((n.get("data") or {}).get("componentType") or n.get("type")).upper() == "KBOTTLE"
                        or str(n.get("id", "")) in read_as_bottle)), None)
    was = str(((bottle or {}).get("data") or {}).get("fluid") or "").lower()
    if not was or was == gas:
        return payload, 0, was or gas
    out = copy.deepcopy(payload)
    n = 0
    for node in out.get("nodes") or []:
        data = node.get("data") if isinstance(node, dict) else None
        if vehicle is not None and str(node.get("id", "")) not in vehicle:
            continue
        if isinstance(data, dict) and str(data.get("fluid") or "").lower() == was:
            data["fluid"] = gas
            n += 1
    return out, n, was


from engine.layerx.vehicle import on_vehicle, vehicle_ids, vehicle_payload  # noqa: E402
from engine.layerx.fingerprint import config_fingerprint  # noqa: E402,F401 - one definition


def _inlet_nodes(built: Any) -> Dict[str, str]:
    net = built.network
    out: Dict[str, str] = {}
    for side in ("oxidiser", "fuel"):
        port = built.engine_ports.get(side, "")
        if port in net.branches:
            out[side] = net.branches[port].upstream
        elif port in net.nodes:
            out[side] = port
    return out


def _dome_regulators(model: Any) -> List[Tuple[str, Any, str]]:
    """``(symbol id, component, upstream node)`` for every dome-loaded regulator."""
    from feedtwin.comps.regulator import Regulator

    built = model.built
    out = []
    for node in model.diagram.nodes:
        if node.type != "PR" or node.options.get("domeLoaded") != "yes":
            continue
        for branch_id in built.branches_of.get(node.id, ()):
            branch = built.network.branches.get(branch_id)
            if branch is not None and isinstance(branch.component, Regulator):
                out.append((node.id, branch.component, branch.upstream))
                break
    return out


def dome_knobs(model: Any) -> List[Dict[str, Any]]:
    """Every regulator a dome dial could set, as the feed twin's hookup lists them: ``{id, label,
    kind, page, drawn_psia}`` with ``kind`` loader / dome / plain (feedtwin.session.hookup)."""
    from feedtwin.session.hookup import regulators

    from feedtwin.session.gauge import ATMOSPHERE

    return [{"id": r.id, "label": r.label, "kind": r.kind, "page": r.page,
             "drawn_psia": None if r.drawn_psig is None else r.drawn_psig + ATMOSPHERE / PSI}
            for r in regulators(model)]


def default_dome_regulator(model: Any) -> Optional[str]:
    """The regulator the feed twin's own dome knob drives on this drawing (``hookup.suggest``)."""
    from feedtwin.session.hookup import DOME, suggest

    knob = next((k for k in suggest(model).knobs if k.id == DOME), None)
    return knob.regulators[0] if knob is not None and knob.regulators else None


def _knob_lockup(model: Any, regulator: str, dome_psig: float, supply_pa: float) -> Optional[float]:
    """Tank lockup [Pa abs] with the dial on ``regulator`` alone: a loader through its own outlet into
    the dome it loads, any other regulator through its own dome signal (a plain one reads it as its
    setpoint). The regulator that sets the tanks is evaluated at zero flow, plus its lockup rise."""
    from feedtwin.comps.regulator import Regulator
    from feedtwin.session.gauge import from_psig

    built = model.built
    labels = {n.id: n.label or n.id for n in model.diagram.nodes}
    signals: Dict[str, float] = {}
    loader = built.dome_loaders.get(regulator)
    if loader is not None:
        cond = built.network.conditions(loader.supply_node, supply_pa,
                                        {f"{loader.component.id}.dome": from_psig(dome_psig)})
        signals[loader.signal] = float(loader.component.outlet_setpoint(0.0, cond))
        target = next((nid for nid, lab in labels.items() if f"{lab}.dome" == loader.signal), None)
    else:
        signals[f"{labels.get(regulator, regulator)}.dome"] = from_psig(dome_psig)
        target = regulator
    for branch_id in built.branches_of.get(target or "", ()):
        branch = built.network.branches.get(branch_id)
        if branch is not None and isinstance(branch.component, Regulator):
            cond = built.network.conditions(branch.upstream, supply_pa, signals)
            return float(branch.component.outlet_setpoint(0.0, cond)) + float(branch.component.p.get("lockup_rise", 0.0))
    return None


def lockup_for_dome(model: Any, dome_psig: float, supply_pa: float, regulator: Optional[str] = None) -> Optional[float]:
    """Tank lockup [Pa abs] the drawing's regulators deliver for a dome dial
    setting and a bottle pressure: the loader evaluated against the bottle the
    way the session does each tick, then the dome-loaded unit at zero flow plus
    its seat's lockup rise. ``None`` when the drawing has no dome-loaded unit."""
    from feedtwin.session.gauge import from_psig

    if regulator is not None:
        return _knob_lockup(model, regulator, dome_psig, supply_pa)
    built = model.built
    regulators = _dome_regulators(model)
    if not regulators:
        return None
    signals: Dict[str, float] = {}
    for loader in built.dome_loaders.values():
        cond = built.network.conditions(
            loader.supply_node, supply_pa, {f"{loader.component.id}.dome": from_psig(dome_psig)}
        )
        signals[loader.signal] = float(loader.component.outlet_setpoint(0.0, cond))
    if not built.dome_loaders:
        dome_signal = next((s for s in built.actuators.values() if s.endswith(".dome")), "")
        if dome_signal:
            signals[dome_signal] = from_psig(dome_psig)
    _, component, upstream = regulators[0]
    cond = built.network.conditions(upstream, supply_pa, signals)
    return float(component.outlet_setpoint(0.0, cond)) + float(component.p.get("lockup_rise", 0.0))


def dome_for_lockup(model: Any, target_pa: float, supply_pa: float, regulator: Optional[str] = None) -> Optional[float]:
    """The dome dial [psig] that locks the tanks up at ``target_pa``. The map is
    affine in the dial (loader outlet plus bias plus supply effect), so two
    evaluations solve it exactly; a third confirms."""
    a, b = 400.0, 600.0
    la, lb = lockup_for_dome(model, a, supply_pa, regulator), lockup_for_dome(model, b, supply_pa, regulator)
    if la is None or lb is None or abs(lb - la) < 1e-9:
        return None
    dome = a + (target_pa - la) * (b - a) / (lb - la)
    check = lockup_for_dome(model, dome, supply_pa, regulator)
    if check is None or abs(check - target_pa) > 0.01 * PSI:
        return None
    return dome


def prepare(config: Any, runner: Any, drawing: Drawing, settings: LayerXSettings,
            overrides: Optional[List[Any]] = None) -> Prepared:
    """Read, match, size, calibrate and check. Never raises for a problem a
    person can fix: that becomes a ``fail`` check naming it."""
    from feedtwin.engine.importer import engine_from_config
    from feedtwin.pid import DiagramError, read_diagram
    from feedtwin.session import assemble_model, load_machine
    from feedtwin.session.burn import BurnPlan
    from feedtwin.session.gauge import ATMOSPHERE, from_psig, psig_from_psia

    prep = Prepared(settings=settings, drawing=drawing, config_sha256=config_fingerprint(config),
                    measurements=list(overrides or []))
    checks = prep.checks
    add = lambda key, label, status, detail="": checks.append(Check(key, label, status, detail))  # noqa: E731

    problems = _option_problems(settings)
    if problems:
        add("options", "Run options", "fail", "; ".join(problems) + ".")
        return prep

    # ---- the drawing, with what has been measured written in ----------------------
    from engine.layerx.measurements import apply_overrides

    payload, applied, missing = apply_overrides(drawing.payload, list(overrides or []))
    prep.overrides = applied
    if applied:
        measured = sum(1 for a in applied if a["provenance"] == "measured")
        add("overrides", "Restated drawing parameters", "info",
            f"{len(applied)} parameter(s) restated ({measured} measured): "
            + ", ".join(f"{a['key']} = {a['value']:g} {a['unit']}".rstrip() for a in applied[:6])
            + (" …" if len(applied) > 6 else "") + ".")
    if missing:
        add("overrides_missing", "Restated parameters the drawing no longer has", "warn",
            "The drawing has changed since these were entered: " + ", ".join(missing) + ".")
    # The burn is the vehicle's (engine.layerx.vehicle): a GSE page joined only by paired
    # disconnects is left out, its disconnect halves capped; Layer X primes what the GSE would.
    try:
        payload, ground = vehicle_payload(payload)
    except Exception:  # noqa: BLE001 - a drawing feedtwin cannot read is reported just below
        ground = []
    if ground:
        add("ground_support", "Ground support on the drawing", "info",
            f"{', '.join(ground)} {'is' if len(ground) == 1 else 'are'} joined to the vehicle only through "
            "paired disconnects: ground support. The burn runs the vehicle alone, primed by Layer X "
            "(loads, bottle fill, regulator dome), with those disconnects capped.")
    if settings.pressurant:
        payload, swapped, was = swap_pressurant(payload, settings.pressurant)
        if swapped:
            add("pressurant", "Pressurant", "info",
                f"{was} swapped for {settings.pressurant} on {swapped} component(s) for this burn. The drawing's "
                "regulator droop and line data were measured with its own gas.")
    try:
        diagram = read_diagram(payload, name=drawing.name)
    except DiagramError as exc:
        add("drawing", "Drawing reads", "fail", str(exc))
        return prep

    # ---- the engine, as the twin imports it --------------------------------
    try:
        native = engine_from_config(config.model_dump(mode="json"), name="engine")
    except Exception as exc:  # noqa: BLE001 - an import failure is a finding
        add("engine", "Engine import into the feed model", "fail", str(exc))
        return prep
    species = {"oxidiser": native.oxidiser.propellant, "fuel": native.fuel.propellant}

    # The vehicle's vessels only (engine.layerx.vehicle): a GSE transfer tank or cart bottle on the
    # drawing's other page, joined by paired disconnects, is not a propellant tank or the pressurant.
    vehicle = vehicle_ids(diagram)
    tanks = on_vehicle([n for n in diagram.nodes if n.type == "TANK"], vehicle)
    roles: Dict[str, str] = {}
    for side, sp in species.items():
        found = [t.id for t in tanks if (t.fluid or "").lower() == sp.lower()]
        if len(found) == 1:
            roles[side] = found[0]
        elif not found:
            add(f"tank_{side}", f"{side.capitalize()} tank on the drawing", "fail",
                f"The engine burns {sp}; no tank on '{drawing.name}' holds it "
                f"(tanks: {', '.join(f'{t.id} [{t.fluid}]' for t in tanks) or 'none'}).")
        else:
            add(f"tank_{side}", f"{side.capitalize()} tank on the drawing", "fail",
                f"{len(found)} tanks on the vehicle hold {sp} ({', '.join(found)}); Layer X needs exactly one.")
    if len(roles) == 2:
        add("tanks", "Tanks match the engine's propellants", "ok",
            f"{roles['oxidiser']} holds {species['oxidiser']}, {roles['fuel']} holds {species['fuel']}.")
    prep.roles = roles

    cea = cea_table_path(config)
    if cea is None:
        add("cea", "Combustion table", "warn",
            "CEA cache not found; the feed model's chamber uses a constant c* and reports no thrust.")
    else:
        add("cea", "Combustion table", "ok", cea.name)

    # ---- site ambient --------------------------------------------------------
    from engine.core.runner import compute_ambient_pressure_from_elevation

    elevation = float(getattr(getattr(config, "environment", None), "elevation", 0.0) or 0.0)
    ambient = compute_ambient_pressure_from_elevation(elevation) if elevation > 0 else 101325.0
    prep.ambient_pa = ambient
    add("ambient", "Site ambient pressure", "info",
        f"{ambient / 1e3:.2f} kPa at {elevation:.0f} m. Layer X reports absolute pressures; gauge "
        "readings are referenced to 101.325 kPa, as on the DAQ.")

    # ---- a first model, for the network's own fluid states -------------------
    try:
        probe_model = assemble_model(diagram, diagram_id=drawing.id, engine=native,
                                     cea_cache=str(cea) if cea else "")
    except Exception as exc:  # noqa: BLE001
        add("assembly", "Drawing assembles with the engine", "fail", str(exc))
        return prep
    inlets = _inlet_nodes(probe_model.built)
    if set(inlets) != {"oxidiser", "fuel"}:
        add("engine_ports", "Engine attaches to the drawing", "fail",
            "The drawing's ENGINE symbol did not resolve to an oxidiser and a fuel injector inlet.")
        return prep
    prep.inlet_nodes = inlets

    # ---- the line the injector is fed by, against the bore the design prices its dump on ----
    # EngineDesign charges the dump of the line's velocity head into the manifold on its own exit
    # bore; the drawing's last line is what actually arrives. A smaller tube makes that dump grow
    # as the fourth power of the bore ratio, silently.
    try:
        from engine.layerx.flight import _path_to_tank

        edges = {str(e.get("id")): e for e in payload.get("edges") or [] if isinstance(e, dict)}
        mismatched = []
        for side, cside in (("oxidiser", "oxidizer"), ("fuel", "fuel")):
            path = _path_to_tank(probe_model, inlets.get(side, ""), roles.get(side, ""))
            last = edges.get(path[-1]) if path else None
            bore = ((last or {}).get("data") or {}).get("params", {}).get("bore") if last else None
            feed = (getattr(config, "feed_system", None) or {}).get(cside)
            if not isinstance(bore, dict) or feed is None:
                continue
            drawn_mm = float(bore["value"]) * {"mm": 1.0, "m": 1e3, "in": 25.4}.get(str(bore.get("unit", "mm")), 1.0)
            d_exit = getattr(feed, "d_exit", None)
            design_mm = (float(d_exit) if d_exit else (4.0 * float(feed.A_hydraulic) / 3.141592653589793) ** 0.5) * 1e3
            if design_mm > 0 and abs(drawn_mm / design_mm - 1.0) > 0.10:
                mismatched.append(f"{'LOX' if side == 'oxidiser' else 'fuel'}: drawn {drawn_mm:.2f} mm, design {design_mm:.2f} mm "
                                  f"(dump ×{(design_mm / drawn_mm) ** 4:.1f})")
        if mismatched:
            add("exit_bore", "Line into the injector", "warn",
                "The manifold dump is priced on the design's exit bore, not the drawing's last line: "
                + "; ".join(mismatched) + ". Set feed_system.<side>.d_exit to the drawn bore, or redraw the line.")
    except Exception:  # noqa: BLE001 - a comparison that cannot be made is not a reason to refuse
        pass

    # ---- in flight, the drawing's lines carry the acceleration as drawn ----------------
    if settings.flight:
        from engine.layerx.flight import line_paths

        try:
            rows = line_paths(payload, probe_model, inlets, roles, [o.key() for o in (overrides or [])])
        except Exception as exc:  # noqa: BLE001 - a drawing the flight cannot trace is a finding
            add("vehicle_lines", "Feed-line heights", "fail", f"{type(exc).__name__}: {exc}")
            return prep
        prep.vehicle_lines = rows
        name = {"oxidiser": "LOX", "fuel": "Fuel"}
        how = {"drawing": "as drawn", "restated": "as restated", "none": "no height on the drawing"}
        missing = [r for r in rows if r["used"] == "none"]
        steep = [b for r in rows for b in r["too_steep"]]
        add("vehicle_lines", "Feed-line heights", "warn" if missing or steep else "info",
            "; ".join(f"{name[r['side']]}: {r['length_m']:.2f} m of line from the tank, falls {r['drop_m']:.2f} m "
                      f"({how[r['used']]})" for r in rows) + "."
            + (" In flight a line with no height carries no head; only the tank's own liquid feels the "
               "acceleration. Put the heights on the drawing in pid-designer, or restate each line's "
               "elevation_change under Enter measured values." if missing else "")
            + (f" {', '.join(steep)} falls further than it is drawn long: check the drawing." if steep else ""))

    def fluid_at(side: str, pressure: float) -> Tuple[float, float]:
        cond = probe_model.built.network.conditions(inlets[side], pressure)
        return float(cond.rho), float(cond.mu)

    # ---- pressures: target lockup, bottle, dome ------------------------------
    atm_psia = ATMOSPHERE / PSI
    lox_psia = float(getattr(config.lox_tank, "initial_pressure_psi", 0.0) or 0.0)
    fuel_psia = float(getattr(config.fuel_tank, "initial_pressure_psi", 0.0) or 0.0)

    # ---- the bottle at T-0 ---------------------------------------------------
    bottles = on_vehicle([n for n in diagram.nodes if n.type == "KBOTTLE"], vehicle)
    drawn_copv = None
    if bottles and "pressure" in bottles[0].params:
        # Absolute in SI whatever the drawing wrote (bare psi reads as psig:
        # feedtwin.model.pressure); the plan wants gauge.
        drawn_copv = psig_from_psia(bottles[0].params["pressure"].si / PSI)
    if not bottles:
        add("bottle", "Pressurant bottle", "fail", "The vehicle has no bottle to press from.")
        return prep
    if settings.copv_pressure_psia is not None:
        copv_psig = settings.copv_pressure_psia - atm_psia
    else:
        copv_psig = settings.copv_pressure_psig if settings.copv_pressure_psig is not None else drawn_copv
    if copv_psig is None:
        add("bottle_pressure", "Bottle pressure at T-0", "fail",
            "Neither the rail nor the drawing's bottle states a fill pressure.")
        return prep
    supply_pa = from_psig(copv_psig)

    # ---- the dome dial, and the tank lockup it gives (2026-10-07) -------------
    # The dial is an input: the rail's, else the one the drawing states on the regulator it sets
    # (the feed twin's dome knob unless the rail names another). A tank pressure on the rail is the
    # other way in: the dial is solved for it. With neither, the design's tank pressure, as before.
    knobs = dome_knobs(probe_model)
    reg_id = settings.dome_regulator or default_dome_regulator(probe_model)
    knob = next((k for k in knobs if k["id"] == reg_id), None)
    if settings.dome_regulator and knob is None:
        add("dome_regulator", "Dome regulator", "fail",
            f"{settings.dome_regulator!r} is not a regulator a dial can set on the vehicle "
            f"({', '.join(k['label'] for k in knobs) or 'none'}).")
        return prep
    named = reg_id if settings.dome_regulator else None   # the session is told only when the rail chose
    drawn_dome = None if knob is None or knob["drawn_psia"] is None else knob["drawn_psia"] - atm_psia
    if settings.dome_psia is not None:
        dome, source = settings.dome_psia - atm_psia, "set on the rail"
    elif settings.tank_pressure_psia is not None:
        dome, source = None, "solved for the rail's tank pressure"
    elif drawn_dome is not None:
        dome, source = drawn_dome, "as drawn"
    else:
        dome, source = None, "solved for the design's tank pressure"
    target_psia = None
    if dome is not None:
        lock = lockup_for_dome(probe_model, dome, supply_pa, named)
        if lock is None:
            add("dome", "Regulator dome", "fail",
                "No regulator on the vehicle takes a dome dial, so the dial cannot set the tanks.")
            return prep
        target_psia = lock / PSI
    else:
        target_psia = settings.tank_pressure_psia or lox_psia
        if not target_psia:
            add("tank_pressure", "Tank pressure", "fail",
                "Neither the rail, the drawing's dome nor the config (lox_tank.initial_pressure_psi) "
                "states a tank pressure.")
            return prep
        if settings.tank_pressure_psia is None and fuel_psia and abs(fuel_psia - lox_psia) > 0.5:
            add("tank_pressures", "One tank pressure for both tanks", "warn",
                f"The config sets LOX {lox_psia:.1f} and fuel {fuel_psia:.1f} psia; the drawing feeds both "
                f"from one regulator, so both start at {target_psia:.1f} psia.")
        dome = dome_for_lockup(probe_model, target_psia * PSI, supply_pa, named)
    target_pa = target_psia * PSI
    regs = _dome_regulators(probe_model) if named is None else knobs
    where = f"on {knob['label']}" if knob is not None else "on the control regulator"
    if dome is None:
        add("dome", "Regulator dome", "warn" if not regs else "fail",
            "No dome-loaded regulator on the drawing: tank pressure is whatever its regulator's "
            "setpoint gives, and the target cannot be dialled." if not regs else
            "Could not solve the dome setting for that lockup.")
        dome = 500.0   # feedtwin's Setup.dome_psi default; nothing on this drawing reads it
    else:
        add("dome", "Regulator dome", "ok",
            f"{dome + atm_psia:.1f} psia {where} ({source}) gives {target_psia:.1f} psia tank lockup "
            f"with the bottle at {copv_psig + atm_psia:.0f} psia.")

    # MAWP of the tanks and the bottle against what they will hold. MAWP is a difference across the
    # wall, so it is held against the site's atmosphere, not the DAQ's 101.325 kPa gauge zero
    # (~1 psi tighter at 627 m; the vehicle climbing during the burn adds a little more).
    for t in tanks:
        mawp = t.params.get("MAWP")
        if mawp is not None and target_pa - ambient > mawp.si:
            add(f"mawp_{t.id}", f"{t.label or t.id} MAWP", "fail",
                f"Lockup {target_psia:.1f} psia is {(target_pa - ambient) / PSI:.1f} psi above the site's atmosphere; "
                f"the drawing's MAWP is {mawp.si / PSI:.0f} psi.")
    for b in bottles:
        mawp = b.params.get("MAWP")
        if mawp is not None and from_psig(copv_psig) - ambient > mawp.si:
            add(f"mawp_{b.id}", f"{b.label or b.id} MAWP", "fail",
                f"Bottle fill {from_psig(copv_psig) / PSI:.0f} psia is {(from_psig(copv_psig) - ambient) / PSI:.0f} psi above the site's "
                f"atmosphere; its MAWP is {mawp.si / PSI:.0f} psi.")

    # The ratings themselves: a pass against a rating nobody measured is only as good as the guess,
    # and a vessel with no rating on the drawing is checked against nothing at all.
    unrated = [v.label or v.id for v in list(tanks) + list(bottles) if v.params.get("MAWP") is None]
    guessed = [f"{v.label or v.id} {v.params['MAWP'].si / PSI:.0f} psi"
               for v in list(tanks) + list(bottles)
               if v.params.get("MAWP") is not None
               and str(getattr(v.params["MAWP"].source, "value", v.params["MAWP"].source)).lower() in ("estimated", "default")]
    if unrated or guessed:
        add("ratings", "Vessel ratings", "warn",
            (f"No MAWP on the drawing for {', '.join(unrated)}: nothing checks those vessels. " if unrated else "")
            + (f"Estimated, not measured or from a datasheet: {', '.join(guessed)}. The MAWP checks and the "
               "optimiser's tank-pressure ceiling stand on these." if guessed else ""))

    gn2 = gn2_on_lox(bottles[0].fluid if bottles else None,
                     next((t for t in tanks if t.id == roles.get("oxidiser")), None), target_pa,
                     test_mode=settings.test_mode or "hotfire",
                     acknowledged=bool(settings.ack_gn2_condensation))
    if gn2 is not None:
        add("gn2_condensation", "Nitrogen over LOX", gn2["status"], gn2["detail"])

    # ---- the load -------------------------------------------------------------
    loads: Optional[Dict[str, float]] = None
    tank_volumes = {t.id: (t.params["volume"].si if "volume" in t.params else None) for t in tanks}
    rho_tank = {}
    if len(roles) == 2:
        for side in ("oxidiser", "fuel"):
            rho_tank[side] = fluid_at(side, target_pa)[0]
        if settings.load == "config":
            loads = {roles["oxidiser"]: float(config.lox_tank.mass), roles["fuel"]: float(config.fuel_tank.mass)}
            for side, tank_id in roles.items():
                vol = tank_volumes.get(tank_id)
                liquid = loads[tank_id] / rho_tank[side]
                if vol is None:
                    continue
                frac = liquid / vol
                if frac >= 1.0:
                    add(f"load_{side}", f"{side.capitalize()} load fits", "fail",
                        f"{loads[tank_id]:.3f} kg is {liquid * 1e3:.2f} L in a {vol * 1e3:.2f} L tank.")
                elif frac > 0.95 or frac < 0.25:
                    add(f"load_{side}", f"{side.capitalize()} load fits", "warn",
                        f"{loads[tank_id]:.3f} kg fills {frac * 100:.0f} % of the {vol * 1e3:.2f} L tank.")
                else:
                    add(f"load_{side}", f"{side.capitalize()} load fits", "ok",
                        f"{loads[tank_id]:.3f} kg fills {frac * 100:.0f} % of the {vol * 1e3:.2f} L tank.")
        # The drawing's tanks against the config's.
        for side, cfg_tank in (("oxidiser", config.lox_tank), ("fuel", config.fuel_tank)):
            cfg_vol = getattr(cfg_tank, "tank_volume_m3", None)
            vol = tank_volumes.get(roles[side])
            if cfg_vol and vol and abs(vol - cfg_vol) / cfg_vol > 0.05:
                add(f"volume_{side}", f"{side.capitalize()} tank volume: drawing vs config", "warn",
                    f"The drawing's tank is {vol * 1e3:.2f} L; the config's is {cfg_vol * 1e3:.2f} L. "
                    "The burn follows the drawing. A different ullage is a different blowdown.")
    press = getattr(config, "press_tank", None)
    cfg_copv_L = getattr(press, "free_volume_L", None) if press is not None else None
    if bottles and cfg_copv_L and "volume" in bottles[0].params:
        drawn_L = bottles[0].params["volume"].si * 1e3
        if abs(drawn_L - cfg_copv_L) / cfg_copv_L > 0.05:
            add("volume_copv", "Bottle volume: drawing vs config", "warn",
                f"The drawing's bottle is {drawn_L:.3f} L; the config's is {cfg_copv_L:.3f} L.")

    # ---- the tanks at burnout: lockup plus the regulator's supply-pressure effect ------------
    # The lockup is checked against the MAWP above; the regulator then lifts the tanks as the
    # bottle falls. Estimate the end pressure from the drawing's own regulator law and say when it
    # crosses a rating or the design's cap. A warning: the burn itself prices it exactly.
    try:
        rise = _burnout_tank_check(probe_model, dome, bottles[0], copv_psig, target_pa, roles, tanks, tank_volumes,
                                   loads, rho_tank, settings, ambient, config)
    except Exception as exc:  # noqa: BLE001 - an estimate that cannot be made is said, not raised
        rise = {"status": "info", "detail": f"Could not estimate the tanks' rise over the burn ({type(exc).__name__}: {exc})."}
    rise_estimate = None
    if rise is not None:
        add("tank_rise", "Tanks at burnout (regulator supply effect)", rise["status"], rise["detail"])
        rise_estimate = rise.get("estimate")

    # ---- the state machine ----------------------------------------------------
    try:
        machine = load_machine(tables=machines_dir())
    except Exception as exc:  # noqa: BLE001
        add("machine", "Valve sequence (DAQ state machine)", "fail", str(exc))
        return prep
    from feedtwin.session.statemachine import bind

    labels = {n.id: n.label for n in diagram.nodes if n.id in probe_model.built.actuators}
    binding = bind(machine, labels, roles=probe_model.built.valve_roles)
    mains = [a for a in machine.actuators if "main" in a.lower()]
    unbound_mains = [a for a in mains if a not in binding.to_symbol]
    if unbound_mains:
        add("mains", "Main valves bound to the Fire state", "fail",
            f"{', '.join(unbound_mains)} has no valve on the drawing, so Fire would not open it.")
    else:
        add("mains", "Main valves bound to the Fire state", "ok",
            ", ".join(f"{a} → {binding.to_symbol[a]}" for a in mains))
    prep.machine = machine

    # ---- the engine, linked to EngineDesign -----------------------------------------
    try:
        link = link_engine(config, tank_pa_O=target_pa, tank_pa_F=target_pa, cea_path=cea,
                           ambient_pa=ambient, fluid_at=fluid_at, mode=settings.engine_model,
                           card_center_pa=(settings.card_center_psia * PSI if settings.card_center_psia else None))
    except Exception as exc:  # noqa: BLE001
        add("engine_link", "EngineDesign solves at T-0", "fail", f"{type(exc).__name__}: {exc}")
        return prep
    prep.link = link
    if True:
        # AUDIT D4-B: the card's vacuum velocity follows the eroding throat's expansion ratio, always
        # (2026-10-03). At the as-built throat it is the plain card chamber, bit for bit.
        if link.mode != "card":
            add("card_eroded_nozzle", "Card nozzle follows the eroding throat", "info",
                f"The engine is '{link.mode}', not the engine card: nothing to scale.")
        else:
            from engine.layerx.card import expansion_chamber

            link.chamber = expansion_chamber(link.card, link.sampler.runner.cea_cache, ambient_pressure=ambient,
                                             volume=link.design.chamber_volume)
            add("card_eroded_nozzle", "Card nozzle follows the eroding throat", "info",
                "The engine card's vacuum velocity is scaled by Cf_vac(ε(t))/Cf_vac(ε0) from EngineDesign's CEA table "
                "as the replay's throat opens (AUDIT D4-B)"
                + ("." if link.chamber.eps_axis else "; this CEA table has no expansion-ratio axis, so the scale is 1."))
    cal = link.calibration
    if link.mode == "card":
        fit = cal["fit"]
        prov = cal["card"]
        within = bool(prov.get("within_tolerance"))
        add("engine_card", "Engine card from EngineDesign", "ok" if within else "warn",
            f"{prov['samples']} EngineDesign solves at the line exit ({prov['sampler']}, "
            f"{prov['built_s']:.1f} s). The table reproduces EngineDesign's own model to Pc "
            f"{fit['envelope_closed_pc'] * 100:.2f} %, thrust {fit['envelope_closed_thrust'] * 100:.2f} %, flow "
            f"{fit['envelope_closed_mdot'] * 100:.2f} % on {int(fit['envelope_points'])} held-out solves (tolerance "
            f"{fit['tolerance'] * 100:.1f} %; whole scan Pc {fit['box_closed_pc'] * 100:.1f} %). That is agreement "
            "with the model, not accuracy: the model's own unknowns (Cd, mixing, nozzle efficiency) are the "
            "uncertainty sweep's.")
        add("engine_boundary", "Engine boundary at the line exit", "info",
            f"Line exit to chamber at T-0: LOX {link.reference['dp_line_O'] / PSI:.1f} psi, fuel "
            f"{link.reference['dp_line_F'] / PSI:.1f} psi, EngineDesign's exit dump into the manifold "
            "included. The drawing's lines carry everything upstream; EngineDesign's own feed_system K "
            "is not used.")
    elif link.mode == "calibrated":
        add("engine_link", "Engine fitted to EngineDesign at T-0", "warn",
            f"Cd {cal['cd_O']:.3f} / {cal['cd_F']:.3f} (twin's own law: {cal['native_cd_O']:.3f} / "
            f"{cal['native_cd_F']:.3f}); η_c* {cal['eta_cstar']:.4f}, η_n {cal['eta_n']:.4f}, held constant "
            "through the burn. The engine card follows EngineDesign everywhere instead.")
    else:
        gap = twin_injector_check(link, fluid_at)
        add("engine_link", "Engine: the twin's native model", "warn",
            "Not EngineDesign. At EngineDesign's T-0 flows the twin's injector drops "
            + ", ".join(f"{side} {tw / PSI:.0f} psi vs {ed / PSI:.0f}" for side, (tw, ed) in gap.items())
            + "; its chamber runs η_c* = 1, so Pc is an upper bound.")
    for note in link.notes:
        add("engine_note", "Engine link", "warn", note)
    if link.mode == "card":
        # The card's injector is a flow capacity tabulated at EngineDesign's propellant densities;
        # the twin's own density at the inlet does not move it. Say how far apart the two are.
        gaps = []
        for side, key in (("oxidiser", "oxidizer"), ("fuel", "fuel")):
            fluid = (config.fluids or {}).get(key)
            rho_ed = float(getattr(fluid, "density", 0.0) or 0.0)
            if rho_ed > 0.0:
                rho_twin = fluid_at(side, target_pa)[0]
                gaps.append((side, rho_ed, rho_twin, rho_twin / rho_ed - 1.0))
        if gaps:
            worst = max(abs(g[3]) for g in gaps)
            add("density", "Propellant density: EngineDesign vs feed model", "warn" if worst > 0.01 else "info",
                "; ".join(f"{side} {ed:.1f} vs {tw:.1f} kg/m³ ({gap * 100:+.1f} %)" for side, ed, tw, gap in gaps)
                + ". The engine card is tabulated at EngineDesign's densities; flow scales with √ρ, so the flow "
                  "error is half the density gap.")

    # ---- the calibrated model, the plan and the setup --------------------------
    def assembler() -> Any:
        return assemble_model(diagram, diagram_id=drawing.id, engine=link.design, chamber=link.chamber,
                              engine_reference=f"live config {prep.config_sha256[:12]}",
                              meta={"diagram_name": drawing.name, "diagram_sha256": drawing.sha256})

    try:
        model = assembler()
    except Exception as exc:  # noqa: BLE001
        add("assembly", "Drawing assembles with the engine", "fail", str(exc))
        return prep
    defaults = model.report.unchecked
    add("assumptions", "Unspecified drawing parameters", "info" if not defaults else "warn",
        f"{defaults} library default(s), {len(model.report.assumptions)} assumed value(s) in total; "
        "listed under Details.")

    prep.model = model
    prep.assembler = assembler
    prep.setup = feed_twin_setup(
        # The chamber closure finer than the engine card's own error (~0.02 %), so a thrust
        # quoted to a tenth of a percent is the card's, not the solver's tolerance.
        chamber_tolerance_psi=CHAMBER_TOLERANCE_PSI,
        network_tolerance=NETWORK_TOLERANCE,
        # The regulator's supply-pressure effect at lockup and the line and fitting heat are the
        # feed twin's own (both on there since 2026-10-03); the first is also what lets 1e-6 solve
        # at lockup.
        dome_psi=dome,
        **{k: v for k, v in (("ullage_collapse", settings.ullage_collapse), ("ullage_vapour", settings.ullage_vapour),
                             ("chilldown", settings.chilldown), ("line_walls", settings.line_walls)) if v is not None},
    )
    prep.plan = BurnPlan(
        tank_psi=psig_from_psia(target_psia),
        copv_psi=copv_psig,
        fill_fraction=settings.fill_fraction,
        loads=loads,
        hold_s=settings.hold_s,
        settle=settings.settle,
        dt=settings.dt,
        horizon_s=settings.horizon_s,
        tanks=(roles["oxidiser"], roles["fuel"]) if len(roles) == 2 else None,
        # The burn ends when the first tank runs dry, not on the step after: burn time, impulse
        # and the bottle at burnout are then continuous in the design, which every comparison
        # Layer X makes (sweep, optimiser, pad against flight) depends on.
        end_on_depletion=True,
        dry_kg=settings.dry_kg,
    )
    lead = float(getattr(prep.plan, "lead_in_s", 0.5))
    if abs(lead / settings.dt - round(lead / settings.dt)) > 1e-6:
        # The firing clock starts at Fire; a step that straddles it is counted short, and the first
        # firing step's impulse with it (3 % of the burn at 0.2 s).
        add("time_step", "Time step", "fail",
            f"{settings.dt * 1e3:g} ms does not divide the {lead:g} s before Fire into whole steps. "
            "Use 10, 20, 50 or 100 ms.")
        return prep
    add("residual", "Burn ends with the tanks empty", "info",
        f"The burn ends when the first tank is down to {settings.dry_kg * 1e3:g} g"
        + (": burnt dry. No unusable residual (sump, line, pull-through) is stated; enter a measured one "
           "to charge for it." if settings.dry_kg <= 0.002 else ", the unusable residual you stated."))
    req = getattr(config, "design_requirements", None)

    def band(side: str) -> Optional[List[float]]:
        lo = getattr(req, f"injector_dp_ratio_{side}_min", None) if req is not None else None
        hi = getattr(req, f"injector_dp_ratio_{side}_max", None) if req is not None else None
        return [float(lo), float(hi)] if lo is not None and hi is not None else None

    prep.derived = {
        # The thermal models the burn runs, as the feed twin sets them (or as this run overrides
        # them): the rail shows them, read-only, so the setup on screen is the twin's.
        "feed_twin_thermal": {
            k: getattr(prep.setup, k) for k in ("ullage_collapse", "ullage_vapour", "chilldown", "line_walls",
                                                "stratification", "wall_boiling", "chilldown_nucleate", "boiling_onset_K",
                                                "regulator_lockup_supply")
            if hasattr(prep.setup, k)},
        "stiffness_band": {"oxidiser": band("O"), "fuel": band("F")},
        "roles": roles,
        "species": species,
        "pressurant_gas": (bottles[0].fluid if bottles else None),
        "target_lockup_psia": target_psia,
        "dome_psig": dome,
        "copv_psig": copv_psig,
        "copv_psia": (from_psig(copv_psig)) / PSI,
        "copv_id": bottles[0].id if bottles else None,
        # A bottle the drawing gives no volume is the size the twin's burn assumed for it, not a blank:
        # the flight and the pressurant diagnostics must fly the bottle the burn emptied.
        "copv_volume_L": (None if not bottles else bottles[0].params["volume"].si * 1e3 if "volume" in bottles[0].params
                          else getattr(prep.setup, "bottle_volume_L", None)),
        "copv_mawp_psi": (bottles[0].params["MAWP"].si / PSI if bottles and "MAWP" in bottles[0].params else None),
        "copv_drawn_psig": drawn_copv,
        # The rail's absolute pressures (2026-10-07): the dial, where it came from, which regulator it
        # sets, what the drawing says it is, every regulator it could be on, and the drawn bottle.
        "dome_psia": dome + atm_psia,
        "dome_source": source,
        "dome_regulator": knob["id"] if knob is not None else None,
        "dome_regulator_label": knob["label"] if knob is not None else None,
        "dome_drawn_psia": None if drawn_dome is None else drawn_dome + atm_psia,
        "dome_candidates": knobs,
        "copv_drawn_psia": None if drawn_copv is None else drawn_copv + atm_psia,
        "tank_mawp_psi": {t.id: t.params["MAWP"].si / PSI for t in tanks if "MAWP" in t.params},
        "loads_kg": loads,
        "fill_fraction": None if loads else settings.fill_fraction,
        "tank_volumes_L": {k: (v * 1e3 if v else None) for k, v in tank_volumes.items()},
        "ambient_pa": ambient,
        "gauge_zero_pa": ATMOSPHERE,
        "elevation_m": elevation,
        "inlet_nodes": inlets,
        "engine_model": link.mode,
        "cea_table": cea.name if cea else None,
        "config_sha256": prep.config_sha256,
        "binding": dict(binding.to_symbol),
        "unbound": list(binding.unmatched),
        "machine_warnings": list(machine.warnings),
        "overrides": prep.overrides,
        "vehicle_lines": prep.vehicle_lines or None,
        "vehicle_dry_kg": _vehicle_dry_kg(config),
        "tank_rise_estimate": rise_estimate,
        "options": options(settings),
    }
    return prep
