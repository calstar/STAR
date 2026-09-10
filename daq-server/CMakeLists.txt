cmake_minimum_required(VERSION 3.20)
project(LiquidEngineFlightSoftware VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── Warnings ──
# The compiler is the cheapest analyser available and was running with all of them off. Turning
# these on found three dead locals, a dead function and two struct fields nothing reads; the one
# that is promoted to an error is -Wreturn-type, because a value-returning function that falls off
# the end leaves the caller reading whatever was in the register and there is no benign version of
# it. Everything else stays a warning so a clean tree does not become a blocked build.
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    add_compile_options(-Wall -Wextra -Wpedantic -Wno-unused-parameter -Werror=return-type)
endif()

# ── Sanitizers (-DSANITIZE=ON) ──
# ASan/UBSan instrument the binary and only report on code that actually executes, so this is worth
# pointing at test/test_integration.sh (which drives real UDP through every service) rather than at
# ctest alone — ctest runs clean, while one integration run reported the misaligned stores in
# config_broadcast and an uninitialised bool in BoardDiscovery. PIC is required, not optional:
# daqv2_comms is a static library linked into a shared one, and ASan's
# __asan_option_detect_stack_use_after_return reference fails to relocate without it.
option(SANITIZE "Build with AddressSanitizer + UndefinedBehaviorSanitizer" OFF)
if(SANITIZE)
    if(NOT CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        message(FATAL_ERROR "SANITIZE=ON requires GCC or Clang")
    endif()
    set(CMAKE_POSITION_INDEPENDENT_CODE ON)
    add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer -g)
    add_link_options(-fsanitize=address,undefined)
endif()

find_package(Threads REQUIRED)
find_package(ZLIB REQUIRED)
find_package(OpenSSL REQUIRED)

# All binaries land in build/bin/ for predictable paths in scripts
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)

# daq-protocol: wire protocol library (subtree at repo-root lib/daq-protocol)
add_library(daqv2_comms STATIC
    ../lib/daq-protocol/src/DiabloPacketUtils.cpp
)
target_include_directories(daqv2_comms PUBLIC
    ../lib/daq-protocol/src
)
# DAQv2 headers use size_t without <cstddef>; force the standard header (GCC/Clang)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(daqv2_comms PRIVATE "-include" "cstddef")
endif()
# GCC 13 reports -Wstringop-overflow inside libstdc++'s inlined vector::resize here, claiming a
# write "into a region of size 0". Both call sites (DiabloPacketUtils.cpp:748,769) are guarded by
# `if (N)` and a MAX_ bound, so the count cannot be zero; this is the known GCC 13 false positive.
# Scoped to this target so the warning keeps working everywhere else.
if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    target_compile_options(daqv2_comms PRIVATE -Wno-stringop-overflow)
endif()

# enable_testing() must come BEFORE add_subdirectory() — subdirectories added
# earlier never emit their add_test() registrations into CTest.
enable_testing()

add_subdirectory(diablo_server)

if(EXISTS ${CMAKE_SOURCE_DIR}/tests)
    add_subdirectory(tests)
endif()
