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
# (run.sh, service_run.py, abort_codes.py): the refactor splits that file, so nothing here
# compiles it.

# The abort-threshold ADC codes calibration_service writes, at targets on a fused/unfused rounding
# edge (D-WP9-FMA; abort_codes.py). Runs the built service with no Elodin; binds nothing.
find_package(Python3 COMPONENTS Interpreter)
if(Python3_Interpreter_FOUND)
    add_test(NAME char_calibration_abort_codes
        COMMAND bash ${CHAR_CAL_DIR}/check_golden.sh ${CHAR_CAL_DIR}/golden/abort_codes.txt
                ${Python3_EXECUTABLE} ${CHAR_CAL_DIR}/abort_codes.py
                --cal $<TARGET_FILE:calibration_service> --part control)
    set_tests_properties(char_calibration_abort_codes PROPERTIES
        LABELS characterization TIMEOUT 120)
    # The boundary targets sit on a fused/unfused rounding edge. Both calibration_service and the
    # library's calibration sources are built -ffp-contract=off, so they must answer the same
    # codes on every architecture (abort_codes.py, README.md "Abort codes and FMA").
    add_test(NAME char_calibration_abort_codes_boundary
        COMMAND bash ${CHAR_CAL_DIR}/check_golden.sh
                ${CHAR_CAL_DIR}/golden/abort_codes_boundary.txt
                ${Python3_EXECUTABLE} ${CHAR_CAL_DIR}/abort_codes.py
                --cal $<TARGET_FILE:calibration_service> --part boundary)
    set_tests_properties(char_calibration_abort_codes_boundary PROPERTIES
        LABELS characterization TIMEOUT 120)
endif()
