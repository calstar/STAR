"""The c* efficiency chain against references outside the code: CEA, CoolProp, textbook algebra and an
independent ODE integration of the spray model.

    eta_c* = eta_vap * eta_mix * eta_HL      (engine/pipeline/combustion_physics.py, combustion_eff.py)

Reference numbers were generated once and are pinned here, because CI has neither rocketcea nor the
time to rebuild them:
  * CEA: rocketcea 1.2.3, LOX / Ethanol cards, the ethanol card's h,cal lowered by dh (1+O/F) M_EtOH
    so the mixture loses dh = 188 kJ/kg (or Q/mdot at the design point).
  * CoolProp 7.2.0 saturation states.
"""
from __future__ import annotations

import copy
import math
import re
from pathlib import Path

import numpy as np
import pytest

from engine.pipeline import combustion_physics as cp
from engine.pipeline.combustion_eff import eta_cstar, heat_loss_cstar_efficiency, wall_heat_lost_W
from engine.pipeline.config_schemas import CombustionEfficiencyConfig

ROOT = Path(__file__).resolve().parents[1]
PSI = 6894.757293168
R_U = 8314.462618

# (Pc psia, O/F, Tc K, M kg/kmol, gamma, c*(h - 188 kJ/kg) / c*(h))  -- rocketcea, see module doc.
CEA_HEAT_LOSS = [
    (200.0, 1.0, 2350.93, 18.4072, 1.22426, 0.982815),
    (200.0, 1.3, 2964.33, 20.8488, 1.15791, 0.988492),
    (200.0, 1.5, 3153.81, 22.0964, 1.13183, 0.991723),
    (200.0, 1.8, 3244.53, 23.4859, 1.12024, 0.993283),
    (200.0, 2.2, 3244.40, 24.8609, 1.11787, 0.993158),
    (430.0, 1.0, 2354.56, 18.4134, 1.22718, 0.982799),
    (430.0, 1.3, 3004.18, 20.9271, 1.16603, 0.988021),
    (430.0, 1.5, 3225.45, 22.2483, 1.13757, 0.991223),
    (430.0, 1.8, 3336.15, 23.6965, 1.12375, 0.993102),
    (430.0, 2.2, 3337.74, 25.0891, 1.12107, 0.993014),
    (800.0, 1.0, 2356.70, 18.4171, 1.22894, 0.982792),
    (800.0, 1.3, 3031.56, 20.9812, 1.17232, 0.987711),
    (800.0, 1.5, 3280.31, 22.3655, 1.14253, 0.990795),
    (800.0, 1.8, 3410.87, 23.8707, 1.12661, 0.992943),
    (800.0, 2.2, 3414.46, 25.2795, 1.12363, 0.992894),
]
# 6500 N design point: 431.75 psia, O/F 1.5013, mdot 2.8152 kg/s; CEA c* ratio at Q = 529.3 kW.
DESIGN = dict(Pc=2976827.09, MR=1.5013044, mdot=2.8151867, Tc=3226.756, M=22.256595, gamma=1.137481)
DESIGN_Q_W, DESIGN_CEA_RATIO = 529.3e3, 0.991236


def _old_linear_factor(Q, mdot, Tc, gamma, R):
    """The formula the chamber solver used: 1 - Q/(mdot cp T_eff), T_eff = Tc - Q/(mdot cp)."""
    cp_ = gamma * R / (gamma - 1.0)
    T_eff = Tc - Q / (mdot * cp_)
    return 1.0 - Q / (mdot * cp_ * T_eff)


# --------------------------------------------------------------------------- heat loss (TH-1, CN-2, CE-3)
def test_heat_loss_factor_matches_cea_at_the_design_point():
    d = DESIGN
    R = R_U / d["M"]
    eta = heat_loss_cstar_efficiency(DESIGN_Q_W, d["mdot"], d["Tc"], d["gamma"], R)
    loss, loss_cea = 1.0 - eta, 1.0 - DESIGN_CEA_RATIO
    assert abs(loss / loss_cea - 1.0) < 0.10, (eta, DESIGN_CEA_RATIO)


