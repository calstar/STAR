"""Devices: the §6.1.4 state machine, eqs (12)-(15), and the device table."""

import math

import pytest

from physics.devices import (
    DATA_DIR,
    KNOWN_A4_EXCEPTIONS,
    CdS_of,
    CdS_total,
    DeviceState,
    airframe_band,
    check_row,
    load_catalogue,
)
from physics.schema import Device, Trigger, TriggerKind


def make_device(**kw):
    kw.setdefault("CdS", 2.489)
    kw.setdefault("D0", 1.601)
    kw.setdefault("m_c", 0.213)
    kw.setdefault("trigger", Trigger(kind=TriggerKind.ALTITUDE, value=152.0))
    return Device(**kw)


class FakeAtm:
    site_elev = 0.0

    def rho(self, z):
        return 1.15


# --- the three-phase state machine, §6.1.4 --------------------------------


def test_state_starts_pending():
    s = DeviceState()
    assert s.pending and not s.triggered and not s.stretched


def test_fire_schedules_but_does_not_deploy():
    """The middle phase is real: charge fired, canopy still stowed. The
    reference implementation for this model crashed on exactly it, because
    t_d was set at the trigger while t_f was not yet defined."""
    s = DeviceState()
    s.fire(10.0, 0.5)
    assert s.triggered and not s.stretched
    assert s.t_x == 10.0 and s.t_d == 10.5
    assert s.t_f is None
    # And it must contribute no drag in that phase, without raising.
    assert CdS_of(make_device(), s, 10.2) == 0.0


def test_stretch_defines_v_s_and_t_f():
    d = make_device(n=8.0)
    s = DeviceState()
    s.fire(10.0, 0.5)
    s.stretch(10.5, 152.0, -25.0, d, FakeAtm(), 0.0)
    assert s.stretched
    assert s.v_s == 25.0                      # eq (9a): |v| at line stretch
    assert s.t_f == pytest.approx(d.s_f / 25.0)  # eqs (9), (10)
    assert s.rho_s == 1.15


def test_stretch_at_zero_speed_is_rejected_with_the_reason():
    """A trigger at exactly apogee with v0 = 0 makes eq (10) divide by zero
    and eq (23) return a bound of zero for a load that is not zero (§6.1.1)."""
    s = DeviceState()
    s.fire(0.0, 0.0)
    with pytest.raises(ValueError, match="zero speed"):
        s.stretch(0.0, 914.0, 0.0, make_device(), FakeAtm(), 0.0)


# --- eq (12) area growth ---------------------------------------------------


def test_area_growth_follows_tau_to_the_j():
    d = make_device(j=2, n=8.0)
    s = DeviceState()
    s.fire(0.0, 0.0)
    s.stretch(0.0, 152.0, -25.0, d, FakeAtm(), 0.0)
    t_f = s.t_f

    assert CdS_of(d, s, -1.0) == 0.0          # before line stretch
    assert CdS_of(d, s, 0.0) == 0.0           # tau = 0
    assert CdS_of(d, s, 0.5 * t_f) == pytest.approx(d.CdS * 0.25)
    assert CdS_of(d, s, t_f) == pytest.approx(d.CdS)
    assert CdS_of(d, s, 2 * t_f) == d.CdS     # clamped after full inflation


def test_slotted_canopy_grows_linearly():
    d = make_device(j=1, n=8.0)
    s = DeviceState()
    s.fire(0.0, 0.0)
    s.stretch(0.0, 152.0, -25.0, d, FakeAtm(), 0.0)
    assert CdS_of(d, s, 0.5 * s.t_f) == pytest.approx(d.CdS * 0.5)


def test_growth_is_monotonic():
    d = make_device()
    s = DeviceState()
    s.fire(0.0, 0.0)
    s.stretch(0.0, 152.0, -25.0, d, FakeAtm(), 0.0)
    xs = [CdS_of(d, s, k * s.t_f / 20.0) for k in range(25)]
    assert all(b >= a for a, b in zip(xs, xs[1:]))


# --- eq (13) total, including the airframe --------------------------------


def test_total_includes_the_airframe():
    """OpenRocket's computeCD iterates only deployed devices, so the body
    contributes nothing after deployment. That is a real error during drogue
    descent."""
    d = make_device()
    s = DeviceState()
    assert CdS_total([d], [s], 0.0, 0.05) == 0.05  # nothing deployed yet
    s.fire(0.0, 0.0)
    s.stretch(0.0, 152.0, -25.0, d, FakeAtm(), 0.0)
    assert CdS_total([d], [s], 10.0, 0.05) == pytest.approx(d.CdS + 0.05)


