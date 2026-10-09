"""Back channels are dividing-flow rings, not a plenum; holes cavitate when K < (Cd/Cc)^2.

The old solve fed all 24 holes from one manifold pressure. With one port per ring the LOX channel
runs faster than its jets (velocity head ~ the injector drop), so holes near the port starve and
the far ones gain (Rohde, Richards & Metger, NASA TN D-5467; Acrivos, Babcock & Pigford 1959).
"""
import copy
import math

import pytest

PSI = 6894.757
CFG = "tests/fixtures/doublet_6500N_autochannel.yaml"


def _run(mutate):
    from engine.pipeline.io import load_config
    from engine.core.runner import PintleEngineRunner
    import os
    path = CFG if os.path.exists(CFG) else "configs/ethalox_6500N_doublet_2026-09-26.yaml"
    c = copy.deepcopy(load_config(path))
    mutate(c)
    r = PintleEngineRunner(c).evaluate(c.lox_tank.initial_pressure_psi * PSI,
                                       c.fuel_tank.initial_pressure_psi * PSI, silent=True)
    return r, r["diagnostics"]


def test_one_port_starves_the_holes_by_the_port():
    _, d = _run(lambda c: setattr(c.injector.plate, "channel_inlets", 1))
    assert d["manifold_model"] == "ring_network"
    assert d["element_flow_ratio_min_O"] < 0.8 < 1.1 < d["element_flow_ratio_max_O"]
    assert d["element_mass_flows_O"][0] == min(d["element_mass_flows_O"])     # port hole flows least
    assert d["Cd_O"] == pytest.approx(0.79, abs=0.01)             # the holes' own Cd
    assert d["Cd_eff_manifold_O"] < d["Cd_O"] - 0.05               # the manifold's loss, separately


def test_more_ports_flatten_the_distribution_toward_the_plenum():
    r4, d4 = _run(lambda c: setattr(c.injector.plate, "channel_inlets", 4))
    r1, d1 = _run(lambda c: setattr(c.injector.plate, "channel_inlets", 1))
    rp, _ = _run(lambda c: setattr(c.injector.plate, "manifold_model", "plenum"))
    spread = lambda d: d["element_flow_ratio_max_O"] - d["element_flow_ratio_min_O"]
    assert spread(d4) < 0.05 < spread(d1)
    assert abs(r4["MR"] - rp["MR"]) < abs(r1["MR"] - rp["MR"])
    assert r1["Pc"] < r4["Pc"] < rp["Pc"] * 1.0001


def test_a_wide_channel_recovers_the_plenum():
    from engine.core.injectors.impinging import _RingManifold
    rho, mu, dh = 1140.0, 2e-4, 1.6e-3
    cd_of = lambda Re, p: 0.8
    kw = dict(n_holes=24, n_ports=1, D_h=0.05, r_ring=0.035, A_hole=math.pi * dh ** 2 / 4, d_hole=dh,
              rho=rho, mu=mu, K_ent=0.5, C_R=1.0, roughness=0.0)
    wide = _RingManifold(A_ch=1.0, **kw)
    P, Pc = 3.5e6, 2.6e6
    per_hole = 0.8 * kw["A_hole"] * math.sqrt(2 * rho * (P - Pc))
    total, holes, _ = wide.march(24 * per_hole, P, Pc, cd_of)
    assert total == pytest.approx(24 * per_hole, rel=1e-6)
    assert max(holes) / min(holes) == pytest.approx(1.0, abs=1e-6)


def test_branch_march_matches_a_hand_calc_for_one_hole():
    from engine.core.injectors.impinging import _RingManifold, _churchill_f
    rho, mu, A_ch, dh = 1000.0, 1e-3, 2e-5, 1.5e-3
    net = _RingManifold(n_holes=2, n_ports=1, A_ch=A_ch, D_h=4e-3, r_ring=0.03,
                        A_hole=math.pi * dh ** 2 / 4, d_hole=dh, rho=rho, mu=mu, K_ent=0.5, C_R=0.0,
                        roughness=0.0)
    m, P, Pc = 0.05, 1.0e6, 0.2e6
    u = (m / 2) / (rho * A_ch)
    p = P - 1.5 * 0.5 * rho * u * u
    s = 2 * math.pi * 0.03 / 2
    p -= _churchill_f(rho * u * 4e-3 / mu, 0.0) * (0.5 * s / 4e-3) * 0.5 * rho * u * u
    q = 0.8 * math.pi * dh ** 2 / 4 * math.sqrt(2 * rho * (p - Pc))
    total, holes, _ = net.march(m, P, Pc, lambda Re, pp: 0.8)
    assert holes[0] == pytest.approx(q, rel=1e-12)
    assert total == pytest.approx(2 * q, rel=1e-12)


