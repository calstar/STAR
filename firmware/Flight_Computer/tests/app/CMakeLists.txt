cmake_minimum_required(VERSION 3.16)
project(star_app LANGUAGES C)

# Host tests for the portable task cores in app/ (no HAL, no RTOS): the same
# step functions the RTOS tasks call, driven by a virtual clock and fake chips.
enable_testing()
option(SELF_TEST_SANITIZERS "Run host tests with address/undefined sanitizers" OFF)

set(ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../..)
set(FAKES ${ROOT}/tests/fakes)

add_library(star_app STATIC
    ${ROOT}/app/sensors_core.c
    ${ROOT}/app/gnss_core.c
    ${ROOT}/app/battery.c
    ${ROOT}/app/boot_report.c
    ${ROOT}/app/sleep_math.c
    ${ROOT}/chips/ubx.c
    ${ROOT}/Core/Src/gnss_frame.c
    ${FAKES}/fake_gnss.c
    ${ROOT}/chips/dev_ism330dhcx.c
    ${ROOT}/chips/dev_h3lis100dl.c
    ${ROOT}/chips/dev_ms5611.c
    ${FAKES}/fake_regs.c
    ${FAKES}/fake_baro.c)
target_include_directories(star_app PUBLIC ${ROOT}/app ${ROOT}/chips ${ROOT}/Core/Inc ${FAKES})

set(TESTS test_sensors_core test_gnss_core test_boot_report test_sleep_math)
foreach(t ${TESTS})
    add_executable(${t} ${t}.c)
    target_link_libraries(${t} PRIVATE star_app)
    add_test(NAME ${t} COMMAND ${t})
endforeach()

foreach(target star_app ${TESTS})
    set_target_properties(${target} PROPERTIES C_STANDARD 11 C_EXTENSIONS OFF)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
    if(SELF_TEST_SANITIZERS)
        target_compile_options(${target} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
        target_link_options(${target} PRIVATE -fsanitize=address,undefined)
    endif()
endforeach()
