/* ed_cea.c - CEA table interpolation, faithful port of CEACache (cea_cache.py).
 *
 * Parity notes vs Python:
 *  - Index lookup replicates np.searchsorted(grid, x, side='left') followed by
 *    np.clip(i, 1, n-1), so boundary weights (0 at low edge, 1 at high edge) match.
 *  - The 8-corner trilinear formula is byte-for-byte the same expression order.
 *  - If any corner is NaN, falls back to the f000 (lower) corner, like Python.
 *  - eval() clamps (Pc,MR,eps) to grid bounds first (CEACache.eval clamp).
 */
#include "ed_cea.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* First index i in [0,n] with g[i] >= x  (np.searchsorted side='left'). */
static size_t searchsorted_left(const double *g, size_t n, double x) {
    size_t lo = 0, hi = n;
    while (lo < hi) {
        size_t mid = lo + ((hi - lo) >> 1);
        if (g[mid] < x) lo = mid + 1;
        else            hi = mid;
    }
    return lo;
}

static size_t clamp_idx(size_t i, size_t n) {
    /* np.clip(i, 1, n-1) */
    if (i < 1) return 1;
    if (i > n - 1) return n - 1;
    return i;
}

double ed_cea_trilinear(const EdCeaTables *t, const double *table,
                        double Pc, double MR, double eps) {
    const size_t n_mr = t->n_mr, n_eps = t->n_eps;

    size_t i_pc  = clamp_idx(searchsorted_left(t->Pc_grid,  t->n_pc,  Pc),  t->n_pc);
    size_t i_mr  = clamp_idx(searchsorted_left(t->MR_grid,  t->n_mr,  MR),  t->n_mr);
    size_t i_eps = clamp_idx(searchsorted_left(t->eps_grid, t->n_eps, eps), t->n_eps);

    const double Pc0 = t->Pc_grid[i_pc - 1],  Pc1 = t->Pc_grid[i_pc];
    const double MR0 = t->MR_grid[i_mr - 1],  MR1 = t->MR_grid[i_mr];
    const double e0  = t->eps_grid[i_eps - 1], e1 = t->eps_grid[i_eps];

    /* index(i,j,k) = (i*n_mr + j)*n_eps + k */
#define IDX(i, j, k) ((((size_t)(i) * n_mr + (size_t)(j)) * n_eps) + (size_t)(k))
    const double f000 = table[IDX(i_pc - 1, i_mr - 1, i_eps - 1)];
    const double f001 = table[IDX(i_pc - 1, i_mr - 1, i_eps    )];
    const double f010 = table[IDX(i_pc - 1, i_mr,     i_eps - 1)];
    const double f011 = table[IDX(i_pc - 1, i_mr,     i_eps    )];
    const double f100 = table[IDX(i_pc,     i_mr - 1, i_eps - 1)];
    const double f101 = table[IDX(i_pc,     i_mr - 1, i_eps    )];
    const double f110 = table[IDX(i_pc,     i_mr,     i_eps - 1)];
    const double f111 = table[IDX(i_pc,     i_mr,     i_eps    )];
#undef IDX

    if (isnan(f000) || isnan(f001) || isnan(f010) || isnan(f011) ||
        isnan(f100) || isnan(f101) || isnan(f110) || isnan(f111)) {
        return f000; /* nearest-neighbour fallback (Python returns the f000 corner) */
    }

    const double wx = (Pc1 != Pc0) ? (Pc - Pc0) / (Pc1 - Pc0) : 0.0;
    const double wy = (MR1 != MR0) ? (MR - MR0) / (MR1 - MR0) : 0.0;
    const double wz = (e1  != e0 ) ? (eps - e0) / (e1  - e0 ) : 0.0;

    return  f000 * (1 - wx) * (1 - wy) * (1 - wz) +
            f100 * wx       * (1 - wy) * (1 - wz) +
            f010 * (1 - wx) * wy       * (1 - wz) +
            f110 * wx       * wy       * (1 - wz) +
            f001 * (1 - wx) * (1 - wy) * wz +
            f101 * wx       * (1 - wy) * wz +
            f011 * (1 - wx) * wy       * wz +
            f111 * wx       * wy       * wz;
}

