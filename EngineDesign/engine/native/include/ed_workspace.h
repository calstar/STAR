/* ed_workspace.h - Reusable scratch buffers, sized once, reused across evals.
 *
 * The hot path performs zero malloc/free. Any temporary arrays needed by the
 * residual loop, cooling segment profiles, or stability mode sweeps live here and
 * are owned by the caller for the lifetime of a worker thread.
 */
#ifndef ED_WORKSPACE_H
#define ED_WORKSPACE_H

#include "ed_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Fixed upper bounds keep the workspace a flat POD with no heap pointers.
 * Sized for the canonical configs (<=20 cooling segments, <=8 acoustic modes). */
#define ED_WS_MAX_SEGMENTS 64
#define ED_WS_MAX_MODES    16

typedef struct {
    /* Root-finder convergence history (bench/diagnostics only). */
    double residual_hist[256];
    int    residual_count;

    /* Cooling heat-flux profile scratch (ablative/graphite, later stages). */
    double seg_x[ED_WS_MAX_SEGMENTS];
    double seg_q[ED_WS_MAX_SEGMENTS];

    /* Acoustic mode scratch (stability, later stages). */
    double mode_freq[ED_WS_MAX_MODES];
    double mode_margin[ED_WS_MAX_MODES];

    /* Warm-start cache for the Pc bracket across consecutive evaluations. */
    double last_Pc;
    double last_bracket_lo;
    double last_bracket_hi;
} EdWorkspace;

/* Zero-initialize a workspace. No allocation. */
static inline void ed_workspace_reset(EdWorkspace *ws) {
    ws->residual_count = 0;
    ws->last_Pc = 0.0;
    ws->last_bracket_lo = 0.0;
    ws->last_bracket_hi = 0.0;
}

#ifdef __cplusplus
}
#endif

#endif /* ED_WORKSPACE_H */
