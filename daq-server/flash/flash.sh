#!/bin/bash
# Flash script for DAQ Sensor System
# Handles flashing of all executables and dependencies

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
BUILD_DIR="${BUILD_DIR:-build}"
TARGET_DIR="${TARGET_DIR:-/opt/sensor_system}"
FLASH_HOST="${FLASH_HOST:-}"
FLASH_USER="${FLASH_USER:-root}"
LOG_FILE="${LOG_FILE:-flash_deploy.log}"

# Executables to flash (updated with new dependencies)
EXECUTABLES=(
    "daq_bridge"                    # Main DAQ bridge with state machine
    "send_all_sensors_from_config"  # Test program for config-based sensors
    "send_all_message_types"        # Test program for all message types
    "test_fsw_simulator"            # FSW simulator
    "esp32_pt_streamer"             # ESP32 PT streamer
    "fake_esp32_packet_gen"         # Fake ESP32 packet generator
    "sitl_simulator"                # SITL simulator (if built)
    "test_robust_ddp"               # Robust DDP controller test (if built)
    "test_imu_calibration"          # IMU calibration test (if built)
)

# Libraries to flash (updated with new dependencies)
LIBRARIES=(
    "libdaq_comms_lib.so"    # DAQ communications (messages, parser, transport, UDP)
    "libfsw_daq_lib.so"      # FSW DAQ (config, routing, elodin, control/state machine, calibration)
)

# Config files to flash
CONFIG_FILES=(
    "config/config_flight_daq.toml"
    "config/config_ground_daq.toml"
    "config/config.toml"
)

# Scripts to flash
SCRIPTS=(
    "scripts/startup/startup_daq_db.sh"
    "scripts/startup/startup_daq_bridge.sh"
    "scripts/startup/start_full_system.sh"
)

print_usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -h, --host HOST          Target host (IP or hostname) for remote flashing"
    echo "  -u, --user USER          SSH user (default: root)"
    echo "  -b, --build-dir DIR      Build directory (default: build)"
    echo "  -t, --target-dir DIR     Target installation directory (default: /opt/sensor_system)"
    echo "  -e, --executable EXE     Flash only specific executable"
    echo "  -l, --library LIB        Flash only specific library"
    echo "  -c, --config             Flash only config files"
    echo "  -s, --scripts            Flash only scripts"
    echo "  -a, --all                Flash everything (default)"
    echo "  --help                   Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                                    # Flash everything to local system"
    echo "  $0 -h 192.168.2.100                  # Flash to remote host"
    echo "  $0 -e daq_bridge                      # Flash only daq_bridge"
    echo "  $0 -c                                 # Flash only config files"
}

check_build() {
    if [ ! -d "$BUILD_DIR" ]; then
        echo -e "${RED}ERROR: Build directory '$BUILD_DIR' not found${NC}"
        echo "Run 'cmake -B $BUILD_DIR -S . && cmake --build $BUILD_DIR' first"
        exit 1
    fi
}

flash_file() {
    local src="$1"
    local dst="$2"
    local desc="$3"

    if [ ! -f "$src" ]; then
        echo -e "${YELLOW}WARNING: Source file '$src' not found, skipping${NC}"
        return 1
    fi

    if [ -n "$FLASH_HOST" ]; then
        # Remote flash via SSH
        echo -e "${GREEN}Flashing $desc to $FLASH_HOST:$dst${NC}"
        ssh "$FLASH_USER@$FLASH_HOST" "mkdir -p $(dirname $dst)"
        scp "$src" "$FLASH_USER@$FLASH_HOST:$dst"
        ssh "$FLASH_USER@$FLASH_HOST" "chmod +x $dst" 2>/dev/null || true
    else
        # Local flash
        echo -e "${GREEN}Flashing $desc to $dst${NC}"
        mkdir -p "$(dirname "$dst")"
        cp "$src" "$dst"
        chmod +x "$dst" 2>/dev/null || true
    fi
}

flash_executables() {
    echo -e "${YELLOW}=== Flashing Executables ===${NC}"

    for exe in "${EXECUTABLES[@]}"; do
        local src="$BUILD_DIR/$exe"
        local dst="$TARGET_DIR/bin/$exe"

        # Check if executable exists in build directory
        if [ -f "$src" ]; then
            flash_file "$src" "$dst" "executable: $exe"
        else
            # Try FSW subdirectory
            src="$BUILD_DIR/FSW/$exe"
            if [ -f "$src" ]; then
                flash_file "$src" "$dst" "executable: $exe"
            else
                # Try daq_comms subdirectory
                src="$BUILD_DIR/daq_comms/$exe"
                if [ -f "$src" ]; then
                    flash_file "$src" "$dst" "executable: $exe"
                else
                    echo -e "${YELLOW}WARNING: Executable '$exe' not found in build directory${NC}"
                fi
            fi
        fi
    done
}