# --- eqs (14)/(15) the attitude band --------------------------------------


def test_airframe_band_ratio_is_2_55_times_fineness():
    for d_body, l_body in ((0.1016, 1.44), (0.152, 2.5), (0.075, 0.9)):
        axial, broadside = airframe_band(d_body, l_body)
        assert broadside / axial == pytest.approx(2.546 * l_body / d_body, rel=1e-3)


def test_airframe_band_for_the_worked_vehicle():
    axial, broadside = airframe_band(0.1016, 1.44)
    assert axial == pytest.approx(0.6 * math.pi * 0.1016 ** 2 / 4)
    assert broadside == pytest.approx(1.2 * 1.44 * 0.1016)
    assert broadside / axial == pytest.approx(36.1, abs=0.1)


# --- the device table, §4.1 -----------------------------------------------


def test_catalogue_loads_and_validates():
    cat = load_catalogue()
    assert len(cat) == 121
    # Six manufacturers; only 68 rows are Fruity Chutes.
    makers = {e.manufacturer for e in cat.values()}
    assert len(makers) == 6
    fruity = [e for e in cat.values() if e.manufacturer == "Fruity Chutes"]
    assert len(fruity) == 68


def test_ifc48_matches_the_worked_example_inputs():
    """§13.1's device row comes straight from the scraper. If the vendor
    revises a number, this is where it surfaces."""
    e = load_catalogue()["IFC-48"]
    assert e.CdS == pytest.approx(2.489, abs=0.001)     # eq (A1)
    assert e.D0 == pytest.approx(1.601, abs=0.001)      # eq (A2)
    assert e.m_c == pytest.approx(0.2126, abs=0.001)    # eq (A3)
    assert e.j == 2                                     # annular -> solid cloth


def test_spill_hole_convention_holds_catalogue_wide():
    """§4.1: area_projected EXCLUDES the spill hole -- the opposite of the
    Knacke convention. Pairing a vendor Cd with your own pi*D^2/4 overstates
    CdS by 3.2% on the IFC-48, silently, and that goes straight into eq (23).

    The convention could have been Fruity-Chutes-only, since they transcribe
    competitors into their own calculator. It is not.
    """
    cat = load_catalogue()
    holds = 0
    for e in cat.values():
        d = float(e.row["diameter_in"] or 0)
        ap = float(e.row["area_projected_sqft"] or 0)
        asp = e.row.get("area_spill_sqft")
        if not d or not ap or asp in (None, ""):
            continue
        geo = math.pi * (d / 12.0) ** 2 / 4.0
        if abs(ap + float(asp) - geo) / geo < 0.005:
            holds += 1
    assert holds >= 120, "the spill-hole convention should hold catalogue-wide"


def test_ifc48_spill_hole_is_exactly_3_2_percent():
    e = load_catalogue()["IFC-48"]
    d = float(e.row["diameter_in"])
    ap = float(e.row["area_projected_sqft"])
    geo = math.pi * (d / 12.0) ** 2 / 4.0
    assert geo / ap - 1.0 == pytest.approx(0.0320, abs=5e-4)


def test_known_vendor_errors_are_pinned_not_ignored():
    """CFC-30-S and CFC-36-S carry cd_area_canopy = 0.8000 where their own
    geometry requires 0.8427. It does not affect any CdS we compute, since
    eq (A1) reads the projected pair -- but a NEW inconsistency must still
    fail rather than hide behind a permissive check."""
    import csv
    import os

    with open(os.path.join(DATA_DIR, "parachutes.csv"), encoding="utf-8",
              newline="") as handle:
        rows = {r["sku"]: r for r in csv.DictReader(handle)}

    failing = {sku for sku, row in rows.items() if check_row(row)}
    assert failing == set(KNOWN_A4_EXCEPTIONS)

    # And the drag area we actually use is unaffected by the bad column.
    cat = load_catalogue()
    base = cat["CFC-30"]
    variant = cat["CFC-30-S"]
    assert variant.CdS == pytest.approx(base.CdS, rel=1e-9)


def test_a4_check_catches_a_mangled_cd():
    row = {
        "cd_projected": "1.9000", "area_projected_sqft": "12.1771",
        "cd_area_canopy": "1.2360", "area_canopy_sqft": "21.6752",
        "equivalent_flat_diameter_in": "63.0403",
        "rating_15fps_lb": "7.1729", "rating_20fps_lb": "12.7519",
    }
    problems = check_row(row)
    assert any(p.startswith("A4") for p in problems)
