#!/usr/bin/env bash
set -euo pipefail

# Complete Sensor System Startup Script
# This script starts everything you need: database, sensors, and viewer

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Default configuration
DEFAULT_DB_NAME="sensor_db"
DEFAULT_CONFIG="config/config_base.toml"
DEFAULT_PORT=2240

# Print banner
print_banner() {
    echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║           🚀 SENSOR SYSTEM LAUNCHER 🚀           ║${NC}"
    echo -e "${CYAN}║                                                  ║${NC}"
    echo -e "${CYAN}║  Complete system startup with database,         ║${NC}"
    echo -e "${CYAN}║  sensors, and visualization                      ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
    echo
}

# Cross-platform IPv6 address handling
get_ipv6_bind_address() {
    local port="$1"
    printf '[::]:%s' "$port"
}

# Check and setup environment
check_environment() {
    # Check if we're in the right directory (should be shell/ directory)
    if [[ ! -f "../startup.sh" ]]; then
        echo -e "${RED}❌ Please run this script from the shell/ directory${NC}"
        echo -e "${YELLOW}💡 Usage: cd shell && ./start_complete_system.sh${NC}"
        exit 1
    fi

    # Auto-source startup.sh if ROOT_SENSOR_DIR isn't set
    if [[ -z "${ROOT_SENSOR_DIR:-}" ]]; then
        echo -e "${YELLOW}🔧 Setting up environment...${NC}"
        source ../startup.sh
        echo -e "${GREEN}✅ Environment setup complete${NC}"
        echo
    fi
}

# Kill existing processes
cleanup_existing() {
    echo -e "${YELLOW}🧹 Cleaning up existing processes...${NC}"

    # Kill existing tmux sessions
    for session in "complete_sensor_system" "sensor_system" "groundstation" "jetson_sensors"; do
        if tmux has-session -t "$session" 2>/dev/null; then
            echo -e "${YELLOW}  Killing existing tmux session: $session${NC}"
            tmux kill-session -t "$session"
        fi
    done

    # Kill any elodin-db processes
    if pgrep -f "elodin-db" > /dev/null; then
        echo -e "${YELLOW}  Killing existing database processes...${NC}"
        pkill -f "elodin-db" || true
    fi

    # Kill sensor generators
    if pgrep -f "fake_sensor_generator" > /dev/null; then
        echo -e "${YELLOW}  Killing existing sensor generators...${NC}"
        pkill -f "fake_sensor_generator" || true
    fi

    sleep 2
    echo -e "${GREEN}✅ Cleanup complete${NC}"
}

# Check for database conflicts
check_database_conflict() {
    local db_name="$1"
    local db_path="$HOME/.local/share/elodin/$db_name"
    local db_meta_path="${db_path}_metadata"

    if [[ -d "$db_path" ]]; then
        echo -e "${YELLOW}⚠️  Database '$db_name' already exists at:${NC}"
        echo -e "${BLUE}   $db_path${NC}"
        echo
        echo -e "${CYAN}What would you like to do?${NC}"
        echo -e "${GREEN}  1) Overwrite${NC} - Delete existing database and create new one"
        echo -e "${YELLOW}  2) Append${NC}   - Use existing database (read/append mode)"
        echo -e "${RED}  3) Quit${NC}     - Exit without making changes"
        echo

        while true; do
            read -p "Enter your choice [1/2/3]: " choice
            case $choice in
                1)
                    echo -e "${YELLOW}🗑️  Deleting existing database...${NC}"
                    rm -rf "$db_path" "$db_meta_path"
                    echo -e "${GREEN}✅ Database deleted. Will create new database.${NC}"
                    return 0
                    ;;
                2)
                    echo -e "${GREEN}✅ Using existing database in append mode.${NC}"
                    return 0
                    ;;
                3)
                    echo -e "${RED}❌ Exiting without changes.${NC}"
                    exit 0
                    ;;
                *)
                    echo -e "${RED}Invalid choice. Please enter 1, 2, or 3.${NC}"
                    ;;
            esac
        done
    fi
}

