# DAQ Bridge: listens for sensor UDP packets, publishes to Elodin DB

add_executable(daq_bridge daq_bridge_main.cpp)

target_include_directories(daq_bridge PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../lib/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../transport/include
)

target_link_libraries(daq_bridge
    fsw_daq_lib
    daq_comms_lib
    daqv2_comms
    Threads::Threads
    pthread
    ${RT_LIBRARY}
)

install(TARGETS daq_bridge RUNTIME DESTINATION bin)
