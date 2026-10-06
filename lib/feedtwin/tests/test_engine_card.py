"""Engine cards: another tool's injector and chamber, tabulated (feedtwin.engine.card).

Checked against things the card cannot fake:
* the interpolant reproduces its nodes and any linear function exactly;
* ``dp = (mdot/phi)^2`` holds for any flow, signed;
* ``F + p_a A_e`` is the same at every ambient pressure;
* ``p_c = mdot c*/A_t`` holds without a fixed point;
* a burn on a card with constant tables gives exactly that chamber pressure, step by
  step, through the twin's network and chamber closure.

And the opt-in rule: an injector without a card behaves exactly as before.
"""

from __future__ import annotations

import json
import math
from dataclasses import replace
from pathlib import Path

import pytest

from feedtwin.engine import (
    CardChamber,
    ChamberCard,
    EngineCard,
    InjectorCard,
    Table2D,
)
from feedtwin.engine.component import injector_legs
from feedtwin.comps.base import FlowConditions


def table(fn, x=(0.0, 1.0, 5), y=(0.0, 2.0, 4)) -> Table2D:  # type: ignore[no-untyped-def]
    x0, x1, nx = x
    y0, y1, ny = y
    dx, dy = (x1 - x0) / (nx - 1), (y1 - y0) / (ny - 1)
    return Table2D(
        x0,
        dx,
        nx,
        y0,
        dy,
        ny,
        tuple(
            tuple(float(fn(x0 + i * dx, y0 + j * dy)) for j in range(ny))
            for i in range(nx)
        ),
    )


def constant_card(
    cstar: float = 1550.0,
    vvac: float = 2600.0,
    phi: float = 1.7e-3,
    throat: float = 1.8e-3,
    exit_area: float = 8.7e-3,
) -> EngineCard:
    box = ((0.0, 0.0), (100.0, 0.0), (100.0, 1e8), (0.0, 1e8))
    inj = InjectorCard(table(lambda m, p: phi, (0.0, 5.0, 3), (1e5, 1e7, 3)), hull=box)
    ch = ChamberCard(
        table(lambda r, m: cstar, (0.5, 3.0, 3), (0.1, 6.0, 3)),
        table(lambda r, m: vvac, (0.5, 3.0, 3), (0.1, 6.0, 3)),
        hull=((0.5, 0.1), (3.0, 0.1), (3.0, 6.0), (0.5, 6.0)),
    )
    return EngineCard("constant", throat, exit_area, inj, replace(inj), ch)


# ------------------------------------------------------------------ the table


def test_table_reproduces_its_nodes_and_any_linear_function() -> None:
    t = table(lambda x, y: math.sin(3 * x) + y * y)
    for i in range(t.nx):
        for j in range(t.ny):
            x, y = t.x0 + i * t.dx, t.y0 + j * t.dy
            assert t(x, y) == pytest.approx(math.sin(3 * x) + y * y, abs=1e-12)
    lin = table(lambda x, y: 2.0 + 3.0 * x - 0.5 * y)
    for x, y in ((0.13, 0.71), (0.5, 1.99), (0.99, 0.01), (0.37, 1.23)):
        assert lin(x, y) == pytest.approx(2.0 + 3.0 * x - 0.5 * y, abs=1e-12)


def test_table_clamps_outside_its_box() -> None:
    t = table(lambda x, y: x + y)
    assert t(-5.0, 1.0) == pytest.approx(t(0.0, 1.0))
    assert t(0.5, 99.0) == pytest.approx(t(0.5, 2.0))
    assert not t.in_box(1.5, 0.0) and t.in_box(1.0, 2.0)


def test_table_refuses_values_that_do_not_match_its_axes() -> None:
    with pytest.raises(ValueError):
        Table2D(0.0, 1.0, 3, 0.0, 1.0, 2, ((1.0, 2.0), (3.0, 4.0)))


# ------------------------------------------------------------------ the injector


def test_injector_card_is_the_orifice_relation_on_its_capacity() -> None:
    card = constant_card(phi=2.0e-3)
    for m in (
        0.01,
        0.9,
        1.9,
        7.0,
    ):  # 7 kg/s is outside the table; the quadratic still holds
        assert card.oxidiser.pressure_drop(m, 3.0e6) == pytest.approx(
            (m / 2.0e-3) ** 2, rel=1e-12
        )
    assert card.oxidiser.pressure_drop(-1.0, 3.0e6) == pytest.approx(
        -((1.0 / 2.0e-3) ** 2)
    )
    assert card.oxidiser.pressure_drop(0.0, 3.0e6) == 0.0


