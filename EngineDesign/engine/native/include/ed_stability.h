/* ed_stability.h - Module 3: combustion stability margins.
 *
 * Port target: comprehensive_stability_analysis() (engine/pipeline/stability/).
 * Layer 1 needs margins + state, so strings are omitted in v1.
 * STATUS: API frozen; implementation gated on the stability port (README).
 */
#ifndef ED_STABILITY_H
#define ED_STABILITY_H

#include "ed_types.h"
#include "ed_state.h"
#include "ed_chamber.h"
#include "ed_evaluate.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --- Chug fast-tier (Stage 5a): Nyquist gain-margin from a 200-pt complex sweep.
 * Port of stability/chug.py::chug_margin_fast. Per-stream constants are precomputed
 * by the Python caller (build_stability_inputs) and passed in, so the C side only
 * runs the frequency sweep + phase-crossover detection (the hot loop). */
typedef struct {
    double G_inj;        /* injector conductance kg/(s.Pa); <=0 => 1/G treated as +inf */
    double inertance;    /* 1/m */
    double resistance;   /* Pa.s/kg */
    double tau_conv;     /* s */
    double reg_Z_hf;     /* Pa.s/kg (0 => regulator impedance contributes nothing) */
    double reg_corner_hz;
    int    reg_enabled;
} EdChugStream;

typedef struct {
    double gain_margin;
    double f_chug_hz;
    double phase_margin_deg;
    int    stable;
} EdChugResult;

/* K_c = chamber gain (cstar / A_t); theta_c = chamber residence time constant. */
ed_status_t ed_chug_margin_fast(const EdChugStream *streams, int n_streams,
                                double K_c, double theta_c,
                                double f_lo, double f_hi, EdChugResult *out);

/* Fast acoustic check (1L + 1T modes). Port of acoustic.py::fast_acoustic. */
typedef struct {
    double alpha_max;   /* max growth rate [1/s]; NaN if no modes */
    double f_1L, f_1T;  /* Hz */
    int    limiting;    /* 0 = 1L, 1 = 1T, -1 = none */
    int    stable;      /* alpha_max < 0 */
} EdAcousticResult;

ed_status_t ed_fast_acoustic(double D_ch, double L_ch, double gamma, double a_sound,
                             double nu_g, double mach_ne, double n, double tau_sens,
                             EdAcousticResult *out);

typedef struct EdStabilityResult {
    ed_stability_state_t stability_state;
    double stability_score;
    int    is_stable;

    /* Chugging (low-frequency feed-coupled). */
    double chug_frequency;     /* Hz */
    double chug_margin;
    double tau_residence;      /* s */
    double Lstar;              /* m */

    /* Acoustic (chamber modes). */
    double acoustic_margin;
    int    acoustic_mode_count;
    double acoustic_limiting_freq; /* Hz */

    /* Feed-system coupling. */
    double feed_margin;
    double feed_frequency;     /* Hz */
} EdStabilityResult;

ed_status_t ed_stability_analyze(const EdEngineState *state,
                                 const EdChamberDiagnostics *chamber,
                                 const EdEvaluateResult *eval,
                                 EdStabilityResult *out);

#ifdef __cplusplus
}
#endif

#endif /* ED_STABILITY_H */
