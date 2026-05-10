#!/bin/bash

# Format script for Liquid Engine Flight Software
# This script handles code formatting using clang-format

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
CHECK_ONLY=false
VERBOSE=false
FORMAT_ALL=false

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to show usage
show_usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Format C++ code using clang-format

OPTIONS:
    --check          Check formatting without making changes
    --verbose        Show verbose output (and per-file errors when --check fails)
    --all            Format all C++ files including external/
    --help           Show this help message

ENVIRONMENT:
    FORMAT_JOBS      Parallel clang-format processes (default: CPU count via nproc/sysctl, else 8).

EXAMPLES:
    $0                    # Format code in diablo_server/, archive/legacy/utl/
    $0 --check            # Check formatting without changes
    $0 --verbose          # Format with verbose output
    $0 --all              # Format all C++ files including external/

EOF
}

# Function to check if clang-format is installed
check_clang_format() {
    if ! command -v clang-format &> /dev/null; then
        print_error "clang-format is not installed. Please install it:"
        echo "  Ubuntu/Debian: sudo apt-get install clang-format"
        echo "  macOS: brew install clang-format"
        echo "  Or visit: https://clang.llvm.org/docs/ClangFormat.html"
        exit 1
    fi

    local version=$(clang-format --version | head -n1)
    print_status "Using $version"
}

# Function to find C++ files
find_cpp_files() {
    local directories=("diablo_server" "archive/legacy/utl")

    if [ "$FORMAT_ALL" = true ]; then
        directories+=("external")
    fi

    for dir in "${directories[@]}"; do
        if [ -d "$dir" ]; then
            # Skip vendored and generated trees for normal runs.
            # This keeps formatting focused on first-party code and avoids traversing
            # large submodule/vendor directories like FSW/external/uWebSockets.
            find "$dir" \
                \( -path "$dir/external" -o -path "$dir/external/*" -o -path "$dir/build" -o -path "$dir/build/*" \) -prune -o \
                -type f \( -name "*.cpp" -o -name "*.hpp" -o -name "*.c" -o -name "*.h" \) -print
        else
            print_warning "Directory $dir not found, skipping..."
        fi
    done
}

# Parallel clang-format jobs (one file per process — multi-file argv can hang on some clang-format versions).
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

# Function to format files
format_files() {
    local files=($(find_cpp_files))
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
            print_success "All files are properly formatted!"
            return 0
        fi
        print_error "Some files need formatting. Listing offenders…"
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

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --check)
            CHECK_ONLY=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --all)
            FORMAT_ALL=true
            shift
            ;;
        --help)
            show_usage
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Main execution
main() {
    print_status "Starting code formatting process..."

    # Check if clang-format is available
    check_clang_format

    # Check if .clang-format config exists
    if [ ! -f ".clang-format" ]; then
        print_warning ".clang-format configuration file not found"
        print_status "Using default clang-format style"
    fi

    # Format files
    format_files
    local exit_code=$?

    if [ $exit_code -eq 0 ]; then
        print_success "Formatting process completed successfully!"
    else
        print_error "Formatting process failed!"
    fi

    exit $exit_code
}

# Run main function
main "$@"
