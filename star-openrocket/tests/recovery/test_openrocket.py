"""The OpenRocket port, against OpenRocket.

`physics/openrocket.py` is a port of another program's model, so "it looks
right" is worth nothing. The evidence here runs strongest-last:

  1. the ISA against **OpenRocket's own JUnit values**, lifted from
     `core/src/test/java/info/openrocket/core/models/atmosphere/`;
  2. the 500 m interpolation grid, proving we interpolate rather than evaluate;
  3. the Euler stepper converging onto our RK45, with the residual attributed
     to gravity and density rather than waved at -- this is what separates
     "a coarsely integrated different model" from "a coding error";
  4. the three PLAN.md §2 defects, each as a number.

Everything is pinned to **release-24.12**. The repo default branch is
`unstable`, whose `ExtendedISAModel` has a geopotential conversion and humid-air
gas constant that no released OpenRocket has -- so these golden values would
not reproduce against it, which is the point of pinning.
"""

import copy
import json
import math
import os

import pytest

from physics import openrocket as orx
from physics.atmosphere import Atmosphere
from physics.cases import evaluate
from physics.devices import airframe_band
from physics.openrocket import DELTA, ExtendedISA, simulate, wgs_gravity
from physics.schema import Config
from physics.site import FAR_ELEV_M, FAR_LAT
from physics.solver import integrate

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


@pytest.fixture
def config():
    with open(os.path.join(FIXTURES, "worked_example.json"), encoding="utf-8") as fh:
        return Config.model_validate(json.load(fh))


# ===========================================================================
# 1. The ISA, against OpenRocket's own ExtendedISAModelTest
# ===========================================================================
#
# Every expected value below is an `assertEquals` from that file, at its own
# tolerance. They are not numbers this project derived.


def test_standard_sea_level():
    """`testStandardSeaLevel`."""
    t, p = ExtendedISA().conditions(0.0)
    assert t == pytest.approx(288.15, abs=0.01)
    assert p == pytest.approx(101325.0, abs=0.01)


@pytest.mark.parametrize("altitude", [-100.0, -1.0, 0.0])
def test_negative_altitudes_clamp(altitude):
    """`testNegativeAltitudes`: below the table, return the lowest level."""
    t, p = ExtendedISA().conditions(altitude)
    assert t == pytest.approx(288.15, abs=0.01)
    assert p == pytest.approx(101325.0, abs=0.01)


def test_custom_sea_level_conditions():
    """`testCustomConditions`: ExtendedISAModel(278.15, 100000.0)."""
    t, p = ExtendedISA(0.0, 278.15, 100000.0).conditions(0.0)
    assert t == pytest.approx(278.15, abs=0.01)
    assert p == pytest.approx(100000.0, abs=0.01)


def test_launch_site_layer_and_the_back_fitted_column():
    """`testAltitudeModel` / `testBelowLaunchSite`, the load-bearing one.

    `ExtendedISAModel(1000, 281.15, 89876)` re-fits the lowest layer through the
    pad state and back-calculates a sea-level temperature so the column still
    meets 216.65 K at 11 km -- the same idea as our eq (7). The 500 m and 0 m
    values check that back-fit *and* the interpolation grid at once, and they
    are asserted to 0.01 Pa in OpenRocket's own suite.
    """
    model = ExtendedISA(1000.0, 281.15, 89876.0)

    t, p = model.conditions(1000.0)
    assert t == pytest.approx(281.15, abs=0.01)
    assert p == pytest.approx(89876.0, abs=0.01)

    t, p = model.conditions(500.0)
    assert t == pytest.approx(284.375, abs=0.01)
    assert p == pytest.approx(95472.8, abs=0.01)

    t, p = model.conditions(0.0)
    assert t == pytest.approx(287.6, abs=0.01)
    assert p == pytest.approx(101349.04, abs=0.01)


def test_launch_site_between_grid_levels():
    """`testInterpolatedAltitudeModel`: a pad at 2750 m is not on the 500 m
    grid, which is why OpenRocket's own tolerance here is 50 Pa and not 0.01."""
    t, p = ExtendedISA(2750.0, 271.15, 72500.0).conditions(2750.0)
    assert t == pytest.approx(271.15, abs=0.01)
    assert p == pytest.approx(72500.0, abs=50.0)


