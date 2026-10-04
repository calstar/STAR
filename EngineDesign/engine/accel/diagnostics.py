"""Assemble the injector diagnostics dict from Numba's own solve outputs.

Replaces the second, C-side injector solve that the Numba path used to make for
diagnostics alone (native_injector._nat().injector_solve + _result_to_diag). The
physics was always there -- injector_solve computed these values and discarded
them -- so this is plumbing, not new physics.

Everything is derived from the flat param vector plus the solve tuple; no config
object is needed, which is what keeps this callable from inside a worker without
re-parsing YAML.

OMISSIONS. C's _result_to_diag also emits J, TMR, theta and
feed_orifice_coupling_iterations; no reader for those exists anywhere, and they
are impinging spray quantities the accelerated path never needs.

A_eff_O/F and the turbulence block ARE emitted, after an initial omission proved
wrong: A_eff is asserted present (not merely derivable) by
tests/test_flow_capacity_effective_area.py, and turbulence_intensity_mix reaches
chamber_solver.py:180 through *closure* diagnostics -- i.e. the accel.solve path,
which is distinct from the accel.evaluate path the first analysis looked at.
"""
from __future__ import annotations

import math

from engine.accel.params import _IDX

_DJO, _DJF = _IDX["DJO"], _IDX["DJF"]
_NO, _NF = _IDX["NO"], _IDX["NF"]
_RHO_O, _RHO_F = _IDX["RHO_O"], _IDX["RHO_F"]
_ANG_O, _ANG_F = _IDX["ANG_O"], _IDX["ANG_F"]
_MU_O, _MU_F = _IDX["MU_O"], _IDX["MU_F"]
_INJ_TYPE = _IDX["INJ_TYPE"]
_PIN_DHO, _PIN_DHF = _IDX["PIN_DHO"], _IDX["PIN_DHF"]


