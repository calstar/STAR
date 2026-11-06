#!/bin/bash
# Regenerate CubeMX code from firmware.ioc without opening the GUI, then put
# each file's line endings back to what git has (see below).
#
#   scripts/cubemx_generate.sh            # from firmware/Flight_Computer
#   CUBEMX=/path/to/STM32CubeMX scripts/cubemx_generate.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CUBEMX="${CUBEMX:-/Applications/STMicroelectronics/STM32CubeMX.app/Contents/MacOs/STM32CubeMX}"
script="$(mktemp)"
trap 'rm -f "$script"' EXIT
printf 'config load %s\nproject generate\nexit\n' "$PWD/firmware.ioc" > "$script"
"$CUBEMX" -q "$script" | grep -E '^(OK|KO)|ERROR' || true
# Keep each file's line endings as they are in git (CubeMX's GUI wrote some
# files CRLF, its command-line mode writes everything CRLF): only the real
# changes should show up in the diff.
for f in Core/Src/*.c Core/Inc/*.h; do
    if git cat-file -e "HEAD:./$f" 2>/dev/null &&
       git show "HEAD:./$f" | head -3 | grep -q $'\r'; then
        perl -pi -e 's/\r?\n/\r\n/' "$f"   # file is CRLF in git
    else
        perl -pi -e 's/\r\n/\n/' "$f"       # LF in git, or new
    fi
done
git status --short -- . | sed 's/^/changed: /'
