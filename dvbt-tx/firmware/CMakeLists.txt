# ESP-IDF project: the rocket video transmitter's ESP32-P4 firmware.
#   . /opt/esp/esp-idf/export.sh && idf.py set-target esp32p4 && idf.py build
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(dvbt_tx_fw)
