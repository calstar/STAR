# elodin/: golden-master characterization of the Elodin schema — what the C++ services register
# (blackbox_schema.py: the real daq_bridge, calibration_service, sequencer_service and
# controller_service started against a stand-in elodin-db on loopback) and the backend's view of it
# (run.sh, TypeScript). CHAR_UPDATE=1 rewrites golden/.
set(CHAR_ELODIN_WORK ${CMAKE_CURRENT_BINARY_DIR}/work)
file(MAKE_DIRECTORY ${CHAR_ELODIN_WORK})
find_package(Python3 REQUIRED COMPONENTS Interpreter)

# The services bind real ports: RUN_SERIAL, and ctest runs under with_stack_lock.sh.
foreach(cfg config_base profile_default)
    add_test(NAME char_elodin_schema_${cfg}
             COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/blackbox_schema.py
                     $<TARGET_FILE_DIR:daq_bridge> ${CMAKE_SOURCE_DIR} ${CHAR_ELODIN_WORK} ${cfg}
             WORKING_DIRECTORY ${CHAR_ELODIN_WORK})
    set_tests_properties(char_elodin_schema_${cfg} PROPERTIES
        LABELS characterization RUN_SERIAL TRUE TIMEOUT 1200)
endforeach()