# Get user configuration
get_user_config() {
    echo -e "${CYAN}📋 System Configuration${NC}"
    echo

    # Database name
    read -p "Database name [$DEFAULT_DB_NAME]: " DB_NAME
    DB_NAME=${DB_NAME:-$DEFAULT_DB_NAME}

    # Check for conflicts
    check_database_conflict "$DB_NAME"

    # Config file
    echo
    read -p "Config file path [$DEFAULT_CONFIG]: " CONFIG_PATH
    CONFIG_PATH=${CONFIG_PATH:-$DEFAULT_CONFIG}

    if [[ ! -f "$CONFIG_PATH" ]]; then
        echo -e "${RED}❌ Config file not found: $CONFIG_PATH${NC}"
        exit 1
    fi

    # Mode selection
    echo
    echo -e "${CYAN}Select system mode:${NC}"
    echo -e "${GREEN}  1) Local${NC}     - Database and sensors on this machine"
    echo -e "${YELLOW}  2) Remote${NC}    - Connect to remote groundstation"
    echo

    while true; do
        read -p "Enter mode [1/2]: " mode_choice
        case $mode_choice in
            1)
                MODE="local"
                break
                ;;
            2)
                MODE="remote"
                echo
                read -p "Groundstation IP address: " GROUNDSTATION_IP
                if [[ -z "$GROUNDSTATION_IP" ]]; then
                    echo -e "${RED}❌ Groundstation IP is required for remote mode${NC}"
                    exit 1
                fi
                break
                ;;
            *)
                echo -e "${RED}Invalid choice. Please enter 1 or 2.${NC}"
                ;;
        esac
    done

    echo
    echo -e "${GREEN}📝 Configuration Summary:${NC}"
    echo -e "${BLUE}  Database: $DB_NAME${NC}"
    echo -e "${BLUE}  Config: $CONFIG_PATH${NC}"
    echo -e "${BLUE}  Mode: $MODE${NC}"
    if [[ "$MODE" == "remote" ]]; then
        echo -e "${BLUE}  Groundstation: $GROUNDSTATION_IP:$DEFAULT_PORT${NC}"
    fi
    echo

    read -p "Continue with this configuration? [Y/n]: " confirm
    if [[ "$confirm" =~ ^[Nn]$ ]]; then
        echo -e "${RED}❌ Aborted by user${NC}"
        exit 0
    fi
}

