"""The inline 1-DOF ascent (D5-C): the specific force a burn pass can read at each twin step
without flying the whole burn first.

Checked against a closed form (Tsiolkovsky with gravity, no air), against RocketPy on LE4's saved
delivered curve (AUDIT 9.3 5: 0.002 %), and on the pad (exactly one g0 while the vehicle is held).
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from engine.layerx import flight as flt
from test_layerx_flight import SITE_PA, built_flight, le4_arrays, le4_config, le4_loads, le4_payload

G0 = 9.80665


@pytest.fixture(scope="module")
def config():
    return le4_config()


@pytest.fixture(scope="module")
def rocketpy_le4(config):
    """LE4's curve flown in RocketPy with the config's own COPV: the reference."""
    _, res = built_flight(config, le4_payload(), le4_loads())
    return res["flight"]


# ---------------------------------------------------------------------- closed form


def test_no_air_constant_thrust_is_tsiolkovsky():
    """No drag, no pressure thrust, constant F and mdot: the specific force is F/m(t) exactly, and
    v = c ln(m0/m) - g0 t, z = c [t - (m/mdot) ln(m0/m)] - g0 t^2/2 with c = F/mdot (Sutton &
    Biblarz, Rocket Propulsion Elements, 9th ed., ch. 4, vertical flight without drag)."""
    m0, F, md = 80.0, 7000.0, 3.0
    t = np.linspace(0.0, 3.5, 71)
    ascent = flt.InlineAscent(mass_kg=m0, reference_area_m2=0.0193, nozzle_exit_area_m2=0.0, elevation_m=626.67,
                              reference_pressure_pa=None, drag=None, dt_max=0.01)
    c = F / md
    for tk in t:
        a = ascent.advance(float(tk), F, md)
        m = m0 - md * tk
        assert a == pytest.approx(F / m, rel=1e-12)
        assert ascent.m == pytest.approx(m, rel=1e-12)
        assert ascent.v == pytest.approx(c * math.log(m0 / m) - G0 * tk, abs=1e-6)
        assert ascent.z == pytest.approx(c * (tk - m / md * math.log(m0 / m)) - 0.5 * G0 * tk * tk, abs=1e-6)
    assert ascent.liftoff_time_s == 0.0


# ---------------------------------------------------------------------- against RocketPy


def test_inline_matches_rocketpy_through_the_burn(config, rocketpy_le4):
    """LE4's saved delivered curve, the same vehicle (mass, drag, nozzle, pad): the inline ascent's
    specific force against RocketPy's at every firing sample while RocketPy's motor burns."""
    t, F, mO, mF = le4_arrays()
    fl = rocketpy_le4
    mass = flt.liftoff_mass(config, le4_loads(), ambient_pa=SITE_PA)
    assert mass["value"] == pytest.approx(float(fl.rocket.total_mass(0.0)), abs=1e-3)
    out = flt.inline_specific_force(config, F, mO + mF, t, mass["value"], SITE_PA)
    tb = float(fl.rocket.motor.burn_out_time)
    burning = t <= tb
    assert burning.sum() == len(t) - 1   # the last sample is 1.2 ms past RocketPy's cutoff
    ours = np.asarray(out["accel_m_s2"])[burning]
    theirs = np.array([flt.axial_acceleration(fl, float(x)) for x in t[burning]])
    assert np.max(np.abs(ours / theirs - 1.0)) < 1e-4            # measured 0.0023 %
    assert out["held"] == [False] * len(t) and out["liftoff_time_s"] == 0.0
    # The state too: RocketPy's altitude and speed at the last burning sample.
    k = int(np.flatnonzero(burning)[-1])
    assert out["altitude_m"][k] == pytest.approx(float(fl.z(t[k])) - config.environment.elevation, rel=2e-3)
    assert out["velocity_m_s"][k] == pytest.approx(float(fl.vz(t[k])), rel=1e-3)


def test_inline_is_a_drop_in_for_the_flown_schedule(config):
    """``{t, accel_m_s2}`` on the burn's clock, as ``fly``'s schedule: the outer loop's own measure
    of change between them is far inside its tolerance."""
    t, F, mO, mF = le4_arrays()
    flown = flt.fly(config, le4_payload(), le4_loads(), SITE_PA)
    assert flown["ok"], flown.get("error")
    out = flt.inline_specific_force(config, F, mO + mF, t, flown["liftoff_mass_kg"], SITE_PA)
    assert out["t"] == flown["schedule"]["t"]
    assert flt.schedule_change(flown["schedule"], out) < 0.02 * flt.ACCEL_TOLERANCE   # measured 2.3e-5


# ---------------------------------------------------------------------- the pad


def test_held_on_the_pad_reads_exactly_one_g(config):
    """Before Fire (zero thrust) and while thrust is below the weight the stand carries the vehicle:
    it does not move and its columns feel exactly g0, the pad's ``Setup.body_acceleration``. The
    first sample whose thrust beats the weight releases it."""
    m0 = 80.0
    w = m0 * G0
    t = [-0.5, -0.25, 0.0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30]
    F = [0.0, 0.0, 0.0, 0.3 * w, 0.6 * w, 0.9 * w, 1.5 * w, 8.0 * w, 8.0 * w]
    md = [0.0, 0.0, 0.0, 0.5, 1.0, 1.5, 2.5, 3.0, 3.0]
    out = flt.inline_specific_force(config, F, md, t, m0, SITE_PA)
    for k in range(6):
        assert out["accel_m_s2"][k] == G0 and out["held"][k], k
        assert out["altitude_m"][k] == 0.0 and out["velocity_m_s"][k] == 0.0, k
    # Mass leaves while it is held: the propellant flows whether or not the vehicle moves.
    assert out["mass_kg"][5] == pytest.approx(m0 - (0.25 + 0.75 + 1.25) * 0.05, rel=1e-12)
    assert not out["held"][7] and out["accel_m_s2"][7] > 7.0 * G0
    assert 0.15 <= out["liftoff_time_s"] <= 0.20
    assert out["velocity_m_s"][8] > 0.0 and out["altitude_m"][8] > 0.0


def test_stepped_one_sample_at_a_time_is_the_same(config):
    """Causal: a burn pass that drives the ascent step by step gets what the batch call returns."""
    t, F, mO, mF = le4_arrays()
    m0 = 80.0
    batch = flt.inline_specific_force(config, F, mO + mF, t, m0, SITE_PA)
    ascent = flt.InlineAscent.from_config(config, m0, SITE_PA)
    stepped = [ascent.advance(float(a), float(b), float(c)) for a, b, c in zip(t, F, mO + mF)]
    assert stepped == batch["accel_m_s2"]


def test_the_model_block_lists_its_inputs(config):
    t, F, mO, mF = le4_arrays()
    out = flt.inline_specific_force(config, F, mO + mF, t, 80.0, SITE_PA)
    model = out["model"]
    assert model["name"] == "inline_vertical_1dof" and "Sutton" in model["source"] and model["assumptions"]
    for name, row in model["inputs"].items():
        assert set(row) == {"value", "unit", "provenance"} and row["provenance"], name
    assert "schema default" in model["inputs"]["surface_roughness_m"]["provenance"]


def test_bad_input_is_refused(config):
    with pytest.raises(ValueError):
        flt.inline_specific_force(config, [1.0, 2.0], [1.0], [0.0, 1.0], 80.0, SITE_PA)
    with pytest.raises(ValueError):
        flt.inline_specific_force(config, [1.0, 2.0], [1.0, 1.0], [1.0, 0.0], 80.0, SITE_PA)
    with pytest.raises(ValueError):
        flt.InlineAscent(mass_kg=0.0, reference_area_m2=0.0, nozzle_exit_area_m2=0.0, elevation_m=0.0,
                         reference_pressure_pa=None)
