"""Native injector fast-path used by engine.core.closure.flows when ED_USE_NATIVE=1.

Builds an EdEngineState from a PintleEngineConfig, calls the C impinging solver,
and returns (mdot_O, mdot_F, diagnostics) matching the Python solve's contract for
the keys the chamber residual / Layer 1 / stability consume.

Safety:
  * Only the impinging injector with regen-coupled feed loss disabled is handled;
    anything else returns None so the caller uses Python.
  * solve_checked() runs the Python solver once and compares mdot before trusting
    native for the session (see closure wiring); any mismatch disables native.
"""
from __future__ import annotations

import math
import os

_NAT = None
_PHI = {"none": 0, "sqrtP": 1, "logP": 2}
_INJ = {"pintle": 0, "impinging": 1, "coaxial": 2}


_NATIVE_LIB_OK = None

# ed_combustion_physics.c implements the Rupe mixing model (eta_turbulence retired) at
# bit-parity with Python (verified 2026-06-28, worst reldiff 5e-16 across 600-900 psi),
# so the native fast path is on by default.


def native_enabled() -> bool:
    """Single source of truth for whether the native kernel is used at runtime.

    ON by default; ``ED_USE_NATIVE=0`` forces it OFF (debugging / parity escape
    hatch), and a library that cannot be built or loaded also disables it
    (graceful fallback to Python — never a hard failure).

    The ``ED_USE_NATIVE`` env var is re-read every call so the escape hatch works
    even after the lib has loaded (tests pin it at runtime). Only the expensive
    library-load probe is cached.

    This decides *whether native is wired in at all*. Per-config capability is a
    SEPARATE decision made by ``_can_handle*`` — pintle and other unsupported
    configs always fall back to the Python path regardless of this flag.
    """
    if os.environ.get("ED_USE_NATIVE", "1") == "0":
        return False
    global _NATIVE_LIB_OK
    if _NATIVE_LIB_OK is None:
        try:
            _nat()  # build/load the library once; cache the instance
            _NATIVE_LIB_OK = True
        except Exception:
            _NATIVE_LIB_OK = False
    return _NATIVE_LIB_OK


def available() -> bool:
    """Backwards-compatible alias for :func:`native_enabled`."""
    return native_enabled()


def require_native() -> bool:
    """Strict mode (ED_REQUIRE_NATIVE=1): a *genuine* native failure (library
    won't load, solver errors, returns rc!=0 / non-converged) raises instead of
    returning None to fall back to Python.

    This exists for the CI parity job: without it, a broken or missing native
    build makes every call silently fall back to Python, so the parity tests pass
    on the Python path and report a FALSE GREEN. Configs the native kernel simply
    doesn't cover (`_can_handle*` False) still fall back quietly — that's "not
    applicable", not a failure — so default (non-strict) runs are unaffected.
    """
    return os.environ.get("ED_REQUIRE_NATIVE", "0") == "1"


def _nat():
    global _NAT
    if _NAT is None:
        from . import ed_native
        _NAT = ed_native.load()
    return _NAT


def _can_handle(config) -> bool:
    inj = getattr(config, "injector", None)
    if inj is None or inj.type != "impinging":
        return False
    regen = getattr(config, "regen_cooling", None)
    if regen is not None and getattr(regen, "enabled", False):
        return False  # regen-coupled feed loss not ported yet
    return True


def _fill_discharge(dst, c):
    dst.Cd_inf = float(c.Cd_inf); dst.a_Re = float(c.a_Re); dst.Cd_min = float(c.Cd_min)
    dst.use_geometry_cd = int(bool(c.use_geometry_cd))
    dst.d_ref_m = float(c.d_ref_m); dst.d_min_m = float(c.d_min_m)
    dst.cd_small_hole_exponent = float(c.cd_small_hole_exponent)
    dst.cd_large_hole_log_gain = float(c.cd_large_hole_log_gain)
    dst.cd_inf_max = float(c.cd_inf_max); dst.cd_inf_min_geom = float(c.cd_inf_min_geom)
    dst.use_pressure_correction = int(bool(c.use_pressure_correction))
    dst.P_ref = float(c.P_ref); dst.a_P = float(c.a_P)
    dst.use_temperature_correction = int(bool(c.use_temperature_correction))
    dst.T_ref = float(c.T_ref); dst.a_T = float(c.a_T)


