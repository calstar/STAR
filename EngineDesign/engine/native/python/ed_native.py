"""ctypes bindings for libed_physics.

Loads an arch-matched library (auto-built on demand via autobuild.ensure_lib),
mirrors the POD structs from include/ed_state.h, and binds the implemented C API.
A sizeof self-check (ctypes vs ed_sizeof_*) runs at load so any layout drift fails
loudly instead of silently reading garbage.
"""
from __future__ import annotations

import ctypes as C
import os

ED_OK = 0
ED_ERR_NOT_IMPLEMENTED = -6

_d = C.c_double
_i = C.c_int
_u8 = C.c_uint8


# --- POD struct mirrors of include/ed_state.h (field order MUST match) --------
class EdDischarge(C.Structure):
    _fields_ = [
        ("Cd_inf", _d), ("a_Re", _d), ("Cd_min", _d), ("use_geometry_cd", _u8),
        ("d_ref_m", _d), ("d_min_m", _d), ("cd_small_hole_exponent", _d),
        ("cd_large_hole_log_gain", _d), ("cd_inf_max", _d), ("cd_inf_min_geom", _d),
        ("use_pressure_correction", _u8), ("P_ref", _d), ("a_P", _d),
        ("use_temperature_correction", _u8), ("T_ref", _d), ("a_T", _d),
    ]


class EdFeed(C.Structure):
    _fields_ = [("d_inlet", _d), ("A_hydraulic", _d), ("K0", _d), ("K1", _d), ("phi_type", _i)]


class EdFluid(C.Structure):
    _fields_ = [(n, _d) for n in (
        "density", "viscosity", "surface_tension", "specific_heat",
        "thermal_conductivity", "temperature", "bulk_modulus",
        "boiling_point", "latent_heat", "molecular_weight", "Pc_ref")]


class EdImpingingBranch(C.Structure):
    _fields_ = [("n_elements", _i), ("d_jet", _d), ("impingement_angle", _d), ("spacing", _d)]


class EdInjector(C.Structure):
    _fields_ = [
        ("type", _i), ("imp_O", EdImpingingBranch), ("imp_F", EdImpingingBranch),
        ("pintle_d_tip", _d), ("pintle_annular_gap", _d), ("pintle_n_orifices", _i),
        ("pintle_d_orifice", _d), ("coax_d_core", _d), ("coax_d_port", _d),
        ("coax_annulus_gap", _d),
    ]


class EdCombustionEff(C.Structure):
    _fields_ = [
        ("model", _i),
        ("efficiency", _d), ("C", _d), ("K", _d), ("mixture_efficiency_floor", _d),
        ("cooling_efficiency_floor", _d), ("turbulence_efficiency_floor", _d),
        ("use_advanced_model", _u8), ("use_finite_rate_chemistry", _u8),
        ("use_shifting_equilibrium", _u8), ("use_cooling_coupling", _u8),
        ("use_turbulence_coupling", _u8), ("Pc_gate", _d), ("tau_ref", _d),
        ("tau_ref_P", _d), ("tau_ref_T", _d), ("n_pressure", _d),
        ("T_star_fuel_cap_K", _d), ("A0_hydrocarbon", _d), ("Ea_hydrocarbon", _d),
        ("n_pre_hydrocarbon", _d),
        ("has_tau_Tc_floor", _u8), ("tau_Tc_floor", _d),
        # Rupe momentum-ratio mixing model
        ("Em_peak", _d), ("mixing_sigma", _d), ("R_opt", _d),
    ]


