"""Cross-check our Mach-dependent fin CP/CNa against RocketPy's native fins.

Skipped when rocketpy is not installed (heavy, optional dep -- not in CI). Asserts
the two documented facts: subsonic agreement (mutual validation), and the transonic
divergence our CP work exists to add (RocketPy's fin CP is fixed; ours migrates aft).
"""

from __future__ import annotations

import pytest

pytest.importorskip("rocketpy")

from backend.onshape.aero.rocketpy_compare import compare_fins_vs_mach  # noqa: E402


def test_subsonic_agrees_with_rocketpy():
    cmp = compare_fins_vs_mach(machs=[0.1, 0.3, 0.5])
    for i in range(len(cmp.mach)):
        assert cmp.our_cna[i] == pytest.approx(cmp.rocketpy_cna[i], rel=1e-2)
        assert cmp.our_cp[i] == pytest.approx(cmp.rocketpy_cp[i], abs=5e-4)


def test_rocketpy_fin_cp_is_mach_flat_but_ours_migrates_aft():
    cmp = compare_fins_vs_mach(machs=[0.3, 1.0, 2.0, 3.0])
    # RocketPy's fin CP never moves.
    assert max(cmp.rocketpy_cp) - min(cmp.rocketpy_cp) < 1e-9
    # Ours migrates monotonically aft (larger axial position = further back).
    assert all(b >= a - 1e-9 for a, b in zip(cmp.our_cp, cmp.our_cp[1:]))
    assert cmp.our_cp[-1] > cmp.our_cp[0] + 5e-3  # a clear supersonic shift
