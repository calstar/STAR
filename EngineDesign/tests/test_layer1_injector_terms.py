"""Layer 1 injector terms: ring co-location, vaporization budget, tilt sign, igniter thread,
closure-plate support, manifold velocity head.

Each expectation is hand arithmetic or an outside number (ASME B1.20.1 L2, Roark Table 11.2,
NASA TN D-5467 via layout.channel_velocity_head), not a replay of the optimizer.
"""
from __future__ import annotations

import math
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

import engine.optimizer.layers.layer1_static_optimization as L1
from engine.pipeline.io import load_config

ROOT = Path(__file__).resolve().parents[1]
# The committed config: output/ is gitignored, so a path there exists only on
# the machine that wrote it and the test failed everywhere else, CI included.
Y6500 = ROOT / "configs/ethalox_6500N_doublet_2026-09-26.yaml"
PSI = 6894.757
IN = 0.0254


# ---------------------------------------------------------------------------------------------
# 1. _impinging_geometry_fit_squared: no ring co-location, no vaporization budget
# ---------------------------------------------------------------------------------------------

def test_geometry_fit_does_not_reward_closing_the_ring_gap():
    """The co-location term charged (|D_pitch_O - D_pitch_F| / bore)^2, driving the ring gap --
    and the impingement standoff dr / (tan th_O + tan th_F) -- to zero."""
    bore = 0.127
    kw = dict(D_chamber_inner_m=bore, L_chamber_m=0.15)
    apart = L1._impinging_geometry_fit_squared({"D_pitch_O": 0.060, "D_pitch_F": 0.090}, **kw)
    together = L1._impinging_geometry_fit_squared({"D_pitch_O": 0.075, "D_pitch_F": 0.075}, **kw)
    assert apart == together == 0.0
    # Not vacuous: the ring-fit term it keeps still charges a ring outside the bore.
    out = L1._impinging_geometry_fit_squared({"D_pitch_O": 0.060, "D_pitch_F": 0.1397}, **kw)
    assert out == pytest.approx((0.1397 / bore - 1.0) ** 2, rel=1e-12)


def test_geometry_fit_charges_no_vaporization_length():
    """x* came from a second, cruder evaporation model and double-counted eta_vap (~142 points
    on the 6500N). A spray three chamber lengths long now costs nothing here."""
    diag = {"vaporization_length_total": 0.45, "L_imp": 0.006, "x_star": 0.44}
    assert L1._impinging_geometry_fit_squared(diag, D_chamber_inner_m=0.127, L_chamber_m=0.15) == 0.0
    assert L1._impinging_geometry_fit_squared(
        {"L_imp": 0.006, "x_star": 0.44}, D_chamber_inner_m=0.127, L_chamber_m=0.15) == 0.0


# ---------------------------------------------------------------------------------------------
# Tilt sign from the pitch circles, the same rule as the break-even
# ---------------------------------------------------------------------------------------------

def _tilt_kw():
    # LOX-heavy streams at equal angles: the resultant leans toward whichever way LOX travels.
    return dict(mdot_O=1.80, mdot_F=1.13, rho_O=1141.0, rho_F=789.0, n_elements=24,
                d_jet_O_m=0.00163, d_jet_F_m=0.00147, angle_O_deg=40.0, angle_F_deg=40.0)


def test_tilt_sign_follows_the_pitch_circles_not_the_ring_order_flag():
    """LOX outboard (s_O > s_F) travels INWARD to the collision, so a LOX-heavy pair leans
    inward -- whatever layer1_ring_order_fuel_outboard requested."""
    kw = _tilt_kw()
    lox_in = L1._impinging_resultant_tilt_deg(**kw, lox_inboard=True)
    assert lox_in > 0.0
    lox_out_geom = L1._impinging_resultant_tilt_deg(
        **kw, lox_inboard=True, spacing_O_m=0.0118, spacing_F_m=0.0091)
    assert lox_out_geom == pytest.approx(-lox_in, rel=1e-12)
    lox_in_geom = L1._impinging_resultant_tilt_deg(
        **kw, lox_inboard=False, spacing_O_m=0.0091, spacing_F_m=0.0118)
    assert lox_in_geom == pytest.approx(lox_in, rel=1e-12)


