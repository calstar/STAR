cmake_minimum_required(VERSION 3.16)
project(star_idle LANGUAGES C)

enable_testing()
option(IDLE_SANITIZERS "Run host tests with address/undefined sanitizers" OFF)

set(ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../..)
set(FAKES ${ROOT}/tests/fakes)

add_library(star_idle STATIC ../../src/app/idle.c)
target_include_directories(star_idle PUBLIC ../../src/app ../../src/chips)
target_compile_features(star_idle PUBLIC c_std_99)
set_target_properties(star_idle PROPERTIES C_EXTENSIONS OFF)

add_executable(test_idle test_idle.c)
target_link_libraries(test_idle PRIVATE star_idle)

# Idle ↔ MLC power-down policy (fake_regs bus, same style as chips tests).
add_library(star_idle_mlc STATIC
    ${ROOT}/src/app/idle_mlc.c
    ${ROOT}/src/chips/dev_ism330dhcx.c)
target_include_directories(star_idle_mlc PUBLIC ${ROOT}/src/app ${ROOT}/src/chips)
target_compile_features(star_idle_mlc PUBLIC c_std_99)
set_target_properties(star_idle_mlc PROPERTIES C_EXTENSIONS OFF)

add_library(idle_mlc_fakes STATIC ${FAKES}/fake_regs.c)
target_include_directories(idle_mlc_fakes PUBLIC ${FAKES})
target_link_libraries(idle_mlc_fakes PUBLIC star_idle_mlc)

add_executable(test_idle_mlc test_idle_mlc.c)
target_link_libraries(test_idle_mlc PRIVATE idle_mlc_fakes)

foreach(target star_idle test_idle star_idle_mlc idle_mlc_fakes test_idle_mlc)
    if(MSVC)
        target_compile_options(${target} PRIVATE /W4 /WX)
    else()
        target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror -Wconversion)
    endif()
    if(IDLE_SANITIZERS)
        if(NOT CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
            message(FATAL_ERROR "Sanitizers require Clang or GCC")
        endif()
        target_compile_options(${target} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
        target_link_options(${target} PRIVATE -fsanitize=address,undefined)
    endif()
endforeach()
add_test(NAME idle_contract COMMAND test_idle)
add_test(NAME idle_mlc COMMAND test_idle_mlc)
