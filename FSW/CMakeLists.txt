# CMakeLists.txt for FSW (Flight Software)
# Contains: config, routing, elodin, discovery, calibration, etc.

cmake_minimum_required(VERSION 3.16)
project(FSW_DAQ_Bridge)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Threads REQUIRED)
find_package(ZLIB REQUIRED)
find_package(OpenSSL REQUIRED)

# When built from repo root, daq_comms is already added; when built from FSW/build, add it
if(NOT TARGET daq_comms_lib)
    add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../daq_comms ${CMAKE_BINARY_DIR}/daq_comms)
endif()

# Source files for FSW library
set(FSW_SOURCES
    src/config/BoardDiscovery.cpp
    src/config/DynamicConfigManager.cpp
    src/config/SensorAssignment.cpp
    src/config/ConfigParser.cpp
    src/routing/HeartbeatRouter.cpp
    src/routing/SensorRouter.cpp
    src/elodin/DatabaseConfig.cpp
    src/elodin/ElodinClient.cpp
    src/streams/SensorFramePipeline.cpp
    src/fsw/FSWConfigManager.cpp
    src/control/PressureStateMachine.cpp
    src/calibration/PTCalibration.cpp
    src/calibration/SensorCalibration.cpp
    src/control/ControllerLUT.cpp
    src/control/RobustDDPController.cpp
    src/control/ControllerService.cpp
    # src/nav/EKFNavigationEnhanced.cpp
    # src/calibration/IMUCalibration.cpp
    # Calibration pipeline (if needed)
    # src/calibration/PTCalibrationPipeline.cpp
)

# Create shared library for FSW (renamed to avoid conflict with root CMakeLists)
add_library(fsw_daq_lib SHARED ${FSW_SOURCES})

# Include directories (CMAKE_CURRENT_SOURCE_DIR = FSW when built from root or from FSW/build)
target_include_directories(fsw_daq_lib PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/../daq_comms/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../archive/legacy/utl
)

# Find Eigen3 for calibration framework
find_package(Eigen3 REQUIRED)

# Link libraries
target_link_libraries(fsw_daq_lib
    daq_comms_lib  # Link to daq_comms for messages and transport
    daqv2_comms    # Link to real DAQv2-Comms protocol library
    Eigen3::Eigen
    Threads::Threads
    pthread
    ${RT_LIBRARY}
)

# Main daq_bridge executable
add_executable(daq_bridge src/daq_bridge_main.cpp)

target_include_directories(daq_bridge PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../daq_comms/include
)

target_link_libraries(daq_bridge
    fsw_daq_lib
    daq_comms_lib
    daqv2_comms
    Threads::Threads
    pthread
    ${RT_LIBRARY}
)

# Test program to send all sensors from config
add_executable(send_all_sensors_from_config test/send_all_sensors_from_config.cpp)

target_include_directories(send_all_sensors_from_config PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../daq_comms/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../archive/legacy/utl
)

target_link_libraries(send_all_sensors_from_config
    fsw_daq_lib
    daq_comms_lib
    Threads::Threads
    pthread
    ${RT_LIBRARY}
)

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
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../daq_comms/include
)

target_link_libraries(test_robust_ddp
    fsw_daq_lib
    daq_comms_lib
    Eigen3::Eigen
    Threads::Threads
    pthread
    ${RT_LIBRARY}
)

# Sequencer Elodin DB sync test executable
add_executable(test_sequencer_elodin test/test_sequencer_elodin.cpp)

target_include_directories(test_sequencer_elodin PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../daq_comms/include
)

target_link_libraries(test_sequencer_elodin
    fsw_daq_lib
    daq_comms_lib
    Threads::Threads
    pthread
    ${RT_LIBRARY}
)

# Controller Service standalone executable
add_executable(controller_service src/control/controller_main.cpp)

target_include_directories(controller_service PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../daq_comms/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../archive/legacy/utl
)

target_link_libraries(controller_service
    fsw_daq_lib
    daq_comms_lib
    Eigen3::Eigen
    Threads::Threads
    pthread
    ${RT_LIBRARY}
)

