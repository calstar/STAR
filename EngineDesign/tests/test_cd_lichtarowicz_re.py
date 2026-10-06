"""Cd(Re) of a drilled orifice follows Lichtarowicz, Duggins & Markland (1965).

J. Mech. Eng. Sci. 7(2):210-219, sharp-inlet long orifice, non-cavitating, 2 <= L/d <= 10:

    1/Cd = 1/Cd_u + 20 (1 + 2.25 L/d)/Re - 0.0015 (L/d) / (1 + 7.5 [log10(0.00015 Re)]^2)
    Cd_u = 0.827 - 0.0085 L/d

The module anchors Cd_u to its inlet table (sharp 0.80 at the fit's L/d 3.18), which for a sharp
inlet reproduces the published Cd_u exactly; that is what the expected values below use. The old
law, Cd_inf - a_Re / sqrt(Re) with an unsourced a_Re = 0.18, sat ~0.06 high at Re 2e3.

Expected values are computed here from the paper's expression, not from the module.
"""
from __future__ import annotations

import math

import pytest

from engine.core.discharge import cd_from_re
from engine.pipeline.config_schemas import DischargeConfig


def _paper(Re: float, lod: float) -> float:
    cd_u = 0.827 - 0.0085 * lod
    inv = 1.0 / cd_u + 20.0 * (1.0 + 2.25 * lod) / Re \
        - 0.0015 * lod / (1.0 + 7.5 * math.log10(0.00015 * Re) ** 2)
    return 1.0 / inv


def _sharp(lod: float, **kw) -> DischargeConfig:
    return DischargeConfig(Cd_inf=0.60, a_Re=0.18, Cd_min=0.2, inlet_geometry="sharp",
                           orifice_l_over_d=lod, **kw)


@pytest.mark.parametrize("lod", [2.0, 3.0, 4.0, 6.0, 10.0])
@pytest.mark.parametrize("Re", [1.0e3, 3.0e3, 1.0e4, 5.0e4, 2.0e5, 1.0e6])
def test_matches_paper(Re, lod):
    got = cd_from_re(Re, _sharp(lod), d_hyd_m=1.5e-3)
    # The paper's expression can exceed Cd_u at very high Re and long L/d (its last term);
    # the module clamps at Cd_u, which is the only difference allowed.
    want = min(_paper(Re, lod), 0.827 - 0.0085 * lod)
    assert got == pytest.approx(want, rel=1e-12, abs=1e-12)


@pytest.mark.parametrize("Re, want", [(3.1e5, 0.7928), (3.4e4, 0.7901), (1.0e4, 0.784), (2.0e3, 0.736)])
def test_audit_magnitudes_ld4(Re, want):
    assert cd_from_re(Re, _sharp(4.0)) == pytest.approx(want, abs=0.002)


def test_piecewise_keeps_legacy_a_re():
    c = _sharp(4.0, length_model="piecewise")
    cd_inf = 0.80  # sharp, piecewise factor 1.0 at L/d 4
    assert cd_from_re(1.0e4, c) == pytest.approx(cd_inf - 0.18 / 100.0, rel=1e-12)


def test_no_inlet_keeps_legacy_a_re():
    c = DischargeConfig(Cd_inf=0.60, a_Re=0.18, use_geometry_cd=False, orifice_l_over_d=4.0)
    assert cd_from_re(1.0e4, c) == pytest.approx(0.60 - 0.18 / 100.0, rel=1e-12)
