"""Tank geometry, ullage collapse, and constant-pressure expulsion.

The headline check is :func:`test_expulsion_matches_closed_form`: for an ideal
gas with no interfacial loss, holding a tank at constant pressure while liquid
leaves needs exactly ``m = p dV / (R T_in)``, *independent of the ullage's
starting temperature*. That independence is a strong test -- it fails loudly if
the expansion-work term is missing or mis-signed, which is the single easiest
thing to get wrong in a tank model.
"""

from __future__ import annotations

import math
from dataclasses import replace

import pytest
from scipy.integrate import quad

from feedtwin.model.units import get_unit
from feedtwin.props import Fluid
from feedtwin.vessels import (
    ConductionCollapse,
    CylindricalTank,
    Head,
    LiquidThermal,
    NoCollapse,
    TabulatedGeometry,
    Tank,
    build_collapse_model,
    build_geometry,
    level_of_volume,
    registered_collapse_models,
    registered_geometries,
)

#: Exact, from the library's own table -- a truncated 6894.757 leaves a
#: 0.02 Pa round-trip error that these tolerances would otherwise chase.
PSI = get_unit("psi").factor
R_UNIVERSAL = 8.31446261815324


@pytest.fixture(scope="module")
def geometry() -> CylindricalTank:
    """6 in. tank, 600 mm barrel, 2:1 ellipsoidal heads. The team's shape."""
    return CylindricalTank(diameter=0.152, barrel_length=0.600)


@pytest.fixture(scope="module")
def lox() -> Fluid:
    return Fluid("oxygen")


@pytest.fixture(scope="module")
def gn2() -> Fluid:
    return Fluid("nitrogen")


# ---------------------------------------------------------------- geometry


def test_cylinder_volume_matches_closed_form(geometry: CylindricalTank) -> None:
    r, c = 0.076, 0.038
    expected = 2.0 * (2.0 / 3.0) * math.pi * r * r * c + math.pi * r * r * 0.600
    assert geometry.total_volume == pytest.approx(expected, rel=1e-12)


def test_hemispherical_heads_give_a_sphere() -> None:
    """Zero barrel with two hemispherical heads is a sphere, exactly."""
    r = 0.076
    sphere = CylindricalTank(
        diameter=2 * r,
        barrel_length=0.0,
        bottom=Head(radius=r, ratio=1.0),
        top=Head(radius=r, ratio=1.0),
    )
    assert sphere.total_volume == pytest.approx(4.0 / 3.0 * math.pi * r**3, rel=1e-12)
    assert sphere.wetted_area(sphere.height) == pytest.approx(
        4.0 * math.pi * r * r, rel=1e-12
    )
    assert sphere.height == pytest.approx(2 * r, rel=1e-12)


def test_flat_heads_give_a_cylinder() -> None:
    r = 0.076
    tube = CylindricalTank(
        diameter=2 * r, barrel_length=0.5, bottom=Head.flat(), top=Head.flat()
    )
    assert tube.total_volume == pytest.approx(math.pi * r * r * 0.5, rel=1e-12)
    assert tube.height == pytest.approx(0.5, rel=1e-12)


def test_volume_endpoints_are_exact(geometry: CylindricalTank) -> None:
    assert geometry.volume_below(0.0) == 0.0
    assert geometry.volume_below(geometry.height) == pytest.approx(
        geometry.total_volume, rel=1e-14
    )


def test_level_inverts_volume(geometry: CylindricalTank) -> None:
    for level in (0.005, 0.02, 0.038, 0.3, 0.62, 0.66):
        volume = geometry.volume_below(level)
        assert level_of_volume(geometry, volume) == pytest.approx(level, abs=1e-9)


def test_cross_section_is_the_derivative_of_volume(geometry: CylindricalTank) -> None:
    """dV/dh must equal the horizontal area, or collapse gets the wrong area."""
    h, eps = 0.020, 1e-7
    numeric = (geometry.volume_below(h + eps) - geometry.volume_below(h - eps)) / (
        2 * eps
    )
    assert numeric == pytest.approx(geometry.cross_section(h), rel=1e-5)


def test_interface_shrinks_in_the_head(geometry: CylindricalTank) -> None:
    """A nearly-empty tank has far less interface than a half-full one."""
    assert geometry.cross_section(0.010) < 0.5 * geometry.cross_section(0.3)


