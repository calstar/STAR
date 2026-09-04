"""Numba-backed physics accelerator for the Layer-1 optimizer inner loop.

Replaced the hand-written C port that used to live at engine/native (deleted once
this reached parity and then overtook it). Every entry point returns None rather
than raising when it cannot handle a config, because every caller treats None as
"fall back to the authoritative Python path".

Set ED_ACCEL=off to disable the accelerator entirely; everything then runs on the
Python physics, which stays authoritative and is what the parity suite diffs
against.
"""
from __future__ import annotations

import os

__all__ = ["available", "enabled", "can_handle", "can_handle_chamber",
           "evaluate", "solve", "chamber_solve", "warmup", "require",
           "chug_margin_fast"]


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
    if os.environ.get("ED_USE_NATIVE") == "0":   # historical switch, still honoured
        return False
    return available()


def require() -> bool:
    """Strict mode: a genuine accelerator failure raises instead of falling back.

    Without it a broken accelerator is invisible -- every caller falls back to
    Python and the suite passes green on the wrong path.
    """
    return os.environ.get("ED_REQUIRE_ACCEL") == "1"


def can_handle(config) -> bool:
    """Impinging only; regen-coupled feed loss is not ported."""
    inj = getattr(config, "injector", None)
    if inj is None or inj.type != "impinging":
        return False
    regen = getattr(config, "regen_cooling", None)
    if regen is not None and getattr(regen, "enabled", False):
        return False  # regen-coupled feed loss not ported
    return True


def can_handle_chamber(config) -> bool:
    """Adds the chamber-solve gates on top of can_handle().

    No ablative gate: ablative IS ported (kernels._cooling_evaluate). No graphite
    gate either -- graphite never enters the chamber residual; it lives in the
    burn/recession path and chamber_solver.py references it zero times.
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


def solve(config, P_tank_O, P_tank_F, Pc):
    """Injector mass flows at a given Pc -> (mdot_O, mdot_F, diagnostics), or None.

    Sits on the FALLBACK path: closure.flows
    calls it on every residual iteration of the Python chamber solve, so it runs
    far more often than evaluate() does.

    The param vector is rebuilt per call rather than cached on the config, exactly
    as the C path rebuilds its state per call. Caching would be wrong here: Layer 1
    mutates the worker's config in place between candidates
    (_apply_x_to_worker_config_inplace), so a config-keyed cache would serve stale
    geometry.
    """
    from engine.accel import diagnostics as _diag
    from engine.accel import kernels as _k
    from engine.accel import params as _p

    if not can_handle(config):
        return None
    try:
        P = _p.extract_params(config)
    except AssertionError:
        return None
    sol = _k.injector_solve(P, float(P_tank_O), float(P_tank_F), float(Pc))
    if not sol[0]:
        return None
    return float(sol[1]), float(sol[2]), _diag.build_diag(P, sol)


def chamber_solve(config, cache, P_tank_O, P_tank_F):
    """Whole chamber residual loop -> (Pc, diagnostics), or None.

    The only consumer (chamber_solver._native_chamber_pc) reads element 0.

    Shares evaluate_core's Brent solve instead of duplicating it. That computes a
    little more than Pc (nozzle/thrust), which is deliberate: a second, subtly
    different root-find is exactly how the two paths would drift apart.
    """
    from engine.accel import kernels as _k
    from engine.accel import params as _p

    if not can_handle_chamber(config):
        return None
    if not getattr(cache, "use_3d", False):
        return None
    try:
        P = _p.extract_params(config)
    except AssertionError:
        return None
    arr = _k._cea_arrays_cached(cache)
    r = _k.evaluate_core(P, *arr, float(P_tank_O), float(P_tank_F), 101325.0)
    if not r[0]:
        return None
    Pc = float(r[1])
    if not (Pc > 0.0) or Pc != Pc:
        return None
    return Pc, {"Pc": Pc, "mdot_O": r[11], "mdot_F": r[12], "mdot_total": r[8],
                "MR": r[4], "cstar_ideal": r[13], "cstar_actual": r[5],
                "eta_cstar": r[14], "gamma": r[6], "R": r[15],
                "Tc": r[21], "Tc_ideal": r[7], "converged": True}


def warmup():
    """Force the JIT to compile/load before a ProcessPool is built.

    @njit(cache=True) persists compiled code, but each worker process still
    deserializes it on first call -- un-warmed, that lands inside the first CMA
    generation and skews it. Call this in the parent AND in the pool's worker
    initialiser.

    Never raises: a warmup failure must not block optimization, exactly as the
    C prewarm didn't.
    """
    try:
        import numpy as np
        from engine.accel import kernels as _k
        from engine.accel.params import NP
        n = 2
        grid = np.linspace(1.0, 2.0, n)
        tab = np.ones((n, n, n), dtype=np.float64)
        _k.evaluate_core(np.zeros(NP), grid, grid, grid,
                         tab, tab, tab, tab, tab, tab, tab, 1.0, 1.0, 1.0)
        return True
    except Exception:
        return False


def chug_margin_fast(streams, chamber, **kw):
    """Chug gain/phase margin. Dispatches like the rest of this surface.

    fast_acoustic deliberately has no counterpart here: it measured 10.5 us in
    Python against 4.2 us in C, and acoustic.fast_acoustic has no loop to compile.
    A 6 us difference does not justify a kernel, so that path stays pure Python.
    """
    from engine.accel import stability as _stab
    return _stab.chug_margin_fast(streams, chamber, **kw)