@pytest.mark.parametrize("args", [
    (1000.0, 288.15, 0.0),        # zero pressure
    (1000.0, 0.0, 101325.0),      # zero temperature
    (1000.0, 288.15, -1000.0),    # negative pressure
    (1000.0, -273.15, 101325.0),  # negative temperature
    (12000.0, 220.0, 25000.0),    # above the 11 km first layer
])
def test_invalid_construction_is_rejected(args):
    """`testEdgeCases`, the `assertThrows` half. A pad above 11 km is rejected
    because the re-fit has nothing left to anchor to."""
    with pytest.raises(ValueError):
        ExtendedISA(*args)


def test_a_below_sea_level_pad_is_accepted_and_quietly_relocated():
    """`testEdgeCases` opens with `assertDoesNotThrow` on a -100 m altitude, so
    a pad below sea level is legal -- Badwater is -85 m.

    What it does with it is worth knowing: the `altitude > 0` branch is skipped
    entirely, so the pad temperature and pressure are installed at layer 0,
    which is **sea level**, not at -100 m. The measurement is silently
    relocated 100 m upward rather than rejected. Not a case FAR can hit at
    630 m, and pinned so nobody assumes otherwise.
    """
    model = ExtendedISA(-100.0, 288.15, 101325.0)
    assert model.layer[0] == 0.0
    assert model.base_temperature[0] == pytest.approx(288.15)
    assert model.base_pressure[0] == pytest.approx(101325.0)
    assert model.conditions(0.0)[1] == pytest.approx(101325.0, abs=0.01)


# ===========================================================================
# 2. The 500 m lookup grid
# ===========================================================================


def test_the_grid_interpolates_rather_than_evaluating():
    """Prove the table is really there.

    An exact evaluation and a chord across 500 m agree at the nodes and differ
    between them. If someone "optimised" `conditions` into `exact`, every ISA
    test above would still pass and this is the only thing that would notice.
    """
    model = ExtendedISA(FAR_ELEV_M, 284.0554, 94000.0)

    for node in (0.0, 500.0, 1000.0, 1500.0):
        assert model.conditions(node)[1] == pytest.approx(model.exact(node)[1],
                                                          rel=1e-12)

    for mid in (250.0, 750.0, 1250.0):
        assert model.conditions(mid)[1] != pytest.approx(model.exact(mid)[1],
                                                         rel=1e-9)


def test_grid_density_error_is_0_04_percent_not_0_6():
    """What the lookup table actually costs, measured.

    PLAN.md §5 and `atmosphere.py` both say the 500 m grid is "~0.6% density
    error near the ground". It is **0.036%** mid-cell and zero at the nodes,
    peaking at 0.045% over the first 5 km -- more than an order of magnitude
    smaller than claimed. The claim was an estimate nobody had checked; this is
    the check, and the docs are corrected to match.

    Evaluating exactly is still the right call -- it is a handful of flops and
    removes the question -- but the reason is simplicity, not a 0.6% error.
    """
    model = ExtendedISA(FAR_ELEV_M, 284.0554, 94000.0)

    def rho(pair):
        return pair[1] / (orx.R_AIR * pair[0])

    worst = max(abs(rho(model.conditions(z)) / rho(model.exact(z)) - 1.0)
                for z in range(0, 5000, 10))
    assert worst < 0.0006, "grid error grew past the documented 0.06%"
    assert worst == pytest.approx(0.00045, abs=0.0001)


# ===========================================================================
# 3. Gravity
# ===========================================================================


