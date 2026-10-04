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

import enum
import os

__all__ = ["available", "enabled", "can_handle", "can_handle_chamber",
           "chamber_physics_not_mirrored",
           "evaluate", "solve", "chamber_solve", "warmup", "require",
           "chug_margin_fast", "Outcome",
           "evaluate_ex", "solve_ex", "chamber_solve_ex"]


class Outcome(enum.Enum):
    """Why an accelerated call did not return a result.

    These two failures look identical to callers today -- both surface as a bare
    None -- but they mean opposite things:

      NOT_HANDLED  the accelerator has no implementation for this config (wrong
                   injector type, film/regen cooling, a non-3D CEA cache). Python
                   is the ONLY implementation, so falling back is mandatory and
                   the fallback does real work.

      NO_SOLUTION  the physics ran and did not converge. Measured over 102 such
                   candidates, the Python path then failed on every one -- it
                   re-derives "infeasible" at full cost and also gives up. So this
                   fallback is (almost always) wasted work.

    Conflating them is what made that impossible to see or measure. The public
    evaluate/solve/chamber_solve keep returning None exactly as before -- every
    caller keys on `is None` and none of them change -- while the *_ex variants
    expose the reason for instrumentation and for any future short-circuit.
    """

    OK = "ok"
    NOT_HANDLED = "not_handled"
    NO_SOLUTION = "no_solution"


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
    """Impinging and pintle; regen-coupled feed loss is not ported for either."""
    inj = getattr(config, "injector", None)
    if inj is None or inj.type not in ("impinging", "pintle"):
        return False          # coaxial has no port
    regen = getattr(config, "regen_cooling", None)
    if regen is not None and getattr(regen, "enabled", False):
        return False          # regen-coupled feed loss not ported
    if inj.type == "impinging":
        # kernels._tn4222 mirrors the 'tn4087' and 'none' TN 4222 property transfers only.
        from engine.core.spray import tn4222_transfer_model
        spray = getattr(config, "spray", None)
        if spray is not None and tn4222_transfer_model(spray.smd) not in ("tn4087", "none"):
            return False
    fs = getattr(config, "feed_system", None) or {}
    for side in ("oxidizer", "fuel"):
        if getattr(fs.get(side), "roughness_m", None) is not None:
            # Colebrook friction at the per-call Re needs the liquid viscosity inside
            # kernels._dpf, which it is not passed; feed_loss.delta_p_feed runs it in Python.
            # (Fittings ARE ported: params._feed folds them into K0.)
            return False
    if inj.type == "pintle":
        # PintleInjector.solve calls cd_from_re WITHOUT an orifice diameter, so a
        # config with geometry-based Cd enabled resolves Cd_inf differently there
        # than the kernel would. Untested corner: hand it to Python.
        for side in ("oxidizer", "fuel"):
            if getattr(config.discharge[side], "use_geometry_cd", False):
                return False
    return True



def chamber_physics_not_mirrored(config=None) -> tuple:
    """Python chamber physics engine.accel.chamber does not reproduce (empty: none).

    Kept as the seam the parity suite and Layer 1 read: an entry here would send every chamber
    call to the Python solve, which is slower but never different physics."""
    return ()


def can_handle_chamber(config) -> bool:
    """Adds the chamber gates on top of can_handle(): film and regen cooling are not mirrored
    (their heat returns to the propellant and feeds the injector), nor the legacy efficiency
    switch. The per-config pieces (the wide c* table, the mixing and blowing models) are checked
    by chamber.chamber_inputs, which returns None for anything it does not mirror."""
    if not can_handle(config):
        return False
    fc = getattr(config, "film_cooling", None)
    if fc is not None and getattr(fc, "enabled", False):
        return False
    eff = config.combustion.efficiency
    if not getattr(eff, "use_advanced_model", True):
        return False
    return True


