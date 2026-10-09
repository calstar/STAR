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


# ---------------------------------------------------------------------------------------
# COPV volume and density are declared, not assumed
# ---------------------------------------------------------------------------------------

def test_no_hardcoded_copv_density():
    """Fluid(density=200) was a number with no source on it.

    Real GN2 at 4500 psi / 293 K is 310 kg/m3 (CoolProp, Z = 1.150). At 200 a 5 L COPV
    caps at 1.0 kg, and the 1.551 kg a 5 L bottle actually holds made RocketPy refuse the
    tank as "overfilled" -- so the flight sim failed outright on a correctly specified COPV.
    """
    src = FLIGHT_SIM.read_text()
    assert 'Fluid(name="GN2_COPV", density=200)' not in src, "the invented 200 kg/m3 is back"
    assert "density=m_pressurant/(V_copv*0.999)" in src, (
        "COPV density must be mass/volume from the config, not a constant "
        "(the 0.999 is solver ullage -- see test_solver_ullage_is_small_and_conserves_mass)"
    )


def test_copv_geometry_follows_free_volume():
    """press_radius x press_h and free_volume_L could disagree; free_volume_L wins.

    It is the number the operator specifies and the one a propellant-volume budget counts.
    """
    src = FLIGHT_SIM.read_text()
    block = src[src.index("free_L = getattr"):src.index("press_geom = CylindricalTank", src.index("free_L = getattr"))]
    assert "V_copv = float(free_L)/1000.0" in block
    assert "press_h_eff = V_copv/(np.pi*config.press_tank.press_radius**2)" in block


def test_a_5L_copv_holds_what_a_5L_copv_holds():
    """The case that broke it: 5 L, 1.551 kg of GN2 at 4500 psi."""
    V, m = 0.005, 1.551
    assert m / V == pytest.approx(310.2, abs=1.0), "5 L at 4500 psi is ~310 kg/m3"
    assert m > V * 200.0, "at the old hardcoded 200 kg/m3 this tank reads as overfilled"
    assert V * 200.0 == pytest.approx(1.0, abs=0.01), "the old cap was 1.0 kg"


def test_gas_stub_comes_out_of_the_pressurant_mass():
    """A flat 0.01 kg added ALONGSIDE the liquid over-filled the COPV.

    With density derived as m_pressurant/V, the tank then held m_pressurant + 0.01 kg =
    0.0050322 m3 in a 0.0050000 m3 bottle, and RocketPy rejected it:
      "Input Function image (0.00503...) must be within the domain (0.0, 0.005)".
    """
    src = FLIGHT_SIM.read_text()
    assert "initial_gas_mass=0.01," not in src, "the additive 0.01 kg stub is back"
    assert "initial_liquid_mass=max(0.0, m_pressurant - 1.0e-4)," in src
    assert "initial_gas_mass=1.0e-4," in src

    # the arithmetic that broke it, on the 5 L / 1.551 kg COPV
    V, m = 0.005, 1.551
    rho = m / V
    assert (m + 0.01) / rho == pytest.approx(0.0050322, abs=1e-6), "the overflow"
    assert (m + 0.01) / rho > V, "additive stub must exceed the tank"
    assert m / rho == pytest.approx(V, rel=1e-12), "taking the stub out of m conserves volume"


def test_solver_ullage_is_small_and_conserves_mass():
    """The 0.1 % lives in the density, never in the mass."""
    src = FLIGHT_SIM.read_text()
    assert "density=m_pressurant/(V_copv*0.999)" in src
    V, m = 0.005, 1.551
    rho = m / (V * 0.999)
    assert m / rho == pytest.approx(0.999 * V, rel=1e-12), "fluid sits just inside the domain"
    assert rho * (0.999 * V) == pytest.approx(m, rel=1e-12), "mass is exact"
