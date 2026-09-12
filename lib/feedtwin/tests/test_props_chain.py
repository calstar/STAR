"""The fallback chain, and refusing to answer when there is no honest answer.

The chain is the design (see :mod:`feedtwin.props.fluid`): fast tables first,
the equation of state behind them, measured data in front when there is any.
These tests hold it to the two promises that make it safe to rely on --

* a state point the fast backend cannot reach is **served by the next one**,
  not failed and not guessed at; and
* a state point *nothing* can serve **raises**, naming what each backend said,
  rather than returning a number.

The second matters more than it looks. Every backend in this package refuses
outside its envelope, so the only way a wrong number gets out is if this layer
invents one.
"""

from __future__ import annotations

import pytest

from feedtwin.props import Fluid, OutOfRange, PropertyError

IN_TABLES = dict(p=1.0e7, T=300.0)

#: Points outside the tabulated envelope, verified against the backend rather
#: than assumed: 5 GPa is past the pressure ceiling, 20 K past the temperature
#: floor, 1 Pa below the pressure floor.
PAST_THE_TABLES = [
    ("above the pressure ceiling", dict(p=5.0e9, T=300.0)),
    ("below the temperature floor", dict(p=1.0e6, T=20.0)),
    ("below the pressure floor", dict(p=1.0, T=300.0)),
]


def test_ordinary_states_are_served_by_the_tables() -> None:
    assert Fluid("nitrogen").state(**IN_TABLES).backend == "bicubic"


@pytest.mark.parametrize("label,state", PAST_THE_TABLES)
def test_the_chain_falls_through_to_the_equation_of_state(
    label: str, state: dict[str, float]
) -> None:
    """Past the tables, the equation of state answers -- and says it did."""
    snapshot = Fluid("nitrogen").state(**state)
    assert snapshot.backend == "heos", label
    assert snapshot.rho > 0.0


@pytest.mark.parametrize("label,state", PAST_THE_TABLES)
def test_the_tables_refuse_rather_than_extrapolate(
    label: str, state: dict[str, float]
) -> None:
    """Pinned on the backend itself, because the whole design leans on it.

    If the tabulated backend ever started extrapolating instead of raising,
    every test above would still pass -- the chain would simply never fall
    through, and would return quietly wrong numbers at the edges. This is the
    test that would notice.

    Asserted one level below :class:`Fluid` deliberately: through a fluid, an
    exhausted chain reports :class:`PropertyError` summarising every backend's
    reason, which is right for a caller but too coarse to prove *this* backend
    refused for *this* reason.
    """
    from feedtwin.props import CoolPropBackend, StatePair, get_species

    backend = CoolPropBackend(get_species("nitrogen"), "BICUBIC&HEOS", "bicubic")
    with pytest.raises(OutOfRange):
        backend.update(StatePair.PT, state["p"], state["T"])


@pytest.mark.parametrize("label,state", PAST_THE_TABLES)
def test_an_exhausted_chain_preserves_why(label: str, state: dict[str, float]) -> None:
    """A chain of only the tables fails, and the OutOfRange survives as the cause."""
    with pytest.raises(PropertyError) as excinfo:
        Fluid("nitrogen", chain=["bicubic"]).get("rho", **state)

    assert isinstance(excinfo.value.__cause__, OutOfRange), label


def test_a_state_nothing_can_serve_raises_and_explains() -> None:
    """The error names every backend and what it said."""
    absurd = Fluid("nitrogen", chain=["bicubic"])
    with pytest.raises(PropertyError) as excinfo:
        absurd.get("rho", p=5.0e9, T=300.0)

    message = str(excinfo.value)
    assert "bicubic" in message
    assert "nitrogen" in message


@pytest.mark.parametrize(
    "state,expected",
    [
        (dict(p=-5.0, T=300.0), "must be > 0"),
        (dict(p=1.0e6, T=0.0), "must be > 0"),
        (dict(p=5.0e5, q=1.7), r"within \[0, 1\]"),
        (dict(p=float("nan"), T=300.0), "not a finite number"),
    ],
)
def test_impossible_inputs_are_rejected_before_any_backend(
    state: dict[str, float], expected: str
) -> None:
    """A negative pressure should say so, not fail inside a root find.

    Handed p < 0, CoolProp reports that a Brent bracket does not contain a
    root -- true, useless, and three layers below the mistake. NaN matters even
    more: it is what a diverging solve produces, and propagating it would turn
    one bad iteration into a plausible-looking density.
    """
    with pytest.raises(ValueError, match=expected):
        Fluid("nitrogen").get("rho", **state)


