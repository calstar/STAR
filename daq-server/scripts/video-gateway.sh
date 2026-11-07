#!/usr/bin/env bash
# Run the VIDCOMM video gateway: the pinned MediaMTX with daq-server/video/mediamtx.yml.
#
# The same script everywhere, so the workspace and the desert run one version and one
# config: the sensor-video service runs it on star-rfs, ./dev.sh runs it on a laptop,
# and on the media Mac you run it yourself. On macOS it holds off idle sleep for as long
# as it runs (caffeinate -i), so a quiet countdown does not put the gateway to sleep.
#
#   scripts/video-gateway.sh              download if needed, then run in the foreground
#   scripts/video-gateway.sh --fetch      download and verify only (setup / CI)
#   scripts/video-gateway.sh --print-bin  print the binary's path (downloading if needed)
#   scripts/video-gateway.sh --set-password   set the password a DAQ backend on another
#                                            machine uses to reach this gateway (desert)
#   scripts/video-gateway.sh --set-obs-password   set the read-only password OBS uses to
#                                                pull the feeds over RTSP (:8554)
#
# Remote access: with a password (VIDEO_GATEWAY_PASSWORD, or the gitignored file
# video/gateway.password that --set-password writes) the gateway admits user "daq" from
# any address, for its control API and WebRTC reads. Without one, only this machine can
# use it. Enter the same password in the Video view's Edit > Gateway on the DAQ laptop.
#
# Settings can be overridden with MTX_<KEY> environment variables (MediaMTX's own
# mechanism), e.g. MTX_APIADDRESS=127.0.0.1:18887.
set -euo pipefail

VERSION="v1.21.3"
# From the release's checksums.sha256. Changing VERSION means changing these.
sha256_for() {
  case "$1" in
    linux_amd64)  echo 0a2ea7eba96023631efa1bea7804823a9145b043b6646a8a05798d4ac24ed635 ;;
    linux_arm64)  echo 27f038237cb5f77a724f6afc58eca2798f2bc4edf9989895631a80eeb41a4fe2 ;;
    darwin_amd64) echo 8a8416ee2ff5d17d9366498b6d88b76ab6d3afcda50b6d7321ccddb349bdbaf2 ;;
    darwin_arm64) echo bc1a0762fd18ffb413bcd81dcb9a072ac159fbd1f27e79ac6f14598aaac5ed3f ;;
    *) return 1 ;;
  esac
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIDEO_DIR="$(cd "$HERE/../video" && pwd)"
CONFIG="${VIDEO_GATEWAY_CONFIG:-$VIDEO_DIR/mediamtx.yml}"
BIN_DIR="$VIDEO_DIR/.bin/$VERSION"
BIN="$BIN_DIR/mediamtx"

platform() {
  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) echo "video-gateway: unsupported OS $(uname -s)" >&2; return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) echo "video-gateway: unsupported CPU $(uname -m)" >&2; return 1 ;;
  esac
  echo "${os}_${arch}"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch() {
  [[ -x "$BIN" ]] && return 0
  local plat want tarball tmp
  plat="$(platform)"
  want="$(sha256_for "$plat")" || { echo "video-gateway: no pinned checksum for $plat" >&2; return 1; }
  tarball="mediamtx_${VERSION}_${plat}.tar.gz"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  echo "video-gateway: downloading MediaMTX $VERSION ($plat)" >&2
  curl -fsSL -o "$tmp/$tarball" "https://github.com/bluenviron/mediamtx/releases/download/$VERSION/$tarball"
  local got
  got="$(sha256 "$tmp/$tarball")"
  if [[ "$got" != "$want" ]]; then
    echo "video-gateway: checksum mismatch for $tarball (got $got, want $want)" >&2
    return 1
  fi
  tar -xzf "$tmp/$tarball" -C "$tmp" mediamtx
  mkdir -p "$BIN_DIR"
  mv "$tmp/mediamtx" "$BIN"
  chmod +x "$BIN"
}

PASSWORD_FILE="$VIDEO_DIR/gateway.password"
OBS_PASSWORD_FILE="$VIDEO_DIR/obs.password"

