/* ed_phys_const.h - Physical constants mirrored from the engine pipeline constants
 * modules. Values copied verbatim so the C residual matches Python bit-for-bit. */
#ifndef ED_PHYS_CONST_H
#define ED_PHYS_CONST_H

/* physics_constants.py */
#define ED_PRANDTL_DEFAULT     0.8
#define ED_D_M_REF             5e-5
#define ED_D_M_T_REF           1500.0
#define ED_D_M_P_REF           2.5e6
#define ED_U_SLIP_CAP          50.0
#define ED_D_MIN_GASIFICATION  1e-6

/* combustion_physics.py hardcoded model params / defaults */
#define ED_CS_C_L              0.1     /* near-field length coeff */
#define ED_CS_C_U              0.5     /* RMS velocity contribution */
#define ED_CS_U_RMS_CAP        200.0
#define ED_GAS_MU_DEFAULT      7e-5    /* eta_Lstar default mu */
#define ED_GAS_RHO_L_DEFAULT   800.0   /* liquid fuel density default */
#define ED_GAS_CP_L_DEFAULT    2000.0  /* fuel_props.get("specific_heat", 2000) */
#define ED_GAS_T_INJ_DEFAULT   293.0   /* fuel_props.get("temperature", 293) */
#define ED_GAS_CP_G_DEFAULT    2200.0
#define ED_MIX_C_MU            0.09
#define ED_MIX_DM_REF          2.0e-5  /* mixing molecular diffusivity ref */
#define ED_MIX_DM_T_REF        300.0
#define ED_MIX_DM_P_REF        101325.0

/* constants.py (thermal) */
#define ED_NU_LAMINAR             4.36
#define ED_NU_TURB_COEF           0.023
#define ED_NU_TURB_RE_EXP         0.8
#define ED_NU_TURB_PR_EXP         0.4
#define ED_RECOVERY_FACTOR_DEF    0.94
#define ED_STEFAN_BOLTZMANN       5.670374419e-8
#define ED_MIN_DENS_KG_M3         0.01
#define ED_EPS_SMALL              1e-6
#define ED_EPS_TINY               1e-8
#define ED_RANKINE_PER_KELVIN     1.8
/* Huzel eq. (4-16) returns viscosity in lb/(in*s) -- pound-MASS per inch-sec;
 * see the nomenclature under eq. (4-12). NOT lbf*s/in^2 (= psi*s), whose
 * factor is 6894.76. The two differ by exactly g_c = 386.088 lbm*in/(lbf*s^2).
 * Must stay numerically identical to LB_PER_IN_S_TO_PA_S in
 * engine/pipeline/constants.py or the A/B parity test will diverge. */
#define ED_LB_PER_IN_S_TO_PA_S    17.8579673
#define ED_HUZEL_COEFF            46.6e-10

#endif /* ED_PHYS_CONST_H */
