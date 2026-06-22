/* ed_stability_modes.c - chug fast-tier margin (Stage 5a).
 *
 * Faithful port of stability/chug.py::chug_margin_fast: the 200-pt log-spaced
 * frequency sweep of the open-loop L(iw) = Y_ch(s) * sum_k exp(-s*tau_k)/Z_feed_k(s),
 * np.unwrap of the phase, and Nyquist phase-crossover gain-margin detection.
 */
#include "ed_stability.h"
#include <complex.h>
#include <math.h>

#define ED_CHUG_N 200

/* np.unwrap(p, discont=pi) over an array, in place. */
static void unwrap_pi(double *p, int n) {
    const double twopi = 2.0 * ED_PI;
    double cum = 0.0;
    double prev = p[0];
    for (int i = 1; i < n; ++i) {
        double cur = p[i];
        double dd = cur - prev;
        /* floor-mod to [0, 2pi): mod(dd+pi, 2pi) - pi */
        double m = (dd + ED_PI);
        m = m - twopi * floor(m / twopi);
        double ddmod = m - ED_PI;
        if (ddmod == -ED_PI && dd > 0.0) ddmod = ED_PI;
        double corr = ddmod - dd;
        if (fabs(dd) < ED_PI) corr = 0.0;
        cum += corr;
        prev = cur;
        p[i] = cur + cum;
    }
}

static double complex z_feed(const EdChugStream *s, double complex sv) {
    double complex zr = 0.0;
    if (s->reg_enabled && s->reg_Z_hf > 0.0) {
        double wc = 2.0 * ED_PI * (s->reg_corner_hz > 1e-6 ? s->reg_corner_hz : 1e-6);
        zr = s->reg_Z_hf * (sv / wc) / (1.0 + sv / wc);
    }
    double complex inv_G = (s->G_inj > 0.0) ? (1.0 / s->G_inj) : INFINITY;
    return zr + s->inertance * sv + s->resistance + inv_G;
}

ed_status_t ed_chug_margin_fast(const EdChugStream *streams, int n_streams,
                                double K_c, double theta_c,
                                double f_lo, double f_hi, EdChugResult *out) {
    if (!streams || !out || n_streams <= 0) return ED_ERR_INVALID_ARG;

    double omega[ED_CHUG_N], phase[ED_CHUG_N], mag[ED_CHUG_N];
    const double l0 = log10(f_lo), l1 = log10(f_hi);
    for (int i = 0; i < ED_CHUG_N; ++i) {
        double f = pow(10.0, l0 + (l1 - l0) * (double)i / (double)(ED_CHUG_N - 1));
        double w = 2.0 * ED_PI * f;
        omega[i] = w;
        double complex sv = I * w;
        double complex acc = 0.0;
        for (int k = 0; k < n_streams; ++k) {
            double complex Zf = z_feed(&streams[k], sv);
            if (Zf == 0.0) continue;
            acc += cexp(-sv * streams[k].tau_conv) / Zf;
        }
        double complex Y = K_c / (theta_c * sv + 1.0);
        double complex L = Y * acc;
        phase[i] = carg(L);
        mag[i] = cabs(L);
    }
    unwrap_pi(phase, ED_CHUG_N);

    const double target = -ED_PI;
    double gm_best = INFINITY, f_pc = NAN;
    for (int i = 0; i < ED_CHUG_N - 1; ++i) {
        double gi = phase[i] - target, gi1 = phase[i + 1] - target;
        if (gi == 0.0 || gi * gi1 < 0.0) {
            double frac = (gi - gi1) != 0.0 ? gi / (gi - gi1) : 0.0;
            double w_c = omega[i] + frac * (omega[i + 1] - omega[i]);
            double mag_c = mag[i] + frac * (mag[i + 1] - mag[i]);
            double gm = mag_c > 0.0 ? 1.0 / mag_c : INFINITY;
            if (gm < gm_best) { gm_best = gm; f_pc = w_c / (2.0 * ED_PI); }
        }
    }

    double pm_deg = NAN;
    for (int i = 0; i < ED_CHUG_N - 1; ++i) {
        double hi = mag[i] - 1.0, hi1 = mag[i + 1] - 1.0;
        if (hi == 0.0 || hi * hi1 < 0.0) {
            double frac = (hi - hi1) != 0.0 ? hi / (hi - hi1) : 0.0;
            double ph_c = phase[i] + frac * (phase[i + 1] - phase[i]);
            pm_deg = (ph_c - target) * 180.0 / ED_PI;
            break;
        }
    }

    if (!isfinite(gm_best)) {
        double mmax = mag[0];
        for (int i = 1; i < ED_CHUG_N; ++i) if (mag[i] > mmax) mmax = mag[i];
        gm_best = 1.0 / ed_max(mmax, 1e-12);
        if (mmax < 1.0) gm_best = ed_max(gm_best, 1.0);
    }

    out->gain_margin = gm_best;
    out->f_chug_hz = f_pc;
    out->phase_margin_deg = pm_deg;
    out->stable = gm_best > 1.0;
    return ED_OK;
}

