#!/usr/bin/env bash
# scripts/setup_common.sh — shared helpers for STAR setup scripts.
#
# Source this from each per-project setup.sh:
#
#   SETUP_COMMON="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/setup_common.sh"
#   # shellcheck disable=SC1090
#   source "$SETUP_COMMON"
#
# Provides:
#   - Coloured step/ok/warn/fail helpers
#   - OS detection (Darwin / Linux / WSL)
#   - ensure_pinned_black — installs black==25.11.0 to pip --user
#   - ensure_homebrew / ensure_apt_packages helpers
#   - prompt_yes_no + AUTO_YES support (respects $SETUP_YES=1)
#   - install_star_aliases — adds scripts/aliases.sh to the user's shell rc
#   - bootstrap_env_files — creates .env / auth/.env with a generated secret

# Guard against double-source (per-project setup.sh + dispatcher may both source).
if [ "${_STAR_SETUP_COMMON_LOADED:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
_STAR_SETUP_COMMON_LOADED=1

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

step()  { printf "\n${CYAN}── %s ──${NC}\n" "$1"; }
ok()    { printf "  ${GREEN}✓${NC} %s\n" "$1"; }
warn()  { printf "  ${YELLOW}!${NC} %s\n" "$1"; }
fail()  { printf "  ${RED}✗${NC} %s\n" "$1" >&2; exit 1; }
info()  { printf "  %s\n" "$1"; }

# ─── OS detection ────────────────────────────────────────────────────────────
detect_os() {
  local kernel
  kernel="$(uname -s)"
  case "$kernel" in
    Darwin) echo "macOS" ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        echo "WSL"
      else
        echo "Linux"
      fi
      ;;
    *) echo "Unknown:$kernel" ;;
  esac
}

# Return 0 if macOS, 1 otherwise.
is_macos() { [ "$(detect_os)" = "macOS" ]; }
# Return 0 if Linux or WSL.
is_linux() { local os; os="$(detect_os)"; [ "$os" = "Linux" ] || [ "$os" = "WSL" ]; }

# ─── Interactive prompts ─────────────────────────────────────────────────────
# Usage: prompt_yes_no "Enable X?" default_answer
#   default_answer: y or n (used when non-interactive or empty response)
# Respects $SETUP_YES=1 (forces yes) and $SETUP_NO=1 (forces no).
prompt_yes_no() {
  local question="$1"
  local default="${2:-y}"
  local reply

  if [ "${SETUP_YES:-0}" = "1" ]; then return 0; fi
  if [ "${SETUP_NO:-0}" = "1" ]; then return 1; fi

  if [ ! -t 0 ]; then
    # Non-interactive: use default.
    case "$default" in [Yy]*) return 0 ;; *) return 1 ;; esac
  fi

  local prompt_suffix
  case "$default" in [Yy]*) prompt_suffix="[Y/n]" ;; *) prompt_suffix="[y/N]" ;; esac

  read -rp "  $question $prompt_suffix " reply || reply=""
  reply="${reply:-$default}"
  case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# ─── Package helpers ─────────────────────────────────────────────────────────
ensure_homebrew() {
  if ! command -v brew >/dev/null 2>&1; then
    fail "Homebrew not found. Install from https://brew.sh first, then re-run."
  fi
  ok "Homebrew found: $(brew --version | head -1)"
}

