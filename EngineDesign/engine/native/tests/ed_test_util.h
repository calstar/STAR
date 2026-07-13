/* ed_test_util.h - Minimal, dependency-free helpers for the C tests:
 * file slurp + flat-JSON number extraction + tolerance checks. Header-only.
 *
 * The golden JSON files are arrays of FLAT objects (no nesting), so a key occurs
 * at most once per object and values are plain numbers — a substring scan is
 * sufficient and avoids pulling in a JSON dependency.
 */
#ifndef ED_TEST_UTIL_H
#define ED_TEST_UTIL_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

static char *edt_slurp(const char *path, size_t *len_out) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = (char *)malloc((size_t)n + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t rd = fread(buf, 1, (size_t)n, f);
    fclose(f);
    buf[rd] = '\0';
    if (len_out) *len_out = rd;
    return buf;
}

/* Find "key" within [obj, obj_end) and parse the number after its ':'. */
static int edt_find_double(const char *obj, const char *obj_end,
                           const char *key, double *out) {
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(obj, pat);
    if (!p || p >= obj_end) return 0;
    p = strchr(p, ':');
    if (!p || p >= obj_end) return 0;
    p++;
    *out = strtod(p, NULL);
    return 1;
}

/* Iterate flat objects in a JSON array. Returns pointer to next object start
 * (at '{') or NULL. *end is set to the object's closing '}'. */
static const char *edt_next_object(const char *p, const char **end) {
    p = strchr(p, '{');
    if (!p) return NULL;
    const char *e = strchr(p, '}');
    if (!e) return NULL;
    *end = e;
    return p;
}

static int edt_close(double got, double want, double rtol, double atol) {
    if (isnan(got) && isnan(want)) return 1;
    double tol = atol + rtol * fabs(want);
    return fabs(got - want) <= tol;
}

#endif /* ED_TEST_UTIL_H */