# Calibration Service standalone executable
add_executable(calibration_service src/calibration/calibration_main.cpp)

target_include_directories(calibration_service PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../daq_comms/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../archive/legacy/utl
)

target_link_libraries(calibration_service
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


# uSockets library + FSW WebSocket Bridge (optional: only if uWebSockets present; bridge is WIP)
set(USOCKETS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/external/uWebSockets")
if(EXISTS "${USOCKETS_DIR}/uSockets/src")
    file(GLOB USOCKETS_SOURCES "${USOCKETS_DIR}/uSockets/src/*.c" "${USOCKETS_DIR}/uSockets/src/eventing/*.c" "${USOCKETS_DIR}/uSockets/src/crypto/*.c")
    add_library(usockets STATIC ${USOCKETS_SOURCES})
    target_include_directories(usockets PUBLIC ${USOCKETS_DIR}/uSockets/src)
    target_compile_definitions(usockets PRIVATE LIBUS_USE_OPENSSL LIBUS_NO_SSL)
    # fsw_web_bridge disabled until main/loop/ifstream fixes are in
    if(FALSE)
    add_executable(fsw_web_bridge src/fsw_web_bridge.cpp)
    target_include_directories(fsw_web_bridge PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/../archive/legacy/utl
        ${USOCKETS_DIR}/src
        ${USOCKETS_DIR}/uSockets/src
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
    endif()
else()
    message(STATUS "uWebSockets not found, skipping fsw_web_bridge")
endif()

# Actuator service — receives state transitions, sends UDP commands
# NOTE: superseded by sequencer_service but kept for reference during migration
add_executable(actuator_service src/control/actuator_service_main.cpp)
target_include_directories(actuator_service PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../daq_comms/include
)
target_link_libraries(actuator_service daq_comms_lib pthread ${RT_LIBRARY})

# Sequencer service — state machine, actuator commanding, abort, FIRE lifecycle
# Replaces actuator_service. Publishes state + allowed transitions to Elodin [0x50, 0x00].
add_executable(sequencer_service
    src/control/sequencer_main.cpp
    src/control/SequencerService.cpp
    src/control/StateMachine.cpp
    src/control/ActuatorCommander.cpp
    src/control/AbortBroadcaster.cpp
    src/control/FireManager.cpp
)
target_include_directories(sequencer_service PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../daq_comms/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../archive/legacy/utl
)
target_link_libraries(sequencer_service
    fsw_daq_lib
    daq_comms_lib
    daqv2_comms
    Eigen3::Eigen
    Threads::Threads
    pthread
    ${RT_LIBRARY}
)

# Heartbeat service — SERVER_HEARTBEAT UDP broadcast; reads engine state from Elodin [0x5000]
add_executable(heartbeat_service src/services/heartbeat_service_main.cpp)
target_include_directories(heartbeat_service PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../daq_comms/include
)
target_link_libraries(heartbeat_service fsw_daq_lib daq_comms_lib Threads::Threads pthread ${RT_LIBRARY})

# Config broadcast service — ACTUATOR_CONFIG / SENSOR_CONFIG UDP (C++ replacement for Python)
add_executable(config_broadcast_service src/services/config_broadcast_service_main.cpp)
target_include_directories(config_broadcast_service PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)
target_link_libraries(config_broadcast_service fsw_daq_lib pthread ${RT_LIBRARY})

# OTA service — Ethernet firmware flash for ESP32-S3 boards over TCP:3232
add_executable(ota_service src/services/ota_service_main.cpp)
target_include_directories(ota_service PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_link_libraries(ota_service Threads::Threads pthread ${RT_LIBRARY})

# Install targets
install(TARGETS fsw_daq_lib daq_bridge controller_service calibration_service actuator_service sequencer_service heartbeat_service config_broadcast_service ota_service
    RUNTIME DESTINATION bin
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
)
if(TARGET fsw_web_bridge)
    install(TARGETS fsw_web_bridge RUNTIME DESTINATION bin)
endif()
