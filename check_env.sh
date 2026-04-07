#!/usr/bin/env bash
# check_env.sh — Diablo-FSW environment health checker
# Checks system tools, build artifacts, node/python deps, git state, and port conflicts.
# Works on Linux, macOS, and WSL.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$SCRIPT_DIR"

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
OK="${GREEN}✓${NC}"; WARN="${YELLOW}⚠${NC}"; ERR="${RED}✗${NC}"

# ── Warning accumulator ──────────────────────────────────────────────────────
WARNINGS=()
warn()  { WARNINGS+=("WARN:  $1"); }
error() { WARNINGS+=("ERROR: $1"); }

section() { printf "\n${CYAN}${BOLD}══ %s ══${NC}\n" "$1"; }

# ── Cross-platform helpers ───────────────────────────────────────────────────

get_mtime() {
    stat -c "%Y" "$1" 2>/dev/null || stat -f "%m" "$1" 2>/dev/null || echo 0
}

detect_platform() {
    local kernel
    kernel="$(uname -s)"
    case "$kernel" in
        Linux)
            if grep -qi microsoft /proc/version 2>/dev/null; then
                echo "WSL"
            else
                echo "Linux"
            fi
            ;;
        Darwin) echo "macOS" ;;
        *)      echo "Unknown:$kernel" ;;
    esac
}

