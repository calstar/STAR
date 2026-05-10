# C++ services for the Diablo Server pipeline
# Each service subdirectory contains only .cpp files (no public headers)

set(COMMON_INCLUDES
    ${CMAKE_CURRENT_SOURCE_DIR}/../lib/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../transport/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../../archive/legacy/utl
)

find_package(Eigen3 REQUIRED)

# ── Sequencer Service ─────────────────────────────────────────────────────────
# State machine, actuator commanding, abort, FIRE lifecycle
add_executable(sequencer_service
    sequencer/sequencer_main.cpp
    sequencer/SequencerService.cpp
    sequencer/StateMachine.cpp
    sequencer/ActuatorCommander.cpp
    sequencer/AbortBroadcaster.cpp
    sequencer/FireManager.cpp
)
target_include_directories(sequencer_service PRIVATE ${COMMON_INCLUDES})
target_link_libraries(sequencer_service
    fsw_daq_lib daq_comms_lib daqv2_comms
    Eigen3::Eigen Threads::Threads pthread ${RT_LIBRARY}
)

# ── Controller Service ────────────────────────────────────────────────────────
# Thrust/altitude control (LUT-based or robust DDP)
add_executable(controller_service controller/controller_main.cpp)
target_include_directories(controller_service PRIVATE ${COMMON_INCLUDES})
target_link_libraries(controller_service
    fsw_daq_lib daq_comms_lib Eigen3::Eigen Threads::Threads pthread ${RT_LIBRARY}
)

# ── Calibration Service ───────────────────────────────────────────────────────
add_executable(calibration_service calibration/calibration_main.cpp)
target_include_directories(calibration_service PRIVATE ${COMMON_INCLUDES})
target_link_libraries(calibration_service
    fsw_daq_lib daq_comms_lib Eigen3::Eigen Threads::Threads pthread ${RT_LIBRARY}
)

# ── Heartbeat Service ─────────────────────────────────────────────────────────
# SERVER_HEARTBEAT UDP broadcast; reads engine state from Elodin [0x5000]
add_executable(heartbeat_service heartbeat/heartbeat_service_main.cpp)
target_include_directories(heartbeat_service PRIVATE ${COMMON_INCLUDES})
target_link_libraries(heartbeat_service
    fsw_daq_lib daq_comms_lib Threads::Threads pthread ${RT_LIBRARY}
)

# ── Config Broadcast Service ──────────────────────────────────────────────────
# ACTUATOR_CONFIG / SENSOR_CONFIG UDP broadcast
add_executable(config_broadcast_service config_broadcast/config_broadcast_service_main.cpp)
target_include_directories(config_broadcast_service PRIVATE ${COMMON_INCLUDES})
target_link_libraries(config_broadcast_service fsw_daq_lib pthread ${RT_LIBRARY})

# ── OTA Service ───────────────────────────────────────────────────────────────
# Ethernet firmware flash for ESP32-S3 boards over TCP:3232
add_executable(ota_service ota/ota_service_main.cpp)
target_include_directories(ota_service PRIVATE ${COMMON_INCLUDES})
target_link_libraries(ota_service Threads::Threads pthread ${RT_LIBRARY})

# ── Data Logger Service ───────────────────────────────────────────────────────
add_executable(data_logger_service data_logger/data_logger_main.cpp)
target_include_directories(data_logger_service PRIVATE ${COMMON_INCLUDES})
target_link_libraries(data_logger_service
    fsw_daq_lib daq_comms_lib Threads::Threads pthread ${RT_LIBRARY}
)

# ── uWebSockets (optional, for future fsw_web_bridge) ────────────────────────
set(USOCKETS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../external/uWebSockets")
if(EXISTS "${USOCKETS_DIR}/uSockets/src")
    file(GLOB USOCKETS_SOURCES
        "${USOCKETS_DIR}/uSockets/src/*.c"
        "${USOCKETS_DIR}/uSockets/src/eventing/*.c"
        "${USOCKETS_DIR}/uSockets/src/crypto/*.c"
    )
    add_library(usockets STATIC ${USOCKETS_SOURCES})
    target_include_directories(usockets PUBLIC ${USOCKETS_DIR}/uSockets/src)
    target_compile_definitions(usockets PRIVATE LIBUS_USE_OPENSSL)
    target_compile_options(usockets PRIVATE -Wno-deprecated-declarations)
else()
    message(STATUS "uWebSockets not found, skipping usockets")
endif()

install(TARGETS
    sequencer_service controller_service calibration_service
    heartbeat_service config_broadcast_service ota_service data_logger_service
    RUNTIME DESTINATION bin
)
