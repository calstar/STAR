"""The extension points, exercised from outside the package.

"Nothing hardcoded" is a claim that decays silently. Adding a special case is
always the cheap move in the moment, and nothing fails when the seam quietly
stops working -- the code still runs, it just can no longer be extended without
editing it. These tests are what makes that failure loud.

Each one adds something *from the outside*, the way a project using this library
would, and asserts it took effect without touching the package:

* a species that is not in ``species.toml``
* a whole species file layered on top of the shipped one
* a backend that is not CoolProp at all
* measured data placed in front of an equation of state
* a property this package never heard of

If any of these needs a change inside ``feedtwin/props`` to pass, the seam it
covers is gone.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import numpy as np
import pytest

from feedtwin.props import (
    PROPERTIES,
    Fluid,
    OutOfRange,
    Phase,
    SpeciesSpec,
    StatePair,
    TabulatedProperties,
    load_species_file,
    register_backend,
    register_property,
    register_species,
    registered_backends,
    registered_species,
)


def test_a_species_can_be_added_at_runtime() -> None:
    """Argon is not in species.toml. It works anyway, with no code change."""
    register_species(SpeciesSpec(name="argon", backend_fluid="Argon", aliases=("ar",)))

    assert "argon" in registered_species()
    argon = Fluid("ar")
    assert argon.name == "argon"
    # Argon at 1 atm, 300 K: about 1.62 kg/m3.
    assert argon.get("rho", p=101325.0, T=300.0) == pytest.approx(1.62, rel=1e-2)


def test_a_species_file_can_be_layered_on_top(tmp_path: Path) -> None:
    """A project can ship its own fluid table; later definitions win."""
    table = tmp_path / "extra_species.toml"
    table.write_text(textwrap.dedent("""
            [krypton]
            backend_fluid = "Krypton"
            aliases = ["kr"]
            roles = ["pressurant"]
            chain = ["heos"]
            """))

    loaded = load_species_file(table)
    assert [s.name for s in loaded] == ["krypton"]

    krypton = Fluid("kr")
    assert krypton.chain == ("heos",)
    assert krypton.species.roles == ("pressurant",)
    assert krypton.get("rho", p=101325.0, T=300.0) > 0.0


def test_a_backend_that_is_not_coolprop_can_join_a_chain() -> None:
    """The seam is the protocol, not the library behind it.

    A deliberately absurd backend -- constant density, nothing else -- proves
    the chain talks to the protocol and never to CoolProp specifically. This is
    what a REFPROP or Modelica media backend would slot into.
    """

    class ConstantDensity:
        """Answers 'rho' with one number and declines everything else."""

        name = "constant"

        def __init__(self, value: float) -> None:
            self._value = value

        def supports(self, prop: str) -> bool:
            return prop == "rho"

        def update(self, pair: StatePair, v1: float, v2: float) -> None:
            return None

        def value(self, prop: str) -> float:
            if prop != "rho":
                raise KeyError(prop)
            return self._value

        def phase(self) -> Phase:
            return Phase.UNKNOWN

        def quality(self) -> float | None:
            return None

    register_backend("constant_999", lambda species: ConstantDensity(999.0))
    assert "constant_999" in registered_backends()

    n2 = Fluid("nitrogen", chain=["constant_999", "heos"])
    # rho comes from the stub, which is first and supports it...
    assert n2.get("rho", p=1.0e7, T=300.0) == 999.0
    # ...while viscosity skips it, because it does not claim to compute it.
    assert n2.get("mu", p=1.0e7, T=300.0) == pytest.approx(1.9e-5, rel=0.2)


def test_measured_data_wins_where_it_has_coverage() -> None:
    """The Phase 12 principle, working in Phase 01.

    A measured grid in front of the equation of state overrides it inside the
    measured region and falls through outside it -- and nobody writes the "do
    we have data here?" branch, because the chain is that branch.
    """
    p_grid = np.array([1.0e6, 2.0e6, 3.0e6])
    T_grid = np.array([280.0, 300.0, 320.0])
    # Deliberately wrong by a factor of two, so "did the measurement win?" is
    # unambiguous rather than a question about interpolation error.
    truth = np.array(
        [[Fluid("nitrogen").get("rho", p=p, T=T) for T in T_grid] for p in p_grid]
    )
    measured = TabulatedProperties(
        p_grid, T_grid, {"rho": truth * 2.0}, source="CF-2026-03"
    )

    n2 = Fluid("nitrogen", chain=[measured, "bicubic", "heos"])
    assert n2.chain == ("measured", "bicubic", "heos")

    inside = n2.get("rho", p=2.0e6, T=300.0)
    assert inside == pytest.approx(truth[1][1] * 2.0, rel=1e-9)

    # Outside the measured box the equation of state answers, unmodified.
    outside = n2.get("rho", p=1.0e7, T=300.0)
    assert outside == pytest.approx(Fluid("nitrogen").get("rho", p=1.0e7, T=300.0))


def test_measured_data_refuses_outside_its_grid_rather_than_extrapolating() -> None:
    """An extrapolated measurement has a measurement's authority and a guess's
    accuracy, so the backend must decline instead."""
    tab = TabulatedProperties(
        [1.0e6, 2.0e6], [280.0, 300.0], {"rho": np.ones((2, 2))}, source="unit-test"
    )
    with pytest.raises(OutOfRange, match="outside the measured grid"):
        tab.update(StatePair.PT, 9.0e6, 290.0)


def test_measured_data_rejects_unregistered_properties() -> None:
    """A table of numbers with no declared unit is not data, it is a guess."""
    with pytest.raises(ValueError, match="not registered properties"):
        TabulatedProperties(
            [1.0, 2.0], [1.0, 2.0], {"squiggliness": np.ones((2, 2))}, source="x"
        )


def test_a_new_property_can_be_registered() -> None:
    """Quantities this package never shipped can still flow through it."""
    spec = register_property("fouling_factor", "m^2.K/W", "Heat exchanger fouling")
    assert PROPERTIES["fouling_factor"] is spec

    tab = TabulatedProperties(
        [1.0e5, 1.0e6],
        [280.0, 320.0],
        {"fouling_factor": np.full((2, 2), 1.7e-4)},
        source="unit-test",
    )
    fluid = Fluid("nitrogen", chain=[tab, "heos"])
    assert fluid.get("fouling_factor", p=5.0e5, T=300.0) == pytest.approx(1.7e-4)

    with pytest.raises(ValueError, match="already registered"):
        register_property("fouling_factor", "-", "duplicate")


def test_shipped_species_are_declared_as_data_not_code() -> None:
    """species.toml is the registry; the package holds no fluid list.

    A guard against the obvious regression: someone adds a fluid by writing it
    into Python because that felt quicker, and the data path quietly becomes
    decorative.
    """
    from feedtwin.props import species as species_module

    table = Path(species_module.__file__).with_name("species.toml")
    declared = set(tomllib_keys(table))

    assert {"oxygen", "ethanol", "nitrogen", "helium"} <= declared
    for name in declared:
        assert Fluid(name).species.backend_fluid


def tomllib_keys(path: Path) -> list[str]:
    import tomllib

    with path.open("rb") as handle:
        return list(tomllib.load(handle))