# Install apt packages that are actually missing.
#
# Uses two-tier check:
#   1. Skip pkgs whose functionality is already provided by *any* installed
#      package (e.g. python3-venv can be satisfied by python3.12-venv). This
#      is done by the caller via ensure_capability wrappers, not here.
#   2. dpkg -s: skip if that exact package name is installed.
#
# If any packages remain, we need sudo. If sudo is not available (no tty for
# prompting, no cached credentials), print a helpful command the user can run
# manually and fail — don't hang waiting for a password we can't get.
ensure_apt_packages() {
  local pkgs=("$@")
  local missing=()
  for p in "${pkgs[@]}"; do
    if ! dpkg -s "$p" >/dev/null 2>&1; then
      missing+=("$p")
    fi
  done
  if [ ${#missing[@]} -eq 0 ]; then
    ok "apt packages already present"
    return 0
  fi

  info "Installing apt packages: ${missing[*]}"
  if sudo -n true 2>/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y "${missing[@]}"
  elif [ -t 0 ]; then
    # Interactive — sudo can prompt.
    sudo apt-get update -qq
    sudo apt-get install -y "${missing[@]}"
  else
    warn "sudo required but not available (no tty, no cached creds)."
    warn "Run this manually then re-invoke setup:"
    warn "  sudo apt-get install -y ${missing[*]}"
    return 1
  fi
}

# Return 0 if `python3 -m venv` works (venv module is available). On Debian /
# Ubuntu this often requires python3-venv, but the module can also come from
# python3.X-venv or a manylinux wheel — a functional test is more reliable
# than dpkg. Callers should try this first before falling back to apt.
python_venv_available() {
  python3 -c 'import venv; import ensurepip' >/dev/null 2>&1
}

# Ensure `python3 -m venv` works. Prefers the functional test; only falls
# back to apt if the module truly isn't available.
ensure_python_venv() {
  if python_venv_available; then
    ok "python3 -m venv works"
    return 0
  fi
  if is_linux; then
    # Try the version-suffixed package first (satisfies `import ensurepip` on
    # Ubuntu 22.04+), then the generic name.
    local py_ver
    py_ver="$(python3 -c 'import sys; print(f"python3.{sys.version_info.minor}")')"
    ensure_apt_packages "${py_ver}-venv" python3-venv || \
      ensure_apt_packages python3-venv
  fi
  python_venv_available || fail "python3 -m venv still not working after install attempt"
}

# ─── Pinned black install (shared by daq-server + firmware format hooks) ─────
# Reasons for pinning to 25.11.0 (also documented in setup.sh and CI):
#   (1) format.sh runs outside any venv, so black must be on $PATH globally.
#   (2) brew's black tracks latest (26+), which requires Python ≥3.10; macOS
#       system Python is 3.9, so brew's black may be unusable.
#   (3) Pinning keeps CI and laptops in sync — same pin as
#       daq-server/requirements.txt and .github/workflows/daq-server-ci.yml.
ensure_pinned_black() {
  local wanted="25.11.0"
  if command -v black >/dev/null 2>&1; then
    local have
    have="$(black --version 2>/dev/null | awk '{print $2}' | head -1)"
    if [ "$have" = "$wanted" ]; then
      ok "black $wanted already installed"
      return 0
    fi
    warn "black on PATH is $have; want $wanted — reinstalling"
  fi

  # ensure_pinned_black runs in the top-level shared prep, before any per-
  # project setup gets a chance to install python3-pip. On a truly fresh
  # Ubuntu (or a mac without pip on PATH), bootstrap pip3 first.
  if ! command -v pip3 >/dev/null 2>&1; then
    info "pip3 not found — bootstrapping"
    if is_linux; then
      ensure_apt_packages python3 python3-pip
    elif is_macos; then
      # macOS python3 comes with ensurepip; try that first.
      python3 -m ensurepip --user --upgrade >/dev/null 2>&1 || \
        fail "pip3 unavailable and 'python3 -m ensurepip' failed — install python3 first"
    fi
  fi

  info "pip3 install --user black==$wanted"
  pip3 install --user --quiet "black==$wanted" \
    || pip3 install --user --quiet --break-system-packages "black==$wanted" \
    || fail "black install failed"
  ok "black $wanted installed (pip --user)"

  # Compute the pip --user bin dir so we can hint about $PATH.
  local py_ver py_user_bin
  py_ver="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  if is_macos; then
    py_user_bin="$HOME/Library/Python/$py_ver/bin"
  else
    py_user_bin="$HOME/.local/bin"
  fi
  if ! command -v black >/dev/null 2>&1; then
    warn "black installed but not on \$PATH. Add to your shell rc:"
    warn "  export PATH=\"$py_user_bin:\$PATH\""
  fi
}

# ─── Repo root discovery ─────────────────────────────────────────────────────
# Locates the STAR repo root by walking up from a given directory looking for
# setup.sh + daq-server + firmware. Callers pass their own script dir.
find_repo_root() {
  local start="${1:-$PWD}"
  local dir="$start"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/setup.sh" ] && [ -d "$dir/daq-server" ] && [ -d "$dir/firmware" ]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

# ─── Shell aliases ───────────────────────────────────────────────────────────
# Adds `source <repo>/scripts/aliases.sh` to the user's shell rc, which gives
# them the uniform per-project aliases (engine-dev, pid-attach, daq-logs, …).
# Idempotent, and never appends a duplicate.
#
# Usage: install_star_aliases <repo_root>
install_star_aliases() {
  local repo_root="$1"
  local aliases_file="$repo_root/scripts/aliases.sh"
  local rc line

  if [ ! -f "$aliases_file" ]; then
    warn "scripts/aliases.sh not found — skipping alias setup"
    return 0
  fi

  # Which file the user's shell actually reads. macOS Terminal starts bash as a
  # *login* shell, which reads .bash_profile and never .bashrc.
  case "${SHELL:-/bin/bash}" in
    */zsh)
      rc="$HOME/.zshrc"
      ;;
    *)
      if [ "$(detect_os)" = "macOS" ] && [ -f "$HOME/.bash_profile" ]; then
        rc="$HOME/.bash_profile"
      else
        rc="$HOME/.bashrc"
      fi
      ;;
  esac

  # Already set up? Either path counts: daq-server/tools/aliases.sh is a shim
  # that sources the same file, so adding ours too would just load it twice.
  if [ -f "$rc" ] && grep -qF "scripts/aliases.sh" "$rc"; then
    ok "STAR aliases already in $(basename "$rc")"
    return 0
  fi
  if [ -f "$rc" ] && grep -qF "daq-server/tools/aliases.sh" "$rc"; then
    ok "STAR aliases already loaded in $(basename "$rc") (via the daq-server shim)"
    warn "That still works. To use the canonical path, replace that line with:"
    warn "  source \"$aliases_file\""
    return 0
  fi

  if ! prompt_yes_no "Add STAR aliases (engine-dev, daq-logs, star-help, …) to $(basename "$rc")?" y; then
    warn "Skipped. To add them later:"
    warn "  echo 'source \"$aliases_file\"' >> $rc"
    return 0
  fi

  line="source \"$aliases_file\""
  {
    printf '\n# STAR monorepo aliases — run `star-help` for the list\n'
    printf '%s\n' "$line"
  } >> "$rc"

  ok "Added STAR aliases to $rc"
  ok "Run 'source $rc' (or open a new shell), then 'star-help'"
}

# ─── Deployment env files ────────────────────────────────────────────────────
# Creates .env and auth/.env from their .example templates, generating a real
# JWT_SECRET and writing the SAME value to both -- they have to match or every
# app rejects every login. Never overwrites an existing file.
#
# Usage: bootstrap_env_files <repo_root>
bootstrap_env_files() {
  local repo_root="$1"
  local root_env="$repo_root/.env"
  local auth_env="$repo_root/auth/.env"
  local secret=""

  if [ -f "$root_env" ] && [ -f "$auth_env" ]; then
    ok ".env and auth/.env already exist — leaving them alone"
    return 0
  fi

  # Reuse the secret already in place, so adding the missing file cannot
  # desynchronise a working pair.
  if [ -f "$root_env" ]; then
    secret="$(sed -n 's/^JWT_SECRET=//p' "$root_env" | head -1)"
  elif [ -f "$auth_env" ]; then
    secret="$(sed -n 's/^JWT_SECRET=//p' "$auth_env" | head -1)"
  fi
  if [ -z "$secret" ] || [ "$secret" = "replace-with-a-long-random-string" ]; then
    secret="$(python3 -c 'import secrets; print(secrets.token_hex(32))' 2>/dev/null)" || secret=""
  fi
  if [ -z "$secret" ]; then
    warn "Could not generate a JWT_SECRET (python3 missing?) — skipping env setup"
    return 0
  fi

  _write_env_from_example() {
    local example="$1" target="$2"
    [ -f "$target" ] && return 0
    [ -f "$example" ] || { warn "Missing $example — skipping $target"; return 0; }
    sed "s|^JWT_SECRET=.*|JWT_SECRET=$secret|" "$example" > "$target"
    chmod 600 "$target"
    ok "Created ${target#"$repo_root"/} (JWT_SECRET generated)"
  }

  _write_env_from_example "$repo_root/.env.example" "$root_env"
  _write_env_from_example "$repo_root/auth/.env.example" "$auth_env"
  unset -f _write_env_from_example

  # The Flask session key is independent of JWT_SECRET and only the auth
  # service uses it, so it can be generated freely.
  if [ -f "$auth_env" ] && grep -q '^FLASK_SECRET_KEY=replace-with' "$auth_env"; then
    local flask_key
    flask_key="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
    sed -i.bak "s|^FLASK_SECRET_KEY=.*|FLASK_SECRET_KEY=$flask_key|" "$auth_env"
    rm -f "$auth_env.bak"
  fi

  warn "auth/.env still needs your Google OAuth credentials before deploying."
  warn "  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — see deploy/README.md"
}
