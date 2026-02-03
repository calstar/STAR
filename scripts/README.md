# Scripts Directory

This directory contains all scripts, tools, and utilities for the sensor system, organized into logical subdirectories.

## 📁 Directory Structure

### `startup/` - System Startup & Shutdown Scripts
Shell scripts for starting and stopping system components:
- `startup_daq_db.sh` - Start Elodin database for DAQ system
- `startup_daq_bridge.sh` - Start DAQ bridge service
- `start_engine_controller.sh` - Start engine controller service
- `start_remote_sensors.sh` - Start remote sensor collection
- `stop_daq.sh` - Stop all DAQ services
- `run_simulated_stack.sh` - Run simulated sensor stack
- `setup_esp32_config.sh` - Configure ESP32 connections

### `test/` - Test Scripts
Test scripts for validating system components:
- `test_*.sh` - Shell-based test scripts
- `test_*.py` - Python-based test scripts
- `test_elodin_editor.sh` - Test Elodin editor integration
- `test_fsw_elodin.sh` - Test FSW Elodin integration
- `test_pt_db.sh` - Test PT database functionality
- `test_full_pipeline.sh` - End-to-end pipeline tests

### `calibration/` - Calibration Scripts
Python scripts for sensor calibration:
- `calibration_sequence.py` - Main calibration sequence
- `calibration_performance_monitor.py` - Monitor calibration performance
- `calibration_robustness.py` - Test calibration robustness
- `pt_calibration_gui.py` - PT calibration GUI
- `robust_pt_calibration_gui.py` - Robust PT calibration GUI
- `smart_calibration_gui.py` - Smart calibration GUI
- `start_calibration_system.py` - Start calibration system
- `test_calibration_system.py` - Test calibration system
- `autonomous_calibration_engine.py` - Autonomous calibration engine

### `tools/` - Utility Tools
General-purpose utility scripts:
- `channel_plotter.py` - Plot sensor channel data
- `view_sensor_data.py` - View sensor data
- `fake_diablo_packet.py` - Generate fake Diablo packets
- `health_check.sh` - System health check utility

### `source/` - C++ Source Files
C++ source files that are compiled into executables:
- `esp32_pt_streamer.cpp` - ESP32 PT streamer (compiled to `esp32_pt_streamer`)
- `esp32_streamer.cpp` - ESP32 streamer
- `fake_esp32_packet_gen.cpp` - Fake ESP32 packet generator (compiled to `fake_esp32_packet_gen`)
- `fake_sensor_generator.cpp` - Fake sensor data generator
- `fake_sensor_generator_remote.cpp` - Remote fake sensor generator

### `systemd/` - Systemd Service Files
Systemd service unit files:
- `engine_controller.service` - Engine controller systemd service

## 🚀 Quick Reference

### Starting the System
```bash
# Start DAQ database
./scripts/startup/startup_daq_db.sh

# Start DAQ bridge
./scripts/startup/startup_daq_bridge.sh

# Start engine controller
./scripts/startup/start_engine_controller.sh
```

### Running Tests
```bash
# Run all tests
./scripts/test/test_full_pipeline.sh

# Test Elodin integration
./scripts/test/test_elodin_editor.sh
```

### Calibration
```bash
# Run calibration sequence
python3 scripts/calibration/calibration_sequence.py

# Start calibration GUI
python3 scripts/calibration/smart_calibration_gui.py
```

### Building C++ Tools
The C++ source files in `source/` are built via CMake:
```bash
cd build
cmake ..
make esp32_pt_streamer fake_esp32_packet_gen
```

## 📝 Notes

- All shell scripts should be executable (`chmod +x`)
- Python scripts require Python 3.8+ and dependencies from `requirements.txt`
- C++ source files are compiled as part of the main build system
- Service files in `systemd/` are installed to `/etc/systemd/system/` during installation

