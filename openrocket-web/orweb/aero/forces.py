"""AerodynamicForces with OpenRocket's merge and override-aware getters.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.aerodynamics.AerodynamicForces.

The CP is stored as CP*CNa with the CNa as weight, so merging two forces adds
moments and CNa; merge() sums the non-axial coefficients only. The drag getters
look at the owning component: a component whose CD is overridden (or whose
ancestor overrides it) reports zero friction/pressure/base drag, and getCD()
reports the override itself.
"""

from __future__ import annotations

import math

from . import _compat as compat
from . import mathutil as mu
from .coordinate import Coordinate

NaN = math.nan


class AerodynamicForces:
    def __init__(self):
        self.component = None
        self.cp_cna = Coordinate.ZERO  # type: ignore[attr-defined]
        self.CN = NaN
        self.Cm = NaN
        self.Cside = NaN
        self.Cyaw = NaN
        self.Croll = NaN
        self.CrollDamp = NaN
        self.CrollForce = NaN
        self.CDaxial = NaN
        self.CD = NaN
        self.pressureCD = NaN
        self.baseCD = NaN
        self.frictionCD = NaN
        self.overrideCD = NaN
        self.pitchDampingMoment = NaN
        self.yawDampingMoment = NaN
        self.axisymmetric = True

    # component
    def set_component(self, c) -> None:
        self.component = c

    def get_component(self):
        return self.component

    # CP
    def set_cp(self, cp: Coordinate) -> None:
        if mu.equals(0, cp.weight):
            self.cp_cna = Coordinate.ZERO  # type: ignore[attr-defined]
        else:
            self.cp_cna = Coordinate(cp.x * cp.weight, cp.y * cp.weight, cp.z * cp.weight, cp.weight)

    def get_cp(self) -> Coordinate:
        w = self.cp_cna.weight
        if mu.equals(0, w):
            return Coordinate.ZERO  # type: ignore[attr-defined]
        return Coordinate(self.cp_cna.x / w, self.cp_cna.y / w, self.cp_cna.z / w, w)

    # plain coefficients
    def set_cn(self, v): self.CN = v
    def get_cn(self): return self.CN
    def set_cm(self, v): self.Cm = v
    def get_cm(self): return self.Cm
    def set_cside(self, v): self.Cside = v
    def get_cside(self): return self.Cside
    def set_cyaw(self, v): self.Cyaw = v
    def get_cyaw(self): return self.Cyaw
    def set_croll(self, v): self.Croll = v
    def get_croll(self): return self.Croll
    def set_croll_damp(self, v): self.CrollDamp = v
    def get_croll_damp(self): return self.CrollDamp
    def set_croll_force(self, v): self.CrollForce = v
    def get_croll_force(self): return self.CrollForce
    def set_cd_axial(self, v): self.CDaxial = v
    def get_cd_axial(self): return self.CDaxial
    def set_cd(self, v): self.CD = v
    def set_pitch_damping_moment(self, v): self.pitchDampingMoment = v
    def get_pitch_damping_moment(self): return self.pitchDampingMoment
    def set_yaw_damping_moment(self, v): self.yawDampingMoment = v
    def get_yaw_damping_moment(self): return self.yawDampingMoment
    def set_pressure_cd(self, v): self.pressureCD = v
    def set_base_cd(self, v): self.baseCD = v
    def set_friction_cd(self, v): self.frictionCD = v
    def set_override_cd(self, v): self.overrideCD = v

    # override-aware drag getters
    def _overridden(self) -> bool:
        c = self.component
        return compat.is_cd_overridden(c) or compat.is_cd_overridden_by_ancestor(c)

    def get_cd(self) -> float:
        c = self.component
        if c is None:
            return self.CD
        if compat.is_cd_overridden_by_ancestor(c):
            return 0.0
        if compat.is_cd_overridden(c):
            return compat.get_override_cd(c)
        return self.CD

    def get_pressure_cd(self) -> float:
        if self.component is None:
            return self.pressureCD
        return 0.0 if self._overridden() else self.pressureCD

    def get_base_cd(self) -> float:
        if self.component is None:
            return self.baseCD
        return 0.0 if self._overridden() else self.baseCD

    def get_friction_cd(self) -> float:
        if self.component is None:
            return self.frictionCD
        return 0.0 if self._overridden() else self.frictionCD

    def get_override_cd(self) -> float:
        c = self.component
        if c is None:
            return self.overrideCD
        if not compat.is_a(c, "Rocket") and (
                not compat.is_cd_overridden(c) or compat.is_cd_overridden_by_ancestor(c)):
            return 0.0
        return self.overrideCD

    def zero(self) -> "AerodynamicForces":
        # component, and the four drag parts, untouched (as in Java)
        self.axisymmetric = True
        self.set_cp(Coordinate.NUL)  # type: ignore[attr-defined]
        self.CN = 0.0
        self.Cm = 0.0
        self.Cside = 0.0
        self.Cyaw = 0.0
        self.Croll = 0.0
        self.CrollDamp = 0.0
        self.CrollForce = 0.0
        self.CDaxial = 0.0
        self.CD = 0.0
        self.pitchDampingMoment = 0.0
        self.yawDampingMoment = 0.0
        return self

    def merge(self, other: "AerodynamicForces") -> "AerodynamicForces":
        self.cp_cna = self.cp_cna.add(other.cp_cna)
        self.CN = self.CN + other.get_cn()
        self.Cm = self.Cm + other.get_cm()
        self.Cside = self.Cside + other.get_cside()
        self.Cyaw = self.Cyaw + other.get_cyaw()
        self.Croll = self.Croll + other.get_croll()
        self.CrollDamp = self.CrollDamp + other.get_croll_damp()
        self.CrollForce = self.CrollForce + other.get_croll_force()
        return self

    def __repr__(self) -> str:
        cp = self.get_cp()
        return (f"AerodynamicForces[{compat.name_of(self.component)}: cpx={cp.x:.6g} cna={cp.weight:.6g} "
                f"CN={self.CN:.6g} CD={self.CD:.6g}]")
