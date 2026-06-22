/* ed_state.h - Flat POD snapshot of one engine configuration.
 *
 * EdEngineState is a frozen, allocation-free snapshot of everything needed to
 * evaluate a single design point. It is produced offline (state_from_yaml /
 * ed_state_builder.py) from a PintleEngineConfig and never references Python.
 *
 * Hot Layer-1 fields (throat area, L*, injector dims, tank pressures) are grouped
 * so they can be patched in O(1) with ed_state_patch() without re-parsing YAML.
 *
 * NOTE (Stage 1): Field coverage is complete enough for the foundational kernels
 * (CEA, root-find, feed-loss, discharge, geometry). Fields consumed only by the
 * not-yet-ported combustion/cooling/stability physics are present so that the
 * struct layout is stable for future stages; see engine/native/README.md.
 */
#ifndef ED_STATE_H
#define ED_STATE_H

#include "ed_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Mirrors DischargeConfig (engine/pipeline/config_schemas + discharge.py). */
typedef struct {
    double Cd_inf;
    double a_Re;
    double Cd_min;
    uint8_t use_geometry_cd;
    double d_ref_m;
    double d_min_m;
    double cd_small_hole_exponent;
    double cd_large_hole_log_gain;
    double cd_inf_max;
    double cd_inf_min_geom;
    uint8_t use_pressure_correction;
    double P_ref;
    double a_P;
    uint8_t use_temperature_correction;
    double T_ref;
    double a_T;
} EdDischarge;

/* Mirrors FeedSystemConfig used by feed_loss.delta_p_feed. */
typedef struct {
    double d_inlet;     /* <=0 => use A_hydraulic */
    double A_hydraulic; /* m^2 */
    double K0;
    double K1;
    ed_phi_type_t phi_type;
} EdFeed;

/* Bulk fluid properties for one propellant branch (engine.fluids[...]). */
typedef struct {
    double density;             /* kg/m^3 */
    double viscosity;           /* Pa.s */
    double surface_tension;     /* N/m */
    double specific_heat;       /* J/(kg.K) */
    double thermal_conductivity;/* W/(m.K) */
    double temperature;         /* K */
    double bulk_modulus;        /* Pa (feed-system acoustics) */
    /* Fuel-only evaporation props (see _get_fuel_props); 0 if unused. */
    double boiling_point;       /* K */
    double latent_heat;         /* J/kg */
    double molecular_weight;    /* g/mol */
    double Pc_ref;              /* Pa */
} EdFluid;

/* Impinging-doublet geometry (per branch). */
typedef struct {
    int    n_elements;
    double d_jet;              /* m */
    double impingement_angle;  /* deg */
    double spacing;            /* m */
} EdImpingingBranch;

/* Injector geometry, tagged union over injector_type. Only the active arm is
 * meaningful. (Pintle/coaxial fields are placeholders for later stages.) */
typedef struct {
    ed_injector_type_t type;
    /* impinging */
    EdImpingingBranch imp_O;
    EdImpingingBranch imp_F;
    /* pintle (placeholder) */
    double pintle_d_tip;
    double pintle_annular_gap;
    int    pintle_n_orifices;
    double pintle_d_orifice;
    /* coaxial (placeholder) */
    double coax_d_core;
    double coax_d_port;
    double coax_annulus_gap;
} EdInjector;

typedef enum { ED_EFF_CONSTANT = 0, ED_EFF_LINEAR = 1, ED_EFF_EXPONENTIAL = 2 } ed_eff_model_t;

/* Combustion efficiency config (CombustionEfficiencyConfig). */
typedef struct {
    ed_eff_model_t model;       /* constant | linear | exponential */
    double efficiency;          /* combustion.efficiency scalar baseline */
    double C;                   /* exponential/linear/constant model coeff */
    double K;
    double mixture_efficiency_floor;
    double cooling_efficiency_floor;
    double turbulence_efficiency_floor;
    uint8_t use_advanced_model;
    uint8_t use_finite_rate_chemistry;
    uint8_t use_shifting_equilibrium;
    uint8_t use_cooling_coupling;
    uint8_t use_turbulence_coupling;
    double Pc_gate;
    double tau_ref;
    double tau_ref_P;
    double tau_ref_T;
    double n_pressure;
    double T_star_fuel_cap_K;
    double A0_hydrocarbon, Ea_hydrocarbon, n_pre_hydrocarbon;
    uint8_t has_tau_Tc_floor;   /* tau_Tc_floor_K present? */
    double  tau_Tc_floor;       /* K */
} EdCombustionEff;

/* Cooling enable flags + params the chamber residual reads via
 * _evaluate_cooling_models (the ablative path for the canonical config). */
