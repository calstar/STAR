"""The marching session as library code, and a burn as one call.

The session's physics is covered where it was written (feed-twin's
``tests/test_session.py``, which now runs against this package through the
app's re-exports) and by ``scripts/physics_benchmark.py``. What is new here is
the surface a second caller uses: assembling without the app's artifact store,
priming a fixed propellant load by mass, and a burn that records its probes.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from feedtwin.pid import read_diagram
from feedtwin.session import assemble_model, load_machine, psig_from_psia, PSI
from feedtwin.session.burn import (
    BurnPlan,
    burn_setup,
    find_probes,
    open_session,
    run_burn,
)
from feedtwin.session.gauge import ATMOSPHERE, from_psig

STAR = Path(__file__).resolve().parents[3]
STAND = STAR / "feed-twin" / "backend" / "diagrams" / "ethalox_stand.json"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"
ENGINE = STAR / "EngineDesign" / "configs" / "ethalox_doublet_7000N.yaml"
CEA = STAR / "EngineDesign" / "output" / "cache" / "cea_cache_LOX_Ethanol_3D.npz"

needs_stand = pytest.mark.skipif(
    not (STAND.exists() and TABLES.is_dir()), reason="stand drawing or tables absent"
)
needs_engine = pytest.mark.skipif(
    not (ENGINE.exists() and CEA.exists()), reason="engine config or CEA table absent"
)


def _model(engine: bool = False):  # type: ignore[no-untyped-def]
    diagram = read_diagram(json.loads(STAND.read_text()), name="ethalox_stand")
    design = None
    if engine:
        import yaml

        from feedtwin.engine.importer import engine_from_config

        design = engine_from_config(yaml.safe_load(ENGINE.read_text()), name="7000N")
    return assemble_model(
        diagram,
        diagram_id="ethalox_stand.json",
        engine=design,
        cea_cache=str(CEA) if engine else "",
    )


def test_gauge_from_psia_round_trips_exactly() -> None:
    """A caller that knows psia converts through the gauge zero without error."""
    for psia in (14.6959, 94.07e3 / PSI, 578.0, 4514.7):
        assert from_psig(psig_from_psia(psia)) == pytest.approx(psia * PSI, rel=1e-14)
    assert from_psig(0.0) == ATMOSPHERE


def test_burn_setup_is_the_study_numerics() -> None:
    setup = burn_setup(dome_psi=513.0)
    assert setup.tick_budget == 1.0e9
    assert setup.max_iterations == 120
    assert setup.auto_vent is False
    assert setup.stratification is False
    assert setup.boiling_onset_K == 0.0 and setup.chilldown_nucleate == 0.0
    assert setup.dome_psi == 513.0


@needs_stand
def test_a_model_assembles_without_an_artifact_store() -> None:
    model = _model()
    assert model.engine is None and model.chamber is None
    assert model.report.diagram == "ethalox_stand.json"
    assert model.report.engine == ""
    assert model.report.nodes > 0 and model.report.branches > 0
    assert set(model.built.tanks) == {"OXT", "FUT"}


@needs_stand
def test_prime_by_mass_loads_exactly_that_mass() -> None:
    session = open_session(_model(), load_machine(tables=TABLES), setup=burn_setup())
    session.prime(tank_psi=550.0, copv_psi=4500.0, loads={"OXT": 6.611})
    assert session.tanks["OXT"].state.liquid_mass == pytest.approx(6.611, rel=1e-12)
    # A tank the loads do not name keeps the fill fraction.
    fuel = session.tanks["FUT"]
    rho = fuel.tank.liquid.get("rho", T=fuel.state.liquid_temperature, q=0.0)
    expected = fuel.tank.geometry.total_volume * 0.95 * rho
    assert fuel.state.liquid_mass == pytest.approx(expected, rel=1e-12)


@needs_stand
def test_prime_without_loads_fills_by_volume() -> None:
    """Without ``loads`` every tank holds ``fill_fraction`` of its volume as liquid, by
    hand from the volume and the density: the behaviour before ``loads`` existed."""
    a = open_session(_model(), load_machine(tables=TABLES), setup=burn_setup())
    a.prime(fill_fraction=0.8, tank_psi=500.0)
    for sim in a.tanks.values():
        rho = sim.tank.liquid.get("rho", T=sim.state.liquid_temperature, q=0.0)
        expected = sim.tank.geometry.total_volume * 0.8 * rho
        assert sim.state.liquid_mass == pytest.approx(expected, rel=1e-12), sim.id


@needs_stand
def test_prime_refuses_a_load_that_does_not_fit_or_has_no_tank() -> None:
    session = open_session(_model(), load_machine(tables=TABLES), setup=burn_setup())
    with pytest.raises(ValueError, match="L of liquid"):
        session.prime(loads={"FUT": 50.0})
    with pytest.raises(ValueError, match="no tank"):
        session.prime(loads={"LOX-TANK": 1.0})


@needs_stand
def test_probes_are_found_on_the_drawing() -> None:
    session = open_session(
        _model(engine=ENGINE.exists() and CEA.exists()),
        load_machine(tables=TABLES),
        setup=burn_setup(),
    )
    probes = find_probes(session)
    assert set(probes.tank_ullage) == {"OXT", "FUT"}
    assert probes.tank_fluid["OXT"] and probes.tank_fluid["FUT"]
    assert probes.regulator_outlet, "the stand's regulators were not found"
    assert probes.bottles


@needs_stand
@needs_engine
def test_a_short_burn_records_and_conserves_propellant() -> None:
    """Fire for a third of a second and check the bookkeeping holds.

    Conservation is the check worth having here: the propellant that left the
    tanks has to be the propellant the chamber says it burned, integrated over
    the same steps. It is independent of every correlation in the model.
    """
    session = open_session(
        _model(engine=True), load_machine(tables=TABLES), setup=burn_setup()
    )
    loads = {"OXT": 6.0, "FUT": 4.0}
    plan = BurnPlan(
        tank_psi=550.0, loads=loads, settle=False, lead_in_s=0.1, horizon_s=0.3
    )
    trace = run_burn(session, plan)

    assert trace.end is not None and not trace.end.cancelled
    n = len(trace.t)
    assert n == trace.end.steps
    assert trace.firing.count(False) == 2
    assert set(trace.probes.injector_inlet) == {"oxidiser", "fuel"}
    for node in trace.nodes():
        assert len(trace.pressure[node]) == n

    firing = [i for i, f in enumerate(trace.firing) if f]
    pc = trace.chamber["pressure_Pa"]
    assert all(pc[i] > 2.0 * ATMOSPHERE for i in firing[1:])
    assert all(trace.chamber["thrust_N"][i] > 0.0 for i in firing[1:])
    # Injector inlet sits between the tank and the chamber.
    for side, tank in (("oxidiser", "OXT"), ("fuel", "FUT")):
        inlet = trace.pressure[trace.probes.injector_inlet[side]]
        tank_p = trace.tank[tank]["pressure_Pa"]
        for i in firing[1:]:
            assert pc[i] < inlet[i] < tank_p[i] + 5.0 * PSI

    dt = plan.dt
    for tank, key in (("OXT", "mdot_oxidiser"), ("FUT", "mdot_fuel")):
        left = loads[tank] - trace.tank[tank]["liquid_mass_kg"][-1]
        burned = sum(trace.chamber[key][i] * dt for i in firing)
        assert burned == pytest.approx(left, rel=0.03), tank


@needs_stand
def test_a_model_runs_under_one_session_only() -> None:
    """A session writes its run into the model's network; a second session on the same model
    would start from the first one's end state. open_session refuses it."""
    model = _model()
    open_session(model, load_machine(tables=TABLES), setup=burn_setup())
    with pytest.raises(ValueError, match="fresh model"):
        open_session(model, load_machine(tables=TABLES), setup=burn_setup())
    # A fresh one is fine.
    open_session(_model(), load_machine(tables=TABLES), setup=burn_setup())


