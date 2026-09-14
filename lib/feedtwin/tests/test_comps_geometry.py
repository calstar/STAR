"""Bends and flex hose: geometry that changes the answer.

Bend radius is not a cosmetic property. At r/D = 1 a bend carries about three
times the friction factor of a straight run and at r/D = 3 still nearly twice,
so a model that ignores how tightly a line is actually routed under-predicts its
loss substantially.

It is also a hardware limit. Tube bent inside its minimum radius thins and
ovalises; hose bent inside its minimum collapses a smooth-bore liner or fatigues
a convoluted one. Those limits are *reported*, never enforced -- a line bent too
tight is buildable, somebody will build it, and the model should still solve so
that the cost is visible.
"""

from __future__ import annotations

import pytest

from feedtwin.comps import build_component, conditions_from_fluid
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.props import Fluid

M = Provenance.MANUFACTURER
BORE_MM = 7.75


@pytest.fixture(scope="module")
def lox() -> object:
    return conditions_from_fluid(Fluid("LOX"), p=3.0e6, T=90.0)


def _bend(**overrides: Param) -> object:
    params: dict[str, Param] = {
        "bore": Param(BORE_MM, "mm", M, "3/8 x 0.035 tube"),
        "bend_radius": Param(23.0, "mm", M, "as bent"),
    }
    params.update(overrides)
    return build_component(ComponentInstance.build("BD-01", "bend", params))


def _hose(params: dict[str, Param] | None = None, **kwargs: object) -> object:
    base: dict[str, Param] = {
        "bore": Param(9.5, "mm", M, "3/8 in. hose"),
        "length": Param(0.6, "m", M, "cut length"),
    }
    base.update(params or {})
    return build_component(
        ComponentInstance.build("FH-01", "flex_hose", base, **kwargs)  # type: ignore[arg-type]
    )


# ------------------------------------------------------------------- geometry


def test_bend_resistance_depends_on_how_tight_the_bend_is(lox: object) -> None:
    """A tight bend and a long-radius one are not the same component.

    The whole reason bend radius is a first-class parameter rather than an
    elbow class: a tube bent on whatever former was to hand is not a
    long-radius elbow, and the difference is visible in the loss.
    """
    tight = _bend(bend_radius=Param(8.0, "mm", M, "hand bender"))
    easy = _bend(bend_radius=Param(23.0, "mm", M, "r/D = 3"))

    assert tight.diagnostics(0.5, lox)["r_over_D"] == pytest.approx(1.03, rel=1e-2)  # type: ignore[attr-defined]
    assert tight.pressure_drop(0.5, lox) > easy.pressure_drop(0.5, lox)  # type: ignore[attr-defined]


def test_bend_loss_has_a_minimum_near_three_diameters(lox: object) -> None:
    """A real and slightly counter-intuitive result, worth pinning.

    Very tight bends lose to the turn itself; very long-radius ones lose to the
    extra arc length they add. The optimum sits around r/D = 2 to 4. That this
    falls out of the correlation rather than being imposed is a good sign that
    the geometry is reaching it correctly.
    """
    losses = {
        rD: _bend(
            bend_radius=Param(rD * BORE_MM, "mm", M, "swept")
        ).pressure_drop(  # type: ignore[attr-defined]
            0.5, lox
        )
        for rD in (1.0, 3.0, 10.0)
    }
    assert losses[3.0] < losses[1.0], "a very tight bend should cost more"
    assert losses[3.0] < losses[10.0], "a very long bend should cost more"


def test_a_bend_inside_its_minimum_radius_is_reported_not_enforced(
    lox: object,
) -> None:
    """It still solves. The violation is a statement, not a refusal."""
    over_bent = _bend(
        bend_radius=Param(15.0, "mm", M, "as built"),
        outer_diameter=Param(9.525, "mm", M, "3/8 in. OD"),
        min_bend_radius=Param(28.6, "mm", M, "3x OD, shop rule"),
    )
    assert over_bent.pressure_drop(0.5, lox) > 0.0  # type: ignore[attr-defined]

    violations = over_bent.check()  # type: ignore[attr-defined]
    assert len(violations) == 1
    assert violations[0].limit == "min_bend_radius"
    assert violations[0].severity == "error"
    assert "1.57x OD" in violations[0].detail, "quoted against OD, as benders are"


def test_a_bend_within_its_limit_reports_nothing() -> None:
    fine = _bend(
        bend_radius=Param(40.0, "mm", M, "as built"),
        min_bend_radius=Param(28.6, "mm", M, "3x OD"),
    )
    assert fine.check() == []  # type: ignore[attr-defined]