def test_tabulated_geometry_round_trips() -> None:
    table = TabulatedGeometry(levels=[0.0, 0.1, 0.2], volumes=[0.0, 1e-3, 3e-3])
    assert table.total_volume == 3e-3
    assert table.volume_below(0.05) == pytest.approx(0.5e-3)
    # Cross-section is differenced from the volume table when not supplied.
    assert table.cross_section(0.15) == pytest.approx(2e-2)
    assert level_of_volume(table, 1e-3) == pytest.approx(0.1, abs=1e-9)


def test_tabulated_geometry_rejects_a_shrinking_tank() -> None:
    with pytest.raises(ValueError, match="non-decreasing"):
        TabulatedGeometry(levels=[0.0, 0.1], volumes=[1e-3, 0.0])


def test_geometry_registry() -> None:
    assert "cylindrical" in registered_geometries()
    built = build_geometry("cylindrical", diameter=0.152, barrel_length=0.6)
    assert built.total_volume == pytest.approx(
        CylindricalTank(diameter=0.152, barrel_length=0.6).total_volume
    )
    with pytest.raises(KeyError, match="unknown tank geometry"):
        build_geometry("bathtub")


# ---------------------------------------------------------------- collapse


def test_conduction_rate_integrates_to_the_closed_form(lox: Fluid) -> None:
    """The instantaneous flux must integrate to 2 A dT sqrt(k rho c t / pi)."""
    liquid = LiquidThermal(
        conductivity=lox.get("k", T=90.0, q=0.0),
        density=lox.get("rho", T=90.0, q=0.0),
        heat_capacity=lox.get("cp", T=90.0, q=0.0),
    )
    model = ConductionCollapse()
    area = 0.018
    integrated, _ = quad(
        lambda t: model.heat_rate(area, 300.0, 90.0, liquid, t), 0.0, 5.0
    )
    closed = model.heat_total(area, 300.0, 90.0, liquid, 5.0)
    # The gap is entirely MIN_CONTACT_TIME clipping the integrable singularity.
    # It must stay under 1% of a five-second burn, which is what makes the
    # floor a numerical guard rather than a modelling choice.
    assert integrated == pytest.approx(closed, rel=0.01)
    assert integrated < closed


def test_penetration_depth_is_millimetres_over_a_burn(lox: Fluid) -> None:
    """The physical claim behind using a transient model at all."""
    liquid = LiquidThermal(
        conductivity=lox.get("k", T=90.0, q=0.0),
        density=lox.get("rho", T=90.0, q=0.0),
        heat_capacity=lox.get("cp", T=90.0, q=0.0),
    )
    assert liquid.penetration_depth(5.0) == pytest.approx(1.1e-3, abs=0.2e-3)
    # sqrt(t): a 12x longer soak deepens the layer by sqrt(12) ~ 3.5, not 12.
    ratio = liquid.penetration_depth(60.0) / liquid.penetration_depth(5.0)
    assert ratio == pytest.approx(math.sqrt(12.0), rel=1e-9)


def test_collapse_flux_decays_with_contact_time(lox: Fluid) -> None:
    """Why repressurising right before ignition helps: it resets the clock."""
    liquid = LiquidThermal(0.15, 1140.0, 1700.0)
    model = ConductionCollapse()
    fresh = model.heat_rate(0.018, 300.0, 90.0, liquid, 1.0)
    stale = model.heat_rate(0.018, 300.0, 90.0, liquid, 100.0)
    assert fresh == pytest.approx(10.0 * stale, rel=1e-9)


def test_no_collapse_is_a_named_model() -> None:
    assert (
        NoCollapse().heat_rate(0.018, 300.0, 90.0, LiquidThermal(1, 1, 1), 5.0) == 0.0
    )
    assert set(registered_collapse_models()) >= {"none", "conduction"}
    assert build_collapse_model("conduction", enhancement=2.0).name == "conduction"
    with pytest.raises(KeyError, match="unknown ullage collapse model"):
        build_collapse_model("magic")


# -------------------------------------------------------------------- tank


def test_initial_state_round_trips_pressure(
    lox: Fluid, gn2: Fluid, geometry: CylindricalTank
) -> None:
    tank = Tank(lox, gn2, geometry)
    state = tank.initial_state(
        pressure=500 * PSI,
        liquid_mass=9.0,
        liquid_temperature=90.0,
        gas_temperature=293.15,
    )
    # 1e-6, not 1e-9: the default chain is the BICUBIC table, whose
    # interpolation error this round trip measures. On HEOS it is exact.
    assert tank.pressure(state) == pytest.approx(500 * PSI, rel=1e-6)
    assert tank.gas_temperature(state) == pytest.approx(293.15, rel=1e-6)


