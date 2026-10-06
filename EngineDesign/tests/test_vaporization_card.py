"""The stability tab's vaporization card draws the droplet march that sets eta_vap, not a
model of its own.

It used to show L_vap = u_inj x tau_conv: injection speed held down the whole chamber, times the
chug lag (which on the Leonardi model includes a mixing lag). On the 6.5 kN ethalox doublet that
read 675 mm in a 199 mm chamber while the c* model had the fuel 95 % vaporized at 157 mm.
"""
import copy

import pytest

PSI = 6894.757
CFG = "configs/ethalox_6500N.yaml"


@pytest.fixture(scope="module")
def run():
    from engine.pipeline.io import load_config
    from engine.core.runner import PintleEngineRunner
    cfg = load_config(CFG)
    return PintleEngineRunner(copy.deepcopy(cfg)).evaluate(
        cfg.lox_tank.initial_pressure_psi * PSI, cfg.fuel_tank.initial_pressure_psi * PSI,
        silent=True, rich_stability=True)


def test_card_is_the_c_star_models_march(run):
    ce = run["diagnostics"]["cstar_efficiency"]
    vap = run["stability_rich"]["vaporization"]
    by = {s["stream"]: s for s in vap["streams"]}
    assert vap["L_ch_m"] == pytest.approx(ce["L_chamber_equiv"], rel=1e-12)
    for k in ("O", "F"):
        assert by[k]["frac_vaporized_end"] == pytest.approx(ce[f"frac_vaporized_{k}"], rel=1e-9)
        if ce[f"x_vap95_{k}"] is not None:
            assert by[k]["L_vap_m"] == pytest.approx(ce[f"x_vap95_{k}"] + ce["x_drop_formation"], rel=1e-9)
        prof = by[k]["remaining_profile"]
        assert prof[0] == [0.0, 1.0]                                   # all liquid at the face
        assert prof[-1][0] == pytest.approx(ce["L_chamber_equiv"], rel=1e-9)
        assert prof[-1][1] == pytest.approx(1.0 - ce[f"frac_vaporized_{k}"], abs=1e-9)
        assert all(a[1] >= b[1] - 1e-12 for a, b in zip(prof, prof[1:]))   # never re-condenses


def test_card_is_not_the_chug_lag_times_injection_speed(run):
    vap = run["stability_rich"]["vaporization"]
    lead = next(s for s in vap["streams"] if s["stream"] == vap["rate_limiting_stream"])
    u = run["diagnostics"][f"v_{lead['stream']}_bulk"]
    assert lead["L_vap_m"] != pytest.approx(u * lead["tau_conv_s"], rel=0.05)


def test_the_profile_run_does_not_change_the_solvers_march():
    """profile_points > 0 runs the Python march; the solver's (compiled) path must give the same."""
    from engine.pipeline.combustion_physics import spray_vaporization_march
    streams = [{"name": "O", "mass_fraction": 0.6, "D32": 90e-6, "rho_l": 1100.0, "cp_l": 1700.0,
                "T0": 90.0, "T_s": 140.0, "h_fg": 1.3e5},
               {"name": "F", "mass_fraction": 0.4, "D32": 150e-6, "rho_l": 750.0, "cp_l": 2600.0,
                "T0": 293.0, "T_s": 460.0, "h_fg": 5.4e5}]
    kw = dict(Pc=2.6e6, Tc=3200.0, gamma=1.14, R=350.0, m_dot_total=3.0, Ac=0.0127, L_chamber=0.18,
              u_drop0=25.0, rr_q=3.0)
    a = spray_vaporization_march(streams, **kw)
    b = spray_vaporization_march(streams, **kw, profile_points=40)
    assert "profile" not in a and len(b["profile"]["F"]) > 20
    for n in ("O", "F"):
        assert b["frac_vaporized"][n] == pytest.approx(a["frac_vaporized"][n], rel=1e-9)
        assert b["profile"]["F"][-1][1] == pytest.approx(b["frac_vaporized"]["F"], rel=1e-12)


def test_a_stream_not_95_percent_gone_says_how_far_it_got():
    from engine.pipeline.stability.report import _radar, _vaporization_profile
    march = {"L_chamber": 0.2, "x_drop_formation": 0.01, "streams": {
        "O": {"instant": False, "x95": 0.05, "frac_end": 1.0, "profile": [[0.0, 0.0], [0.2, 1.0]]},
        "F": {"instant": False, "x95": None, "frac_end": 0.9, "profile": [[0.0, 0.0], [0.2, 0.9]]}}}
    inp = {"D32_O": 9e-5, "D32_F": 1.5e-4, "tau_conv_O": 0.01, "tau_conv_F": 0.02, "tau_sens": 0.003}
    vap = _vaporization_profile(inp, 2.6e6, march=march)
    assert vap["rate_limiting_stream"] == "F" and vap["L_vap_m"] is None
    assert vap["vaporized_in_chamber"] is False
    ac = {"modes": []}
    assert _radar(1.5, ac, vap, 1.05)["values"][3] == pytest.approx(0.9 / 0.95)
