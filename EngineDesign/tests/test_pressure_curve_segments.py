"""Tank-pressure curves from segments (layer2_pressure.generate_pressure_curve_from_segments).

The Time-Series tab asks for what it draws: a segment may rise or fall as the user's feed system
does, and a blowdown segment ends at its end pressure. Layer 2's
search keeps the old behaviour: rises forced into a 5 % fall, blowdown stopping short.
"""
import numpy as np
import pytest

from engine.optimizer.layers.layer2_pressure import generate_pressure_curve_from_segments as gen

PSI = 6894.757


def test_a_rising_segment_rises_when_asked():
    seg = [{"length_ratio": 1.0, "type": "linear", "start_pressure": 500 * PSI, "end_pressure": 540 * PSI}]
    c = gen(seg, n_points=50, allow_rise=True, exact_ends=True)
    assert c[0] == pytest.approx(500 * PSI) and c[-1] == pytest.approx(540 * PSI)
    assert np.all(np.diff(c) > 0)


def test_layer2_default_is_unchanged():
    seg = [{"length_ratio": 1.0, "type": "linear", "start_pressure": 500 * PSI, "end_pressure": 540 * PSI}]
    assert gen(seg, n_points=50)[-1] == pytest.approx(475 * PSI)          # forced 5 % fall
    bd = [{"length_ratio": 1.0, "type": "blowdown", "start_pressure": 600 * PSI, "end_pressure": 400 * PSI, "k": 0.5}]
    assert gen(bd, n_points=50)[-1] == pytest.approx((400 + 200 * np.exp(-0.5)) * PSI)


def test_exact_ends_blowdown_reaches_its_end():
    bd = [{"length_ratio": 1.0, "type": "blowdown", "start_pressure": 600 * PSI, "end_pressure": 400 * PSI, "k": 0.5}]
    c = gen(bd, n_points=50, exact_ends=True)
    assert c[0] == pytest.approx(600 * PSI) and c[-1] == pytest.approx(400 * PSI)
