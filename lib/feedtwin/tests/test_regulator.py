"""The regulator: spec-sheet droop, and the two effects it is made of.

Everything here is checked against numbers a datasheet actually prints. The
model has no geometry in it on purpose -- see
:mod:`feedtwin.comps.regulator` for why a diaphragm force balance was
abandoned rather than deferred out of laziness.

The team's dome regulator is the worked example throughout: the Aqua
Environment 1092-50, 500 psi setpoint, 17 psi of outlet rise per 1000 psi of
inlet decay -- declared in the datasheet's own units, not as a bare ratio.
"""

from __future__ import annotations

import math

import pytest
from fluids.fittings import Cv_to_K

from feedtwin.comps import FlowConditions, build_component
from feedtwin.comps.regulator import IdealRegulator, Regulator
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.model.spec import SpecError
from feedtwin.model.units import get_unit

#: Exact, from the library's own table -- a truncated 6894.757 leaves a
#: 0.02 Pa round-trip error that these tolerances would otherwise chase.
PSI = get_unit("psi").factor

#: GN2 at roughly 500 psi and 293 K. Enough to exercise the seat term.
GAS = FlowConditions(rho=39.0, mu=1.78e-5, p_upstream=4500 * PSI, temperature=293.15)

M = Provenance.MANUFACTURER


def make(model: str = "droop", **overrides: object) -> Regulator:
    params = {
        "setpoint": Param(500.0, "psi", Provenance.MANUFACTURER, "PR-01 datasheet"),
        "supply_coefficient": Param(
            17.0,
            "psi/1000psi",
            Provenance.MANUFACTURER,
            "Aqua 1092-50: 17 psi per 1000 psi inlet",
        ),
        "inlet_reference": Param(
            4500.0, "psi", Provenance.MANUFACTURER, "setpoint measured at 4500 psi"
        ),
        "Cv": Param(0.8, "Cv", Provenance.MANUFACTURER, "datasheet"),
        "bore": Param(7.75, "mm", Provenance.MANUFACTURER, "3/8 seat"),
    }
    for key, value in overrides.items():
        params[key] = value  # type: ignore[assignment]
    built = build_component(
        ComponentInstance.build("PR-01", "regulator", params, model=model)
    )
    assert isinstance(built, Regulator)
    return built


def outlet(reg: Regulator, mdot: float, p_in: float) -> float:
    flow = FlowConditions(rho=39.0, mu=1.78e-5, p_upstream=p_in, temperature=293.15)
    return p_in - reg.pressure_drop(mdot, flow)


# ------------------------------------------------------- supply-pressure effect


def test_outlet_is_the_setpoint_at_the_reference_inlet() -> None:
    reg = make()
    assert outlet(reg, 0.01, 4500 * PSI) == pytest.approx(500 * PSI, rel=1e-9)


def test_outlet_rises_as_the_bottle_empties() -> None:
    """The sign people guess wrong: outlet goes UP as inlet goes DOWN."""
    reg = make()
    assert outlet(reg, 0.01, 1500 * PSI) > outlet(reg, 0.01, 4500 * PSI)


def test_supply_effect_matches_the_datasheet_number() -> None:
    """17 psi per 1000 psi, checked as the quoted rate and over a full decay."""
    reg = make()
    per_1000 = outlet(reg, 0.01, 3500 * PSI) - outlet(reg, 0.01, 4500 * PSI)
    assert per_1000 / PSI == pytest.approx(17.0, rel=1e-6)

    # Over a real COPV decay, 4500 -> 1500 psi.
    full = outlet(reg, 0.01, 1500 * PSI) / PSI
    assert full == pytest.approx(500.0 + 3.0 * 17.0, rel=1e-6)
    assert full == pytest.approx(551.0, abs=0.1)