@pytest.mark.parametrize("Pc_psia,MR,Tc,M,gamma,cea_ratio", CEA_HEAT_LOSS)
def test_heat_loss_factor_tracks_cea_across_the_envelope(Pc_psia, MR, Tc, M, gamma, cea_ratio):
    """sqrt(1 - x) is 0.94-1.34x CEA's loss over the ethalox envelope; the linear form was 1.9-2.7x."""
    R = R_U / M
    mdot = 1.0
    Q = 188.0e3 * mdot
    ratio = (1.0 - heat_loss_cstar_efficiency(Q, mdot, Tc, gamma, R)) / (1.0 - cea_ratio)
    assert 0.90 < ratio < 1.40, ratio


def _peaked_cstar(Pc):
    """Smooth peaked c*(O/F) (1725 exp(-0.3 ln(MR/1.5)^2) m/s): the heat-loss tests need only a c*
    source for the mixing and vaporized-gas ratios, which cancel between the hot and cold calls."""
    MR = np.geomspace(0.1, 20.0, 400)
    Pcs = np.geomspace(1e5, 1.2e7, 4)
    c = 1725.0 * np.exp(-0.3 * np.log(MR / 1.5) ** 2)
    return cp.CstarOfMR(Pc, wide=cp.CstarWideTable("X", "Y", MR, Pcs, np.repeat(c[:, None], 4, axis=1)))


def _advanced_params(Q_by_source, cooling_eff):
    """A minimal eta_cstar call around the design point with a synthetic cooling result."""
    d = DESIGN
    R = R_U / d["M"]
    diag = {
        "D32_O": 44.2e-6, "D32_F": 85.4e-6, "u_O": 32.8, "u_F": 37.5, "u_axial_spray": 24.8,
        "rho_O_momentum": 1140.0, "rho_F_momentum": 789.0,
        "v_O_bulk": 32.8, "v_F_bulk": 37.5, "d_jet_O": 1.548e-3, "d_jet_F": 1.421e-3,
        "cooling": {name: {"heat_removed": q} for name, q in Q_by_source.items()},
    }
    return {
        "Pc": d["Pc"], "Tc": d["Tc"], "cstar_ideal": 1725.3, "gamma": d["gamma"], "R": R,
        "MR": d["MR"], "Ac": math.pi * 0.0635 ** 2, "At": 1.5337e-3, "m_dot_total": d["mdot"],
        "chamber_length": 0.131,
        "u_fuel": 37.5, "u_lox": 32.8, "spray_diagnostics": diag, "cstar_fn": _peaked_cstar(d["Pc"]),
        "fuel_props": {"boiling_point": 351.4, "latent_heat": 838e3, "molecular_weight": 46.07,
                       "specific_heat": 2440.0, "temperature": 293.0, "critical_temperature": 514.71,
                       "density": 789.0},
    }


def test_eta_cstar_charges_wall_heat_by_the_energy_balance():
    """End to end: the factor eta_cstar applies is CEA's c* ratio, not the caller's linear factor."""
    d = DESIGN
    R = R_U / d["M"]
    cfg = CombustionEfficiencyConfig()
    old = _old_linear_factor(DESIGN_Q_W, d["mdot"], d["Tc"], d["gamma"], R)
    eta_hot = eta_cstar(1.0, cfg, old, _advanced_params({"ablative": DESIGN_Q_W}, old))
    eta_cold = eta_cstar(1.0, cfg, 1.0, _advanced_params({}, 1.0))
    assert abs((1.0 - eta_hot / eta_cold) / (1.0 - DESIGN_CEA_RATIO) - 1.0) < 0.10


def test_heat_returned_to_the_propellant_is_not_a_cstar_loss():
    """Regenerative heat rides back to the injector with the coolant; film coolant stays in the flow."""
    Q, per = wall_heat_lost_W({"regen": {"heat_removed": 4e5}, "film": {"heat_removed": 1e5},
                               "ablative": {"heat_removed": 2e5}, "metadata": {"x": 1}})
    assert Q == pytest.approx(2e5) and per == {"ablative": 2e5}


# --------------------------------------------------------------------------- vaporization (CE-1, CE-8)
@pytest.mark.parametrize("P,Tb,Lb,M,Tcrit,T_ref,h_ref", [
    (1.0e6, 351.4, 838e3, 46.07, 514.71, 423.845, 686.61e3),     # CoolProp ethanol
    (2.9768e6, 351.4, 838e3, 46.07, 514.71, 473.085, 506.02e3),
    (5.0e6, 351.4, 838e3, 46.07, 514.71, 501.504, 332.76e3),
    (1.0e6, 90.2, 213e3, 32.0, 154.6, 119.621, 174.34e3),         # CoolProp oxygen
    (2.9768e6, 90.2, 213e3, 32.0, 154.6, 141.514, 119.89e3),
])
def test_drops_evaporate_at_their_saturation_state_at_pc(P, Tb, Lb, M, Tcrit, T_ref, h_ref):
    """Clausius-Clapeyron + Watson against CoolProp: T within 1.5 %, h_fg within 10 %."""
    T, h = cp.saturation_state(P, Tb, Lb, M, Tcrit)
    assert abs(T / T_ref - 1.0) < 0.015
    assert abs(h / h_ref - 1.0) < 0.10