def test_an_injector_leg_uses_its_card_and_only_when_it_has_one() -> None:
    from feedtwin.engine.design import DischargeModel, EngineDesign, InjectorSide

    side = InjectorSide("oxygen", 5.0e-5, 1.6e-3, DischargeModel(cd_inf=0.6, a_re=0.0))
    design = EngineDesign(
        name="t",
        injector_type="impinging",
        oxidiser=side,
        fuel=replace(side, propellant="ethanol"),
        throat_area=1.8e-3,
        expansion_ratio=4.8,
        chamber_volume=2.4e-3,
    )
    flow = FlowConditions(rho=1140.0, mu=1.8e-4, p_upstream=3.7e6)
    plain, _ = injector_legs(design)
    # Without a card: the orifice relation on the Cd model, exactly as it always was.
    assert plain.pressure_drop(1.8, flow) == pytest.approx(
        1.8**2 / (2 * 1140.0 * (0.6 * 5.0e-5) ** 2), rel=1e-12
    )
    card = constant_card(phi=1.7e-3, throat=1.8e-3)
    carded, _ = injector_legs(card.attach(design))
    assert carded.pressure_drop(1.8, flow) == pytest.approx(
        (1.8 / 1.7e-3) ** 2, rel=1e-12
    )
    # Its effective area is recovered from the card at the leg's density.
    area = carded.effective_area(1.8, flow)
    assert 1.8**2 / (2 * 1140.0 * area**2) == pytest.approx(
        (1.8 / 1.7e-3) ** 2, rel=1e-12
    )


def test_reverse_flow_through_a_carded_leg_loses_pressure_backwards() -> None:
    """``total_dp`` is what the network solves with, and run backwards an orifice drops
    pressure backwards: it is odd in the flow, carded or not.

    The card's own relation is signed, and the leg used to hand that signed drop to a
    base class that signs it again, so reverse flow came out as a pressure *rise*,
    ``+(mdot/phi)^2``. A chamber closure that brackets the chamber up to the higher
    tank's pressure asks the other leg to run backwards; it had no root there, and a
    network solve asked for better than ~3e-5 stalled at the bottom of the parabola.
    """
    from feedtwin.engine.design import DischargeModel, EngineDesign, InjectorSide

    side = InjectorSide("oxygen", 5.0e-5, 1.6e-3, DischargeModel(cd_inf=0.6, a_re=0.0))
    design = EngineDesign(
        name="t",
        injector_type="impinging",
        oxidiser=side,
        fuel=replace(side, propellant="ethanol"),
        throat_area=1.8e-3,
        expansion_ratio=4.8,
        chamber_volume=2.4e-3,
    )
    flow = FlowConditions(rho=789.0, mu=1.2e-3, p_upstream=3.9e6)
    plain, _ = injector_legs(design)
    carded, _ = injector_legs(constant_card(phi=1.6e-3, throat=1.8e-3).attach(design))
    for leg in (plain, carded):
        for m in (0.006, 0.4, 1.8):
            forward = leg.total_dp(m, flow)
            assert forward > 0.0
            assert leg.total_dp(-m, flow) == pytest.approx(-forward, rel=1e-12)
    assert carded.total_dp(-0.4, flow) == pytest.approx(-((0.4 / 1.6e-3) ** 2))


def test_a_card_refuses_a_design_with_a_different_throat() -> None:
    from feedtwin.engine.design import DischargeModel, EngineDesign, InjectorSide

    side = InjectorSide("oxygen", 5.0e-5, 1.6e-3, DischargeModel())
    design = EngineDesign(
        name="t",
        injector_type="impinging",
        oxidiser=side,
        fuel=side,
        throat_area=2.0e-3,
        expansion_ratio=4.8,
        chamber_volume=2.4e-3,
    )
    with pytest.raises(ValueError, match="throat"):
        constant_card(throat=1.8e-3).attach(design)


# ------------------------------------------------------------------ the chamber


