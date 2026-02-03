cmake_minimum_required(VERSION 3.20)
project(LiquidEngineFlightSoftware VERSION 1.0.0 LANGUAGES CXX)

# Set C++ standard
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Compiler flags
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wall -Wextra -Wpedantic")
set(CMAKE_CXX_FLAGS_DEBUG "-g -O0 -DDEBUG")
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG")

# Find required packages
find_package(Eigen3 REQUIRED)
find_package(PkgConfig REQUIRED)
find_package(Threads REQUIRED)

# Find optional packages
find_package(PkgConfig QUIET)
if(PkgConfig_FOUND)
    pkg_check_modules(LIBCANARD QUIET libcanard)
endif()

# Include directories
include_directories(
    ${CMAKE_SOURCE_DIR}/FSW/include
    ${CMAKE_SOURCE_DIR}/FSW/calibration/include
    ${CMAKE_SOURCE_DIR}/FSW/comms/include
    ${CMAKE_SOURCE_DIR}/FSW/control/include
    ${CMAKE_SOURCE_DIR}/FSW/nav/include
    ${CMAKE_SOURCE_DIR}/FSW/state/include
    ${CMAKE_SOURCE_DIR}/comms/include
    ${CMAKE_SOURCE_DIR}/utl
)

# External dependencies
include_directories(${EIGEN3_INCLUDE_DIRS})

# Source files for flight software (main executable only)
set(FSW_SOURCES
    FSW/src/main.cpp
    # Control system sources
    FSW/control/src/EngineControl.cpp
    FSW/control/src/ValveController.cpp
    FSW/control/src/GainScheduling.cpp
    FSW/control/src/OptimalController.cpp
    # Communication system sources
    FSW/comms/src/PacketProtocol.cpp
    FSW/comms/src/CommunicationProtocol.cpp
    FSW/comms/src/ESP32SerialHandler.cpp
    FSW/comms/src/ESP32ConfigParser.cpp
    # Calibration system sources
    FSW/calibration/src/SensorCalibration.cpp
    FSW/calibration/src/EncoderCalibration.cpp
    FSW/calibration/src/PTCalibrationFramework.cpp
    FSW/calibration/src/SmartCalibrationSystem.cpp
    FSW/calibration/src/EnvironmentalRobustCalibration.cpp
    FSW/calibration/src/PTCalibrationTool.cpp
    FSW/calibration/src/PTCalibrationMonitor.cpp
    # Navigation system sources
    FSW/nav/src/SensorFusion.cpp
    FSW/nav/src/EKFNavigation.cpp
    FSW/nav/src/ObservationMatrix.cpp
    FSW/nav/src/PTObservationMatrixBuilder.cpp
    # State management sources
    FSW/state/src/StateMachine.cpp
)

# Source files for shared library (used by examples) - only include implemented files
set(FSW_LIB_SOURCES
    # Control system sources (only EngineControl has implementation)
    FSW/control/src/EngineControl.cpp
    # Communication system sources
    FSW/comms/src/ESP32SerialHandler.cpp
    FSW/comms/src/ESP32ConfigParser.cpp
    # Calibration system sources
    FSW/calibration/src/SensorCalibration.cpp
    FSW/calibration/src/EncoderCalibration.cpp
    FSW/calibration/src/PTCalibrationFramework.cpp
    FSW/calibration/src/SmartCalibrationSystem.cpp
    FSW/calibration/src/EnvironmentalRobustCalibration.cpp
    FSW/calibration/src/PTCalibrationTool.cpp
    FSW/calibration/src/PTCalibrationMonitor.cpp
    # Navigation system sources
    FSW/nav/src/SensorFusion.cpp
    FSW/nav/src/ObservationMatrix.cpp
    FSW/nav/src/PTObservationMatrixBuilder.cpp
)

# Source files for utilities
set(UTL_SOURCES
    # Note: utl/ directory contains only header files (.hpp)
    # No .cpp files needed as they are template/header-only libraries
)

# Create shared library for examples
add_library(fsw_lib SHARED ${FSW_LIB_SOURCES} ${UTL_SOURCES})

# Create flight software executable (commented out until all source implementations are added)
# add_executable(engine_controller ${FSW_SOURCES} ${UTL_SOURCES})

# Create example executables
add_executable(esp32_integration_example FSW/src/esp32_integration_example.cpp)
add_executable(pt_integration_example FSW/src/pt_integration_example.cpp)
add_executable(raw_voltage_pt_example FSW/src/raw_voltage_pt_example.cpp)
add_executable(configurable_pt_example FSW/src/configurable_pt_example.cpp)
add_executable(pt_calibration_example FSW/src/pt_calibration_example.cpp)
add_executable(complete_calibration_pipeline FSW/src/complete_calibration_pipeline.cpp)
add_executable(paper_algorithm_pipeline FSW/src/paper_algorithm_pipeline.cpp)