def test_churchill_matches_laminar_and_blasius():
    from engine.core.injectors.impinging import _churchill_f
    assert _churchill_f(1000.0, 0.0) == pytest.approx(64 / 1000.0, rel=0.02)
    assert _churchill_f(1e5, 0.0) == pytest.approx(0.316 * 1e5 ** -0.25, rel=0.05)


def test_holes_cavitate_at_start_when_the_chamber_is_at_one_atmosphere():
    from engine.core.injectors.impinging import _stream_flow
    from engine.core.discharge import contraction_coefficient
    from engine.pipeline.io import load_config
    cfg = load_config("configs/ethalox_6500N.yaml")
    dc = cfg.discharge["oxidizer"]
    A, d = 24 * math.pi * 1.6e-3 ** 2 / 4, 1.6e-3
    feed = lambda m: 0.0
    P_tank, Pc, Pv = 3.6e6, 101325.0, 101325.0
    m0, Cd0, *_ = _stream_flow(Pc, P_tank, 1140.0, A, d, 2e-4, dc, 90.0, 0.80, feed)
    m1, Cd1, *_ = _stream_flow(Pc, P_tank, 1140.0, A, d, 2e-4, dc, 90.0, 0.80, feed,
                               cav=(Pv, contraction_coefficient(0.0)))
    K = (P_tank - Pv) / (P_tank - Pc)
    assert Cd1 == pytest.approx(0.62 * math.sqrt(K), rel=1e-6)
    assert m1 < 0.8 * m0
    # hot fire (K ~ 4): the limit does nothing
    m2, Cd2, *_ = _stream_flow(2.6e6, P_tank, 1140.0, A, d, 2e-4, dc, 90.0, 0.80, feed,
                               cav=(Pv, contraction_coefficient(0.0)))
    m3, Cd3, *_ = _stream_flow(2.6e6, P_tank, 1140.0, A, d, 2e-4, dc, 90.0, 0.80, feed)
    assert m2 == pytest.approx(m3, rel=1e-12)


def test_kernel_mirrors_the_cavitation_limit_at_start():
    """At Pc = 1 atm the LOX holes cavitate; the numba injector must give the Python flow."""
    from engine import accel
    from engine.core.injectors import get_injector_model
    from engine.pipeline.io import load_config
    if not accel.available():
        pytest.skip("numba unavailable")
    cfg = load_config("configs/ethalox_6500N.yaml")
    if getattr(cfg.injector, "plate", None) is not None:
        cfg.injector.plate.manifold_model = "plenum"
    assert accel.can_handle(cfg)
    P = 584.27 * PSI
    got = accel.solve(cfg, P, P, 101325.0)
    mO, mF, d = get_injector_model(cfg).solve(P, P, 101325.0)
    assert d["Cd_O"] < 0.7          # the limit binds (Cc sqrt(K) ~ 0.62)
    assert got[0] == pytest.approx(mO, rel=1e-9)
    assert got[1] == pytest.approx(mF, rel=1e-9)


def test_declared_channel_flow_height_sets_the_manifold_area():
    """The CAD's channel (0.300 x 0.487 in LOX, 2 ports) is ~5x the auto-drawn one: the ring is
    then effectively a plenum (holes within +-1 %), and O/F returns to the plenum value."""
    IN = 0.0254

    def cad(c):
        pl = c.injector.plate
        pl.channel_inlets, pl.channel_width = 2, 0.3 * IN
        pl.channel_flow_height_O, pl.channel_flow_height_F = 0.487 * IN, 0.54 * IN

    r, d = _run(cad)
    from engine.core.injectors.layout import layout_from_config
    rp, _ = _run(lambda c: setattr(c.injector.plate, "manifold_model", "plenum"))
    assert d["element_flow_ratio_max_O"] - d["element_flow_ratio_min_O"] < 0.02
    assert r["MR"] == pytest.approx(rp["MR"], rel=0.01)