def test_card_chamber_pressure_and_thrust_follow_the_tables() -> None:
    card = constant_card(cstar=1550.0, vvac=2600.0, throat=1.8e-3, exit_area=8.7e-3)
    mo, mf = 1.85, 1.22
    res = card.chamber_model(ambient_pressure=94070.0).evaluate(mo, mf)
    assert res.pressure == pytest.approx((mo + mf) * 1550.0 / 1.8e-3, rel=1e-12)
    assert res.thrust == pytest.approx((mo + mf) * 2600.0 - 94070.0 * 8.7e-3, rel=1e-12)
    assert res.specific_impulse == pytest.approx(
        res.thrust / ((mo + mf) * 9.80665), rel=1e-12
    )
    assert res.mixture_ratio == pytest.approx(mo / mf)


def test_thrust_plus_ambient_times_exit_area_does_not_depend_on_ambient() -> None:
    card = constant_card()
    vac = {
        pa: card.chamber_model(ambient_pressure=pa).evaluate(1.8, 1.2)
        for pa in (0.0, 5.0e4, 101325.0)
    }
    for pa, res in vac.items():
        assert res.thrust + pa * card.exit_area == pytest.approx(
            3.0 * 2600.0, rel=1e-12
        )


def test_a_card_chamber_off_its_hull_says_so() -> None:
    card = constant_card()
    inside = card.chamber_model().evaluate(1.8, 1.2)
    outside = card.chamber_model().evaluate(9.0, 0.5)  # O/F 18, far outside
    assert not inside.combustion.extrapolated
    assert outside.combustion.extrapolated
    # No flow is ambient and no thrust, as for any chamber.
    shut = card.chamber_model(ambient_pressure=94070.0).evaluate(0.0, 0.0)
    assert shut.pressure == 94070.0 and shut.thrust == 0.0


def test_fill_time_uses_the_cards_cstar() -> None:
    card = constant_card(cstar=1550.0)
    chamber = card.chamber_model(volume=2.4e-3)
    assert chamber.fill_time(2.7e6, 1.5) == pytest.approx(
        2.4e-3 / (1.8e-3 * 1550.0), rel=1e-9
    )


def test_a_card_round_trips_through_json() -> None:
    card = replace(
        constant_card(), provenance={"tool": "test"}, fit={"envelope_worst": 1e-4}
    )
    again = EngineCard.from_dict(json.loads(json.dumps(card.to_dict())))
    assert again == card
    with pytest.raises(ValueError, match="schema"):
        EngineCard.from_dict({**card.to_dict(), "schema": 99})


# ------------------------------------------------------------------ in a burn

STAR = Path(__file__).resolve().parents[3]
STAND = STAR / "feed-twin" / "backend" / "diagrams" / "copv_study_gn2.json"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"
ENGINE = STAR / "EngineDesign" / "configs" / "ethalox_doublet_7000N.yaml"


needs_stand = pytest.mark.skipif(
    not (STAND.exists() and TABLES.is_dir() and ENGINE.exists()),
    reason="stand drawing, tables or engine config absent",
)


def _card_burn(**setup: object):  # type: ignore[no-untyped-def]
    """A short GN2 burn on a constant card: phi 1.6e-3, c* 1520 m/s."""
    import yaml

    from feedtwin.engine.importer import engine_from_config
    from feedtwin.pid import read_diagram
    from feedtwin.session import assemble_model, load_machine
    from feedtwin.session.burn import BurnPlan, burn_setup, open_session, run_burn

    design = engine_from_config(yaml.safe_load(ENGINE.read_text()), name="7000N")
    card = constant_card(
        cstar=1520.0, vvac=2550.0, phi=1.6e-3, throat=design.throat_area
    )
    design = card.attach(design)
    model = assemble_model(
        read_diagram(json.loads(STAND.read_text()), name="gn2"),
        diagram_id="gn2",
        engine=design,
        chamber=card.chamber_model(ambient_pressure=94070.0),
    )
    session = open_session(
        model,
        load_machine(tables=TABLES),
        setup=burn_setup(dome_psi=500.0, chamber_tolerance_psi=0.01, **setup),
    )
    trace = run_burn(
        session,
        BurnPlan(
            loads={"OXT": 6.0, "FUT": 4.0}, settle=False, lead_in_s=0.1, horizon_s=0.4
        ),
    )
    return trace, design


