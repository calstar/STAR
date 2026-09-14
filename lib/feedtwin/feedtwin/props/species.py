"""Which fluids exist, declared as data.

The species table lives in ``species.toml``, not in Python. Adding a propellant
is an edit to a data file; it is never a new branch in a function. That is the
difference between a simulator that supports four fluids and one that supports
whatever you point it at, and it is cheap only if it is done on day one --
retrofitting a fluid registry after fifty ``if fluid == "lox"`` sites have
accumulated is the expensive version of this decision.

Anything the equation of state already knows -- molar mass, critical point,
triple point -- is deliberately *not* declared here. Duplicating it would create
a second source of truth that silently disagrees with the first.

Runtime registration is supported too, so a project can add a species without
editing this package::

    from feedtwin.props import register_species, SpeciesSpec

    register_species(SpeciesSpec(name="nitrous", backend_fluid="NitrousOxide"))
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from feedtwin.props.errors import UnknownFluid

#: Backends tried in order when a species does not name its own chain.
#:
#: Tabulated bicubic first because it is 10-30x faster than evaluating the
#: Helmholtz energy directly; the equation of state behind it because the tables
#: cover a bounded region and refuse everything outside it. Ordinary states are
#: fast, unusual states are correct, and no caller has to know which happened.
DEFAULT_CHAIN: tuple[str, ...] = ("bicubic", "heos")

_SPECIES_FILE = Path(__file__).with_name("species.toml")


@dataclass(frozen=True, slots=True)
class SpeciesSpec:
    """One declared fluid.

    Attributes:
        name: Canonical lowercase identifier, e.g. ``"nitrogen"``.
        backend_fluid: What the equation-of-state library calls it, e.g.
            ``"Nitrogen"``. Separate from ``name`` because the library's
            spelling is its business, not ours.
        aliases: Other names that resolve here -- ``"lox"`` for oxygen, ``"gn2"``
            for nitrogen. Matched case-insensitively.
        roles: What the fluid is used as: ``oxidizer``, ``fuel``, ``pressurant``.
            Advisory metadata for UIs and validation, not physics.
        chain: Backends to try in order. Defaults to :data:`DEFAULT_CHAIN`.
        options: Free-form settings passed through to backends, so a backend can
            carry per-species configuration without this class growing a field
            for every backend that ever exists.
    """

    name: str
    backend_fluid: str
    aliases: tuple[str, ...] = ()
    roles: tuple[str, ...] = ()
    chain: tuple[str, ...] = DEFAULT_CHAIN
    options: dict[str, Any] = field(default_factory=dict)


_SPECIES: dict[str, SpeciesSpec] = {}
_ALIASES: dict[str, str] = {}

#: Whether the shipped table has been read. An explicit flag, not "is _SPECIES
#: empty" -- that test looks equivalent and is not. A program whose first call
#: is register_species() would make the registry non-empty, the shipped table
#: would then look already-loaded, and every fluid in species.toml would be
#: unknown for the rest of the process. Nothing would raise until something
#: asked for oxygen.
_LOADED = False


def register_species(spec: SpeciesSpec) -> SpeciesSpec:
    """Add or replace a species. Aliases are indexed case-insensitively.

    Registrations layer *on top of* the shipped table: it is loaded first if it
    has not been already, so adding a species never removes one.
    """
    _ensure_loaded()
    return _register(spec)


def _register(spec: SpeciesSpec) -> SpeciesSpec:
    """Register without loading the shipped table -- used by the loader itself."""
    _SPECIES[spec.name] = spec
    _ALIASES[spec.name.lower()] = spec.name
    for alias in spec.aliases:
        _ALIASES[alias.lower()] = spec.name
    return spec


def get_species(name: str) -> SpeciesSpec:
    """Resolve a name or alias to its species. Case-insensitive."""
    _ensure_loaded()
    key = _ALIASES.get(name.strip().lower())
    if key is None:
        raise UnknownFluid(name, list(_SPECIES))
    return _SPECIES[key]


def registered_species() -> list[str]:
    """Canonical names of every declared species, sorted."""
    _ensure_loaded()
    return sorted(_SPECIES)


def _ensure_loaded() -> None:
    global _LOADED
    if _LOADED:
        return
    # Set before loading, not after: load_species_file registers as it goes,
    # and a flag set afterwards would let a re-entrant call start the load a
    # second time.
    _LOADED = True
    load_species_file(_SPECIES_FILE)


def load_species_file(path: Path) -> list[SpeciesSpec]:
    """Load a species table from a TOML file and register everything in it.

    Public so a project can layer its own table on top of the shipped one --
    later definitions replace earlier ones by name.
    """
    with path.open("rb") as handle:
        raw = tomllib.load(handle)

    loaded: list[SpeciesSpec] = []
    for name, body in raw.items():
        if not isinstance(body, dict):
            raise ValueError(
                f"{path}: [{name}] must be a table, got {type(body).__name__}"
            )
        loaded.append(_register(_spec_from_toml(name, body)))
    return loaded


def _spec_from_toml(name: str, body: dict[str, Any]) -> SpeciesSpec:
    backend_fluid = body.get("backend_fluid")
    if not isinstance(backend_fluid, str):
        raise ValueError(f"species [{name}] needs a string 'backend_fluid'")

    chain = body.get("chain", list(DEFAULT_CHAIN))
    options = body.get("options", {})
    if not isinstance(options, dict):
        raise ValueError(f"species [{name}]: 'options' must be a table")

    return SpeciesSpec(
        name=name.lower(),
        backend_fluid=backend_fluid,
        aliases=_str_tuple(name, "aliases", body.get("aliases", [])),
        roles=_str_tuple(name, "roles", body.get("roles", [])),
        chain=_str_tuple(name, "chain", chain),
        options=options,
    )


def _str_tuple(species: str, key: str, value: Any) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ValueError(f"species [{species}]: '{key}' must be a list of strings")
    return tuple(str(v) for v in value)
