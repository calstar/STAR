#!/bin/bash

# Liquid Engine Flight Software Startup Script
# This script starts the engine controller with proper configuration and monitoring

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="${CONFIG_FILE:-/etc/engine_controller/config_engine.toml}"
LOG_LEVEL="${LOG_LEVEL:-info}"
SERVICE_NAME="engine_controller"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
check_root() {
    if [[ $EUID -eq 0 ]]; then
        log_warning "Running as root. Consider running as dedicated user."
    fi
}

# Check system requirements
check_system_requirements() {
    log_info "Checking system requirements..."
    
    # Check if running on supported platform
    if [[ ! -f /etc/os-release ]]; then
        log_error "Cannot determine OS version"
        exit 1
    fi
    
    # Check for required tools
    local required_tools=("systemctl" "journalctl" "ps" "netstat")
    for tool in "${required_tools[@]}"; do
        if ! command -v "$tool" &> /dev/null; then
            log_error "Required tool '$tool' not found"
            exit 1
        fi
    done
    
    log_success "System requirements check passed"
}

# Check configuration file
check_config() {
    log_info "Checking configuration file..."
    
    if [[ ! -f "$CONFIG_FILE" ]]; then
        log_warning "Configuration file not found at $CONFIG_FILE"
        log_info "Using default configuration from project directory"
        CONFIG_FILE="$PROJECT_ROOT/config/config_engine.toml"
        
        if [[ ! -f "$CONFIG_FILE" ]]; then
            log_error "No configuration file found"
            exit 1
        fi
    fi
    
    log_success "Configuration file found: $CONFIG_FILE"
}

# Check if service is already running
check_service_status() {
    log_info "Checking service status..."
    
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        log_warning "Service '$SERVICE_NAME' is already running"
        read -p "Do you want to restart it? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            log_info "Stopping existing service..."
            systemctl stop "$SERVICE_NAME"
            sleep 2
        else
            log_info "Exiting without changes"
            exit 0
        fi
    fi
}

# Create necessary directories
create_directories() {
    log_info "Creating necessary directories..."
    
    local directories=(
        "/var/lib/engine_controller"
        "/var/lib/engine_controller/calibrations"
        "/var/log/engine_controller"
        "/tmp/engine_controller"
    )
    
    for dir in "${directories[@]}"; do
        if [[ ! -d "$dir" ]]; then
            sudo mkdir -p "$dir"
            sudo chown engine_controller:engine_controller "$dir" 2>/dev/null || true
            log_success "Created directory: $dir"
        fi
    done
}

# Set up hardware interfaces
setup_hardware() {
    log_info "Setting up hardware interfaces..."
    
    # Check CAN interface
    if [[ -d /sys/class/net/can0 ]]; then
        if ! ip link show can0 | grep -q "UP"; then
            log_info "Bringing up CAN interface..."
            sudo ip link set can0 up type can bitrate 1000000
        fi
        log_success "CAN interface ready"
    else
        log_warning "CAN interface not found"
    fi
    
    # Check serial interfaces
    local serial_devices=("/dev/ttyUSB0" "/dev/ttyUSB1" "/dev/ttyACM0")
    for device in "${serial_devices[@]}"; do
        if [[ -e "$device" ]]; then
            log_info "Found serial device: $device"
            sudo chmod 666 "$device" 2>/dev/null || true
        fi
    done
    
    # Check GPIO access
    if [[ -d /sys/class/gpio ]]; then
        log_success "GPIO interface available"
    else
        log_warning "GPIO interface not available"
    fi
}

# Start the service
start_service() {
    log_info "Starting engine controller service..."
    
    # Set environment variables
    export CONFIG_FILE
    export LOG_LEVEL
    
    # Start the service
    if systemctl start "$SERVICE_NAME"; then
        log_success "Service started successfully"
    else
        log_error "Failed to start service"
        systemctl status "$SERVICE_NAME" --no-pager
        exit 1
    fi
}

# Monitor the service
monitor_service() {
    log_info "Monitoring service status..."
    
    # Wait for service to start
    sleep 3
    
    # Check if service is running
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        log_success "Service is running"
    else
        log_error "Service failed to start"
        systemctl status "$SERVICE_NAME" --no-pager
        exit 1
    fi
    
    # Show service logs
    log_info "Recent service logs:"
    journalctl -u "$SERVICE_NAME" --no-pager -n 20
    
    # Show network connections
    log_info "Network connections:"
    netstat -tuln | grep -E ":(2240|2241|2242|2243)" || log_warning "No expected network connections found"
}

# Main execution
main() {
    log_info "Starting Liquid Engine Flight Software Controller"
    log_info "=================================================="
    
    check_root
    check_system_requirements
    check_config
    check_service_status
    create_directories
    setup_hardware
    start_service
    monitor_service
    
    log_success "Engine controller startup complete!"
    log_info "Use 'journalctl -u $SERVICE_NAME -f' to follow logs"
    log_info "Use 'systemctl status $SERVICE_NAME' to check status"
    log_info "Use 'systemctl stop $SERVICE_NAME' to stop the service"
}

# Handle script interruption
cleanup() {
    log_info "Cleaning up..."
    # Add any cleanup tasks here
}

trap cleanup EXIT INT TERM

# Run main function
main "$@"
