"""The injector discharge coefficient must not be used as a lever for other constraints.

`solver.closure.Cd_reduction_factor` used to default to 0.95. When the spray constraints
were violated the closure loop multiplied the injector Cd by it and tried again, up to
`max_iterations` times. That is not a discharge coefficient: a drilled orifice does not
flow less because its spray is long. Cd is orifice geometry and Reynolds number, full stop.

Measured on the 8 kN ethalox design point before this was fixed:

    Cd_geom(d=2.9 mm)            = 0.6055   (the physical answer)
    Cd after 5 reductions        = 0.6055 * 0.95**5 = 0.4685
    Cd the solver actually used  = 0.4686

A 23% error that propagates straight into orifice sizing. Size holes for Cd 0.47 and real
hardware at Cd 0.70 flows ~50% more: the same engine then makes +11.9% thrust and Pc, and
injector dP/Pc falls to 0.164, below the 0.20 chug floor.

And it never worked. The feedback has the WRONG SIGN -- lower Cd gives lower jet velocity,
which gives a larger SMD, which gives a LONGER evaporation length. Measured: x* went from
0.1256 m with the loop off to 0.1338 m with it on, against the 0.05 m limit it was chasing.
The loop simply exhausted its iterations having made the constraint worse.

An x* violation belongs in the infeasibility report (it is already in diagnostics as
`x_star`), not in the discharge coefficient.
"""
from __future__ import annotations

import math

import pytest

from engine.pipeline.config_schemas import ClosureConfig, DischargeConfig
from engine.core.discharge import cd_from_re, cd_inf_from_orifice_diameter

# the shipped ethalox discharge setup
_DISCHARGE = dict(Cd_inf=0.60, a_Re=0.18, Cd_min=0.35, use_geometry_cd=True,
                  d_ref_m=0.002, cd_small_hole_exponent=0.20, cd_large_hole_log_gain=0.015,
                  cd_inf_max=0.62, cd_inf_min_geom=0.48, d_min_m=0.0004)


def test_cd_reduction_defaults_to_off():
    """1.0 means the multiply is a no-op. Anything below 1.0 corrupts Cd."""
    assert ClosureConfig().Cd_reduction_factor == 1.0, (
        "Cd_reduction_factor must default to 1.0 (off). Below 1.0 the closure loop uses the "
        "discharge coefficient as a free variable to satisfy a spray-length constraint."
    )


def test_the_old_default_produced_the_observed_error():
    """Guard the guard: 0.95^5 is exactly the 23% error that was measured in the field."""
    cfg = DischargeConfig(**_DISCHARGE)
    cd_physical = cd_inf_from_orifice_diameter(2.893e-3, cfg)
    assert cd_physical == pytest.approx(0.6055, abs=5e-4)
    cd_corrupted = cd_physical * 0.95 ** 5
    assert cd_corrupted == pytest.approx(0.4686, abs=1e-3), (
        "0.6055 * 0.95**5 should reproduce the 0.4686 the solver was using"
    )
    assert cd_corrupted / cd_physical < 0.80, "the corruption should be >20%"


@pytest.mark.parametrize("d_mm", [1.5, 2.0, 2.5, 2.893, 3.5])
def test_cd_stays_in_the_physical_band(d_mm):
    """At real injector Reynolds numbers Cd must sit near its geometry value, not at Cd_min."""
    cfg = DischargeConfig(**_DISCHARGE)
    cd = cd_from_re(3.5e5, cfg, d_hyd_m=d_mm * 1e-3)
    assert 0.55 < cd < 0.65, (
        f"Cd = {cd:.4f} at d = {d_mm} mm and Re = 3.5e5. A drilled orifice at high Re sits "
        f"near its geometry asymptote; landing near Cd_min means something is driving it there."
    )
    assert cd > cfg.Cd_min * 1.4, "Cd should not be anywhere near the Cd_min clamp at high Re"


def test_zero_reynolds_is_the_no_flow_sentinel_only():
    """cd_from_re(0) returns Cd_min by design -- that is the NO-FLOW branch, not a real Cd.

    Four call sites pass a literal 0.0 when inlet pressure is below chamber pressure. That is
    correct in context (mdot is zero anyway), but it means Cd_min doubles as a sentinel, so a
    Cd landing on Cd_min in a FLOWING case is a signal that something is wrong.
    """
    cfg = DischargeConfig(**_DISCHARGE)
    assert cd_from_re(0.0, cfg, d_hyd_m=2.9e-3) == pytest.approx(cfg.Cd_min)
    assert cd_from_re(1.0e5, cfg, d_hyd_m=2.9e-3) > 0.55
