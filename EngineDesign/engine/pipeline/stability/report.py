"""Rich stability report (<=5 s) for the final report and forward mode.

Runs the RICH tiers (chug root-find, full acoustic mode set with damping budgets) and assembles the
single payload that both the post-optimizer report and forward mode render from (plan §A5 schema).
Every block maps to a §V visualization. Pure-ish: takes the same (config, Pc, ..., diagnostics, cg)
as comprehensive_stability_analysis and reuses analysis.build_stability_inputs for identical extraction.

[Phys §3-§6; plan A5, §V]
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
import numpy as np

from engine.pipeline.stability import chug, acoustic, analysis

_PA_PER_PSI = 6894.757


# ---------------------------------------------------------------------------
# Visualization data builders
# ---------------------------------------------------------------------------

def _chug_boundary_curve(streams, chamber, n_pts: int = 16) -> List[List[float]]:
    """Viz #1: the chug stability boundary in (eta_inj, tau/theta_c). For each eta_inj, bisect on a
    lag-scale factor to find where the fast gain margin crosses 1 (marginal). Uses the FAST margin
    (cheap; ~n_pts*~12 calls)."""
    import copy
    theta_c = chamber.theta_c()
    if not np.isfinite(theta_c) or theta_c <= 0:
        return []
    tau0 = float(np.mean([s.tau_conv for s in streams]))
    curve: List[List[float]] = []
    for eta in np.linspace(0.08, 0.45, n_pts):
        # scale all streams to this eta; bisect lag factor k in [0.1, 8] for GM(k)=1
        def gm_at(kfac: float) -> float:
            sc = []
            for s in streams:
                s2 = copy.copy(s)
                s2.eta_inj = float(eta)
                s2.tau_conv = float(s.tau_conv * kfac)
                sc.append(s2)
            return chug.chug_margin_fast(sc, chamber)["gain_margin"] - 1.0
        lo, hi = 0.1, 8.0
        f_lo, f_hi = gm_at(lo), gm_at(hi)
        if f_lo * f_hi > 0:        # no crossing in range -> skip (all stable or all unstable)
            continue
        for _ in range(18):
            mid = 0.5 * (lo + hi)
            if gm_at(mid) * f_lo > 0:
                lo = mid
            else:
                hi = mid
        tau_marg = tau0 * 0.5 * (lo + hi)
        curve.append([float(eta), float(tau_marg / theta_c)])
    return curve


def _vaporization_profile(inp: Dict[str, Any], Pc: float, n_pts: int = 40) -> Dict[str, Any]:
    """Viz #5: d^2-law droplet decay along the chamber + vaporization length vs chamber length."""
    D32 = inp["D32_O"]
    K_v = inp["K_v_O"]
    L_ch = inp["L_ch"]
    rho_O = float(inp.get("rho_O", 1140.0))   # config-sourced via build_stability_inputs (P2c)
    eta = inp["eta_inj_O"]
    # representative droplet axial speed ~ LOX injection velocity v=sqrt(2*dP/rho) (Cd~0.6)
    v_drop = 0.6 * float(np.sqrt(max(2.0 * eta * Pc / rho_O, 1.0)))
    tau_vap = inp["tau_conv_O"]
    L_vap = v_drop * tau_vap if np.isfinite(tau_vap) else float("nan")
    x_max = float(max(L_ch, L_vap if np.isfinite(L_vap) else L_ch) * 1.1)
    xs = np.linspace(0.0, x_max, n_pts)
    # d^2(x)/d0^2 = 1 - x/L_vap (linear in x under d^2-law at constant v_drop), clipped at 0
    d2 = np.clip(1.0 - xs / L_vap, 0.0, 1.0) if (np.isfinite(L_vap) and L_vap > 0) else np.ones_like(xs)
    return {
        "d2_profile": [[float(x), float(y)] for x, y in zip(xs, d2)],
        "L_vap_m": float(L_vap), "L_ch_m": float(L_ch),
        "tau_conv_s": float(inp["tau_conv_O"]), "tau_sens_s": float(inp["tau_sens"]),
        "smd_um": float(D32 * 1e6), "smd_band_um": [float(D32 * 0.8e6), float(D32 * 1.2e6)],
        "vaporized_in_chamber": bool(np.isfinite(L_vap) and L_vap <= L_ch),
    }