/* Shared stencil: the 8 flat corner offsets + trilinear weights for a point.
 * All six property tables share grids, so the index/weight work is done once. */
typedef struct {
    size_t off[8];
    double w[8];
    size_t base; /* f000 offset, used for the NaN-corner fallback */
} ed_stencil;

static ed_stencil cea_stencil(const EdCeaTables *t, double Pc, double MR, double eps) {
    const size_t n_mr = t->n_mr, n_eps = t->n_eps;
    size_t i_pc  = clamp_idx(searchsorted_left(t->Pc_grid,  t->n_pc,  Pc),  t->n_pc);
    size_t i_mr  = clamp_idx(searchsorted_left(t->MR_grid,  t->n_mr,  MR),  t->n_mr);
    size_t i_eps = clamp_idx(searchsorted_left(t->eps_grid, t->n_eps, eps), t->n_eps);

    const double Pc0 = t->Pc_grid[i_pc - 1],  Pc1 = t->Pc_grid[i_pc];
    const double MR0 = t->MR_grid[i_mr - 1],  MR1 = t->MR_grid[i_mr];
    const double e0  = t->eps_grid[i_eps - 1], e1 = t->eps_grid[i_eps];
    const double wx = (Pc1 != Pc0) ? (Pc - Pc0) / (Pc1 - Pc0) : 0.0;
    const double wy = (MR1 != MR0) ? (MR - MR0) / (MR1 - MR0) : 0.0;
    const double wz = (e1  != e0 ) ? (eps - e0) / (e1  - e0 ) : 0.0;

#define OFF(i, j, k) ((((size_t)(i) * n_mr + (size_t)(j)) * n_eps) + (size_t)(k))
    ed_stencil s;
    s.base   = OFF(i_pc - 1, i_mr - 1, i_eps - 1);
    s.off[0] = OFF(i_pc - 1, i_mr - 1, i_eps - 1); s.w[0] = (1-wx)*(1-wy)*(1-wz);
    s.off[1] = OFF(i_pc,     i_mr - 1, i_eps - 1); s.w[1] = wx    *(1-wy)*(1-wz);
    s.off[2] = OFF(i_pc - 1, i_mr,     i_eps - 1); s.w[2] = (1-wx)*wy    *(1-wz);
    s.off[3] = OFF(i_pc,     i_mr,     i_eps - 1); s.w[3] = wx    *wy    *(1-wz);
    s.off[4] = OFF(i_pc - 1, i_mr - 1, i_eps    ); s.w[4] = (1-wx)*(1-wy)*wz;
    s.off[5] = OFF(i_pc,     i_mr - 1, i_eps    ); s.w[5] = wx    *(1-wy)*wz;
    s.off[6] = OFF(i_pc - 1, i_mr,     i_eps    ); s.w[6] = (1-wx)*wy    *wz;
    s.off[7] = OFF(i_pc,     i_mr,     i_eps    ); s.w[7] = wx    *wy    *wz;
#undef OFF
    return s;
}

static double cea_apply(const ed_stencil *s, const double *table) {
    const double f0 = table[s->off[0]], f1 = table[s->off[1]],
                 f2 = table[s->off[2]], f3 = table[s->off[3]],
                 f4 = table[s->off[4]], f5 = table[s->off[5]],
                 f6 = table[s->off[6]], f7 = table[s->off[7]];
    if (isnan(f0) || isnan(f1) || isnan(f2) || isnan(f3) ||
        isnan(f4) || isnan(f5) || isnan(f6) || isnan(f7)) {
        return table[s->base]; /* matches Python f000 fallback */
    }
    return f0*s->w[0] + f1*s->w[1] + f2*s->w[2] + f3*s->w[3] +
           f4*s->w[4] + f5*s->w[5] + f6*s->w[6] + f7*s->w[7];
}

