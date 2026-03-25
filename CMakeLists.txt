cmake_minimum_required(VERSION 3.20)
project(LiquidEngineFlightSoftware VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Threads REQUIRED)

# DAQv2-Comms: the real protocol library (from external/DAQv2-Comms submodule)
# Arduino.h shim lives alongside the source so it compiles on Linux.
add_library(daqv2_comms STATIC
    external/DAQv2-Comms/src/DiabloPacketUtils.cpp
)
target_include_directories(daqv2_comms PUBLIC
    external/DAQv2-Comms/src
)

# Active build: daq_comms library + FSW (daq_bridge, controller_service, fsw_web_bridge)
add_subdirectory(daq_comms)
add_subdirectory(FSW)

enable_testing()
if(EXISTS ${CMAKE_SOURCE_DIR}/tests)
    add_subdirectory(tests)
endif()
