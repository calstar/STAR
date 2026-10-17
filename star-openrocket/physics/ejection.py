"""Separation joints: shear pins, ejection charge, and avionics-bay vent holes.

Replaces the mastersheets' `4) Ejection Charges & Shear Pin` and `5) Vent Hole
Sizing` tabs (reference/mastersheets/). Those worked backwards -- pressure in,
"how many pins would this shear" out, rounded to the *nearest* pin -- and never
asked what the pins have to hold. This module sizes a joint the other way round:

  1. Hold.   The pins must survive every load that tries to open the joint
             before its charge fires, with `sf_hold` margin, at the pins'
             *weakest*:  N = ceil(sf_hold * F_hold / F_pin_min).
  2. Break.  The charge must shear those N pins at their *strongest*, with
             `sf_eject` margin:  P = sf_eject * N * F_pin_max / A.
  3. Charge. Black powder for that pressure in the bay's free volume, by the
             ideal gas law on the combustion products:  m = P V / (R T).

The loads that try to open a joint (each reported, the largest governs):

  - Drag separation at burnout. Thrust stops at peak drag; each part of the
    vehicle then decelerates at its own drag over its own mass, and the
    forward part -- streamlined, heavy for its drag -- wants to coast ahead.
    The pins hold it to the vehicle's deceleration:
        F = m_fwd * D_burnout / m_burnout
    which takes the forward part's own drag as zero (conservative).
  - Trapped pressure. A sealed bay keeps pad pressure while the air outside
    thins; the difference pushes on the bulkhead. Worst at apogee, and every
    joint has to hold it until its own charge fires, so it is evaluated at
    apogee for all of them:  F = (p_pad - p(h_apogee)) * A.
  - Drogue opening, main joint only, and only for dual separation (drogue and
    main out of separate joints). The drogue's opening force decelerates
    everything hanging from it; the part forward of the main joint (nose cone
    and main canopy) tries to keep going:
        F = m_fwd * F_drogue / m_descending.
    With single separation (cable cutter / Tender Descender) the main joint
    never sees it.

Stdlib only: scalar arithmetic, no pydantic (see test_imports).
"""

import math
from dataclasses import dataclass, field
from typing import List, Optional

from physics.constants import IN_TO_M, LB_TO_KG, LBF_TO_N

FT_LBF_TO_J = 0.3048 * LBF_TO_N
RANKINE_TO_K = 5.0 / 9.0

# Black powder combustion products (FFFFg). The values every hobby ejection
# calculator uses, from the ideal-gas sizing in Wikipedia's "Ejection charge"
# and Nakka's Appendix E: R = 22.16 ft-lbf/(lbm R), T = 3307 R. Checked against
# the mastersheets' grams to within 2% (tests/recovery/test_ejection.py).
BP_R = 22.16 * FT_LBF_TO_J / LB_TO_KG / RANKINE_TO_K   # J/(kg K), ~119.2
BP_T = 3307.0 * RANKINE_TO_K                            # K, ~1837
BP_SOURCE = ("ideal gas on combustion products, R = 22.16 ft-lbf/(lbm R), "
             "T = 3307 R for FFFFg (Wikipedia 'Ejection charge'; Nakka "
             "Appendix E)")

# Vent holes: VernK's altimeter port rule, as rocketrycalculator.com and the
# FreeCAD Rocket Vent Hole Size Calculator implement it. One 1/4 in hole per
# 100 in^3 of bay, scaled by volume and split over N holes:
#     d = ID * sqrt((A_ref / V_ref) * (L / N))
# A rule of thumb that altimeter makers' charts agree with, not physics.
#
# The mastersheet's `0.004396` is sqrt(A_ref/V_ref) in *millimetres*, applied
# to centimetre inputs: its holes are sqrt(10) = 3.16x too small. Kept in SI
# here so the units cannot be mixed again.
VENT_A_REF = math.pi / 4.0 * (0.25 * IN_TO_M) ** 2   # m^2, one 1/4 in hole
VENT_V_REF = 100.0 * IN_TO_M ** 3                     # m^3, per 100 in^3
VENT_SOURCE = ("VernK altimeter port sizing: one 1/4 in hole per 100 in^3 "
               "(rocketrycalculator.com test-vent-port; FreeCAD Rocket Vent "
               "Hole Size Calculator)")

# Above this the charge is worth a second look at the bulkheads and the
# airframe, not just the pins. A common hobby ceiling for ejection pressure.
P_EJECT_WARN = 25.0 * LBF_TO_N / IN_TO_M ** 2   # 25 psi in Pa


@dataclass(frozen=True)
class PinSpec:
    key: str
    label: str
    F_min: float    # N, the weakest a pin of this kind shears at
    F_max: float    # N, the strongest
    source: str


def _lbf(x):
    return x * LBF_TO_N


# Nylon shear pins. Published numbers scatter widely (manufacturer spec vs
# measured, single vs double shear, batch to batch), so the range is taken
# wide on purpose: the low end sizes the hold, the high end sizes the charge.
# The team's own shear test should replace these; every joint can override.
PIN_CATALOG = {
    p.key: p for p in (
        PinSpec("2-56", "2-56 nylon", _lbf(18.0), _lbf(33.0),
                "Rocketry Forum measurements: 18 lbf average (19 spec), "
                "~33 lbf single pin in another test"),
        PinSpec("4-40", "4-40 nylon", _lbf(38.0), _lbf(56.0),
                "38-40 lbf aircraft-grade rating; 56 lbf measured "
                "(Rocketry Forum)"),
        PinSpec("6-32", "6-32 nylon", _lbf(69.0), _lbf(116.0),
                "69 lbf manufacturer spec, 116 lbf measured (Rocketry "
                "Forum); the mastersheets used 75-114 lbf"),
    )
}


