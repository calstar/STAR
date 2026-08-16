"""Device state, drag-area growth, and the device table. PLAN.md §6, §4.1.

The important thing in this module is `DeviceState`, which encodes the §6.1.4
distinction between three instants that are easy to conflate:

    t_x                      t_d = t_x + delay          t_d + t_f
     |                        |                          |
     |  charge fires          |  LINE STRETCH            |  full inflation
     |  (altimeter closes)    |  tau = 0, CdS = 0        |  tau = 1, CdS = full
     |                        |                          |
     +-- still falling on airframe drag alone -----------+
         CdS_i = 0 the whole way

v_s is sampled at LINE STRETCH, never at the trigger. Sampling at t_x drops the
entire §6.1.3 effect -- up to 55% low on a bagged drogue -- and does it
silently, because A is independent of v_s at fixed s_f (eq 44) so nothing looks
inconsistent and even the eq (48) cross-check still passes.
"""

import csv
import math
import os

from physics.constants import (
    G_TO_KG,
    IN_TO_M,
    SQFT_TO_SQM,
)

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


class DeviceState:
    """Mutable per-device state for one run. See the module docstring.

    A device moves through exactly three phases:

        pending    -> t_x is None
        triggered  -> t_x set, t_f still None  (charge fired, canopy stowed)
        stretched  -> t_f set                  (inflating, then inflated)

    `CdS_of` returns 0 in the first two. That middle phase is real -- the
    reference implementation for this model crashed on exactly it, because
    t_d was set at the trigger while t_f was not yet defined.
    """

    __slots__ = ("t_x", "t_d", "v_s", "rho_s", "z_d", "t_f")

    def __init__(self):
        self.t_x = None  # trigger time
        self.t_d = None  # scheduled line-stretch time
        self.v_s = None  # frozen freestream speed at line stretch, eq (9a)
        self.rho_s = None  # density at line stretch, for eq (22)
        self.z_d = None  # altitude at line stretch
        self.t_f = None  # filling time, eq (10)

    @property
    def triggered(self):
        return self.t_x is not None

    @property
    def stretched(self):
        return self.t_f is not None

    @property
    def pending(self):
        return self.t_x is None

    def fire(self, t, delay):
        """The charge goes off. Schedules line stretch; does NOT deploy."""
        self.t_x = t
        self.t_d = t + delay

    def stretch(self, t, z, v, device, atm, site_elev, s_h=0.0):
        """Line stretch. The only place v_s is defined, per eq (9a).

        `v` is the vertical speed and `s_h` the horizontal AIR-RELATIVE speed at
        the event; the deployment airspeed the loads see is the resultant
        `|v_rel| = hypot(v, s_h)`. `s_h` defaults to 0 (the 1-D windless case), so
        a drogue at apogee with no sideways speed keeps its old `v_s = |v|`. A
        sideways velocity also lifts a would-be zero-speed apogee deploy off the
        floor below.
        """
        self.t_d = t
        self.z_d = z
        self.v_s = (v * v + s_h * s_h) ** 0.5
        if self.v_s <= 0.0:
            raise ValueError(
                "device %r reached line stretch at zero speed, so eq (10) "
                "divides by zero and eq (23) returns a bound of zero for a "
                "load that is not zero. A trigger at exactly apogee with "
                "v0 = 0 does this -- give it the real apogee-detect lag "
                "instead." % device.name
            )
        self.rho_s = atm.rho(z)
        self.t_f = device.s_f / self.v_s  # eqs (9), (10)

    def tau(self, t):
        """Eq (11). Normalised inflation progress. None before line stretch."""
        if not self.stretched:
            return None
        return (t - self.t_d) / self.t_f


def CdS_of(device, state, t):
    """Eq (12). Drag area of one device at time t.

    Returns 0 for a device that has triggered but not yet stretched -- the
    canopy is still stowed and contributes nothing. Physically the bag and
    pilot chute are already out and pulling, so the real vehicle is slightly
    slower than modelled and the modelled v_s is slightly high. Conservative,
    and left alone in Phase 1 (§6.1.4).
    """
    if not state.stretched or t < state.t_d:
        return 0.0
    tau = (t - state.t_d) / state.t_f
    if tau >= 1.0:
        return device.CdS
    return device.CdS * tau ** device.j


def CdS_total(devices, states, t, CdS_body):
    """Eq (13). Airframe plus every device.

    The airframe term is the point: OpenRocket's `computeCD` iterates only
    deployed recovery devices, so the body contributes nothing after
    deployment. That is a real error during drogue descent, where the airframe
    can dominate the descent rate.
    """
    total = CdS_body
    for d, s in zip(devices, states):
        total += CdS_of(d, s, t)
    return total


def airframe_band(d_body, l_body):
    """Eqs (14)/(15). The axial/broadside bounds, m^2.

    Attitude under canopy is not known and the two differ by 2.55 * l/d -- 36x
    at a fineness of 14. PLAN.md §6.4 is explicit: run both, do not pick one.
    Under a main this is noise; under a drogue it can dominate descent rate,
    and before any deployment it is worth a factor of two in opening load.
    """
    axial = 0.6 * math.pi * d_body ** 2 / 4.0
    broadside = 1.2 * l_body * d_body
    return axial, broadside


