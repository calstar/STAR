#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# STAR Monorepo — Newcomer Setup Script
# ─────────────────────────────────────────────────────────────────────────────
#
# Dispatcher over the per-project setup scripts. Each subproject owns its own
# install steps (daq-server/setup.sh, firmware/setup.sh, EngineDesign/setup.sh,
# pid-designer/setup.sh, onshape-viewer/setup.sh) so you only pay for what you
# use — cloning the repo for the P&ID editor shouldn't force you to build
# Rust + elodin-db.
#
# ─── Usage ───────────────────────────────────────────────────────────────────
#
#   bash setup.sh                    # interactive menu
#   bash setup.sh --all              # install everything
#   bash setup.sh --daq-server       # single project
#   bash setup.sh --daq-server --firmware
#   bash setup.sh --engine-design --ci   # flags pass through to sub-scripts
#   bash setup.sh --list             # list available projects
#   bash setup.sh --help
#
# Non-interactive:
#   SETUP_YES=1 bash setup.sh --all  # or --yes / -y
#
# ─── Windows users ───────────────────────────────────────────────────────────
#
# This repo has symlinks committed to git. macOS and Linux handle them
# automatically; Windows does not unless you enable symlink support BEFORE
# cloning:
#
#   git config --global core.symlinks true
#
# (Or use WSL — strongly recommended over native Windows for this codebase.)
# Without this, files that should be symlinks become plain text files
# containing the link target, and builds will fail with confusing errors.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/setup_common.sh"

# ─── Project registry ────────────────────────────────────────────────────────
# One row per project: key | display name | script path | one-line description
# The dispatcher runs them in this order when multiple are selected — put the
# lightest ones first so quick projects finish before slow ones (daq-server).
PROJECTS=(
  "pid-designer|P&ID Designer|pid-designer/setup.sh|FastAPI + React P&ID editor (quick)"
  "onshape-viewer|Onshape CM Viewer|onshape-viewer/setup.sh|FastAPI + React/three.js CAD centre-of-mass viewer (quick)"
  "engine-design|Engine Design|EngineDesign/setup.sh|Python physics pipeline + FastAPI + React"
  "firmware|Firmware|firmware/setup.sh|PlatformIO for ESP32 board firmware"
  "daq-server|DAQ Server|daq-server/setup.sh|C++ + Rust + Python + Node — the big one"
)

project_field() {
  # $1 = row, $2 = 1..4 (key/name/path/desc)
  awk -F'|' -v i="$2" '{print $i}' <<< "$1"
}

print_project_list() {
  printf "\n  Available projects:\n\n"
  local i=1
  for row in "${PROJECTS[@]}"; do
    printf "    %d) %-15s — %s\n" "$i" "$(project_field "$row" 1)" "$(project_field "$row" 4)"
    i=$((i+1))
  done
  printf "\n"
}

show_help() {
  awk '/^#!/{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
  print_project_list
  cat <<'EOF'
  Flags:
    --all                Install every project
    --daq-server         Install daq-server
    --firmware           Install firmware
    --engine-design      Install EngineDesign
    --pid-designer       Install pid-designer
    --onshape-viewer     Install onshape-viewer
    --list               List projects and exit
    --yes, -y            Accept all prompts (non-interactive)
    --no-hook            Don't offer daq-server pre-push format hook
    --help, -h           This help

  Any additional flags are passed through to each project's setup.sh, e.g.:
    bash setup.sh --engine-design --ci --no-frontend
    bash setup.sh --daq-server --no-build

EOF
}

# ─── Argument parsing ────────────────────────────────────────────────────────
SELECTED=()
PASSTHRU=()
DID_LIST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --all)
      for row in "${PROJECTS[@]}"; do SELECTED+=("$(project_field "$row" 1)"); done
      ;;
    --daq-server)     SELECTED+=("daq-server") ;;
    --firmware)       SELECTED+=("firmware") ;;
    --engine-design)  SELECTED+=("engine-design") ;;
    --pid-designer)   SELECTED+=("pid-designer") ;;
    --onshape-viewer) SELECTED+=("onshape-viewer") ;;
    --list)          DID_LIST=1 ;;
    --yes|-y)        export SETUP_YES=1; PASSTHRU+=("--yes") ;;
    --no-hook)       PASSTHRU+=("--no-hook") ;;
    --help|-h)       show_help; exit 0 ;;
    # Anything else is passed through to sub-scripts (e.g. --ci, --no-build)
    *)               PASSTHRU+=("$1") ;;
  esac
  shift
done

if [ "$DID_LIST" = "1" ]; then
  print_project_list
  exit 0
fi

# ─── Sanity ──────────────────────────────────────────────────────────────────
step "Sanity checks"
if [ ! -d daq-server ] || [ ! -d firmware ]; then
  fail "Run this from the STAR repo root (expected daq-server/ and firmware/)"
fi
ok "Repo root: $REPO_ROOT"

OS="$(detect_os)"
case "$OS" in
  macOS|Linux|WSL) ok "Detected $OS" ;;
  *) fail "Unsupported OS: $OS — use macOS, Linux, or WSL" ;;
esac