# ESP32 PT Streamer for calibration (Rec18 format)
add_executable(esp32_pt_streamer scripts/source/esp32_pt_streamer.cpp)
target_link_libraries(esp32_pt_streamer Threads::Threads pthread rt)

# Fake ESP32 packet generator for testing
add_executable(fake_esp32_packet_gen scripts/source/fake_esp32_packet_gen.cpp)
target_link_libraries(fake_esp32_packet_gen Threads::Threads pthread rt)

# FSW Simulator for Elodin groundstation testing
add_executable(test_fsw_simulator scripts/test/test_fsw_simulator.cpp)
target_link_libraries(test_fsw_simulator daq_comms_lib Threads::Threads pthread rt)
target_include_directories(test_fsw_simulator PRIVATE
    ${CMAKE_SOURCE_DIR}/daq_comms/include
    ${CMAKE_SOURCE_DIR}/comms/include
    ${CMAKE_SOURCE_DIR}/utl
)

# Link libraries for main executable (commented out until all source implementations are added)
# target_link_libraries(engine_controller
#     Eigen3::Eigen
#     Threads::Threads
#     pthread
#     rt
# )

# Link libraries for shared library
target_link_libraries(fsw_lib
    Eigen3::Eigen
    Threads::Threads
    pthread
    rt
)

# Link example executables to shared library
target_link_libraries(esp32_integration_example fsw_lib)
target_link_libraries(pt_integration_example fsw_lib)
target_link_libraries(raw_voltage_pt_example fsw_lib)
target_link_libraries(configurable_pt_example fsw_lib)
target_link_libraries(pt_calibration_example fsw_lib)
target_link_libraries(complete_calibration_pipeline fsw_lib)
target_link_libraries(paper_algorithm_pipeline fsw_lib)

# Link optional libraries
if(LIBCANARD_FOUND)
    target_link_libraries(fsw_lib ${LIBCANARD_LIBRARIES})
    target_compile_options(fsw_lib PRIVATE ${LIBCANARD_CFLAGS_OTHER})
endif()

# Compiler-specific options
if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    target_compile_options(fsw_lib PRIVATE -Wno-unused-parameter)
elseif(CMAKE_CXX_COMPILER_ID STREQUAL "Clang")
    target_compile_options(fsw_lib PRIVATE -Wno-unused-parameter)
endif()

# Install targets
install(TARGETS fsw_lib
    RUNTIME DESTINATION bin
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
)

# Install example executables
install(TARGETS esp32_integration_example pt_integration_example raw_voltage_pt_example
        configurable_pt_example pt_calibration_example complete_calibration_pipeline
        paper_algorithm_pipeline
    RUNTIME DESTINATION bin/examples
)

# Install configuration files
install(FILES config/config_engine.toml
    DESTINATION /etc/engine_controller
)

# Install systemd service file
install(FILES scripts/systemd/engine_controller.service
    DESTINATION /etc/systemd/system
)

# Create calibration directory
install(DIRECTORY DESTINATION /var/lib/engine_controller/calibrations)

# Create log directory
install(DIRECTORY DESTINATION /var/log/engine_controller)

# Add daq_comms subdirectory (must be before test targets that use it)
add_subdirectory(daq_comms)

# Testing
enable_testing()

# Add unit tests if they exist
if(EXISTS ${CMAKE_SOURCE_DIR}/tests)
    add_subdirectory(tests)
endif()

# Documentation
find_package(Doxygen QUIET)
if(DOXYGEN_FOUND AND EXISTS ${CMAKE_SOURCE_DIR}/docs/Doxyfile.in)
    configure_file(${CMAKE_SOURCE_DIR}/docs/Doxyfile.in
                   ${CMAKE_BINARY_DIR}/Doxyfile @ONLY)
    add_custom_target(docs
        COMMAND ${DOXYGEN_EXECUTABLE} ${CMAKE_BINARY_DIR}/Doxyfile
        WORKING_DIRECTORY ${CMAKE_BINARY_DIR}
        COMMENT "Generating API documentation with Doxygen"
        VERBATIM
    )
elseif(DOXYGEN_FOUND)
    message(STATUS "Doxygen found but Doxyfile.in not found, skipping documentation generation")
else()
    message(STATUS "Doxygen not found, skipping documentation generation")
endif()

# Packaging
set(CPACK_PACKAGE_NAME "liquid-engine-flight-software")
set(CPACK_PACKAGE_VERSION ${PROJECT_VERSION})
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Liquid Engine Flight Software")
set(CPACK_PACKAGE_VENDOR "Your Organization")
set(CPACK_PACKAGE_CONTACT "your.email@organization.com")

include(CPack)