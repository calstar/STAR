cmake_minimum_required(VERSION 3.16)
project(star_health_radio LANGUAGES C CXX)

# Host tests for the health task and the start-up SelfTest send (#521, #522):
# the portable cores, Ryan's frame codec, and the RTOS adapters against fake
# CMSIS, watchdog, ADC and radio functions.
enable_testing()
option(SELF_TEST_SANITIZERS "Enable address/undefined sanitizers" OFF)
set(ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../..)
add_library(health_radio STATIC ${ROOT}/src/app/health.c
    ${ROOT}/src/app/health_core.c ${ROOT}/src/app/battery.c
    ${ROOT}/src/app/selftest_radio.c ${ROOT}/src/radio/frame.cpp)
target_include_directories(health_radio PUBLIC ${ROOT}/src/app ${ROOT}/src/radio)
add_executable(test_health_radio test_health_radio.cpp)
target_link_libraries(test_health_radio PRIVATE health_radio)
add_test(NAME health_radio COMMAND test_health_radio)
add_executable(test_tasks test_tasks.c ${ROOT}/src/app/health_task.c
    ${ROOT}/src/app/selftest_radio_board.c)
target_include_directories(test_tasks PRIVATE fakes ${ROOT}/src/board)
target_link_libraries(test_tasks PRIVATE health_radio)
add_test(NAME tasks COMMAND test_tasks)
foreach(t health_radio test_health_radio test_tasks)
    set_target_properties(${t} PROPERTIES C_STANDARD 11 CXX_STANDARD 17)
    target_compile_options(${t} PRIVATE -Wall -Wextra -Werror -Wpedantic)
    if(SELF_TEST_SANITIZERS)
        target_compile_options(${t} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
        target_link_options(${t} PRIVATE -fsanitize=address,undefined)
    endif()
endforeach()