def test_supercritical_drop_has_no_latent_heat():
    T, h = cp.saturation_state(8.0e6, 90.2, 213e3, 32.0, 154.6)
    assert (T, h) == (154.6, 0.0)


def test_gasification_heat_up_and_evaporation_add():
    """Heating a drop and then gasifying it are successive stages; the lifetime is their sum
    (Law 1982). They were combined as parallel rates, making the lifetime shorter than either."""
    _, dg = cp.calculate_gasification_efficiency(
        Tc=3227.0, Pc=2.99e6, tau_res=1.36e-3, SMD=85.7e-6, rho_l=789.0, cp_l=2440.0, L_eff=838e3,
        T_inj=293.0, cp_g=3090.0, rho_g=2.47, mu_g=7e-5, U_slip=50.0, fuel_props={"T_star_fuel_cap_K": 473.0})
    assert dg["tau_vap"] >= max(dg["tau_heat"], dg["tau_gasify"])
    assert dg["tau_vap"] == pytest.approx(dg["tau_heat"] + dg["tau_gasify"], rel=1e-12)


def _design_streams(Pc, k=1.0, MR=1.47):
    TsO, hO = cp.saturation_state(Pc, 90.2, 213e3, 32.0, 154.6)
    TsF, hF = cp.saturation_state(Pc, 351.4, 838e3, 46.07, 514.71)
    wO, wF = MR / (1 + MR), 1 / (1 + MR)
    return [dict(name="O", mass_fraction=wO, D32=44e-6 * k, rho_l=1140.0, cp_l=2300.0, T0=90.0, T_s=TsO, h_fg=hO),
            dict(name="F", mass_fraction=wF, D32=85e-6 * k, rho_l=789.0, cp_l=2440.0, T0=293.0, T_s=TsF, h_fg=hF)]


_GAS = dict(Pc=2.92e6, Tc=3226.0, gamma=1.1375, R=373.57, m_dot_total=2.718, Ac=math.pi * 0.0635 ** 2)
_AT = 1.5337e-3


def _eta_vap(Lstar, k=1.0):
    return cp.spray_vaporization_march(_design_streams(_GAS["Pc"], k), **_GAS,
                                       L_chamber=Lstar * _AT / _GAS["Ac"], u_drop0=24.0,
                                       rr_q=3.0)["F_throat"]


def test_vaporization_rises_with_lstar_and_falls_with_drop_size():
    Ls = [0.5, 0.75, 1.0, 1.5]
    e = [_eta_vap(L) for L in Ls]
    assert all(b > a for a, b in zip(e, e[1:])), e
    assert e[0] < 0.995                       # a short chamber leaves fuel unvaporized
    sizes = [_eta_vap(1.0, k) for k in (1.0, 1.5, 2.0)]
    assert all(b < a for a, b in zip(sizes, sizes[1:])), sizes


