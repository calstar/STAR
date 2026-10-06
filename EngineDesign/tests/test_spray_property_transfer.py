"""TN 4222 property transfer as a named model, loud failure on degenerate spray inputs, and the
accelerator gate for the transfer the kernel does not mirror."""
from __future__ import annotations

import copy
import math

import pytest

from engine.core import spray
from engine.core.spray import (
    TN4222_HEPTANE_MU, TN4222_HEPTANE_RHO, TN4222_HEPTANE_SIGMA, TN4222_RHO_AIR,
    smd_impinging_tn4222, smd_lefebvre, tn4222_property_factor, tn4222_transfer_model,
)

ETH = dict(rho_liq=789.0, mu_liq=1.2e-3, sigma=0.0223, rho_gas=2.2)


def test_transfer_models_are_the_published_exponents():
    tn = tn4222_property_factor("tn4087", **ETH)
    by_hand = ((0.0223 * 1.2e-3 / 789.0) / (TN4222_HEPTANE_SIGMA * TN4222_HEPTANE_MU / TN4222_HEPTANE_RHO)) ** 0.25 \
        * (2.2 / TN4222_RHO_AIR) ** -0.25
    assert tn == pytest.approx(by_hand, rel=1e-12)
    dj = tn4222_property_factor("dombrowski_johns", **ETH)
    by_hand = ((0.0223 ** 2 / (2.2 * 789.0)) / (TN4222_HEPTANE_SIGMA ** 2 / (TN4222_RHO_AIR * TN4222_HEPTANE_RHO))) ** (1 / 6)
    assert dj == pytest.approx(by_hand, rel=1e-12)
    assert tn4222_property_factor("none", **ETH) == 1.0
    # heptane in TN 4222's air is the reference for every transfer
    ref = dict(rho_liq=TN4222_HEPTANE_RHO, mu_liq=TN4222_HEPTANE_MU, sigma=TN4222_HEPTANE_SIGMA,
               rho_gas=TN4222_RHO_AIR)
    for t in spray.TN4222_PROPERTY_TRANSFERS:
        assert tn4222_property_factor(t, **ref) == pytest.approx(1.0, rel=1e-12)


def test_default_transfer_is_unchanged():
    from engine.pipeline.config_schemas import SMDConfig
    smd = SMDConfig()
    assert tn4222_transfer_model(smd) == "tn4087"
    assert tn4222_transfer_model(SMDConfig(smd_property_scaling=False)) == "none"
    assert tn4222_transfer_model(SMDConfig(smd_property_transfer="dombrowski_johns")) == "dombrowski_johns"
    a = smd_impinging_tn4222(1.5e-3, 30.0, **{k: ETH[k] for k in ("rho_liq", "mu_liq", "sigma", "rho_gas")})
    b = smd_impinging_tn4222(1.5e-3, 30.0, **ETH, transfer="tn4087")
    c = smd_impinging_tn4222(1.5e-3, 30.0, **ETH, transfer="dombrowski_johns")
    assert a == b and c == pytest.approx(a / tn4222_property_factor("tn4087", **ETH)
                                         * tn4222_property_factor("dombrowski_johns", **ETH), rel=1e-12)


@pytest.mark.parametrize("bad", [dict(v_jet=0.0), dict(d_jet=-1e-3), dict(rho_gas=float("nan")),
                                 dict(sigma=0.0)])
def test_degenerate_jets_raise_instead_of_returning_the_orifice(bad):
    kw = dict(d_jet=1.5e-3, v_jet=30.0, **ETH)
    kw.update(bad)
    with pytest.raises(ValueError):
        smd_impinging_tn4222(**kw)


@pytest.mark.parametrize("We,d", [(0.0, 1e-3), (100.0, 0.0), (float("inf"), 1e-3)])
def test_lefebvre_raises_on_degenerate_input(We, d):
    with pytest.raises(ValueError):
        smd_lefebvre(d, We, 0.01, 0.5, 0.6, 0.0)


def test_unmirrored_transfer_hands_the_injector_to_python():
    from engine import accel
    from engine.pipeline.io import load_config
    cfg = load_config("configs/impinging_smoke.yaml")
    assert accel.can_handle(cfg)                                 # a config the kernel takes
    none = copy.deepcopy(cfg)
    none.spray.smd.smd_property_transfer = "none"
    dj = copy.deepcopy(cfg)
    dj.spray.smd.smd_property_transfer = "dombrowski_johns"
    assert accel.can_handle(cfg) == accel.can_handle(none)      # mirrored by kernels._tn4222
    assert accel.can_handle(dj) is False
