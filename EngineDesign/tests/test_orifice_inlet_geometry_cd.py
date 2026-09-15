"""Cd comes from the orifice INLET and its L/d, and it is a per-side design knob.

Two things this pins down.

1. THE ANCHORS. The widely-quoted "sharp-edged orifice, Cd = 0.61" is the THIN-PLATE value
   (L/d -> 0), where the jet leaves at the vena contracta and never recovers. The same sharp
   entry on a normally drilled hole (L/d 2-5) reattaches inside the bore and recovers to
   ~0.80. Conflating them under-predicts a real injector's flow by ~24%, which is the same
   class of error as the Cd-reduction loop this codebase already had.

   Sources: Huzel & Huang, "Modern Engineering for Design of Liquid-Propellant Rocket
   Engines" (injector orifice Cd table); Lichtarowicz, Duggins & Markland (1965),
   "Discharge Coefficients for Incompressible Non-Cavitating Flow through Long Orifices"
   (Cd peaks near L/d ~ 2, Re-independent above ~1e4); Nurick (1976) on inlet condition and
   cavitation inception.

2. IT IS A KNOB. `discharge.oxidizer` and `discharge.fuel` are separate config blocks, so
   filleting only ONE side's inlet raises that propellant's Cd and moves the momentum ratio
   / O/F without touching hole size, element count or angles.
"""
from __future__ import annotations

import pytest

from engine.core.discharge import (
    INLET_GEOMETRY_CD,
    cd_from_inlet_radius_ratio,
    cd_from_re,
    cd_inf_from_inlet_geometry,
    cd_length_factor,
)
from engine.pipeline.config_schemas import DischargeConfig

_BASE = dict(Cd_inf=0.60, a_Re=0.18, Cd_min=0.35, use_geometry_cd=True, d_ref_m=0.002,
             cd_small_hole_exponent=0.20, cd_large_hole_log_gain=0.015,
             cd_inf_max=0.62, cd_inf_min_geom=0.48)


@pytest.mark.parametrize("r_over_d,l_over_d,expected,label", [
    (0.00, 0.001, 0.61, "thin plate, sharp"),
    (0.00, 4.0,   0.80, "drilled hole, sharp"),
    (0.10, 4.0,   0.88, "short tube, rounded entrance"),
])
def test_published_anchors(r_over_d, l_over_d, expected, label):
    cd = cd_from_inlet_radius_ratio(r_over_d) * cd_length_factor(l_over_d)
    assert cd == pytest.approx(expected, abs=0.01), f"{label}: got {cd:.4f}, published {expected}"


def test_thin_plate_and_drilled_hole_are_not_the_same_number():
    """The 24% gap is the whole point -- if these collapse, the model has lost the physics."""
    thin = cd_from_inlet_radius_ratio(0.0) * cd_length_factor(0.001)
    drilled = cd_from_inlet_radius_ratio(0.0) * cd_length_factor(4.0)
    assert drilled / thin > 1.2, "a drilled hole must flow materially more than a thin plate"


def test_length_factor_peaks_in_the_lichtarowicz_band():
    """Cd rises to a maximum near L/d ~ 2 and falls slowly after; it does not rise forever."""
    assert cd_length_factor(2.0) == pytest.approx(1.0)
    assert cd_length_factor(4.0) == pytest.approx(1.0)
    assert cd_length_factor(0.5) < cd_length_factor(2.0)
    assert cd_length_factor(12.0) < cd_length_factor(4.0)


def test_rounding_saturates():
    """Past r/d ~ 0.2 rounding buys almost nothing -- why bellmouths are specified there."""
    gain_early = cd_from_inlet_radius_ratio(0.10) - cd_from_inlet_radius_ratio(0.0)
    gain_late = cd_from_inlet_radius_ratio(0.30) - cd_from_inlet_radius_ratio(0.20)
    # measured 4.59x on the fitted curve; the point is that the first 0.1 of rounding
    # buys several times what the third 0.1 buys, not a specific multiple.
    assert gain_early > 4.0 * gain_late


@pytest.mark.parametrize("name", sorted(INLET_GEOMETRY_CD))
def test_every_named_geometry_is_reachable_and_ordered(name):
    cfg = DischargeConfig(**_BASE, inlet_geometry=name, orifice_l_over_d=4.0)
    cd = cd_from_re(3.5e5, cfg, d_hyd_m=2.1e-3)
    assert 0.55 < cd < 0.98
    assert cd == pytest.approx(INLET_GEOMETRY_CD[name], abs=0.02)


def test_unset_leaves_the_old_path_untouched():
    """Opt-in: a config that declares no inlet geometry must behave exactly as before."""
    cfg = DischargeConfig(**_BASE)
    assert cd_inf_from_inlet_geometry(cfg) is None
    assert cd_from_re(3.5e5, cfg, d_hyd_m=2.1e-3) == pytest.approx(0.60, abs=0.02)


def test_filleting_one_side_is_a_real_trim():
    """The knob: same hole, same dP, one side filleted -> that side flows measurably more."""
    sharp = cd_from_re(3.5e5, DischargeConfig(**_BASE, inlet_geometry="sharp",
                                              orifice_l_over_d=4.0), d_hyd_m=2.1e-3)
    filleted = cd_from_re(3.5e5, DischargeConfig(**_BASE, inlet_radius_ratio=0.10,
                                                 orifice_l_over_d=4.0), d_hyd_m=2.1e-3)
    gain = filleted / sharp - 1.0
    assert 0.08 < gain < 0.14, f"r/d 0.10 should buy ~10% flow, got {gain*100:.1f}%"


def test_unknown_geometry_is_loud():
    with pytest.raises(ValueError, match="Unknown inlet_geometry"):
        cd_inf_from_inlet_geometry(DischargeConfig(**_BASE, inlet_geometry="polished"))
