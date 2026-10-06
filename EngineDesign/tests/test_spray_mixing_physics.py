"""Mixing, vaporization and drop-size physics against references outside the code.

    eta_mix = sum_i w_i c*(O/F_i) / c*(O/F)      stream tubes (Pieper, Dean & Valentine, JSR 4(6) 1967)
    E_m     = 1 - sum_{r<R} w (R-r)/R - sum_{r>R} w (r-R)/(1-R)       Rupe (JPL TR 32-1546 eq. 1)
    eta_vap = F c*(O/F_vap) / c*(O/F)            Priem & Heidmann (NASA TR R-67)

References: rocketcea (LOX / Ethanol cards, the ones the CEA cache is built from), CoolProp, JPL TR
32-1546 Fig. 1 digitized, Abramzon & Sirignano (1989), Yuen & Chen (1976), and an independent scipy
integration of the drop equations. Numbers that need rocketcea are pinned for CI.
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from engine.pipeline import combustion_physics as cp
from engine.pipeline.config_schemas import CombustionEfficiencyConfig

PSI = 6894.757293168361
R_U = 8314.462618


def _rocketcea():
    try:
        from rocketcea.cea_obj import CEA_Obj
    except Exception:
        return None
    return CEA_Obj(oxName="LOX", fuelName="Ethanol")


def _synthetic_cstar(Pc=2.2e6):
    """A smooth peaked c*(O/F), Pc-independent: 1700 exp(-0.3 ln(MR/1.55)^2) m/s."""
    MR = np.geomspace(0.1, 20.0, 400)
    Pcs = np.geomspace(1e5, 1.2e7, 4)
    c = 1700.0 * np.exp(-0.3 * np.log(MR / 1.55) ** 2)
    tab = cp.CstarWideTable("X", "Y", MR, Pcs, np.repeat(c[:, None], Pcs.size, axis=1))
    return cp.CstarOfMR(Pc, wide=tab)


def _wide_or_skip():
    tab = cp.get_cstar_wide_table("LOX", "Ethanol")
    if tab is None:
        pytest.skip("no wide c* table for LOX/Ethanol (output/cache/cstar_wide_LOX_Ethanol.npz)")
    return tab


# --------------------------------------------------------------------------- Rupe E_m
def test_rupe_Em_is_tr_32_1546_eq_1():
    """Four tubes about R = 0.6, by hand: lean (0.5, 0.2) and (0.55, 0.3), rich (0.7, 0.4), (0.8, 0.1)."""
    r = np.array([0.5, 0.55, 0.7, 0.8])
    w = np.array([0.2, 0.3, 0.4, 0.1])
    R = 0.6
    hand = 1.0 - (0.2 * 0.1 + 0.3 * 0.05) / 0.6 - (0.4 * 0.1 + 0.1 * 0.2) / 0.4
    assert cp.rupe_Em_of_distribution(r, w, R) == pytest.approx(hand, rel=1e-12)


@pytest.mark.parametrize("dist", ["gaussian", "two_tube"])
@pytest.mark.parametrize("R,Em", [(0.45, 0.8), (0.56, 0.79), (0.7, 0.9)])
def test_the_stream_tubes_reproduce_the_Em_they_were_built_from(dist, R, Em):
    fn = _synthetic_cstar()
    out = cp.stream_tube_mixing_efficiency(R / (1 - R), fn, [(1.0, R / (1 - R), Em)], dist)
    # Gaussian tubes past r = 0 or 1 (beyond ~4 sigma, weight < 1e-4) are clipped to pure propellant.
    assert out["Em_total"] == pytest.approx(Em, abs=1e-4 if dist == "gaussian" else 1e-12)


def test_a_wide_gaussian_is_clipped_at_pure_propellant_and_says_so():
    """E_m 0.7 about r = 0.4 puts the normal's lean tail 2.2 sigma from pure fuel."""
    fn = _synthetic_cstar()
    out = cp.stream_tube_mixing_efficiency(0.4 / 0.6, fn, [(1.0, 0.4 / 0.6, 0.7)])
    assert 0.01 < out["mass_clipped_to_pure_propellant"] < 0.03
    assert out["Em_total"] == pytest.approx(0.7, abs=5e-3)


