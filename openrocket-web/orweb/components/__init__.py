"""The rocket component tree, one class per OpenRocket component type.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.rocketcomponent.*.
Class names are OpenRocket's; methods are its accessors in snake_case
(getForeRadius -> get_fore_radius).
"""

from .assemblies import AxialStage, ComponentAssembly, ParallelStage, PodSet, Rocket
from .base import RocketComponent
from .external import BodyComponent, ExternalComponent, Finish, Tube
from .fins import CrossSection, EllipticalFinSet, FinSet, FreeformFinSet, TrapezoidFinSet, TubeFinSet
from .internal import (Bulkhead, CenteringRing, ClusterConfiguration, EngineBlock, InnerTube, InternalComponent,
                       RadiusRingComponent, RingComponent, StructuralComponent, ThicknessRingComponent, TubeCoupler)
from .lugs import LaunchLug, RailButton
from .massobjects import MassComponent, MassComponentType, MassObject, Parachute, RecoveryDevice, ShockCord, Streamer
from .position import AngleMethod, AxialMethod, RadiusMethod
from .symmetric import BodyTube, NoseCone, Shape, SymmetricComponent, Transition

__all__ = [n for n in dir() if not n.startswith("_")]
