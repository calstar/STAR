#!/bin/bash

# Repo-wide formatter for STAR.
#   C/C++ — clang-format (configs: daq-server/.clang-format @ 100col for daq-server,
#                                  .clang-format            @  80col elsewhere
#                                                                  inc. firmware)
#   Python — black (config: pyproject.toml at repo root, line-length=88)
#
# clang-format and black both auto-discover the nearest config walking up
# from each source file, so per-tree settings stay correct without any
# per-target plumbing here.

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CHECK_ONLY=false
VERBOSE=false
FORMAT_ALL=false

# C/C++ trees to format. Each path is relative to the repo root.
TARGETS=(
    "daq-server/diablo_server"
    "daq-server/archive/legacy/utl"
    "firmware"
)

# Extra trees included only with --all (vendored/external code).
TARGETS_ALL=(
    "daq-server/external"
)

# Python trees to format with black. Line length lives in pyproject.toml
# (currently 88, black's default). Keep this list narrow — daq-server Python
# is already formatted by daq-server/.pre-commit-config.yaml.
PY_TARGETS=(
    "firmware"
)

print_status()  { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

show_usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Format C/C++ code across the STAR repo using clang-format.

OPTIONS:
    --check          Check formatting without making changes
    --verbose        Show verbose output (and per-file errors when --check fails)
    --all            Also format vendored trees (e.g. daq-server/external)
    --help           Show this help message

ENVIRONMENT:
    FORMAT_JOBS      Parallel clang-format processes (default: CPU count via nproc/sysctl, else 8).

EXAMPLES:
    $0                    # Format default trees in-place
    $0 --check            # Check formatting without changes (used by CI)
    $0 --verbose          # Format with verbose output
    $0 --all              # Also include vendored/external trees
EOF
}

check_clang_format() {
    if ! command -v clang-format &> /dev/null; then
        print_error "clang-format is not installed. Please install it:"
        echo "  Ubuntu/Debian: sudo apt-get install clang-format"
        echo "  macOS: brew install clang-format"
        echo "  Or visit: https://clang.llvm.org/docs/ClangFormat.html"
        exit 1
    fi
    local version
    version=$(clang-format --version | head -n1)
    print_status "Using $version"
}

check_black() {
    if ! command -v black &> /dev/null; then
        print_error "black is not installed. Please install it:"
        echo "  pip install black            # or"
        echo "  pip install --user black     # if pip refuses (PEP 668)"
        echo "  (matches daq-server/.pre-commit-config.yaml: psf/black)"
        exit 1
    fi
    local version
    version=$(black --version | head -n1)
    print_status "Using $version (config: pyproject.toml)"
}

# NOTE: file discovery is null-delimited (-print0) so paths with spaces
# (e.g. "firmware/DAN-E Avionics/", "firmware/Environmental Tracker/")
# survive the trip through bash variables. Always read via
# `while IFS= read -r -d '' f; do ...; done < <(find_*_files)`.
find_cpp_files() {
    local dirs=("${TARGETS[@]}")
    if [ "$FORMAT_ALL" = true ]; then
        dirs+=("${TARGETS_ALL[@]}")
    fi

    for dir in "${dirs[@]}"; do
        if [ -d "$dir" ]; then
            # Skip vendored / build / archived trees inside each target.
            # firmware/libraries is vendored (subtrees, symlinks); firmware/Archive
            # is intentionally frozen old code.
            find "$dir" \
                \( -path "$dir/external"  -o -path "$dir/external/*" \
                -o -path "$dir/build"     -o -path "$dir/build/*" \
                -o -path "$dir/.pio"      -o -path "$dir/.pio/*" \
                -o -path "$dir/Archive"   -o -path "$dir/Archive/*" \
                -o -path "$dir/libraries" -o -path "$dir/libraries/*" \) -prune -o \
                -type f \( -name "*.cpp" -o -name "*.hpp" -o -name "*.c" -o -name "*.h" \) -print0
        else
            print_warning "Directory $dir not found, skipping..."
        fi
    done
}

find_py_files() {
    for dir in "${PY_TARGETS[@]}"; do
        if [ -d "$dir" ]; then
            find "$dir" \
                \( -path "$dir/external"  -o -path "$dir/external/*" \
                -o -path "$dir/build"     -o -path "$dir/build/*" \
                -o -path "$dir/.pio"      -o -path "$dir/.pio/*" \
                -o -path "$dir/Archive"   -o -path "$dir/Archive/*" \
                -o -path "$dir/libraries" -o -path "$dir/libraries/*" \) -prune -o \
                -type f -name "*.py" -print0
        else
            print_warning "Directory $dir not found, skipping..."
        fi
    done
}