/* ---- fast acoustic (1L + 1T): port of acoustic.py::fast_acoustic ---------- */
#define ED_TRANSVERSE_1T 1.84118  /* J'_1 first zero */
#define ED_OVERLAP_1L    0.70
#define ED_OVERLAP_1T    0.40

/* mode_growth_rate alpha = driving - damping_total (damping_budget). */
static double mode_alpha(double f, double overlap, double D_ch, double L_ch,
                         double gamma, double nu_g, double mach_ne,
                         double n, double tau_sens) {
    const double omega = 2.0 * ED_PI * f;
    const double drive = 0.5 * omega * (gamma - 1.0) * overlap * (n * sin(omega * tau_sens));
    double a_noz = (f > 0 && L_ch > 0 && mach_ne > 0) ? ED_PI * f * (gamma - 1.0) * mach_ne : 0.0;
    double a_vis = 0.0;
    if (f > 0 && D_ch > 0 && nu_g > 0) {
        double delta = sqrt(nu_g / (ED_PI * f));
        a_vis = 2.0 * ED_PI * f * (delta / D_ch) * 4.0;
    }
    const double a_inj = 0.02 * ED_PI * f;
    const double a_2ph = 0.03 * ED_PI * f * 1.0;
    return drive - (a_noz + a_vis + a_inj + a_2ph);
}

ed_status_t ed_fast_acoustic(double D_ch, double L_ch, double gamma, double a_sound,
                             double nu_g, double mach_ne, double n, double tau_sens,
                             EdAcousticResult *out) {
    if (!out) return ED_ERR_INVALID_ARG;
    const double f_1L = (a_sound > 0 && L_ch > 0) ? a_sound / (4.0 * L_ch) : 0.0;
    const double f_1T = (a_sound > 0 && D_ch > 0) ? ED_TRANSVERSE_1T * a_sound / (ED_PI * D_ch) : 0.0;
    out->f_1L = f_1L;
    out->f_1T = f_1T;

    int have = 0;
    double best = -INFINITY; int lim = -1;
    if (f_1L > 0) {
        double a = mode_alpha(f_1L, ED_OVERLAP_1L, D_ch, L_ch, gamma, nu_g, mach_ne, n, tau_sens);
        if (a > best) { best = a; lim = 0; }
        have = 1;
    }
    if (f_1T > 0) {
        double a = mode_alpha(f_1T, ED_OVERLAP_1T, D_ch, L_ch, gamma, nu_g, mach_ne, n, tau_sens);
        if (a > best) { best = a; lim = 1; }
        have = 1;
    }
    if (!have) {
        out->alpha_max = NAN; out->limiting = -1; out->stable = 1;
        return ED_OK;
    }
    out->alpha_max = best;
    out->limiting = lim;
    out->stable = best < 0.0;
    return ED_OK;
}