def test_the_datasheet_rate_can_be_written_three_ways() -> None:
    """psi/1000psi, psi/100psi and psi/psi are the same number, and `-` is not.

    The whole point of giving this parameter its own dimension: a bare ratio
    reads the same whether the author meant 17 per thousand or 17 per hundred,
    and the solver cannot tell. Spelling the unit out makes the three agree and
    makes the fourth an error at load.
    """
    at = lambda p: outlet(p, 0.01, 1500 * PSI)
    a = at(make(supply_coefficient=Param(17.0, "psi/1000psi", M, "")))
    b = at(make(supply_coefficient=Param(1.7, "psi/100psi", M, "")))
    c = at(make(supply_coefficient=Param(0.017, "psi/psi", M, "")))
    assert a == pytest.approx(b) == pytest.approx(c)

    with pytest.raises(SpecError, match="dimensionless"):
        make(supply_coefficient=Param(0.017, "-", M, "bare ratio"))


def test_supply_effect_is_disabled_without_a_reference() -> None:
    """A coefficient with no datum silently does nothing -- so check() says so."""
    reg = make(inlet_reference=Param(0.0, "psi", Provenance.DEFAULT, "unset"))
    assert outlet(reg, 0.01, 1500 * PSI) == pytest.approx(500 * PSI, rel=1e-9)
    limits = [v.limit for v in reg.check()]
    assert "inlet_reference" in limits


# ------------------------------------------------------------------ flow droop


def test_flow_droop_is_a_separate_coefficient() -> None:
    """Cv does not produce it. This is the correction Rev D of the plan needed.

    At a tenth of rated flow the wide-open seat loses a couple of psi while a
    real unit has already drooped by ten. If Cv alone produced droop, these two
    regulators -- identical but for ``flow_droop`` -- would agree.
    """
    without = make()
    with_droop = make(
        flow_droop=Param(10.0, "psi", Provenance.MANUFACTURER, "droop at rated"),
        rated_flow=Param(0.10, "kg/s", Provenance.MANUFACTURER, "rated"),
    )
    p_without = outlet(without, 0.01, 4500 * PSI)
    p_with = outlet(with_droop, 0.01, 4500 * PSI)
    assert p_without - p_with == pytest.approx(1.0 * PSI, rel=1e-6)


def test_flow_droop_is_linear_in_rated_fraction() -> None:
    reg = make(
        flow_droop=Param(10.0, "psi", Provenance.MANUFACTURER, "droop"),
        rated_flow=Param(0.10, "kg/s", Provenance.MANUFACTURER, "rated"),
    )
    # Referenced to zero flow, where the droop term is exactly zero. A small
    # non-zero reference carries its own droop and biases every comparison.
    base = outlet(reg, 0.0, 4500 * PSI)
    for fraction in (0.25, 0.5, 1.0):
        sag = base - outlet(reg, fraction * 0.10, 4500 * PSI)
        assert sag / PSI == pytest.approx(10.0 * fraction, rel=1e-3)


def test_droop_without_a_rated_flow_is_flagged() -> None:
    reg = make(flow_droop=Param(10.0, "psi", Provenance.MANUFACTURER, "droop"))
    assert "rated_flow" in [v.limit for v in reg.check()]


def test_the_two_effects_oppose_each_other() -> None:
    """Inlet decay lifts the outlet; flow pulls it down. Both, at once."""
    reg = make(
        flow_droop=Param(51.0, "psi", Provenance.MANUFACTURER, "droop at rated"),
        rated_flow=Param(0.10, "kg/s", Provenance.MANUFACTURER, "rated"),
    )
    # 3000 psi of decay lifts by 51; full rated flow pulls down by 51.
    assert outlet(reg, 0.10, 1500 * PSI) == pytest.approx(500 * PSI, rel=1e-3)


# --------------------------------------------------------------- limits


def test_a_regulator_never_raises_pressure() -> None:
    """Inlet below setpoint: the outlet follows the inlet down.

    It does not track the inlet *exactly*, and that is right rather than a
    rounding error -- a wide-open regulator is still a restriction, so the
    outlet sits one seat-loss below the inlet. What must never happen is an
    outlet above the inlet, which is what a naive ``p_in - (p_in - setpoint)``
    would produce the moment the bottle falls below setpoint.
    """
    reg = make()
    flow = FlowConditions(39.0, 1.78e-5, 300 * PSI)
    dp = reg.pressure_drop(0.01, flow)
    assert dp > 0.0
    assert outlet(reg, 0.01, 300 * PSI) < 300 * PSI

    # The drop is exactly the wide-open seat's, nothing more.
    seat = (
        Cv_to_K(reg.p["Cv"], reg.p["bore"])
        * 0.5
        * 39.0
        * (0.01 / (39.0 * math.pi * reg.p["bore"] ** 2 / 4.0)) ** 2
    )
    assert dp == pytest.approx(seat, rel=1e-9)


