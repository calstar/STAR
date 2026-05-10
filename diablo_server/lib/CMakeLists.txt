# Shared C++ library for the Diablo Server pipeline
# Builds fsw_daq_lib: config, routing, elodin, calibration, control logic

set(FSW_SOURCES
    src/util/IpFromMac.cpp
    src/config/BoardDiscovery.cpp
    src/config/DynamicConfigManager.cpp
    src/config/SensorAssignment.cpp
    src/config/ConfigParser.cpp
    src/config/LoadActiveBoards.cpp
    src/routing/HeartbeatRouter.cpp
    src/routing/SensorRouter.cpp
    src/elodin/DatabaseConfig.cpp
    src/elodin/ElodinClient.cpp
    src/streams/SensorFramePipeline.cpp
    src/fsw/FSWConfigManager.cpp
    src/control/PressureStateMachine.cpp
    src/calibration/PTCalibration.cpp
    src/calibration/SensorCalibration.cpp
    src/calibration/AllanVariance.cpp
    src/calibration/RobustCalibrationFramework.cpp
    src/calibration/RobustCalibrationManager.cpp
    src/control/ControllerLUT.cpp
    src/control/RobustDDPController.cpp
    src/control/ControllerService.cpp
    src/DataLoggerService.cpp
    # src/calibration/IMUCalibration.cpp  (disabled)
)

add_library(fsw_daq_lib SHARED ${FSW_SOURCES})

find_package(Eigen3 REQUIRED)

target_include_directories(fsw_daq_lib PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/../transport/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../../archive/legacy/utl
)

target_link_libraries(fsw_daq_lib
    daq_comms_lib
    daqv2_comms
    Eigen3::Eigen
    Threads::Threads
    pthread
    ${RT_LIBRARY}
)

# C++ unit tests
add_executable(test_robust_ddp test/test_robust_ddp.cpp)
target_include_directories(test_robust_ddp PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../transport/include
)
target_link_libraries(test_robust_ddp
    fsw_daq_lib daq_comms_lib Eigen3::Eigen Threads::Threads pthread ${RT_LIBRARY})

add_executable(test_sequencer_elodin
    test/test_sequencer_elodin.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/SequencerService.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/StateMachine.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/ActuatorCommander.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/AbortBroadcaster.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/FireManager.cpp
)
target_include_directories(test_sequencer_elodin PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../transport/include
)
target_link_libraries(test_sequencer_elodin
    fsw_daq_lib daq_comms_lib daqv2_comms Threads::Threads pthread ${RT_LIBRARY})

install(TARGETS fsw_daq_lib
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
)
