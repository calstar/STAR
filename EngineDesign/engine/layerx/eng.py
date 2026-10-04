"""A Layer X burn as a RASP ``.eng`` thrust curve, for OpenRocket.

The curve is the run's hand-off (``result["timeseries"]``): the thrust the flight in this run flew,
from Fire to the moment the first tank ran dry. RASP's layout::

    ; comments
    NAME  DIAMETER_mm  LENGTH_mm  DELAYS  PROPELLANT_kg  TOTAL_kg  MANUFACTURER
    time_s  thrust_N
    ...

OpenRocket starts every curve from (0, 0) and needs it to end on zero thrust. The model's thrust
is on at Fire, so the first point sits ``EDGE_S`` after it and a zero point ``EDGE_S`` after the
last: the two ramps cost and add back half an edge of thrust each, and the file states its own
impulse against the run's.

Mass, as OpenRocket uses it: it removes the propellant mass in proportion to the impulse delivered.
``PROPELLANT_kg`` is what the burn consumed; ``TOTAL_kg`` adds the engine's dry mass
(``rocket.engine_mass``). Tanks, pressurant, bottle and unburned residual are not in it: in an
OpenRocket model of a liquid vehicle they are airframe components.
"""

from __future__ import annotations

import math
import re
import time
from typing import Any, Dict, List, Optional, Tuple

#: Time from Fire to the first point, and from the last point to zero thrust [s].
EDGE_S = 0.001


def motor_header(config: Any) -> Dict[str, Any]:
    """Diameter, length and dry mass of the engine for the ``.eng`` header, each with its basis."""
    from engine.optimizer.layers.layer1_static_optimization import (
        _layer1_bell_length_m,
        _layer1_chamber_lengths,
        _layer1_contraction_theta,
    )

    out: Dict[str, Any] = {"diameter_mm": None, "length_mm": None, "dry_kg": None, "basis": {}}
    cg = getattr(config, "chamber_geometry", None)
    req = getattr(config, "design_requirements", None)
    ab = getattr(config, "ablative_cooling", None)
    if cg is not None and getattr(cg, "chamber_diameter", None):
        bore = float(cg.chamber_diameter)
        liner = float(ab.initial_thickness) if ab is not None and ab.enabled else 0.0
        metal = float(getattr(req, "metal_wall_thickness_per_side_m", None) or 0.0) if req is not None else 0.0
        out["diameter_mm"] = (bore + 2.0 * (liner + metal)) * 1e3
        out["basis"]["diameter"] = "chamber bore + liner + metal wall, both sides"
        body = getattr(getattr(config, "rocket", None), "radius", None)
        if body and out["diameter_mm"] > 2.0 * float(body) * 1e3:
            # OpenRocket refuses a motor wider than its mount; the chamber sits in the boat tail or
            # proud of the body, which is the airframe's business, not the motor file's.
            out["chamber_od_mm"] = out["diameter_mm"]
            out["diameter_mm"] = 2.0 * float(body) * 1e3
            out["basis"]["diameter"] = (f"the airframe's {out['diameter_mm']:.1f} mm body (rocket.radius): the chamber's "
                                        f"{out['chamber_od_mm']:.1f} mm OD is wider than any motor mount OpenRocket "
                                        "will accept")
        if getattr(cg, "A_throat", None) and getattr(cg, "Lstar", None) and getattr(cg, "expansion_ratio", None):
            lens = _layer1_chamber_lengths(float(cg.A_throat), float(cg.Lstar), bore, _layer1_contraction_theta(req))
            length = lens["face_to_throat"] + _layer1_bell_length_m(float(cg.A_throat), float(cg.expansion_ratio))
            out["length_mm"] = length * 1e3
            out["basis"]["length"] = "injector face to nozzle exit (80 % bell), as Layer 1 measures it"
    rocket = getattr(config, "rocket", None)
    if rocket is not None and getattr(rocket, "engine_mass", None):
        out["dry_kg"] = float(rocket.engine_mass)
        out["basis"]["dry_mass"] = "rocket.engine_mass"
    return out


def _token(text: str) -> str:
    """A RASP header field: no whitespace."""
    return re.sub(r"\s+", "-", text.strip()) or "-"


def curve(result: Dict[str, Any]) -> Tuple[List[float], List[float]]:
    """(time from Fire [s], thrust [N]) of the run's hand-off curve."""
    ts = result.get("timeseries") or {}
    data = ts.get("data") or {}
    t_raw, f_raw = data.get("time") or [], data.get("thrust_kN") or []
    if len(t_raw) < 2 or len(t_raw) != len(f_raw):
        raise ValueError("the run has no thrust curve")
    if any(v is None or not math.isfinite(float(v)) for v in list(t_raw) + list(f_raw)):
        raise ValueError("the run's thrust curve has missing samples; run the burn again")
    t = [float(v) for v in t_raw]
    f = [float(v) * 1e3 for v in f_raw]
    t0 = t[0]
    return [v - t0 for v in t], f


def _trapz(t: List[float], f: List[float]) -> float:
    return sum(0.5 * (f[i] + f[i + 1]) * (t[i + 1] - t[i]) for i in range(len(t) - 1))