format_parallel_jobs() {
    if [ -n "${FORMAT_JOBS:-}" ]; then
        echo "$FORMAT_JOBS"
    elif command -v nproc &>/dev/null; then
        nproc
    elif command -v sysctl &>/dev/null; then
        sysctl -n hw.ncpu 2>/dev/null || echo 8
    else
        echo 8
    fi
}

format_cpp() {
    local files=()
    while IFS= read -r -d '' file; do
        files+=("$file")
    done < <(find_cpp_files)
    local total_files=${#files[@]}
    local jobs
    jobs="$(format_parallel_jobs)"

    if [ $total_files -eq 0 ]; then
        print_warning "No C++ files found to format"
        return 0
    fi

    print_status "Found $total_files C++ files"
    print_status "Running clang-format ($jobs parallel jobs, one file at a time)…"

    if [ "$CHECK_ONLY" = true ]; then
        if printf '%s\0' "${files[@]}" | xargs -0 -P "$jobs" -n 1 clang-format --dry-run --Werror --; then
            print_success "All C++ files are properly formatted!"
            return 0
        fi
        print_error "Some C++ files need formatting. Listing offenders…"
        local bad=()
        for file in "${files[@]}"; do
            if ! clang-format --dry-run --Werror "$file" &>/dev/null; then
                bad+=("$file")
                if [ "$VERBOSE" = true ]; then
                    print_error "  $file"
                fi
            fi
        done
        if [ "$VERBOSE" != true ] && [ ${#bad[@]} -gt 0 ]; then
            for file in "${bad[@]}"; do
                echo "  - $file"
            done
        fi
        print_error "Run '$0' (without --check) to fix formatting issues"
        return 1
    fi

    if ! printf '%s\0' "${files[@]}" | xargs -0 -P "$jobs" -n 1 clang-format -i --; then
        print_error "clang-format failed"
        return 1
    fi

    if [ "$VERBOSE" = true ]; then
        print_success "clang-format -i completed for $total_files files (use git diff to see edits)"
    else
        print_success "clang-format finished ($total_files files)"
    fi
}

format_py() {
    local files=()
    while IFS= read -r -d '' file; do
        files+=("$file")
    done < <(find_py_files)
    local total_files=${#files[@]}

    if [ $total_files -eq 0 ]; then
        print_warning "No Python files found to format"
        return 0
    fi

    print_status "Found $total_files Python files"
    print_status "Running black (config from pyproject.toml)…"

    local black_args=(--quiet)
    [ "$VERBOSE" = true ] && black_args=()

    if [ "$CHECK_ONLY" = true ]; then
        if black --check "${black_args[@]}" "${files[@]}"; then
            print_success "All Python files are properly formatted!"
            return 0
        fi
        print_error "Some Python files need formatting."
        print_error "Run '$0' (without --check) to fix formatting issues"
        return 1
    fi

    if ! black "${black_args[@]}" "${files[@]}"; then
        print_error "black failed"
        return 1
    fi

    print_success "black finished ($total_files files)"
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --check)   CHECK_ONLY=true; shift ;;
        --verbose) VERBOSE=true; shift ;;
        --all)     FORMAT_ALL=true; shift ;;
        --help)    show_usage; exit 0 ;;
        *)         print_error "Unknown option: $1"; show_usage; exit 1 ;;
    esac
done

main() {
    # Resolve repo root from the script's own location so the script is
    # invokable from anywhere (CI, hooks, ad-hoc).
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    cd "$script_dir"

    print_status "Starting code formatting process..."
    check_clang_format
    check_black

    if [ ! -f ".clang-format" ]; then
        print_warning "repo-root .clang-format not found; firmware/ will fall back to LLVM defaults"
    fi
    if [ ! -f "daq-server/.clang-format" ]; then
        print_warning "daq-server/.clang-format not found; daq-server will use the repo-root config"
    fi
    if [ ! -f "pyproject.toml" ]; then
        print_warning "repo-root pyproject.toml not found; black will fall back to its built-in defaults"
    fi

    local exit_code=0
    format_cpp || exit_code=$?
    format_py  || exit_code=$?

    if [ $exit_code -eq 0 ]; then
        print_success "Formatting process completed successfully!"
    else
        print_error "Formatting process failed!"
    fi

    exit $exit_code
}

main "$@"
