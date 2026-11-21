"""External components: material, surface finish, body components.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.rocketcomponent.ExternalComponent,
BodyComponent, Tube.
"""

from __future__ import annotations

from enum import Enum

from .. import material as mat
from .base import RocketComponent
from .position import AxialMethod


class Finish(Enum):
    """ExternalComponent.Finish: name -> roughness size (m)."""
    ROUGH = 500.0e-6
    ROUGHUNFINISHED = 250.0e-6
    UNFINISHED = 150.0e-6
    NORMAL = 60.0e-6
    SMOOTH = 20.0e-6
    OPTIMUM = 5.0e-6
    POLISHED = 2.0e-6
    FINISHPOLISHED = 0.5e-6
    MIRROR = 0.0e-6

    def get_roughness_size(self) -> float:
        return self.value

    @staticmethod
    def parse(s: str) -> "Finish":
        s = s.strip()
        for f in Finish:
            if f.name.lower() == s:
                return f
        raise ValueError(f"unknown finish {s!r}")


class ExternalComponent(RocketComponent):
    def __init__(self, axial_method: AxialMethod):
        super().__init__(axial_method)
        self.material: mat.Material = mat.DEFAULT_BULK
        self.finish = Finish.NORMAL

    def get_component_volume(self) -> float:
        raise NotImplementedError

    def get_component_mass(self) -> float:
        return self.material.density * self.get_component_volume()

    def is_aerodynamic(self) -> bool:
        return True

    def is_massive(self) -> bool:
        return True

    def get_material(self) -> mat.Material:
        return self.material

    def set_material(self, m: mat.Material) -> None:
        if m.type != mat.BULK:
            raise ValueError("ExternalComponent requires a bulk material")
        if self.material == m:
            return
        self.material = m
        self._fire()

    def get_finish(self) -> Finish:
        return self.finish

    def set_finish(self, f: Finish) -> None:
        if self.finish is f:
            return
        self.finish = f
        self._fire()


class BodyComponent(ExternalComponent):
    def __init__(self):
        super().__init__(AxialMethod.AFTER)

    def set_length(self, length: float) -> None:
        if self.length == length:
            return
        self.length = max(length, 0.0)
        self._fire()

    def allows_children(self) -> bool:
        return True


class Tube(ExternalComponent):
    """Tube: an ExternalComponent that is Coaxial (LaunchLug, TubeFinSet)."""