def test_no_limit_declared_means_no_claim() -> None:
    """Silence about a limit is not a pass -- it is an absence of information."""
    assert _bend().check() == []  # type: ignore[attr-defined]


# ------------------------------------------------------------------ flex hose


def test_routing_a_hose_tighter_costs_pressure(lox: object) -> None:
    """Curved flow is genuinely more lossy, and the whole run is curved.

    Unlike a discrete bend -- where the curvature effect is already inside the
    fitting correlation -- a hose bent over its length is curved everywhere, so
    the friction factor itself changes.
    """
    straight = _hose()
    gentle = _hose({"installed_bend_radius": Param(150.0, "mm", M, "routed")})
    tight = _hose({"installed_bend_radius": Param(60.0, "mm", M, "routed")})

    assert (
        straight.pressure_drop(0.5, lox)  # type: ignore[attr-defined]
        < gentle.pressure_drop(0.5, lox)  # type: ignore[attr-defined]
        < tight.pressure_drop(0.5, lox)  # type: ignore[attr-defined]
    )


def test_convoluted_hose_is_far_lossier_than_smooth_bore(lox: object) -> None:
    """The convolutions are in the flow path, not just in the braid."""
    smooth = _hose()
    convoluted = _hose(options={"construction": "convoluted"})

    ratio = (
        convoluted.diagnostics(0.5, lox)["friction_factor"]
        / smooth.diagnostics(0.5, lox)["friction_factor"]  # type: ignore[attr-defined]
    )
    assert ratio == pytest.approx(4.0, rel=1e-9), "the default convolution factor"


def test_end_fittings_are_reported_separately(lox: object) -> None:
    """On a short hose the crimped ends dominate, and that should be visible.

    Rolling them into a single number would hide the case where most of a
    hose's loss is its terminations -- which is the case that tells you a
    shorter hose will not help.
    """
    short = _hose({"length": Param(0.15, "m", M, "short jumper")})
    d = short.diagnostics(0.5, lox)  # type: ignore[attr-defined]

    assert d["dp_end_fittings"] > d["dp_hose"], "ends dominate a short hose"
    assert short.pressure_drop(0.5, lox) == pytest.approx(  # type: ignore[attr-defined]
        d["dp_hose"] + d["dp_end_fittings"]
    )


def test_static_and_dynamic_bend_limits_are_distinguished() -> None:
    """Inside static, outside dynamic -- the case worth surfacing.

    Whether a run actually flexes in service is a fact about the installation
    that the model does not know, so this is a warning rather than an error.
    Silently passing it would lose the one piece of information that matters.
    """
    hose = _hose(
        {
            "installed_bend_radius": Param(120.0, "mm", M, "routed"),
            "min_bend_radius": Param(100.0, "mm", M, "datasheet, static"),
            "min_bend_radius_dynamic": Param(200.0, "mm", M, "datasheet, dynamic"),
        }
    )
    violations = hose.check()  # type: ignore[attr-defined]
    assert len(violations) == 1
    assert violations[0].severity == "warning"
    assert violations[0].limit == "min_bend_radius_dynamic"


def test_breaking_the_static_limit_is_an_error() -> None:
    hose = _hose(
        {
            "installed_bend_radius": Param(80.0, "mm", M, "routed"),
            "min_bend_radius": Param(100.0, "mm", M, "datasheet, static"),
            "min_bend_radius_dynamic": Param(200.0, "mm", M, "datasheet, dynamic"),
        }
    )
    violations = hose.check()  # type: ignore[attr-defined]
    assert [v.severity for v in violations] == ["error"]
    assert "collapses" in violations[0].detail


def test_a_straight_hose_has_no_bend_to_check() -> None:
    hose = _hose({"min_bend_radius": Param(100.0, "mm", M, "datasheet")})
    assert hose.check() == []  # type: ignore[attr-defined]


def test_hose_defaults_are_flagged_as_assumptions() -> None:
    """Roughness, convolution factor and end-fitting K are all placeholders.

    Published flex-hose loss data is scarce and construction varies between
    manufacturers, so these defaults are more suspect than most. A run report
    should say so, which it can only do if they are tagged.
    """
    instance = ComponentInstance.build(
        "FH-01",
        "flex_hose",
        {
            "bore": Param(9.5, "mm", M, "hose"),
            "length": Param(0.6, "m", M, "cut length"),
        },
    )
    assumed = set(instance.assumptions())
    assert {"roughness", "convolution_factor", "end_fitting_K"} <= assumed
