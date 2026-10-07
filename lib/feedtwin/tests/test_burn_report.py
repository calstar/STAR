"""One way to total a burn (feedtwin.session.report), and one way to put a card on an engine.

The cockpit finds its burns in a session's history; Layer X records one burn as columns. The
totals have to be the same arithmetic on the same steps, or a disagreement between the tools
could be bookkeeping. Checked against hand sums, and against the burn's own trace.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from test_engine_card import constant_card
from test_session_burn import CEA, ENGINE, STAND, TABLES, needs_engine, needs_stand

from feedtwin.engine.chamber import GRAVITY
from feedtwin.session.report import burns, summarise


def _sample(
    t: float, thrust: float, ox: float, fuel: float, pc: float = 2.5e6
) -> SimpleNamespace:
    chamber = None
    if ox + fuel > 0.0:
        chamber = SimpleNamespace(
            thrust=thrust,
            pressure=pc,
            mdot_total=ox + fuel,
            mdot_oxidiser=ox,
            mdot_fuel=fuel,
            combustion=SimpleNamespace(cstar=1500.0, extrapolated=False),
        )
    return SimpleNamespace(t=t, chamber=chamber, balance=None)


def test_totals_are_right_endpoint_sums_over_each_steps_own_length() -> None:
    # A start ramp, then full flow at a drifting O/F; uneven steps on purpose.
    t = [0.1, 0.15, 0.25, 0.4]
    thrust = [1000.0, 2000.0, 2100.0, 1900.0]
    ox = [0.3, 0.6, 0.6, 0.66]
    fuel = [0.2, 0.4, 0.4, 0.34]
    r = summarise(t, thrust, [2e6] * 4, ox, fuel, before=0.0)
    dt = [0.1, 0.05, 0.1, 0.15]
    impulse = sum(f * d for f, d in zip(thrust, dt))
    assert r.impulse_Ns == pytest.approx(impulse, rel=1e-12)
    assert r.end_s - r.start_s == pytest.approx(0.4)
    assert r.thrust_mean_N == pytest.approx(impulse / 0.4)
    burned_ox = sum(m * d for m, d in zip(ox, dt))
    burned_fuel = sum(m * d for m, d in zip(fuel, dt))
    # Mass ratio of what burned -- not the mean of the step ratios, which differs here.
    assert r.of_mean == pytest.approx(burned_ox / burned_fuel)
    assert r.of_mean != pytest.approx(
        sum(o / f for o, f in zip(ox, fuel)) / 4, rel=1e-3
    )
    assert r.isp_s == pytest.approx(impulse / (GRAVITY * (burned_ox + burned_fuel)))
    # The ramp step is outside full flow: the minimum is the full-flow one.
    assert r.thrust_min_N == 1900.0
    assert r.of_min == pytest.approx(1.5) and r.of_max == pytest.approx(0.66 / 0.34)


def test_a_history_splits_into_burns_at_every_quiet_step() -> None:
    history = [_sample(0.0, 0, 0, 0)]
    history += [_sample(0.02 * k, 2000.0, 0.6, 0.4) for k in range(1, 6)]
    history += [_sample(0.12, 0, 0, 0), _sample(0.14, 0, 0, 0)]
    history += [_sample(0.14 + 0.02 * k, 1000.0, 0.3, 0.2) for k in range(1, 4)]
    found = burns(history)  # type: ignore[arg-type]
    assert len(found) == 2
    # The LOX runs out first: fuel alone through the chamber is not a burn, however
    # much "thrust" a clamped combustion table reports for it.
    history += [_sample(0.22, 2000.0, 0.0, 0.4), _sample(0.24, 2000.0, 0.0, 0.4)]
    assert burns(history)[-1].impulse_Ns == pytest.approx(found[-1].impulse_Ns)  # type: ignore[arg-type]
    assert not burns(history)[-1].burning  # type: ignore[arg-type]
    first, second = found
    assert first.start_s == 0.0 and first.end_s == pytest.approx(0.10)
    assert first.impulse_Ns == pytest.approx(2000.0 * 0.10)
    assert not first.burning
    assert second.start_s == pytest.approx(0.14)
    assert second.impulse_Ns == pytest.approx(1000.0 * 0.06)
    assert second.burning, "the history ends mid-burn: running totals, said so"


@needs_stand
@needs_engine
def test_a_burn_found_in_a_sessions_history_totals_what_its_trace_totals() -> None:
    """The cockpit's way (find the burn in the samples) against the burn's own trace,
    step for step: same impulse, same propellant, to rounding."""
    from test_session_burn import _model

    from feedtwin.session import load_machine
    from feedtwin.session.burn import BurnPlan, burn_setup, open_session, run_burn

    session = open_session(
        _model(engine=True), load_machine(tables=TABLES), setup=burn_setup()
    )
    seen: list = []
    plan = BurnPlan(
        tank_psi=550.0,
        loads={"OXT": 6.0, "FUT": 4.0},
        settle=False,
        lead_in_s=0.1,
        horizon_s=0.3,
    )
    trace = run_burn(
        session, plan, also=lambda clock, sample, firing: seen.append(sample)
    )
    inlets = trace.probes.injector_inlet
    (found,) = burns(seen, inlets)

    firing = [i for i, f in enumerate(trace.firing) if f]
    impulse = sum(
        trace.chamber["thrust_N"][i] * (trace.t[i] - trace.t[i - 1]) for i in firing
    )
    ox = sum(
        trace.chamber["mdot_oxidiser"][i] * (trace.t[i] - trace.t[i - 1])
        for i in firing
    )
    assert found.steps == len(firing)
    assert found.impulse_Ns == pytest.approx(impulse, rel=1e-9)
    assert found.oxidiser_kg == pytest.approx(ox, rel=1e-9)
    ch = trace.chamber
    total = [ch["mdot_oxidiser"][i] + ch["mdot_fuel"][i] for i in firing]
    median = sorted(total)[len(total) // 2]
    full = [i for i, m in zip(firing, total) if m >= 0.8 * median]
    for side, key in (
        ("oxidiser", "stiffness_oxidiser_min"),
        ("fuel", "stiffness_fuel_min"),
    ):
        pc, inlet = ch["pressure_Pa"], trace.pressure[inlets[side]]
        lowest = min((inlet[i] - pc[i]) / pc[i] for i in full)
        assert getattr(found, key) == pytest.approx(lowest, rel=1e-12), side
        assert getattr(found, key) > 0.05, side


def test_install_is_attach_plus_the_cards_chamber_at_its_own_site() -> None:
    import yaml
    from dataclasses import replace

    from feedtwin.engine.card import CardChamber
    from feedtwin.engine.importer import engine_from_config

    if not ENGINE.exists():
        pytest.skip("engine config absent")
    design = engine_from_config(yaml.safe_load(ENGINE.read_text()), name="7000N")
    card = replace(
        constant_card(throat=design.throat_area),
        provenance={"ambient_pa_sampled": 94070.0},
    )
    installed, chamber = card.install(design)
    assert installed.oxidiser.card is card.oxidiser and installed.fuel.card is card.fuel
    assert isinstance(chamber, CardChamber)
    assert chamber.ambient_pressure == 94070.0
    assert card.install(design, ambient_pressure=1e5)[1].ambient_pressure == 1e5
    with pytest.raises(ValueError, match="throat"):
        constant_card(throat=design.throat_area * 1.1).install(design)
    assert CEA  # the stand's combustion table is what the burn above used