# Rupe's mean line, JPL TR 32-1546 Fig. 1 (orifice area ratios 0.26-1.0), digitized: (N_R, E_m %).
FIG1_MEAN_LINE = [(0.26, 44.3), (0.28, 48.5), (0.30, 53.8), (0.35, 62.3), (0.40, 70.3), (0.45, 75.7),
                  (0.50, 77.7), (0.55, 77.7), (0.60, 74.4), (0.65, 68.5), (0.70, 60.5), (0.75, 53.7),
                  (0.78, 48.6)]


def test_Em_falloff_follows_rupes_correlation():
    """N_R = M/(1+M) (TR 32-1546 eq. 2 with 1 = fuel). With the figure's own peak (77.2 at N_R 0.525)
    the default curvature reproduces the digitized mean line within 3 points (data scatter +-5)."""
    cfg = CombustionEfficiencyConfig()
    M0 = 0.525 / 0.475
    for N, E in FIG1_MEAN_LINE:
        got = 100.0 * cp.rupe_Em_at_M(N / (1 - N), 0.772, M0, cfg.rupe_Em_curvature)
        assert abs(got - E) < 3.0, (N, E, got)
    assert cp.rupe_Em_at_M(1.0, 0.8, 1.0) == 0.8
    # Symmetric in N_R, not in ln M: M = 1/3 (N 0.25) and M = 3 (N 0.75) fall off alike.
    assert cp.rupe_Em_at_M(1 / 3, 0.8, 1.0) == pytest.approx(cp.rupe_Em_at_M(3.0, 0.8, 1.0), rel=1e-12)


# --------------------------------------------------------------------------- stream-tube c* integral
# Direct CEA (rocketcea, LOX/Ethanol, 316.4 psia): scipy quad of c* over a normal in r, and the two
# tubes at R +- MAD. (MR, E_m) -> (gaussian, two-tube).
CEA_MIX = {(1.277, 0.85): (0.95140, 0.96101), (1.5, 0.85): (0.95227, 0.96213)}


@pytest.mark.parametrize("key", list(CEA_MIX))
def test_stream_tube_integral_matches_direct_cea_quadrature(key):
    wide = _wide_or_skip()
    MR, Em = key
    fn = cp.CstarOfMR(316.4 * PSI, wide=wide)
    g, two = CEA_MIX[key]
    assert cp.stream_tube_mixing_efficiency(MR, fn, [(1, MR, Em)], "gaussian")["eta_mix"] == pytest.approx(g, abs=3e-4)
    assert cp.stream_tube_mixing_efficiency(MR, fn, [(1, MR, Em)], "two_tube")["eta_mix"] == pytest.approx(two, abs=3e-4)


def test_perfect_mixing_is_exactly_one_and_striation_is_integrated():
    fn = _synthetic_cstar()
    MR = 1.3
    assert cp.stream_tube_mixing_efficiency(MR, fn, [(1.0, MR, 1.0)])["eta_mix"] == pytest.approx(1.0, abs=1e-14)
    # Two perfectly mixed elements at O/F 1.0 and 1.6 whose masses average to the bulk r:
    r1, r2 = 0.5, 1.6 / 2.6
    w1 = (r2 - MR / (1 + MR)) / (r2 - r1)
    out = cp.stream_tube_mixing_efficiency(MR, fn, [(w1, 1.0, 1.0), (1 - w1, 1.6, 1.0)])
    hand = (w1 * fn(1.0) + (1 - w1) * fn(1.6)) / fn(MR)
    assert out["eta_mix"] == pytest.approx(hand, rel=1e-12)
    assert abs(out["element_centre_shift"]) < 1e-12


def _advanced(diag_extra=None, cfg=None, cstar_fn=None, fuel_props=None, ox_props=None):
    diag = {"D32_O": 90e-6, "D32_F": 160e-6, "u_axial_spray": 22.0, "rupe_M": 0.83,
            "L_imp": 5.75e-3, "L_sheet_breakup": 2.4e-3, **(diag_extra or {})}
    return cp.calculate_combustion_efficiency_advanced(
        0.95, 2.18e6, 3150.0, 1650.0, 1.14, 370.0, 1.277, cfg or CombustionEfficiencyConfig(),
        0.0127, 0.00131, 2.4, u_fuel=35.8, u_lox=25.7, spray_diagnostics=diag,
        fuel_props=fuel_props if fuel_props is not None else {
            "name": "Ethanol", "density": 789.0, "boiling_point": 351.4, "latent_heat": 838e3,
            "molecular_weight": 46.07, "specific_heat": 2440.0, "temperature": 293.0,
            "critical_temperature": 514.71},
        ox_props=ox_props if ox_props is not None else {
            "name": "LOX", "density": 1140.0, "boiling_point": 90.2, "latent_heat": 213e3,
            "molecular_weight": 32.0, "specific_heat": 2300.0, "temperature": 90.0,
            "critical_temperature": 154.6},
        cstar_fn=cstar_fn or _synthetic_cstar())