def test_unknown_property_and_unknown_fluid_say_what_is_available() -> None:
    with pytest.raises(KeyError, match="unknown property"):
        Fluid("nitrogen").get("enthalpy_but_misspelled", p=1e6, T=300.0)

    from feedtwin.props import UnknownFluid

    with pytest.raises(UnknownFluid, match="Registered"):
        Fluid("unobtanium")


def test_an_unformable_state_lists_the_valid_pairs() -> None:
    with pytest.raises(TypeError, match="exactly two of"):
        Fluid("nitrogen").get("rho", p=1.0e6)


def test_accessor_and_get_agree_including_argument_order() -> None:
    """A positional API must honour the order the caller declared."""
    n2 = Fluid("nitrogen")
    expected = n2.get("rho", p=1.0e7, T=300.0)

    assert n2.accessor("rho", "p", "T")(1.0e7, 300.0) == pytest.approx(expected)
    assert n2.accessor("rho", "T", "p")(300.0, 1.0e7) == pytest.approx(expected)


def test_accessor_falls_through_the_chain_too() -> None:
    """The fast path must not lose the fallback it was optimised around."""
    rho = Fluid("nitrogen").accessor("rho", "p", "T")
    assert rho(5.0e9, 300.0) == pytest.approx(1579.7, rel=1e-3)


def test_quality_is_none_outside_the_dome_not_a_sentinel() -> None:
    """CoolProp reports -1 or -1000 for "not two-phase"; neither may escape.

    A sentinel that survives into a mass balance is read as a vapour fraction,
    and -1000 kg of vapour does not raise anything.
    """
    n2 = Fluid("nitrogen")
    assert n2.state(p=5.0e5, T=80.0).quality is None  # subcooled liquid
    assert n2.state(p=1.0e7, T=300.0).quality is None  # supercritical
    assert n2.state(p=5.0e5, q=0.5).quality == pytest.approx(0.5)


def test_the_chain_is_visible() -> None:
    """Which sources a fluid is using is inspectable, not implicit."""
    assert Fluid("nitrogen").chain == ("bicubic", "heos")
    assert Fluid("nitrogen", chain=["heos"]).chain == ("heos",)

    with pytest.raises(ValueError, match="empty backend chain"):
        Fluid("nitrogen", chain=[])


# ------------------------------------------------- phase, and not guessing it


def test_a_declared_liquid_is_solved_as_a_liquid() -> None:
    """The default is *not* to infer phase from ``(p, T)``.

    Asking the property layer to decide has failed twice here from two
    different causes, and both times silently: oxygen at an ambient default is
    a gas at 40 kg/m^3 where LOX is 1140, so the leg solves at a thirtieth of
    the density and every number after it stays plausible. Below the critical
    point a declared fluid is evaluated on its saturated-liquid line, which
    cannot come back as a gas whatever pressure the solve is guessing.
    """
    from feedtwin.comps.elements import conditions_from_fluid
    from feedtwin.props import Fluid

    lox = conditions_from_fluid(Fluid("oxygen"), 3.4e6, 90.0)
    assert lox.rho == pytest.approx(1142.0, abs=15.0)

    ethanol = conditions_from_fluid(Fluid("ethanol"), 3.4e6, 293.15)
    assert ethanol.rho == pytest.approx(789.0, abs=20.0)


def test_multiphase_is_opt_in_and_changes_the_answer() -> None:
    """It has to be reachable, and it has to actually do something -- a flag
    that quietly does nothing is worse than no flag."""
    from feedtwin.comps.elements import conditions_from_fluid
    from feedtwin.props import Fluid

    forced = conditions_from_fluid(Fluid("oxygen"), 3.4e6, 90.0, multiphase=False)
    inferred = conditions_from_fluid(Fluid("oxygen"), 3.4e6, 90.0, multiphase=True)
    # Subcooled LOX is a little denser than saturated; both are liquid.
    assert inferred.rho > forced.rho
    assert forced.rho > 1000.0


def test_a_pressurant_is_untouched_by_the_liquid_rule() -> None:
    """Nitrogen at 4500 psi and room temperature is supercritical -- there is no
    liquid line to sit on, and forcing one would be nonsense."""
    from feedtwin.comps.elements import conditions_from_fluid
    from feedtwin.props import Fluid

    gas = conditions_from_fluid(Fluid("nitrogen"), 3.1e7, 293.15)
    assert 250.0 < gas.rho < 400.0


def test_a_network_defaults_to_single_phase() -> None:
    from feedtwin.solve.network import Network

    assert Network().multiphase is False
    assert Network(multiphase=True).multiphase is True