def _fill_feed(dst, c):
    dst.d_inlet = float(getattr(c, "d_inlet", 0.0) or 0.0)
    dst.A_hydraulic = float(getattr(c, "A_hydraulic", 0.0) or 0.0)
    dst.K0 = float(c.K0); dst.K1 = float(c.K1); dst.phi_type = _PHI[c.phi_type]


_EFF_MODEL = {"constant": 0, "linear": 1, "exponential": 2}


def _fill_fluid(dst, f):
    dst.density = float(f.density); dst.viscosity = float(f.viscosity)
    dst.surface_tension = float(f.surface_tension)
    dst.temperature = float(getattr(f, "temperature", 0.0) or 0.0)
    dst.latent_heat = float(getattr(f, "latent_heat", 300e3) or 300e3)


def _fill_comb(dst, eff):
    dst.model = _EFF_MODEL.get(eff.model, 2)
    dst.C = float(eff.C); dst.K = float(eff.K)
    dst.cooling_efficiency_floor = float(eff.cooling_efficiency_floor)
    dst.use_cooling_coupling = int(bool(eff.use_cooling_coupling))
    dst.tau_ref = float(eff.tau_ref); dst.tau_ref_P = float(eff.tau_ref_P)
    dst.tau_ref_T = float(eff.tau_ref_T); dst.n_pressure = float(eff.n_pressure)
    dst.T_star_fuel_cap_K = float(getattr(eff, "T_star_fuel_cap_K", 1000.0))
    floor = getattr(eff, "tau_Tc_floor_K", None)
    dst.has_tau_Tc_floor = int(floor is not None)
    dst.tau_Tc_floor = float(floor or 0.0)
    # Rupe momentum-ratio mixing model (R_opt<=0 => derive from impingement angles in C)
    dst.Em_peak = float(getattr(eff, "Em_peak", 0.96))
    dst.mixing_sigma = float(getattr(eff, "mixing_sigma", 1.5))
    _ropt = getattr(eff, "R_opt", None)
    dst.R_opt = float(_ropt) if _ropt is not None else 0.0


def _fill_cooling(dst, cfg):
    rg, ab, eff = cfg.regen_cooling, cfg.ablative_cooling, cfg.combustion.efficiency
    fc = getattr(cfg, "film_cooling", None)
    dst.regen_enabled = int(bool(rg and rg.enabled))
    dst.film_enabled = int(bool(fc and fc.enabled))
    dst.ablative_enabled = int(bool(ab and ab.enabled))
    dst.graphite_enabled = int(bool(getattr(cfg, "graphite_insert", None) and cfg.graphite_insert.enabled))
    dst.use_cooling_coupling = int(bool(eff.use_cooling_coupling))
    dst.cooling_efficiency_floor = float(eff.cooling_efficiency_floor)
    if rg is not None:
        dst.hot_gas_viscosity = float(rg.hot_gas_viscosity)
        dst.hot_gas_thermal_conductivity = float(rg.hot_gas_thermal_conductivity)
        dst.hot_gas_prandtl = float(rg.hot_gas_prandtl)
        dst.gas_turbulence_intensity = float(rg.gas_turbulence_intensity)
        dst.recovery_factor = float(rg.recovery_factor) if rg.recovery_factor is not None else 0.94
        dst.radiation_emissivity_hot = float(rg.radiation_emissivity_hot)
        dst.radiation_view_factor = float(rg.radiation_view_factor)
        dst.regen_chamber_inner_diameter = float(rg.chamber_inner_diameter or 0.0)
    if ab is not None:
        dst.ablative_coverage_fraction = float(ab.coverage_fraction)
        dst.ablative_surface_temperature_limit = float(ab.surface_temperature_limit)
        dst.ablative_material_density = float(ab.material_density)
        dst.ablative_heat_of_ablation = float(ab.heat_of_ablation)
        dst.ablative_specific_heat = float(ab.specific_heat)
        dst.ablative_pyrolysis_temperature = float(ab.pyrolysis_temperature)
        dst.ablative_use_physics_based_blowing = int(bool(ab.use_physics_based_blowing))
        dst.ablative_blowing_efficiency = float(ab.blowing_efficiency)
        dst.ablative_blowing_coefficient = float(ab.blowing_coefficient)
        dst.ablative_blowing_min_reduction_factor = float(ab.blowing_min_reduction_factor)
        dst.ablative_turbulence_reference_intensity = float(ab.turbulence_reference_intensity)
        dst.ablative_turbulence_sensitivity = float(ab.turbulence_sensitivity)
        dst.ablative_turbulence_exponent = float(ab.turbulence_exponent)
        dst.ablative_turbulence_max_multiplier = float(ab.turbulence_max_multiplier)
        dst.ablative_surface_emissivity = float(ab.surface_emissivity)
        dst.ablative_ambient_temperature = float(ab.ambient_temperature)
        dst.ablative_radiative_sink_minimum_threshold = float(ab.radiative_sink_minimum_threshold)
        dst.ablative_radiative_sink_fallback_temperature = float(ab.radiative_sink_fallback_temperature)


