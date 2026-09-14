"""Phase 15: the heat a line's own metal gives the gas flowing through it.

Every component in this model was adiabatic, which is the assumption a stand
disproves in the most visible way available: run a blowdown and frost, then
icicles, form on the fittings downstream of the regulator. Frost on the metal
is not decoration -- it is the evidence that the metal got cold, and metal only
gets cold by giving its heat to something. That something is the gas.

What is tested here is the giving, not the sitting. A line that has been loaded
for an hour is colder than one loaded a minute ago, and none of that is modelled
on purpose: predicting it needs an ambient film, an insulation state and a clock,
to arrive at a starting temperature that the fluid standing in the line already
tells us.
"""

from __future__ import annotations

import math

import pytest

from feedtwin.comps.wall import (
    STAINLESS_DENSITY,
    LineWall,
    stainless_capacity,
)


def a_line(mass: float = 0.4, length: float = 0.5, bore: float = 0.0109) -> LineWall:
    return LineWall(mass=mass, area=math.pi * bore * length, bore=bore)


#: Nitrogen near 200 K and 30 bar, which is what a press line actually carries.
N2 = dict(density=50.0, viscosity=1.29e-5, conductivity=0.0185, heat_capacity=1080.0)


class TestCapacity:
    """Stainless holds a fraction of its room-temperature heat when it is cold.

    This is the whole reason a LOX line and a pressurant line cannot share a
    number. 316 at 77 K holds about 190 J/(kg.K) against 500 at room
    temperature -- a factor of 2.6 -- so a model with one constant cp is wrong
    by that factor on exactly the lines where the metal is coldest.
    """

    @pytest.mark.parametrize(
        "temperature, expected",
        [(77.0, 190.0), (100.0, 230.0), (200.0, 400.0), (293.0, 494.0), (300.0, 500.0)],
    )
    def test_matches_nist_values(self, temperature: float, expected: float) -> None:
        assert stainless_capacity(temperature) == pytest.approx(expected, abs=1.0)

    def test_cold_metal_holds_far_less(self) -> None:
        ratio = stainless_capacity(293.0) / stainless_capacity(77.0)
        assert 2.0 < ratio < 3.5, f"316 cp should fall ~2.6x by 77 K, got {ratio:.2f}"

    def test_rises_monotonically(self) -> None:
        temps = [20.0, 50.0, 77.0, 100.0, 150.0, 200.0, 250.0, 300.0, 400.0]
        values = [stainless_capacity(t) for t in temps]
        assert values == sorted(values)

    def test_clamped_outside_the_table(self) -> None:
        """Beyond the table it holds the end value rather than extrapolating a
        piecewise fit into a negative heat capacity."""
        assert stainless_capacity(1.0) == pytest.approx(stainless_capacity(20.0))
        assert stainless_capacity(9_000.0) == pytest.approx(stainless_capacity(400.0))

    def test_capacity_scales_with_mass(self) -> None:
        assert a_line(mass=0.8).capacity(293.0) == pytest.approx(
            2.0 * a_line(mass=0.4).capacity(293.0)
        )