def _chamber_run(config, cache, P_tank_O, P_tank_F, P_ambient):
    """(P vector, result vector, Outcome) of one accelerated chamber solve."""
    from engine.accel import chamber as _ch
    from engine.accel import kernels as _k
    from engine.accel import params as _p

    if not can_handle_chamber(config):
        return None, None, Outcome.NOT_HANDLED
    if not getattr(cache, "use_3d", False):
        return None, None, Outcome.NOT_HANDLED
    try:
        P = _p.extract_params(config)
    except AssertionError:
        return None, None, Outcome.NOT_HANDLED  # config outside the ported subset
    CH = _ch.chamber_inputs(config, cache)
    if CH is None:
        return None, None, Outcome.NOT_HANDLED
    arr = _k._cea_arrays_cached(cache)
    ok, res = _ch.evaluate_core(P, CH, arr, float(P_tank_O), float(P_tank_F), float(P_ambient))
    if not ok:
        return P, None, Outcome.NO_SOLUTION
    return P, res, Outcome.OK


def chamber_point(config, cache, P_tank_O, P_tank_F, P_ambient=101325.0):
    """Chamber and nozzle at one point, without diagnostics or stability: (dict | None, Outcome).

    For callers that sample the engine hundreds of times and need only the operating point --
    Layer X's engine card (engine/layerx/card.py). Same root as evaluate(); nothing here is a
    second solve that could drift from it.
    """
    P, res, oc = _chamber_run(config, cache, P_tank_O, P_tank_F, P_ambient)
    if oc is not Outcome.OK:
        return None, oc
    from engine.accel import chamber as _ch

    R = _ch._R
    g = lambda k: float(res[R[k]])  # noqa: E731
    return {"Pc": g("PC"), "mdot_O": g("MDOT_O"), "mdot_F": g("MDOT_F"), "MR": g("MR"),
            "F": g("F"), "Isp": g("ISP"), "P_exit": g("P_EXIT"), "cstar_actual": g("CSTAR"),
            "cstar_ideal": g("CSTAR_IDEAL"), "eta_cstar": g("ETA")}, Outcome.OK


def evaluate(config, cache, P_tank_O, P_tank_F, P_ambient=101325.0):
    """Single-call chamber + nozzle + thrust + stability. None => caller falls back."""
    return evaluate_ex(config, cache, P_tank_O, P_tank_F, P_ambient)[0]


def evaluate_ex(config, cache, P_tank_O, P_tank_F, P_ambient=101325.0):
    """As evaluate(), but returns (result_or_None, Outcome)."""
    from engine.accel import chamber as _ch
    from engine.accel import diagnostics as _diag
    from engine.accel import kernels as _k
    from engine.pipeline.stability.analysis import comprehensive_stability_analysis

    P, res, oc = _chamber_run(config, cache, P_tank_O, P_tank_F, P_ambient)
    if oc is not Outcome.OK:
        return None, oc
    R = _ch._R
    Pc = float(res[R["PC"]])
    sol = _k._solve_injector(P, float(P_tank_O), float(P_tank_F), Pc)
    if not sol[0]:
        return None, Outcome.NO_SOLUTION
    diag = _diag.build_diag(P, sol, config, Pc)
    g = lambda k: float(res[R[k]])  # noqa: E731
    mO, mF, mdt = g("MDOT_O"), g("MDOT_F"), g("MDOT")
    diag.update({
        "mdot_O": mO, "mdot_F": mF, "mdot_total": mdt, "Pc": Pc, "MR": g("MR"),
        "cstar_ideal": g("CSTAR_IDEAL"), "cstar_actual": g("CSTAR"), "eta_cstar": g("ETA"),
        "gamma": g("GAMMA"), "R": g("R"), "Tc": g("TC_EFF"), "Tc_ideal": g("TC_IDEAL"),
        "M": g("M_MOL"), "Pc_ns": Pc / g("KAPPA"), "stagnation_loss_kappa": g("KAPPA"),
        "SMD": max(sol[5], sol[6]),
        "cstar_efficiency": {
            "eta_cstar": g("ETA"), "eta_vaporization": g("ETA_VAP"), "eta_mixing": g("ETA_MIX"),
            "eta_heat_loss": g("ETA_HL"), "heat_lost_W": g("Q_ABL"),
            "fraction_vaporized": g("F_VAP"), "rupe_Em": g("EM"),
        },
    })
    try:
        stab = comprehensive_stability_analysis(
            config=config, Pc=Pc, MR=g("MR"), mdot_total=mdt,
            cstar=g("CSTAR"), gamma=g("GAMMA"), R=g("R"), Tc=g("TC_EFF"), diagnostics=diag)
    except Exception:
        return None, Outcome.NO_SOLUTION
    return {
        "Pc": Pc, "mdot_O": mO, "mdot_F": mF, "mdot_total": mdt, "MR": g("MR"),
        "F": g("F"), "Isp": g("ISP"), "v_exit": g("V_EXIT"), "P_exit": g("P_EXIT"),
        "P_throat": g("P_THROAT"), "T_exit": g("T_EXIT"), "T_throat": g("T_THROAT"),
        "M_exit": g("M_EXIT"), "Tc": g("TC_EFF"),
        "eps": float(config.chamber_geometry.expansion_ratio),
        "A_throat": float(config.chamber_geometry.A_throat),
        "A_exit": float(config.chamber_geometry.A_exit),
        "cstar_actual": g("CSTAR"), "cstar_ideal": g("CSTAR_IDEAL"), "eta_cstar": g("ETA"),
        "gamma": g("GAMMA"), "R": g("R"),
        "Cf": g("CF"), "Cf_actual": g("CF"), "Cf_ideal": g("CF_IDEAL"),
        "Cd_O": sol[8], "Cd_F": sol[9], "A_geom_O": sol[14], "A_geom_F": sol[15],
        "stability": stab, "stability_results": stab,
        "diagnostics": diag, "P_ambient": float(P_ambient),
        "native_fast_eval": True, "numba_fast_eval": True,
    }, Outcome.OK