# Prompt for a password and keep it in a gitignored, owner-only file ($1). Empty removes it.
set_password() {
  local file="$1" what="$2" a b
  read -r -s -p "$what password (empty: none): " a; echo
  if [[ -z "$a" ]]; then rm -f "$file"; echo "video-gateway: $what access off"; return; fi
  read -r -s -p "Again: " b; echo
  [[ "$a" == "$b" ]] || { echo "video-gateway: passwords differ, nothing changed" >&2; return 1; }
  ( umask 077; printf '%s' "$a" > "$file" )
  echo "video-gateway: saved (used from the next time the gateway starts)"
}

case "${1:-}" in
  --fetch) fetch; exit 0 ;;
  --print-bin) fetch; echo "$BIN"; exit 0 ;;
  --set-password) set_password "$PASSWORD_FILE" "Gateway (DAQ backend)"; exit $? ;;
  --set-obs-password) set_password "$OBS_PASSWORD_FILE" "OBS (read-only RTSP)"; exit $? ;;
  "") ;;
  *) echo "usage: $0 [--fetch | --print-bin | --set-password | --set-obs-password]" >&2; exit 2 ;;
esac

fetch

# Users beyond this machine's own (see the header), passed to MediaMTX as extra internal
# users through its MTX_* environment overrides; passwords are never echoed.
next_user=1
add_user() {   # add_user NAME PASSWORD ACTION...
  local name="$1" pass="$2" i=0; shift 2
  export "MTX_AUTHINTERNALUSERS_${next_user}_USER=$name"
  export "MTX_AUTHINTERNALUSERS_${next_user}_PASS=$pass"
  export "MTX_AUTHINTERNALUSERS_${next_user}_IPS="
  for action in "$@"; do export "MTX_AUTHINTERNALUSERS_${next_user}_PERMISSIONS_${i}_ACTION=$action"; i=$((i + 1)); done
  next_user=$((next_user + 1))
}

password="${VIDEO_GATEWAY_PASSWORD:-}"
if [[ -z "$password" && -s "$PASSWORD_FILE" ]]; then password="$(cat "$PASSWORD_FILE")"; fi
if [[ -n "$password" ]]; then
  add_user daq "$password" api read          # a DAQ backend on another machine
  echo "video-gateway: remote access on (user daq)" >&2
else
  echo "video-gateway: remote access off (this machine only; --set-password to allow a DAQ laptop)" >&2
fi

password="${VIDEO_OBS_PASSWORD:-}"
if [[ -z "$password" && -s "$OBS_PASSWORD_FILE" ]]; then password="$(cat "$OBS_PASSWORD_FILE")"; fi
if [[ -n "$password" ]]; then
  add_user obs "$password" read              # OBS: RTSP reads only, no API, no publishing
  echo "video-gateway: OBS access on (user obs, RTSP :8554)" >&2
else
  echo "video-gateway: OBS access off (--set-obs-password to allow a streaming laptop)" >&2
fi
unset password
# The video agent (video/agent.mjs) runs MediaMTX and keeps recordings; it needs Node and
# ffmpeg on this machine. Run from the video dir: buffer/ and recordings/ live there.
need() { command -v "$1" >/dev/null 2>&1 || { echo "video-gateway: $1 not found -- $2" >&2; exit 1; }; }
if [[ "$(uname -s)" == "Darwin" ]]; then
  need node "brew install node"
  need ffmpeg "brew install ffmpeg"
else
  need node "install Node 20 (deploy/bootstrap_daq.sh does)"
  need ffmpeg "sudo apt-get install -y ffmpeg"
fi
export VIDEO_GATEWAY_PASSWORD="${VIDEO_GATEWAY_PASSWORD:-$( [[ -s "$PASSWORD_FILE" ]] && cat "$PASSWORD_FILE" )}"
cd "$VIDEO_DIR"
if [[ "$(uname -s)" == "Darwin" ]]; then
  exec caffeinate -i node "$VIDEO_DIR/agent.mjs" --mediamtx "$BIN" --config "$CONFIG"
fi
exec node "$VIDEO_DIR/agent.mjs" --mediamtx "$BIN" --config "$CONFIG"