def test_tilt_and_breakeven_agree_on_which_ring_is_inboard():
    """Break-even takes theta of the inner ring (smaller D_pitch); the tilt's sign must use the
    same ring. Swapping the spacings swaps both."""
    n = 24
    for sO, sF in ((0.0091, 0.0118), (0.0118, 0.0091)):
        inner_is_O = n * sO / math.pi <= n * sF / math.pi
        assert L1._lox_ring_inboard(sO, sF) is inner_is_O
        be_O = L1._resultant_tilt_breakeven_deg(
            n_elements=n, spacing_O_m=sO, spacing_F_m=sF, angle_O_deg=30.0, angle_F_deg=50.0,
            D_chamber_inner_m=0.127, L_chamber_m=0.15)
        dr = 0.5 * abs(n * (sO - sF) / math.pi)
        L_imp = dr / (math.tan(math.radians(30.0)) + math.tan(math.radians(50.0)))
        th_in = 30.0 if inner_is_O else 50.0
        r_imp = 0.5 * n * min(sO, sF) / math.pi + L_imp * math.tan(math.radians(th_in))
        assert be_O == pytest.approx(math.degrees(math.atan2(0.0635 - r_imp, 0.15)), rel=1e-12)
        t = L1._impinging_resultant_tilt_deg(**_tilt_kw(), spacing_O_m=sO, spacing_F_m=sF)
        assert (t > 0) is inner_is_O


# ---------------------------------------------------------------------------------------------
# 3. Closure plate: support condition and plug radius
# ---------------------------------------------------------------------------------------------

def test_closure_plate_coefficients_are_roarks():
    """Roark Table 11.2, uniform load: simply supported k = 3(3+nu)/8 (centre), fixed k = 3/4
    (edge), sigma_max = k p a^2 / t^2."""
    assert L1._closure_plate_stress_coeff("simply_supported", 0.3) == pytest.approx(1.2375, rel=1e-12)
    assert L1._closure_plate_stress_coeff("simply_supported", 0.25) == pytest.approx(3 * 3.25 / 8)
    assert L1._closure_plate_stress_coeff("clamped") == 0.75
    assert L1._closure_plate_stress_coeff("fixed") == 0.75
    with pytest.raises(ValueError):
        L1._closure_plate_stress_coeff("bolted")


def test_closure_mass_uses_the_support_and_the_plug_radius():
    a_bore, a_plug, p, sig, rho, wall = 0.0635, 0.0762, 2.2e6, 205e6, 3400.0, 0.0381
    A_c = math.pi * a_bore ** 2
    barrel = L1._layer1_chamber_mass_kg(A_c, 0.1, wall, rho, Pc_pa=0.0)
    m = L1._layer1_chamber_mass_kg(A_c, 0.1, wall, rho, Pc_pa=p,
                                   plate_support="simply_supported", r_plate_m=a_plug)
    t = a_plug * math.sqrt(3.0 * 3.3 / 8.0 * p / sig)
    assert m - barrel == pytest.approx(math.pi * a_plug ** 2 * t * rho, rel=1e-12)
    # Previous behaviour, exactly, when neither is passed: fixed edge at the bore.
    m0 = L1._layer1_chamber_mass_kg(A_c, 0.1, wall, rho, Pc_pa=p)
    t0 = a_bore * math.sqrt(0.75 * p / sig)
    assert m0 - barrel == pytest.approx(math.pi * a_bore ** 2 * t0 * rho, rel=1e-12)


def test_plate_support_reads_a_declared_field_and_defaults_simply_supported():
    req = {}
    bare = SimpleNamespace(injector=SimpleNamespace(plate=SimpleNamespace(
        model_dump=lambda: {"back": "channels"})), discharge={})
    assert L1._layer1_injector_plate_constants(bare, req)["layer1_injector_plate_support"] == "simply_supported"
    declared = SimpleNamespace(injector=SimpleNamespace(plate=SimpleNamespace(
        support="clamped", model_dump=lambda: {"back": "channels", "support": "clamped"})), discharge={})
    assert L1._layer1_injector_plate_constants(declared, req)["layer1_injector_plate_support"] == "clamped"


# ---------------------------------------------------------------------------------------------
# 2 and 4. Sign-off gates on the 6500N doublet: igniter thread, manifold velocity head
# ---------------------------------------------------------------------------------------------

@pytest.fixture(scope="module")
def _python_physics():
    from engine import accel
    real = accel.enabled, accel.require
    accel.enabled = lambda: False
    accel.require = lambda: False
    try:
        yield
    finally:
        accel.enabled, accel.require = real


def _load(tmp_path: Path, edit=None):
    d = yaml.safe_load(Y6500.read_text())
    if edit:
        edit(d)
    p = tmp_path / "cfg.yaml"
    p.write_text(yaml.safe_dump(d))
    cfg = load_config(str(p))
    return cfg, cfg.design_requirements.model_dump()


@pytest.fixture(scope="module")
def solved(_python_physics):
    from engine.core.runner import PintleEngineRunner
    cfg = load_config(str(Y6500))
    P = 529.0414683968598 * PSI
    return PintleEngineRunner(cfg).evaluate(P_tank_O=P, P_tank_F=P)