def _feed_pressure_traces(inp: Dict[str, Any], Pc: float, n_pts: int = 40,
                          burn_time_s: float = 5.0) -> Dict[str, Any]:
    """Viz #6: dome-reg setpoint band vs blowdown reference (Phys §6.2)."""
    from engine.optimizer.feed_pressure_model import (
        generate_blowdown_reference_curve,
        generate_dome_regulated_pressure_curve,
    )
    P_set_pa = float(inp["streams"][0].Pc + inp["streams"][0].dP_feed)
    P_set = P_set_pa / _PA_PER_PSI
    ripple = float(inp["streams"][0].regulator.max_excursion_pa) / _PA_PER_PSI
    if ripple <= 0:
        ripple = 14.0
    t_reg, P_reg = generate_dome_regulated_pressure_curve(
        P_set_pa, burn_time_s=burn_time_s, n_points=n_pts,
    )
    t_bd, P_bd = generate_blowdown_reference_curve(
        P_set_pa, burn_time_s=burn_time_s, n_points=n_pts,
    )
    regulated = [[float(ti), float(pi / _PA_PER_PSI)] for ti, pi in zip(t_reg, P_reg)]
    blowdown = [[float(ti), float(pi / _PA_PER_PSI)] for ti, pi in zip(t_bd, P_bd)]
    return {"P_set_psi": P_set, "ripple_psi": ripple, "regulated": regulated, "blowdown_ref": blowdown}


def _water_hammer(inp: Dict[str, Any]) -> Dict[str, Any]:
    """Viz #8 (separate): Joukowsky spike vs available feed dP. Valve transient, NOT combustion."""
    s = inp["streams"][0]
    rho = float(inp.get("rho_O", 1140.0))      # config-sourced (P2c)
    K = float(inp.get("K_bulk_O", 1.5e9))      # fluids.oxidizer.bulk_modulus_pa (preset); T5 measures
    a_liq = float(np.sqrt(K / rho))
    v = float(s.mdot / (rho * s.feed_area)) if s.feed_area > 0 else 0.0
    spike = rho * a_liq * v
    return {"spike_psi": float(spike / _PA_PER_PSI), "available_dp_psi": float(s.dP_feed / _PA_PER_PSI)}


def _sensitivity(inp: Dict[str, Any]) -> Dict[str, Any]:
    """n / chi sensitivity bands for the acoustic limiting-mode growth rate (cheap sweep)."""
    D_ch, L_ch, gas = inp["D_ch"], inp["L_ch"], inp["gas"]
    tv = inp["tau_conv_O"]
    a_n = [acoustic.fast_acoustic(D_ch, L_ch, gas, n=nn, tau_sens=inp["tau_sens"])["alpha_max"]
           for nn in (0.3, 0.6)]
    a_chi = [acoustic.fast_acoustic(D_ch, L_ch, gas, n=inp["n_interaction"], tau_sens=cc * tv)["alpha_max"]
             for cc in (0.05, 0.30)]
    return {"acoustic_alpha_vs_n": [float(min(a_n)), float(max(a_n))],
            "acoustic_alpha_vs_chi": [float(min(a_chi)), float(max(a_chi))]}


def _chug_pole(chug_rich: Dict[str, Any]) -> Dict[str, float]:
    """Viz #1b: dominant chug pole location in the s-plane (σ + jω)."""
    alpha = chug_rich.get("alpha")
    f_hz = chug_rich.get("f_chug_hz")
    if alpha is None or f_hz is None or not np.isfinite(alpha) or not np.isfinite(f_hz):
        return {"real": float("nan"), "imag": float("nan")}
    return {"real": float(alpha), "imag": float(2 * np.pi * f_hz)}


def _radar(chug_margin: float, ac: Dict[str, Any], vap: Dict[str, Any],
           gate_threshold: float) -> Dict[str, Any]:
    """Viz #7: one-glance health radar."""
    def mode_alpha(name):
        for m in ac["modes"]:
            if m["mode"] == name:
                return m["alpha"]
        return float("-inf")
    a1L, a1T = mode_alpha("1L"), mode_alpha("1T")
    # normalize alphas to a 0..1.3 "margin-like" scale via the same acoustic gate mapping
    v1L = analysis._acoustic_gate_margin(a1L)
    v1T = analysis._acoustic_gate_margin(a1T)
    vap_complete = float(np.clip(vap["L_ch_m"] / vap["L_vap_m"], 0.0, 1.3)) if (
        np.isfinite(vap["L_vap_m"]) and vap["L_vap_m"] > 0) else 1.3
    axes = ["chug", "1L", "1T", "vaporization"]
    values = [float(chug_margin), float(v1L), float(v1T), vap_complete]
    return {"axes": axes, "values": values, "threshold": [gate_threshold] * len(axes)}


# ---------------------------------------------------------------------------
# Top-level assembly
# ---------------------------------------------------------------------------