flash_libraries() {
    echo -e "${YELLOW}=== Flashing Libraries ===${NC}"

    for lib in "${LIBRARIES[@]}"; do
        local src="$BUILD_DIR/$lib"
        local dst="$TARGET_DIR/lib/$lib"

        # Check if library exists in build directory
        if [ -f "$src" ]; then
            flash_file "$src" "$dst" "library: $lib"
        else
            # Try FSW subdirectory
            src="$BUILD_DIR/FSW/$lib"
            if [ -f "$src" ]; then
                flash_file "$src" "$dst" "library: $lib"
            else
                # Try daq_comms subdirectory
                src="$BUILD_DIR/daq_comms/$lib"
                if [ -f "$src" ]; then
                    flash_file "$src" "$dst" "library: $lib"
                else
                    echo -e "${YELLOW}WARNING: Library '$lib' not found in build directory${NC}"
                fi
            fi
        fi
    done
}

flash_configs() {
    echo -e "${YELLOW}=== Flashing Config Files ===${NC}"

    for config in "${CONFIG_FILES[@]}"; do
        if [ -f "$config" ]; then
            local dst="$TARGET_DIR/etc/$(basename $config)"
            flash_file "$config" "$dst" "config: $(basename $config)"
        else
            echo -e "${YELLOW}WARNING: Config file '$config' not found${NC}"
        fi
    done
}

flash_scripts() {
    echo -e "${YELLOW}=== Flashing Scripts ===${NC}"

    for script in "${SCRIPTS[@]}"; do
        if [ -f "$script" ]; then
            local dst="$TARGET_DIR/scripts/$(basename $script)"
            flash_file "$script" "$dst" "script: $(basename $script)"
        else
            echo -e "${YELLOW}WARNING: Script '$script' not found${NC}"
        fi
    done
}

# Parse command line arguments
FLASH_EXECUTABLES=false
FLASH_LIBRARIES=false
FLASH_CONFIGS=false
FLASH_SCRIPTS=false
FLASH_ALL=true
SPECIFIC_EXE=""
SPECIFIC_LIB=""

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--host)
            FLASH_HOST="$2"
            shift 2
            ;;
        -u|--user)
            FLASH_USER="$2"
            shift 2
            ;;
        -b|--build-dir)
            BUILD_DIR="$2"
            shift 2
            ;;
        -t|--target-dir)
            TARGET_DIR="$2"
            shift 2
            ;;
        -e|--executable)
            SPECIFIC_EXE="$2"
            FLASH_ALL=false
            FLASH_EXECUTABLES=true
            shift 2
            ;;
        -l|--library)
            SPECIFIC_LIB="$2"
            FLASH_ALL=false
            FLASH_LIBRARIES=true
            shift 2
            ;;
        -c|--config)
            FLASH_ALL=false
            FLASH_CONFIGS=true
            shift
            ;;
        -s|--scripts)
            FLASH_ALL=false
            FLASH_SCRIPTS=true
            shift
            ;;
        -a|--all)
            FLASH_ALL=true
            shift
            ;;
        --help)
            print_usage
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            print_usage
            exit 1
            ;;
    esac
done

# Logging helpers
log_info() {
    echo -e "${BLUE}[INFO] $1${NC}"
}

log_warn() {
    echo -e "${YELLOW}[WARNING] $1${NC}"
}

# Main execution
check_build

if [ "$FLASH_ALL" = true ]; then
    FLASH_EXECUTABLES=true
    FLASH_LIBRARIES=true
    FLASH_CONFIGS=true
    FLASH_SCRIPTS=true
fi

if [ -n "$FLASH_HOST" ]; then
    echo -e "${GREEN}Flashing to remote host: $FLASH_USER@$FLASH_HOST${NC}"
    echo -e "${GREEN}Target directory: $TARGET_DIR${NC}"
else
    echo -e "${GREEN}Flashing to local system${NC}"
    echo -e "${GREEN}Target directory: $TARGET_DIR${NC}"
fi

if [ "$FLASH_EXECUTABLES" = true ]; then
    if [ -n "$SPECIFIC_EXE" ]; then
        # Flash only specific executable
        EXECUTABLES=("$SPECIFIC_EXE")
    fi
    flash_executables
fi

if [ "$FLASH_LIBRARIES" = true ]; then
    if [ -n "$SPECIFIC_LIB" ]; then
        # Flash only specific library
        LIBRARIES=("$SPECIFIC_LIB")
    fi
    flash_libraries
fi

if [ "$FLASH_CONFIGS" = true ]; then
    flash_configs
fi

if [ "$FLASH_SCRIPTS" = true ]; then
    flash_scripts
fi

echo -e "${GREEN}=== Flash Complete ===${NC}"

# Update library cache if on local system
if [ -z "$FLASH_HOST" ] && command -v ldconfig &> /dev/null; then
    echo -e "${YELLOW}Updating library cache...${NC}"
    ldconfig "$TARGET_DIR/lib" 2>/dev/null || true
fi
