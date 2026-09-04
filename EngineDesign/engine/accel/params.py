"""Config -> flat scalar state, in pure Python (no C dependency).

WHY THIS EXISTS
    The Numba kernels used to read their inputs out of the C `EdEngineState`
    struct (numba_eval.extract_params called native_injector.build_state), so
    Numba could not run without the C library loaded. That made the C port
    impossible to delete. This module reproduces that reconciliation with no
    ctypes involved.

WHY IT IS A TRANSCRIPTION, NOT A REWRITE
    `native_injector.build_state` encodes decisions that are NOT recoverable by
    reading the config schema -- see the inline notes on smd_model and
    we_corr_max below. Re-deriving "what the config means" from the YAML would
    silently produce different numbers on some configs. So each field here is a
    line-for-line transcription of the corresponding `_fill_*` helper, and
    tests/test_accel_params_match_native_state.py asserts exact equality against
    the real EdEngineState for every committed config while the C port still
    exists to compare against.

The returned object mirrors EdEngineState's attribute paths exactly
(`st.fluid_O.density`, `st.injector.imp_O.d_jet`, ...) so the existing
param-vector mapping reads from either interchangeably.
"""
from __future__ import annotations

import numpy as np
from operator import attrgetter as _attrgetter
from types import SimpleNamespace

# Enum mappings -- mirror native_injector._PHI / _INJ / _EFF_MODEL.
_PHI = {"none": 0, "sqrtP": 1, "logP": 2}
_INJ = {"pintle": 0, "impinging": 1, "coaxial": 2}
_EFF_MODEL = {"constant": 0, "linear": 1, "exponential": 2}


def _ns(**kw):
    return SimpleNamespace(**kw)


def _discharge(c):
    """Mirrors native_injector._fill_discharge."""
    return _ns(
        Cd_inf=float(c.Cd_inf), a_Re=float(c.a_Re), Cd_min=float(c.Cd_min),
        use_geometry_cd=int(bool(c.use_geometry_cd)),
        d_ref_m=float(c.d_ref_m), d_min_m=float(c.d_min_m),
        cd_small_hole_exponent=float(c.cd_small_hole_exponent),
        cd_large_hole_log_gain=float(c.cd_large_hole_log_gain),
        cd_inf_max=float(c.cd_inf_max), cd_inf_min_geom=float(c.cd_inf_min_geom),
        use_pressure_correction=int(bool(c.use_pressure_correction)),
        P_ref=float(c.P_ref), a_P=float(c.a_P),
        use_temperature_correction=int(bool(c.use_temperature_correction)),
        T_ref=float(c.T_ref), a_T=float(c.a_T),
    )


def _feed(c):
    """Mirrors native_injector._fill_feed."""
    return _ns(
        d_inlet=float(getattr(c, "d_inlet", 0.0) or 0.0),
        A_hydraulic=float(getattr(c, "A_hydraulic", 0.0) or 0.0),
        K0=float(c.K0), K1=float(c.K1), phi_type=_PHI[c.phi_type],
    )


def _fluid(f):
    """Mirrors native_injector._fill_fluid.

    Note the `or` defaults: a missing OR zero temperature becomes 0.0, and a
    missing OR zero latent_heat becomes 300e3. Falsy checks, not `is None`.
    """
    return _ns(
        density=float(f.density), viscosity=float(f.viscosity),
        surface_tension=float(f.surface_tension),
        temperature=float(getattr(f, "temperature", 0.0) or 0.0),
        latent_heat=float(getattr(f, "latent_heat", 300e3) or 300e3),
    )


def _comb(eff):
    """Mirrors native_injector._fill_comb."""
    floor = getattr(eff, "tau_Tc_floor_K", None)
    ropt = getattr(eff, "R_opt", None)
    return _ns(
        model=_EFF_MODEL.get(eff.model, 2),
        C=float(eff.C), K=float(eff.K),
        cooling_efficiency_floor=float(eff.cooling_efficiency_floor),
        use_cooling_coupling=int(bool(eff.use_cooling_coupling)),
        tau_ref=float(eff.tau_ref), tau_ref_P=float(eff.tau_ref_P),
        tau_ref_T=float(eff.tau_ref_T), n_pressure=float(eff.n_pressure),
        T_star_fuel_cap_K=float(getattr(eff, "T_star_fuel_cap_K", 1000.0)),
        has_tau_Tc_floor=int(floor is not None),
        tau_Tc_floor=float(floor or 0.0),
        # Rupe momentum-ratio mixing; R_opt<=0 => derive from impingement angles.
        Em_peak=float(getattr(eff, "Em_peak", 0.96)),
        mixing_sigma=float(getattr(eff, "mixing_sigma", 1.5)),
        R_opt=float(ropt) if ropt is not None else 0.0,
    )