def _impulse(trace, plan) -> float:  # type: ignore[no-untyped-def]
    """Thrust times each step's own length, over the firing steps."""
    total, prev = 0.0, None
    for t, firing, f in zip(trace.t, trace.firing, trace.chamber["thrust_N"]):
        if firing:
            total += f * (t - (prev if prev is not None else t - plan.dt))
        prev = t
    return total


@needs_stand
@needs_engine
def test_ending_on_depletion_is_continuous_in_the_load() -> None:
    """With ``end_on_depletion`` the last step lands the first tank on ``dry_kg``, so
    the impulse grows smoothly with the load. On whole steps it moves in jumps of a
    step's worth as the depletion crosses a step boundary; that is the default, and
    the study keeps it."""

    def fire(ox_kg: float, end: bool):  # type: ignore[no-untyped-def]
        session = open_session(
            _model(engine=True), load_machine(tables=TABLES), setup=burn_setup()
        )
        plan = BurnPlan(
            tank_psi=550.0,
            loads={"OXT": ox_kg, "FUT": 4.0},
            settle=False,
            lead_in_s=0.1,
            horizon_s=2.0,
            end_on_depletion=end,
            tanks=("OXT",),
        )
        trace = run_burn(session, plan)
        assert trace.end is not None and trace.end.tank == "OXT"
        return trace, plan

    # 15 g apart over 105 g: one 50 ms step burns ~90 g of LOX, so a boundary is crossed.
    loads = [0.40 + 0.015 * k for k in range(8)]
    smooth, stepped = [], []
    for ox in loads:
        trace, plan = fire(ox, True)
        assert trace.tank["OXT"]["liquid_mass_kg"][-1] == pytest.approx(
            plan.dry_kg, abs=0.003
        )
        smooth.append(_impulse(trace, plan))
        trace, plan = fire(ox, False)
        stepped.append(_impulse(trace, plan))
    d_smooth = [b - a for a, b in zip(smooth, smooth[1:])]
    d_stepped = [b - a for a, b in zip(stepped, stepped[1:])]
    # 15 g of LOX more each time: the same few tens of N.s every time.
    assert all(d > 0.0 for d in d_smooth), d_smooth
    assert max(d_smooth) < 2.0 * min(d_smooth), d_smooth
    # On whole steps the same loads jump: at least one increment is a step's worth.
    assert max(d_stepped) > 3.0 * max(d_smooth), (d_stepped, d_smooth)
