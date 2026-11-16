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

# Hand-rolled encoders inside the services. The svc_*.cpp files compile a service's *_main.cpp
# with main renamed so its anonymous-namespace builders can be called; production code is
# untouched. AbortBroadcaster.cpp is compiled in the same way the existing lib tests do.
set(CHAR_DIABLO ${CMAKE_SOURCE_DIR}/diablo_server)
add_executable(char_service_encoders
    service_encoders.cpp
    svc_config_broadcast.cpp
    svc_heartbeat.cpp
    svc_stacklight.cpp
    svc_daq_bridge.cpp
    svc_controller.cpp
    ${CHAR_DIABLO}/services/sequencer/AbortBroadcaster.cpp
)
target_include_directories(char_service_encoders PRIVATE
    ${CHAR_DIABLO}/lib/include ${CHAR_DIABLO}/transport/include)
target_link_libraries(char_service_encoders
    fsw_daq_lib daq_comms_lib daqv2_comms Threads::Threads)
char_packets_target(char_service_encoders)
# Pure: reads config copies in its own work dir, opens no socket.
add_test(NAME char_packets_service_config_broadcast
         COMMAND char_service_encoders config_broadcast ${CMAKE_SOURCE_DIR}
         WORKING_DIRECTORY ${CHAR_PACKETS_WORK})
set_tests_properties(char_packets_service_config_broadcast PROPERTIES LABELS characterization)
# Transport-side message types and the Elodin TABLE frame. Pure: no sockets.
add_executable(char_comms_messages comms_messages.cpp)
target_include_directories(char_comms_messages PRIVATE
    ${CHAR_DIABLO}/lib/include ${CHAR_DIABLO}/transport/include)
target_link_libraries(char_comms_messages fsw_daq_lib daq_comms_lib)
char_packets_target(char_comms_messages)
add_test(NAME char_packets_comms_messages COMMAND char_comms_messages
         WORKING_DIRECTORY ${CHAR_PACKETS_WORK})
set_tests_properties(char_packets_comms_messages PROPERTIES LABELS characterization)

# Loopback UDP on 127.0.0.1 (ephemeral ports).
add_test(NAME char_packets_service_packets COMMAND char_service_encoders packets
         WORKING_DIRECTORY ${CHAR_PACKETS_WORK})
set_tests_properties(char_packets_service_packets PROPERTIES
    LABELS characterization RUN_SERIAL TRUE TIMEOUT 120)
