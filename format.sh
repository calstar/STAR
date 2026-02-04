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
    --verbose        Show verbose output
    --all            Format all C++ files (including external dependencies)
    --help           Show this help message

EXAMPLES:
    $0                    # Format code in FSW/, comms/, and utl/ directories
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
    local directories=("FSW" "comms" "utl")

    if [ "$FORMAT_ALL" = true ]; then
        directories+=("external")
    fi

    for dir in "${directories[@]}"; do
        if [ -d "$dir" ]; then
            find "$dir" -name "*.cpp" -o -name "*.hpp" -o -name "*.c" -o -name "*.h"
        else
            print_warning "Directory $dir not found, skipping..."
        fi
    done
}

# Function to format files
format_files() {
    local files=($(find_cpp_files))
    local total_files=${#files[@]}

    if [ $total_files -eq 0 ]; then
        print_warning "No C++ files found to format"
        return 0
    fi

    print_status "Found $total_files C++ files"

    local changed_files=()
    local unchanged_files=()

    for file in "${files[@]}"; do
        if [ "$VERBOSE" = true ]; then
            print_status "Processing: $file"
        fi

        if [ "$CHECK_ONLY" = true ]; then
            # Check if file is properly formatted
            if ! clang-format --dry-run --Werror "$file" &>/dev/null; then
                changed_files+=("$file")
                if [ "$VERBOSE" = true ]; then
                    print_error "Formatting issues found in: $file"
                fi
            else
                unchanged_files+=("$file")
            fi
        else
            # Actually format the file
            local temp_file=$(mktemp)
            if clang-format "$file" > "$temp_file"; then
                if ! cmp -s "$file" "$temp_file"; then
                    mv "$temp_file" "$file"
                    changed_files+=("$file")
                    if [ "$VERBOSE" = true ]; then
                        print_success "Formatted: $file"
                    fi
                else
                    unchanged_files+=("$file")
                    rm "$temp_file"
                fi
            else
                print_error "Failed to format: $file"
                rm -f "$temp_file"
                return 1
            fi
        fi
    done

    # Print summary
    if [ "$CHECK_ONLY" = true ]; then
        if [ ${#changed_files[@]} -eq 0 ]; then
            print_success "All files are properly formatted!"
            return 0
        else
            print_error "Found formatting issues in ${#changed_files[@]} files:"
            for file in "${changed_files[@]}"; do
                echo "  - $file"
            done
            print_error "Run '$0' to fix formatting issues"
            return 1
        fi
    else
        if [ ${#changed_files[@]} -eq 0 ]; then
            print_success "All files were already properly formatted!"
        else
            print_success "Formatted ${#changed_files[@]} files"
            if [ "$VERBOSE" = true ]; then
                echo "Changed files:"
                for file in "${changed_files[@]}"; do
                    echo "  - $file"
                done
            fi
        fi
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
