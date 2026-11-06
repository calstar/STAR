cmake_minimum_required(VERSION 3.16)
project(star_idle_e2e LANGUAGES C CXX)

enable_testing()
option(SELF_TEST_SANITIZERS "Run host tests with address/undefined sanitizers" OFF)

set(ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../..)

add_executable(idle_e2e idle_e2e.cpp)
target_include_directories(idle_e2e PRIVATE
    ${ROOT}/src
    ${ROOT}/tests/fakes)
set_target_properties(idle_e2e PROPERTIES
    CXX_STANDARD 11
    CXX_EXTENSIONS OFF)
target_compile_options(idle_e2e PRIVATE -Wall -Wextra -Werror)
if(SELF_TEST_SANITIZERS)
    target_compile_options(idle_e2e PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
    target_link_options(idle_e2e PRIVATE -fsanitize=address,undefined)
endif()
add_test(NAME idle_e2e COMMAND idle_e2e)
