# CI/CD Pipeline Documentation

This directory contains GitHub Actions workflows for continuous integration and deployment.

## Workflows

### `ci.yml` - Main CI Pipeline

Comprehensive CI pipeline that runs on every push and pull request:

1. **Format Check** - Ensures code follows formatting standards
2. **Build** - Builds with multiple compilers (GCC 12, Clang 15) and configurations (Debug, Release)
3. **Static Analysis** - Runs cppcheck and clang-tidy
4. **Code Quality** - Checks for TODOs, large files, and other quality issues
5. **Security Scan** - Scans for security vulnerabilities and unsafe code patterns
6. **Tests** - Runs CTest, Python tests, and integration tests
7. **Build Summary** - Provides a summary of all job results

### `pre-commit.yml` - Pre-commit Checks

Runs pre-commit hooks to catch issues before code is merged.

## Setup

### Pre-commit Hooks

Install pre-commit hooks locally:

```bash
./scripts/setup_pre_commit.sh
```

Or manually:

```bash
pip install pre-commit
pre-commit install
```

### Running Locally

Test formatting:

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
- **Compilers**: GCC 12, Clang 15
- **Build Types**: Debug, Release
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