def test_overfull_tank_refuses(
    lox: Fluid, gn2: Fluid, geometry: CylindricalTank
) -> None:
    tank = Tank(lox, gn2, geometry)
    with pytest.raises(ValueError, match="does not fit"):
        tank.initial_state(
            pressure=500 * PSI,
            liquid_mass=500.0,
            liquid_temperature=90.0,
            gas_temperature=293.15,
        )


def test_outlet_pressure_includes_the_liquid_column(
    lox: Fluid, gn2: Fluid, geometry: CylindricalTank
) -> None:
    tank = Tank(lox, gn2, geometry)
    state = tank.initial_state(
        pressure=500 * PSI,
        liquid_mass=9.0,
        liquid_temperature=90.0,
        gas_temperature=293.15,
    )
    head = tank.outlet_pressure(state) - tank.pressure(state)
    expected = tank.liquid_density(state) * 9.80665 * tank.level(state)
    assert head == pytest.approx(expected, rel=1e-12)
    assert head > 0.0


@pytest.mark.parametrize("ullage_temperature", [150.0, 293.15, 400.0])
def test_expulsion_matches_closed_form(
    lox: Fluid, gn2: Fluid, geometry: CylindricalTank, ullage_temperature: float
) -> None:
    """Constant-pressure expulsion needs ``m = p dV / (R T_in)``.

    From the energy balance with ``p`` held: ``(cv/R) p Vdot = mdot cp T_in -
    p Vdot`` reduces to ``mdot = p Vdot / (R T_in)``, which does **not** contain
    the ullage's own temperature. Getting the same answer from a 150 K ullage
    and a 400 K one is the real content of this test; a missing or mis-signed
    expansion-work term breaks that independence immediately.
    """
    tank = Tank(lox, gn2, geometry, collapse=NoCollapse())
    state = tank.initial_state(
        pressure=500 * PSI,
        liquid_mass=9.0,
        liquid_temperature=90.0,
        gas_temperature=ullage_temperature,
    )
    result = tank.pressurant_for_expulsion(
        state, mdot_liquid=1.5, duration=5.0, inlet_temperature=293.15, steps=2000
    )

    expelled = 9.0 - result["liquid_remaining"]
    volume = expelled / tank.liquid_density(state)
    r_specific = R_UNIVERSAL / gn2.constants()["molar_mass"]
    ideal = 500 * PSI * volume / (r_specific * 293.15)

    # Within 1%: the residual is the real-gas correction, checked below.
    assert result["mass"] == pytest.approx(ideal, rel=0.01)
    # And the pressure really was held, which is what makes the comparison valid.
    assert abs(result["pressure_error"]) < 1.0


def test_expulsion_deviation_is_the_compressibility(
    lox: Fluid, gn2: Fluid, geometry: CylindricalTank
) -> None:
    """The ~0.5% gap from ideal is Z, not numerical slop."""
    tank = Tank(lox, gn2, geometry, collapse=NoCollapse())
    state = tank.initial_state(
        pressure=500 * PSI,
        liquid_mass=9.0,
        liquid_temperature=90.0,
        gas_temperature=293.15,
    )
    result = tank.pressurant_for_expulsion(
        state, mdot_liquid=1.5, duration=5.0, inlet_temperature=293.15, steps=2000
    )
    volume = (9.0 - result["liquid_remaining"]) / tank.liquid_density(state)
    r_specific = R_UNIVERSAL / gn2.constants()["molar_mass"]
    ideal = 500 * PSI * volume / (r_specific * 293.15)

    z = gn2.get("Z", p=500 * PSI, T=293.15)
    assert z < 1.0  # nitrogen is attractive-dominated here
    # Real gas needs MORE mass for the same pressure, by roughly 1/Z.
    assert result["mass"] / ideal == pytest.approx(1.0 / z, rel=0.01)