# Pure-bash version compare: returns 0 if $1 >= $2 (dot-separated)
ver_gte() {
    local IFS='.'
    local -a a=() b=()
    read -r -a a <<<"$1"
    read -r -a b <<<"$2"
    local i
    for i in 0 1 2; do
        local av="${a[$i]:-0}" bv="${b[$i]:-0}"
        (( 10#$av > 10#$bv )) && return 0
        (( 10#$av < 10#$bv )) && return 1
    done
    return 0
}

port_in_use() {
    local port="$1"
    if command -v ss &>/dev/null; then
        ss -tlnp 2>/dev/null | awk '{print $4}' | grep -qE ":${port}$"
    elif command -v lsof &>/dev/null; then
        lsof -i "TCP:${port}" -sTCP:LISTEN &>/dev/null
    else
        return 1
    fi
}

port_owner() {
    local port="$1"
    if command -v ss &>/dev/null; then
        # Extract process name from ss -tlnp output
        ss -tlnp 2>/dev/null | grep ":${port} " | grep -o '"[^"]*"' | head -1 | tr -d '"'
    elif command -v lsof &>/dev/null; then
        lsof -i "TCP:${port}" -sTCP:LISTEN -Fp 2>/dev/null | head -1 | tr -d 'p' | xargs -I{} ps -p {} -o comm= 2>/dev/null
    fi
}

# ────────────────────────────────────────────────────────────────────────────
PLATFORM="$(detect_platform)"

# ══ 1. PLATFORM INFO ════════════════════════════════════════════════════════
section "PLATFORM INFO"

printf "  %-16s %s\n" "Platform:"  "$PLATFORM"
printf "  %-16s %s\n" "Arch:"      "$(uname -m)"
printf "  %-16s %s\n" "Kernel:"    "$(uname -r)"

if [ "$PLATFORM" = "WSL" ]; then
    printf "  %-16s %s\n" "WSL version:" "$(uname -r | grep -o 'microsoft.*' || echo 'WSL')"
elif [ "$PLATFORM" = "macOS" ]; then
    printf "  %-16s %s\n" "macOS:" "$(sw_vers -productVersion 2>/dev/null || echo unknown)"
elif [ "$PLATFORM" = "Linux" ]; then
    distro="$(grep '^PRETTY_NAME' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"')"
    printf "  %-16s %s\n" "Distro:" "${distro:-unknown}"
fi

printf "  %-16s %s\n" "Repo:" "$REPO"

if [ "$PLATFORM" = "WSL" ] && echo "$REPO" | grep -q "^/mnt/"; then
    printf "  ${ERR} CRITICAL: Repo is on Windows filesystem (%s)\n" "$REPO"
    printf "       mtime comparisons are UNRELIABLE on /mnt/ paths.\n"
    printf "       Move repo to WSL native filesystem: /home/%s/\n" "$USER"
    error "Repo is on Windows filesystem — mtime-based staleness checks unreliable. Move to ~/."
fi

# ── Read version requirements from repo manifests ───────────────────────────
# cmake minimum from CMakeLists.txt: cmake_minimum_required(VERSION 3.20)
CMAKE_MIN_VER="$(grep -i 'cmake_minimum_required' "$REPO/CMakeLists.txt" 2>/dev/null \
    | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)"
CMAKE_MIN_VER="${CMAKE_MIN_VER:-3.20}"

# C++ standard from CMakeLists.txt: set(CMAKE_CXX_STANDARD 20)
CXX_STANDARD="$(grep 'set(CMAKE_CXX_STANDARD ' "$REPO/CMakeLists.txt" 2>/dev/null \
    | grep -v REQUIRED | grep -oE '[0-9]+' | head -1)"
CXX_STANDARD="${CXX_STANDARD:-20}"

# Node.js minimum from start.sh: if [ "$NODE_MAJOR_VER" -lt 20 ]
NODE_MIN_MAJOR="$(grep 'NODE_MAJOR_VER -lt' "$REPO/web-gui/start.sh" 2>/dev/null \
    | grep -oE '[0-9]+' | head -1)"
NODE_MIN_MAJOR="${NODE_MIN_MAJOR:-20}"

# ══ 2. SYSTEM TOOLS ═════════════════════════════════════════════════════════
section "SYSTEM TOOLS"

check_tool() {
    local name="$1" min_ver="$2" actual="$3"
    if [ -z "$actual" ] || [ "$actual" = "NOT_FOUND" ]; then
        printf "  ${ERR} %-16s not found in PATH\n" "$name"
        error "$name not found in PATH"
        return 1
    fi
    if [ -n "$min_ver" ] && ! ver_gte "$actual" "$min_ver"; then
        printf "  ${WARN} %-16s %-20s (need >= %s)\n" "$name" "$actual" "$min_ver"
        warn "$name version $actual is below minimum $min_ver"
    else
        printf "  ${OK} %-16s %s\n" "$name" "$actual"
    fi
}

# node — min version from web-gui/start.sh
if command -v node &>/dev/null; then
    NODE_VER="$(node --version 2>/dev/null | tr -d 'v')"
    check_tool "node" "${NODE_MIN_MAJOR}.0.0" "$NODE_VER"
else
    check_tool "node" "${NODE_MIN_MAJOR}.0.0" "NOT_FOUND"
fi

# npm
if command -v npm &>/dev/null; then
    check_tool "npm" "" "$(npm --version 2>/dev/null)"
else
    check_tool "npm" "" "NOT_FOUND"
fi

# python3
if command -v python3 &>/dev/null; then
    PY_VER="$(python3 --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
    check_tool "python3" "3.8.0" "$PY_VER"
else
    check_tool "python3" "3.8.0" "NOT_FOUND"
fi

# cmake — min version from CMakeLists.txt cmake_minimum_required()
if command -v cmake &>/dev/null; then
    CMAKE_VER="$(cmake --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
    check_tool "cmake" "${CMAKE_MIN_VER}.0" "$CMAKE_VER"
else
    check_tool "cmake" "${CMAKE_MIN_VER}.0" "NOT_FOUND"
fi
printf "       %-14s %s\n" "(from CMakeLists.txt:" "cmake_minimum_required(VERSION ${CMAKE_MIN_VER}))"

# g++ — C++ standard from CMakeLists.txt CMAKE_CXX_STANDARD
if command -v g++ &>/dev/null; then
    GPP_VER="$(g++ --version 2>/dev/null | head -1)"
    printf "  ${OK} %-16s %s\n" "g++" "$GPP_VER"
    # C++ standard compile test using standard read from CMakeLists.txt
    if echo "int main(){}" | g++ "-std=c++${CXX_STANDARD}" -x c++ - -o /dev/null 2>/dev/null; then
        printf "  ${OK} %-16s %s\n" "g++ (C++${CXX_STANDARD})" "supported"
        printf "       %-14s %s\n" "(from CMakeLists.txt:" "CMAKE_CXX_STANDARD ${CXX_STANDARD})"
    else
        printf "  ${ERR} %-16s %s\n" "g++ (C++${CXX_STANDARD})" "NOT supported — required by CMakeLists.txt"
        error "g++ does not support -std=c++${CXX_STANDARD} (set in CMakeLists.txt)"
    fi
else
    printf "  ${ERR} %-16s not found in PATH\n" "g++"
    error "g++ not found in PATH"
fi

# make
if command -v make &>/dev/null; then
    MAKE_VER="$(make --version 2>/dev/null | head -1)"
    printf "  ${OK} %-16s %s\n" "make" "$MAKE_VER"
else
    printf "  ${ERR} %-16s not found in PATH\n" "make"
    error "make not found in PATH"
fi

# tmux
if command -v tmux &>/dev/null; then
    printf "  ${OK} %-16s %s\n" "tmux" "$(tmux -V 2>/dev/null)"
else
    printf "  ${WARN} %-16s not found (needed by start.sh)\n" "tmux"
    warn "tmux not found — required by web-gui/start.sh"
fi

# openssl
if command -v openssl &>/dev/null; then
    printf "  ${OK} %-16s %s\n" "openssl" "$(openssl version 2>/dev/null)"
else
    printf "  ${WARN} %-16s not found\n" "openssl"
    warn "openssl not found"
fi

# ss or lsof for port checks
if command -v ss &>/dev/null; then
    printf "  ${OK} %-16s %s\n" "ss" "$(ss --version 2>/dev/null | head -1 || echo 'available')"
elif command -v lsof &>/dev/null; then
    printf "  ${OK} %-16s %s\n" "lsof" "available (ss not found, using lsof)"
else
    printf "  ${WARN} %-16s neither ss nor lsof found — port checks skipped\n" "port tools"
    warn "Neither ss nor lsof found — port conflict checks unavailable"
fi

# ══ 3. C++ BUILD ARTIFACTS ══════════════════════════════════════════════════
section "C++ BUILD ARTIFACTS"

CACHE="$REPO/build/CMakeCache.txt"
if [ ! -f "$CACHE" ]; then
    printf "  %b build/CMakeCache.txt not found — cmake has not been run\n" "$ERR"
    printf "       Fix: mkdir -p build && cd build && cmake .. && cd ..\n"
    error "CMakeCache.txt missing — run: mkdir -p build && cd build && cmake .."
else
    printf "  %b build/CMakeCache.txt found\n" "$OK"
    cmake_val() { grep "^${1}=" "$CACHE" 2>/dev/null | cut -d= -f2-; }
    BUILD_TYPE="$(cmake_val CMAKE_BUILD_TYPE:STRING)"
    CXX_COMPILER="$(cmake_val CMAKE_CXX_COMPILER:FILEPATH)"
    OPENSSL_INC="$(cmake_val OPENSSL_INCLUDE_DIR:PATH)"
    EIGEN_DIR="$(cmake_val Eigen3_DIR:PATH)"
    printf "    %-24s %s\n" "CMAKE_BUILD_TYPE:"  "${BUILD_TYPE:-(none — unoptimized)}"
    printf "    %-24s %s\n" "CXX compiler:"      "${CXX_COMPILER:-(unknown)}"
    printf "    %-24s %s\n" "OpenSSL include:"   "${OPENSSL_INC:-(not found in cache)}"
    printf "    %-24s %s\n" "Eigen3 dir:"        "${EIGEN_DIR:-(not found in cache)}"
    [ -z "$BUILD_TYPE" ] && warn "CMAKE_BUILD_TYPE not set — build has no optimization flags"
fi

printf "\n  Checking binaries:\n"

# CMake SHARED targets: .so on Linux/WSL (also used when flashing), .dylib on macOS
SHLIB_EXT=".so"
[ "$PLATFORM" = "macOS" ] && SHLIB_EXT=".dylib"

EXPECTED_BINS=(
    "build/FSW/daq_bridge"
    "build/FSW/controller_service"
    "build/FSW/calibration_service"
    "build/FSW/actuator_service"
    "build/FSW/heartbeat_service"
    "build/FSW/config_broadcast_service"
    "build/FSW/libfsw_daq_lib${SHLIB_EXT}"
    "build/daq_comms/libdaq_comms_lib${SHLIB_EXT}"
)

SOURCE_DIRS=()
[ -d "$REPO/FSW/src" ]         && SOURCE_DIRS+=("$REPO/FSW/src")
[ -d "$REPO/FSW/include" ]     && SOURCE_DIRS+=("$REPO/FSW/include")
[ -d "$REPO/daq_comms/src" ]   && SOURCE_DIRS+=("$REPO/daq_comms/src")
[ -d "$REPO/daq_comms/include" ] && SOURCE_DIRS+=("$REPO/daq_comms/include")

for artifact in "${EXPECTED_BINS[@]}"; do
    full_path="$REPO/$artifact"
    if [ ! -f "$full_path" ]; then
        printf "    ${ERR} %-48s MISSING\n" "$artifact"
        error "Binary missing: $artifact — run: ./build.sh"
        continue
    fi

    # Count source files newer than this binary (.cpp/.h only — CMakeLists.txt
    # changes are tracked by cmake/make automatically and don't indicate staleness)
    newer_count=0
    if [ "${#SOURCE_DIRS[@]}" -gt 0 ]; then
        newer_count=$(find "${SOURCE_DIRS[@]}" \
            \( -name "*.cpp" -o -name "*.h" \) \
            -newer "$full_path" 2>/dev/null | wc -l | tr -d ' ')
    fi

    if [ "$newer_count" -gt 0 ]; then
        printf "    ${WARN} %-48s STALE (%d source file(s) newer)\n" "$artifact" "$newer_count"
        warn "Stale binary: $artifact ($newer_count newer source file(s)) — run: ./build.sh"
    else
        size="$(du -sh "$full_path" 2>/dev/null | cut -f1)"
        printf "    ${OK} %-48s OK  [%s]\n" "$artifact" "$size"
    fi
done

# ══ 4. NODE.JS DEPENDENCIES ═════════════════════════════════════════════════
section "NODE.JS DEPENDENCIES"

read_pkg_ver() {
    local pkgjson="$1"
    if [ -f "$pkgjson" ]; then
        sed 's/.*"version": *"\([^"]*\)".*/\1/;t;d' "$pkgjson" | head -1
    else
        echo "not installed"
    fi
}

# Read the expected version range for a package from a package.json file
# (searches both dependencies and devDependencies)
get_pkg_expected() {
    local pkgjson="$1" pkg="$2"
    [ -f "$pkgjson" ] || { echo ""; return; }
    # Escape special chars in package name (handles @scope/pkg)
    local escaped
    escaped="$(echo "$pkg" | sed 's/[@\/]/\\&/g')"
    grep "\"${escaped}\"" "$pkgjson" 2>/dev/null | head -1 \
        | sed 's/.*"[^"]*": *"\([^"]*\)".*/\1/'
}

check_node_env() {
    local label="$1" dir="$2"
    shift 2
    local key_pkgs=("$@")
    local pkgjson="$dir/package.json"
    local lockfile="$dir/package-lock.json"
    local modules="$dir/node_modules"

    printf "\n  [%s]  %s\n" "$label" "$dir"

    if [ ! -f "$lockfile" ]; then
        printf "    %b package-lock.json not found\n" "$ERR"
        error "$label: package-lock.json missing at $dir"
        return
    fi

    if [ ! -d "$modules" ]; then
        printf "    %b node_modules/ not found\n" "$ERR"
        printf "         Fix: cd %s && npm install\n" "$dir"
        error "$label: node_modules missing — run: cd $dir && npm install"
        return
    fi

    lock_mtime="$(get_mtime "$lockfile")"
    # Prefer node_modules/.package-lock.json (updated by npm v7+ on every install)
    # over the node_modules/ directory mtime, which npm does not reliably touch.
    inner_lock="$modules/.package-lock.json"
    if [ -f "$inner_lock" ]; then
        mod_mtime="$(get_mtime "$inner_lock")"
    else
        mod_mtime="$(get_mtime "$modules")"
    fi

    if [ "$lock_mtime" -gt "$mod_mtime" ]; then
        diff=$(( lock_mtime - mod_mtime ))
        printf "    ${WARN} node_modules may be STALE (package-lock.json newer by %ds)\n" "$diff"
        printf "         Fix: cd %s && npm install\n" "$dir"
        warn "$label: node_modules older than package-lock.json — run: cd $dir && npm install"
    else
        printf "    %b node_modules is up-to-date with package-lock.json\n" "$OK"
    fi

    printf "    Key package versions (expected from package.json → installed):\n"
    for pkg in "${key_pkgs[@]}"; do
        expected="$(get_pkg_expected "$pkgjson" "$pkg")"
        installed="$(read_pkg_ver "$modules/$pkg/package.json")"
        if [ "$installed" = "not installed" ]; then
            printf "      ${ERR} %-25s not installed  (package.json expects: %s)\n" \
                "$pkg" "${expected:-(not listed)}"
            error "$label: $pkg not installed in node_modules"
        elif [ -n "$expected" ]; then
            printf "      ${OK} %-25s %-14s (package.json: %s)\n" "$pkg" "$installed" "$expected"
        else
            printf "      ${OK} %-25s %s\n" "$pkg" "$installed"
        fi
    done
}

check_node_env "backend" "$REPO/web-gui/backend" \
    "ws" "tsx" "typescript" "msgpack-lite" "@iarna/toml"

check_node_env "frontend" "$REPO/web-gui/frontend" \
    "next" "react" "typescript" "vitest" "uplot"

# ══ 5. PYTHON ENVIRONMENT ═══════════════════════════════════════════════════
section "PYTHON ENVIRONMENT"

VENV="$REPO/.venv"

if [ ! -d "$VENV" ]; then
    printf "  %b .venv/ not found\n" "$ERR"
    printf "       Fix: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt\n"
    printf "       (or run: ./setup.sh)\n"
    error ".venv missing — run: ./setup.sh or python3 -m venv .venv && pip install -r requirements.txt"
else
    printf "  %b .venv/ exists\n" "$OK"

    VENV_PY_VER="$(grep '^version' "$VENV/pyvenv.cfg" 2>/dev/null | sed 's/.*= *//')"
    VENV_PY_EXE="$(grep '^executable' "$VENV/pyvenv.cfg" 2>/dev/null | sed 's/.*= *//')"
    printf "  ${OK} %-16s %s\n" "Python version:" "${VENV_PY_VER:-unknown}"
    printf "       %-16s %s\n" "Executable:"     "${VENV_PY_EXE:-unknown}"

    VENV_PYTHON="$VENV/bin/python3"
    if [ -x "$VENV_PYTHON" ]; then
        SITE_PACKAGES="$("$VENV_PYTHON" -c "import site; print(site.getsitepackages()[0])" 2>/dev/null)"
    fi
    if [ -z "${SITE_PACKAGES:-}" ] || [ ! -d "${SITE_PACKAGES:-}" ]; then
        SITE_PACKAGES="$(find "$VENV/lib" -maxdepth 3 -type d -path "*/site-packages" 2>/dev/null | head -1)"
    fi

    if [ -z "${SITE_PACKAGES:-}" ]; then
        printf "  %b Cannot locate site-packages in .venv\n" "$ERR"
        error ".venv site-packages not found"
    else
        printf "  site-packages: %s\n" "$SITE_PACKAGES"
        printf "\n  Key packages:\n"

        # Get expected version spec from requirements.txt for a package
        get_req_spec() {
            local pkg="$1"
            local req="$REPO/requirements.txt"
            [ -f "$req" ] || { echo ""; return; }
            local line
            # Match package name at start of line (case-insensitive), optionally followed by specifier
            line="$(grep -i "^${pkg}[>=<!~\[ ]" "$req" 2>/dev/null | head -1)"
            [ -z "$line" ] && line="$(grep -i "^${pkg}$" "$req" 2>/dev/null | head -1)"
            if [ -n "$line" ]; then
                # Strip the package name (word chars + dots + hyphens) from start, keep the spec
                echo "$line" | sed 's/^[A-Za-z0-9_.-]*//' | tr -d ' '
            fi
        }

        check_py_pkg() {
            local pkg="$1"
            # Normalize: lowercase, hyphens→underscores (for dist-info directory names)
            local norm="${pkg,,}"
            norm="${norm//-/_}"
            local info
            info="$(find "$SITE_PACKAGES" -maxdepth 1 -type d -name "${pkg}-*.dist-info" 2>/dev/null | head -1)"
            [ -z "$info" ] && info="$(find "$SITE_PACKAGES" -maxdepth 1 -type d -name "${norm}-*.dist-info" 2>/dev/null | head -1)"
            local expected
            expected="$(get_req_spec "$pkg")"
            if [ -n "$info" ]; then
                local ver
                ver="$(grep '^Version:' "${info}/METADATA" 2>/dev/null | head -1 | cut -d' ' -f2)"
                if [ -n "$expected" ]; then
                    printf "    ${OK} %-16s %-14s (requirements.txt: %s%s)\n" \
                        "$pkg" "${ver:-?}" "$pkg" "$expected"
                else
                    printf "    ${OK} %-16s %s\n" "$pkg" "${ver:-?}"
                fi
            else
                if [ -n "$expected" ]; then
                    printf "    ${ERR} %-16s NOT INSTALLED  (requirements.txt: %s%s)\n" \
                        "$pkg" "$pkg" "$expected"
                else
                    printf "    ${ERR} %-16s NOT INSTALLED\n" "$pkg"
                fi
                error "Python package $pkg not installed — run: .venv/bin/pip install -r requirements.txt"
            fi
        }

        printf "    (expected specs from requirements.txt → installed in .venv)\n"
        check_py_pkg "numpy"
        check_py_pkg "scipy"
        check_py_pkg "PyQt6"
        check_py_pkg "websockets"
        check_py_pkg "duckdb"
        check_py_pkg "psutil"
        check_py_pkg "matplotlib"
        check_py_pkg "pyqtgraph"
        check_py_pkg "pyserial"
    fi
fi

# ══ 6. ELODIN DB ════════════════════════════════════════════════════════════
section "ELODIN DB"

ELODIN_BIN=""
if command -v elodin-db &>/dev/null; then
    ELODIN_BIN="$(command -v elodin-db)"
else
    for p in "$HOME/.cargo/bin/elodin-db" "/usr/local/bin/elodin-db" "/usr/bin/elodin-db"; do
        [ -x "$p" ] && { ELODIN_BIN="$p"; break; }
    done
fi

if [ -z "$ELODIN_BIN" ]; then
    printf "  %b elodin-db not found (checked PATH and ~/.cargo/bin/)\n" "$ERR"
    error "elodin-db not found — install from Elodin or ensure ~/.cargo/bin is in PATH"
else
    ELODIN_VER="$("$ELODIN_BIN" --version 2>/dev/null || echo "unknown")"
    printf "  ${OK} %-16s %s\n" "elodin-db:" "$ELODIN_BIN"
    printf "  ${OK} %-16s %s\n" "version:" "$ELODIN_VER"
    if [ "$PLATFORM" = "WSL" ] && echo "$ELODIN_BIN" | grep -q "^/mnt/"; then
        printf "  %b elodin-db is on Windows filesystem — may have interop issues\n" "$WARN"
        warn "elodin-db at $ELODIN_BIN is on Windows filesystem — install to ~/.cargo/bin in WSL"
    fi
fi

# ══ 7. GIT STATE ════════════════════════════════════════════════════════════
section "GIT STATE"

cd "$REPO" || exit 1

GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
DIRTY_COUNT="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

printf "  %-16s %s\n" "Branch:"  "$GIT_BRANCH"
printf "  %-16s %s\n" "Commit:"  "$GIT_COMMIT"

if [ "$DIRTY_COUNT" -gt 0 ]; then
    printf "  ${WARN} %-16s %d uncommitted change(s)\n" "Working tree:" "$DIRTY_COUNT"
    warn "Git tree has $DIRTY_COUNT uncommitted file(s)"
else
    printf "  ${OK} %-16s clean\n" "Working tree:"
fi

printf "\n  Submodules:\n"
while IFS= read -r line; do
    status_char="${line:0:1}"
    commit="${line:1:40}"
    rest="${line:42}"
    path="$(echo "$rest" | awk '{print $1}')"
    desc="$(echo "$rest" | awk '{$1=""; print substr($0,2)}')"

    case "$status_char" in
        ' ')
            printf "    ${OK} %-42s %s %s\n" "$path" "$commit" "$desc"
            ;;
        '+')
            printf "    ${WARN} %-42s %s (DIFFERENT from expected)\n" "$path" "$commit"
            warn "Submodule $path is at a different commit — run: git submodule update"
            ;;
        '-')
            printf "    ${ERR} %-42s NOT INITIALIZED\n" "$path"
            error "Submodule $path not initialized — run: git submodule update --init --recursive"
            ;;
        'U')
            printf "    ${ERR} %-42s MERGE CONFLICT\n" "$path"
            error "Submodule $path has merge conflicts"
            ;;
        *)
            printf "    ${WARN} %-42s status: '%s'\n" "$path" "$status_char"
            ;;
    esac
