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


def build_diag(P, sol):
    """Mirror native_injector._result_to_diag using Numba's injector_solve tuple.

    `sol` is the 24-tuple from kernels.injector_solve.
    """
    (_ok, mdot_O, mdot_F, u_O, u_F, D32_O, D32_F, mom_R, Cd_O, Cd_F,
     Pi_O, Pi_F, dpi_O, dpi_F, A_geom_O, A_geom_F,
     dpf_O, dpf_F, We_O, We_F, u_rel, x_star, constraints_ok, n_iter,
     ti_O, ti_F) = sol

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
    # Same included-angle convention as impinging.py: separation = theta_O + theta_F.
    imp_sep = float(P[_ANG_O]) + float(P[_ANG_F])
    diag["impingement_angle_deg"] = max(1.0, min(179.0, imp_sep))
    return diag