def build_rich_report(config, Pc: float, MR: float, mdot_total: float, cstar: float,
                      gamma: float, R: float, Tc: float, diagnostics: Dict[str, Any],
                      cg: Any, *, gate_threshold: float = 1.05,
                      overrides: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """Assemble the full rich stability payload (plan §A5 schema). <=5 s."""
    inp = analysis.build_stability_inputs(
        config, Pc, MR, mdot_total, cstar, gamma, R, Tc, diagnostics, cg, overrides=overrides,
    )
    streams, chamber, gas = inp["streams"], inp["chamber"], inp["gas"]

    # --- chug (rich root-find + with/without regulator + boundary) ---
    chug_rich = chug.chug_growth_rate(streams, chamber)
    chug_margin = analysis._chug_gate_margin(
        chug.chug_margin_fast(streams, chamber).get("gain_margin", float("nan")))
    boundary = _chug_boundary_curve(streams, chamber)
    theta_c = chamber.theta_c()
    design_streams = []
    for label, eta, tau in (
        ("O", inp["eta_inj_O"], inp["tau_conv_O"]),
        ("F", inp["eta_inj_F"], inp["tau_conv_F"]),
    ):
        tt = float(tau / theta_c) if (np.isfinite(theta_c) and theta_c > 0) else float("nan")
        design_streams.append({"stream": label, "eta_inj": float(eta), "tau_theta_c": tt})

    # --- acoustic (full mode set with damping budgets) ---
    ac = acoustic.analyze_acoustic_modes(inp["D_ch"], inp["L_ch"], gas,
                                         n=inp["n_interaction"], tau_sens=inp["tau_sens"])
    ac_alpha_max = ac["modes"][0]["alpha"] if ac["modes"] else float("nan")
    acoustic_margin = analysis._acoustic_gate_margin(ac_alpha_max)
    acoustic_modes = [{
        "name": m["mode"], "freq_hz": m["f_hz"], "alpha": m["alpha"],
        "driving": m["driving"],
        "damping": {"noz": m["damping"]["nozzle"], "visc": m["damping"]["viscous"],
                    "inj": m["damping"]["injector"], "twophase": m["damping"]["twophase"]},
    } for m in ac["modes"]]

    # --- phase clock (omega*tau_sens per mode) ---
    phase = [{"mode": m["mode"], "omega_tau": float(2 * np.pi * m["f_hz"] * inp["tau_sens"])}
             for m in ac["modes"]]

    vap = _vaporization_profile(inp, Pc)
    burn_t = float(getattr(getattr(config, "design_requirements", None), "target_burn_time", None) or 5.0)
    feedp = _feed_pressure_traces(inp, Pc, burn_time_s=burn_t)
    wh = _water_hammer(inp)
    sens = _sensitivity(inp)
    radar = _radar(chug_margin, ac, vap, gate_threshold)

    min_margin = float(min(chug_margin, acoustic_margin))
    state = ("stable" if (chug_margin >= gate_threshold and acoustic_margin >= gate_threshold
                          and chug_rich.get("stable", True) and not ac["any_unstable"])
             else "marginal" if min_margin >= 0.95 else "unstable")
    limiting = "chug" if chug_margin <= acoustic_margin else ac.get("limiting_mode")

    return {
        "summary": {"state": state, "min_margin": min_margin,
                    "gate_margin_threshold": gate_threshold, "limiting_mode": limiting},
        "chug": {
            "alpha": chug_rich.get("alpha"), "freq_hz": chug_rich.get("f_chug_hz"),
            "zeta": chug_rich.get("zeta"), "margin": chug_margin,
            "alpha_no_reg": chug_rich.get("alpha_no_reg"), "driver": chug_rich.get("driver"),
            "boundary_curve": boundary,
            "pole": _chug_pole(chug_rich),
            "design_streams": design_streams,
        },
        "acoustic": {"margin": acoustic_margin, "modes": acoustic_modes,
                     "any_unstable": ac["any_unstable"], "limiting_mode": ac["limiting_mode"]},
        "phase": phase,
        "vaporization": vap,
        "feed_pressure": feedp,
        "radar": radar,
        "water_hammer": wh,
        "assumptions": {
            "n": inp["n_interaction"], "chi_acoustic": inp["chi_acoustic"],
            "dP_reg_max_psi": float(streams[0].regulator.max_excursion_pa / _PA_PER_PSI),
            "eta_inj_O": inp["eta_inj_O"], "eta_inj_F": inp["eta_inj_F"],
            "smd_O_um": float(inp["D32_O"] * 1e6),
            # Every recorded silent-default substitution this process has made (P2c registry).
            # Empty list = config fully specified the physics. The hardcoded-Cd bug class, surfaced.
            "fallbacks_used": _fallbacks_used(),
        },
        "sensitivity": sens,
    }


def _fallbacks_used():
    try:
        from engine.pipeline.assumptions import fallbacks_used
        return fallbacks_used()
    except ImportError:
        return []