typedef struct {
    uint8_t regen_enabled;
    uint8_t film_enabled;
    uint8_t ablative_enabled;
    uint8_t graphite_enabled;
    uint8_t use_cooling_coupling;

    /* hot-gas / regen props used by estimate_hot_wall_heat_flux + gas prep */
    double  hot_gas_viscosity;
    double  hot_gas_thermal_conductivity;
    double  hot_gas_prandtl;
    double  gas_turbulence_intensity;
    double  recovery_factor;            /* resolved (null -> 0.94) */
    double  radiation_emissivity_hot;
    double  radiation_view_factor;
    double  regen_chamber_inner_diameter;

    /* ablative response (compute_ablative_response) */
    double  ablative_coverage_fraction;
    double  ablative_surface_temperature_limit;
    double  ablative_material_density;
    double  ablative_heat_of_ablation;
    double  ablative_specific_heat;
    double  ablative_pyrolysis_temperature;
    uint8_t ablative_use_physics_based_blowing;
    double  ablative_blowing_efficiency;
    double  ablative_blowing_coefficient;
    double  ablative_blowing_min_reduction_factor;
    double  ablative_turbulence_reference_intensity;
    double  ablative_turbulence_sensitivity;
    double  ablative_turbulence_exponent;
    double  ablative_turbulence_max_multiplier;
    double  ablative_surface_emissivity;
    double  ablative_ambient_temperature;
    double  ablative_radiative_sink_minimum_threshold;
    double  ablative_radiative_sink_fallback_temperature;

    double  cooling_efficiency_floor;
} EdCooling;

/* Spray / SMD config (spray.* block). */
typedef enum { ED_SMD_LEFEBVRE = 0, ED_SMD_INGEBO = 1 } ed_smd_model_t;
typedef enum { ED_SPRAYANG_J = 0, ED_SPRAYANG_TMR = 1 } ed_spray_angle_model_t;

typedef struct {
    ed_smd_model_t smd_model;
    double smd_C;             /* lefebvre C */
    double smd_m;             /* lefebvre Weber exponent */
    double smd_p;             /* lefebvre Ohnesorge exponent */
    double smd_C_ingebo;      /* ingebo prefactor */
    double smd_we_corr_max;   /* lefebvre We cap; <=0 => none */
    double chamber_gas_R;     /* J/(kg.K) for rho_gas */
    double chamber_gas_T;     /* K */
    ed_spray_angle_model_t spray_angle_model;
    double spray_angle_k;
    double spray_angle_n;
    double we_min;
    double evap_K;            /* tau_evap = K * D32^2 */
    double evap_x_star_limit; /* m */
    uint8_t evap_use_constraint;
} EdSpray;

/* Chamber + nozzle geometry (ChamberGeometry). These are the primary hot fields
 * mutated by Layer-1 optimization. */
typedef struct {
    double A_throat;          /* m^2 */
    double A_exit;            /* m^2 */
    double volume;            /* m^3 */
    double Lstar;             /* m (override; <=0 => V/At) */
    double length;            /* m */
    double length_cylindrical;
    double length_contraction;
    double chamber_diameter;  /* m */
    double exit_diameter;     /* m */
    double expansion_ratio;
    double nozzle_efficiency;
    double Cf;
    double design_pressure;   /* Pa */
} EdGeometry;

/* Brent solver settings (SolverConfig) + injector closure loop. */
typedef struct {
    double Pc_min_bound;      /* Pa */
    double Pc_max_bound;      /* Pa */
    double tolerance;         /* xtol */
    int    max_iterations;
    int    closure_max_iterations;     /* solver.closure.max_iterations */
    double closure_Cd_reduction_factor;/* solver.closure.Cd_reduction_factor */
} EdSolver;

/* Top-level frozen snapshot. POD; safe to memcpy and patch. */
typedef struct {
    EdInjector       injector;
    EdFeed           feed_O;
    EdFeed           feed_F;
    EdDischarge      discharge_O;
    EdDischarge      discharge_F;
    EdFluid          fluid_O;
    EdFluid          fluid_F;
    EdCombustionEff  comb;
    EdCooling        cooling;
    EdSpray          spray;
    EdGeometry       geom;
    EdSolver         solver;
    double           P_ambient;   /* Pa (from elevation), may be overridden per-call */
} EdEngineState;

/* O(1) patch of the hottest Layer-1 fields. Pass NAN to leave a field unchanged. */
static inline void ed_state_patch(EdEngineState *s,
                                  double A_throat, double A_exit,
                                  double Lstar, double volume) {
    if (isfinite(A_throat)) s->geom.A_throat = A_throat;
    if (isfinite(A_exit))   s->geom.A_exit   = A_exit;
    if (isfinite(Lstar))    s->geom.Lstar    = Lstar;
    if (isfinite(volume))   s->geom.volume   = volume;
}

#ifdef __cplusplus
}
#endif

#endif /* ED_STATE_H */