def test_wgs_gravity_matches_the_closed_form():
    """`WGSGravityModel.calcGravity`, and the constant that is easy to confuse.

    The altitude correction uses `WorldCoordinate.REARTH = 6371000` -- the mean
    radius -- and NOT the 6356766 the ISA uses for geopotential. Substituting
    one for the other is a silent 0.0002% and exactly the sort of thing a port
    gets wrong, so both radii are asserted to be different here.
    """
    sin2 = math.sin(math.radians(FAR_LAT)) ** 2
    g0 = 9.7803267714 * ((1.0 + 0.00193185138639 * sin2)
                         / math.sqrt(1.0 - 0.00669437999013 * sin2))
    assert wgs_gravity(FAR_LAT, 0.0) == pytest.approx(g0, rel=1e-12)
    assert wgs_gravity(FAR_LAT, FAR_ELEV_M) == pytest.approx(
        g0 * (orx.REARTH / (orx.REARTH + FAR_ELEV_M)) ** 2, rel=1e-12)
    # Equator to pole is a real 0.5%.
    assert wgs_gravity(90.0, 0.0) / wgs_gravity(0.0, 0.0) == \
        pytest.approx(1.0053, abs=0.0002)


# ===========================================================================
# 4. The stepper converges onto our RK45
# ===========================================================================


def _single_canopy(config):
    """One canopy, opening effectively instantly, high enough to settle.

    Strips away everything that is a *modelling* difference so the only things
    left are the integrator, the atmosphere and gravity. `n -> 0` collapses our
    filling time to nothing, which is the one way to make our model produce the
    step function OpenRocket always produces.
    """
    cfg = copy.deepcopy(config)
    cfg.devices = [d for d in cfg.devices if d.name == "main"]
    cfg.devices[0].trigger.value = 900.0
    cfg.devices[0].n = 1e-9
    return cfg


def test_euler_converges_onto_our_rk45(config):
    """The test that decides whether this port is a model or a bug.

    With one canopy, no airframe drag on either side and no filling time, the
    two codes are solving the same ODE by different methods. If the port were
    wrong the answers would not agree at any step size; if the Euler stepper
    were unstable they would diverge as the step grew. Neither happens: they
    agree to better than 0.1% at every step size from 0.5 s down to 2 ms.
    """
    cfg = _single_canopy(config)
    ours = integrate(cfg, CdS_body=0.0)

    for dt in (0.5, 0.1, 0.01, 0.002):
        run = simulate(cfg, CdS_coast=0.0, recovery_time_step=dt)
        assert run.t_ground == pytest.approx(ours.t_ground, rel=1e-3)
        assert run.v_impact == pytest.approx(ours.v_impact, rel=1e-3)


def test_the_residual_is_gravity_and_density_not_integration(config):
    """Where the last 0.06% goes, to four decimal places.

    A convergence test that stops at "close enough" leaves open whether the
    remainder is a small bug. It is not: the entire gap is the WGS gravity
    model (-0.092% at FAR's latitude) against our constant g0, plus the
    interpolated density (+0.027%), and terminal velocity carries both as a
    square root. Predicted -0.0596%, observed -0.0597%.

    That the integrator contributes nothing measurable is the strongest single
    statement available about the port short of the golden CSV.
    """
    cfg = _single_canopy(config)
    ours_atm = Atmosphere(FAR_ELEV_M, cfg.site.T_pad, cfg.site.p_pad)
    run = simulate(cfg, CdS_coast=0.0, recovery_time_step=0.002)

    rho_ours, g_ours = ours_atm.rho(0.0), ours_atm.g(0.0)
    rho_or = run.atm.density(FAR_ELEV_M)
    g_or = wgs_gravity(FAR_LAT, FAR_ELEV_M)

    # v_t = sqrt(2 m g / (rho CdS)), so the ratio is sqrt(g ratio / rho ratio).
    predicted = math.sqrt((g_or / g_ours) / (rho_or / rho_ours)) - 1.0
    ours = integrate(cfg, CdS_body=0.0)
    observed = run.v_impact / ours.v_impact - 1.0

    assert predicted == pytest.approx(-0.000596, abs=2e-5)
    assert observed == pytest.approx(predicted, abs=2e-5)


# ===========================================================================
# 5. The three PLAN.md §2 defects, each as a number
# ===========================================================================


def test_defect_1_deployment_is_a_step_function(config):
    """`CdS` goes from zero to full between two integration points."""
    run = simulate(config)
    main = next(c for c in run.canopies if c.name == "main")

    i = next(k for k, t in enumerate(run.traj.t) if t >= main.t_deploy)
    before, after = run.traj.CdS[i - 1], run.traj.CdS[i]
    assert after - before == pytest.approx(main.CdS, rel=1e-9)
    # ...across a single step of the minimum length. Infinite jerk.
    assert run.traj.t[i] - run.traj.t[i - 1] == pytest.approx(orx.MIN_TIME_STEP,
                                                              abs=1e-9)
    # Which produces a deceleration no real canopy applies.
    assert max(abs(a) for a in run.traj.a) > 15.0 * 9.80665


