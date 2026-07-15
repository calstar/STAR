/* ed_cea.h - Preloaded CEA property tables + hand-rolled trilinear interpolation.
 *
 * Mirrors engine/pipeline/cea_cache.py: CEACache.eval() + _trilinear_interpolate().
 * Tables are produced offline by engine/native/python/export_cea_tables.py and
 * loaded from a flat .bin (see ed_cea_load). No RocketCEA at runtime.
 */
#ifndef ED_CEA_H
#define ED_CEA_H

#include "ed_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Flattened C-order tables: index(i_pc,i_mr,i_eps) = (i_pc*n_mr + i_mr)*n_eps + i_eps.
 * Stored as double for bit-comparable parity with the float64 Python cache. */
typedef struct {
    const double *Pc_grid;   /* length n_pc, ascending */
    const double *MR_grid;   /* length n_mr, ascending */
    const double *eps_grid;  /* length n_eps, ascending */
    const double *cstar_table;
    const double *Cf_table;
    const double *Tc_table;
    const double *gamma_table;
    const double *R_table;
    const double *M_table;
    size_t n_pc, n_mr, n_eps;

    /* Clamp bounds == grid endpoints (matches CEACache.{Pc,MR,eps}_{min,max}). */
    double Pc_min, Pc_max;
    double MR_min, MR_max;
    double eps_min, eps_max;

    /* Backing storage when loaded from file (NULL for caller-provided tables). */
    void *_owned;
} EdCeaTables;

/* Output of one CEA lookup (matches CEACache.eval() dict keys). */
typedef struct {
    double cstar_ideal;
    double Cf_ideal;
    double Tc;
    double gamma;
    double R;
    double M;
} EdCeaResult;

/* Evaluate CEA properties at (MR, Pc, eps). Pa is accepted for API parity with
 * the Python signature but, like the Python cache, does not affect 3D lookups.
 * Clamps inputs to grid bounds, then trilinear-interpolates each table. */
ed_status_t ed_cea_eval(const EdCeaTables *t,
                        double MR, double Pc, double Pa, double eps,
                        EdCeaResult *out);

/* Single-table trilinear interpolation (exposed for unit tests). Inputs must be
 * pre-clamped to [grid0, gridN-1] exactly as eval() does. */
double ed_cea_trilinear(const EdCeaTables *t, const double *table,
                        double Pc, double MR, double eps);

/* Load tables from a .bin produced by export_cea_tables.py. Allocates backing
 * storage (offline/setup only, never in the hot loop). Free with ed_cea_free. */
ed_status_t ed_cea_load(const char *path, EdCeaTables *out);
void        ed_cea_free(EdCeaTables *t);

#ifdef __cplusplus
}
#endif

#endif /* ED_CEA_H */