# Start the complete system
start_system() {
    local db_name="$1"
    local config_path="$2"
    local mode="$3"
    local groundstation_ip="${4:-}"

    local session_name="complete_sensor_system"
    local timestamp=$(date +%m_%d_%y__%H_%M_%S)
    local db_path="$HOME/.local/share/elodin/$db_name"
    local db_meta_path="${db_path}_metadata"
    local log_dir="${db_meta_path}/log"

    # Create log directory
    mkdir -p "$log_dir"

    # Log files
    local db_log="$log_dir/database_$timestamp.log"
    local sensor_log="$log_dir/sensors_$timestamp.log"
    local viewer_log="$log_dir/viewer_$timestamp.log"

    echo -e "${PURPLE}🚀 Starting Complete Sensor System...${NC}"
    echo -e "${BLUE}   Session: $session_name${NC}"
    echo -e "${BLUE}   Logs: $log_dir${NC}"
    echo

    # Timing constants like your original script
    SLEEP_TIME_SHORT=1
    SLEEP_TIME_SHELL_ENTER=2
    SLEEP_TIME_LONG=3

    # Start tmux session
    tmux new-session -d -s "$session_name" -c "$ROOT_SENSOR_DIR"

    if [[ "$mode" == "local" ]]; then
        # LOCAL MODE: Database + Local Sensors + Viewer

        # Start tmux session with just the DB (left big pane) - EXACTLY like your working script
        sleep $SLEEP_TIME_SHELL_ENTER
        tmux send-keys -t "$session_name" "cd shell && source startup_db.sh $db_name 2>&1 | tee $db_log" C-m
        tmux select-pane -t "$session_name":0 -T "DB"

        # Start a background watcher to wait for "Database is ready!" in log - EXACTLY like your working script
        (
            sleep $SLEEP_TIME_LONG
            while true; do
                if grep -q "Database is ready!" "$db_log" 2>/dev/null; then
                    break
                fi
                sleep 0.5
            done

            # Once DB is ready, create sensor pane - EXACTLY like your working script
            tmux split-window -h -t "$session_name":0 -c "$ROOT_SENSOR_DIR"
            sleep $SLEEP_TIME_SHELL_ENTER
            tmux send-keys -t "$session_name":0.1 "cd scripts && ./fake_sensor_generator 127.0.0.1 $DEFAULT_PORT 2>&1 | tee $sensor_log" C-m
            tmux select-pane -t "$session_name":0.1 -T "Sensors"
            sleep $SLEEP_TIME_SHORT

            # Create viewer pane - EXACTLY like your working script
            tmux split-window -v -t "$session_name":0.1 -c "$ROOT_SENSOR_DIR"
            sleep $SLEEP_TIME_SHELL_ENTER
            tmux send-keys -t "$session_name":0.2 "python3 scripts/view_sensor_data.py --host 127.0.0.1 --port $DEFAULT_PORT 2>&1 | tee $viewer_log" C-m
            tmux select-pane -t "$session_name":0.2 -T "Viewer"

            echo "✅ Sensor system started successfully!"
            echo "   - Database: $db_name"
            echo "   - Config: $config_path"
            echo "   - Logs: $log_dir"
            echo ""
            echo "To attach to the session: tmux attach -t $session_name"
            echo "To stop the system: tmux kill-session -t $session_name"
        ) &

    else
        # REMOTE MODE: Remote Sensors Only - EXACTLY like your working script
        sleep $SLEEP_TIME_SHELL_ENTER
        tmux send-keys -t "$session_name" "cd scripts && ./fake_sensor_generator_remote $groundstation_ip $DEFAULT_PORT 2>&1 | tee $sensor_log" C-m
        tmux select-pane -t "$session_name":0 -T "Remote Sensors"
    fi

    echo -e "${GREEN}✅ System startup initiated!${NC}"
    echo
    echo -e "${CYAN}📊 System Information:${NC}"
    echo -e "${BLUE}  Database: $db_name${NC}"
    echo -e "${BLUE}  Config: $config_path${NC}"
    echo -e "${BLUE}  Mode: $mode${NC}"
    if [[ "$mode" == "remote" ]]; then
        echo -e "${BLUE}  Groundstation: $groundstation_ip:$DEFAULT_PORT${NC}"
    else
        echo -e "${BLUE}  Local Address: 127.0.0.1:$DEFAULT_PORT${NC}"
    fi
    echo -e "${BLUE}  Logs: $log_dir${NC}"
    echo
    echo -e "${YELLOW}🎮 Tmux Controls:${NC}"
    echo -e "${BLUE}  Switch panes: Ctrl+B then arrow keys${NC}"
    echo -e "${BLUE}  Stop system: tmux kill-session -t $session_name${NC}"
    echo
    echo -e "${GREEN}🔗 Attaching to tmux session...${NC}"
    echo -e "${YELLOW}💡 Components will start automatically as database becomes ready${NC}"

    # Wait a bit for the background process to complete, then attach
    sleep 5

    # Immediately attach so you can interact with DB while the watcher runs
    tmux attach -t "$session_name"
}

# Main function
main() {
    print_banner
    check_environment
    cleanup_existing

    # Get configuration from user
    get_user_config

    # Start the system
    start_system "$DB_NAME" "$CONFIG_PATH" "$MODE" "${GROUNDSTATION_IP:-}"
}

# Run main function
main "$@"
