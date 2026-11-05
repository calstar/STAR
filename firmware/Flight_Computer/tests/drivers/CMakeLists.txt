cmake_minimum_required(VERSION 3.16)
project(star_drivers LANGUAGES C)

# Host tests for the portable chip drivers in drivers/ (no HAL, no RTOS),
# run against scripted fake buses. CI runs this with sanitizers on.
enable_testing()
option(SELF_TEST_SANITIZERS "Run host tests with address/undefined sanitizers" OFF)

set(DRIVERS ${CMAKE_CURRENT_SOURCE_DIR}/../../drivers)

add_library(star_drivers STATIC ${DRIVERS}/dev_ism330dhcx.c)
target_include_directories(star_drivers PUBLIC ${DRIVERS})
add_library(fake_regs STATIC fake_regs.c)
target_link_libraries(fake_regs PUBLIC star_drivers)

set(TESTS test_ism330dhcx)
foreach(t ${TESTS})
    add_executable(${t} ${t}.c)
    target_link_libraries(${t} PRIVATE fake_regs)
    add_test(NAME ${t} COMMAND ${t})
endforeach()

foreach(target star_drivers fake_regs ${TESTS})
    set_target_properties(${target} PROPERTIES C_STANDARD 99 C_EXTENSIONS OFF)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
    if(SELF_TEST_SANITIZERS)
        target_compile_options(${target} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
        target_link_options(${target} PRIVATE -fsanitize=address,undefined)
    endif()
endforeach()