def to_eng(
    result: Dict[str, Any],
    *,
    run_id: str = "",
    name: Optional[str] = None,
    diameter_mm: Optional[float] = None,
    length_mm: Optional[float] = None,
    dry_kg: Optional[float] = None,
    manufacturer: str = "STAR",
    note: Optional[str] = None,
) -> str:
    """The ``.eng`` text. Header values not given come from ``result["motor"]``."""
    t, f = curve(result)
    motor = result.get("motor") or {}
    dia = diameter_mm if diameter_mm is not None else motor.get("diameter_mm")
    length = length_mm if length_mm is not None else motor.get("length_mm")
    dry = dry_kg if dry_kg is not None else motor.get("dry_kg")
    missing = [k for k, v in (("diameter", dia), ("length", length)) if v is None]
    if missing:
        raise ValueError(f"This run did not record the engine {' or '.join(missing)}: run the burn again, "
                         "or give diameter_mm and length_mm.")
    summ = (result.get("timeseries") or {}).get("summary") or {}
    prop = float(summ.get("lox_propellant_kg") or 0.0) + float(summ.get("fuel_propellant_kg") or 0.0)
    if not prop > 0.0:
        raise ValueError("the run reports no propellant consumed")
    total = prop + float(dry or 0.0)
    mean = _trapz(t, f) / t[-1] if t[-1] > 0 else 0.0
    name = _token(name or f"STAR-{round(mean)}N")

    # Only the first point moves: the ramp in loses half an edge of the first step's thrust and
    # the ramp out adds half an edge of the last's, so the file keeps the run's impulse.
    pts_t = [EDGE_S] + t[1:] + [t[-1] + EDGE_S]
    pts_f = [f[0]] + f[1:] + [0.0]
    written = _trapz([0.0] + pts_t, [0.0] + pts_f)
    run_impulse = _trapz(t, f)

    prov = result.get("provenance") or {}
    settings = prov.get("settings") or {}
    derived = prov.get("derived") or {}
    flown = bool((result.get("flight") or {}).get("ok"))
    basis = motor.get("basis") or {}
    lines = [
        f"; {name}: Layer X burn{f' {run_id}' if run_id else ''}, exported {time.strftime('%Y-%m-%d %H:%M')}",
        f"; drawing {((prov.get('drawing') or {}).get('name')) or '-'}, tanks "
        f"{derived.get('target_lockup_psia') or settings.get('tank_pressure_psia') or '-'} psia, bottle "
        f"{derived.get('copv_psig') or settings.get('copv_pressure_psig') or '-'} psig, "
        f"{'as flown (acceleration on the feed)' if flown else 'on the pad'}",
        f"; burn {t[-1]:.3f} s, total impulse {run_impulse:.1f} N-s (this file {written:.1f} N-s), "
        f"mean thrust {mean:.1f} N",
        f"; propellant {prop:.4f} kg consumed; total adds engine dry mass {float(dry or 0.0):.4f} kg"
        f" ({basis.get('dry_mass', 'given') if dry is not None else 'none given'}). Tanks, pressurant and residual "
        "are not included.",
        f"; diameter: {basis.get('diameter', 'given') if diameter_mm is None else 'given'}; "
        f"length: {basis.get('length', 'given') if length_mm is None else 'given'}",
        "; OpenRocket burns this propellant mass at the motor; a liquid vehicle carries it in its tanks. Put the "
        "tanks' propellant in as mass components and read the CG and stability margin from those, not from this motor.",
    ]
    if note:
        lines.append(f"; {note}")
    lines.append(f"{name} {float(dia):.1f} {float(length):.1f} P {prop:.4f} {total:.4f} {_token(manufacturer)}")
    lines += [f"   {a:.4f} {b:.2f}" for a, b in zip(pts_t, pts_f)]
    lines.append(";")
    return "\n".join(lines) + "\n"


def filename(result: Dict[str, Any], run_id: str = "") -> str:
    t, f = curve(result)
    mean = _trapz(t, f) / t[-1] if t[-1] > 0 else 0.0
    stamp = run_id or time.strftime("%Y%m%d-%H%M%S")
    return f"STAR-{round(mean)}N-{stamp}.eng"


def check(text: str) -> Dict[str, Any]:
    """Parse ``text`` the way a RASP reader does: header fields, points, impulse. For tests."""
    rows = [ln.split(";")[0].strip() for ln in text.splitlines()]
    rows = [r for r in rows if r]
    head = rows[0].split()
    pts = [tuple(float(x) for x in r.split()) for r in rows[1:]]
    ts = [0.0] + [p[0] for p in pts]
    fs = [0.0] + [p[1] for p in pts]
    return {
        "name": head[0], "diameter_mm": float(head[1]), "length_mm": float(head[2]), "delays": head[3],
        "propellant_kg": float(head[4]), "total_kg": float(head[5]), "manufacturer": head[6],
        "time": ts, "thrust": fs, "impulse": _trapz(ts, fs),
        "increasing": all(b > a for a, b in zip(ts, ts[1:])) and not math.isnan(sum(ts)),
    }