def _fill_geom(dst, cg):
    dst.A_throat = float(cg.A_throat); dst.A_exit = float(cg.A_exit); dst.volume = float(cg.volume)
    dst.Lstar = float(cg.Lstar) if cg.Lstar else 0.0
    dst.length = float(cg.length)
    dst.length_cylindrical = float(cg.length_cylindrical or 0.0)
    dst.length_contraction = float(cg.length_contraction or 0.0)
    dst.chamber_diameter = float(cg.chamber_diameter or 0.0)
    dst.exit_diameter = float(cg.exit_diameter or 0.0)
    dst.expansion_ratio = float(cg.expansion_ratio)
    dst.nozzle_efficiency = float(cg.nozzle_efficiency)
    dst.Cf = float(cg.Cf or 0.0)
    dst.design_pressure = float(cg.design_pressure or 0.0)


def _fill_imp(dst, b):
    dst.n_elements = int(b.n_elements); dst.d_jet = float(b.d_jet)
    dst.impingement_angle = float(b.impingement_angle)
    dst.spacing = float(getattr(b, "spacing", 0.0) or 0.0)


def build_state(config):
    from . import ed_native
    st = ed_native.EdEngineState()
    g = config.injector.geometry
    sp = config.spray
    st.injector.type = _INJ[config.injector.type]
    _fill_imp(st.injector.imp_O, g.oxidizer)
    _fill_imp(st.injector.imp_F, g.fuel)
    _fill_discharge(st.discharge_O, config.discharge["oxidizer"])
    _fill_discharge(st.discharge_F, config.discharge["fuel"])
    _fill_feed(st.feed_O, config.feed_system["oxidizer"])
    _fill_feed(st.feed_F, config.feed_system["fuel"])
    _fill_fluid(st.fluid_O, config.fluids["oxidizer"])
    _fill_fluid(st.fluid_F, config.fluids["fuel"])
    # Impinging atomization is always Ingebo (see impinging.py); ignore stale lefebvre in YAML.
    st.spray.smd_model = 1
    st.spray.smd_C = float(sp.smd.C); st.spray.smd_m = float(sp.smd.m); st.spray.smd_p = float(sp.smd.p)
    st.spray.smd_C_ingebo = float(sp.smd.C_ingebo)
    wcm = getattr(sp.smd, "we_corr_max", None)
    st.spray.smd_we_corr_max = float(wcm) if wcm else 0.0
    st.spray.chamber_gas_R = float(sp.smd.chamber_gas_R)
    st.spray.chamber_gas_T = float(sp.smd.chamber_gas_T)
    st.spray.spray_angle_model = 0 if sp.spray_angle.model == "J" else 1
    st.spray.spray_angle_k = float(sp.spray_angle.k); st.spray.spray_angle_n = float(sp.spray_angle.n)
    st.spray.we_min = float(sp.weber.get("We_min", 15.0))
    st.spray.evap_K = float(sp.evaporation.K)
    st.spray.evap_x_star_limit = float(sp.evaporation.x_star_limit)
    st.spray.evap_use_constraint = int(bool(sp.evaporation.use_constraint))
    st.solver.closure_max_iterations = int(config.solver.closure.max_iterations)
    st.solver.closure_Cd_reduction_factor = float(config.solver.closure.Cd_reduction_factor)
    st.solver.Pc_min_bound = float(config.solver.Pc_bounds[0])
    st.solver.Pc_max_bound = float(config.solver.Pc_bounds[1])
    st.solver.tolerance = float(config.solver.tolerance)
    st.solver.max_iterations = int(config.solver.max_iterations)
    _fill_comb(st.comb, config.combustion.efficiency)
    _fill_cooling(st.cooling, config)
    from engine.pipeline.config_schemas import ensure_chamber_geometry
    _fill_geom(st.geom, ensure_chamber_geometry(config))
    return st


