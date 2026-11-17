"""Motors: OpenRocket's ThrustCurveMotor, its RASP/RockSim loaders and a registry.

OpenRocket 24.12, GPLv3 (see each module for the classes it ports).
"""

from .motor import (PLUGGED_DELAY, PSEUDO_TIME_BURNOUT, PSEUDO_TIME_EMPTY, PSEUDO_TIME_LAUNCH,
                    ThrustCurveMotor)
from .registry import MotorRegistry, default_registry

__all__ = ["ThrustCurveMotor", "MotorRegistry", "default_registry", "PLUGGED_DELAY",
           "PSEUDO_TIME_LAUNCH", "PSEUDO_TIME_BURNOUT", "PSEUDO_TIME_EMPTY"]
