/* state_from_yaml.c - Offline CLI: YAML config -> binary EdEngineState snapshot.
 *
 * Stage 1 status: the supported producer of the snapshot is the Python builder
 * engine/native/python/ed_state_builder.py, which reuses the project's Pydantic
 * loader (presets, defaults, derived geometry) instead of re-implementing that
 * resolution in C. A standalone C/libyaml path is intentionally deferred to avoid
 * a libyaml build dependency for tooling and to keep a single source of truth for
 * config resolution. This file builds as a usage shim so the documented layout is
 * complete; it is wired to the binary writer alongside the ed_evaluate port.
 */
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "--help") != 0) {
        fprintf(stderr,
            "state_from_yaml: standalone C YAML->snapshot is deferred (Stage 1).\n");
    }
    printf(
        "Produce an EdEngineState snapshot with the Python builder:\n"
        "  python engine/native/python/ed_state_builder.py \\\n"
        "      --config configs/canonical/impinging.yaml \\\n"
        "      --out    engine/native/tests/golden/state_impinging.json\n"
        "\n"
        "The packed-binary writer (build_state_bin) and this C path are enabled\n"
        "together with the ed_evaluate port; see engine/native/README.md.\n");
    return 0;
}