# --- device table, PLAN.md §4.1 -------------------------------------------


class CatalogueEntry:
    """One row of parachutes.csv, converted to SI on read."""

    __slots__ = ("sku", "manufacturer", "model", "canopy_style", "style",
                 "CdS", "D0", "m_c", "j", "rating_20fps_kg", "row")

    def __init__(self, row):
        self.row = row
        self.sku = row["sku"]
        self.manufacturer = row.get("manufacturer") or ""
        self.model = row.get("model") or ""
        self.canopy_style = (row.get("canopy_style") or "").lower()
        self.style = row.get("style") or ""

        # (A1) Drag area. Take cd_projected * area_projected as shipped.
        #
        # Do NOT recompute S_p as pi*D^2/4. Fruity Chutes' area_projected
        # EXCLUDES the spill hole -- the opposite of the Knacke convention,
        # where reference areas include openings. For the IFC-48,
        # pi*D^2/4 = 12.5664 sq ft but area_projected = 12.1771, the difference
        # being exactly the 8.448 in vent. Pairing their Cd with your own
        # pi*D^2/4 overstates CdS by 3.2%, silently, and F is proportional to
        # CdS in eq (23).
        self.CdS = _f(row["cd_projected"]) * _f(row["area_projected_sqft"]) * SQFT_TO_SQM

        # (A2) Nominal diameter, from the flat/equivalent diameter.
        self.D0 = _f(row["equivalent_flat_diameter_in"]) * IN_TO_M

        # (A3) Canopy mass.
        self.m_c = _f(row["weight_g"]) * G_TO_KG

        # Growth exponent from canopy style: annular and elliptical are solid
        # cloth, so j = 2. Slotted types would take j = 1.
        self.j = 1 if "slot" in self.canopy_style else 2

        r20 = _f(row.get("rating_20fps_lb"))
        self.rating_20fps_kg = r20 * 0.45359237 if r20 is not None else None

    def __repr__(self):
        return "CatalogueEntry(%s, CdS=%.4f m2, D0=%.3f m, m_c=%.3f kg)" % (
            self.sku, self.CdS, self.D0, self.m_c)


def _f(value):
    if value is None or value == "":
        return None
    return float(value)


# The two rows Fruity Chutes ships with an inconsistent cd_area_canopy: both
# -S variants carry 0.8000 where their own geometry requires 0.8427 (the value
# their non-S siblings use). This does NOT affect any drag area computed here,
# because eq (A1) reads the *projected* pair, not the canopy pair. Listed so a
# NEW inconsistency still fails rather than being lost in a known-noisy check.
KNOWN_A4_EXCEPTIONS = frozenset({"CFC-30-S", "CFC-36-S"})


def check_row(row):
    """Eqs (A4)-(A6). Returns a list of complaints for one CSV row.

    These validate that a record parsed correctly, which matters because a
    silently mis-parsed Cd or area becomes a wrong opening load with nothing
    to flag it.
    """
    problems = []
    cd_p = _f(row.get("cd_projected"))
    area_p = _f(row.get("area_projected_sqft"))
    cd_c = _f(row.get("cd_area_canopy"))
    area_c = _f(row.get("area_canopy_sqft"))
    d_flat = _f(row.get("equivalent_flat_diameter_in"))
    r15 = _f(row.get("rating_15fps_lb"))
    r20 = _f(row.get("rating_20fps_lb"))

    def rel(a, b):
        return abs(a - b) / abs(b) if b else float("inf")

    if None not in (cd_p, area_p, cd_c, area_c):
        if rel(cd_p * area_p, cd_c * area_c) > 0.01:
            problems.append("A4: projected and canopy drag areas disagree")
    if None not in (d_flat, area_c) and area_c > 0:
        want = math.sqrt(4 * area_c / math.pi) * 12.0
        if rel(d_flat, want) > 0.01:
            problems.append("A5: flat diameter is not the equal-area circle")
    if None not in (r15, r20) and r20:
        if rel(r15 / r20, 0.5625) > 0.01:
            problems.append("A6: ratings do not scale as v^2")
    return problems


def load_catalogue(path=None, strict=True):
    """Read the device table, converting to SI and asserting (A4)-(A6).

    A malformed scrape must fail loudly rather than yield a silently wrong
    CdS, so validation happens on read (§11.2).
    """
    if path is None:
        path = os.path.join(DATA_DIR, "parachutes.csv")

    entries = {}
    problems = {}
    with open(path, encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            sku = row.get("sku")
            if not sku:
                continue
            found = check_row(row)
            if found and sku not in KNOWN_A4_EXCEPTIONS:
                problems[sku] = found
            entries[sku] = CatalogueEntry(row)

    if problems and strict:
        raise ValueError(
            "device table failed consistency checks:\n  "
            + "\n  ".join("%s: %s" % (k, "; ".join(v)) for k, v in problems.items())
        )

    # manual.csv carries hand-entered devices -- a canopy no vendor sells, or
    # one measured in-house -- so they survive a re-scrape.
    manual = os.path.join(os.path.dirname(path), "manual.csv")
    if os.path.exists(manual):
        with open(manual, encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                if row.get("sku"):
                    entries[row["sku"]] = CatalogueEntry(row)

    return entries
