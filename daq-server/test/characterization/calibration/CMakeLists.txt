# Calibration characterization (docs/remaster/LEDGER.md): golden outputs of lib/src/calibration
# and lib/src/t7 through their public API. The stack-level half (the built calibration_service
# against a stand-in Elodin) and the backend TS half live in run.sh. CHAR_UPDATE=1 rewrites the
# goldens instead of comparing.
#
# One golden per output for every build type, OS and arch: floats compare within 4 ULP
# (golden_compare.py), because a Release and an unoptimised build differ in the last bits.
find_package(Eigen3 REQUIRED)
set(CHAR_CAL_DIR ${CMAKE_CURRENT_SOURCE_DIR})
set(CHAR_CAL_LIB ${CMAKE_SOURCE_DIR}/diablo_server/lib)

add_executable(char_calibration_lib lib_harness.cpp)
target_include_directories(char_calibration_lib PRIVATE ${CHAR_CAL_DIR} ${CHAR_CAL_LIB}/include)
target_link_libraries(char_calibration_lib
    fsw_daq_lib daq_comms_lib Eigen3::Eigen Threads::Threads ${RT_LIBRARY})
add_test(NAME char_calibration_lib
    COMMAND bash ${CHAR_CAL_DIR}/check_golden.sh ${CHAR_CAL_DIR}/golden/lib.txt
            $<TARGET_FILE:char_calibration_lib> ${CHAR_CAL_DIR}/fixtures)
set_tests_properties(char_calibration_lib PROPERTIES
    LABELS characterization TIMEOUT 60)

# calibration_main.cpp itself is characterized only through the built calibration_service
# (run.sh, service_run.py): the refactor splits that file, so nothing here compiles it.
