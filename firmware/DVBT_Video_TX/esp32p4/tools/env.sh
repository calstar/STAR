# Source me: puts idf.py and the ESP32-P4 toolchain on PATH.
export IDF_ROOT=${IDF_ROOT:-/opt/esp}
export IDF_PATH=$IDF_ROOT/esp-idf IDF_TOOLS_PATH=$IDF_ROOT/tools
. "$IDF_PATH/export.sh" >/dev/null
