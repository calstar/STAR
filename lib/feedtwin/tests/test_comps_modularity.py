"""The component library's seams, exercised from outside.

Same purpose as the property layer's modularity tests: "nothing hardcoded"
decays silently, because adding a special case is always the cheap move and
nothing fails when a seam stops working -- the code still runs, it just can no
longer be extended without editing it.

Three seams here, and one principle:

* ``register_fitting`` -- a loss correlation the package never shipped.
* ``register_builder`` -- the physics behind a (type, model) pair, which is how
  a component type declared in ``components.toml`` acquires behaviour.
* ``options`` -- categorical configuration, of which the friction correlation is
  the one this phase cared about most.

And the principle: **measured data supersedes the correlation**, for every
component type, from the first phase that has components at all.
"""

from __future__ import annotations

import pytest

from feedtwin.comps import (
    FlowConditions,
    FittingContext,
    HydraulicComponent,
    build_component,
    fitting_K,
    register_builder,
    register_fitting,
    registered_builders,
    registered_fittings,
)
from feedtwin.model import (
    ComponentInstance,
    Param,
    Provenance,
    SpecError,
    registered_component_types,
)
from feedtwin.model.curve import Curve, CurveError

M = Provenance.MANUFACTURER
WATER = FlowConditions(rho=999.0, mu=1.138e-3, p_upstream=1.0e6)


def _measured_curve(reference: str = "CF-2026-03") -> Curve:
    """A deliberately steep measured curve, so 'did the data win?' is obvious."""
    return Curve(
        x=(0.0, 1.0, 2.0),
        y=(0.0, 5.0, 20.0),
        x_unit="kg/s",
        y_unit="bar",
        source=Provenance.MEASURED,
        reference=reference,
    )


# ------------------------------------------------------------------- fittings


def test_a_fitting_correlation_can_be_added_from_outside() -> None:
    """A loss coefficient this package never shipped, selected by config."""
    register_fitting("unobtainium_swirler", lambda ctx: 42.0)
    assert "unobtainium_swirler" in registered_fittings()

    ctx = FittingContext(bore=0.01, Re=1e5, roughness=1.5e-6, fd=0.018)
    assert fitting_K("unobtainium_swirler", ctx) == 42.0


def test_an_unknown_fitting_lists_what_exists() -> None:
    ctx = FittingContext(bore=0.01, Re=1e5, roughness=1.5e-6, fd=0.018)
    with pytest.raises(ValueError, match="registered"):
        fitting_K("teleporter", ctx)


def test_shipped_fittings_all_produce_a_finite_coefficient() -> None:
    """Every registered adapter is actually callable with the uniform context.

    The registry's whole point is that correlations with very different
    ``fluids`` signatures are reachable through one shape. An adapter that
    unpacks the context wrongly fails here rather than the first time somebody
    selects that fitting in a config.
    """
    ctx = FittingContext(bore=0.01, Re=1.0e5, roughness=1.5e-6, fd=0.018)
    for name in registered_fittings():
        K = fitting_K(name, ctx)
        assert K == pytest.approx(K), f"{name} produced NaN"
        assert K >= 0.0, f"{name} produced a negative resistance"


# -------------------------------------------------------------------- builders


def test_physics_can_be_registered_for_a_new_type_model_pair() -> None:
    """How a component declared in components.toml acquires behaviour."""

    class ConstantDrop(HydraulicComponent):
        def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
            return 12345.0

    register_builder("pipe", "constant_for_test", ConstantDrop)
    assert ("pipe", "constant_for_test") in registered_builders()

    # The schema does not declare that model, so the instance cannot be built
    # through it -- which is the schema doing its job, not a gap.
    with pytest.raises(SpecError, match="unknown model"):
        ComponentInstance.build(
            "FL-01",
            "pipe",
            {"length": Param(1.0, "m", M, ""), "bore": Param(10.0, "mm", M, "")},
            model="constant_for_test",
        )


def test_a_declared_model_with_no_physics_fails_clearly() -> None:
    """The honest failure when a schema is ahead of the implementation.

    ``components.toml`` can declare a model before Phase 03 implements it. That
    should say so, naming what *is* implemented, rather than failing somewhere
    inside a solve.
    """
    from feedtwin.model import ComponentSpec, ParamSpec, register_component_spec

    register_component_spec(
        ComponentSpec(
            type="test_unimplemented",
            description="Declared but not built.",
            models=("someday",),
            params=(ParamSpec("bore", "length", "Bore."),),
        )
    )
    instance = ComponentInstance.build(
        "X-01", "test_unimplemented", {"bore": Param(10.0, "mm", M, "")}
    )
    with pytest.raises(SpecError, match="no implementation"):
        build_component(instance)


def test_every_shipped_type_and_model_has_physics() -> None:
    """The reverse gap: a schema model with nothing behind it.

    Catches the declaration and the implementation drifting apart, which is the
    predictable cost of keeping schemas in data and physics in code.
    """
    from feedtwin.model import get_component_spec

    implemented = set(registered_builders())
    missing = [
        (type_name, model)
        for type_name in registered_component_types()
        for model in get_component_spec(type_name).models
        if (type_name, model) not in implemented
        and not type_name.startswith(("test_", "burst_disc"))
    ]
    assert not missing, f"declared but not implemented: {missing}"


# -------------------------------------------------------------------- measured


