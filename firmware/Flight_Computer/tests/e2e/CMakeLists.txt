cmake_minimum_required(VERSION 3.16)
project(flight_e2e LANGUAGES C CXX)

# End-to-end data pipeline on a laptop: the real chip drivers, task cores
# and eMMC log, with fake chips/card and a virtual clock. Run via
# ./flight_test. FLIGHT_TEST_CANARY builds the deliberately broken variant
# that flight_test requires to FAIL (a test that cannot fail is not a test).
option(SELF_TEST_SANITIZERS "Build with address/undefined sanitizers" OFF)
option(FLIGHT_TEST_CANARY "Corrupt the card image before checking it" OFF)

set(ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../..)
set(SOURCES
    flight_e2e.c
    ${ROOT}/src/app/sensors_core.c
    ${ROOT}/src/app/fc_config.c
    ${ROOT}/src/app/gnss_core.c
    ${ROOT}/src/chips/ubx.c
    ${ROOT}/src/chips/gnss_frame.c
    ${ROOT}/tests/fakes/fake_gnss.c
    ${ROOT}/src/chips/dev_ism330dhcx.c
    ${ROOT}/src/chips/dev_h3lis100dl.c
    ${ROOT}/src/chips/dev_ms5611.c
    ${ROOT}/src/app/emmc_log.c
    ${ROOT}/src/app/flight_state.c
    ${ROOT}/tests/fakes/fake_regs.c
    ${ROOT}/tests/fakes/fake_baro.c)

add_executable(flight_e2e ${SOURCES})
target_include_directories(flight_e2e PRIVATE
    ${ROOT}/src/app ${ROOT}/src/chips ${ROOT}/src/radio ${ROOT}/tests/fakes)
set_target_properties(flight_e2e PROPERTIES C_STANDARD 11 C_EXTENSIONS OFF)
target_compile_options(flight_e2e PRIVATE -Wall -Wextra -Werror)
if(FLIGHT_TEST_CANARY)
    target_compile_definitions(flight_e2e PRIVATE FLIGHT_TEST_CANARY)
endif()
if(SELF_TEST_SANITIZERS)
    target_compile_options(flight_e2e PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
    target_link_options(flight_e2e PRIVATE -fsanitize=address,undefined)
endif()

# The Idle state end to end (idle_e2e.cpp): Aaron's idle.c, Ryan's frames,
# Link and ARM gate, Sx1262Setup, mode_core, sleep_math, the eMMC log's
# state hook; fake radio chip, RTC, ADC and ground station.
add_executable(idle_e2e
    idle_e2e.cpp
    ${ROOT}/src/app/idle.c
    ${ROOT}/src/app/emmc_log.c
    ${ROOT}/src/app/flight_state.c
    ${ROOT}/src/app/mode_core.c
    ${ROOT}/src/app/sleep_math.c
    ${ROOT}/src/radio/frame.cpp
    ${ROOT}/src/radio/link.cpp
    ${ROOT}/src/radio/arm_gate.cpp
    ${ROOT}/src/chips/sx1262.cpp
    ${ROOT}/src/chips/sx1262_setup.cpp)
target_include_directories(idle_e2e PRIVATE
    ${ROOT}/src/app ${ROOT}/src/chips ${ROOT}/src/radio ${ROOT}/tests/fakes)
set_target_properties(idle_e2e PROPERTIES CXX_STANDARD 17 C_STANDARD 11)
target_compile_options(idle_e2e PRIVATE -Wall -Wextra -Werror)
if(SELF_TEST_SANITIZERS)
    target_compile_options(idle_e2e PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
    target_link_options(idle_e2e PRIVATE -fsanitize=address,undefined)
endif()