class TestExchange:
    def test_no_flow_no_heat(self) -> None:
        """The single most important guard in this file.

        With no flow there is no convection, and a wall that leaked heat into a
        stationary node would warm a stand that is just sitting there -- which
        is the soak model this deliberately does not have, arriving by the back
        door and wrong.
        """
        out = a_line().exchange(
            mdot=0.0, wall_temperature=293.0, inlet_temperature=100.0, **N2
        )
        assert out.heat == 0.0
        assert out.effectiveness == 0.0

    def test_warm_wall_warms_cold_gas(self) -> None:
        out = a_line().exchange(
            mdot=0.15, wall_temperature=293.0, inlet_temperature=200.0, **N2
        )
        assert out.heat > 0.0
        assert 200.0 < out.outlet_temperature < 293.0

    def test_cold_wall_cools_warm_gas(self) -> None:
        """Runs both ways. A LOX-cold line chills the gas put through it, which
        is the chilldown of a downstream fitting rather than a special case."""
        out = a_line().exchange(
            mdot=0.15, wall_temperature=95.0, inlet_temperature=290.0, **N2
        )
        assert out.heat < 0.0
        assert 95.0 < out.outlet_temperature < 290.0

    def test_gas_never_overshoots_the_wall(self) -> None:
        """Effectiveness is bounded by one, so the stream can approach the metal
        and never pass it, whatever the geometry."""
        for mass, length in ((50.0, 100.0), (0.01, 0.01)):
            out = a_line(mass=mass, length=length).exchange(
                mdot=1e-4, wall_temperature=293.0, inlet_temperature=100.0, **N2
            )
            assert out.outlet_temperature <= 293.0 + 1e-9
            assert 0.0 <= out.effectiveness <= 1.0

    def test_more_flow_means_less_warming_per_kilogram(self) -> None:
        """NTU falls as mdot rises: a faster stream has less residence time, so
        each kilogram picks up less even though the total heat goes up."""
        slow = a_line().exchange(
            mdot=0.02, wall_temperature=293.0, inlet_temperature=150.0, **N2
        )
        fast = a_line().exchange(
            mdot=0.40, wall_temperature=293.0, inlet_temperature=150.0, **N2
        )
        assert slow.effectiveness > fast.effectiveness
        assert slow.outlet_temperature > fast.outlet_temperature
        assert fast.heat > slow.heat, "total heat still rises with flow"

    def test_more_metal_area_means_more_pickup(self) -> None:
        short = a_line(length=0.1).exchange(
            mdot=0.15, wall_temperature=293.0, inlet_temperature=150.0, **N2
        )
        long = a_line(length=2.0).exchange(
            mdot=0.15, wall_temperature=293.0, inlet_temperature=150.0, **N2
        )
        assert long.effectiveness > short.effectiveness

    def test_heat_agrees_with_the_temperature_rise(self) -> None:
        """Q = mdot.cp.dT, or the wall's book-keeping does not close."""
        out = a_line().exchange(
            mdot=0.15, wall_temperature=293.0, inlet_temperature=180.0, **N2
        )
        assert out.heat == pytest.approx(
            0.15 * N2["heat_capacity"] * (out.outlet_temperature - 180.0), rel=1e-9
        )

    def test_reverse_flow_is_treated_by_magnitude(self) -> None:
        """A negative mdot is the solver's sign convention, not a different
        physical situation; the line still picks up heat from its metal."""
        forward = a_line().exchange(
            mdot=0.15, wall_temperature=293.0, inlet_temperature=180.0, **N2
        )
        back = a_line().exchange(
            mdot=-0.15, wall_temperature=293.0, inlet_temperature=180.0, **N2
        )
        assert back.outlet_temperature == pytest.approx(forward.outlet_temperature)
        assert back.heat == pytest.approx(forward.heat)

    def test_laminar_uses_a_fixed_nusselt(self) -> None:
        """Below the laminar limit Dittus-Boelter does not apply. It is not merely
        inaccurate there -- it tends to zero with flow, so a trickle would come
        out predicting no heat transfer at all, when the real answer is the
        fully-developed laminar value.
        """
        thick = dict(N2, viscosity=5.0e-3)  # syrup, to force Re well under the limit
        out = a_line().exchange(
            mdot=1e-3, wall_temperature=293.0, inlet_temperature=150.0, **thick
        )
        assert out.heat > 0.0
        assert out.effectiveness > 0.0

    @pytest.mark.parametrize("bad", ["density", "viscosity", "conductivity"])
    def test_missing_property_is_not_a_crash(self, bad: str) -> None:
        """A property gap must cost the line its heat, not the tick its life."""
        props = dict(N2, **{bad: 0.0})
        out = a_line().exchange(
            mdot=0.15, wall_temperature=293.0, inlet_temperature=150.0, **props
        )
        assert out.heat == 0.0


