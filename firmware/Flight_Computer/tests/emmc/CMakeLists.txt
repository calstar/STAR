# Host tests for the flight state table and the eMMC flight log.
# Included from ../self_test/CMakeLists.txt so the one CI job runs both;
# also configurable on its own: cmake -S tests/emmc -B build/emmc
cmake_minimum_required(VERSION 3.16)
project(star_emmc LANGUAGES C)
enable_testing()
option(SELF_TEST_SANITIZERS "Run host tests with address/undefined sanitizers" OFF)

set(FC_CORE ${CMAKE_CURRENT_LIST_DIR}/../../Core)
add_library(star_emmc STATIC
    ${FC_CORE}/Src/flight_state.c
    ${FC_CORE}/Src/emmc_log.c
    ${FC_CORE}/Src/emmc_card.c)
target_include_directories(star_emmc PUBLIC ${FC_CORE}/Inc)
target_compile_features(star_emmc PUBLIC c_std_99)
set_target_properties(star_emmc PROPERTIES C_EXTENSIONS OFF)

foreach(name test_flight_state test_emmc_log test_emmc_card)
    add_executable(${name} ${name}.c)
    target_link_libraries(${name} PRIVATE star_emmc)
endforeach()

foreach(target star_emmc test_flight_state test_emmc_log test_emmc_card)
    if(MSVC)
        target_compile_options(${target} PRIVATE /W4 /WX)
    else()
        target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
    endif()
    if(SELF_TEST_SANITIZERS)
        if(NOT CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
            message(FATAL_ERROR "Sanitizers require Clang or GCC")
        endif()
        target_compile_options(${target} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
        target_link_options(${target} PRIVATE -fsanitize=address,undefined)
    endif()
endforeach()

add_test(NAME flight_state_table COMMAND test_flight_state)
add_test(NAME emmc_log COMMAND test_emmc_log)
add_test(NAME emmc_card_registers COMMAND test_emmc_card)