class EdCooling(C.Structure):
    _fields_ = [
        ("regen_enabled", _u8), ("film_enabled", _u8), ("ablative_enabled", _u8),
        ("graphite_enabled", _u8), ("use_cooling_coupling", _u8),
        ("hot_gas_viscosity", _d), ("hot_gas_thermal_conductivity", _d),
        ("hot_gas_prandtl", _d), ("gas_turbulence_intensity", _d),
        ("recovery_factor", _d), ("radiation_emissivity_hot", _d),
        ("radiation_view_factor", _d), ("regen_chamber_inner_diameter", _d),
        ("ablative_coverage_fraction", _d), ("ablative_surface_temperature_limit", _d),
        ("ablative_material_density", _d), ("ablative_heat_of_ablation", _d),
        ("ablative_specific_heat", _d), ("ablative_pyrolysis_temperature", _d),
        ("ablative_use_physics_based_blowing", _u8),
        ("ablative_blowing_efficiency", _d), ("ablative_blowing_coefficient", _d),
        ("ablative_blowing_min_reduction_factor", _d),
        ("ablative_turbulence_reference_intensity", _d),
        ("ablative_turbulence_sensitivity", _d), ("ablative_turbulence_exponent", _d),
        ("ablative_turbulence_max_multiplier", _d), ("ablative_surface_emissivity", _d),
        ("ablative_ambient_temperature", _d),
        ("ablative_radiative_sink_minimum_threshold", _d),
        ("ablative_radiative_sink_fallback_temperature", _d),
        ("cooling_efficiency_floor", _d),
    ]


class EdSpray(C.Structure):
    _fields_ = [
        ("smd_model", _i), ("smd_C", _d), ("smd_m", _d), ("smd_p", _d),
        ("smd_C_ingebo", _d), ("smd_we_corr_max", _d), ("chamber_gas_R", _d),
        ("chamber_gas_T", _d), ("spray_angle_model", _i), ("spray_angle_k", _d),
        ("spray_angle_n", _d), ("we_min", _d), ("evap_K", _d),
        ("evap_x_star_limit", _d), ("evap_use_constraint", _u8),
    ]


class EdGeometry(C.Structure):
    _fields_ = [(n, _d) for n in (
        "A_throat", "A_exit", "volume", "Lstar", "length", "length_cylindrical",
        "length_contraction", "chamber_diameter", "exit_diameter", "expansion_ratio",
        "nozzle_efficiency", "Cf", "design_pressure")]


class EdSolver(C.Structure):
    _fields_ = [
        ("Pc_min_bound", _d), ("Pc_max_bound", _d), ("tolerance", _d),
        ("max_iterations", _i), ("closure_max_iterations", _i),
        ("closure_Cd_reduction_factor", _d),
    ]


class EdEngineState(C.Structure):
    _fields_ = [
        ("injector", EdInjector), ("feed_O", EdFeed), ("feed_F", EdFeed),
        ("discharge_O", EdDischarge), ("discharge_F", EdDischarge),
        ("fluid_O", EdFluid), ("fluid_F", EdFluid), ("comb", EdCombustionEff),
        ("cooling", EdCooling), ("spray", EdSpray), ("geom", EdGeometry),
        ("solver", EdSolver), ("P_ambient", _d),
    ]


class EdInjectorResult(C.Structure):
    _doubles = (
        "mdot_O", "mdot_F", "Cd_O", "Cd_F", "A_geom_O", "A_geom_F", "A_eff_O",
        "A_eff_F", "u_O", "u_F", "v_O_bulk", "v_F_bulk", "momentum_ratio_R",
        "J", "TMR", "theta", "We_O", "We_F", "D32_O", "D32_F", "x_star", "u_rel",
        "P_injector_O", "P_injector_F", "delta_p_injector_O", "delta_p_injector_F",
        "delta_p_feed_O", "delta_p_feed_F", "turbulence_intensity_mix", "MR",
    )
    _fields_ = [(n, _d) for n in _doubles] + [
        ("constraints_satisfied", _i), ("iterations", _i),
        ("feed_orifice_coupling_iters", _i)]


class EdCeaResult(C.Structure):
    _fields_ = [(n, _d) for n in ("cstar_ideal", "Cf_ideal", "Tc", "gamma", "R", "M")]


class EdChugStream(C.Structure):
    _fields_ = [
        ("G_inj", _d), ("inertance", _d), ("resistance", _d), ("tau_conv", _d),
        ("reg_Z_hf", _d), ("reg_corner_hz", _d), ("reg_enabled", _i),
    ]


