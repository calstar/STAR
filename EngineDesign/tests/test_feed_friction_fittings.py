"""Feed-line loss from an itemised run: Colebrook friction at the actual Re, plus fittings.

    P_tank - P_manifold = (K_base + sum K_fittings + K1 phi(P)) q_line + K_exit q_exit
    K_base = K0                                   (roughness_m None: the measured override)
           = K_entrance + f(Re, e/D) L / D        (roughness_m set and mu given)

f is the Darcy factor from Colebrook-White. References: fluids.friction.Colebrook (the exact
Lambert-W solution) and Moody (1944) chart reads. Everything else is hand arithmetic.

Both new inputs are opt-in: a drawing that declares neither must give exactly the old number.
"""
from __future__ import annotations

import math
from pathlib import Path

import pytest
from pydantic import ValidationError

from engine.pipeline.config_schemas import FeedSystemConfig
from engine.pipeline.feed_loss import colebrook_darcy, darcy_friction_factor, delta_p_feed

ROOT = Path(__file__).resolve().parents[1]
PSI_TO_PA = 6894.76
D_TUBE = 0.010922            # 1/2" x 0.035" tube bore
A_TUBE = math.pi / 4.0 * D_TUBE ** 2
EPS_DRAWN_SS = 1.5e-6        # drawn stainless tube, Crane TP-410 A-23


def _q(mdot, rho, A):
    v = mdot / (rho * A)
    return 0.5 * rho * v * v


# Moody (1944) chart reads, +-1 %: smooth Re 1e5 -> 0.0180; e/D 1e-4 at Re 1e6 -> 0.0134;
# e/D 1e-3 at Re 1e4 -> 0.0324.
MOODY = [(1.0e5, 0.0, 0.0180), (1.0e6, 1.0e-4, 0.0134), (1.0e4, 1.0e-3, 0.0324)]


@pytest.mark.parametrize("Re,eD,f_chart", MOODY)
def test_colebrook_matches_moody_chart(Re, eD, f_chart):
    assert colebrook_darcy(Re, eD) == pytest.approx(f_chart, rel=0.01)
    assert darcy_friction_factor(Re, eD) == pytest.approx(f_chart, rel=0.01)


@pytest.mark.parametrize("Re,eD,_", MOODY)
def test_fallback_colebrook_is_fluids_colebrook(Re, eD, _):
    """The no-fluids fallback solves the same equation to machine precision."""
    fr = pytest.importorskip("fluids.friction")
    assert colebrook_darcy(Re, eD) == pytest.approx(fr.Colebrook(Re, eD), rel=1e-12)
    assert darcy_friction_factor(Re, eD) == pytest.approx(fr.Colebrook(Re, eD), rel=1e-12)


def test_laminar_is_64_over_re():
    assert colebrook_darcy(1000.0, 1e-3) == pytest.approx(0.064, rel=1e-15)
    assert darcy_friction_factor(1000.0, 1e-3) == pytest.approx(0.064, rel=1e-15)


def _fuel(**kw):
    base = dict(line_size="1/2_TUBE_035", K0=2.019, K1=0.0, length=0.9144)
    base.update(kw)
    return FeedSystemConfig(**base)


def test_fittings_sum_into_K_eff_on_the_K0_path():
    fit = [{"name": "1/2 in full-bore ball valve", "K": 0.081, "source": "Crane TP-410, 3 f_T"},
           {"name": "90 deg tube bend r/d 3", "K": 0.324, "source": "Crane TP-410, 12 f_T"}]
    cfg = _fuel(fittings=fit)
    dp = delta_p_feed(1.118, 789.0, cfg, 4.0e6)
    assert dp == pytest.approx((2.019 + 0.081 + 0.324 + 1.0) * _q(1.118, 789.0, A_TUBE), rel=1e-12)
    # and they add to the pressure-dependent term, not replace it
    cfg = _fuel(fittings=fit, K1=1e-4, phi_type="sqrtP")
    dp = delta_p_feed(1.118, 789.0, cfg, 4.0e6)
    K = 2.019 + 0.405 + 1e-4 * math.sqrt(4.0e6)
    assert dp == pytest.approx((K + 1.0) * _q(1.118, 789.0, A_TUBE), rel=1e-12)


def test_fitting_without_a_source_is_refused():
    with pytest.raises(ValidationError):
        _fuel(fittings=[{"name": "valve", "K": 2.0, "source": ""}])
    with pytest.raises(ValidationError):
        _fuel(fittings=[{"name": "valve", "K": 2.0}])