def _cooling(cfg):
    """Mirrors native_injector._fill_cooling.

    The C struct is zero-initialised, so fields guarded by `if rg is not None` /
    `if ab is not None` stay 0.0 when that config block is absent. The defaults
    below reproduce that -- do not "improve" them into schema defaults.
    """
    rg, ab = cfg.regen_cooling, cfg.ablative_cooling
    fc = getattr(cfg, "film_cooling", None)
    eff = cfg.combustion.efficiency
    c = _ns(
        regen_enabled=int(bool(rg and rg.enabled)),
        film_enabled=int(bool(fc and fc.enabled)),
        ablative_enabled=int(bool(ab and ab.enabled)),
        graphite_enabled=int(bool(getattr(cfg, "graphite_insert", None)
                                  and cfg.graphite_insert.enabled)),
        use_cooling_coupling=int(bool(eff.use_cooling_coupling)),
        cooling_efficiency_floor=float(eff.cooling_efficiency_floor),
        # zero-init defaults for the two optional blocks
        hot_gas_viscosity=0.0, hot_gas_thermal_conductivity=0.0,
        hot_gas_prandtl=0.0, gas_turbulence_intensity=0.0, recovery_factor=0.0,
        radiation_emissivity_hot=0.0, radiation_view_factor=0.0,
        regen_chamber_inner_diameter=0.0,
        ablative_coverage_fraction=0.0, ablative_surface_temperature_limit=0.0,
        ablative_material_density=0.0, ablative_heat_of_ablation=0.0,
        ablative_specific_heat=0.0, ablative_pyrolysis_temperature=0.0,
        ablative_use_physics_based_blowing=0, ablative_blowing_efficiency=0.0,
        ablative_blowing_coefficient=0.0, ablative_blowing_min_reduction_factor=0.0,
        ablative_turbulence_reference_intensity=0.0, ablative_turbulence_sensitivity=0.0,
        ablative_turbulence_exponent=0.0, ablative_turbulence_max_multiplier=0.0,
        ablative_surface_emissivity=0.0, ablative_ambient_temperature=0.0,
        ablative_radiative_sink_minimum_threshold=0.0,
        ablative_radiative_sink_fallback_temperature=0.0,
    )
    if rg is not None:
        c.hot_gas_viscosity = float(rg.hot_gas_viscosity)
        c.hot_gas_thermal_conductivity = float(rg.hot_gas_thermal_conductivity)
        c.hot_gas_prandtl = float(rg.hot_gas_prandtl)
        c.gas_turbulence_intensity = float(rg.gas_turbulence_intensity)
        c.recovery_factor = float(rg.recovery_factor) if rg.recovery_factor is not None else 0.94
        c.radiation_emissivity_hot = float(rg.radiation_emissivity_hot)
        c.radiation_view_factor = float(rg.radiation_view_factor)
        c.regen_chamber_inner_diameter = float(rg.chamber_inner_diameter or 0.0)
    if ab is not None:
        c.ablative_coverage_fraction = float(ab.coverage_fraction)
        c.ablative_surface_temperature_limit = float(ab.surface_temperature_limit)
        c.ablative_material_density = float(ab.material_density)
        c.ablative_heat_of_ablation = float(ab.heat_of_ablation)
        c.ablative_specific_heat = float(ab.specific_heat)
        c.ablative_pyrolysis_temperature = float(ab.pyrolysis_temperature)
        c.ablative_use_physics_based_blowing = int(bool(ab.use_physics_based_blowing))
        c.ablative_blowing_efficiency = float(ab.blowing_efficiency)
        c.ablative_blowing_coefficient = float(ab.blowing_coefficient)
        c.ablative_blowing_min_reduction_factor = float(ab.blowing_min_reduction_factor)
        c.ablative_turbulence_reference_intensity = float(ab.turbulence_reference_intensity)
        c.ablative_turbulence_sensitivity = float(ab.turbulence_sensitivity)
        c.ablative_turbulence_exponent = float(ab.turbulence_exponent)
        c.ablative_turbulence_max_multiplier = float(ab.turbulence_max_multiplier)
        c.ablative_surface_emissivity = float(ab.surface_emissivity)
        c.ablative_ambient_temperature = float(ab.ambient_temperature)
        c.ablative_radiative_sink_minimum_threshold = float(ab.radiative_sink_minimum_threshold)
        c.ablative_radiative_sink_fallback_temperature = float(ab.radiative_sink_fallback_temperature)
    return c