def solve(config, P_tank_O, P_tank_F, Pc):
    """Injector mass flows at a given Pc -> (mdot_O, mdot_F, diagnostics), or None."""
    return solve_ex(config, P_tank_O, P_tank_F, Pc)[0]


def solve_ex(config, P_tank_O, P_tank_F, Pc):
    """As solve(), but returns (result_or_None, Outcome).

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
        return None, Outcome.NOT_HANDLED
    try:
        P = _p.extract_params(config)
    except AssertionError:
        return None, Outcome.NOT_HANDLED
    sol = _k._solve_injector(P, float(P_tank_O), float(P_tank_F), float(Pc))
    if not sol[0]:
        return None, Outcome.NO_SOLUTION
    return (float(sol[1]), float(sol[2]), _diag.build_diag(P, sol, config, Pc)), Outcome.OK


def chamber_solve(config, cache, P_tank_O, P_tank_F):
    """Whole chamber residual loop -> (Pc, diagnostics), or None."""
    return chamber_solve_ex(config, cache, P_tank_O, P_tank_F)[0]


def chamber_solve_ex(config, cache, P_tank_O, P_tank_F):
    """As chamber_solve(), but returns (result_or_None, Outcome).

    The only consumer (chamber_solver._accel_chamber_pc) reads element 0. Shares
    chamber.evaluate_core's root with evaluate(): a second, subtly different root-find is how
    the two paths would drift apart."""
    from engine.accel import chamber as _ch

    P, res, oc = _chamber_run(config, cache, P_tank_O, P_tank_F, 101325.0)
    if oc is not Outcome.OK:
        return None, oc
    R = _ch._R
    Pc = float(res[R["PC"]])
    if not (Pc > 0.0) or Pc != Pc:
        return None, Outcome.NO_SOLUTION
    g = lambda k: float(res[R[k]])  # noqa: E731
    return (Pc, {"Pc": Pc, "mdot_O": g("MDOT_O"), "mdot_F": g("MDOT_F"), "mdot_total": g("MDOT"),
                 "MR": g("MR"), "cstar_ideal": g("CSTAR_IDEAL"), "cstar_actual": g("CSTAR"),
                 "eta_cstar": g("ETA"), "gamma": g("GAMMA"), "R": g("R"), "Tc": g("TC_EFF"),
                 "Tc_ideal": g("TC_IDEAL"), "converged": True}), Outcome.OK


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
        from engine.accel import chamber as _ch
        _ch.warmup()
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