ed_status_t ed_cea_eval(const EdCeaTables *t,
                        double MR, double Pc, double Pa, double eps,
                        EdCeaResult *out) {
    (void)Pa; /* accepted for API parity; unused in 3D lookup, as in Python */
    if (!t || !out) return ED_ERR_INVALID_ARG;
    if (!isfinite(MR) || !isfinite(Pc) || !isfinite(eps)) return ED_ERR_NONFINITE;

    const double Pc_c  = ed_clip(Pc,  t->Pc_min,  t->Pc_max);
    const double MR_c  = ed_clip(MR,  t->MR_min,  t->MR_max);
    const double eps_c = ed_clip(eps, t->eps_min, t->eps_max);

    const ed_stencil s = cea_stencil(t, Pc_c, MR_c, eps_c);
    out->cstar_ideal = cea_apply(&s, t->cstar_table);
    out->Cf_ideal    = cea_apply(&s, t->Cf_table);
    out->Tc          = cea_apply(&s, t->Tc_table);
    out->gamma       = cea_apply(&s, t->gamma_table);
    out->R           = cea_apply(&s, t->R_table);
    out->M           = cea_apply(&s, t->M_table);
    return ED_OK;
}

/* ---- .bin loader (offline/setup only) ---------------------------------------
 * Layout (little-endian, matches export_cea_tables.py):
 *   char    magic[4]   = "EDCA"
 *   int32   version    = 1
 *   int32   n_pc, n_mr, n_eps
 *   double  Pc_grid[n_pc], MR_grid[n_mr], eps_grid[n_eps]
 *   double  cstar, Cf, Tc, gamma, R, M  (each n_pc*n_mr*n_eps, C-order)
 */
ed_status_t ed_cea_load(const char *path, EdCeaTables *out) {
    if (!path || !out) return ED_ERR_INVALID_ARG;
    FILE *f = fopen(path, "rb");
    if (!f) return ED_ERR_IO;

    ed_status_t rc = ED_ERR_IO;
    char magic[4];
    int32_t version = 0, n_pc = 0, n_mr = 0, n_eps = 0;
    if (fread(magic, 1, 4, f) != 4 || memcmp(magic, "EDCA", 4) != 0) goto done;
    if (fread(&version, sizeof version, 1, f) != 1 || version != 1) goto done;
    if (fread(&n_pc, sizeof n_pc, 1, f) != 1) goto done;
    if (fread(&n_mr, sizeof n_mr, 1, f) != 1) goto done;
    if (fread(&n_eps, sizeof n_eps, 1, f) != 1) goto done;
    if (n_pc <= 0 || n_mr <= 0 || n_eps <= 0) goto done;

    const size_t ng = (size_t)n_pc + (size_t)n_mr + (size_t)n_eps;
    const size_t nt = (size_t)n_pc * (size_t)n_mr * (size_t)n_eps;
    const size_t total = ng + 6 * nt;
    double *buf = (double *)malloc(total * sizeof(double));
    if (!buf) { rc = ED_ERR_IO; goto done; }
    if (fread(buf, sizeof(double), total, f) != total) { free(buf); goto done; }

    memset(out, 0, sizeof(*out));
    out->_owned = buf;
    out->n_pc = (size_t)n_pc; out->n_mr = (size_t)n_mr; out->n_eps = (size_t)n_eps;
    double *p = buf;
    out->Pc_grid = p;  p += n_pc;
    out->MR_grid = p;  p += n_mr;
    out->eps_grid = p; p += n_eps;
    out->cstar_table = p; p += nt;
    out->Cf_table    = p; p += nt;
    out->Tc_table    = p; p += nt;
    out->gamma_table = p; p += nt;
    out->R_table     = p; p += nt;
    out->M_table     = p; p += nt;

    out->Pc_min = out->Pc_grid[0];  out->Pc_max = out->Pc_grid[n_pc - 1];
    out->MR_min = out->MR_grid[0];  out->MR_max = out->MR_grid[n_mr - 1];
    out->eps_min = out->eps_grid[0]; out->eps_max = out->eps_grid[n_eps - 1];
    rc = ED_OK;

done:
    fclose(f);
    return rc;
}

void ed_cea_free(EdCeaTables *t) {
    if (t && t->_owned) {
        free(t->_owned);
        t->_owned = NULL;
    }
}