def _geom(cg):
    """Mirrors native_injector._fill_geom. `cg` must come from ensure_chamber_geometry."""
    return _ns(
        A_throat=float(cg.A_throat), A_exit=float(cg.A_exit), volume=float(cg.volume),
        Lstar=float(cg.Lstar) if cg.Lstar else 0.0,
        length=float(cg.length),
        length_cylindrical=float(cg.length_cylindrical or 0.0),
        length_contraction=float(cg.length_contraction or 0.0),
        chamber_diameter=float(cg.chamber_diameter or 0.0),
        exit_diameter=float(cg.exit_diameter or 0.0),
        expansion_ratio=float(cg.expansion_ratio),
        nozzle_efficiency=float(cg.nozzle_efficiency),
        Cf=float(cg.Cf or 0.0),
        design_pressure=float(cg.design_pressure or 0.0),
    )


def _imp(b):
    """Mirrors native_injector._fill_imp."""
    return _ns(
        n_elements=int(b.n_elements), d_jet=float(b.d_jet),
        impingement_angle=float(b.impingement_angle),
        spacing=float(getattr(b, "spacing", 0.0) or 0.0),
    )


def build_state(config):
    """Pure-Python equivalent of native_injector.build_state.

    Returns a namespace with EdEngineState's attribute paths. Raises the same way
    build_state does on a config it cannot map (e.g. a pintle config, whose
    injector geometry has no .oxidizer/.fuel impinging branches).
    """
    from engine.pipeline.config_schemas import ensure_chamber_geometry

    g = config.injector.geometry
    sp = config.spray

    spray = _ns(
        # Impinging atomization is ALWAYS Ingebo (see impinging.py); a stale
        # `lefebvre` in YAML is deliberately ignored. Reading spray.smd.model
        # here instead would change results on configs that carry the stale key.
        smd_model=1,
        smd_C=float(sp.smd.C), smd_m=float(sp.smd.m), smd_p=float(sp.smd.p),
        smd_C_ingebo=float(sp.smd.C_ingebo),
        # Falsy check, not `is None`: we_corr_max of 0.0 and null both -> 0.0.
        smd_we_corr_max=float(getattr(sp.smd, "we_corr_max", None))
        if getattr(sp.smd, "we_corr_max", None) else 0.0,
        chamber_gas_R=float(sp.smd.chamber_gas_R),
        chamber_gas_T=float(sp.smd.chamber_gas_T),
        spray_angle_model=0 if sp.spray_angle.model == "J" else 1,
        spray_angle_k=float(sp.spray_angle.k), spray_angle_n=float(sp.spray_angle.n),
        we_min=float(sp.weber.get("We_min", 15.0)),
        evap_K=float(sp.evaporation.K),
        evap_x_star_limit=float(sp.evaporation.x_star_limit),
        evap_use_constraint=int(bool(sp.evaporation.use_constraint)),
    )

    solver = _ns(
        closure_max_iterations=int(config.solver.closure.max_iterations),
        closure_Cd_reduction_factor=float(config.solver.closure.Cd_reduction_factor),
        Pc_min_bound=float(config.solver.Pc_bounds[0]),
        Pc_max_bound=float(config.solver.Pc_bounds[1]),
        tolerance=float(config.solver.tolerance),
        max_iterations=int(config.solver.max_iterations),
    )

    return _ns(
        injector=_ns(type=_INJ[config.injector.type],
                     imp_O=_imp(g.oxidizer), imp_F=_imp(g.fuel)),
        discharge_O=_discharge(config.discharge["oxidizer"]),
        discharge_F=_discharge(config.discharge["fuel"]),
        feed_O=_feed(config.feed_system["oxidizer"]),
        feed_F=_feed(config.feed_system["fuel"]),
        fluid_O=_fluid(config.fluids["oxidizer"]),
        fluid_F=_fluid(config.fluids["fuel"]),
        spray=spray,
        solver=solver,
        comb=_comb(config.combustion.efficiency),
        cooling=_cooling(config),
        geom=_geom(ensure_chamber_geometry(config)),
    )