def test_roughness_replaces_K0_with_entrance_plus_colebrook_friction():
    mdot, rho, mu = 1.118, 789.0, 1.2e-3
    fit = [{"name": "ball valve", "K": 0.081, "source": "Crane TP-410, 3 f_T"}]
    cfg = _fuel(roughness_m=EPS_DRAWN_SS, fittings=fit)
    v = mdot / (rho * A_TUBE)
    Re = rho * v * D_TUBE / mu
    fr = pytest.importorskip("fluids.friction")
    f = fr.Colebrook(Re, EPS_DRAWN_SS / D_TUBE)
    K = 0.5 + f * 0.9144 / D_TUBE + 0.081
    assert delta_p_feed(mdot, rho, cfg, 4.0e6, mu=mu) == pytest.approx((K + 1.0) * _q(mdot, rho, A_TUBE), rel=1e-12)
    # f is evaluated at THIS call's Re: halving the flow raises f, so dp falls by less than 4x.
    f2 = fr.Colebrook(Re / 2, EPS_DRAWN_SS / D_TUBE)
    K2 = 0.5 + f2 * 0.9144 / D_TUBE + 0.081
    assert f2 > f
    assert delta_p_feed(mdot / 2, rho, cfg, 4.0e6, mu=mu) == pytest.approx((K2 + 1.0) * _q(mdot / 2, rho, A_TUBE), rel=1e-12)
    # K_entrance is a field
    cfg = _fuel(roughness_m=EPS_DRAWN_SS, K_entrance=0.04)
    K3 = 0.04 + f * 0.9144 / D_TUBE
    assert delta_p_feed(mdot, rho, cfg, 4.0e6, mu=mu) == pytest.approx((K3 + 1.0) * _q(mdot, rho, A_TUBE), rel=1e-12)


def test_roughness_without_viscosity_falls_back_to_K0():
    cfg = _fuel(roughness_m=EPS_DRAWN_SS)
    assert delta_p_feed(1.118, 789.0, cfg, 4.0e6) == pytest.approx(3.019 * _q(1.118, 789.0, A_TUBE), rel=1e-12)


def test_roughness_needs_a_length():
    with pytest.raises(ValidationError):
        FeedSystemConfig(line_size="1/2_TUBE_035", K0=2.019, K1=0.0, roughness_m=EPS_DRAWN_SS)


def test_shipped_6500N_feed_loss_is_unchanged():
    """ethalox_6500N declares neither fittings nor roughness_m: old formula to 1e-12, with or
    without a viscosity passed."""
    from engine.pipeline.io import load_config
    config = load_config(str(ROOT / "configs/ethalox_6500N.yaml"))
    for side, mdot in (("oxidizer", 1.68), ("fuel", 1.118)):
        cfg = config.feed_system[side]
        assert cfg.fittings == [] and cfg.roughness_m is None
        rho, mu = config.fluids[side].density, config.fluids[side].viscosity
        A = cfg.A_hydraulic
        Ax = math.pi * (cfg.d_exit / 2) ** 2 if cfg.d_exit else A
        for P in (3.0e6, 4.0e6):
            want = cfg.K0 * _q(mdot, rho, A) + cfg.K_exit * _q(mdot, rho, Ax)
            assert delta_p_feed(mdot, rho, cfg, P, mu=mu) == pytest.approx(want, rel=1e-12)
            assert delta_p_feed(mdot, rho, cfg, P, mu=mu) == delta_p_feed(mdot, rho, cfg, P)


# ---- accelerator -------------------------------------------------------------------------

# An impinging config the kernel takes (no ring-network manifold, no regen).
KERNEL_CFG = "configs/impinging_lox_ch4_8000N.yaml"


def _need_numba():
    from engine import accel
    if not accel.available():
        pytest.skip("numba unavailable")


def _with_feed(config, **kw):
    fs = {s: FeedSystemConfig(**{**config.feed_system[s].model_dump(), **kw.get(s, {})})
          for s in ("oxidizer", "fuel")}
    return config.model_copy(update={"feed_system": fs})


def test_kernel_carries_fittings_to_1e9():
    """params._feed folds the fittings into K0; the injector solve must still be Python's."""
    _need_numba()
    from engine import accel
    from engine.core.injectors import get_injector_model
    from engine.pipeline.io import load_config
    config = _with_feed(
        load_config(str(ROOT / KERNEL_CFG)),
        oxidizer={"fittings": [{"name": "LOX main solenoid", "K": 3.0, "source": "test value"}]},
        fuel={"fittings": [{"name": "fuel main solenoid", "K": 2.5, "source": "test value"},
                           {"name": "tee, run", "K": 0.4, "source": "test value"}]},
    )
    assert accel.can_handle(config)
    model = get_injector_model(config)
    P = 584.27 * PSI_TO_PA
    for Pc in (2.0e6, 2.6e6):
        got = accel.solve(config, P, P, Pc)
        assert got is not None
        mO, mF, want = model.solve(P, P, Pc)
        for name, g, w in (("mdot_O", got[0], mO), ("mdot_F", got[1], mF),
                           ("dpf_O", got[2]["delta_p_feed_O"], want["delta_p_feed_O"]),
                           ("dpf_F", got[2]["delta_p_feed_F"], want["delta_p_feed_F"])):
            assert g == pytest.approx(w, rel=1e-9), name


def test_roughness_configs_are_not_handled_by_the_kernel():
    _need_numba()
    from engine import accel
    from engine.pipeline.io import load_config
    config = load_config(str(ROOT / KERNEL_CFG))
    assert accel.can_handle(config)
    rough = _with_feed(config, fuel={"roughness_m": EPS_DRAWN_SS, "length": 0.5})
    assert not accel.can_handle(rough)
    res, outcome = accel.solve_ex(rough, 4.0e6, 4.0e6, 2.6e6)
    assert res is None and outcome == accel.Outcome.NOT_HANDLED