def test_mixing_is_the_stream_tube_integral_of_rupes_Em_and_reports_both():
    r = _advanced()
    Em = cp.rupe_Em_at_M(0.83, 0.80, 1.0, 6.07)
    fn = _synthetic_cstar()
    want = cp.stream_tube_mixing_efficiency(1.277, fn, [(1.0, 1.277, Em)], "gaussian")["eta_mix"]
    assert r["rupe_Em"] == pytest.approx(Em, rel=1e-12)
    assert r["eta_mixing"] == pytest.approx(want, rel=1e-12)
    assert r["eta_mixing"] < r["eta_mixing_two_tube"] < 1.0        # the other shape's spread, reported


def test_retired_mixing_knobs_do_nothing():
    a = _advanced(cfg=CombustionEfficiencyConfig(Em_peak=0.6, mixing_sigma=0.2))
    b = _advanced(cfg=CombustionEfficiencyConfig(Em_peak=0.99, mixing_sigma=5.0))
    assert a["eta_mixing"] == b["eta_mixing"]


def test_injector_element_striation_enters_eta_mix():
    base = _advanced()
    mrs = [1.02, 1.15, 1.28, 1.42]
    flows = [0.55, 0.58, 0.6, 0.62]
    s = _advanced({"element_mixture_ratios": mrs, "element_mass_flows": flows})
    assert s["eta_mixing"] < base["eta_mixing"] - 1e-3
    assert s["rupe_Em_total"] < base["rupe_Em_total"]
    # Each element's own M moves as (MR_j/MR)^2: same orifices, v ~ mdot.
    fn = _synthetic_cstar()
    W = np.array(flows) / sum(flows)
    els = [(w, m, cp.rupe_Em_at_M(0.83 * (m / 1.277) ** 2, 0.8, 1.0, 6.07)) for w, m in zip(W, mrs)]
    assert s["eta_mixing"] == pytest.approx(
        cp.stream_tube_mixing_efficiency(1.277, fn, els)["eta_mix"], rel=1e-12)


def test_cstar_beyond_the_table_is_extended_and_recorded_not_clamped():
    """A CEA cache spanning O/F 1.0-2.5 used to clamp: every lean tail tube got c*(1.0)."""
    class Cache:
        MR_min, MR_max = 1.0, 2.5
        config = None
        def eval(self, MR, Pc):
            return {"cstar_ideal": 1700.0 * math.exp(-0.3 * math.log(min(max(MR, 1.0), 2.5) / 1.55) ** 2)}
    fn = cp.CstarOfMR(2.2e6, cea_cache=Cache())
    c, out = fn.of_fraction(np.array([0.25, 0.6, 0.85]))
    assert list(out) == [True, False, True]
    assert c[0] == pytest.approx(fn(1.0) * math.sqrt(0.25 / 0.5), rel=1e-12)
    assert c[2] == pytest.approx(fn(2.5) * math.sqrt(0.15 / (1 - 2.5 / 3.5)), rel=1e-12)
    r = _advanced(cstar_fn=fn)
    names = {a["name"] for a in r["assumptions"]}
    assert "combustion.mixing.cstar_outside_table" in names and r["mixing_mass_outside_cstar_table"] > 0.1


def test_dilution_law_beats_clamping_against_cea():
    C = _rocketcea()
    if C is None:
        pytest.skip("rocketcea not installed")
    pc = 316.4
    cs = lambda mr: C.get_Cstar(pc, mr) * 0.3048
    for mr in (0.3, 0.5, 6.0, 10.0):
        r = mr / (1 + mr)
        edge = 1.0 if mr < 1 else 2.5
        re = edge / (1 + edge)
        law = cs(edge) * math.sqrt(r / re if mr < 1 else (1 - r) / (1 - re))
        assert abs(law / cs(mr) - 1) < 0.2
        assert abs(law - cs(mr)) < abs(cs(edge) - cs(mr))


