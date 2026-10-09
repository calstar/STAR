"""Chamber lengths and the reported pressure profile (CN-1, CN-12).

CN-1: the chamber "length" is barrel + cone and leaves out the 1.5 Rt entrance arc; the solved
      contour was rebuilt from a stored length that went stale (it drew L* 1.0035 for 1.0000),
      and the cone/arc junction carried a duplicate vertex.
CN-12: the pressure profile was invented -- 1.10 Pc at the injector "for pintle injectors" and
      a throat at Pc -- where the throat static pressure is Pc (2/(g+1))^(g/(g-1)).
Geometry references are hand geometry on the drawn contour (1.5 Rt arc, 45 deg cone).
"""
import math
import os
import sys
import warnings

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.pipeline.io import load_config  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CG = load_config(os.path.join(ROOT, "configs", "ethalox_6500N.yaml")).chamber_geometry


def _solved(length):
    from engine.core.chamber_geometry_solver import solved_chamber_plot
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return solved_chamber_plot(CG.A_throat, CG.A_exit, CG.volume, CG.Lstar, CG.chamber_diameter,
                                   length, steps=2000)


def test_face_to_throat_includes_the_entrance_arc():
    pts, _, lengths = _solved(CG.length)
    Rt = math.sqrt(CG.A_throat / math.pi)
    assert lengths["entrance_arc"] == pytest.approx(1.5 * Rt * math.sin(math.pi / 4), rel=1e-12)
    x_face, x_throat = pts[:, 0].min(), pts[np.argmin(pts[:, 1]), 0]
    assert lengths["face_to_throat"] == pytest.approx(x_throat - x_face, abs=1e-6)
    assert lengths["face_to_throat"] == pytest.approx(0.15399, abs=5e-5)


def test_contour_closes_the_declared_volume_whatever_length_is_stored():
    for stored in (CG.length, CG.length + 0.01, None):
        pts, _, _ = _solved(stored)
        x, y = pts[:, 0], pts[:, 1]
        ch = x <= 1e-12
        V = float(np.sum(np.pi * 0.5 * (y[ch][1:] ** 2 + y[ch][:-1] ** 2) * np.diff(x[ch])))
        assert V / CG.A_throat == pytest.approx(CG.volume / CG.A_throat, abs=1e-4)


def test_contour_has_no_zero_length_segment():
    pts, _, _ = _solved(CG.length)
    seg = np.hypot(np.diff(pts[:, 0]), np.diff(pts[:, 1]))
    assert np.all(seg > 1e-12)


def test_pressure_profile_is_quasi_one_dimensional():
    from engine.core.chamber_profiles import calculate_chamber_pressure_profile
    Pc, g = 2.99e6, 1.1375
    p = calculate_chamber_pressure_profile(Pc, CG.Lstar, 2.8, g, 373.6, 3226.0, CG.A_throat,
                                           chamber_diameter=CG.chamber_diameter, volume=CG.volume)
    crit = (2 / (g + 1)) ** (g / (g - 1))
    assert p["P_injection"] == Pc
    assert p["P_throat"] == pytest.approx(Pc * crit, rel=0.01)
    # CEA finite-area combustor at CR 8.26 puts the nozzle stagnation 0.30 % below the face
    assert p["P0_nozzle"] == pytest.approx(Pc / 1.002971, rel=2e-4)
    assert all(b <= a for a, b in zip(p["pressures"], p["pressures"][1:]))
