cmake_minimum_required(VERSION 3.16)
project(star_drivers LANGUAGES C)

# Host tests for the portable chip drivers in drivers/ (no HAL, no RTOS),
# run against scripted fake buses. CI runs this with sanitizers on.
enable_testing()
option(SELF_TEST_SANITIZERS "Run host tests with address/undefined sanitizers" OFF)

set(DRIVERS ${CMAKE_CURRENT_SOURCE_DIR}/../../drivers)

add_library(star_drivers STATIC ${DRIVERS}/dev_ism330dhcx.c ${DRIVERS}/dev_h3lis100dl.c ${DRIVERS}/dev_ms5611.c)
target_include_directories(star_drivers PUBLIC ${DRIVERS})
set(FAKES ${CMAKE_CURRENT_SOURCE_DIR}/../fakes)
add_library(fakes STATIC ${FAKES}/fake_regs.c ${FAKES}/fake_baro.c)
target_include_directories(fakes PUBLIC ${FAKES})
target_link_libraries(fakes PUBLIC star_drivers)

set(TESTS test_ism330dhcx test_h3lis100dl test_ms5611)
foreach(t ${TESTS})
    add_executable(${t} ${t}.c)
    target_link_libraries(${t} PRIVATE fakes)
    add_test(NAME ${t} COMMAND ${t})
endforeach()

foreach(target star_drivers fakes ${TESTS})
    set_target_properties(${target} PROPERTIES C_STANDARD 99 C_EXTENSIONS OFF)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
    if(SELF_TEST_SANITIZERS)
        target_compile_options(${target} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
        target_link_options(${target} PRIVATE -fsanitize=address,undefined)
    endif()
endforeach()
