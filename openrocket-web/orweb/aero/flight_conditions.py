"""Flight conditions: Mach, beta, AOA with sin/sinc, roll rate, reference size.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.aerodynamics.FlightConditions.

The setters keep OpenRocket's no-op-when-equal guards (MathUtil.equals), so a
value within 1e-8 relative of the current one is not stored -- e.g. a fresh
FlightConditions is at Mach 0.3 and AOA 0, exactly as in Java.
"""

from __future__ import annotations

import math

from . import mathutil as mu
from .atmosphere import AtmosphericConditions
from .coordinate import Coordinate

MIN_BETA = 0.25


def _calculate_beta(mach: float) -> float:
    if mach < 1:
        return mu.max_(MIN_BETA, mu.safe_sqrt(1 - mach * mach))
    return mu.max_(MIN_BETA, mu.safe_sqrt(mach * mach - 1))


class FlightConditions:
    def __init__(self, config=None):
        self.ref_length = 1.0
        self.ref_area = math.pi * 0.25
        self.aoa = 0.0
        self.sin_aoa = 0.0
        self.sinc_aoa = 1.0
        self.theta = 0.0
        self.mach = 0.3
        self.beta = _calculate_beta(self.mach)
        self.roll_rate = 0.0
        self.pitch_rate = 0.0
        self.yaw_rate = 0.0
        self.pitch_center = Coordinate.NUL  # type: ignore[attr-defined]
        self.atmospheric_conditions = AtmosphericConditions()
        if config is not None:
            self.set_ref_length(config.get_reference_length())

    # reference
    def set_reference(self, config) -> None:
        self.set_ref_length(config.get_reference_length())

    def set_ref_length(self, length: float) -> None:
        if self.ref_length == length:
            return
        self.ref_length = length
        self.ref_area = math.pi * mu.pow2(length / 2)

    def get_ref_length(self) -> float:
        return self.ref_length

    def set_ref_area(self, area: float) -> None:
        if self.ref_area == area:
            return
        self.ref_area = area
        self.ref_length = mu.safe_sqrt(area / math.pi) * 2

    def get_ref_area(self) -> float:
        return self.ref_area

    # angle of attack
    def set_aoa(self, aoa: float, sin_aoa: float | None = None) -> None:
        aoa = mu.clamp(aoa, 0, math.pi)
        if sin_aoa is None:
            if mu.equals(self.aoa, aoa):
                return
            self.aoa = aoa
            if aoa < 0.001:
                self.sin_aoa = aoa
                self.sinc_aoa = 1.0
            else:
                self.sin_aoa = math.sin(aoa)
                self.sinc_aoa = self.sin_aoa / aoa
            return
        sin_aoa = mu.clamp(sin_aoa, 0, 1)
        if mu.equals(self.aoa, aoa):
            return
        self.aoa = aoa
        self.sin_aoa = sin_aoa
        self.sinc_aoa = 1.0 if aoa < 0.001 else sin_aoa / aoa

    def get_aoa(self) -> float:
        return self.aoa

    def get_sin_aoa(self) -> float:
        return self.sin_aoa

    def get_sinc_aoa(self) -> float:
        return self.sinc_aoa

    def set_theta(self, theta: float) -> None:
        if mu.equals(self.theta, theta):
            return
        self.theta = theta

    def get_theta(self) -> float:
        return self.theta

    # speed
    def set_mach(self, mach: float) -> None:
        mach = max(mach, 0)
        if mu.equals(self.mach, mach):
            return
        self.mach = mach
        self.beta = _calculate_beta(mach)

    def get_mach(self) -> float:
        return self.mach

    def get_velocity(self) -> float:
        return self.mach * self.atmospheric_conditions.get_mach_speed()

    def set_velocity(self, velocity: float) -> None:
        self.set_mach(velocity / self.atmospheric_conditions.get_mach_speed())

    def get_beta(self) -> float:
        return self.beta

    # rates
    def get_roll_rate(self) -> float:
        return self.roll_rate

    def set_roll_rate(self, rate: float) -> None:
        if mu.equals(self.roll_rate, rate):
            return
        self.roll_rate = rate

    def get_pitch_rate(self) -> float:
        return self.pitch_rate

    def set_pitch_rate(self, rate: float) -> None:
        if mu.equals(self.pitch_rate, rate):
            return
        self.pitch_rate = rate

    def get_yaw_rate(self) -> float:
        return self.yaw_rate

    def set_yaw_rate(self, rate: float) -> None:
        if mu.equals(self.yaw_rate, rate):
            return
        self.yaw_rate = rate

    def get_pitch_center(self) -> Coordinate:
        return self.pitch_center

    def set_pitch_center(self, c: Coordinate) -> None:
        self.pitch_center = c

    def get_atmospheric_conditions(self) -> AtmosphericConditions:
        return self.atmospheric_conditions

    def set_atmospheric_conditions(self, cond: AtmosphericConditions) -> None:
        self.atmospheric_conditions = cond

    def clone(self) -> "FlightConditions":
        c = FlightConditions.__new__(FlightConditions)
        c.__dict__.update(self.__dict__)
        c.atmospheric_conditions = self.atmospheric_conditions.clone()
        return c
