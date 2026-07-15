# CI/CD Pipeline Documentation

GitHub Actions for the DAQ server live at the **monorepo root**, not in this
directory. The relevant workflow is
[`.github/workflows/daq-server-ci.yml`](../../.github/workflows/daq-server-ci.yml)
(this `daq-server/.github/` holds only this README).

## Workflow: `daq-server-ci.yml`

Runs on push / PR / manual dispatch. Jobs include:

1. **Code Formatting Check** — runs `./format.sh --check` from the repo root
   (clang-format 19 for C++; `black --check` for Python).
2. **Web GUI** — `npm run test` (Vitest) and `npm run test:build` (Next.js
   build) in `daq-server/diablo_server/frontend`.
3. **Build** — GCC 12 and Clang 18, **Release** only; Clang is pinned to GCC
   12's libstdc++ (`--gcc-install-dir`) to avoid libstdc++ 14 + C++20
   `<format>`/`<chrono>` breakage.
4. **Static Analysis** — cppcheck and clang-tidy.
5. **Code Quality** — TODOs, large files, etc.
6. **Security Scan** — semgrep, secret patterns, unsafe C APIs.
7. **Tests** — CTest, sequencer test, Python tests.
8. **Integration Test** — scripted integration (Rust elodin-db, backend, etc.).
9. **Build Summary** — table of all job results.

Optional locally: [pre-commit](https://pre-commit.com/)
(`daq-server/.pre-commit-config.yaml`) — not run in CI.

## Setup

### Pre-commit Hooks

Install pre-commit hooks locally (from `daq-server/`):

```bash
./scripts/setup_pre_commit.sh
```

Or manually:

```bash
pip install pre-commit
pre-commit install
```

### Running Locally

Test formatting (run from the **monorepo root**, where `format.sh` lives):

```bash
./format.sh --check
```

Run pre-commit hooks manually:

```bash
pre-commit run --all-files
```

## Configuration

### Build Matrix

The CI builds with:
- **Compilers**: GCC 12, Clang 18 (Clang pinned to GCC 12's libstdc++ in Actions)
- **Build type (CI)**: Release only
- **C++ Standard**: C++20

### Artifacts

Build artifacts are uploaded for Release builds with GCC 12, retained for 7 days.

### Timeouts

- Format check: 10 minutes
- Build: 30 minutes
- Static analysis: 20 minutes
- Code quality: 15 minutes
- Security scan: 20 minutes
- Tests: 30 minutes

## Troubleshooting

### Build Failures

1. Check the build logs for compiler errors
2. Ensure all dependencies are listed in the workflow
3. Verify CMake configuration is correct

### Format Check Failures

Run `./format.sh` to auto-format code, then commit the changes.

### Test Failures

1. Run tests locally: `cd build && ctest --output-on-failure`
2. Check for missing test dependencies
3. Verify test data files are available

## Best Practices

1. **Always run pre-commit hooks locally** before pushing
2. **Fix formatting issues** before committing
3. **Run tests locally** before pushing
4. **Check CI status** before merging PRs
5. **Review security warnings** even if non-fatal