def _result_to_diag(config, r):
    """Map EdInjectorResult -> the diagnostics dict the Python solve returns."""
    g = config.injector.geometry
    djo, djf = float(g.oxidizer.d_jet), float(g.fuel.d_jet)
    rho_O = float(config.fluids["oxidizer"].density)
    rho_F = float(config.fluids["fuel"].density)
    n_O = max(1, int(g.oxidizer.n_elements))
    n_F = max(1, int(g.fuel.n_elements))
    mdot_bn_O = r.Cd_O * r.A_geom_O * math.sqrt(2.0 * rho_O * r.delta_p_injector_O) if r.delta_p_injector_O > 0 else 0.0
    mdot_bn_F = r.Cd_F * r.A_geom_F * math.sqrt(2.0 * rho_F * r.delta_p_injector_F) if r.delta_p_injector_F > 0 else 0.0
    diag = {
        "injector_type": "impinging",
        "iterations": int(r.iterations),
        "constraints_satisfied": bool(r.constraints_satisfied),
        "feed_orifice_coupling_iterations": int(r.feed_orifice_coupling_iters),
        "J": r.J, "TMR": r.TMR, "theta": r.theta,
        "We_O": r.We_O, "We_F": r.We_F,
        "D32_O": r.D32_O, "D32_F": r.D32_F,
        "x_star": r.x_star, "u_rel": r.u_rel, "V_rel": r.u_rel,
        "u_O": r.u_O, "u_F": r.u_F,
        "turbulence_intensity_mix": r.turbulence_intensity_mix,
        "Cd_O": r.Cd_O, "Cd_F": r.Cd_F,
        "P_injector_O": r.P_injector_O, "P_injector_F": r.P_injector_F,
        "delta_p_injector_O": r.delta_p_injector_O, "delta_p_injector_F": r.delta_p_injector_F,
        "delta_p_feed_O": r.delta_p_feed_O, "delta_p_feed_F": r.delta_p_feed_F,
        "mdot_from_bernoulli_O": mdot_bn_O, "mdot_from_bernoulli_F": mdot_bn_F,
        "A_geom_O": r.A_geom_O, "A_geom_F": r.A_geom_F,
        "A_eff_O": r.A_eff_O, "A_eff_F": r.A_eff_F,
        "A_jet_O": math.pi * (djo / 2.0) ** 2, "A_jet_F": math.pi * (djf / 2.0) ** 2,
        "d_jet_O": djo, "d_jet_F": djf,
        "momentum_ratio_n_elements_O": n_O, "momentum_ratio_n_elements_F": n_F,
        "rho_O_momentum": rho_O, "rho_F_momentum": rho_F,
        "MR": r.MR,
    }
    if math.isfinite(r.v_O_bulk):
        diag["v_O_bulk"] = r.v_O_bulk
    if math.isfinite(r.v_F_bulk):
        diag["v_F_bulk"] = r.v_F_bulk
    if math.isfinite(r.momentum_ratio_R) and r.momentum_ratio_R > 0:
        diag["momentum_ratio_R"] = r.momentum_ratio_R
    # Same included-angle convention as impinging.py: separation = θ_O + θ_F (deg).
    imp_sep = float(g.oxidizer.impingement_angle + g.fuel.impingement_angle)
    diag["impingement_angle_deg"] = max(1.0, min(179.0, imp_sep))
    return diag


