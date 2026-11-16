# Calibration characterization (docs/remaster/LEDGER.md): golden outputs of lib/src/calibration,
# lib/src/t7 and the per-sample transforms inside services/calibration/calibration_main.cpp.
# The stack-level half (calibration_service against a stand-in Elodin) and the backend TS half
# live in run.sh. CHAR_UPDATE=1 rewrites the goldens instead of comparing.
#
# The goldens are bit-exact, so they are per <os>-<arch>-<build type> (see check_golden.sh): a
# Release build and an unoptimised one differ in the last bits of the same expression.
find_package(Eigen3 REQUIRED)
set(CHAR_CAL_DIR ${CMAKE_CURRENT_SOURCE_DIR})
set(CHAR_CAL_LIB ${CMAKE_SOURCE_DIR}/diablo_server/lib)
string(TOLOWER "${CMAKE_BUILD_TYPE}" _char_cal_bt)
if(_char_cal_bt STREQUAL "" OR _char_cal_bt STREQUAL "debug")
    set(_char_cal_bt "noopt")
endif()
string(TOLOWER "${CMAKE_HOST_SYSTEM_NAME}-${CMAKE_HOST_SYSTEM_PROCESSOR}-${_char_cal_bt}"
       CHAR_CAL_VARIANT)

add_executable(char_calibration_lib lib_harness.cpp)
target_include_directories(char_calibration_lib PRIVATE ${CHAR_CAL_DIR} ${CHAR_CAL_LIB}/include)
target_link_libraries(char_calibration_lib
    fsw_daq_lib daq_comms_lib Eigen3::Eigen Threads::Threads ${RT_LIBRARY})
add_test(NAME char_calibration_lib
    COMMAND bash ${CHAR_CAL_DIR}/check_golden.sh ${CHAR_CAL_DIR}/golden/lib ${CHAR_CAL_VARIANT}
            $<TARGET_FILE:char_calibration_lib> ${CHAR_CAL_DIR}/fixtures)
set_tests_properties(char_calibration_lib PROPERTIES
    LABELS characterization SKIP_RETURN_CODE 77)

# The service's file-static conversions and selection rules, compiled by including the service
# source itself with its main() renamed — no production file is touched.
add_executable(char_calibration_service_fns service_fns_harness.cpp)
target_include_directories(char_calibration_service_fns PRIVATE
    ${CHAR_CAL_DIR}
    ${CHAR_CAL_LIB}/include
    ${CMAKE_SOURCE_DIR}/diablo_server/transport/include
    ${CMAKE_SOURCE_DIR}/diablo_server/services/calibration)
target_link_libraries(char_calibration_service_fns
    fsw_daq_lib daq_comms_lib Eigen3::Eigen Threads::Threads ${RT_LIBRARY})
add_test(NAME char_calibration_service_fns
    COMMAND bash ${CHAR_CAL_DIR}/check_golden.sh ${CHAR_CAL_DIR}/golden/service_fns
            ${CHAR_CAL_VARIANT} $<TARGET_FILE:char_calibration_service_fns>)
set_tests_properties(char_calibration_service_fns PROPERTIES
    LABELS characterization SKIP_RETURN_CODE 77)