def _impinging_spray_extras(config, P, sol, Pc):
    """The spray/doublet diagnostics impinging.py publishes that the kernel tuple does not carry.

    Layer 1 reads D_pitch_*, element_gap_*, L_imp and vaporization_length_total out of the
    diagnostics (its impinging geometry-fit term and final report), and on the DEFAULT path those
    diagnostics are this dict (closure.flows -> accel.solve). Without these keys the accelerated
    path reported None where ED_ACCEL=off reported numbers. Computed from the solved state with
    the SAME helpers, in the same order, as ImpingingInjector.solve -- not re-derived.
    """
    import numpy as np

    from engine.core.injectors.impinging import impingement_standoff_m
    from engine.core.spray import (
        check_spray_constraints, evaporation_constant_m2_s, momentum_flux_ratio,
        ohnesorge_number, spray_angle_from_J, spray_angle_from_TMR, tau_evap, tau_evap_from_k,
        thrust_momentum_ratio,
    )
    (_ok, mdot_O, mdot_F, u_O, u_F, D32_O, D32_F, _mom_R, _Cd_O, _Cd_F,
     _Pi_O, _Pi_F, _dpi_O, _dpi_F, _A_O, _A_F, _dpf_O, _dpf_F, We_O, We_F, u_rel, x_star,
     _cok, _n_iter, _ti_O, _ti_F) = sol[:26]
    geometry = config.injector.geometry
    spray_cfg = config.spray
    fluids = config.fluids
    rho_O, mu_O, sigma_O = fluids["oxidizer"].density, fluids["oxidizer"].viscosity, fluids["oxidizer"].surface_tension
    rho_F, mu_F, sigma_F = fluids["fuel"].density, fluids["fuel"].viscosity, fluids["fuel"].surface_tension

    rho_gas = float(max(Pc / (spray_cfg.smd.chamber_gas_R * spray_cfg.smd.chamber_gas_T), 1e-6))
    J = momentum_flux_ratio(rho_O, u_O, rho_F, u_F)
    MR = mdot_O / mdot_F if mdot_F > 0 else np.inf
    TMR = thrust_momentum_ratio(J, MR)
    if spray_cfg.spray_angle.model == "J":
        theta = spray_angle_from_J(J, spray_cfg.spray_angle.k, spray_cfg.spray_angle.n)
    else:
        theta = spray_angle_from_TMR(TMR)
    Oh_O = ohnesorge_number(mu_O, rho_O, sigma_O, geometry.oxidizer.d_jet)
    Oh_F = ohnesorge_number(mu_F, rho_F, sigma_F, geometry.fuel.d_jet)

    _ev = spray_cfg.evaporation
    k_evap_O = k_evap_F = float("nan")
    if getattr(_ev, "model", "derived") == "derived":
        k_evap_O = evaporation_constant_m2_s(
            Tc=spray_cfg.smd.chamber_gas_T, Pc=Pc, rho_g=rho_gas, rho_l=rho_O,
            L_vap=float(getattr(fluids["oxidizer"], "latent_heat", 0.0) or 0.0),
            T_boil=float(getattr(fluids["oxidizer"], "boiling_point", 0.0) or 0.0),
            cp_g=float(getattr(_ev, "cp_gas", 2200.0)), C_evap=float(getattr(_ev, "C_evap", 1.562)))
        k_evap_F = evaporation_constant_m2_s(
            Tc=spray_cfg.smd.chamber_gas_T, Pc=Pc, rho_g=rho_gas, rho_l=rho_F,
            L_vap=float(getattr(fluids["fuel"], "latent_heat", 0.0) or 0.0),
            T_boil=float(getattr(fluids["fuel"], "boiling_point", 0.0) or 0.0),
            cp_g=float(getattr(_ev, "cp_gas", 2200.0)), C_evap=float(getattr(_ev, "C_evap", 1.562)))
    if np.isfinite(k_evap_O) and np.isfinite(k_evap_F):
        tau_evap_O = tau_evap_from_k(D32_O, k_evap_O)
        tau_evap_F = tau_evap_from_k(D32_F, k_evap_F)
    else:
        tau_evap_O = tau_evap(D32_O, _ev.K)
        tau_evap_F = tau_evap(D32_F, _ev.K)

    s_O = float(getattr(geometry.oxidizer, "spacing", 0.0) or 0.0)
    s_F = float(getattr(geometry.fuel, "spacing", 0.0) or 0.0)
    L_imp = impingement_standoff_m(
        0.5 * (geometry.oxidizer.n_elements + geometry.fuel.n_elements), s_O, s_F,
        geometry.oxidizer.impingement_angle, geometry.fuel.impingement_angle)
    D_pitch_O = float(max(1, int(geometry.oxidizer.n_elements)) * s_O / np.pi)
    D_pitch_F = float(max(1, int(geometry.fuel.n_elements)) * s_F / np.pi)
    _d_avg = 0.5 * (float(geometry.oxidizer.d_jet) + float(geometry.fuel.d_jet))
    _rho_l_avg = 0.5 * (float(rho_O) + float(rho_F))
    if np.isfinite(L_imp) and L_imp > 0 and _d_avg > 0 and rho_gas > 1e-4:
        L_b = float((_d_avg ** 2) / (4.0 * L_imp) * np.sqrt(_rho_l_avg / rho_gas))
        L_b = float(np.clip(L_b, 0.0, 20.0 * _d_avg))
    else:
        L_b = 0.0
    _cok2, violations = check_spray_constraints(We_O, We_F, x_star, spray_cfg)
    return {
        "violations": violations, "J": J, "TMR": TMR, "theta": theta,
        "rho_gas_breakup": float(rho_gas), "Oh_O": float(Oh_O), "Oh_F": float(Oh_F),
        "k_evap_O": float(k_evap_O), "k_evap_F": float(k_evap_F),
        "tau_evap_O": float(tau_evap_O), "tau_evap_F": float(tau_evap_F),
        "L_imp": L_imp, "L_sheet_breakup": float(L_b),
        "D_pitch_O": D_pitch_O, "D_pitch_F": D_pitch_F, "s_pair": float(0.5 * (s_O + s_F)),
        "element_gap_O": float(s_O - geometry.oxidizer.d_jet),
        "element_gap_F": float(s_F - geometry.fuel.d_jet),
        "vaporization_length_total": float((L_imp if np.isfinite(L_imp) else 0.0) + L_b + x_star),
        "apply_tau_res_correction": bool(getattr(_ev, "apply_tau_res_correction", False)),
        "breakup_multiplier": 1.0, "penetration_multiplier": 1.0,
    }


