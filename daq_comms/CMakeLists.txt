# CMakeLists.txt for daq_comms library and executables

# Source files for daq_comms library
set(DAQ_COMMS_SOURCES
    src/transport/NetworkSocket.cpp
    src/transport/TCPClient.cpp
    src/protocol/EncryptedFrame.cpp
    src/protocol/PacketParser.cpp
    src/protocol/DiabloBoardPacketParser.cpp
    src/streams/SensorFramePipeline.cpp
    src/elodin/ElodinClient.cpp
    src/elodin/DatabaseConfig.cpp
    src/routing/SensorRouter.cpp
    src/routing/FrameToElodinMapper.cpp
    src/config/BoardDiscovery.cpp
    src/config/DynamicConfigManager.cpp
    src/config/SensorAssignment.cpp
    src/fsw/FSWConfigManager.cpp
)

# Create shared library for daq_comms
add_library(daq_comms_lib SHARED ${DAQ_COMMS_SOURCES})

# Include directories
target_include_directories(daq_comms_lib PUBLIC
    ${CMAKE_SOURCE_DIR}/daq_comms/include
    ${CMAKE_SOURCE_DIR}/comms/include
    ${CMAKE_SOURCE_DIR}/utl
)

# Link libraries
target_link_libraries(daq_comms_lib
    Threads::Threads
    pthread
    rt
)

# Main daq_bridge executable
add_executable(daq_bridge src/daq_bridge_main.cpp)

target_include_directories(daq_bridge PRIVATE
    ${CMAKE_SOURCE_DIR}/daq_comms/include
    ${CMAKE_SOURCE_DIR}/comms/include
)

target_link_libraries(daq_bridge
    daq_comms_lib
    Threads::Threads
    pthread
    rt
)

# Fake packet generator for testing
add_executable(fake_packet_generator src/fake_packet_generator.cpp)

target_link_libraries(fake_packet_generator
    Threads::Threads
    pthread
    rt
)

# Test program to send fake PT messages directly to DB (like FSW's send_fake_bar.cpp)
add_executable(send_fake_pt test/send_fake_pt.cpp)

target_include_directories(send_fake_pt PRIVATE
    ${CMAKE_SOURCE_DIR}/daq_comms/include
    ${CMAKE_SOURCE_DIR}/comms/include
    ${CMAKE_SOURCE_DIR}/utl
)

target_link_libraries(send_fake_pt
    daq_comms_lib
    Threads::Threads
    pthread
    rt
)

# Test program to send fake data for ALL sensor types (PT, TC, RTD, LC)
add_executable(send_all_sensors test/send_all_sensors.cpp)

target_include_directories(send_all_sensors PRIVATE
    ${CMAKE_SOURCE_DIR}/daq_comms/include
    ${CMAKE_SOURCE_DIR}/comms/include
    ${CMAKE_SOURCE_DIR}/utl
)

target_link_libraries(send_all_sensors
    daq_comms_lib
    Threads::Threads
    pthread
    rt
)

# Install targets
install(TARGETS daq_comms_lib daq_bridge fake_packet_generator
    RUNTIME DESTINATION bin
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
)

