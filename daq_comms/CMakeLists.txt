# CMakeLists.txt for daq_comms library
# Transport + shared message types (on-wire Diablo framing lives in external/DAQv2-Comms only).

set(DAQ_COMMS_SOURCES
    src/transport/NetworkSocket.cpp
    src/transport/TCPClient.cpp
)

# Create shared library for daq_comms
add_library(daq_comms_lib SHARED ${DAQ_COMMS_SOURCES})

# Include directories
target_include_directories(daq_comms_lib PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# Link libraries
target_link_libraries(daq_comms_lib
    Threads::Threads
    pthread
    ${RT_LIBRARY}
)

# Install targets
install(TARGETS daq_comms_lib
    RUNTIME DESTINATION bin
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
)
