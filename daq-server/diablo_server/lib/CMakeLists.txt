# Shared C++ library for the Diablo Server pipeline
# Builds fsw_daq_lib: config, routing, elodin, calibration, control logic

set(FSW_SOURCES
    src/util/IpFromMac.cpp
    src/net/DaqInterface.cpp
    src/config/BoardDiscovery.cpp
    src/config/DynamicConfigManager.cpp
    src/config/SensorAssignment.cpp
    src/config/LoadActiveBoards.cpp
    src/config/Config.cpp
    src/routing/HeartbeatRouter.cpp
    src/routing/SensorRouter.cpp
    src/time/BoardClockSync.cpp
    src/elodin/DatabaseConfig.cpp
    src/elodin/ElodinClient.cpp
    src/streams/SensorFramePipeline.cpp
    src/fsw/FSWConfigManager.cpp
    src/control/PressureStateMachine.cpp
    src/calibration/PTCalibration.cpp
    src/calibration/CubicCalibrationStore.cpp
    src/calibration/SensorCalibration.cpp
    src/calibration/AllanVariance.cpp
    src/calibration/RobustCalibrationFramework.cpp
    src/calibration/RobustCalibrationManager.cpp
    src/control/ControllerLUT.cpp
    src/control/RobustDDPController.cpp
    src/control/ControllerService.cpp
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

add_executable(test_board_clock_sync test/test_board_clock_sync.cpp)
target_include_directories(test_board_clock_sync PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_link_libraries(test_board_clock_sync
    fsw_daq_lib daq_comms_lib Threads::Threads pthread ${RT_LIBRARY})
add_test(NAME board_clock_sync COMMAND test_board_clock_sync)

add_executable(test_fire_lifecycle
    test/test_fire_lifecycle.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/FireManager.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/StateMachine.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/ActuatorCommander.cpp
)
target_include_directories(test_fire_lifecycle PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../transport/include
)
target_link_libraries(test_fire_lifecycle
    fsw_daq_lib daq_comms_lib daqv2_comms Threads::Threads pthread ${RT_LIBRARY})
add_test(NAME fire_lifecycle COMMAND test_fire_lifecycle)

add_executable(test_actuator_delays
    test/test_actuator_delays.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/ActuatorCommander.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/StateMachine.cpp
)
target_include_directories(test_actuator_delays PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../transport/include
)
target_link_libraries(test_actuator_delays
    fsw_daq_lib daq_comms_lib daqv2_comms Threads::Threads pthread ${RT_LIBRARY})
add_test(NAME actuator_delays COMMAND test_actuator_delays)

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

# test_robust_ddp has been built on every configure since it was added but was never registered
# with CTest and is not invoked by CI either, so its assertions have never gated anything.
add_test(NAME robust_ddp COMMAND test_robust_ddp)

# ElodinClient framing, against a fake elodin-db it drives itself (nothing a real db emits today
# is large enough to reach the oversize path, which is why the bug went unnoticed).
add_executable(test_elodin_read_path test/test_elodin_read_path.cpp)
target_include_directories(test_elodin_read_path PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../transport/include
)
target_link_libraries(test_elodin_read_path
    fsw_daq_lib daq_comms_lib daqv2_comms Threads::Threads pthread ${RT_LIBRARY})
add_test(NAME elodin_read_path COMMAND test_elodin_read_path)

# test_sequencer_elodin has been built on every configure since it was added but was never
# registered with CTest, so like test_robust_ddp before it, its assertions have never gated
# anything. It drives a real SequencerService against a throwaway TCP server, so it needs the
# build-tree root as its cwd to resolve config/.
add_test(NAME sequencer_elodin COMMAND test_sequencer_elodin
         WORKING_DIRECTORY ${CMAKE_BINARY_DIR})

# The DAQ NIC resolver. Pure library code — no sockets to a peer, no config files on disk — so it
# needs none of the working-directory or serialization care the sequencer tests below do.
add_executable(test_daq_interface test/test_daq_interface.cpp)
target_include_directories(test_daq_interface PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../transport/include
)
target_link_libraries(test_daq_interface fsw_daq_lib Threads::Threads pthread ${RT_LIBRARY})
add_test(NAME daq_interface COMMAND test_daq_interface)

# Which actuators the controller PWMs, resolved from config. Pure resolution like the NIC test
# above — config comes from strings, so no working-directory care is needed.
add_executable(test_controller_pwm_roles test/test_controller_pwm_roles.cpp)
target_include_directories(test_controller_pwm_roles PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../transport/include
)
target_link_libraries(test_controller_pwm_roles fsw_daq_lib Threads::Threads pthread ${RT_LIBRARY})
add_test(NAME controller_pwm_roles COMMAND test_controller_pwm_roles)

# Concurrency + abort ordering. Both drive a real SequencerService, so they need the same sources
# test_sequencer_elodin links. They resolve config/ and the state CSVs relative to the working
# directory (cwd, ../, ../../), which is why they run from the build dir under CTest.
foreach(seq_test test_sequencer_concurrency test_abort_ordering)
    add_executable(${seq_test}
        test/${seq_test}.cpp
        ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/SequencerService.cpp
        ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/StateMachine.cpp
        ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/ActuatorCommander.cpp
        ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/AbortBroadcaster.cpp
        ${CMAKE_CURRENT_SOURCE_DIR}/../services/sequencer/FireManager.cpp
    )
    target_include_directories(${seq_test} PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/../transport/include
    )
    target_link_libraries(${seq_test}
        fsw_daq_lib daq_comms_lib daqv2_comms Threads::Threads pthread ${RT_LIBRARY})
endforeach()

# WORKING_DIRECTORY matters here. Both tests build a real SequencerService, which resolves
# config/config.toml and the state CSVs by trying "", "../" and "../../" from the cwd. CTest
# otherwise runs a test from the build directory of the CMakeLists that declared it
# (build/diablo_server/lib), which is three levels down — none of the three prefixes reach
# daq-server/config from there, and init() fails. From the top of the build tree "../config/..."
# resolves, which is also how CI invokes the other sequencer binaries.
add_test(NAME sequencer_concurrency COMMAND test_sequencer_concurrency
         WORKING_DIRECTORY ${CMAKE_BINARY_DIR})
add_test(NAME abort_ordering COMMAND test_abort_ordering
         WORKING_DIRECTORY ${CMAKE_BINARY_DIR})
# The concurrency test deliberately runs a storm for ~8 s and the abort test waits on a blackholed
# connect; neither should be strangled by CTest's default timeout on a loaded runner.
set_tests_properties(sequencer_concurrency abort_ordering PROPERTIES TIMEOUT 120)
# They bind fixed resources (the abort broadcast port) and saturate the box, so keep them off each
# other when ctest runs in parallel.
set_tests_properties(sequencer_concurrency abort_ordering PROPERTIES RUN_SERIAL TRUE)

install(TARGETS fsw_daq_lib
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
)
