cmake_minimum_required(VERSION 3.16)
project(star_board LANGUAGES C)

# Host checks for board_exti pin routing (MLC INT2 / PD1). No HAL.
enable_testing()
option(SELF_TEST_SANITIZERS "Run host tests with address/undefined sanitizers" OFF)

add_executable(test_board_exti_mlc_route test_board_exti_mlc_route.c)
add_test(NAME board_exti_mlc_route COMMAND test_board_exti_mlc_route)

foreach(target test_board_exti_mlc_route)
    set_target_properties(${target} PROPERTIES C_STANDARD 99 C_EXTENSIONS OFF)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
    if(SELF_TEST_SANITIZERS)
        target_compile_options(${target} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
        target_link_options(${target} PRIVATE -fsanitize=address,undefined)
    endif()
endforeach()
