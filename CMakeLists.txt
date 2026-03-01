cmake_minimum_required(VERSION 3.20)
project(LiquidEngineFlightSoftware VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Threads REQUIRED)

# Active build: daq_comms library + FSW (daq_bridge, controller_service, fsw_web_bridge)
add_subdirectory(daq_comms)
add_subdirectory(FSW)

enable_testing()
if(EXISTS ${CMAKE_SOURCE_DIR}/tests)
    add_subdirectory(tests)
endif()