def solve(config, P_tank_O, P_tank_F, Pc):
    """Return (mdot_O, mdot_F, diagnostics) via the C kernel, or None to fall back."""
    if not _can_handle(config):
        return None
    try:
        nat = _nat()
        st = build_state(config)
        rc, r = nat.injector_solve(st, float(P_tank_O), float(P_tank_F), float(Pc))
        if rc != 0:
            if require_native():
                raise RuntimeError(f"native injector_solve returned rc={rc}")
            return None
        return float(r.mdot_O), float(r.mdot_F), _result_to_diag(config, r)
    except Exception:
        if require_native():
            raise
        return None


# --- chamber solve (Stage 3): whole residual loop in C ---------------------
# Token of the CEACache whose tables are currently resident in the native lib's
# single buffer (None = none loaded). See _ensure_cea for why this is not id()-keyed.
_CEA_RESIDENT_TOKEN = None


def _can_handle_chamber(config) -> bool:
    """Native chamber solve covers impinging + ablative-only cooling (film/regen
    off), matching the ported cooling_eff path. Anything else -> Python."""
    if not _can_handle(config):
        return False
    fc = getattr(config, "film_cooling", None)
    if fc is not None and getattr(fc, "enabled", False):
        return False
    eff = config.combustion.efficiency
    if not getattr(eff, "use_advanced_model", True):
        return False
    return True


