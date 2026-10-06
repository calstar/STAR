"""Verification checks on a finished Layer X burn: does it conserve what it must? (DATA-CONTRACT 3, ``vv``)

A burn that converges, plots smoothly and violates no assertion is not evidence (CLAUDE.md). These
checks re-derive three balances from the recorded result, by a path independent of the twin's own
bookkeeping where one exists, and report how far each fails to close:

* **Propellant mass**, per side: what was loaded = what the chamber burned + what is left in the
  tank + what the drawing's feed lines hold. ``burned`` integrates the chamber's flow (or, with the
  full network recorded, the injector branches') step by step; ``loaded`` and ``residual`` are the
  tank's own inventory. The twin's network is algebraic (no liquid inventory in a line), so the
  trapped mass is the same at T-0 and at burnout: it enters both sides, and the error is the tank
  inventory against the integrated flow. It is reported because a stand fills its lines too.
* **Pressurant mass**: gas out of the bottle = gas gained by the ullages + gas vented. The bottle
  figure is the twin's vessel state; each ullage is **re-priced with CoolProp** from the recorded
  pressure, gas temperature and fill (``rho(p, T) * V_tank * (1 - fill)``), so the check does not
  read the twin's ullage mass back. Vented gas needs the full network recorder (``result.network``);
  without it the vents are taken as shut, which the burn plan does.
* **Gas-side energy** (first law over the pressurant: bottle, lines, ullages), reported, never
  graded: see :func:`energy_balance` for what it closes and what it cannot.
* **Convergence** of the outer loops, per pass, from ``result.passes``.

Every relative error is in percent of the quantity that entered the balance (the energy residual: of
the expulsion work, see :func:`energy_balance`). The thresholds that grade them live with every other
limit, in :data:`engine.layerx.diag.limits.THRESHOLDS`.

Sources: mass conservation for a control volume and the first law for an open system,
dU/dt = sum(m_in h_in) - sum(m_out h_out) + Q - p dV/dt (Moran & Shapiro, Fundamentals of Engineering
Thermodynamics, ch. 4, the control-volume energy rate balance). Properties: CoolProp
(Bell et al., Ind. Eng. Chem. Res. 53(6), 2014).
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

PSI = 6894.757293168361

#: Display names of the twin's species to CoolProp's.
COOLPROP = {"oxygen": "Oxygen", "ethanol": "Ethanol", "nitrogen": "Nitrogen", "helium": "Helium",
            "water": "Water", "lox": "Oxygen", "ln2": "Nitrogen", "gn2": "Nitrogen", "he": "Helium"}


def _num(v: Any) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _dig(d: Any, path: str) -> Any:
    for part in path.split("."):
        if not isinstance(d, Mapping):
            return None
        d = d.get(part)
    return d


def _pct(err: Optional[float], ref: Optional[float]) -> Optional[float]:
    if err is None or ref is None or ref == 0.0:
        return None
    return 100.0 * err / ref


def _species(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    return COOLPROP.get(str(name).lower(), str(name))


def _steps(series: Mapping[str, Any]) -> List[float]:
    t = series.get("t") or []
    dt = series.get("dt")
    if isinstance(dt, list) and len(dt) == len(t):
        return [float(v) for v in dt]
    # Older runs carry no per-step length: the gap to the previous sample (the first: the next gap).
    out = [t[i] - t[i - 1] for i in range(1, len(t))]
    return ([out[0]] if out else []) + out


# ---------------------------------------------------------------------- the drawing's feed lines


def feed_lines(document: Mapping[str, Any], tank_id: str) -> List[Dict[str, Any]]:
    """The drawing's lines from ``tank_id`` to the engine: the walk the propellant takes, edge by
    edge, while the next symbol carries the tank's fluid (a fill or vent line, which turns to the
    pressurant, is not followed). Each line as ``{id, length_m, bore_m, volume_m3, provenance}``;
    a line missing a length or bore is returned with ``volume_m3`` None."""
    from feedtwin.model.param import to_si

    nodes = {n.get("id"): n for n in (document.get("nodes") or []) if isinstance(n, Mapping)}
    edges = [e for e in (document.get("edges") or []) if isinstance(e, Mapping)]
    fluid = _dig(nodes.get(tank_id), "data.fluid")
    if fluid is None:
        return []

    def is_engine(node_id: str) -> bool:
        return str(_dig(nodes.get(node_id), "data.componentType") or "").upper() == "ENGINE"

    out: List[Dict[str, Any]] = []
    seen = {tank_id}
    frontier = [tank_id]
    while frontier:
        here = frontier.pop()
        for e in edges:
            if e.get("source") != here or e.get("target") in seen:
                continue
            target = e.get("target")
            if not (is_engine(target) or _dig(nodes.get(target), "data.fluid") == fluid):
                continue
            params = _dig(e, "data.params") or {}

            def si(key: str) -> Tuple[Optional[float], Optional[str]]:
                p = params.get(key)
                if not isinstance(p, Mapping) or _num(p.get("value")) is None:
                    return None, None
                try:
                    return float(to_si(float(p["value"]), str(p.get("unit") or ""))), str(p.get("source") or "")
                except Exception:  # noqa: BLE001 - an unknown unit is a line without a volume, said so
                    return None, None

            length, l_src = si("length")
            bore, b_src = si("bore")
            vol = math.pi * bore * bore / 4.0 * length if length is not None and bore is not None else None
            out.append({"id": e.get("id"), "from": here, "to": target, "length_m": length, "bore_m": bore,
                        "volume_m3": vol, "provenance": {"length": l_src, "bore": b_src}})
            if not is_engine(target):
                seen.add(target)
                frontier.append(target)
    return out


def _document(result: Mapping[str, Any], prep: Any, document: Optional[Mapping[str, Any]]) -> Optional[Mapping[str, Any]]:
    if document is not None:
        return document
    payload = getattr(getattr(prep, "drawing", None), "payload", None)
    if isinstance(payload, Mapping):
        return payload
    did = _dig(result, "provenance.drawing.id")
    if not did:
        return None
    try:
        from engine.layerx.sources import DrawingStore

        d = DrawingStore(None).get(str(did))
        return d.payload if d is not None else None
    except Exception:  # noqa: BLE001 - a run whose drawing is gone checks without its lines
        return None


# ---------------------------------------------------------------------- propellant


def mass_balance(result: Mapping[str, Any], prep: Any = None,
                 document: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """Per side: ``{loaded_kg, burned_kg, residual_kg, trapped_kg, error_pct, basis, lines}``.

    ``loaded_kg`` is the tank at T-0 plus the feed lines' liquid; ``error_pct`` is
    ``(loaded - burned - residual - trapped) / loaded``.
    """
    series = result.get("series") or {}
    summary = result.get("summary") or {}
    derived = _dig(result, "provenance.derived") or getattr(prep, "derived", None) or {}
    roles = derived.get("roles") or {}
    species = derived.get("species") or {}
    firing = series.get("firing") or []
    steps = _steps(series)
    doc = _document(result, prep, document)
    net = result.get("network") if isinstance(result.get("network"), Mapping) else None
    out: Dict[str, Any] = {}
    for side, short in (("oxidiser", "ox"), ("fuel", "fuel")):
        s = summary.get(short) or {}
        tank_kg, residual = _num(s.get("loaded_kg")), _num(s.get("residual_kg"))
        if tank_kg is None or residual is None:
            out[short] = {"available": False, "error": "the summary carries no tank inventory"}
            continue
        burned, how = None, ""
        if net is not None:
            injectors = [b for b in (net.get("branches") or {}).values()
                         if isinstance(b, Mapping) and b.get("kind") == "injector" and b.get("side") == short]
            if injectors:
                burned = sum(sum((_num(m) or 0.0) * h for m, h in zip(b.get("mdot") or [], steps)) for b in injectors)
                how = "the injector branches' flow in the network record, each step times its length"
        if burned is None:
            mdot = (series.get(short) or {}).get("mdot") or []
            burned = sum((_num(m) or 0.0) * h for m, h, f in zip(mdot, steps, firing) if f)
            how = "the chamber's flow on the firing steps, each step times its length (analysis.reduce_trace's rule)"
        lines: List[Dict[str, Any]] = []
        trapped: Optional[float] = None
        rho = None
        tank_id = roles.get(side)
        if doc is not None and tank_id:
            lines = feed_lines(doc, tank_id)
            vol = [ln["volume_m3"] for ln in lines]
            liquid_K = [_num(v) for v in ((series.get(short) or {}).get("liquid_K") or [])]
            T = next((v for v in reversed(liquid_K) if v is not None), None)
            sp = _species(species.get(side))
            if lines and None not in vol and T is not None and sp:
                try:
                    import CoolProp.CoolProp as CP

                    # On the saturation line at the liquid's temperature: how the twin prices its liquid
                    # (feedtwin vessels/tank.py liquid_density).
                    rho = float(CP.PropsSI("D", "T", T, "Q", 0, sp))
                    trapped = rho * sum(vol)  # type: ignore[arg-type]
                except Exception:  # noqa: BLE001 - outside CoolProp's range: reported without the lines
                    trapped = None
        loaded = tank_kg + (trapped or 0.0)
        err = loaded - burned - residual - (trapped or 0.0)
        # With the ullage carrying propellant vapour, liquid that evaporated left the tank without
        # passing the injector: it shows here as error, not as a leak.
        # What the burn ran: the feed twin's Setup (provenance.setup), or the run's override of it.
        vapour = bool(_dig(result, "provenance.setup.ullage_vapour") or _dig(result, "provenance.settings.ullage_vapour"))
        out[short] = {
            "available": True,
            "loaded_kg": loaded, "tank_loaded_kg": tank_kg, "burned_kg": burned, "residual_kg": residual,
            "trapped_kg": trapped, "error_kg": err, "error_pct": _pct(err, loaded),
            "liquid_density_kg_m3": rho,
            "lines": lines,
            "basis": (f"Burned: {how}. Loaded and residual: the tank's own inventory at T-0 and at the last step. "
                      "Trapped: the drawing's tank-to-engine line volumes (pi/4 d^2 L) full of saturated liquid at "
                      "the last recorded liquid temperature (CoolProp); valve bodies and the injector manifold are "
                      "not in the drawing and not counted. The twin's lines hold no liquid inventory, so the "
                      "trapped mass is the same at both ends and the error is tank against flow."
                      + ("" if trapped is not None else " Lines not counted: the drawing was not available or a line "
                                                        "has no length or bore.")
                      + (" Ullage vapour is on: propellant that evaporated into the ullage is in the error, not "
                         "lost." if vapour else "")),
            "includes_evaporation": vapour,
        }
    return out


# ---------------------------------------------------------------------- pressurant


def _ullage_masses(series: Mapping[str, Any], derived: Mapping[str, Any], gas: str,
                   i: int) -> Tuple[Optional[float], List[str]]:
    import CoolProp.CoolProp as CP

    roles = derived.get("roles") or {}
    volumes = derived.get("tank_volumes_L") or {}
    total = 0.0
    notes = []
    for side, short in (("oxidiser", "ox"), ("fuel", "fuel")):
        s = series.get(short) or {}
        v_L = _num(volumes.get(roles.get(side)))
        p = _num((s.get("tank_psia") or [None] * (i + 1))[i])
        T = _num((s.get("ullage_K") or [None] * (i + 1))[i])
        fill = _num((s.get("fill_fraction") or [None] * (i + 1))[i])
        if v_L is None or p is None or T is None or fill is None:
            notes.append(f"{short}: no tank volume, ullage pressure, temperature or fill recorded")
            return None, notes
        rho = float(CP.PropsSI("D", "P", p * PSI, "T", T, gas))
        total += rho * v_L * 1e-3 * max(1.0 - fill, 0.0)
    return total, notes


def _vented(result: Mapping[str, Any], steps: Sequence[float]) -> Tuple[Optional[float], Optional[float], str]:
    """Gas that left the network to the atmosphere [kg] and the enthalpy it carried [J], from the
    full network record: every gas branch whose downstream node is ambient (or a vent)."""
    net = result.get("network")
    if not isinstance(net, Mapping):
        return None, None, "no network record: vents taken as shut (the burn plan holds them shut)"
    nodes = net.get("nodes") or {}
    kg = 0.0
    found = []
    for bid, b in (net.get("branches") or {}).items():
        if not isinstance(b, Mapping) or b.get("side") not in ("gas", None):
            continue
        to = nodes.get(b.get("to")) or {}
        if str(to.get("kind") or "").lower() not in ("ambient", "vent"):
            continue
        kg += sum(max(_num(m) or 0.0, 0.0) * h for m, h in zip(b.get("mdot") or [], steps))
        found.append(str(bid))
    return kg, None, ("vented through " + ", ".join(found) if found else "no gas branch to atmosphere in the network")


def pressurant_balance(result: Mapping[str, Any], prep: Any = None) -> Dict[str, Any]:
    """``{bottle_out_kg, ullage_in_kg, vented_kg, error_pct, basis}`` over the recorded window."""
    series = result.get("series") or {}
    derived = _dig(result, "provenance.derived") or getattr(prep, "derived", None) or {}
    settings = _dig(result, "provenance.settings") or {}
    gas = _species(derived.get("pressurant_gas"))
    mass = [_num(v) for v in (series.get("copv_mass_kg") or [])]
    if not gas or len(mass) < 2 or mass[0] is None or mass[-1] is None:
        return {"available": False, "error": "no bottle mass or pressurant species recorded"}
    if settings.get("ullage_vapour"):
        return {"available": False,
                "error": "the ullage carries propellant vapour (ullage_vapour on): pricing it as pure pressurant "
                         "would book the vapour as a pressurant error"}
    m0, notes0 = _ullage_masses(series, derived, gas, 0)
    m1, notes1 = _ullage_masses(series, derived, gas, len(mass) - 1)
    if m0 is None or m1 is None:
        return {"available": False, "error": "; ".join(notes0 + notes1)}
    steps = _steps(series)
    vented, _h, vent_note = _vented(result, steps)
    bottle_out = mass[0] - mass[-1]
    gain = m1 - m0
    err = bottle_out - gain - (vented or 0.0)
    return {
        "available": True,
        "species": gas,
        "bottle_out_kg": bottle_out, "ullage_in_kg": gain, "vented_kg": vented,
        "ullage_t0_kg": m0, "ullage_end_kg": m1,
        "error_kg": err, "error_pct": _pct(err, bottle_out),
        "window_s": [series["t"][0], series["t"][-1]],
        "basis": ("Over the recorded window (lead-in and burn). Bottle: the twin's vessel mass. Ullages: re-priced "
                  "with CoolProp from the recorded ullage pressure and gas temperature over the drawing's tank volume "
                  "less the liquid's (1 - fill), pure pressurant. The network's lines hold no gas inventory. "
                  + vent_note + "."),
    }


# ---------------------------------------------------------------------- energy


def _bottle_wall(result: Mapping[str, Any], prep: Any, document: Optional[Mapping[str, Any]]) -> Tuple[Optional[float], str]:
    """Bottle wall heat capacity m*c [J/K] and where it came from: the drawing's own wall, else
    the twin's Setup default (``bottle_wall_kg_per_L`` times the bottle volume, at feedtwin's
    ``BOTTLE_WALL`` capacity)."""
    derived = _dig(result, "provenance.derived") or getattr(prep, "derived", None) or {}
    doc = _document(result, prep, document)
    bid = derived.get("copv_id")
    if doc is not None and bid:
        from feedtwin.model.param import to_si

        node = next((n for n in (doc.get("nodes") or []) if isinstance(n, Mapping) and n.get("id") == bid), None)
        params = _dig(node, "data.params") or {}
        m, c = params.get("wall_mass"), params.get("wall_capacity")
        if isinstance(m, Mapping) and isinstance(c, Mapping):
            try:
                return (float(to_si(float(m["value"]), str(m.get("unit") or "kg")))
                        * float(to_si(float(c["value"]), str(c.get("unit") or "J/(kg.K)"))),
                        f"the drawing's {bid} wall ({m.get('source') or 'no source'})")
            except Exception:  # noqa: BLE001 - fall through to the Setup default
                pass
    setup = _dig(result, "provenance.setup") or {}
    per_L, vol = _num(setup.get("bottle_wall_kg_per_L")), _num(derived.get("copv_volume_L"))
    if per_L is not None and vol is not None:
        try:
            from feedtwin.session.core import BOTTLE_WALL

            return per_L * vol * float(BOTTLE_WALL["capacity"]), "feed-twin's Setup default bottle wall (assumed)"
        except Exception:  # noqa: BLE001
            pass
    return None, "unknown"


def energy_balance(result: Mapping[str, Any], prep: Any = None,
                   document: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """The first law over the pressurant, over the recorded window.

    For the bottle, ``-dU_bottle + Q_bottle_wall`` is the enthalpy that left it. For the ullages,
    ``dU_ullage + W`` (``W = integral p dV`` on the liquid) is what arrived, less the heat the tank
    walls and the liquid surface gave the gas. Lines and regulators hold no gas and do no work
    (isenthalpic throttling). So the unclosed part,

        R = (-dU_bottle + Q_bottle_wall) - dU_ullage - W - H_vented,

    is minus the heat the tank walls, the liquid surface and (with ``line_walls``) the line walls put
    into the gas, plus integration error. **It closes** the bottle (its wall from the drawing or the
    Setup default, its gas priced with CoolProp at the recorded pressure and m/V), the ullages
    (CoolProp at the recorded p, T) and the boundary work (trapezoidal p dV). **It cannot** separate
    the tank-wall and interface heat from numerical error, because the series records neither the tank
    wall temperatures nor the interface: ``error_pct`` is therefore not a defect measure and the
    limits report it as information only. Vent enthalpy is not in the network record, so a run that
    vents carries that term in R too.
    """
    import CoolProp.CoolProp as CP

    series = result.get("series") or {}
    derived = _dig(result, "provenance.derived") or getattr(prep, "derived", None) or {}
    settings = _dig(result, "provenance.settings") or {}
    gas = _species(derived.get("pressurant_gas"))
    p_b = [_num(v) for v in (series.get("copv_psia") or [])]
    m_b = [_num(v) for v in (series.get("copv_mass_kg") or [])]
    wall = [_num(v) for v in (series.get("copv_wall_K") or [])]
    v_b = _num(derived.get("copv_volume_L"))
    if not gas or v_b is None or len(p_b) < 2 or None in (p_b[0], p_b[-1], m_b[0], m_b[-1]):
        return {"available": False, "error": "no bottle pressure, mass, volume or pressurant recorded"}
    if settings.get("ullage_vapour"):
        return {"available": False, "error": "the ullage carries propellant vapour (ullage_vapour on)"}
    V = v_b * 1e-3

    def u_bottle(i: int) -> float:
        return m_b[i] * float(CP.PropsSI("U", "P", p_b[i] * PSI, "D", m_b[i] / V, gas))  # type: ignore[operator]

    du_b = u_bottle(len(p_b) - 1) - u_bottle(0)
    mc, wall_src = _bottle_wall(result, prep, document)
    q_bw = -mc * (wall[-1] - wall[0]) if mc is not None and wall and wall[0] is not None and wall[-1] is not None else None

    roles = derived.get("roles") or {}
    volumes = derived.get("tank_volumes_L") or {}
    du_u = 0.0
    work = 0.0
    for side, short in (("oxidiser", "ox"), ("fuel", "fuel")):
        s = series.get(short) or {}
        v_L = _num(volumes.get(roles.get(side)))
        p = [_num(v) for v in (s.get("tank_psia") or [])]
        T = [_num(v) for v in (s.get("ullage_K") or [])]
        fill = [_num(v) for v in (s.get("fill_fraction") or [])]
        if v_L is None or not p or None in (p[0], p[-1], T[0], T[-1], fill[0], fill[-1]):
            return {"available": False, "error": f"{short}: no tank volume or ullage state recorded"}
        vol = [v_L * 1e-3 * max(1.0 - f, 0.0) if f is not None else None for f in fill]

        def u_ullage(i: int) -> float:
            rho = float(CP.PropsSI("D", "P", p[i] * PSI, "T", T[i], gas))  # type: ignore[operator]
            return rho * vol[i] * float(CP.PropsSI("U", "P", p[i] * PSI, "T", T[i], gas))  # type: ignore[operator]

        du_u += u_ullage(len(p) - 1) - u_ullage(0)
        for i in range(1, len(p)):
            if None in (p[i], p[i - 1], vol[i], vol[i - 1]):
                continue
            work += 0.5 * (p[i] + p[i - 1]) * PSI * (vol[i] - vol[i - 1])  # type: ignore[operator]
    out_of_bottle = -du_b + (q_bw or 0.0)
    unclosed = out_of_bottle - du_u - work
    return {
        "available": True,
        "bottle_dU_J": du_b, "bottle_wall_heat_J": q_bw, "bottle_wall_basis": wall_src,
        "ullage_dU_J": du_u, "boundary_work_J": work, "vented_enthalpy_J": None,
        "unclosed_J": unclosed,
        # Internal energies carry CoolProp's arbitrary reference state, which cancels in R only because
        # the gas mass is conserved; a percentage of them would move with that reference. The work the
        # gas did on the liquid is reference-free, so R is stated against it.
        "error_pct": _pct(unclosed, work),
        "basis": ("First law over the pressurant, recorded window: R = (-dU_bottle + Q_bottle_wall) - dU_ullages - "
                  "integral p dV, CoolProp internal energies at the recorded states, in percent of the expulsion "
                  "work integral p dV. R is minus the heat the tank walls, the liquid surface and the line walls "
                  "gave the gas, plus integration error, which the series cannot separate (tank-wall and interface "
                  "temperatures are not recorded): not a defect measure. Bottle wall: " + wall_src + "."),
    }


# ---------------------------------------------------------------------- convergence


def convergence(result: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """Per outer pass: the throat schedule's and the flight acceleration's change against their
    tolerances (``replay.THROAT_TOLERANCE``, ``flight.ACCEL_TOLERANCE``)."""
    try:
        from engine.layerx.flight import ACCEL_TOLERANCE
        from engine.layerx.replay import THROAT_TOLERANCE
    except Exception:  # noqa: BLE001 - a result read without the solver still lists its passes
        THROAT_TOLERANCE, ACCEL_TOLERANCE = None, None  # type: ignore[assignment]
    out = []
    for p in result.get("passes") or []:
        if not isinstance(p, Mapping):
            continue
        agree = _dig(p, "agreement.worst") or {}
        out.append({
            "pass": p.get("pass"),
            "throat_residual": _num(p.get("schedule_change")),
            "throat_tolerance": THROAT_TOLERANCE,
            "accel_residual": _num(p.get("accel_change")),
            "accel_tolerance": ACCEL_TOLERANCE if p.get("accel_change") is not None else None,
            "throat_applied": p.get("throat_applied"), "accel_applied": p.get("accel_applied"),
            "burn_time_s": _num(p.get("burn_time_s")),
            "agreement_worst": max((abs(_num(v) or 0.0) for v in agree.values()), default=None) if agree else None,
        })
    return out


# ---------------------------------------------------------------------- the block


def check(result: Mapping[str, Any], prep: Any = None, *,
          document: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """The ``diagnostics.vv`` block. Each part that cannot be computed says why; nothing raises.

    ``prep`` (a Prepared) and ``document`` (the drawing's ``{nodes, edges}``) are optional: the
    result's own provenance names the drawing, and a shipped one is found by id.
    """
    out: Dict[str, Any] = {}
    for key, fn in (("mass", lambda: mass_balance(result, prep, document)),
                    ("pressurant", lambda: pressurant_balance(result, prep)),
                    ("energy", lambda: energy_balance(result, prep, document)),
                    ("convergence", lambda: convergence(result))):
        try:
            out[key] = fn()
        except Exception as exc:  # noqa: BLE001 - DATA-CONTRACT: a failed block never fails the run
            out[key] = {"available": False, "error": f"{type(exc).__name__}: {exc}"}
    out["model"] = {
        "name": "layerx_vv_balances",
        "source": ("Control-volume mass conservation and the first law for an open system (Moran & Shapiro, "
                   "Fundamentals of Engineering Thermodynamics, ch. 4); CoolProp 6+ (Bell et al., Ind. Eng. Chem. "
                   "Res. 53(6), 2014) for the gas and liquid properties"),
        "assumptions": [
            "the twin's lines and regulators hold no gas or liquid inventory (an algebraic network)",
            "the ullage is pure pressurant (checked: the balance is skipped when ullage_vapour is on)",
            "trapped liquid fills the drawing's tank-to-engine lines at the saturated density of the last recorded "
            "liquid temperature; valve bodies and the injector manifold are not counted",
            "vented gas is read from the network record when present; otherwise the vents are shut",
        ],
        "inputs": {
            "tank_volumes_L": {"value": _dig(result, "provenance.derived.tank_volumes_L"), "unit": "L",
                               "provenance": "drawing"},
            "copv_volume_L": {"value": _dig(result, "provenance.derived.copv_volume_L"), "unit": "L",
                              "provenance": "drawing"},
            "pressurant_gas": {"value": _dig(result, "provenance.derived.pressurant_gas"), "unit": "",
                               "provenance": "drawing"},
        },
    }
    return out