# ---------------------------------------------------------------------------
# Parameter-vector layout
#
# The kernels take one flat float64 array rather than a struct, so every scalar
# needs a stable index. _NAMES is that layout and the single source of truth for
# it; kernels.py pulls these names into its module globals so @njit code can use
# them as compile-time constants (P[G_AT] and friends).
#
# APPEND ONLY. Inserting a name shifts every index after it, which silently
# invalidates the cached .nbc artifacts compiled against the old layout.
# ---------------------------------------------------------------------------
# ---- parameter vector layout (mirrors the fields the C residual reads) -------
_NAMES = [
    # fluids
    "RHO_O", "MU_O", "SIG_O", "T_O",
    "RHO_F", "MU_F", "SIG_F", "T_F", "LAT_F",
    # injector geom
    "DJO", "DJF", "NO", "NF", "ANG_O", "ANG_F",
    # discharge O (16)
    "DO_CDINF", "DO_ARE", "DO_CDMIN", "DO_GEOM", "DO_DREF", "DO_DMIN", "DO_EXPS",
    "DO_LOGG", "DO_CDMAX", "DO_CDFLOOR", "DO_UPC", "DO_PREF", "DO_AP", "DO_UTC", "DO_TREF", "DO_AT",
    # discharge F (16)
    "DF_CDINF", "DF_ARE", "DF_CDMIN", "DF_GEOM", "DF_DREF", "DF_DMIN", "DF_EXPS",
    "DF_LOGG", "DF_CDMAX", "DF_CDFLOOR", "DF_UPC", "DF_PREF", "DF_AP", "DF_UTC", "DF_TREF", "DF_AT",
    # feed O / F
    "FO_DIN", "FO_AH", "FO_K0", "FO_K1", "FO_PHI",
    "FF_DIN", "FF_AH", "FF_K0", "FF_K1", "FF_PHI",
    # spray
    "SP_SMDMODEL", "SP_SMDC", "SP_SMDM", "SP_SMDP", "SP_SMDCING", "SP_SMDWECORR",
    "SP_GASR", "SP_GAST", "SP_ANGMODEL", "SP_ANGK", "SP_ANGN", "SP_WEMIN",
    "SP_EVAPK", "SP_EVAPXLIM", "SP_EVAPUSE",
    # solver
    "SV_CLMAX", "SV_CLCDRED", "SV_PCMIN", "SV_PCMAX", "SV_TOL", "SV_MAXIT",
    # geom
    "G_EPS", "G_AT", "G_AE", "G_VOL", "G_LSTAR", "G_DCHAM", "G_NOZZEFF",
    # combustion
    "C_MODEL", "C_C", "C_TAUREF", "C_TAUREFP", "C_TAUREFT", "C_NPRESS", "C_TSTARCAP",
    "C_HASFLOOR", "C_TAUFLOOR", "C_EMPEAK", "C_SIGMA", "C_ROPT",
    # chamber lengths (ablative wetted area only)
    "G_LEN", "G_LCYL", "G_LCONTR",
    # cooling gates + hot-gas block (ed_cooling.c)
    "K_ABLEN", "K_FILMEN", "K_REGENEN", "K_USECOUP", "K_EFFFLOOR",
    "K_HGMU", "K_HGK", "K_HGPR", "K_TI", "K_RECOV", "K_EMISHOT", "K_VIEWF", "K_DREGEN",
    # ablative material / blowing / turbulence / radiative sink
    "AB_COV", "AB_TSURF", "AB_TPYRO", "AB_HABL", "AB_CP", "AB_USEPHYS",
    "AB_BLOWEFF", "AB_BLOWC", "AB_BLOWMIN",
    "AB_TIREF", "AB_TISENS", "AB_TIEXP", "AB_TIMAX",
    "AB_EMIS", "AB_TAMB", "AB_SINKMIN", "AB_SINKFB",
]
_IDX = {n: i for i, n in enumerate(_NAMES)}
globals().update(_IDX)                      # module-level int constants for njit
NP = len(_NAMES)