def test_lockup_sets_the_no_flow_outlet() -> None:
    """What a downstream relief valve actually sees between firings."""
    reg = make(lockup_rise=Param(25.0, "psi", Provenance.MANUFACTURER, "lockup"))
    assert outlet(reg, 0.0, 4500 * PSI) == pytest.approx(525 * PSI, rel=1e-9)
    # And it is above the setpoint the tank is sized around, which is the point.
    assert outlet(reg, 0.0, 4500 * PSI) > reg.p["setpoint"]


def test_saturation_is_reported_not_hidden() -> None:
    """Past its capacity a regulator is a hole, and should say so."""
    reg = make()
    small = FlowConditions(39.0, 1.78e-5, 4500 * PSI)
    assert not reg.is_saturated(0.01, small)
    assert reg.is_saturated(2.0, small)

    violations = reg.envelope_violations(2.0, small)
    assert any(v.limit == "capacity" for v in violations)


def test_saturated_outlet_is_set_by_the_seat() -> None:
    reg = make()
    flow = FlowConditions(39.0, 1.78e-5, 600 * PSI)
    # At a flow the seat cannot pass, the drop is the seat's, not the setpoint's.
    dp = reg.pressure_drop(0.5, flow)
    assert dp > 600 * PSI - 500 * PSI
    assert reg.is_saturated(0.5, flow)


def test_dropout_below_minimum_differential() -> None:
    reg = make(
        min_inlet_differential=Param(50.0, "psi", Provenance.MANUFACTURER, "dropout")
    )
    ok = reg.envelope_violations(0.01, FlowConditions(39.0, 1.78e-5, 4500 * PSI))
    assert not any(v.limit == "min_inlet_differential" for v in ok)

    starved = reg.envelope_violations(0.01, FlowConditions(39.0, 1.78e-5, 520 * PSI))
    assert any(v.limit == "min_inlet_differential" for v in starved)


def test_assumed_droop_is_flagged_as_a_missing_measurement() -> None:
    """An unstated coefficient must not look like a perfect regulator."""
    reg = make(
        supply_coefficient=Param(0.0, "psi/psi", Provenance.DEFAULT, "not filled in"),
    )
    warnings = [v for v in reg.check() if v.limit == "supply_coefficient"]
    assert warnings and warnings[0].severity == "warning"


# ------------------------------------------------------------ fidelity models


def test_ideal_model_is_flat_and_named() -> None:
    """Distinguishable from a droop model with zero coefficients, on purpose."""
    reg = make(model="ideal")
    assert isinstance(reg, IdealRegulator)
    assert outlet(reg, 0.01, 4500 * PSI) == pytest.approx(500 * PSI)
    assert outlet(reg, 5.00, 1000 * PSI) == pytest.approx(500 * PSI)
    assert not reg.is_saturated(5.0, GAS)


def test_droop_and_ideal_agree_when_the_bottle_is_full() -> None:
    assert outlet(make(), 0.01, 4500 * PSI) == pytest.approx(
        outlet(make(model="ideal"), 0.01, 4500 * PSI), rel=1e-9
    )


def test_diagnostics_report_the_droop_from_setpoint() -> None:
    reg = make()
    out = reg.diagnostics(0.01, FlowConditions(39.0, 1.78e-5, 1500 * PSI))
    assert out["droop_from_setpoint"] / PSI == pytest.approx(51.0, abs=0.1)
    assert out["outlet_actual"] == pytest.approx(out["outlet_target"], rel=1e-9)
    assert out["saturated"] == 0.0


# ---------------------------------------------------- dome loading and bias


def dome_loaded(**overrides: object) -> Regulator:
    return make(
        dome_pressure=Param(450.0, "psi", M, "control regulator setting"),
        dome_bias=Param(50.0, "psi", M, "Aqua Environment 1092-50, +50 psi"),
        **overrides,  # type: ignore[arg-type]
    )


