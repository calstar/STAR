# CMakeLists.txt for FSW (Flight Software)
# Contains: config, routing, elodin, discovery, calibration, etc.

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Threads REQUIRED)
find_package(ZLIB REQUIRED)
find_package(OpenSSL REQUIRED)

add_subdirectory(${CMAKE_SOURCE_DIR}/../daq_comms ${CMAKE_BINARY_DIR}/daq_comms)

# Source files for FSW library
set(FSW_SOURCES
    src/config/BoardDiscovery.cpp
    src/config/DynamicConfigManager.cpp
    src/config/SensorAssignment.cpp
    src/config/ConfigParser.cpp
    src/routing/FrameToElodinMapper.cpp
    src/routing/SensorRouter.cpp
    src/elodin/DatabaseConfig.cpp
    src/elodin/ElodinClient.cpp
    src/streams/SensorFramePipeline.cpp
    src/fsw/FSWConfigManager.cpp
    src/control/PressureStateMachine.cpp
    src/calibration/PTCalibration.cpp
    src/calibration/SensorCalibration.cpp
    src/control/RobustDDPController.cpp
    src/control/ControllerService.cpp
    # src/nav/EKFNavigationEnhanced.cpp
    # src/calibration/IMUCalibration.cpp
    # Calibration pipeline (if needed)
    # src/calibration/PTCalibrationPipeline.cpp
)

# Create shared library for FSW (renamed to avoid conflict with root CMakeLists)
add_library(fsw_daq_lib SHARED ${FSW_SOURCES})

# Include directories
target_include_directories(fsw_daq_lib PUBLIC
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src
    ${CMAKE_SOURCE_DIR}/../daq_comms/include  # For messages and parser
    ${CMAKE_SOURCE_DIR}/calibration/include
    ${CMAKE_SOURCE_DIR}/../archive/legacy/utl
)

# Find Eigen3 for calibration framework
find_package(Eigen3 REQUIRED)

# Link libraries
target_link_libraries(fsw_daq_lib
    daq_comms_lib  # Link to daq_comms for messages and parser
    Eigen3::Eigen
    Threads::Threads
    pthread
    ${RT_LIBRARY}
)

# Main daq_bridge executable
add_executable(daq_bridge src/daq_bridge_main.cpp)

target_include_directories(daq_bridge PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/../daq_comms/include
)

target_link_libraries(daq_bridge
    fsw_daq_lib
    daq_comms_lib
    Threads::Threads
    pthread
    ${RT_LIBRARY}
)

# Test program to send all sensors from config
# add_executable(send_all_sensors_from_config test/send_all_sensors_from_config.cpp)

# target_include_directories(send_all_sensors_from_config PRIVATE
#     ${CMAKE_SOURCE_DIR}/include
#     ${CMAKE_SOURCE_DIR}/../daq_comms/include
#     ${CMAKE_SOURCE_DIR}/../archive/legacy/utl
# )

# target_link_libraries(send_all_sensors_from_config
#     fsw_daq_lib
#     daq_comms_lib
#     Threads::Threads
#     pthread
#     ${RT_LIBRARY}
# )

# SITL Simulator executable
# add_executable(sitl_simulator src/sitl/sitl_main.cpp src/sitl/SITLSimulator.cpp)

# target_include_directories(sitl_simulator PRIVATE
#     ${CMAKE_SOURCE_DIR}/include
#     ${CMAKE_SOURCE_DIR}/../daq_comms/include
#     ${CMAKE_SOURCE_DIR}/../archive/legacy/utl
# )

# target_link_libraries(sitl_simulator
#     fsw_daq_lib
#     daq_comms_lib
#     Eigen3::Eigen
#     Threads::Threads
#     pthread
#     ${RT_LIBRARY}
# )

# Robust DDP Controller test executable
add_executable(test_robust_ddp test/test_robust_ddp.cpp)

target_include_directories(test_robust_ddp PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/../daq_comms/include
)

target_link_libraries(test_robust_ddp
    fsw_daq_lib
    daq_comms_lib
    Eigen3::Eigen
    Threads::Threads
    pthread
    ${RT_LIBRARY}
)

# Controller Service standalone executable
add_executable(controller_service src/control/controller_main.cpp)

target_include_directories(controller_service PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/../daq_comms/include
    ${CMAKE_SOURCE_DIR}/../archive/legacy/utl
)

target_link_libraries(controller_service
    fsw_daq_lib
    daq_comms_lib
    Eigen3::Eigen
    Threads::Threads
    pthread
    ${RT_LIBRARY}
)

# IMU Calibration test executable
# add_executable(test_imu_calibration test/test_imu_calibration.cpp)

# target_include_directories(test_imu_calibration PRIVATE
#     ${CMAKE_SOURCE_DIR}/include
#     ${CMAKE_SOURCE_DIR}/../daq_comms/include
# )

# target_link_libraries(test_imu_calibration
#     fsw_daq_lib
#     daq_comms_lib
#     Eigen3::Eigen
#     Threads::Threads
#     pthread
#     ${RT_LIBRARY}
# )


# uSockets library
file(GLOB USOCKETS_SOURCES "external/uWebSockets/uSockets/src/*.c" "external/uWebSockets/uSockets/src/eventing/*.c" "external/uWebSockets/uSockets/src/crypto/*.c")
add_library(usockets STATIC ${USOCKETS_SOURCES})
target_include_directories(usockets PUBLIC external/uWebSockets/uSockets/src)
target_compile_definitions(usockets PRIVATE LIBUS_USE_OPENSSL LIBUS_NO_SSL)

# FSW WebSocket Bridge executable
add_executable(fsw_web_bridge src/fsw_web_bridge.cpp)

target_include_directories(fsw_web_bridge PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/../archive/legacy/utl
    ${CMAKE_SOURCE_DIR}/external/uWebSockets/src
    ${CMAKE_SOURCE_DIR}/external/uWebSockets/uSockets/src
)

target_link_libraries(fsw_web_bridge
    fsw_daq_lib
    usockets
    Threads::Threads
    pthread
    ZLIB::ZLIB
    OpenSSL::SSL
    OpenSSL::Crypto
    ${RT_LIBRARY}
)

# Install targets
install(TARGETS fsw_daq_lib daq_bridge controller_service fsw_web_bridge
    RUNTIME DESTINATION bin
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
)