def test_collapse_costs_pressurant_not_pressure(
    lox: Fluid, gn2: Fluid, geometry: CylindricalTank
) -> None:
    """The point of the whole collapse model.

    With the regulator holding tank pressure, interfacial heat loss does not
    show up in the pressure trace at all -- both runs hold 500 psi exactly. It
    shows up as extra pressurant, which drains the COPV faster, which lowers
    regulator inlet, which moves the outlet through the supply coefficient.
    """
    results = {}
    for name, model in (("none", NoCollapse()), ("conduction", ConductionCollapse())):
        tank = Tank(lox, gn2, geometry, collapse=model)
        state = tank.initial_state(
            pressure=500 * PSI,
            liquid_mass=9.0,
            liquid_temperature=90.0,
            gas_temperature=293.15,
        )
        results[name] = tank.pressurant_for_expulsion(
            state, mdot_liquid=1.5, duration=5.0, inlet_temperature=293.15
        )

    # Both held pressure to well under a psi: the effect is invisible there.
    for result in results.values():
        assert abs(result["pressure_error"]) < 1.0

    extra = results["conduction"]["mass"] / results["none"]["mass"] - 1.0
    # Several percent over a 5 s burn -- not negligible, and not the 20%+ a
    # back-of-envelope estimate that ignores expansion work suggests.
    assert 0.03 < extra < 0.12
    assert results["conduction"]["heat_to_liquid"] > 0.0
    assert results["none"]["heat_to_liquid"] == 0.0


def test_enhancement_increases_demand_monotonically(
    lox: Fluid, gn2: Fluid, geometry: CylindricalTank
) -> None:
    masses = []
    for factor in (1.0, 2.0, 4.0):
        tank = Tank(lox, gn2, geometry, collapse=ConductionCollapse(enhancement=factor))
        state = tank.initial_state(
            pressure=500 * PSI,
            liquid_mass=9.0,
            liquid_temperature=90.0,
            gas_temperature=293.15,
        )
        masses.append(
            tank.pressurant_for_expulsion(
                state, mdot_liquid=1.5, duration=5.0, inlet_temperature=293.15
            )["mass"]
        )
    assert masses[0] < masses[1] < masses[2]


def test_helium_needs_less_mass_than_nitrogen(
    lox: Fluid, geometry: CylindricalTank
) -> None:
    """Sanity on the pressurant choice: helium's R is 7x nitrogen's."""
    masses = {}
    for name in ("helium", "nitrogen"):
        tank = Tank(lox, Fluid(name), geometry, collapse=NoCollapse())
        state = tank.initial_state(
            pressure=500 * PSI,
            liquid_mass=9.0,
            liquid_temperature=90.0,
            gas_temperature=293.15,
        )
        masses[name] = tank.pressurant_for_expulsion(
            state, mdot_liquid=1.5, duration=5.0, inlet_temperature=293.15
        )["mass"]
    assert masses["helium"] < 0.2 * masses["nitrogen"]


def test_liquid_in_the_ullage_refuses(geometry: CylindricalTank) -> None:
    """A pressurant that condenses at tank conditions is not an ullage gas."""
    tank = Tank(Fluid("oxygen"), Fluid("nitrogen"), geometry)
    with pytest.raises(ValueError, match="is a liquid"):
        tank.initial_state(
            pressure=500 * PSI,
            liquid_mass=9.0,
            liquid_temperature=90.0,
            gas_temperature=90.0,
        )


def test_repressurisation_resets_the_interface_clock(
    lox: Fluid, gn2: Fluid, geometry: CylindricalTank
) -> None:
    tank = Tank(lox, gn2, geometry)
    state = tank.initial_state(
        pressure=500 * PSI,
        liquid_mass=9.0,
        liquid_temperature=90.0,
        gas_temperature=293.15,
    )
    # Age the clock directly rather than marching: this is a test of the
    # sqrt(t) flux and its reset, not of the integrator.
    aged = replace(state, contact_time=600.0)
    assert tank.rates(aged).heat_to_liquid < tank.rates(state).heat_to_liquid

    fresh = aged.repressurised()
    assert fresh.contact_time == 0.0
    assert tank.rates(fresh).heat_to_liquid > tank.rates(aged).heat_to_liquid

    # Quantitatively: flux goes as 1/sqrt(t), so 100x the age is 10x less flux.
    old_state = replace(state, contact_time=100.0)
    young = replace(state, contact_time=1.0)
    assert tank.rates(young).heat_to_liquid == pytest.approx(
        10.0 * tank.rates(old_state).heat_to_liquid, rel=1e-9
    )
