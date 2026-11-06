#!/usr/bin/env bash
# The media laptop, in one command: the desert's video machine.
#
# Brings up everything video needs on the Mac that has the UT-130 receiver:
#   * the video gateway -- MediaMTX plus the video agent that keeps recordings
#     (scripts/video-gateway.sh), kept awake while it runs;
#   * HiDes Viewer, which receives the HiDes link and forwards it to the gateway.
# Then it prints exactly what to type on the other machines.
#
#   daq-server/scripts/media-laptop.sh               check, set up what is missing, start
#   daq-server/scripts/media-laptop.sh --no-viewer   the gateway only (no UT-130 today)
#   daq-server/scripts/media-laptop.sh --check       check and print the addresses; start nothing
#
# Safe to re-run: passwords are asked for only when missing, and an already-running gateway
# is reported, not doubled. Ctrl-C stops the gateway; HiDes Viewer is left for you to close.
# Recordings land in daq-server/video/recordings/ on this Mac.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAQ="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$DAQ/.." && pwd)"
LIVE="$REPO/live-video"
APP="$LIVE/dist/HiDes Viewer.app"

viewer=1
check_only=0
for a in "$@"; do
  case "$a" in
    --no-viewer) viewer=0 ;;
    --check) check_only=1 ;;
    -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $a (see --help)" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad() { printf '  \033[33mneed\033[0m %s\n' "$*"; }

[[ "$(uname -s)" == "Darwin" ]] || { echo "media-laptop.sh is for the media Mac. On Linux run scripts/video-gateway.sh." >&2; exit 1; }

# ── 1. What this Mac needs. Name every gap before starting anything. ─────────────
bold "Checking this Mac"
missing=0
need() {   # need CMD "how to install"
  if command -v "$1" >/dev/null 2>&1; then ok "$1"; else bad "$1 -- $2"; missing=1; fi
}
need node "brew install node"
need ffmpeg "brew install ffmpeg"
if [[ $viewer == 1 ]]; then
  if [[ -d "$APP" ]]; then
    ok "HiDes Viewer ($APP)"
  else
    need swift "install Xcode or the Command Line Tools (xcode-select --install)"
    if command -v brew >/dev/null 2>&1 && brew --prefix libusb >/dev/null 2>&1 && [[ -d "$(brew --prefix libusb)/lib" ]]; then
      ok "libusb (to build HiDes Viewer)"
    else
      bad "libusb -- brew install libusb"; missing=1
    fi
  fi
fi
if [[ $missing == 1 ]]; then
  echo
  echo "Install the above, then run this again. Nothing was started."
  exit 1
fi
bash "$HERE/video-gateway.sh" --fetch && ok "gateway binary (MediaMTX)"

if lsof -nP -iTCP:8887 -sTCP:LISTEN >/dev/null 2>&1; then
  running=1
  ok "a gateway is already running on this Mac (port 8887)"
else
  running=0
fi

# ── 2. Passwords, once. ───────────────────────────────────────────────────────────
if [[ $check_only == 0 ]]; then
  echo
  bold "Passwords (kept on this Mac only, in daq-server/video/, never committed)"
  if [[ -s "$DAQ/video/gateway.password" ]]; then
    ok "gateway password is set (the DAQ laptop uses it)"
  else
    echo "  The DAQ laptop needs a password to drive this gateway."
    bash "$HERE/video-gateway.sh" --set-password
  fi
  if [[ -s "$DAQ/video/obs.password" ]]; then
    ok "OBS password is set"
  else
    read -r -p "  Will a streaming laptop pull feeds into OBS from here? [y/N] " yn
    if [[ "$yn" =~ ^[Yy] ]]; then bash "$HERE/video-gateway.sh" --set-obs-password; else ok "no OBS access (run with --set-obs-password later if needed)"; fi
  fi
fi

# ── 3. What to type elsewhere. ───────────────────────────────────────────────────
name="$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"
ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '?')"
echo
bold "This Mac is $name ($ip)"
echo "  DAQ laptop     Video view > Edit > Gateway: host $name, and the gateway password"
echo "  HiDes Viewer   Send to UDP: localhost:5600 (the HiDes stream's port in Edit; 5600-5609)"
if [[ -s "$DAQ/video/obs.password" ]]; then
  echo "  OBS            Media Source: rtsp://$name:8554/raw/<stream id>  (user obs; Edit shows each URL)"
fi
echo "  Recordings     $DAQ/video/recordings/"
echo "  Keep the lid open and the charger in: a sleeping Mac is a dark video wall."
if [[ "$name" =~ ^[A-Za-z]+s-MacBook ]]; then
  echo "  Tip: a short name is easier to type on the day:  sudo scutil --set LocalHostName <short-name>"
fi
fw="$(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null || true)"
if [[ "$fw" == *"enabled"* ]]; then
  echo "  macOS firewall is on: allow incoming connections for node and mediamtx when asked."
fi
[[ $check_only == 1 ]] && exit 0

# ── 4. Start. ─────────────────────────────────────────────────────────────────────
echo
if [[ $viewer == 1 ]]; then
  if [[ ! -d "$APP" ]]; then
    bold "Building HiDes Viewer (first time only, a few minutes)"
    (cd "$LIVE" && sh scripts/make-app.sh)
  fi
  open "$APP"
  ok "HiDes Viewer opened -- press Start, and turn on Send to UDP (localhost:5600)"
fi

if [[ $running == 1 ]]; then
  echo
  echo "The gateway is already running here; leaving it as it is. Stop it where it was started."
  exit 0
fi

bold "Starting the gateway (Ctrl-C stops it)"
exec bash "$HERE/video-gateway.sh"