def test_wide_table_is_cea():
    wide = _wide_or_skip()
    C = _rocketcea()
    if C is None:
        pytest.skip("rocketcea not installed")
    fn = cp.CstarOfMR(2.0e6, wide=wide)
    for mr in (0.3, 1.0, 1.4, 2.0, 5.0):
        assert fn(mr) == pytest.approx(C.get_Cstar(2.0e6 / PSI, mr) * 0.3048, rel=4e-3)


# --------------------------------------------------------------------------- vaporization
def _vap(diag_extra=None, cstar_fn=None, **kw):
    notes = []
    diag = {"D32_O": 90e-6, "D32_F": 160e-6, "u_axial_spray": 22.0, **(diag_extra or {})}
    fuel = {"density": 789.0, "boiling_point": 351.4, "latent_heat": 838e3, "molecular_weight": 46.07,
            "specific_heat": 2440.0, "temperature": 293.0, "critical_temperature": 514.71}
    ox = {"density": 1140.0, "boiling_point": 90.2, "latent_heat": 213e3, "molecular_weight": 32.0,
          "specific_heat": 2300.0, "temperature": 90.0, "critical_temperature": 154.6}
    kw.setdefault("fuel_props", fuel)
    kw.setdefault("ox_props", ox)
    eta, out = cp.calculate_vaporization_efficiency(
        Pc=2.18e6, Tc=3150.0, gamma=1.14, R=370.0, MR=1.277, m_dot_total=2.4, Ac=0.0127, At=0.00131,
        Lstar=0.95, spray_diagnostics=diag, u_fuel=35.8, u_lox=25.7, rr_q=3.0, assumptions=notes,
        cstar_fn=cstar_fn, **kw)
    return eta, out, notes


def test_the_march_starts_where_the_sheet_breaks_into_drops():
    eta0, out0, _ = _vap()
    eta1, out1, _ = _vap({"L_imp": 5.75e-3, "L_sheet_breakup": 2.4e-3})
    assert out1["x_drop_formation"] == pytest.approx(8.15e-3)
    assert out1["L_march"] == pytest.approx(out0["L_chamber_equiv"] - 8.15e-3)
    assert out1["fraction_vaporized"] < out0["fraction_vaporized"]


def test_vaporized_gas_is_charged_at_its_own_mixture_ratio():
    fn = _synthetic_cstar()
    eta, out, _ = _vap(cstar_fn=fn)
    F, fO, fF = out["fraction_vaporized"], out["frac_vaporized_O"], out["frac_vaporized_F"]
    assert fO > fF                                         # the fuel is the slow stream
    MRv = 1.277 * fO / fF
    assert out["MR_vaporized"] == pytest.approx(MRv, rel=1e-12)
    assert eta == pytest.approx(F * fn(MRv) / fn(1.277), rel=1e-12)
    assert eta > F                                         # below the c* peak the lean gas gains
    # Past the peak the same shift costs c*: move the peak below the injected O/F.
    MR = np.geomspace(0.1, 20.0, 400)
    c = 1700.0 * np.exp(-0.3 * np.log(MR / 1.0) ** 2)
    tab = cp.CstarWideTable("X", "Y", MR, np.geomspace(1e5, 1.2e7, 4), np.repeat(c[:, None], 4, axis=1))
    eta2, out2, _ = _vap(cstar_fn=cp.CstarOfMR(2.18e6, wide=tab))
    assert eta2 < out2["fraction_vaporized"]


def test_blowing_factors_are_the_published_forms():
    assert cp.abramzon_sirignano_F(1.0) == pytest.approx(2 ** 0.7 * math.log(2.0), rel=1e-12)
    assert cp.abramzon_sirignano_F(0.0) == 1.0
    assert cp.abramzon_sirignano_F(16.2) == pytest.approx(17.2 ** 0.7 * math.log(17.2) / 16.2, rel=1e-12)
    assert cp.yuen_chen_drag_factor(1.0) == pytest.approx(2 ** -0.2, rel=1e-12)
    cfg = CombustionEfficiencyConfig()
    assert cfg.droplet_blowing_model == "abramzon_sirignano"