def test_a_dome_regulator_outlet_is_dome_plus_bias() -> None:
    """The 1092-50 delivers 50 psi above whatever its dome is loaded to."""
    reg = dome_loaded()
    assert reg.commanded_setpoint(GAS) / PSI == pytest.approx(500.0, rel=1e-9)
    # And that, not the configured `setpoint`, is what it holds.
    assert outlet(reg, 0.0001, 4500 * PSI) / PSI == pytest.approx(500.0, abs=0.1)


def test_the_bias_is_not_folded_into_the_setpoint() -> None:
    """Two regulators, same dome, different bias. They must differ by the bias.

    Folding the bias into the dome setting would make every scenario responsible
    for remembering to add 50 psi, and one day one of them would not.
    """
    biased = dome_loaded()
    unbiased = make(dome_pressure=Param(450.0, "psi", M, "same dome"))
    difference = biased.commanded_setpoint(GAS) - unbiased.commanded_setpoint(GAS)
    assert difference / PSI == pytest.approx(50.0, rel=1e-9)


def test_the_control_regulator_can_be_turned_during_a_run() -> None:
    """The dome is a signal, because on the stand it is a hand on a knob."""
    reg = dome_loaded()

    def at_dome(psi_value: float) -> float:
        flow = FlowConditions(
            rho=39.0,
            mu=1.78e-5,
            p_upstream=4500 * PSI,
            signals={"PR-01.dome": psi_value * PSI},
        )
        return reg.commanded_setpoint(flow) / PSI

    assert at_dome(400.0) == pytest.approx(450.0, rel=1e-9)
    assert at_dome(520.0) == pytest.approx(570.0, rel=1e-9)
    # Turning the control regulator down really does lower the outlet.
    assert at_dome(400.0) < at_dome(450.0) < at_dome(520.0)


def test_a_signal_beats_the_configured_dome() -> None:
    reg = dome_loaded()
    flow = FlowConditions(
        rho=39.0,
        mu=1.78e-5,
        p_upstream=4500 * PSI,
        signals={"PR-01.dome": 300.0 * PSI},
    )
    assert reg.commanded_setpoint(flow) / PSI == pytest.approx(350.0, rel=1e-9)


def test_droop_rides_on_the_dome_setting_not_on_the_configured_setpoint() -> None:
    """Both droop terms are relative to what the regulator was *told* to hold."""
    reg = dome_loaded(
        flow_droop=Param(20.0, "psi", M, "at rated"),
        rated_flow=Param(0.05, "kg/s", M, "rated"),
    )
    flow = FlowConditions(
        rho=39.0,
        mu=1.78e-5,
        p_upstream=4500 * PSI,
        signals={"PR-01.dome": 400.0 * PSI},
    )
    commanded = reg.commanded_setpoint(flow) / PSI
    assert commanded == pytest.approx(450.0)
    # Half of rated flow costs half the droop, measured from the commanded value.
    dp = reg.pressure_drop(0.025, flow)
    assert (4500 * PSI - dp) / PSI == pytest.approx(commanded - 10.0, abs=0.1)


def test_lockup_follows_the_dome() -> None:
    """What a downstream relief sees between firings moves with the knob."""
    reg = dome_loaded(lockup_rise=Param(25.0, "psi", M, "seat creep"))
    flow = FlowConditions(
        rho=39.0,
        mu=1.78e-5,
        p_upstream=4500 * PSI,
        signals={"PR-01.dome": 400.0 * PSI},
    )
    assert reg.lockup_pressure(flow) / PSI == pytest.approx(475.0, rel=1e-9)


def test_a_bias_with_no_dome_is_flagged() -> None:
    """A 50 psi offset that silently is not applied is worse than none."""
    reg = make(dome_bias=Param(50.0, "psi", M, "1092-50"))
    assert "dome_bias" in [v.limit for v in reg.check()]


def test_an_ideal_regulator_still_honours_the_dome() -> None:
    reg = make(
        model="ideal",
        dome_pressure=Param(450.0, "psi", M, "dome"),
        dome_bias=Param(50.0, "psi", M, "bias"),
    )
    assert outlet(reg, 0.01, 4500 * PSI) / PSI == pytest.approx(500.0, rel=1e-9)