def test_defect_2_no_opening_load_is_computed(config):
    """There is no opening-force calculation anywhere in OpenRocket -- only a
    warning above 20 m/s. `F_T` must stay None so the UI renders an absence
    rather than a zero, which would read as "no load".

    `Warning.HighSpeedDeployment` is reported as structured data rather than
    free text: it is a fact about OpenRocket's model, not about this config, so
    it belongs wherever the model is described and not in a list of notes about
    the numbers somebody typed.
    """
    run = simulate(config)
    assert run.traj.F_T is None

    assert [name for name, _ in run.high_speed_deployments] == ["main"]
    assert run.high_speed_deployments[0][1] == pytest.approx(25.6, abs=0.2)
    # ...and it does NOT leak into the config-level warnings.
    assert not any("20 m/s" in w for w in run.warnings)


def test_a_slow_deployment_trips_no_high_speed_warning(config):
    """The threshold is real, not decorative: nothing over 20 m/s, nothing
    reported. Without this the field could be unconditional and look right.

    Needs a genuinely slow vehicle. Moving the main higher is not enough --
    the worked example's drogue only settles at ~25 m/s, so the main still
    opens over the threshold wherever it is put.
    """
    cfg = copy.deepcopy(config)
    drogue = next(d for d in cfg.devices if d.name == "drogue")
    drogue.CdS = 1.0          # settles near 10 m/s instead of 25
    next(d for d in cfg.devices if d.name == "main").trigger.value = 400.0

    run = simulate(cfg)
    assert all(abs(c.v_deploy) < 20.0 for c in run.canopies)
    assert run.high_speed_deployments == []


def test_defect_3_airframe_drag_is_dropped_after_deployment(config):
    """`computeCD` iterates only deployed recovery devices.

    Before any deployment this port substitutes our axial airframe area (see
    the module docstring); the instant a canopy is out, the body contributes
    nothing at all, and total drag area is exactly the sum of the canopies.
    """
    run = simulate(config)
    axial = airframe_band(config.vehicle.d_body, config.vehicle.l_body)[0]

    assert run.traj.CdS[0] == pytest.approx(axial, rel=1e-12)

    drogue = next(c for c in run.canopies if c.name == "drogue")
    i = next(k for k, t in enumerate(run.traj.t) if t >= drogue.t_deploy)
    # Exactly the drogue: no airframe term survives.
    assert run.traj.CdS[i] == pytest.approx(drogue.CdS, rel=1e-12)
    assert run.traj.CdS[i] != pytest.approx(drogue.CdS + axial, rel=1e-9)


# ===========================================================================
# 6. Deployment timing
# ===========================================================================


def test_altitude_trigger_fires_late_by_up_to_one_step(config):
    """OpenRocket detects an altitude crossing only at step boundaries.

    Nothing clamps the step to a deployment altitude -- the ALTITUDE event is
    emitted *after* the step, carrying the pair it spanned -- so a canopy opens
    at the end of the step that crossed it. For the worked example the main is
    configured at 152 m and actually opens 7 m lower, at ~145 m, because it was
    doing 25.6 m/s through a 0.5 s step.
    """
    run = simulate(config)
    main = next(c for c in run.canopies if c.name == "main")

    i = next(k for k, t in enumerate(run.traj.t) if t >= main.t_deploy)
    z_open = run.traj.z[i]
    assert z_open < 152.0
    assert 152.0 - z_open == pytest.approx(7.1, abs=0.5)
    # Bounded by one nominal step's travel, which is what makes it a model
    # property rather than an accident.
    assert 152.0 - z_open <= abs(main.v_deploy) * orx.RECOVERY_TIME_STEP