def build_diag(P, sol, config=None, Pc=None):
    """Mirror native_injector._result_to_diag using Numba's injector_solve tuple.

    `sol` is the 24-tuple from kernels.injector_solve. With `config` and `Pc` (every caller in
    engine.accel passes them), an impinging result also carries the spray/doublet keys
    ImpingingInjector.solve publishes (see _impinging_spray_extras).
    """
    (_ok, mdot_O, mdot_F, u_O, u_F, D32_O, D32_F, mom_R, Cd_O, Cd_F,
     Pi_O, Pi_F, dpi_O, dpi_F, A_geom_O, A_geom_F,
     dpf_O, dpf_F, We_O, We_F, u_rel, x_star, constraints_ok, n_iter,
     ti_O, ti_F) = sol[:26]
    holes_O, holes_F = (sol[26], sol[27]) if len(sol) > 26 else ((), ())

    djo, djf = float(P[_DJO]), float(P[_DJF])
    rho_O, rho_F = float(P[_RHO_O]), float(P[_RHO_F])
    n_O, n_F = max(1, int(P[_NO])), max(1, int(P[_NF]))

    mdot_bn_O = Cd_O * A_geom_O * math.sqrt(2.0 * rho_O * dpi_O) if dpi_O > 0 else 0.0
    mdot_bn_F = Cd_F * A_geom_F * math.sqrt(2.0 * rho_F * dpi_F) if dpi_F > 0 else 0.0

    # Effective flow areas. flow_capacity.effective_flow_areas_from_cd recomputes
    # these downstream, but tests and consumers require them PRESENT on the result,
    # so emit them here exactly as Cd * A_geom.
    A_eff_O = Cd_O * A_geom_O
    A_eff_F = Cd_F * A_geom_F

    # Shear-layer turbulence, mirroring impinging.py:155-172 / pintle.py:218-228.
    # The characteristic length is the HYDRAULIC diameter, which for impinging
    # happens to equal d_jet (impinging.py:117-118) but for pintle is a separate
    # geometry field -- using d_jet there gives Re=0 and a flat 0.1.
    # Consumed via closure diagnostics at chamber_solver.py:180, i.e. the
    # accel.solve path rather than accel.evaluate.
    # ti_O/ti_F come from the solve rather than being recomputed here: pintle
    # derives them from PRE-update Reynolds numbers while weighting with
    # POST-update velocities, which cannot be reconstructed from the outputs.
    if float(P[_INJ_TYPE]) == 0.0:                 # pintle
        dh_O, dh_F = float(P[_PIN_DHO]), float(P[_PIN_DHF])
    else:
        dh_O, dh_F = djo, djf
    v_tot = max(u_O + u_F, 1e-6)
    ti_mix = min(max((ti_O * u_O + ti_F * u_F) / v_tot, 0.02), 0.35)

    diag = {
        "injector_type": "impinging",
        "A_eff_O": A_eff_O, "A_eff_F": A_eff_F,
        "turbulence_intensity_O": ti_O, "turbulence_intensity_F": ti_F,
        "turbulence_length_O": 0.07 * dh_O, "turbulence_length_F": 0.07 * dh_F,
        "turbulence_intensity_mix": ti_mix,
        "iterations": int(n_iter),
        "constraints_satisfied": bool(constraints_ok),
        "We_O": We_O, "We_F": We_F,
        "D32_O": D32_O, "D32_F": D32_F,
        "x_star": x_star, "u_rel": u_rel, "V_rel": u_rel,
        "u_O": u_O, "u_F": u_F,
        "Cd_O": Cd_O, "Cd_F": Cd_F,
        "P_injector_O": Pi_O, "P_injector_F": Pi_F,
        "delta_p_injector_O": dpi_O, "delta_p_injector_F": dpi_F,
        "delta_p_feed_O": dpf_O, "delta_p_feed_F": dpf_F,
        "mdot_from_bernoulli_O": mdot_bn_O, "mdot_from_bernoulli_F": mdot_bn_F,
        "A_geom_O": A_geom_O, "A_geom_F": A_geom_F,
        "A_jet_O": math.pi * (djo / 2.0) ** 2, "A_jet_F": math.pi * (djf / 2.0) ** 2,
        "d_jet_O": djo, "d_jet_F": djf,
        "momentum_ratio_n_elements_O": n_O, "momentum_ratio_n_elements_F": n_F,
        "rho_O_momentum": rho_O, "rho_F_momentum": rho_F,
        "MR": (mdot_O / mdot_F) if mdot_F > 0 else float("nan"),
    }
    # v_*_bulk = mdot / (rho * n_elements * A_jet); A_geom IS n_elements*A_jet
    # (impinging.py:58). Conditionally included exactly as _result_to_diag does.
    for tag, mdot, rho, area in (("O", mdot_O, rho_O, A_geom_O),
                                 ("F", mdot_F, rho_F, A_geom_F)):
        if rho > 0 and area > 0:
            v_bulk = mdot / (rho * area)
            if math.isfinite(v_bulk):
                diag[f"v_{tag}_bulk"] = v_bulk

    # Same conditional inclusion as _result_to_diag: absent, not NaN, when invalid.
    if math.isfinite(mom_R) and mom_R > 0:
        diag["momentum_ratio_R"] = mom_R
    if float(P[_INJ_TYPE]) != 0.0:                 # impinging only, as impinging.py publishes it
        # Rupe's mixing ratio M = rho_O v_O^2 d_O / (rho_F v_F^2 d_F) on the same bulk velocities
        # (impinging.rupe_mixing_ratio); absent, not NaN, when invalid.
        v_Ob = mdot_O / (rho_O * A_geom_O) if (rho_O > 0 and A_geom_O > 0) else float("nan")
        v_Fb = mdot_F / (rho_F * A_geom_F) if (rho_F > 0 and A_geom_F > 0) else float("nan")
        den = rho_F * v_Fb ** 2 * djf
        if math.isfinite(den) and den > 0 and math.isfinite(v_Ob) and rho_O > 0 and djo > 0:
            rupe_M = rho_O * v_Ob ** 2 * djo / den
            if math.isfinite(rupe_M) and rupe_M > 0:
                diag["rupe_M"] = rupe_M
        # Momentum-weighted axial velocity of the collided pair (spray.spray_axial_velocity),
        # u_rel when that is not positive -- the transport velocity the spray march starts from.
        mt = mdot_O + mdot_F
        u_ax = ((mdot_O * u_O * math.cos(math.radians(float(P[_ANG_O])))
                 + mdot_F * u_F * math.cos(math.radians(float(P[_ANG_F])))) / mt) if mt > 0 else float("nan")
        diag["u_axial_spray"] = u_ax if (math.isfinite(u_ax) and u_ax > 0) else float(u_rel)
    if float(P[_INJ_TYPE]) != 0.0:
        # Same included-angle convention as impinging.py: separation = theta_O + theta_F. The
        # pintle publishes none (the c* model then takes the drops as axial), so neither does this.
        imp_sep = float(P[_ANG_O]) + float(P[_ANG_F])
        diag["impingement_angle_deg"] = max(1.0, min(179.0, imp_sep))
        diag.update(_manifold_diagnostics(P, holes_O, holes_F, mdot_O, mdot_F, dpi_O, dpi_F))
    if config is not None and Pc is not None and float(P[_INJ_TYPE]) != 0.0:
        diag.update(_impinging_spray_extras(config, P, sol, float(Pc)))
    return diag


