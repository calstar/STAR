cmake_minimum_required(VERSION 3.20)
project(LiquidEngineFlightSoftware VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Threads REQUIRED)
find_package(ZLIB REQUIRED)
find_package(OpenSSL REQUIRED)

# All binaries land in build/bin/ for predictable paths in scripts
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)

# DAQv2-Comms: wire protocol library (subtree at repo-root lib/DAQv2-Comms)
add_library(daqv2_comms STATIC
    ../lib/DAQv2-Comms/src/DiabloPacketUtils.cpp
)
target_include_directories(daqv2_comms PUBLIC
    ../lib/DAQv2-Comms/src
)
# DAQv2 headers use size_t without <cstddef>; force the standard header (GCC/Clang)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(daqv2_comms PRIVATE "-include" "cstddef")
endif()

add_subdirectory(diablo_server)

enable_testing()
if(EXISTS ${CMAKE_SOURCE_DIR}/tests)
    add_subdirectory(tests)
endif()