_GAS = dict(Pc=2.92e6, Tc=3226.0, gamma=1.1375, R=373.57, m_dot_total=2.718, Ac=math.pi * 0.0635 ** 2)


def _single_drop_reference(blowing: bool, I_heat=None):
    """The march's documented equations for a trace stream in burned gas (U_g = U_c), integrated by
    scipy for 96 size classes, with the Stefan-flow corrections applied while the drop evaporates."""
    from scipy.integrate import solve_ivp
    from engine.pipeline.thermal.regen_cooling import calculate_gas_viscosity_huzel
    g = _GAS
    Pc, Tc, gam, R = g["Pc"], g["Tc"], g["gamma"], g["R"]
    TsF, hF = cp.saturation_state(Pc, 351.4, 838e3, 46.07, 514.71)
    cpg = gam * R / (gam - 1.0)
    rho_c = Pc / (R * Tc)
    U = g["m_dot_total"] / (rho_c * g["Ac"])
    Tf = TsF + (Tc - TsF) / 3.0
    mu = calculate_gas_viscosity_huzel(Tf, R_U / R)
    Pr = 0.8
    k = mu * cpg / Pr
    rho_f = Pc / (R * Tf)
    B = cpg * (Tc - TsF) / hF
    FB = (1 + B) ** 0.7 * math.log1p(B) / B if blowing else 1.0
    cd = (1 + B) ** -0.2 if blowing else 1.0
    L, u0, q = 0.05, 24.0, 3.0
    I = 2440.0 * math.log((Tc - 293.0) / (Tc - TsF)) if I_heat is None else I_heat
    X = 85e-6 * math.gamma(1.0 - 1.0 / q)
    xs, ws = np.polynomial.legendre.leggauss(96)
    remaining = 0.0
    for Vk, wk in zip(0.5 * (xs + 1.0), 0.5 * ws):
        D0 = X * (-math.log1p(-Vk)) ** (1.0 / q)
        Nu0 = 2.0 + 0.6 * math.sqrt(rho_f * u0 * D0 / mu) * Pr ** (1 / 3)
        t_h = 789.0 * D0 ** 2 / (6 * Nu0 * k) * I

        def rhs(t, s):
            x, v, D2 = s
            D = math.sqrt(max(D2, 0.0))
            dU = abs(U - v)
            Re_d = rho_c * dU * D / mu
            ev = t > t_h
            Nu = 2.0 + 0.6 * math.sqrt(rho_f * dU * D / mu) * Pr ** (1 / 3) / FB
            K = 4.0 * Nu * k * math.log1p(B) / (789.0 * cpg) if ev else 0.0
            phi = 1.0 + Re_d ** (2 / 3) / 6.0 if Re_d <= 1000 else 0.424 * Re_d / 24.0
            if ev:
                phi *= cd
            dv = (U - v) * 18.0 * mu * phi / (789.0 * max(D2, 1e-30))
            return [v, dv, -K if D2 > 0 else 0.0]

        hit_wall = lambda t, s: s[0] - L
        hit_wall.terminal = True
        gone = lambda t, s: s[2]
        gone.terminal = True
        sol = solve_ivp(rhs, (0.0, 1.0), [0.0, u0, D0 ** 2], events=(hit_wall, gone),
                        rtol=1e-9, atol=[1e-12, 1e-9, 1e-18], max_step=2e-5)
        remaining += wk * (max(sol.y[2, -1], 0.0) / D0 ** 2) ** 1.5
    fuel = dict(name="F", mass_fraction=1e-9, D32=85e-6, rho_l=789.0, cp_l=2440.0, T0=293.0,
                T_s=TsF, h_fg=hF)
    if I_heat is not None:
        fuel["heatup_integral"] = I_heat
    return 1.0 - remaining, fuel, L, u0, q


@pytest.mark.parametrize("blowing", [True, False])
def test_march_with_blowing_matches_an_independent_integration(blowing):
    ref, fuel, L, u0, q = _single_drop_reference(blowing)
    got = cp.spray_vaporization_march(
        [dict(name="O", mass_fraction=1.0 - 1e-9, instant=True), fuel], **_GAS, L_chamber=L,
        u_drop0=u0, rr_q=q, blowing="abramzon_sirignano" if blowing else "none")["frac_vaporized"]["F"]
    assert got == pytest.approx(ref, abs=3e-4)


