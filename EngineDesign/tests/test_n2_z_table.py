"""copv/n2_Z_lookup.csv covers the pressures a COPV holds, not only a propellant tank's.

The table stopped at 8.3 MPa; RegularGridInterpolator(fill_value=None) extrapolates linearly past
it, so the COPV solvers read Z 1.039 at 26 MPa and 300 K where CoolProp gives 1.105. On the LE4 (3)
stand's 1.312 kg in 4.619 L that put the charge at 3810 psia instead of 4141 (CoolProp, 300 K,
284 kg/m3), and shifted every COPV sizing in the Time-Series panel and Layer 2 by the same few
per cent. Extended to 60 MPa from CoolProp, the rows inside the old range untouched.
"""

from __future__ import annotations

from pathlib import Path

import pytest

TABLE = Path(__file__).resolve().parents[1] / "copv" / "n2_Z_lookup.csv"


@pytest.fixture(scope="module")
def interp():
    from copv.blowdown_solver import load_Z_lookup_table

    return load_Z_lookup_table(str(TABLE))[0]


@pytest.mark.parametrize("T,P", [(300.0, 26e6), (300.0, 45e6), (250.0, 20e6), (90.0, 30e6)])
def test_copv_pressures_read_coolprop_not_an_extrapolation(interp, T, P):
    CP = pytest.importorskip("CoolProp.CoolProp")
    from copv.blowdown_solver import Z_lookup

    # On a tabulated temperature (90, 300) the value is CoolProp's own; 250 K sits between rows.
    tol = 1e-9 if T in (90.0, 300.0) else 2e-4
    assert Z_lookup(T, P, interp) == pytest.approx(CP.PropsSI("Z", "T", T, "P", P, "Nitrogen"), abs=tol)


def test_the_tank_range_is_unchanged(interp):
    """A propellant-tank state (300 K, 5 MPa) still reads the original grid."""
    CP = pytest.importorskip("CoolProp.CoolProp")
    from copv.blowdown_solver import Z_lookup

    assert Z_lookup(300.0, 5003015.075376884, interp) == pytest.approx(
        CP.PropsSI("Z", "T", 300.0, "P", 5003015.075376884, "Nitrogen"), abs=1e-12
    )