def test_a_finer_step_deploys_closer_to_the_mark(config):
    """The corollary: the lateness is the step size, not a fixed offset."""
    coarse = simulate(config)
    fine = simulate(config, recovery_time_step=0.01)

    def open_altitude(run):
        main = next(c for c in run.canopies if c.name == "main")
        i = next(k for k, t in enumerate(run.traj.t) if t >= main.t_deploy)
        return run.traj.z[i]

    assert open_altitude(fine) > open_altitude(coarse)
    assert 152.0 - open_altitude(fine) < 0.5


def test_deploy_delay_has_a_one_millisecond_floor(config):
    """`event.getTime() + Math.max(0.001, deployConfig.getDeployDelay())`.

    A zero delay is not zero: OpenRocket always inserts a millisecond. It is
    physically meaningless and numerically real, and it is why the deployment
    step above is exactly MIN_TIME_STEP long.
    """
    cfg = copy.deepcopy(config)
    for d in cfg.devices:
        d.delay = 0.0
    run = simulate(cfg)

    drogue = next(c for c in run.canopies if c.name == "drogue")
    # TIME trigger at 2.0 s with zero delay maps to an APOGEE device whose
    # deployDelay is 2.0, so max(0.001, 2.0) leaves it at 2.0 exactly.
    assert drogue.t_deploy == pytest.approx(2.0, abs=1e-9)

    # ...but a device configured at apogee with no delay still waits 1 ms.
    cfg2 = copy.deepcopy(config)
    cfg2.devices = [d for d in cfg2.devices if d.name == "drogue"]
    cfg2.devices[0].trigger.value = 0.0
    cfg2.devices[0].delay = 0.0
    run2 = simulate(cfg2)
    assert run2.canopies[0].t_deploy == pytest.approx(orx.MIN_TIME_STEP,
                                                      abs=1e-12)


def test_time_trigger_maps_onto_an_apogee_device(config):
    """Our TIME trigger has no OpenRocket equivalent, so `trigger.value` and
    our `delay` both ride in `deployDelay`. The total lag to a fully open
    canopy is what has to be preserved."""
    cfg = copy.deepcopy(config)
    drogue = next(d for d in cfg.devices if d.name == "drogue")
    drogue.delay = 0.4

    canopies = orx.canopies_from(cfg)
    mapped = next(c for c in canopies if c.name == "drogue")
    assert mapped.kind is orx.APOGEE
    assert mapped.deploy_delay == pytest.approx(2.4)

    run = simulate(cfg)
    assert next(c for c in run.canopies
                if c.name == "drogue").t_deploy == pytest.approx(2.4, abs=1e-9)


# ===========================================================================
# 7. The run as a whole
# ===========================================================================


def test_the_descent_completes_and_lands(config):
    run = simulate(config)
    assert run.traj.z[-1] == pytest.approx(0.0, abs=1e-6)
    assert run.v_impact > 0.0
    assert all(c.deployed for c in run.canopies)
    assert 40.0 < run.t_ground < 80.0


def test_coast_substitution_is_bounded_by_its_two_ends(config):
    """The one place the port cannot be exact, kept honest.

    OpenRocket runs RK4 + Barrowman before the first deployment; we cannot.
    The default is our axial airframe area and the other bound is zero drag.
    The gap between them is what the substitution is worth -- small here, and
    reported as a number rather than assumed.
    """
    with_body = simulate(config)
    without = simulate(config, CdS_coast=0.0)

    # Zero coast drag means a faster drogue deployment speed, so the two
    # bracket the truth rather than agreeing.
    assert without.t_ground != pytest.approx(with_body.t_ground, rel=1e-9)
    assert abs(without.t_ground / with_body.t_ground - 1.0) < 0.01


def test_it_is_slower_than_us_because_it_drops_the_airframe(config):
    """The comparison the tab exists to draw, as an assertion.

    Same config, both models. Ours keeps the airframe in `CdS_total` (eq 13)
    for the whole descent; OpenRocket drops it the moment a canopy is out. On
    the worked example the drogue is 31x the axial airframe area so the effect
    is small, but it has a sign and the sign is not arbitrary.
    """
    theirs = simulate(config)
    ours = evaluate(config, "axial", "nominal")
    assert theirs.t_ground < ours.run.t_ground
    assert abs(theirs.t_ground / ours.run.t_ground - 1.0) < 0.02
