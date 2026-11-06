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
#
# Settings can be overridden with MTX_<KEY> environment variables (MediaMTX's own
# mechanism), e.g. MTX_APIADDRESS=127.0.0.1:19997.
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

case "${1:-}" in
  --fetch) fetch; exit 0 ;;
  --print-bin) fetch; echo "$BIN"; exit 0 ;;
  "") ;;
  *) echo "usage: $0 [--fetch | --print-bin]" >&2; exit 2 ;;
esac

fetch
# MediaMTX writes nothing to its working directory with this config, but run it from the
# video dir so a relative path in a future setting lands somewhere predictable.
cd "$VIDEO_DIR"
if [[ "$(uname -s)" == "Darwin" ]]; then
  exec caffeinate -i "$BIN" "$CONFIG"
fi
exec "$BIN" "$CONFIG"
