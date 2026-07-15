/* ed_types.h - Common scalar types, enums, status codes, and small math helpers
 *
 * Part of the STAR EngineDesign native physics kernel (parallel implementation).
 * This is a clean-room C11 port of the Python hot path under engine/. It does NOT
 * link against or import any Python code at runtime.
 */
#ifndef ED_TYPES_H
#define ED_TYPES_H

#include <stddef.h>
#include <stdint.h>
#include <math.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Return / status codes. 0 == success; negative == failure. */
typedef enum {
    ED_OK = 0,
    ED_ERR_INVALID_ARG = -1,
    ED_ERR_NONFINITE = -2,
    ED_ERR_NO_BRACKET = -3,
    ED_ERR_NO_CONVERGE = -4,
    ED_ERR_OUT_OF_RANGE = -5,
    ED_ERR_NOT_IMPLEMENTED = -6,
    ED_ERR_IO = -7
} ed_status_t;

/* Injector dispatch tags (matches injector.type strings in config). */
typedef enum {
    ED_INJ_PINTLE = 0,
    ED_INJ_IMPINGING = 1,
    ED_INJ_COAXIAL = 2
} ed_injector_type_t;

/* Feed-loss pressure-dependence model (matches FeedSystemConfig.phi_type). */
typedef enum {
    ED_PHI_NONE = 0,
    ED_PHI_SQRTP = 1,
    ED_PHI_LOGP = 2
} ed_phi_type_t;

/* Stability state enum (matches stability analysis "stability_state"). */
typedef enum {
    ED_STAB_STABLE = 0,
    ED_STAB_MARGINAL = 1,
    ED_STAB_UNSTABLE = 2
} ed_stability_state_t;

/* Physical constants used across the kernel (match engine/pipeline/constants.py). */
#define ED_G0            9.80665
#define ED_PI            3.14159265358979323846
#define ED_P_SEA_LEVEL   101325.0

/* Branch-free clamp for doubles. Matches numpy.clip semantics for scalar a<=b. */
static inline double ed_clip(double x, double lo, double hi) {
    if (x < lo) return lo;
    if (x > hi) return hi;
    return x;
}

static inline double ed_min(double a, double b) { return a < b ? a : b; }
static inline double ed_max(double a, double b) { return a > b ? a : b; }

static inline int ed_isfinite(double x) { return isfinite(x); }

/* numpy.sign for the bracket-sign test in the root finder. */
static inline int ed_sign(double x) {
    if (x > 0.0) return 1;
    if (x < 0.0) return -1;
    return 0;
}

#ifdef __cplusplus
}
#endif

#endif /* ED_TYPES_H */
