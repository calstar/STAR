"""A thrust-curve motor.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.motor.ThrustCurveMotor
(getPseudoIndex, interpolateAtIndex, interpolateCenterOfMassAtIndex, computeStatistics,
Builder.simplifyDesignation), info.openrocket.core.motor.Motor (pseudo-times).
Structure adapted from star-openrocket/backend/motors/motor.py (same STAR monorepo).

A motor is parallel arrays: ``time``, ``thrust``, and a per-sample centre of mass
(``cgx`` from the motor's forward end, ``mass`` the total motor mass). Mass and CG
at a time interpolate exactly as OpenRocket does, so at launch they are the
first sample and at burnout the last.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from ..util import mathutil as mu

PSEUDO_TIME_EMPTY = math.nan
PSEUDO_TIME_LAUNCH = 0.0
PSEUDO_TIME_BURNOUT = 1.7976931348623157e308  # Double.MAX_VALUE
PLUGGED_DELAY = math.inf
MARGINAL_THRUST = 0.05
_SNAP = 0.0001
_SIMPLIFY = re.compile(r"^[0-9]*[ -]*([A-Z][0-9]+).*")


def simplify_designation(s: str) -> str:
    s = s.strip()
    m = _SIMPLIFY.match(s)
    if m:
        return m.group(1)
    return re.sub(r"\s", "", s)


@dataclass
class ThrustCurveMotor:
    manufacturer: str
    designation: str
    diameter: float
    length: float
    time: list[float]
    thrust: list[float]
    cg_x: list[float]
    mass: list[float]
    digest: str = ""
    delays: list[float] = field(default_factory=list)
    motor_type: str = "UNKNOWN"  # SINGLE | RELOAD | HYBRID | UNKNOWN
    common_name: str = ""
    description: str = ""
    quality: str = "basic"
    file_format: str = ""
    comment: str = ""
    available: bool = True

    def __post_init__(self) -> None:
        if not self.common_name:
            self.common_name = simplify_designation(self.designation)
        self._compute_statistics()

    # -- Java accessors ----------------------------------------------------------------------
    def get_designation(self) -> str:
        return self.designation

    def get_manufacturer(self) -> str:
        return self.manufacturer

    def get_digest(self) -> str:
        return self.digest

    def get_diameter(self) -> float:
        return self.diameter

    def get_length(self) -> float:
        return self.length

    def get_motor_type(self) -> str:
        return self.motor_type

    def get_time_points(self) -> list[float]:
        return list(self.time)

    def get_thrust_points(self) -> list[float]:
        return list(self.thrust)

    def get_launch_cgx(self) -> float:
        return self.cg_x[0]

    def get_burnout_cgx(self) -> float:
        return self.cg_x[-1]

    def get_launch_mass(self) -> float:
        return self.mass[0]

    def get_burnout_mass(self) -> float:
        return self.mass[-1]

    def get_burn_time(self) -> float:
        return self.time[-1]

    def get_unit_rotational_inertia(self) -> float:
        return mu.filled_cylinder_rotational(self.diameter / 2)

    def get_unit_longitudinal_inertia(self) -> float:
        return mu.filled_cylinder_longitudinal(self.diameter / 2, self.length)

    # -- interpolation -----------------------------------------------------------------------
    def _get_index(self, t: float) -> int:
        lower = 0
        upper = 0
        while upper < len(self.time) and t >= self.time[upper]:
            lower = upper
            upper += 1
        return lower

    def _get_index_fraction(self, t: float, index: int) -> float:
        upper = index + 1
        if upper == len(self.time):
            return 0.0
        frac = (t - self.time[index]) / (self.time[upper] - self.time[index])
        if _SNAP > frac:
            return 0.0
        if (1 - _SNAP) < frac:
            return 1.0
        return frac

    def get_pseudo_index(self, t: float) -> float:
        if len(self.time) == 0 or 0 > t or math.isnan(t):
            return math.nan
        lower = self._get_index(t)
        return float(lower) + self._get_index_fraction(t, lower)

    @staticmethod
    def _interpolate_at_index(values: list[float], pseudo: float) -> float:
        lower = int(pseudo)
        upper = lower + 1
        lower_frac = pseudo - float(lower)
        upper_frac = 1 - lower_frac
        if _SNAP > lower_frac:
            return values[lower]
        if _SNAP > upper_frac:
            return values[upper]
        return values[lower] * upper_frac + values[upper] * lower_frac

    def _com_at_index(self, pseudo: float) -> tuple[float, float]:
        """interpolateCenterOfMassAtIndex -> (cgx, mass)."""
        if math.isnan(pseudo):
            return math.nan, math.nan
        upper_frac = math.fmod(pseudo, 1.0)
        lower_frac = 1 - upper_frac
        lower = int(pseudo)
        upper = lower + 1
        if _SNAP > (1 - lower_frac):
            return self.cg_x[lower], self.mass[lower]
        if _SNAP > upper_frac:
            return self.cg_x[upper], self.mass[upper]
        return (self.cg_x[lower] * lower_frac + self.cg_x[upper] * upper_frac,
                self.mass[lower] * lower_frac + self.mass[upper] * upper_frac)

    def get_thrust(self, t: float) -> float:
        p = self.get_pseudo_index(t)
        if math.isnan(p):
            return math.nan
        return self._interpolate_at_index(self.thrust, p)

    def get_cmx(self, t: float) -> float:
        return self._com_at_index(self.get_pseudo_index(t))[0]

    def get_total_mass(self, t: float) -> float:
        return self._com_at_index(self.get_pseudo_index(t))[1]

    def get_propellant_mass(self, t: float | None = None) -> float:
        if t is None:
            return self.get_launch_mass() - self.get_burnout_mass()
        return self.get_total_mass(t) - self.get_burnout_mass()

    # -- statistics (computeStatistics) -----------------------------------------------------
    def _compute_statistics(self) -> None:
        time, thrust = self.time, self.thrust
        if len(time) < 2:
            self.max_thrust = self.burn_time_estimate = self.average_thrust = self.total_impulse = 0.0
            return
        self.max_thrust = 0.0
        for t in thrust:
            if t > self.max_thrust:
                self.max_thrust = t
        limit = self.max_thrust * MARGINAL_THRUST
        if thrust[0] >= limit:
            burn_start = time[0]
        else:
            sp = 1
            while sp < len(thrust) and thrust[sp] < limit:
                sp += 1
            if sp >= len(thrust):
                burn_start = time[0]
            elif mu.equals(thrust[sp - 1], thrust[sp]):
                burn_start = (time[sp - 1] + time[sp]) / 2
            else:
                burn_start = mu.map_range(limit, thrust[sp - 1], thrust[sp], time[sp - 1], time[sp])
        if thrust[-1] >= limit:
            burn_end = time[-1]
        else:
            ep = len(thrust) - 2
            while ep >= 0 and thrust[ep] < limit:
                ep -= 1
            if ep < 0:
                burn_end = time[-1]
            elif mu.equals(thrust[ep], thrust[ep + 1]):
                burn_end = (time[ep] + time[ep + 1]) / 2
            else:
                burn_end = mu.map_range(limit, thrust[ep], thrust[ep + 1], time[ep], time[ep + 1])
        self.burn_time_estimate = max(burn_end - burn_start, 0.0)
        total = 0.0
        avg = 0.0
        for i in range(len(time) - 1):
            t0, t1, f0, f1 = time[i], time[i + 1], thrust[i], thrust[i + 1]
            total += (t1 - t0) * (f0 + f1) / 2
            if t0 < burn_start < t1:
                fs = mu.map_range(burn_start, t0, t1, f0, f1)
                avg += (fs + f1) / 2 * (t1 - burn_start)
            elif t0 >= burn_start and t1 <= burn_end:
                avg += (f0 + f1) / 2 * (t1 - t0)
            elif t0 < burn_end < t1:
                fe = mu.map_range(burn_end, t0, t1, f0, f1)
                avg += (f0 + fe) / 2 * (burn_end - t0)
        self.total_impulse = total
        self.average_thrust = avg / self.burn_time_estimate if self.burn_time_estimate > 0 else 0.0

    def get_total_impulse_estimate(self) -> float:
        return self.total_impulse

    def get_burn_time_estimate(self) -> float:
        return self.burn_time_estimate

    def get_average_thrust_estimate(self) -> float:
        return self.average_thrust

    def get_max_thrust_estimate(self) -> float:
        return self.max_thrust

    # -- (de)serialisation ------------------------------------------------------------------
    def to_dict(self) -> dict:
        return {"manufacturer": self.manufacturer, "designation": self.designation,
                "commonName": self.common_name, "digest": self.digest, "type": self.motor_type,
                "diameter": self.diameter, "length": self.length, "delays": [
                    (None if math.isinf(d) else d) for d in self.delays],
                "time": list(self.time), "thrust": list(self.thrust), "cgx": list(self.cg_x),
                "mass": list(self.mass)}

    @staticmethod
    def from_dict(d: dict) -> "ThrustCurveMotor":
        return ThrustCurveMotor(
            manufacturer=d["manufacturer"], designation=d["designation"], diameter=float(d["diameter"]),
            length=float(d["length"]), time=[float(x) for x in d["time"]], thrust=[float(x) for x in d["thrust"]],
            cg_x=[float(x) for x in d["cgx"]], mass=[float(x) for x in d["mass"]], digest=d.get("digest") or "",
            delays=[PLUGGED_DELAY if x is None else float(x) for x in d.get("delays", [])],
            motor_type=d.get("type") or d.get("motorType") or "UNKNOWN", common_name=d.get("commonName") or "")

    def summary(self) -> dict:
        """The /api/motors/search row."""
        return {"designation": self.designation, "manufacturer": self.manufacturer, "digest": self.digest,
                "diameter": self.diameter, "length": self.length, "totalImpulse": self.total_impulse,
                "burnTime": self.burn_time_estimate, "avgThrust": self.average_thrust,
                "commonName": self.common_name, "type": self.motor_type}
