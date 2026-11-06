# ESP-IDF project: the rocket video transmitter's ESP32-P4 firmware.
#   . /opt/esp/esp-idf/export.sh && idf.py set-target esp32p4 && idf.py build
cmake_minimum_required(VERSION 3.16)
# Camera + H.264 components from GitHub (tools/fetch-video-deps.sh), used in
# place with the component manager off: the registry is not needed.
set(TP ${CMAKE_CURRENT_LIST_DIR}/third_party)
if(EXISTS ${TP}/esp-video-components)
    set(EXTRA_COMPONENT_DIRS
        ${TP}/esp-video-components/esp_video
        ${TP}/esp-video-components/esp_cam_sensor
        ${TP}/esp-video-components/esp_ipa
        ${TP}/esp-video-components/esp_sccb_intf
        ${TP}/esp-h264-component/esp_h264
        ${TP}/esp-iot-solution/tools/cmake_utilities)
    set(ENV{IDF_COMPONENT_MANAGER} 0)
endif()
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(dvbt_tx_fw)