class EdChugResult(C.Structure):
    _fields_ = [("gain_margin", _d), ("f_chug_hz", _d),
                ("phase_margin_deg", _d), ("stable", _i)]


class EdAcousticResult(C.Structure):
    _fields_ = [("alpha_max", _d), ("f_1L", _d), ("f_1T", _d),
                ("limiting", _i), ("stable", _i)]


class EdChamberDiagnostics(C.Structure):
    _doubles = (
        "Pc", "mdot_O", "mdot_F", "mdot_total", "MR", "cstar_ideal", "cstar_actual",
        "eta_cstar", "cooling_efficiency", "Tc", "Tc_ideal", "gamma", "R", "M",
        "momentum_ratio_R", "delta_P_injector_O", "delta_P_injector_F",
        "A_geom_O", "A_geom_F", "SMD", "Cd_O", "Cd_F", "u_O", "u_F",
    )
    _fields_ = [(n, _d) for n in _doubles] + [
        ("converged", _i), ("residual_iters", _i)]


class EdEvaluateResult(C.Structure):
    _doubles = (
        "Pc", "mdot_O", "mdot_F", "mdot_total", "MR", "F", "Isp", "v_exit",
        "P_exit", "P_throat", "T_exit", "T_throat", "Tc", "gamma", "R",
        "cstar_actual", "cstar_ideal", "eta_cstar", "Cf_actual", "Cf_ideal",
        "eps", "A_throat", "A_exit", "Cd_O", "Cd_F", "momentum_ratio_R",
        "delta_P_injector_O", "delta_P_injector_F", "A_geom_O", "A_geom_F",
        "SMD", "cooling_efficiency", "Tc_effective",
    )
    _fields_ = [(n, _d) for n in _doubles] + [("converged", _i)]


