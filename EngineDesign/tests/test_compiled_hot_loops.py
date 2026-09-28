"""The compiled spray march and area-Mach bisection are the NumPy ones, not approximations of them.

Both loops are compiled with numba purely for speed (together ~90 % of a Python chamber
evaluation). Each keeps its NumPy implementation as the reference, selectable by a module flag.
"""
import numpy as np
import pytest

PSI = 6894.757


def test_area_mach_bisection_matches_numpy(monkeypatch):
    from engine.pipeline.thermal import gas_side
    if gas_side._mach_bisect is None:
        pytest.skip("numba unavailable")
    rng = np.random.default_rng(3)
    ar = np.concatenate([rng.uniform(1.0, 30.0, 200), [1.0, 1.0 + 1e-13, 4.0]])
    for sup in (True, False):
        for g in (1.12, 1.2, 1.4):
            fast = gas_side.mach_from_area_ratio(ar, g, sup)
            monkeypatch.setattr(gas_side, "_USE_COMPILED_BISECT", False)
            ref = gas_side.mach_from_area_ratio(ar, g, sup)
            monkeypatch.setattr(gas_side, "_USE_COMPILED_BISECT", True)
            np.testing.assert_allclose(fast, ref, rtol=1e-14, atol=0)
    assert isinstance(gas_side.mach_from_area_ratio(5.6, 1.14, True), float)


def test_spray_march_matches_numpy_on_the_6500N(monkeypatch):
    from engine.pipeline import combustion_physics as cp
    from engine.pipeline.io import load_config
    from engine.core.runner import PintleEngineRunner
    if cp._march_core is None:
        pytest.skip("numba unavailable")
    cfg = load_config("configs/ethalox_6500N.yaml")
    P = 584.27 * PSI
    fast = PintleEngineRunner(cfg).evaluate(P, P, P_ambient=94070.0, silent=True)
    monkeypatch.setattr(cp, "_USE_COMPILED_MARCH", False)
    ref = PintleEngineRunner(cfg).evaluate(P, P, P_ambient=94070.0, silent=True)
    for k in ("F", "Pc", "MR", "eta_cstar", "Isp"):
        assert fast[k] == pytest.approx(ref[k], rel=1e-10), k
    a, b = fast["diagnostics"]["cstar_efficiency"], ref["diagnostics"]["cstar_efficiency"]
    for k in ("eta_vaporization", "frac_vaporized_F", "x_vap95_O", "x_vap95_F"):
        assert a[k] == pytest.approx(b[k], rel=1e-10), k


def test_spray_march_matches_numpy_across_sprays(monkeypatch):
    """Coarse and fine sprays, one stream at the face, short and long chambers."""
    from engine.pipeline import combustion_physics as cp
    if cp._march_core is None:
        pytest.skip("numba unavailable")
    base = dict(Pc=2.9e6, Tc=3200.0, gamma=1.14, R=377.0, m_dot_total=2.7, Ac=0.0127,
                u_drop0=24.0, rr_q=3.0)
    lox = dict(name="O", mass_fraction=0.6, rho_l=1140.0, cp_l=1700.0, T0=90.0, T_s=143.0, h_fg=1.1e5)
    eth = dict(name="F", mass_fraction=0.4, rho_l=789.0, cp_l=2440.0, T0=293.0, T_s=471.0, h_fg=5.06e5)
    cases = []
    for d32 in (20e-6, 60e-6, 200e-6):
        for L in (0.05, 0.12, 0.4):
            cases.append(([dict(lox, D32=d32), dict(eth, D32=1.3 * d32)], L))
    cases.append(([dict(lox, D32=50e-6, instant=True), dict(eth, D32=80e-6)], 0.12))
    for streams, L in cases:
        fast = cp.spray_vaporization_march(streams, L_chamber=L, **base)
        monkeypatch.setattr(cp, "_USE_COMPILED_MARCH", False)
        ref = cp.spray_vaporization_march(streams, L_chamber=L, **base)
        monkeypatch.setattr(cp, "_USE_COMPILED_MARCH", True)
        assert fast["F_throat"] == pytest.approx(ref["F_throat"], rel=1e-12)
        for name in ref["frac_vaporized"]:
            assert fast["frac_vaporized"][name] == pytest.approx(ref["frac_vaporized"][name], rel=1e-12)
            if ref["x_vap95"][name] is None:
                assert fast["x_vap95"][name] is None
            else:
                assert fast["x_vap95"][name] == pytest.approx(ref["x_vap95"][name], rel=1e-12)