def test_igniter_thread_engagement_gate(tmp_path):
    """1/2 NPT: L2 = 0.5337 in = 13.56 mm (ASME B1.20.1) against a 0.500 in (12.70 mm) plate."""
    cfg, req = _load(tmp_path)
    assert req["layer1_injector_plate_thickness_m"] == pytest.approx(0.5 * IN)
    ok, msg = L1._layer1_declared_limit_gates(cfg, req, {})["igniter_engagement"]
    assert not ok and "13.56 mm" in msg and "12.70 mm" in msg

    def hub(d):
        d["injector"]["igniter"]["hub_thickness"] = 0.014
    cfg, req = _load(tmp_path, hub)
    ok, _ = L1._layer1_declared_limit_gates(cfg, req, {})["igniter_engagement"]
    assert ok


def _q_hand(area, mdot, rho, dp, inlets):
    v = mdot / (2.0 * inlets) / (rho * area)
    return 0.5 * rho * v * v / dp


def test_manifold_gate_fails_one_port_and_passes_four(tmp_path, solved):
    from engine.core.injectors.layout import MANIFOLD_Q_FRAC, layout_from_config
    cfg, req = _load(tmp_path)
    gates = L1._layer1_declared_limit_gates(cfg, req, {}, performance=solved)
    ok_O, msg_O = gates["manifold_q_O"]
    assert not ok_O and "1 feed port" in msg_O
    dg = solved["diagnostics"]
    flows = {"mdot_O": solved["mdot_O"], "mdot_F": solved["mdot_F"],
             "dp_O": dg["delta_p_injector_O"], "dp_F": dg["delta_p_injector_F"]}
    lay = layout_from_config(yaml.safe_load(Y6500.read_text()), drawings=False, flows=flows)
    A_O = lay["passages"]["O"]["channel"]["flow_area"]
    assert A_O * 1e6 == pytest.approx(19.3, abs=0.5)          # the drawn LOX channel
    assert f"channel {A_O * 1e6:.1f} mm^2" in msg_O             # Layer 1 sizes the same channel
    rho_O = cfg.fluids["oxidizer"].density
    q = _q_hand(A_O, solved["mdot_O"], rho_O, dg["delta_p_injector_O"], 1)
    assert q > MANIFOLD_Q_FRAC
    assert lay["passages"]["O"]["channel"]["q_over_dp"] == pytest.approx(q, rel=1e-9)

    def four(d):
        d["injector"]["plate"]["channel_inlets"] = 4
    cfg4, req4 = _load(tmp_path, four)
    gates4 = L1._layer1_declared_limit_gates(cfg4, req4, {}, performance=solved)
    assert gates4["manifold_q_O"][0] and gates4["manifold_q_F"][0]
    assert _q_hand(A_O, solved["mdot_O"], rho_O, dg["delta_p_injector_O"], 4) == pytest.approx(q / 16)


def test_manifold_search_term_is_the_area_shortfall(tmp_path, solved):
    cfg, req = _load(tmp_path)
    c = L1._layer1_injector_plate_constants(cfg, req)
    g = cfg.injector.geometry
    dg = solved["diagnostics"]
    kw = dict(n_elements=g.oxidizer.n_elements, spacing_O_m=g.oxidizer.spacing,
              spacing_F_m=g.fuel.spacing, d_jet_O_m=g.oxidizer.d_jet, d_jet_F_m=g.fuel.d_jet,
              angle_O_deg=g.oxidizer.impingement_angle, angle_F_deg=g.fuel.impingement_angle,
              plate_thickness_m=c["layer1_injector_plate_thickness_m"],
              face_contoured=c["layer1_injector_face_contoured"],
              exit_land=c["layer1_injector_exit_land"],
              passage_ld_O=c["layer1_injector_land_ld_O"], passage_ld_F=c["layer1_injector_land_ld_F"],
              channel_width_m=c["layer1_injector_channel_width_m"],
              channel_floor=c["layer1_injector_channel_floor"],
              mdot_O=solved["mdot_O"], mdot_F=solved["mdot_F"],
              dp_O=dg["delta_p_injector_O"], dp_F=dg["delta_p_injector_F"],
              rho_O=cfg.fluids["oxidizer"].density, rho_F=cfg.fluids["fuel"].density)
    q1 = L1._impinging_manifold_q(**kw, channel_inlets=1)
    v1 = L1._impinging_manifold_violation(q1)
    hand = sum(max(0.0, h["area_needed"] / h["flow_area"] - 1.0) ** 2 for h in q1.values())
    assert v1 == pytest.approx(hand, rel=1e-12) and v1 > 0.0
    assert L1._impinging_manifold_violation(L1._impinging_manifold_q(**kw, channel_inlets=4)) == 0.0
    # No flows (a failed solve) => nothing to charge.
    assert L1._impinging_manifold_q(**dict(kw, mdot_O=None, mdot_F=None), channel_inlets=1) == {}