@needs_stand
def test_a_burn_on_a_card_runs_the_cards_engine_at_every_step() -> None:
    """Constant tables make the chamber closed-form: p_c = mdot c*/A_t, and the injector
    drop is (mdot/phi)^2. Every firing step of a burn through the twin's network and
    chamber closure has to satisfy both, to the closure's tolerance."""
    trace, design = _card_burn()
    firing = [i for i, f in enumerate(trace.firing) if f]
    assert len(firing) > 4, "the engine never fired"
    inlet = trace.probes.injector_inlet
    ch = trace.chamber
    for i in firing[1:]:
        mt = ch["mdot_oxidiser"][i] + ch["mdot_fuel"][i]
        assert ch["pressure_Pa"][i] == pytest.approx(
            mt * 1520.0 / design.throat_area, rel=1e-9
        )
        for side, key in (("oxidiser", "mdot_oxidiser"), ("fuel", "mdot_fuel")):
            dp = trace.pressure[inlet[side]][i] - ch["pressure_Pa"][i]
            # The chamber is closed to 0.01 psi, but the network solve under it stops at the
            # session's LIVE_TOL (1e-4 scaled residual), which leaves the injector drop within a few
            # tenths of a percent of the card's -- measured 0.2 % here. A wrong card is off by
            # tens of percent.
            assert dp == pytest.approx((ch[key][i] / 1.6e-3) ** 2, rel=5e-3)


@needs_stand
def test_a_caller_can_ask_the_network_for_the_cards_drop_to_the_closures_tolerance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Opting into a tight network tolerance has to buy the injector drop, not a burn of
    held flows.

    At 1e-5 this burn used to fail 36 of 45 solves: the regulator's outlet stepped
    1.7 kPa across zero flow with the tanks primed inside the step, and a carded leg
    run backwards gained pressure. Both rows had no root, and the residual floor was
    2.5e-5. With both closed it converges at every step, and what is left of the
    injector error is the chamber closure's own 0.01 psi against ~0.9 MPa of drop.
    """
    import feedtwin.session.core as core

    # Every solve, not every sample: a sample records only a tick's last coupling step,
    # and the regulator's failure is one held solve at T-0 that a sample never shows.
    solves: list[bool] = []
    solve = core.solve_steady

    def counted(*args, **kwargs):  # type: ignore[no-untyped-def]
        result = solve(*args, **kwargs)
        solves.append(result.converged)
        return result

    monkeypatch.setattr(core, "solve_steady", counted)
    trace, design = _card_burn(network_tolerance=1.0e-6, regulator_lockup_supply=True)
    assert len(solves) > 40 and all(solves), f"{solves.count(False)} solves held"
    assert all(trace.converged)
    firing = [i for i, f in enumerate(trace.firing) if f]
    assert len(firing) > 4, "the engine never fired"
    assert len(firing) > 4
    inlet = trace.probes.injector_inlet
    ch = trace.chamber
    for i in firing[1:]:
        for side, key in (("oxidiser", "mdot_oxidiser"), ("fuel", "mdot_fuel")):
            dp = trace.pressure[inlet[side]][i] - ch["pressure_Pa"][i]
            assert dp == pytest.approx((ch[key][i] / 1.6e-3) ** 2, rel=2e-4)


def test_the_hull_includes_its_own_edges() -> None:
    """Every sample the card was built from is inside its hull, the corners and the
    far edges included; a hair outside is not. Plain ray casting kept only two of a
    square's four edges."""
    from feedtwin.engine.card import _inside

    hull = [(0.5, 2.0e6), (3.0, 2.0e6), (3.0, 5.0e6), (0.5, 5.0e6)]
    for point in [
        (0.5, 2.0e6),
        (3.0, 5.0e6),
        (3.0, 3.5e6),
        (1.7, 5.0e6),
        (1.7, 2.0e6),
        (0.5, 3.0e6),
    ]:
        assert _inside(hull, *point), point
    for point in [(3.001, 3.5e6), (1.7, 5.00001e6), (0.499, 3.0e6), (1.7, 1.99999e6)]:
        assert not _inside(hull, *point), point
    assert not _inside([], 1.0, 3.0e6)
