"""Pressurant gas is dead mass, not propellant.

ui.flight_sim used to drain the entire COPV over the burn
(``mdot = m_pressurant / burn_time``) and hand that to a RocketPy
MassFlowRateBasedTank as ``liquid_mass_flow_rate_out``, which subtracts it from vehicle
mass. But the gas moves from the COPV into the ullage the departing propellant leaves
behind -- it is still on board at burnout. Flying it as propellant over-stated the mass
ratio, and running the tank to exactly zero made RocketPy raise outright.
"""
import math
import re
from pathlib import Path

import pytest

FLIGHT_SIM = Path(__file__).resolve().parents[1] / "ui" / "flight_sim.py"


def test_pressurant_mass_flow_is_zero():
    src = FLIGHT_SIM.read_text()
    block = src[src.index("m_pressurant = getattr"):src.index("print(f\"  Pressurant")]
    assert "m_pressurant / effective_burn_time" not in block, (
        "the COPV is being drained over the burn again; pressurant is not propellant"
    )
    assert re.search(r"mdot_pressurant_avg\s*=\s*0\.0", block), (
        "mdot_pressurant_avg must be 0.0 -- the gas stays on the vehicle"
    )


def test_pressurant_still_counts_toward_wet_mass():
    """Dead mass, not absent mass. It must still be in the initial mass sum."""
    src = FLIGHT_SIM.read_text()
    assert "total_initial_mass = rocket_mass + motor_dry_mass + m_lox0 + m_rp10 + m_pressurant" in src, (
        "pressurant dropped out of the initial mass; it is carried, just not expelled"
    )


def test_the_mass_ratio_error_this_caused():
    """Quantifies the defect on the 180 lb / 11 L point, so the fix has a number on it.

    Two different numbers, and they are not the same size -- worth keeping straight:

      * the IDEAL rocket equation gains ~51 m/s from flying 1.551 kg of gas as propellant;
      * the SIMULATED trajectory only gained 183 ft of apogee (12522 -> 12339 ft at
        eta_c* 0.9315, measured A/B on this vehicle).

    The trajectory effect is far smaller because the mass comes off gradually and the
    flight is drag-dominated at Mach 0.87. Do not quote the 51 m/s as an apogee error.
    """
    m_wet, m_prop, m_gas = 180 * 0.45359237, 10.7375, 1.551
    isp_eff = 238.72 * 9.80665
    dv_wrong = isp_eff * math.log(m_wet / (m_wet - m_prop - m_gas))   # gas flown as propellant
    dv_right = isp_eff * math.log(m_wet / (m_wet - m_prop))           # gas carried
    assert dv_wrong > dv_right, "expelling the gas must inflate the mass ratio"
    assert dv_wrong - dv_right == pytest.approx(51.0, abs=2.0), (
        f"ideal-dv overstatement changed: {dv_wrong - dv_right:.1f} m/s"
    )
    # and the measured trajectory effect, which is the number that actually matters
    apogee_bug_ft, apogee_fixed_ft = 12522.0, 12339.0
    assert apogee_bug_ft > apogee_fixed_ft
    assert (apogee_bug_ft / apogee_fixed_ft - 1) == pytest.approx(0.0148, abs=0.004), (
        "the simulated apogee inflation was 1.5 %, not the 15 % the rocket equation implies"
    )


def test_zero_flow_cannot_empty_the_tank():
    """The old model hit exactly -0.000 kg at burnout and RocketPy raised on it."""
    m_gas, burn = 1.551, 3.918
    assert m_gas - (m_gas / burn) * burn == pytest.approx(0.0, abs=1e-12), "the old model ran it dry"
    assert m_gas - 0.0 * burn == m_gas, "the fixed model leaves the COPV full"
