"""Phase 08: an optimized Layer-1 engine on the end of the feed system.

Point it at what the optimizer wrote and fire it::

    from feedtwin.engine import Chamber, CEATable, load_engine, injector_legs

    design = load_engine("configs/impinging_lox_ch4_8000N_optimal.yaml")
    design.summary()
    #   impinging injector, oxygen/methane, A_t 1398.2 mm^2,
    #   A_inj ox 124.55 mm^2 / fuel 60.76 mm^2, design 8000 N at 24.1 bar

    chamber = Chamber(design.throat_area,
                      CEATable("output/cache/cea_cache_LOX_CH4_3D.npz",
                               expansion_ratio=design.expansion_ratio))
    ox_leg, fuel_leg = injector_legs(design)

Nothing is retyped. The injector areas come from Layer 1's own geometry through
a **type-aware** extractor -- round jets for an impinging face, orifices and an
annulus for a pintle, core and annulus for a coaxial -- and an unrecognised type
is refused rather than guessed at, because a wrong area is a wrong mass flow and
every number downstream of it stays perfectly plausible.

Combustion is **propellant-aware** for real: :class:`CEATable` reads
EngineDesign's own CEA cache, so ``c*``, chamber temperature, ``gamma`` and
``C_F`` come from the same table both tools use. That is what lets a firing
trace report chamber temperature and O/F drift rather than assuming them.

The engine is a boundary, not a component: chamber pressure depends on the flows
and the flows depend on chamber pressure, and
:class:`~feedtwin.engine.component.EngineCoupling` closes that loop around the
whole feed system.
"""

from __future__ import annotations

from feedtwin.engine.balance import (
    MixtureBalance,
    SideBalance,
    balance_from,
)
from feedtwin.engine.chamber import (
    GRAVITY,
    CEATable,
    Chamber,
    ChamberResult,
    CombustionState,
    ConstantCStar,
    CStarModel,
    cea_cache_for,
    mixture_ratio_of,
)
from feedtwin.engine.component import EngineCoupling, InjectorLeg, injector_legs
from feedtwin.engine.design import (
    PROPELLANT_ALIASES,
    DischargeModel,
    EngineDesign,
    InjectorSide,
    UnknownPropellant,
    injector_areas,
    register_injector_type,
    register_propellant_alias,
    registered_injector_types,
    species_for,
)
from feedtwin.engine.importer import (
    EngineImportError,
    engine_from_config,
    load_engine,
)

__all__ = [
    "MixtureBalance",
    "SideBalance",
    "balance_from",
    "GRAVITY",
    "PROPELLANT_ALIASES",
    "CEATable",
    "CStarModel",
    "Chamber",
    "ChamberResult",
    "CombustionState",
    "ConstantCStar",
    "DischargeModel",
    "EngineCoupling",
    "EngineDesign",
    "EngineImportError",
    "InjectorLeg",
    "InjectorSide",
    "UnknownPropellant",
    "cea_cache_for",
    "engine_from_config",
    "injector_areas",
    "injector_legs",
    "load_engine",
    "mixture_ratio_of",
    "register_injector_type",
    "register_propellant_alias",
    "registered_injector_types",
    "species_for",
]