class EdNative:
    def __init__(self, lib_path: str | None = None):
        if lib_path is None:
            from . import autobuild  # local import to keep ctypes import side-effect-free
            lib_path = os.environ.get("ED_NATIVE_LIB") or autobuild.ensure_lib()
        self.lib = C.CDLL(lib_path)
        self.lib_path = lib_path
        L = self.lib

        for fn in ("ed_sizeof_cea_tables", "ed_sizeof_engine_state",
                   "ed_sizeof_workspace", "ed_sizeof_evaluate_result"):
            getattr(L, fn).restype = C.c_size_t

        # Layout drift guard: ctypes mirror must match the C struct byte-for-byte.
        c_size = L.ed_sizeof_engine_state()
        if C.sizeof(EdEngineState) != c_size:
            raise RuntimeError(
                f"EdEngineState layout mismatch: ctypes={C.sizeof(EdEngineState)} "
                f"C={c_size}. Update ed_native.py struct mirror to match ed_state.h.")

        L.ed_cea_load.argtypes = [C.c_char_p, C.c_void_p]; L.ed_cea_load.restype = _i
        L.ed_cea_free.argtypes = [C.c_void_p]
        L.ed_cea_eval.argtypes = [C.c_void_p, _d, _d, _d, _d, C.POINTER(EdCeaResult)]
        L.ed_cea_eval.restype = _i

        L.ed_delta_p_feed.argtypes = [_d, _d, C.POINTER(EdFeed), _d]; L.ed_delta_p_feed.restype = _d
        L.ed_cd_inf_from_orifice_diameter.argtypes = [_d, C.POINTER(EdDischarge)]
        L.ed_cd_inf_from_orifice_diameter.restype = _d
        L.ed_cd_from_re.argtypes = [_d, C.POINTER(EdDischarge), _d, _d, _d]; L.ed_cd_from_re.restype = _d

        L.ed_injector_solve.argtypes = [C.POINTER(EdEngineState), _d, _d, _d,
                                        C.POINTER(EdInjectorResult)]
        L.ed_injector_solve.restype = _i

        L.ed_evaluate.argtypes = [C.c_void_p, C.c_void_p, _d, _d, _d, _d, C.c_void_p,
                                  C.POINTER(EdEvaluateResult)]
        L.ed_evaluate.restype = _i

        L.ed_chamber_solve.argtypes = [C.POINTER(EdEngineState), C.c_void_p, _d, _d, _d,
                                       C.c_void_p, C.POINTER(EdChamberDiagnostics)]
        L.ed_chamber_solve.restype = _i

        L.ed_chug_margin_fast.argtypes = [C.POINTER(EdChugStream), _i, _d, _d, _d, _d,
                                          C.POINTER(EdChugResult)]
        L.ed_chug_margin_fast.restype = _i

        L.ed_fast_acoustic.argtypes = [_d, _d, _d, _d, _d, _d, _d, _d,
                                       C.POINTER(EdAcousticResult)]
        L.ed_fast_acoustic.restype = _i

        self._tables_buf = C.create_string_buffer(L.ed_sizeof_cea_tables())
        self._ws_buf = C.create_string_buffer(L.ed_sizeof_workspace())

    # --- chug fast-tier --------------------------------------------------
    def chug_margin_fast(self, streams, K_c, theta_c, f_lo=2.0, f_hi=2000.0):
        n = len(streams)
        arr = (EdChugStream * n)(*streams)
        out = EdChugResult()
        rc = self.lib.ed_chug_margin_fast(arr, n, float(K_c), float(theta_c),
                                          float(f_lo), float(f_hi), C.byref(out))
        return rc, out

    def fast_acoustic(self, D_ch, L_ch, gamma, a_sound, nu_g, mach_ne, n, tau_sens):
        out = EdAcousticResult()
        rc = self.lib.ed_fast_acoustic(float(D_ch), float(L_ch), float(gamma),
                                       float(a_sound), float(nu_g), float(mach_ne),
                                       float(n), float(tau_sens), C.byref(out))
        return rc, out

    # --- chamber solve ---------------------------------------------------
    def chamber_solve(self, state, P_O, P_F, Pc_guess=0.0):
        out = EdChamberDiagnostics()
        rc = self.lib.ed_chamber_solve(C.byref(state), self._tables_buf,
                                       float(P_O), float(P_F), float(Pc_guess),
                                       self._ws_buf, C.byref(out))
        return rc, out

    # --- CEA -------------------------------------------------------------
    def cea_load(self, bin_path: str) -> None:
        if self.lib.ed_cea_load(bin_path.encode(), self._tables_buf) != ED_OK:
            raise RuntimeError("ed_cea_load failed")

    def cea_eval(self, MR: float, Pc: float, eps: float, Pa: float = 101325.0) -> EdCeaResult:
        out = EdCeaResult()
        if self.lib.ed_cea_eval(self._tables_buf, MR, Pc, Pa, eps, C.byref(out)) != ED_OK:
            raise RuntimeError("ed_cea_eval failed")
        return out

    def cea_free(self) -> None:
        self.lib.ed_cea_free(self._tables_buf)

    # --- injector --------------------------------------------------------
    def injector_solve(self, state: EdEngineState, P_O: float, P_F: float, Pc: float):
        out = EdInjectorResult()
        rc = self.lib.ed_injector_solve(C.byref(state), P_O, P_F, Pc, C.byref(out))
        return rc, out

    def evaluate(self, state_buf, P_O: float, P_F: float, P_amb: float = 101325.0):
        out = EdEvaluateResult()
        rc = self.lib.ed_evaluate(state_buf, self._tables_buf, P_O, P_F, P_amb,
                                  0.0, self._ws_buf, C.byref(out))
        return rc, out


_INSTANCE: EdNative | None = None


def load(lib_path: str | None = None) -> EdNative:
    """Process-wide singleton (auto-builds + loads on first call)."""
    global _INSTANCE
    if _INSTANCE is None or lib_path is not None:
        _INSTANCE = EdNative(lib_path)
    return _INSTANCE