@dataclass
class Joint:
    name: str
    role: str                 # "drogue" | "main" | "other"
    bay_id: float             # m, inner diameter the charge pushes on
    bay_length: float         # m, free length the charge pressurises
    m_forward: float          # kg, everything forward of this joint


@dataclass
class Vehicle:
    m_burnout: float          # kg, whole vehicle at burnout
    D_burnout: float          # N, whole-vehicle drag at burnout
    m_descending: float       # kg, mass hanging from the drogue
    p_pad: float              # Pa, pad station pressure (sealed bay)
    p_apogee: float           # Pa, ambient at apogee


@dataclass
class Settings:
    sf_hold: float = 2.0
    sf_eject: float = 1.5
    trapped_pressure: bool = True
    dual_separation: bool = True


@dataclass
class PinOption:
    """One pin size, sized for one joint."""
    key: str
    label: str
    n_pins: int               # fewest that hold, at the pins' weakest
    hold_margin: Optional[float]   # n * F_min / F_hold; None if F_hold = 0
    P_eject: float            # Pa, shears n at their strongest with margin
    F_eject: float            # N on the bulkhead
    m_bp: float               # kg of black powder
    high_pressure: bool       # P_eject above P_EJECT_WARN


@dataclass
class JointResult:
    name: str
    role: str
    area: float               # m^2
    volume: float             # m^3
    F_drag: float             # N
    F_trapped: float          # N (0 when the box is off)
    F_drogue: float           # N (0 unless main joint + dual separation)
    F_hold: float             # N, the largest
    governing: str            # "drag" | "trapped" | "drogue" | "none"
    options: List[PinOption] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


def area(d):
    return math.pi / 4.0 * d * d


def bp_mass(P, V):
    """Black powder for gauge pressure P (Pa) in free volume V (m^3), kg."""
    return P * V / (BP_R * BP_T)


def pins_required(F_hold, F_pin_min, sf_hold):
    """Fewest pins that hold `F_hold` with margin, at their weakest. Rounds UP:
    the mastersheet's round-to-nearest claimed 4 pins hold 282 lbf when four
    take 300 lbf. At least one pin, since a joint with none is not a joint."""
    if F_pin_min <= 0.0:
        raise ValueError("pin strength must be positive")
    # The epsilon keeps an exact multiple (2 * 150 / 75) from rounding to 5.
    return max(1, math.ceil(sf_hold * F_hold / F_pin_min - 1e-9))


def size_pin(pin, F_hold, A, V, settings):
    """How many of `pin` the joint needs, and the charge that shears them."""
    if pin.F_min > pin.F_max:
        raise ValueError("%s: minimum strength exceeds its maximum" % pin.label)
    n = pins_required(F_hold, pin.F_min, settings.sf_hold)
    P = settings.sf_eject * n * pin.F_max / A
    return PinOption(
        key=pin.key, label=pin.label, n_pins=n,
        hold_margin=(n * pin.F_min / F_hold) if F_hold > 0.0 else None,
        P_eject=P, F_eject=P * A, m_bp=bp_mass(P, V),
        high_pressure=P > P_EJECT_WARN,
    )


def size_joint(joint, vehicle, settings, F_drogue_open=None,
               pins=tuple(PIN_CATALOG.values())):
    """Size one joint for every pin in `pins`. `F_drogue_open` is the drogue's
    peak opening force, N, or None when the configuration has no drogue."""
    A = area(joint.bay_id)
    V = A * joint.bay_length
    warnings = []

    F_drag = 0.0
    if vehicle.m_burnout > 0.0:
        F_drag = joint.m_forward * vehicle.D_burnout / vehicle.m_burnout

    F_trapped = 0.0
    if settings.trapped_pressure:
        F_trapped = max(0.0, vehicle.p_pad - vehicle.p_apogee) * A

    F_drogue = 0.0
    if joint.role == "main" and settings.dual_separation:
        if F_drogue_open is None:
            warnings.append("Dual separation is on but the configuration has "
                            "no drogue, so no drogue opening load was applied.")
        elif vehicle.m_descending > 0.0:
            F_drogue = joint.m_forward * F_drogue_open / vehicle.m_descending

    loads = {"drag": F_drag, "trapped": F_trapped, "drogue": F_drogue}
    governing = max(loads, key=loads.get)
    F_hold = loads[governing]
    if F_hold <= 0.0:
        governing = "none"

    return JointResult(
        name=joint.name, role=joint.role, area=A, volume=V,
        F_drag=F_drag, F_trapped=F_trapped, F_drogue=F_drogue,
        F_hold=F_hold, governing=governing,
        options=[size_pin(p, F_hold, A, V, settings) for p in pins],
        warnings=warnings,
    )


@dataclass
class VentResult:
    d: float                  # m, each hole
    d_64ths: int              # nearest 64th of an inch, at least 1
    volume: float             # m^3


def vent_hole(bay_id, bay_length, n_holes):
    """Diameter of each of `n_holes` static ports in an avionics bay."""
    if n_holes < 1:
        raise ValueError("need at least one vent hole")
    d = bay_id * math.sqrt(VENT_A_REF / VENT_V_REF * bay_length / n_holes)
    return VentResult(d=d, d_64ths=max(1, round(d / IN_TO_M * 64.0)),
                      volume=area(bay_id) * bay_length)

