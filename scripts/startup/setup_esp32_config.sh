#!/bin/bash

# ESP32 Configuration Setup Script
# Helps users configure ESP32 serial communication settings

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default configuration path
CONFIG_PATH="config/esp32_config.toml"

print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  ESP32 PT Sensor Configuration Setup  ${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

detect_serial_devices() {
    echo "Detecting available serial devices..."
    echo
    
    local devices_found=false
    
    # Linux devices
    if ls /dev/ttyUSB* 2>/dev/null; then
        devices_found=true
        echo "Found USB serial devices:"
        ls -la /dev/ttyUSB* 2>/dev/null | while read line; do
            echo "  $line"
        done
        echo
    fi
    
    if ls /dev/ttyACM* 2>/dev/null; then
        devices_found=true
        echo "Found ACM devices:"
        ls -la /dev/ttyACM* 2>/dev/null | while read line; do
            echo "  $line"
        done
        echo
    fi
    
    # macOS devices
    if ls /dev/cu.usbserial* 2>/dev/null; then
        devices_found=true
        echo "Found USB serial devices (macOS):"
        ls -la /dev/cu.usbserial* 2>/dev/null | while read line; do
            echo "  $line"
        done
        echo
    fi
    
    if ls /dev/cu.usbmodem* 2>/dev/null; then
        devices_found=true
        echo "Found USB modem devices (macOS):"
        ls -la /dev/cu.usbmodem* 2>/dev/null | while read line; do
            echo "  $line"
        done
        echo
    fi
    
    if [ "$devices_found" = false ]; then
        print_warning "No serial devices found. Make sure your ESP32 is connected."
        echo
    fi
}

get_device_path() {
    local device_path=""
    
    echo "Enter the serial device path for your ESP32:"
    echo "Examples:"
    echo "  Linux:   /dev/ttyUSB0, /dev/ttyACM0"
    echo "  macOS:   /dev/cu.usbserial-*, /dev/cu.usbmodem*"
    echo "  Windows: COM3, COM4 (will be converted to /dev/ttyUSB0 format)"
    echo
    read -p "Device path: " device_path
    
    # Convert Windows COM ports to Linux format for configuration
    if [[ $device_path =~ ^COM[0-9]+$ ]]; then
        device_path="/dev/ttyUSB${device_path:3}"
        print_info "Converted Windows COM port to: $device_path"
    fi
    
    echo "$device_path"
}

get_baud_rate() {
    local baud_rate=""
    
    echo "Enter the baud rate for ESP32 communication:"
    echo "Common rates: 9600, 115200, 230400, 460800"
    echo
    read -p "Baud rate [115200]: " baud_rate
    
    if [ -z "$baud_rate" ]; then
        baud_rate="115200"
    fi
    
    echo "$baud_rate"
}

get_operation_mode() {
    local mode=""
    
    echo "Select operation mode:"
    echo "  1) Binary mode (recommended for production)"
    echo "  2) Text mode (for debugging)"
    echo
    read -p "Mode [1]: " mode
    
    case $mode in
        2|"text"|"Text"|"TEXT")
            echo "false"
            ;;
        *)
            echo "true"
            ;;
    esac
}

get_debug_settings() {
    local debug=""
    
    echo "Enable debug output for development?"
    echo "  1) Yes (shows detailed sensor information)"
    echo "  2) No (minimal output)"
    echo
    read -p "Debug mode [2]: " debug
    
    case $debug in
        1|"yes"|"Yes"|"YES")
            echo "true"
            ;;
        *)
            echo "false"
            ;;
    esac
}

create_config_file() {
    local device_path="$1"
    local baud_rate="$2"
    local binary_mode="$3"
    local debug_mode="$4"
    
    # Create config directory if it doesn't exist
    mkdir -p config
    
    # Create configuration file
    cat > "$CONFIG_PATH" << EOF
# ESP32 Serial Communication Configuration
# Configuration file for ESP32 PT sensor integration

[serial]
# Serial port configuration
device_path = "$device_path"
baud_rate = $baud_rate
timeout_ms = 100
max_buffer_size = 1024
enable_binary_mode = $binary_mode

[pt_sensors]
# PT sensor configuration
max_pt_sensors = 9
max_data_age_ms = 1000.0

# PT sensor location mapping (adjust based on your hardware wiring)
[pt_sensors.location_mapping]
channel_0 = "PRESSURANT_TANK"  # Pressurant Tank PT
channel_1 = "KERO_INLET"       # Kero Inlet PT
channel_2 = "KERO_OUTLET"      # Kero Outlet PT
channel_3 = "LOX_INLET"        # Lox Inlet PT
channel_4 = "LOX_OUTLET"       # Lox Outlet PT
channel_5 = "INJECTOR"         # Injector PT
channel_6 = "CHAMBER_WALL_1"   # Chamber Wall PT #1
channel_7 = "CHAMBER_WALL_2"   # Chamber Wall PT #2
channel_8 = "NOZZLE_EXIT"      # Nozzle Exit PT

[observation_matrix]
# Observation matrix configuration
enable_outlier_detection = true
outlier_threshold_sigma = 3.0
time_sync_tolerance_ms = 50.0
enable_interpolation = false
interpolation_window_ms = 100.0

[logging]
# Logging configuration
log_level = "INFO"
enable_console_output = true
enable_file_logging = false
log_file_path = "/var/log/esp32_pt_sensors.log"

[development]
# Development and debugging settings
enable_debug_output = $debug_mode
print_raw_data = $debug_mode
print_observation_matrices = $debug_mode
simulate_missing_sensors = false
simulate_sensor_delay = false
EOF

    print_success "Configuration file created: $CONFIG_PATH"
}

show_config_summary() {
    local device_path="$1"
    local baud_rate="$2"
    local binary_mode="$3"
    local debug_mode="$4"
    
    echo
    echo "Configuration Summary:"
    echo "====================="
    echo "Device Path: $device_path"
    echo "Baud Rate: $baud_rate"
    echo "Binary Mode: $binary_mode"
    echo "Debug Output: $debug_mode"
    echo "Config File: $CONFIG_PATH"
    echo
}

main() {
    print_header
    
    print_info "This script will help you configure ESP32 PT sensor communication."
    echo
    
    # Detect available serial devices
    detect_serial_devices
    
    # Get configuration from user
    local device_path=$(get_device_path)
    local baud_rate=$(get_baud_rate)
    local binary_mode=$(get_operation_mode)
    local debug_mode=$(get_debug_settings)
    
    echo
    show_config_summary "$device_path" "$baud_rate" "$binary_mode" "$debug_mode"
    
    # Confirm configuration
    read -p "Create configuration file with these settings? [Y/n]: " confirm
    if [[ $confirm =~ ^[Nn]$ ]]; then
        print_info "Configuration cancelled."
        exit 0
    fi
    
    # Create configuration file
    create_config_file "$device_path" "$baud_rate" "$binary_mode" "$debug_mode"
    
    echo
    print_success "ESP32 configuration setup complete!"
    echo
    echo "Next steps:"
    echo "1. Upload your Arduino code to the ESP32"
    echo "2. Connect the ESP32 to the specified device path"
    echo "3. Run the configurable PT example:"
    echo "   ./build/engine_controller"
    echo
    echo "To modify settings later, edit: $CONFIG_PATH"
    echo
}

# Run main function
main "$@"
