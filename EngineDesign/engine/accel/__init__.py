"""Numba-backed physics accelerator for the Layer-1 optimizer inner loop.

Replaces the hand-written C port at engine/native. During the migration both
backends exist and must be *simultaneously* callable -- the parity suite, the
benchmark and CI all compare them -- so backend selection lives here rather than
being baked into either implementation.

Public surface mirrors native_injector's, so call sites change an import and
nothing else. Every entry point returns None rather than raising when it cannot
handle a config, because every caller already treats None as "use Python".
"""
from __future__ import annotations

import os

__all__ = ["available", "enabled", "can_handle", "can_handle_chamber", "evaluate"]


def available() -> bool:
    """False (never raises) when numba is absent, so a missing dep degrades to Python."""
    try:
        import numba  # noqa: F401
    except Exception:
        return False
    return True


def enabled() -> bool:
    if os.environ.get("ED_ACCEL", "numba") == "off":
        return False
    if os.environ.get("ED_USE_NATIVE") == "0":   # honour the historical switch
        return False
    return available()


def can_handle(config) -> bool:
    """Mirrors native_injector._can_handle."""
    inj = getattr(config, "injector", None)
    if inj is None or inj.type != "impinging":
        return False
    regen = getattr(config, "regen_cooling", None)
    if regen is not None and getattr(regen, "enabled", False):
        return False  # regen-coupled feed loss not ported
    return True


def can_handle_chamber(config) -> bool:
    """Mirrors native_injector._can_handle_chamber.

    No ablative gate: ablative IS ported (kernels._cooling_evaluate). No graphite
    gate either -- graphite never enters the chamber residual, exactly as the C
    kernel treats it.
    """
    if not can_handle(config):
        return False
    fc = getattr(config, "film_cooling", None)
    if fc is not None and getattr(fc, "enabled", False):
        return False
    eff = config.combustion.efficiency
    if not getattr(eff, "use_advanced_model", True):
        return False
    return True


def evaluate(config, cache, P_tank_O, P_tank_F, P_ambient=101325.0):
    """Single-call chamber + nozzle + thrust + stability. None => caller falls back.

    Signature matches native_injector.evaluate so it drops into the same slot.
    """
    from engine.accel import diagnostics as _diag
    from engine.accel import kernels as _k
    from engine.accel import params as _p
    from engine.pipeline.stability.analysis import comprehensive_stability_analysis

    if not can_handle_chamber(config):
        return None
    if not getattr(cache, "use_3d", False):
        return None
    try:
        P = _p.extract_params(config)
    except AssertionError:
        return None                       # config outside the ported subset
    arr = _k._cea_arrays_cached(cache)

    r = _k.evaluate_core(P, *arr, float(P_tank_O), float(P_tank_F), float(P_ambient))
    if not r[0]:
        return None
    (_, Pc, F, Isp, MR, csa, gm, tc, mdt, vex, cfa,
     mO, mF, cs_id, eta, Rg, Pex, Pth, Tex, Tth, cf_id, tc_eff) = r
    if F != F:
        return None

    sol = _k.injector_solve(P, float(P_tank_O), float(P_tank_F), float(Pc))
    if not sol[0]:
        return None
    diag = _diag.build_diag(P, sol)
    diag.update({
        "mdot_O": mO, "mdot_F": mF, "mdot_total": mdt, "Pc": Pc, "MR": MR,
        "cstar_ideal": cs_id, "cstar_actual": csa, "eta_cstar": eta,
        "gamma": gm, "R": Rg, "Tc": tc_eff, "SMD": max(sol[5], sol[6]),
    })
    try:
        stab = comprehensive_stability_analysis(
            config=config, Pc=Pc, MR=MR, mdot_total=mdt,
            cstar=csa, gamma=gm, R=Rg, Tc=tc_eff, diagnostics=diag)
    except Exception:
        return None
    return {
        "Pc": Pc, "mdot_O": mO, "mdot_F": mF, "mdot_total": mdt, "MR": MR,
        "F": F, "Isp": Isp, "v_exit": vex, "P_exit": Pex, "P_throat": Pth,
        "T_exit": Tex, "T_throat": Tth, "Tc": tc_eff,
        "eps": float(P[_k.G_EPS]), "A_throat": float(P[_k.G_AT]), "A_exit": float(P[_k.G_AE]),
        "cstar_actual": csa, "cstar_ideal": cs_id, "eta_cstar": eta, "gamma": gm, "R": Rg,
        "Cf": cfa, "Cf_actual": cfa, "Cf_ideal": cf_id,
        "Cd_O": sol[8], "Cd_F": sol[9], "A_geom_O": sol[14], "A_geom_F": sol[15],
        "stability": stab, "stability_results": stab,
        "diagnostics": diag, "P_ambient": float(P_ambient),
        "native_fast_eval": True, "numba_fast_eval": True,
    }
