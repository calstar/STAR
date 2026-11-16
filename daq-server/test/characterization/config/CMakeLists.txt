# Characterization area "config": every C++ config loader's parsed result, frozen per input file.
# The dumpers only read files; check.sh runs them and diffs against golden/ (run.sh covers the
# TypeScript and Python halves). CHAR_UPDATE=1 rewrites the goldens (only ever on main's behaviour).
find_package(Eigen3 REQUIRED)
set(_CFG_DIR ${CMAKE_CURRENT_SOURCE_DIR})
set(_DS ${CMAKE_SOURCE_DIR}/diablo_server)
set(_CFG_INCLUDES
    ${_DS}/lib/include
    ${_DS}/transport/include
    ${_DS}/../archive/legacy/utl
)

# The sequencer's loaders are not in fsw_daq_lib; build the same sources in, as
# tools/state_script_check does for StateMachine.cpp.
add_executable(char_config_dump
    char_config_dump.cpp
    ${_DS}/services/sequencer/StateMachine.cpp
    ${_DS}/services/sequencer/ActuatorCommander.cpp
    ${_DS}/services/sequencer/ScriptStates.cpp
)
target_include_directories(char_config_dump PRIVATE ${_CFG_INCLUDES})
# char_config_dump.cpp redefines `private` around one header on purpose (see the comment there).
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
    target_compile_options(char_config_dump PRIVATE -Wno-keyword-macro)
endif()
target_link_libraries(char_config_dump
    fsw_daq_lib daq_comms_lib daqv2_comms Eigen3::Eigen Threads::Threads pthread ${RT_LIBRARY})

# One executable per service main, each #including that main.cpp (see char_config_services.cpp).
# The included file is production code compiled a second time; its own warnings are already in
# the baseline from the real build, so they are not repeated here.
foreach(_svc STACKLIGHT DAQ_BRIDGE CONFIG_BROADCAST)
    string(TOLOWER ${_svc} _lc)
    add_executable(char_cfg_${_lc} char_config_services.cpp)
    target_compile_definitions(char_cfg_${_lc} PRIVATE CHAR_SERVICE_${_svc}=1)
    target_compile_options(char_cfg_${_lc} PRIVATE -w)
    target_include_directories(char_cfg_${_lc} PRIVATE ${_CFG_INCLUDES})
    target_link_libraries(char_cfg_${_lc}
        fsw_daq_lib daq_comms_lib daqv2_comms Threads::Threads pthread ${RT_LIBRARY})
endforeach()

add_test(NAME characterization_config_cpp
    COMMAND bash ${_CFG_DIR}/check.sh cpp $<TARGET_FILE_DIR:char_config_dump>
            $<TARGET_FILE_DIR:state_script_check>
    WORKING_DIRECTORY ${_CFG_DIR})
set_tests_properties(characterization_config_cpp PROPERTIES LABELS characterization)