def _ensure_cea(cache) -> bool:
    """Load the live CEACache into the native lib's (single) resident tables buffer.

    The native library holds ONE table set at a time, so we reload whenever the
    requested cache differs from the one currently resident. Identity is tracked by
    a token stored ON the cache object — immune to id() reuse after GC. The old
    id(cache)-keyed flag silently served a previously-loaded config's tables when a
    freed cache's id was reused (multi-config processes: tests, GUI config switches).
    Returns False if the cache isn't a supported 3D grid.
    """
    global _CEA_RESIDENT_TOKEN
    nat = _nat()
    token = getattr(cache, "_ed_native_token", None)
    if token is None:
        token = object()  # unique sentinel; lives and dies with this cache
        try:
            cache._ed_native_token = token
        except Exception:
            token = None  # cache rejects attributes -> always reload (safe, slower)
    if token is not None and _CEA_RESIDENT_TOKEN is token:
        return True
    if not getattr(cache, "use_3d", False):
        return False
    import os, struct, tempfile, numpy as np
    Pc = np.ascontiguousarray(cache.Pc_grid, dtype=np.float64)
    MR = np.ascontiguousarray(cache.MR_grid, dtype=np.float64)
    eps = np.ascontiguousarray(cache.eps_grid, dtype=np.float64)
    tables = [cache.cstar_table, cache.Cf_table, cache.Tc_table,
              cache.gamma_table, cache.R_table, cache.M_table]
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as f:
        path = f.name
        f.write(b"EDCA"); f.write(struct.pack("<i", 1))
        f.write(struct.pack("<iii", len(Pc), len(MR), len(eps)))
        f.write(Pc.tobytes()); f.write(MR.tobytes()); f.write(eps.tobytes())
        for t in tables:
            f.write(np.ascontiguousarray(t, dtype=np.float64).tobytes())
    # ed_cea_load fully fread()s the file into native memory and fclose()s it, so the
    # temp file is dead weight the moment cea_load returns. Delete it unconditionally —
    # otherwise every worker process / new cache object leaks a ~1.8 MB .bin into $TMPDIR.
    try:
        nat.cea_load(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    _CEA_RESIDENT_TOKEN = token
    return True


def chug_margin_fast(streams, chamber, *, with_regulator=True, f_lo=2.0, f_hi=2000.0):
    """Native port of chug.chug_margin_fast. Extracts the per-stream constants from
    the Python ChugStream/ChugChamber objects (cheap) and runs the 200-pt complex
    sweep in C. Returns a dict matching the Python result, or None to fall back."""
    if not available():
        return None
    try:
        from . import ed_native
        nat = _nat()
        cstreams = []
        for st in streams:
            reg = st.regulator
            enabled = bool(getattr(reg, "enabled", False) and with_regulator and getattr(reg, "Z_hf", 0.0) > 0.0)
            cstreams.append(ed_native.EdChugStream(
                G_inj=float(st.G_inj()), inertance=float(st.inertance()),
                resistance=float(st.resistance()), tau_conv=float(st.tau_conv),
                reg_Z_hf=float(getattr(reg, "Z_hf", 0.0)),
                reg_corner_hz=float(getattr(reg, "corner_hz", 3.0)),
                reg_enabled=int(enabled)))
        rc, out = nat.chug_margin_fast(cstreams, chamber.K_c(), chamber.theta_c(), f_lo, f_hi)
        if rc != 0:
            return None
        return {
            "gain_margin": float(out.gain_margin),
            "stable": bool(out.stable),
            "f_chug_hz": float(out.f_chug_hz),
            "phase_margin_deg": float(out.phase_margin_deg),
            "margin": float(out.gain_margin),
        }
    except Exception:
        return None


def fast_acoustic(D_ch, L_ch, gas, *, n, tau_sens):
    """Native port of acoustic.fast_acoustic. Returns a dict matching Python, or None."""
    if not available():
        return None
    try:
        nat = _nat()
        rc, out = nat.fast_acoustic(D_ch, L_ch, gas.gamma, gas.a_sound, gas.nu_g,
                                    gas.mach_nozzle_entrance, n, tau_sens)
        if rc != 0:
            return None
        lim = {0: "1L", 1: "1T"}.get(out.limiting, None)
        return {
            "alpha_max": float(out.alpha_max), "limiting_mode": lim,
            "stable": bool(out.stable), "f_1L": float(out.f_1L), "f_1T": float(out.f_1T),
        }
    except Exception:
        return None


def chamber_solve(config, cache, P_tank_O, P_tank_F):
    """Return (Pc, diagnostics_struct) via the native chamber solve, or None."""
    if not _can_handle_chamber(config):
        return None
    try:
        nat = _nat()
        if not _ensure_cea(cache):
            if require_native():
                raise RuntimeError("native CEA cache load failed (unsupported/ non-3D grid)")
            return None
        st = build_state(config)
        rc, d = nat.chamber_solve(st, float(P_tank_O), float(P_tank_F))
        if rc != 0 or not d.converged:
            if require_native():
                raise RuntimeError(f"native chamber_solve rc={rc} converged={bool(d.converged)}")
            return None
        return float(d.Pc), d
    except Exception:
        if require_native():
            raise
        return None


def evaluate(config, cache, P_tank_O, P_tank_F, P_ambient=101325.0):
    """Native chamber solve + authoritative Python RPA nozzle + Python stability.

    Returns a dict compatible with the keys engine.optimizer Layer-1 reads from
    runner.evaluate() — or None to fall back to the full Python path (unsupported
    injector type, non-3D CEA cache, or non-converged solve).

    The chamber residual loop runs in C; thrust/Isp come from the SAME
    engine.core.nozzle.calculate_thrust the finalization path uses (RPA delivered
    thrust, F = zeta_n*Cf_vac*Pc*At - Pa*Ae), so the inner loop ranks on the exact
    number finalization reports — no frozen-nozzle bias. The nozzle is cheap (a CEA
    Cf_vac lookup + arithmetic), so keeping it in Python costs ~nothing. Stability
    reuses comprehensive_stability_analysis (native kernels under the hood).
    """
    if not _can_handle_chamber(config):
        return None
    try:
        import ctypes as C
        nat = _nat()
        if not _ensure_cea(cache):
            return None
        st = build_state(config)  # geometry changes per candidate, so rebuild each call
        rc, r = nat.evaluate(C.byref(st), float(P_tank_O), float(P_tank_F), float(P_ambient))
        if rc != 0 or not r.converged:
            return None
        # Full injector diagnostics at the converged Pc — same construction the
        # production Python path feeds to stability (D32, delta_p_feed, Cd, A_geom,
        # momentum_ratio_R, u_O/F, ...), so per-candidate stability is unchanged.
        rci, ir = nat.injector_solve(st, float(P_tank_O), float(P_tank_F), float(r.Pc))
        if rci != 0:
            return None
    except Exception:
        return None

    diagnostics = _result_to_diag(config, ir)
    diagnostics.update({
        "mdot_O": r.mdot_O, "mdot_F": r.mdot_F, "mdot_total": r.mdot_total,
        "Pc": r.Pc, "MR": r.MR,
        "cstar_ideal": r.cstar_ideal, "cstar_actual": r.cstar_actual, "eta_cstar": r.eta_cstar,
        # Stability uses the cooling-adjusted effective Tc (= runner's diagnostics["Tc"]),
        # not the ideal Tc the nozzle expands from.
        "gamma": r.gamma, "R": r.R, "Tc": r.Tc_effective, "SMD": r.SMD,
    })

    try:
        from engine.pipeline.stability.analysis import comprehensive_stability_analysis
        stability_results = comprehensive_stability_analysis(
            config=config, Pc=r.Pc, MR=r.MR, mdot_total=r.mdot_total,
            cstar=r.cstar_actual, gamma=r.gamma, R=r.R, Tc=r.Tc_effective, diagnostics=diagnostics)
    except Exception:
        stability_results = {}

    # Delivered thrust inline (RPA): F = zeta_n * Cf_vac * Pc * At - Pa * Ae. This is
    # the SAME formula as engine.core.nozzle.calculate_thrust, but with a single
    # Cf_vac lookup instead of the full Python nozzle (dict build + mach solve +
    # validation) — keeping the Layer-1 inner loop native-fast. zeta_c (eta_c*) rides
    # in through Pc. Exit-state fields are display-only (from the C result).
    g0 = 9.80665
    zeta_n = float(config.chamber_geometry.nozzle_efficiency)
    try:
        cf_vac = cache.eval_cf_vac(r.MR, r.Pc, r.eps)
    except Exception:
        return None
    At, Ae = r.A_throat, r.A_exit
    F = zeta_n * cf_vac * r.Pc * At - float(P_ambient) * Ae
    if F != F:  # NaN guard
        return None
    Isp = F / (r.mdot_total * g0)
    Cf_actual = F / (r.Pc * At)

    return {
        # Mirrors the runner.evaluate keys Layer-1 consumes (success is inferred
        # from finite F/Pc by the objective, exactly as for runner.evaluate).
        "Pc": r.Pc, "mdot_O": r.mdot_O, "mdot_F": r.mdot_F, "mdot_total": r.mdot_total,
        "MR": r.MR, "F": F, "Isp": Isp, "v_exit": r.v_exit,
        "P_exit": r.P_exit, "P_throat": r.P_throat, "T_exit": r.T_exit, "T_throat": r.T_throat,
        "Tc": r.Tc_effective, "eps": r.eps, "A_throat": r.A_throat, "A_exit": r.A_exit,
        "cstar_actual": r.cstar_actual, "cstar_ideal": r.cstar_ideal, "eta_cstar": r.eta_cstar,
        "gamma": r.gamma, "R": r.R,
        "Cf": Cf_actual, "Cf_actual": Cf_actual, "Cf_ideal": r.Cf_ideal,
        "Cd_O": r.Cd_O, "Cd_F": r.Cd_F, "A_geom_O": r.A_geom_O, "A_geom_F": r.A_geom_F,
        "stability": stability_results, "stability_results": stability_results,
        "diagnostics": diagnostics,
        "P_ambient": float(P_ambient),
        "native_fast_eval": True,
    }