class TestMassFromGeometry:
    """The tube's own metal, which is the part a drawing can compute."""

    def test_half_inch_tube_mass_is_right(self) -> None:
        """1/2 in. x 0.035 in. wall 316: about 265 g/m, so 255 mm is ~67 g --
        against roughly 200 g for the two unions holding it on. The fittings
        dominating the tube is the reason `fitting_mass` exists at all.
        """
        bore, thickness, length = 0.010922, 0.000889, 1.0
        outer = bore + 2.0 * thickness
        mass = math.pi / 4.0 * (outer**2 - bore**2) * length * STAINLESS_DENSITY
        assert mass == pytest.approx(0.265, abs=0.02)


class TestTheIcicleQuestion:
    """The numbers behind the answer given to the stand's own observation.

    Two paths could warm the gas: the room, through frost and the tube wall
    (Path B), and the line's own thermal mass (Path A). Only one of them is
    worth modelling, and the arithmetic here is why.
    """

    def test_the_room_is_negligible_over_a_burn(self) -> None:
        """Path B. Still air onto 0.4 m^2 of cold pipe is a few watts; even a
        generous frosted-surface figure is tens. Against a 150 g/s stream that
        is hundredths of a kelvin -- so the room is not what warms the gas.
        """
        mdot, cp = 0.15, 1080.0
        still = 6.0 * 0.4 * (293.0 - 200.0) / 100.0  # ~2 W/m2K over 0.4 m2
        frosted = 32.0  # W, a deliberately generous frosted-surface figure
        for watts in (still, frosted):
            rise = watts / (mdot * cp)
            assert rise < 0.25, f"{watts:.0f} W gave {rise:.3f} K"

    def test_the_lines_own_metal_is_not(self) -> None:
        """Path A. The same stream through 0.4 kg of room-temperature steel
        picks up kelvins, not hundredths -- an order of magnitude that decides
        which one gets a model.
        """
        out = a_line(mass=0.4).exchange(
            mdot=0.15, wall_temperature=293.0, inlet_temperature=200.0, **N2
        )
        rise = out.outlet_temperature - 200.0
        assert rise > 1.0, f"path A should be kelvins, got {rise:.2f} K"

    def test_the_metal_runs_out(self) -> None:
        """And it is a first-run effect. The wall has a fixed number of joules
        in it; spend them and the second run of the day starts colder, because
        only the room recharges it and the room is Path B.
        """
        wall = a_line(mass=0.4)
        temperature, given = 293.0, 0.0
        for _ in range(120):  # 6 s at 50 ms
            out = wall.exchange(
                mdot=0.15, wall_temperature=temperature, inlet_temperature=200.0, **N2
            )
            given += out.heat * 0.05
            temperature -= out.heat * 0.05 / wall.capacity(temperature)
        assert temperature < 293.0 - 10.0, "the metal must visibly cool"
        assert given == pytest.approx(
            wall.capacity(0.5 * (293.0 + temperature)) * (293.0 - temperature), rel=0.02
        ), "joules out of the metal must equal joules into the gas"


def test_the_wall_uses_the_same_laminar_limit_as_friction() -> None:
    """One transition, not two. Friction switched at 2040 and the Nusselt
    number at 2300, so a line between them was turbulent to one correlation
    and laminar to the other."""
    from feedtwin.comps import wall
    from feedtwin.comps.correlations import LAMINAR_LIMIT

    assert wall.LAMINAR_LIMIT is LAMINAR_LIMIT
    line = a_line()

    # Straddle the one limit: just below is Nu = 3.66 exactly, just above is not.
    def at(re):
        mu = 4.0 * 0.15 / (math.pi * line.bore * re)
        return line.exchange(
            mdot=0.15,
            wall_temperature=293.0,
            inlet_temperature=200.0,
            **dict(N2, viscosity=mu),
        )

    below, above = at(LAMINAR_LIMIT * 0.99), at(LAMINAR_LIMIT * 1.01)
    nu_below = (
        -math.log(1 - below.effectiveness)
        * 0.15
        * N2["heat_capacity"]
        * line.bore
        / (N2["conductivity"] * line.area)
    )
    assert nu_below == pytest.approx(3.66, rel=1e-6)
    assert above.effectiveness != pytest.approx(below.effectiveness, rel=1e-3)