def test_spray_march_matches_an_independent_single_drop_integration():
    """With the marched stream a trace in an already-burned flow, U_g = U_c and each size class is an
    isolated drop. Integrate the documented equations with scipy for fine classes and compare."""
    from scipy.integrate import solve_ivp
    from engine.pipeline.thermal.regen_cooling import calculate_gas_viscosity_huzel

    g = _GAS
    eps = 1e-9
    Pc, Tc, gam, R = g["Pc"], g["Tc"], g["gamma"], g["R"]
    TsF, hF = cp.saturation_state(Pc, 351.4, 838e3, 46.07, 514.71)
    fuel = dict(name="F", mass_fraction=eps, D32=85e-6, rho_l=789.0, cp_l=2440.0, T0=293.0, T_s=TsF, h_fg=hF)
    L, u0, q = 0.05, 24.0, 3.0
    got = cp.spray_vaporization_march([dict(name="O", mass_fraction=1.0 - eps, instant=True), fuel],
                                      **g, L_chamber=L, u_drop0=u0, rr_q=q,
                                      blowing="none")["frac_vaporized"]["F"]

    cpg = gam * R / (gam - 1.0)
    rho_c = Pc / (R * Tc)
    U = g["m_dot_total"] / (rho_c * g["Ac"])
    Tf = TsF + (Tc - TsF) / 3.0
    mu = calculate_gas_viscosity_huzel(Tf, R_U / R)
    Pr = 0.8
    k = mu * cpg / Pr
    rho_f = Pc / (R * Tf)
    lnB = math.log(1.0 + cpg * (Tc - TsF) / hF)
    X = 85e-6 * math.gamma(1.0 - 1.0 / q)
    xs, ws = np.polynomial.legendre.leggauss(96)
    V, w = 0.5 * (xs + 1.0), 0.5 * ws
    remaining = 0.0
    for Vk, wk in zip(V, w):
        D0 = X * (-math.log1p(-Vk)) ** (1.0 / q)
        Nu0 = 2.0 + 0.6 * math.sqrt(rho_f * u0 * D0 / mu) * Pr ** (1 / 3)
        t_h = 789.0 * 2440.0 * D0 ** 2 / (6 * Nu0 * k) * math.log((Tc - 293.0) / (Tc - TsF))

        def rhs(t, s):
            x, v, D2 = s
            D = math.sqrt(max(D2, 0.0))
            dU = abs(U - v)
            Re_d = rho_c * dU * D / mu
            Nu = 2.0 + 0.6 * math.sqrt(rho_f * dU * D / mu) * Pr ** (1 / 3)
            K = 4.0 * Nu * k * lnB / (789.0 * cpg) if t > t_h else 0.0
            phi = 1.0 + Re_d ** (2 / 3) / 6.0 if Re_d <= 1000 else 0.424 * Re_d / 24.0
            dv = (U - v) * 18.0 * mu * phi / (789.0 * max(D2, 1e-30))
            return [v, dv, -K if D2 > 0 else 0.0]

        hit_wall = lambda t, s: s[0] - L
        hit_wall.terminal = True
        gone = lambda t, s: s[2]
        gone.terminal = True
        sol = solve_ivp(rhs, (0.0, 1.0), [0.0, u0, D0 ** 2], events=(hit_wall, gone),
                        rtol=1e-9, atol=[1e-12, 1e-9, 1e-18], max_step=2e-5)
        remaining += wk * (max(sol.y[2, -1], 0.0) / D0 ** 2) ** 1.5
    assert got == pytest.approx(1.0 - remaining, abs=3e-4), (got, 1.0 - remaining)


def test_missing_inputs_are_named_not_hidden():
    """A stream without properties is taken as vaporized at the face and says so; without the
    injector's u_axial_spray the drops start with the pair's axial momentum per unit mass."""
    d = DESIGN
    diag = {"D32_O": 44e-6, "D32_F": 85e-6, "impingement_angle_deg": 89.0}
    fuel = {"boiling_point": 351.4, "latent_heat": 838e3, "molecular_weight": 46.07, "density": 789.0,
            "specific_heat": 2440.0, "temperature": 293.0, "critical_temperature": 514.71}
    notes = []
    eta, out = cp.calculate_vaporization_efficiency(
        Pc=d["Pc"], Tc=d["Tc"], gamma=d["gamma"], R=R_U / d["M"], MR=1.5, m_dot_total=2.8,
        Ac=0.012668, At=1.5337e-3, Lstar=1.0, spray_diagnostics=diag, fuel_props=fuel, ox_props=None,
        u_fuel=37.5, u_lox=32.8, rr_q=3.0, assumptions=notes)
    names = {a["name"] for a in notes}
    assert "combustion.vaporization.oxidizer" in names
    assert out["frac_vaporized_O"] == 1.0 and 0.0 < out["frac_vaporized_F"] < 1.0
    assert eta == pytest.approx(0.6 + 0.4 * out["frac_vaporized_F"], rel=1e-12)
    assert out["u_drop0"] == pytest.approx((0.6 * 32.8 + 0.4 * 37.5) * math.cos(math.radians(44.5)), rel=1e-12)


# --------------------------------------------------------------------------- mixing (CE-4, CE-5)
def test_rupe_parameter_is_elverum_morey_eq_1():
    M = cp.rupe_mixing_parameter(1140.0, 32.815, 1.54797e-3, 789.0, 37.457, 1.42140e-3)
    assert M == pytest.approx(1140.0 * 32.815 ** 2 * 1.54797e-3 / (789.0 * 37.457 ** 2 * 1.42140e-3), rel=1e-12)


