"""Pad state resolution, PLAN.md §5 eqs (7a)/(7b) and the METAR decoder.

Ported from the standalone pad-state/test_pad_state.py when that module moved
into the package. Offline -- no test here touches the network.
"""

import pytest

from physics import pad_state as ps
from physics.atmosphere import geopotential


# --- eq (7a), the Phase 1 default -----------------------------------------


def test_isa_column_matches_the_published_table():
    for h, want in ((0.0, 101325.0), (1000.0, 89874.6), (1400.0, 85598.9),
                    (11000.0, 22632.1)):
        assert ps.p_pad_isa(h) == pytest.approx(want, abs=0.6)


def test_layer0_exponent():
    assert ps.EXP == pytest.approx(5.255877, abs=1e-5)


# --- eq (7b), the altimeter-setting inversion ------------------------------


def test_altimeter_inversion_round_trips_on_any_day():
    # The altimeter setting is *manufactured* from station pressure using the
    # standard column, so decoding it must round-trip to machine precision
    # regardless of what the real weather is doing.
    for p_station in (89874.6, 87000.0, 92500.0, 95123.7):
        setting = p_station / ps.column_ratio(1000.0)  # how the station computes it
        assert ps.p_pad_metar(setting, 1000.0) == pytest.approx(p_station, abs=1e-6)


def test_using_the_setting_raw_is_the_error_this_module_exists_to_prevent():
    # PLAN.md §5: at a 1000 m field reporting a standard setting, the naive
    # value is 101325 Pa against a true station pressure of 89874.6 Pa. That
    # 12.7% in density vanishes at sea level and grows with site height, so it
    # is invisible in testing and worst where these vehicles fly.
    h = 1000.0
    naive = 101325.0
    correct = ps.p_pad_metar(naive, h)
    assert correct == pytest.approx(89874.6, abs=0.6)
    assert naive / correct - 1.0 == pytest.approx(0.1274, abs=5e-4)


# --- METAR decoding --------------------------------------------------------

RAW = (
    "METAR KNID 290456Z AUTO 19013KT 10SM CLR 31/M03 A2981 "
    "RMK AO2 SLP070 T03061028 $"
)


def test_parses_station_time_and_altimeter():
    ob = ps.parse_metar(RAW)
    assert ob.station == "KNID"
    assert ob.time == "290456Z"
    assert ob.altim_pa == pytest.approx(29.81 * ps.INHG, abs=1e-6)


def test_precise_remark_beats_the_rounded_group():
    # T03061028 is +30.6 / -2.8; the rounded 31/M03 group would lose 0.4 K,
    # which is 0.14% in density -- comparable to everything else §5 chases.
    ob = ps.parse_metar(RAW)
    assert ob.temp_c == pytest.approx(30.6)
    assert ob.dewp_c == pytest.approx(-2.8)


def test_maintenance_flag_from_trailing_dollar():
    assert ps.parse_metar(RAW).maintenance is True


def test_falls_back_to_the_rounded_group():
    ob = ps.parse_metar("KMHV 291553Z 12008KT 10SM CLR 28/M01 A3012")
    assert ob.temp_c == pytest.approx(28.0)
    assert ob.dewp_c == pytest.approx(-1.0)
    assert ob.maintenance is False


def test_international_q_group_is_hectopascals():
    # Q1013 is 101300 Pa, not 1013 inHg. A factor of 33.86 if confused.
    ob = ps.parse_metar("EGLL 291550Z 24012KT 9999 FEW035 18/11 Q1013")
    assert ob.altim_pa == pytest.approx(101300.0, abs=1e-6)


def test_missing_temperature_raises():
    with pytest.raises(ValueError):
        ps.parse_metar("KNID 290456Z AUTO 19013KT 10SM CLR A2981")


# --- the FAR site, end to end ---------------------------------------------


def test_far_site_worked_case():
    h = geopotential(610.0)
    T_pad = (30.6 + 273.15) - ps.L0 * (697.0 - 610.0)  # lapse-transferred 87 m
    p_pad = ps.p_pad_metar(29.81 * ps.INHG, h)
    assert T_pad == pytest.approx(304.32, abs=0.01)
    assert p_pad == pytest.approx(93858.8, abs=0.5)
    assert ps.density(p_pad, T_pad) == pytest.approx(1.07446, abs=1e-4)


def test_temperature_dominates_pressure_by_an_order_of_magnitude():
    # The headline result of §5: bring a thermometer, look up your elevation,
    # everything else is noise.
    h = geopotential(610.0)
    T_pad = (30.6 + 273.15) - ps.L0 * (697.0 - 610.0)
    p_pad = ps.p_pad_metar(29.81 * ps.INHG, h)
    rho = ps.density(p_pad, T_pad)

    T_isa = ps.T0 + ps.L0 * h
    err_T = ps.density(p_pad, T_isa) / rho - 1.0
    err_p = ps.density(ps.p_pad_isa(h), T_pad) / rho - 1.0

    assert err_T == pytest.approx(0.0708, abs=5e-4)
    assert err_p == pytest.approx(0.0037, abs=5e-4)
    assert abs(err_T) > 10 * abs(err_p)


def test_humidity_correction_is_small_enough_to_defer():
    # rho_moist/rho_dry = 1 - 0.378 e/p. PLAN.md §5 defers it because it is
    # twenty times smaller than the Cx band; hold it to that.
    f = ps.virtual_factor(30.6, -2.8, 93858.8)
    assert 0.995 < f < 1.0
