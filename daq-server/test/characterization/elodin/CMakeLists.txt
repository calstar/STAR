# elodin/: golden-master characterization of the Elodin schema — what the C++ services register
# (this CMakeLists, captured over loopback TCP) and the backend's view of it (run.sh, TypeScript).
# CHAR_UPDATE=1 rewrites golden/.
set(CHAR_ELODIN_GOLDEN ${CMAKE_CURRENT_SOURCE_DIR}/golden)
set(CHAR_ELODIN_WORK ${CMAKE_CURRENT_BINARY_DIR}/work)
file(MAKE_DIRECTORY ${CHAR_ELODIN_WORK})
set(CHAR_PACKETS_SRC ${CMAKE_CURRENT_SOURCE_DIR}/../packets)

add_executable(char_elodin_schema
    elodin_schema.cpp
    # daq_bridge's own board-id derivation, compiled from its main TU (see packets/svc_*.cpp)
    ${CHAR_PACKETS_SRC}/svc_daq_bridge.cpp
)
target_include_directories(char_elodin_schema PRIVATE
    ${CHAR_PACKETS_SRC}
    ${CMAKE_SOURCE_DIR}/diablo_server/lib/include
    ${CMAKE_SOURCE_DIR}/diablo_server/transport/include)
target_compile_definitions(char_elodin_schema PRIVATE CHAR_GOLDEN_DIR="${CHAR_ELODIN_GOLDEN}")
target_link_libraries(char_elodin_schema fsw_daq_lib daq_comms_lib daqv2_comms Threads::Threads)

# Loopback TCP listener on 127.0.0.1 (ephemeral port): RUN_SERIAL, run ctest under the stack lock.
foreach(cfg config_base profile_default)
    add_test(NAME char_elodin_schema_${cfg}
             COMMAND char_elodin_schema ${CMAKE_SOURCE_DIR} ${cfg}
             WORKING_DIRECTORY ${CHAR_ELODIN_WORK})
    set_tests_properties(char_elodin_schema_${cfg} PROPERTIES
        LABELS characterization RUN_SERIAL TRUE TIMEOUT 120)
endforeach()
