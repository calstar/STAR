# packets/: golden-master characterization of every byte format the DAQ server puts on, or takes
# off, a wire: the board protocol (daqv2_comms), the decode path daq_bridge runs
# (SensorFramePipeline), the hand-rolled encoders inside the services, and the transport-side
# message types. See README.md in the parent directory; CHAR_UPDATE=1 rewrites golden/.
set(CHAR_PACKETS_GOLDEN ${CMAKE_CURRENT_SOURCE_DIR}/golden)
set(CHAR_PACKETS_WORK ${CMAKE_CURRENT_BINARY_DIR}/work)
file(MAKE_DIRECTORY ${CHAR_PACKETS_WORK})

function(char_packets_target name)
    target_compile_definitions(${name} PRIVATE CHAR_GOLDEN_DIR="${CHAR_PACKETS_GOLDEN}")
    target_include_directories(${name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
endfunction()

# Pure: the wire protocol library alone. No sockets.
add_executable(char_wire_protocol wire_protocol.cpp)
target_link_libraries(char_wire_protocol daqv2_comms)
char_packets_target(char_wire_protocol)
foreach(mode layout encode decode malformed)
    add_test(NAME char_packets_wire_${mode} COMMAND char_wire_protocol ${mode}
             WORKING_DIRECTORY ${CHAR_PACKETS_WORK})
    set_tests_properties(char_packets_wire_${mode} PROPERTIES LABELS characterization)
endforeach()

# The decode path daq_bridge runs: SensorFramePipeline::poll() over loopback UDP (ephemeral port
# on 127.0.0.1). RUN_SERIAL, and run ctest under with_stack_lock.sh.
add_executable(char_pipeline_decode pipeline_decode.cpp)
target_link_libraries(char_pipeline_decode fsw_daq_lib daq_comms_lib daqv2_comms)
char_packets_target(char_pipeline_decode)
add_test(NAME char_packets_pipeline_decode COMMAND char_pipeline_decode
         WORKING_DIRECTORY ${CHAR_PACKETS_WORK})
set_tests_properties(char_packets_pipeline_decode PROPERTIES
    LABELS characterization RUN_SERIAL TRUE TIMEOUT 120)

# Transport-side message types and the Elodin TABLE frame. Pure: no sockets.
add_executable(char_comms_messages comms_messages.cpp)
target_include_directories(char_comms_messages PRIVATE
    ${CMAKE_SOURCE_DIR}/diablo_server/lib/include ${CMAKE_SOURCE_DIR}/diablo_server/transport/include)
target_link_libraries(char_comms_messages fsw_daq_lib daq_comms_lib)
char_packets_target(char_comms_messages)
add_test(NAME char_packets_comms_messages COMMAND char_comms_messages
         WORKING_DIRECTORY ${CHAR_PACKETS_WORK})
set_tests_properties(char_packets_comms_messages PROPERTIES LABELS characterization)


# The services, black box: blackbox_services.py starts each built binary against a loopback copy
# of a committed config and captures what it sends (UDP by destination address, TCP to a stand-in
# elodin-db). They bind real ports, the board port 5005 among them: RUN_SERIAL, and ctest runs
# under with_stack_lock.sh. macOS needs the 127.0.0.<board> lo0 aliases.
find_package(Python3 REQUIRED COMPONENTS Interpreter)
foreach(mode config_broadcast heartbeat stacklight daq_bridge abort pwm)
    add_test(NAME char_packets_service_${mode}
             COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/blackbox_services.py
                     ${mode} $<TARGET_FILE_DIR:daq_bridge> ${CMAKE_SOURCE_DIR} ${CHAR_PACKETS_WORK}
             WORKING_DIRECTORY ${CHAR_PACKETS_WORK})
    set_tests_properties(char_packets_service_${mode} PROPERTIES
        LABELS characterization RUN_SERIAL TRUE TIMEOUT 300)
endforeach()