done < <(git submodule status 2>/dev/null)

# ══ 8. CONFIG ═══════════════════════════════════════════════════════════════
section "CONFIG"

CONFIG_TOML="$REPO/config/config.toml"
if [ ! -f "$CONFIG_TOML" ]; then
    printf "  %b config/config.toml NOT FOUND — system cannot start without it\n" "$ERR"
    error "config/config.toml missing"
else
    printf "  %b config/config.toml exists\n" "$OK"
    # Extract a few top-level values
    toml_val() { grep "^$1" "$CONFIG_TOML" 2>/dev/null | head -1 | sed 's/[^=]*= *//' | tr -d '"'; }
    MODE="$(toml_val 'mode')"
    STATE="$(toml_val 'state')"
    printf "    %-16s %s\n" "mode:"  "${MODE:-(unset)}"
    printf "    %-16s %s\n" "state:" "${STATE:-(unset)}"
fi

# ══ 9. PORT CONFLICTS ═══════════════════════════════════════════════════════
section "PORT CONFLICTS"

PORTS_TO_CHECK=(
    "2240:Elodin DB TCP"
    "8081:Backend WebSocket"
    "8082:Backend API/HTTP"
    "9090:Elodin Relay WebSocket"
    "9091:Elodin Relay TCP forward"
    "3000:Frontend (Next.js)"
)

