"""Injector model registry and base classes."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Tuple, Dict, Any, Type

from engine.pipeline.config_schemas import (
    PintleEngineConfig,
    PintleInjectorConfig,
    CoaxialInjectorConfig,
    ImpingingInjectorConfig,
)


class InjectorModel(ABC):
    """Abstract base class for injector models"""

    def __init__(self, engine_config: PintleEngineConfig):
        self.engine_config = engine_config

    @abstractmethod
    def solve(
        self,
        P_tank_O: float,
        P_tank_F: float,
        Pc: float,
    ) -> Tuple[float, float, Dict[str, Any]]:
        """Solve injector flows for given tank and chamber pressures."""
        raise NotImplementedError


def _validate_pintle_config(config: PintleInjectorConfig) -> None:
    # Placeholder for additional validation if required in future
    return None


from .pintle import PintleInjector  # noqa: E402  (import after base class)  # pylint: disable=wrong-import-position
from .coaxial import CoaxialInjector  # noqa: E402
from .impinging import ImpingingInjector  # noqa: E402


INJECTOR_REGISTRY: Dict[str, Type[InjectorModel]] = {
    "pintle": PintleInjector,
    "coaxial": CoaxialInjector,
    "impinging": ImpingingInjector,
}


def get_injector_model(engine_config: PintleEngineConfig) -> InjectorModel:
    """Factory returning injector model implementation based on configuration."""
    injector_cfg = engine_config.injector
    if injector_cfg.type == "pintle":
        _validate_pintle_config(injector_cfg)

    injector_cls = INJECTOR_REGISTRY.get(injector_cfg.type)
    if injector_cls is None:
        raise NotImplementedError(
            f"Injector type '{injector_cfg.type}' is not registered."
        )
    return injector_cls(engine_config)