@pytest.mark.parametrize("type_name", ["pipe", "orifice", "valve", "check_valve"])
def test_measured_data_supersedes_the_correlation_for_every_type(
    type_name: str,
) -> None:
    """The Phase 12 principle, available from the phase that has components.

    A measured curve replaces the correlation outright. Note the contrast with
    the property layer, where measured data falls *through* to an equation of
    state outside its range: a property has a defensible fallback and a
    component does not.
    """
    instance = ComponentInstance.build(
        "X-01",
        type_name,
        {},
        curves={"dp_mdot": _measured_curve()},
        model="measured",
    )
    component = build_component(instance)

    # Exactly the measured value, not something near it.
    assert component.pressure_drop(1.0, WATER) == pytest.approx(5.0e5)
    assert component.pressure_drop(1.5, WATER) == pytest.approx(12.5e5)  # interpolated
    assert instance.curves["dp_mdot"].source is Provenance.MEASURED


def test_measured_data_refuses_outside_its_range() -> None:
    """It does not fall back to a correlation, and does not extrapolate.

    Silently switching to a correlation halfway up a flow sweep would put a kink
    in the result that nobody asked for and nobody would see.
    """
    component = build_component(
        ComponentInstance.build(
            "X-01", "pipe", {}, curves={"dp_mdot": _measured_curve()}, model="measured"
        )
    )
    with pytest.raises(CurveError, match="outside the curve's range"):
        component.pressure_drop(5.0, WATER)


def test_the_measured_model_says_what_it_needs() -> None:
    with pytest.raises(SpecError, match="dp_mdot"):
        ComponentInstance.build("X-01", "pipe", {}, model="measured")


def test_a_curve_must_declare_its_provenance_and_dimensions() -> None:
    """Same rules as a scalar: where it came from, and what it measures."""
    with pytest.raises(TypeError, match="where it came from"):
        Curve((0.0, 1.0), (0.0, 1.0), "kg/s", "bar", "measured")  # type: ignore[arg-type]

    wrong_axis = Curve(
        x=(0.0, 1.0),
        y=(0.0, 1.0),
        x_unit="m",  # a length, not a mass flow
        y_unit="bar",
        source=Provenance.MEASURED,
    )
    with pytest.raises(SpecError, match="expected a mass_flow"):
        ComponentInstance.build(
            "X-01", "pipe", {}, curves={"dp_mdot": wrong_axis}, model="measured"
        )


def test_a_tabulated_valve_characteristic_comes_from_a_curve() -> None:
    """Cv against travel, as a manufacturer's chart or a bench test gives it."""
    curve = Curve(
        x=(0.0, 0.25, 0.5, 0.75, 1.0),
        y=(0.0, 0.4, 1.1, 2.0, 3.0),
        x_unit="-",
        y_unit="Cv",
        source=Provenance.MANUFACTURER,
        reference="vendor chart, figure 4",
    )
    valve = build_component(
        ComponentInstance.build(
            "SOL-01",
            "valve",
            {"Cv": Param(3.0, "Cv", M, "full open"), "bore": Param(10.0, "mm", M, "")},
            curves={"cv_position": curve},
            options={"characteristic": "tabulated"},
        )
    )
    assert valve.effective_cv(0.5) == pytest.approx(1.1)  # type: ignore[attr-defined]
    assert valve.effective_cv(1.0) == pytest.approx(3.0)  # type: ignore[attr-defined]


def test_a_tabulated_characteristic_without_its_curve_fails_clearly() -> None:
    valve = build_component(
        ComponentInstance.build(
            "SOL-01",
            "valve",
            {"Cv": Param(3.0, "Cv", M, ""), "bore": Param(10.0, "mm", M, "")},
            options={"characteristic": "tabulated"},
        )
    )
    with pytest.raises(SpecError, match="cv_position"):
        valve.effective_cv(0.5)  # type: ignore[attr-defined]


# --------------------------------------------------------- the solver interface


def test_the_residual_form_agrees_with_the_causal_one() -> None:
    """The provisional protocol, checked against the physics it wraps.

    ``residuals`` is expected to move when Phase 04 assembles a real Jacobian.
    What must not move is this: whatever shape the solver interface takes, it
    has to agree with ``pressure_drop``, which is the form validated against
    published results. This test is the bridge, and it is the one to re-run when
    that interface changes.
    """
    from feedtwin.model.component import EvalContext, PortState

    line = build_component(
        ComponentInstance.build(
            "FL-01",
            "pipe",
            {"length": Param(2.0, "m", M, ""), "bore": Param(10.0, "mm", M, "")},
        )
    )
    line.conditions_provider = lambda port, signals: WATER

    mdot, p_in = 1.0, 1.0e6
    expected_drop = line.pressure_drop(mdot, WATER)

    ctx = EvalContext(
        ports=(PortState(p=p_in, h=0.0), PortState(p=p_in - expected_drop, h=0.0)),
        flows=(mdot,),
    )
    assert line.residuals(ctx)[0] == pytest.approx(0.0, abs=1e-6)

    # Reverse flow: the loss opposes the flow, so the sign follows it.
    reversed_ctx = EvalContext(
        ports=(PortState(p=p_in, h=0.0), PortState(p=p_in + expected_drop, h=0.0)),
        flows=(-mdot,),
    )
    assert line.residuals(reversed_ctx)[0] == pytest.approx(0.0, abs=1e-6)


def test_evaluating_residuals_without_a_conditions_provider_says_so() -> None:
    """Phase 04 supplies it; until then the failure should be legible."""
    from feedtwin.model.component import EvalContext, PortState

    line = build_component(
        ComponentInstance.build(
            "FL-01",
            "pipe",
            {"length": Param(1.0, "m", M, ""), "bore": Param(10.0, "mm", M, "")},
        )
    )
    ctx = EvalContext(
        ports=(PortState(p=1e6, h=0.0), PortState(p=9e5, h=0.0)), flows=(1.0,)
    )
    with pytest.raises(SpecError, match="conditions provider"):
        line.residuals(ctx)