def test_mixing_peaks_at_rupe_optimum_and_ignores_angles():
    """E_m is best at M = rupe_M_opt and falls off symmetrically in N_R = M/(1+M) (JPL TR 32-1546
    Fig. 1); M comes from the jet state and the impingement angles do not enter."""
    cfg = CombustionEfficiencyConfig()
    at_opt = cp.rupe_Em_at_M(1.0, cfg.rupe_Em_opt, cfg.rupe_M_opt, cfg.rupe_Em_curvature)
    assert at_opt == pytest.approx(cfg.rupe_Em_opt, rel=1e-15)
    lo = cp.rupe_Em_at_M(0.5, cfg.rupe_Em_opt, 1.0, cfg.rupe_Em_curvature)
    hi = cp.rupe_Em_at_M(2.0, cfg.rupe_Em_opt, 1.0, cfg.rupe_Em_curvature)
    assert lo == pytest.approx(hi, rel=1e-12) and lo < at_opt
    base = {"rho_O_momentum": 1140.0, "v_O_bulk": 30.0, "d_jet_O": 1.5e-3,
            "rho_F_momentum": 789.0, "v_F_bulk": 30.0 * math.sqrt(1140.0 / 789.0), "d_jet_F": 1.5e-3}
    assert cp.rupe_M_from_diagnostics(base) == pytest.approx(1.0, rel=1e-12)
    assert cp.rupe_M_from_diagnostics({**base, "impingement_angle_deg": 120.0}) == pytest.approx(1.0, rel=1e-12)
    assert cp.rupe_M_from_diagnostics({**base, "rupe_M": 1.3}) == 1.3


def test_resultant_tilt_balance_includes_the_orifice_area_ratio():
    """mdot_O u_O sin(th_O) = mdot_F u_F sin(th_F) => R = (d_F/d_O) sqrt(sin th_F / sin th_O)."""
    R = cp.rupe_R_opt_from_angles(43.0, 46.0, d_O=1.548e-3, d_F=1.4214e-3)
    assert R == pytest.approx(0.943, abs=1e-3)


# --------------------------------------------------------------------------- kinetics (CE-7)
def test_no_chamber_kinetic_loss_and_no_mixture_ratio_steps():
    """Products relax in ~1 us against a ~1 ms stay time. With the vaporization term pinned (model
    constant) and a Pc-independent c* curve, eta must not move with Pc and Tc at all, and must move
    smoothly with O/F (only through the c* curve) across the old 1.5 plateau edge."""
    cfg = CombustionEfficiencyConfig(model="constant", C=0.0)
    diag = {"rupe_M": 1.0, "D32_O": 44e-6, "D32_F": 85e-6}

    def eta(MR, Pc, Tc):
        return cp.calculate_combustion_efficiency_advanced(
            1.0, Pc, Tc, 1700.0, 1.14, 373.0, MR, cfg, 0.0127, 0.00153, 2.8,
            u_fuel=37.5, u_lox=32.8, spray_diagnostics=diag, fuel_props={},
            cstar_fn=_peaked_cstar(Pc))["eta_total"]

    assert eta(1.5, 2.9e6, 3200.0) == pytest.approx(eta(1.5, 1.2e6, 2400.0), rel=1e-12)
    e = [eta(m, 2.9e6, 3200.0) for m in (1.46, 1.48, 1.50, 1.52, 1.54)]
    steps = np.diff(e)
    assert np.max(np.abs(np.diff(steps))) < 1e-3
    assert not hasattr(cp, "_ea_norm_from_mr")


# --------------------------------------------------------------------------- the design, end to end
def _evaluate(cfg):
    from engine.core.runner import PintleEngineRunner
    run = PintleEngineRunner(copy.deepcopy(cfg))
    P = cfg.lox_tank.initial_pressure_psi * PSI
    return run.evaluate(P, cfg.fuel_tank.initial_pressure_psi * PSI, silent=True)


@pytest.fixture(scope="module")
def ethalox():
    from engine.pipeline.io import load_config
    return load_config(str(ROOT / "configs" / "ethalox_6500N.yaml"))


