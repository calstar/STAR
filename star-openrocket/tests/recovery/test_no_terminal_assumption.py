"""Nothing in this model assumes terminal velocity.

Every speed the tool reports is integrated from eq (17). Eq (18) exists, but
`v_terminal` is called only from tests, where it serves as an independent
oracle -- never from a code path that produces a reported number.

That is easy to claim and easy to break later: an "optimisation" that
short-circuits a long drogue descent to its analytic terminal rate would pass
every other test in this suite, because for a normally-deployed vehicle the
two answers agree to 0.02%. These tests fail if that ever happens, by putting
the vehicle in configurations where the two answers are *different* and
checking the tool reports the integrated one.
"""

import copy
import json
import os

import pytest

from physics.dynamics import v_terminal
from physics.schema import Config, Trigger, TriggerKind
from physics.solver import integrate

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fixtures", "worked_example.json")


def load_config():
    with open(FIXTURE, encoding="utf-8") as handle:
        return Config.model_validate(json.load(handle))


def _with_main_at(z_d):
    config = load_config()
    main = next(d for d in config.devices if d.name == "main")
    main.trigger = Trigger(kind=TriggerKind.ALTITUDE, value=z_d)
    return config


def _settled_rate(run):
    """Eq (18) with everything deployed -- what a steady descent would give."""
    CdS = run.CdS_body + sum(d.CdS for d in run.devices)
    return v_terminal(run.m, run.atm.g(0.0), run.atm.rho(0.0), CdS)


def test_impact_equals_terminal_when_there_is_room_to_settle():
    """The agreeable case. A main at 152 m has ~25 s and a 0.31 s relaxation
    time, so it genuinely settles -- and the tool gets there by integrating,
    not by asserting it."""
    run = integrate(load_config(), "axial")
    assert run.v_impact == pytest.approx(_settled_rate(run), rel=1e-3)


def test_impact_exceeds_terminal_when_deployed_too_low():
    """The discriminating case. Deployed at 10 m the main cannot settle, and
    the tool must say so rather than reporting the terminal rate.

    If any code path ever substitutes eq (18) for the integration, this is the
    test that catches it.
    """
    run = integrate(_with_main_at(10.0), "axial")
    settled = _settled_rate(run)
    assert run.v_impact > 2.0 * settled
    assert run.v_impact == pytest.approx(14.63, abs=0.15)


def test_impact_speed_is_monotonic_in_deploy_altitude():
    """Between 'no time at all' and 'fully settled' the answer must vary
    smoothly with how much room the canopy had. A constant here would mean the
    result had stopped depending on the trajectory."""
    speeds = []
    for z_d in (2.0, 5.0, 10.0, 20.0, 30.0, 152.0):
        run = integrate(_with_main_at(z_d), "axial")
        speeds.append(run.v_impact)
    assert all(b <= a + 1e-6 for a, b in zip(speeds, speeds[1:])), speeds
    assert speeds[0] / speeds[-1] > 3.0


def test_deployed_too_low_is_warned_about():
    """§11.10 names this check explicitly. A 2.4x-terminal impact carries 5.8x
    the energy while every load number still looks unremarkable, so silence
    here would be the dangerous kind."""
    run = integrate(_with_main_at(10.0), "axial")
    assert any("settled rate" in w for w in run.warnings), run.warnings

    quiet = integrate(load_config(), "axial")
    assert not any("settled rate" in w for w in quiet.warnings)


def test_drogue_phase_speed_is_integrated_not_assumed():
    """The main's v_s is whatever the drogue descent actually produced.

    For the worked vehicle it lands within 0.2% of the drogue's terminal rate
    -- but that is a *result*, and moving the drogue trigger later must not
    change it while moving the main deployment earlier must.
    """
    config = load_config()
    run = integrate(config, "axial")
    v_s = run.state_of("main").v_s

    drogue_CdS = 0.15 + run.CdS_body
    z_d = run.state_of("main").z_d
    settled = v_terminal(run.m, run.atm.g(z_d), run.atm.rho(z_d), drogue_CdS)
    assert v_s == pytest.approx(settled, rel=5e-3)

    # Fire the main high, before the drogue descent has settled: v_s must
    # come out LOWER than terminal, because the vehicle is still accelerating
    # into it from apogee.
    high = _with_main_at(880.0)
    run_high = integrate(high, "axial")
    v_s_high = run_high.state_of("main").v_s
    z_high = run_high.state_of("main").z_d
    settled_high = v_terminal(run_high.m, run_high.atm.g(z_high),
                              run_high.atm.rho(z_high), drogue_CdS)
    assert v_s_high < 0.9 * settled_high


def test_v_terminal_is_not_called_by_the_library():
    """Guard the claim structurally, not just behaviourally.

    `dynamics.v_terminal` is a validation and reporting helper. If it ever
    appears in solver.py, loads.py or cases.py, a computed answer has been
    replaced by an analytic one somewhere.
    """
    import pathlib

    root = pathlib.Path(__file__).resolve().parent.parent.parent / "physics"
    for name in ("solver.py", "loads.py", "cases.py", "devices.py"):
        source = (root / name).read_text(encoding="utf-8")
        # The solver computes a settled rate inline for the §11.10 warning,
        # which is a *comparison* against the integrated answer rather than a
        # substitute for it -- so look for the import, which is what a
        # substitution would need.
        assert "from physics.dynamics import v_terminal" not in source, name
        assert "v_terminal(" not in source, name
