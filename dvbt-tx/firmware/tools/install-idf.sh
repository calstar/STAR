#!/usr/bin/env bash
# Install ESP-IDF v5.5.1 and the ESP32-P4 toolchain (RISC-V GCC 14.2, GDB,
# OpenOCD) into $IDF_ROOT (default /opt/esp). Everything comes from GitHub
# and PyPI; dl.espressif.com is not needed (it is blocked in some sandboxes),
# so the Python environment is installed without Espressif's constraints
# file and an equivalent one is written from what got installed.
#
#   dvbt-tx/firmware/tools/install-idf.sh
#   . dvbt-tx/firmware/tools/env.sh && cd dvbt-tx/firmware && idf.py build
set -euo pipefail
IDF_ROOT=${IDF_ROOT:-/opt/esp}
IDF_VER=${IDF_VER:-v5.5.1}
export IDF_TOOLS_PATH=$IDF_ROOT/tools
mkdir -p "$IDF_ROOT"
if [ ! -d "$IDF_ROOT/esp-idf" ]; then
    git clone --depth 1 --branch "$IDF_VER" --recurse-submodules --shallow-submodules -j 8 \
        https://github.com/espressif/esp-idf.git "$IDF_ROOT/esp-idf"
fi
cd "$IDF_ROOT/esp-idf"
python3 tools/idf_tools.py --non-interactive install --targets esp32p4 required
python3 tools/idf_tools.py --non-interactive install-python-env --no-constraints
py=$(ls -d "$IDF_TOOLS_PATH"/python_env/idf5.5_py*_env/bin/python | head -1)
"$py" -m pip freeze > "$IDF_TOOLS_PATH/espidf.constraints.v5.5.txt"
echo "ESP-IDF $IDF_VER ready: . $(dirname "$0")/env.sh"
