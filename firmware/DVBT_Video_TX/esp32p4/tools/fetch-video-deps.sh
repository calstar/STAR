#!/usr/bin/env bash
# Espressif's camera and H.264 components, from GitHub at pinned commits,
# into third_party/ (git-ignored). The component registry
# (components.espressif.com) is not needed; the build includes these
# directly with the component manager off.
#
#   tools/fetch-video-deps.sh && idf.py build
set -euo pipefail
cd "$(dirname "$0")/.."
TP=third_party
mkdir -p "$TP"
fetch() {   # repo dir commit [sparse path]
    local repo=$1 dir=$2 rev=$3 sparse=${4:-}
    if [ ! -d "$TP/$dir/.git" ]; then
        if [ -n "$sparse" ]; then
            git clone -q --filter=blob:none --no-checkout "https://github.com/$repo.git" "$TP/$dir"
            git -C "$TP/$dir" sparse-checkout set "$sparse"
        else
            git clone -q --filter=blob:none --no-checkout "https://github.com/$repo.git" "$TP/$dir"
        fi
    fi
    git -C "$TP/$dir" fetch -q --depth 1 origin "$rev"
    git -C "$TP/$dir" checkout -q "$rev"
    echo "$dir @ $rev"
}
# esp_video 2.5.0, esp_cam_sensor 2.6.0, esp_ipa 2.4.0, esp_sccb_intf 1.0.0
fetch espressif/esp-video-components esp-video-components 08bcabdf99c7a6f4e5b7e03119ea389a226fc7d2
# esp_h264 1.5.0
fetch espressif/esp-h264-component esp-h264-component 08a0b6588fa02bc1b16351fa7a0afc7ade1dc657
# cmake_utilities 1.3.0
fetch espressif/esp-iot-solution esp-iot-solution d2d935d0ee3e78deffa3981cc8c39ac8f534932b tools/cmake_utilities