def _manifold_diagnostics(P, holes_O, holes_F, mdot_O, mdot_F, dpi_O, dpi_F):
    """impinging._manifold_diagnostics from the kernel's per-hole flows."""
    if len(holes_O) == 0 and len(holes_F) == 0:
        return {"manifold_model": "plenum"}
    out = {"manifold_model": "ring_network"}
    per = {}
    for k, holes, md, dpi, rho, d, n in (
            ("O", holes_O, mdot_O, dpi_O, float(P[_RHO_O]), float(P[_DJO]), float(P[_NO])),
            ("F", holes_F, mdot_F, dpi_F, float(P[_RHO_F]), float(P[_DJF]), float(P[_NF]))):
        if len(holes) == 0:
            continue
        b = _IDX[f"NET_{k}"]
        n_ports, scale, A_ch = float(P[b + 1]), float(P[b + 7]), float(P[b + 3])
        hs = [float(q) for q in holes]
        mean = md / (2.0 * n_ports * scale * len(hs)) if md > 0 else float("nan")
        per[k] = hs
        out[f"element_mass_flows_{k}"] = hs
        out[f"element_flow_ratio_min_{k}"] = float(min(hs) / mean) if mean > 0 else float("nan")
        out[f"element_flow_ratio_max_{k}"] = float(max(hs) / mean) if mean > 0 else float("nan")
        out[f"manifold_branch_velocity_{k}"] = float(md / (2.0 * n_ports) / (rho * A_ch))
        out[f"manifold_ports_{k}"] = int(n_ports)
        A = n * math.pi * d ** 2 / 4.0
        out[f"Cd_eff_manifold_{k}"] = (float(md / (A * math.sqrt(2.0 * rho * dpi)))
                                       if dpi > 0 and md > 0 else float("nan"))
    if "O" in per and "F" in per and len(per["O"]) == len(per["F"]):
        mrs = [o / f if f > 0 else float("inf") for o, f in zip(per["O"], per["F"])]
        out["element_mixture_ratios"] = mrs
        out["element_mass_flows"] = [o + f for o, f in zip(per["O"], per["F"])]
        out["element_mixture_ratio_min"] = float(min(mrs))
        out["element_mixture_ratio_max"] = float(max(mrs))
    return out