def test_blowing_changes_the_answer():
    _, fuel, L, u0, q = _single_drop_reference(False)
    kw = dict(**_GAS, L_chamber=L, u_drop0=u0, rr_q=q)
    streams = [dict(name="O", mass_fraction=1.0 - 1e-9, instant=True), fuel]
    a = cp.spray_vaporization_march(streams, **kw, blowing="none")["frac_vaporized"]["F"]
    b = cp.spray_vaporization_march(streams, **kw)["frac_vaporized"]["F"]
    assert abs(a - b) > 1e-3


def test_heatup_uses_the_liquids_own_cp_and_density():
    CP = pytest.importorskip("CoolProp.CoolProp")
    from scipy.integrate import quad
    P, T0, Ts, Tc = 2.18e6, 293.0, 455.0, 3150.0
    liq = cp.liquid_heatup_properties("Ethanol", P, T0, Ts, Tc)
    ref = quad(lambda T: CP.PropsSI("C", "T", T, "P", P, "Ethanol") / (Tc - T), T0, Ts)[0]
    assert liq["heatup_integral"] == pytest.approx(ref, rel=1e-4)
    assert liq["rho_l"] == pytest.approx(CP.PropsSI("D", "T", 0.5 * (T0 + Ts), "P", P, "Ethanol"), rel=1e-9)
    # Ethanol's cp climbs from 2.4 to ~4 kJ/(kg K) on the way to T_sat: the configured 2440 is 30 % low.
    assert liq["cp_l_effective"] > 1.25 * 2440.0
    assert cp.liquid_heatup_properties("RP-1", P, T0, Ts, Tc) is None
    # LOX: CoolProp's T_sat at 2.18 MPa (~134.6 K) sits below Clausius-Clapeyron's; integrated to it.
    lox = cp.liquid_heatup_properties("LOX", P, 90.0, 138.0, Tc)
    assert lox["T_liquid_limit"] < 138.0 and lox["heatup_integral"] > 0


def test_march_heatup_integral_is_the_constant_cp_log_when_cp_is_constant():
    _, fuel, L, u0, q = _single_drop_reference(False)
    kw = dict(**_GAS, L_chamber=L, u_drop0=u0, rr_q=q, blowing="none")
    I = 2440.0 * math.log((_GAS["Tc"] - 293.0) / (_GAS["Tc"] - fuel["T_s"]))
    a = cp.spray_vaporization_march([dict(name="O", mass_fraction=0.5, instant=True), fuel], **kw)
    b = cp.spray_vaporization_march([dict(name="O", mass_fraction=0.5, instant=True),
                                     dict(fuel, heatup_integral=I)], **kw)
    assert a["F_throat"] == pytest.approx(b["F_throat"], rel=1e-12)
    ref, fuel2, *_ = _single_drop_reference(False, I_heat=1.4 * I)
    got = cp.spray_vaporization_march([dict(name="O", mass_fraction=1 - 1e-9, instant=True), fuel2],
                                      **kw)["frac_vaporized"]["F"]
    assert got == pytest.approx(ref, abs=3e-4)


def test_coolprop_liquid_properties_reach_the_march():
    pytest.importorskip("CoolProp")
    fuel = {"name": "Ethanol", "density": 789.0, "boiling_point": 351.4, "latent_heat": 838e3,
            "molecular_weight": 46.07, "specific_heat": 2440.0, "temperature": 293.0,
            "critical_temperature": 514.71}
    _, out, notes = _vap(fuel_props=fuel)
    assert out["rho_l_F"] < 760.0 and out["cp_l_F"] > 3000.0 and "CoolProp" in out["liquid_props_F"]
    _, out2, notes2 = _vap()
    assert out2["rho_l_F"] == 789.0
    assert "combustion.vaporization.fuel.liquid_properties" in {a["name"] for a in notes2}
    fuel_rp = dict(fuel, name="RP-1")
    _, _, notes3 = _vap(fuel_props=fuel_rp)
    assert "combustion.vaporization.fuel.liquid_properties" in {a["name"] for a in notes3}