ANY_IN_USE=false
for entry in "${PORTS_TO_CHECK[@]}"; do
    port="${entry%%:*}"
    label="${entry##*:}"
    if port_in_use "$port"; then
        owner="$(port_owner "$port")"
        printf "  ${WARN} Port %-5s (%s) is IN USE" "$port" "$label"
        [ -n "$owner" ] && printf " — process: %s" "$owner"
        printf "\n"
        warn "Port $port ($label) already in use${owner:+ by $owner}"
        ANY_IN_USE=true
    else
        printf "  ${OK} Port %-5s (%s) is free\n" "$port" "$label"
    fi
done

if [ "$ANY_IN_USE" = true ]; then
    printf "\n  %bNote:%b If ports show the correct services (elodin-db, node, next-server),\n" "$CYAN" "$NC"
    printf "         the system is already running — these are not errors.\n"
fi

# ══ SUMMARY ═════════════════════════════════════════════════════════════════
section "SUMMARY"

if [ "${#WARNINGS[@]}" -eq 0 ]; then
    printf "\n  %b%bALL CHECKS PASSED — environment looks healthy.%b\n\n" "$GREEN" "$BOLD" "$NC"
else
    printf "\n  Found %d issue(s):\n\n" "${#WARNINGS[@]}"
    for w in "${WARNINGS[@]}"; do
        if [[ "$w" == ERROR:* ]]; then
            printf "  ${RED}✗${NC}  %s\n" "${w#ERROR: }"
        else
            printf "  ${YELLOW}⚠${NC}  %s\n" "${w#WARN:  }"
        fi
    done
    printf "\n"
fi