def test_coarser_spray_costs_cstar(ethalox, monkeypatch):
    """CE-1: vaporization was saturated at 1.0, so atomization never reached c*. Doubling the Ingebo
    prefactor doubles D32 and must cost at least a point of eta_c*."""
    monkeypatch.setenv("ED_ACCEL", "off")
    base = _evaluate(ethalox)["diagnostics"]["eta_cstar"]
    coarse = copy.deepcopy(ethalox)
    coarse.spray.smd.smd_scale *= 2.0
    assert base - _evaluate(coarse)["diagnostics"]["eta_cstar"] > 0.01


def _with_lstar(cfg, L):
    cfg = copy.deepcopy(cfg)
    cg = cfg.chamber_geometry
    dV = (L - cg.Lstar) * cg.A_throat
    Ac = math.pi * (cg.chamber_diameter / 2.0) ** 2
    cg.volume, cg.Lstar = L * cg.A_throat, L
    cg.length_cylindrical += dV / Ac
    cg.length += dV / Ac
    return cfg


def test_lstar_buys_vaporization_until_heat_loss_wins(ethalox, monkeypatch):
    """CE-2: eta_c* must rise from a short chamber, with an interior optimum -- not fall from the
    minimum L* as the kinetics surrogate and the 2x heat-loss term made it."""
    monkeypatch.setenv("ED_ACCEL", "off")
    out = {L: _evaluate(_with_lstar(ethalox, L))["diagnostics"] for L in (0.5, 1.0, 1.5)}
    assert out[1.0]["eta_cstar"] > out[0.5]["eta_cstar"] + 0.005
    vap = [out[L]["cstar_efficiency"]["eta_vaporization"] for L in (0.5, 1.0, 1.5)]
    assert vap[0] < vap[1] < vap[2] and vap[0] < 0.995, vap


def test_design_cstar_breakdown_is_reported(ethalox, monkeypatch):
    """The breakdown is reported with the answer, with the Rupe E_m that set the mixing term."""
    monkeypatch.setenv("ED_ACCEL", "off")
    d = _evaluate(ethalox)["diagnostics"]
    b = d["cstar_efficiency"]
    assert b["eta_cstar"] == pytest.approx(d["eta_cstar"], rel=1e-12)
    assert b["eta_cstar"] == pytest.approx(b["eta_vaporization"] * b["eta_mixing"] * b["eta_heat_loss"], rel=1e-12)
    assert b["rupe_Em_opt"] == ethalox.combustion.efficiency.rupe_Em_opt and b["rupe_M"] > 0
    assert 0.0 < b["rupe_Em"] <= b["rupe_Em_opt"]
    # The fuel evaporates at its saturation temperature at Pc, not at a configured cap.
    T_sat, _ = cp.saturation_state(d["Pc"], 351.4, 838e3, 46.07, None)
    assert b["T_surface_F"] == pytest.approx(T_sat, rel=1e-9)


@pytest.mark.xfail(strict=True, reason=(
    "SP-8089 / Sutton put well-designed unlike doublets at eta_c* 0.90-0.97. The stream-tube "
    "integral of a cold-flow Rupe E_m of 0.80 with no gas-phase mixing downstream, plus this "
    "injector's element-to-element O/F striation, lands the design at ~0.885: below the band. Either "
    "the element's cold-flow E_m is better than the 0.75-0.85 literature band (measure it), or "
    "gas-phase mixing recovers several points of what the unmixed stream tubes charge. Strict: "
    "when the model or the design moves back into the band, this XPASS fails and must be revisited."))
def test_design_cstar_efficiency_is_in_the_unlike_doublet_band(ethalox, monkeypatch):
    monkeypatch.setenv("ED_ACCEL", "off")
    d = _evaluate(ethalox)["diagnostics"]
    assert 0.90 <= d["eta_cstar"] <= 0.97


# --------------------------------------------------------------------------- dead keys (CE-12)
def test_every_efficiency_field_is_read_or_marked_inert():
    """A key nothing reads must say so, or the Parameters workspace offers a knob that does nothing."""
    sources = []
    for base in ("engine", "backend"):
        for p in (ROOT / base).rglob("*.py"):
            if p.name != "config_schemas.py" and "archive" not in p.parts:
                sources.append(p.read_text(errors="ignore"))
    blob = "\n".join(sources)
    silent = []
    for name, fi in CombustionEfficiencyConfig.model_fields.items():
        if (fi.description or "").startswith("[DEPRECATED"):
            continue
        if not re.search(r"""(\.|["'])%s\b""" % re.escape(name), blob):
            silent.append(name)
    assert not silent, f"unread and unmarked: {silent}"