def _assert_supported(st):
    """Guard the assumptions that let this port skip cooling / use the impinging path."""
    assert int(st.injector.type) == 1, "not impinging"
    # Ablative IS ported (see _cooling_evaluate). Film/regen are not -- C refuses
    # them too (ed_cooling.c:147), so they stay a Python fallback.
    assert int(getattr(st.cooling, "film_enabled")) == 0 and int(getattr(st.cooling, "regen_enabled")) == 0
    # No graphite gate, deliberately: C does not check it either (ed_cooling.c
    # refuses only film/regen at :147), because graphite never enters the chamber
    # residual -- it lives in the burn/recession path (runner.py), and
    # chamber_solver.py references it zero times. Gating on it here would reject
    # configs/canonical/impinging.yaml, which C handles fine.


def extract_params(config):
    """Flatten the config scalars this port needs into a float64 vec.

    Delegates the field mapping to _params_from_state so there is ONE table of
    field names; the two used to carry independent copies of the whole mapping,
    which would drift the moment a field was added on one side only.
    """
    st = build_state(config)          # pure Python -- no C library required
    _assert_supported(st)
    return _params_from_state(st)



# ---------------------------------------------------------------------------
# state -> param vector
#
# The (index, attribute-path) mapping is STATIC, so it is built once at import
# and frozen into attrgetters. It used to be walked per call with str.split(".")
# and f-string key lookups, which cost 96 us per extraction -- 6x the cost of
# building the state itself, and paid on EVERY residual iteration of the fallback
# path via accel.solve. Same field list, same order; only the lookup is hoisted.
# ---------------------------------------------------------------------------
def _build_path_table():
    paths = {
        "RHO_O": "fluid_O.density", "MU_O": "fluid_O.viscosity",
        "SIG_O": "fluid_O.surface_tension", "T_O": "fluid_O.temperature",
        "RHO_F": "fluid_F.density", "MU_F": "fluid_F.viscosity",
        "SIG_F": "fluid_F.surface_tension", "T_F": "fluid_F.temperature",
        "LAT_F": "fluid_F.latent_heat",
        "DJO": "injector.imp_O.d_jet", "DJF": "injector.imp_F.d_jet",
        "NO": "injector.imp_O.n_elements", "NF": "injector.imp_F.n_elements",
        "ANG_O": "injector.imp_O.impingement_angle",
        "ANG_F": "injector.imp_F.impingement_angle",
    }
    for pre, side in (("DO", "discharge_O"), ("DF", "discharge_F")):
        for suf, fld in (("CDINF","Cd_inf"),("ARE","a_Re"),("CDMIN","Cd_min"),("GEOM","use_geometry_cd"),
                         ("DREF","d_ref_m"),("DMIN","d_min_m"),("EXPS","cd_small_hole_exponent"),
                         ("LOGG","cd_large_hole_log_gain"),("CDMAX","cd_inf_max"),("CDFLOOR","cd_inf_min_geom"),
                         ("UPC","use_pressure_correction"),("PREF","P_ref"),("AP","a_P"),
                         ("UTC","use_temperature_correction"),("TREF","T_ref"),("AT","a_T")):
            paths[f"{pre}_{suf}"] = f"{side}.{fld}"
    for pre, side in (("FO", "feed_O"), ("FF", "feed_F")):
        for suf, fld in (("DIN","d_inlet"),("AH","A_hydraulic"),("K0","K0"),("K1","K1"),("PHI","phi_type")):
            paths[f"{pre}_{suf}"] = f"{side}.{fld}"
    for suf, fld in (("SMDMODEL","smd_model"),("SMDC","smd_C"),("SMDM","smd_m"),("SMDP","smd_p"),
                     ("SMDCING","smd_C_ingebo"),("SMDWECORR","smd_we_corr_max"),("GASR","chamber_gas_R"),
                     ("GAST","chamber_gas_T"),("ANGMODEL","spray_angle_model"),("ANGK","spray_angle_k"),
                     ("ANGN","spray_angle_n"),("WEMIN","we_min"),("EVAPK","evap_K"),
                     ("EVAPXLIM","evap_x_star_limit"),("EVAPUSE","evap_use_constraint")):
        paths[f"SP_{suf}"] = f"spray.{fld}"
    for suf, fld in (("CLMAX","closure_max_iterations"),("CLCDRED","closure_Cd_reduction_factor"),
                     ("PCMIN","Pc_min_bound"),("PCMAX","Pc_max_bound"),("TOL","tolerance"),
                     ("MAXIT","max_iterations")):
        paths[f"SV_{suf}"] = f"solver.{fld}"
    for suf, fld in (("EPS","expansion_ratio"),("AT","A_throat"),("AE","A_exit"),("VOL","volume"),
                     ("LSTAR","Lstar"),("DCHAM","chamber_diameter"),("NOZZEFF","nozzle_efficiency"),
                     ("LEN","length"),("LCYL","length_cylindrical"),("LCONTR","length_contraction")):
        paths[f"G_{suf}"] = f"geom.{fld}"
    for suf, fld in (("MODEL","model"),("C","C"),("TAUREF","tau_ref"),("TAUREFP","tau_ref_P"),
                     ("TAUREFT","tau_ref_T"),("NPRESS","n_pressure"),("TSTARCAP","T_star_fuel_cap_K"),
                     ("HASFLOOR","has_tau_Tc_floor"),("TAUFLOOR","tau_Tc_floor"),("EMPEAK","Em_peak"),
                     ("SIGMA","mixing_sigma"),("ROPT","R_opt")):
        paths[f"C_{suf}"] = f"comb.{fld}"
    for name, fld in (("K_ABLEN","ablative_enabled"),("K_FILMEN","film_enabled"),
                      ("K_REGENEN","regen_enabled"),("K_USECOUP","use_cooling_coupling"),
                      ("K_EFFFLOOR","cooling_efficiency_floor"),("K_HGMU","hot_gas_viscosity"),
                      ("K_HGK","hot_gas_thermal_conductivity"),("K_HGPR","hot_gas_prandtl"),
                      ("K_TI","gas_turbulence_intensity"),("K_RECOV","recovery_factor"),
                      ("K_EMISHOT","radiation_emissivity_hot"),("K_VIEWF","radiation_view_factor"),
                      ("K_DREGEN","regen_chamber_inner_diameter"),
                      ("AB_COV","ablative_coverage_fraction"),
                      ("AB_TSURF","ablative_surface_temperature_limit"),
                      ("AB_TPYRO","ablative_pyrolysis_temperature"),
                      ("AB_HABL","ablative_heat_of_ablation"),("AB_CP","ablative_specific_heat"),
                      ("AB_USEPHYS","ablative_use_physics_based_blowing"),
                      ("AB_BLOWEFF","ablative_blowing_efficiency"),
                      ("AB_BLOWC","ablative_blowing_coefficient"),
                      ("AB_BLOWMIN","ablative_blowing_min_reduction_factor"),
                      ("AB_TIREF","ablative_turbulence_reference_intensity"),
                      ("AB_TISENS","ablative_turbulence_sensitivity"),
                      ("AB_TIEXP","ablative_turbulence_exponent"),
                      ("AB_TIMAX","ablative_turbulence_max_multiplier"),
                      ("AB_EMIS","ablative_surface_emissivity"),
                      ("AB_TAMB","ablative_ambient_temperature"),
                      ("AB_SINKMIN","ablative_radiative_sink_minimum_threshold"),
                      ("AB_SINKFB","ablative_radiative_sink_fallback_temperature")):
        paths[name] = f"cooling.{fld}"
    missing = set(_NAMES) - set(paths)
    assert not missing, f"param(s) with no source path: {sorted(missing)}"
    return paths


_PATHS = _build_path_table()
_GETTERS = tuple((_IDX[n], _attrgetter(_PATHS[n])) for n in _NAMES)


def _params_from_state(st):
    """Flatten a state namespace (or EdEngineState) into the float64 param vector."""
    P = np.zeros(NP)
    for i, get in _GETTERS:
        P[i] = get(st)
    return P