# ─── Interactive selection ───────────────────────────────────────────────────
if [ ${#SELECTED[@]} -eq 0 ]; then
  if [ ! -t 0 ] || [ "${SETUP_YES:-0}" = "1" ]; then
    # Non-interactive with no selection = default to --all (matches the
    # old setup.sh behavior for CI / provisioning scripts calling us).
    warn "No projects selected and non-interactive; defaulting to --all"
    for row in "${PROJECTS[@]}"; do SELECTED+=("$(project_field "$row" 1)"); done
  else
    print_project_list
    cat <<'EOF'
  Which projects do you want to set up?
    - Enter a comma- or space-separated list of numbers (e.g. "1 3" or "1,3")
    - Enter "a" for all
    - Enter "q" to quit

EOF
    read -rp "  Choice: " REPLY || REPLY=""
    REPLY="${REPLY// /,}"
    case "$REPLY" in
      q|Q|"") warn "No selection — exiting"; exit 0 ;;
      a|A|all)
        for row in "${PROJECTS[@]}"; do SELECTED+=("$(project_field "$row" 1)"); done
        ;;
      *)
        IFS=',' read -ra CHOICES <<< "$REPLY"
        for c in "${CHOICES[@]}"; do
          c="${c// /}"
          [ -z "$c" ] && continue
          if ! [[ "$c" =~ ^[0-9]+$ ]] \
             || [ "$c" -lt 1 ] || [ "$c" -gt "${#PROJECTS[@]}" ]; then
            fail "Invalid choice: '$c' (want 1..${#PROJECTS[@]})"
          fi
          SELECTED+=("$(project_field "${PROJECTS[$((c-1))]}" 1)")
        done
        ;;
    esac
  fi
fi

# Deduplicate while preserving PROJECTS order.
FINAL=()
for row in "${PROJECTS[@]}"; do
  key="$(project_field "$row" 1)"
  for sel in "${SELECTED[@]}"; do
    if [ "$sel" = "$key" ]; then
      FINAL+=("$row")
      break
    fi
  done
done

if [ ${#FINAL[@]} -eq 0 ]; then
  fail "No valid projects selected."
fi

# ─── Shared prep ─────────────────────────────────────────────────────────────
# Global black install: format.sh and the pre-push hook run outside any venv,
# so black needs to be on the global $PATH. Every project's format-check ends
# up calling the same top-level format.sh, so we install it once here rather
# than per-project.
step "Shared: pinned global black (for format.sh + pre-push hook)"
ensure_pinned_black

# Windows-symlink foot-gun sanity: if the DAQv2-Comms symlink got turned into
# a text file by a Windows clone, every project's build later will fail with
# confusing errors. Detect it once, upfront.
LINK="$REPO_ROOT/firmware/libraries/DAQv2-Comms"
if [ -e "$LINK" ] && [ ! -L "$LINK" ] && [ -f "$LINK" ]; then
  warn "firmware/libraries/DAQv2-Comms is a plain file, not a symlink."
  warn "You likely cloned on Windows without symlinks enabled. Re-clone with:"
  warn "  git config --global core.symlinks true"
fi

# ─── Dispatch ────────────────────────────────────────────────────────────────
printf "\n${BOLD}Plan:${NC} setup will run these projects in order:\n"
for row in "${FINAL[@]}"; do
  printf "    - %s (%s)\n" "$(project_field "$row" 2)" "$(project_field "$row" 3)"
done
printf "\n"

FAILED=()
COMPLETED=()
for row in "${FINAL[@]}"; do
  key="$(project_field "$row" 1)"
  name="$(project_field "$row" 2)"
  script="$(project_field "$row" 3)"

  step "▶ $name — $script"

  if [ ! -f "$REPO_ROOT/$script" ]; then
    warn "Setup script missing: $script — skipping"
    FAILED+=("$name (script missing)")
    continue
  fi

  # We run each project's setup as a *subshell* rather than sourcing so a
  # single project's failure doesn't kill the dispatcher for the others,
  # and each project sees a clean environment.
  if bash "$REPO_ROOT/$script" "${PASSTHRU[@]}"; then
    COMPLETED+=("$name")
    ok "$name setup complete"
  else
    rc=$?
    FAILED+=("$name (exit $rc)")
    warn "$name failed with exit $rc — continuing with remaining projects"
  fi
done

# ─── Summary ─────────────────────────────────────────────────────────────────
step "Setup summary"

if [ ${#COMPLETED[@]} -gt 0 ]; then
  printf "  ${GREEN}✓ Completed:${NC}\n"
  for n in "${COMPLETED[@]}"; do printf "      - %s\n" "$n"; done
fi

if [ ${#FAILED[@]} -gt 0 ]; then
  printf "  ${RED}✗ Failed:${NC}\n"
  for n in "${FAILED[@]}"; do printf "      - %s\n" "$n"; done
  printf "\n"
  fail "One or more project setups failed. See output above."
fi

cat <<EOF

All done. Per-project next-step instructions were printed above.

Common reminders:
  • Add \$HOME/.cargo/bin to \$PATH if you set up daq-server
  • Add pip --user bin dir to \$PATH if 'black' or 'pio' aren't found
      macOS: \$HOME/Library/Python/<ver>/bin
      Linux: \$HOME/.local/bin

EOF
