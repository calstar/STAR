#!/usr/bin/env bash

# DAQ Database Startup Script
# Starts Elodin database for DAQ bridge system
# Usage: source startup_daq_db.sh <db_name> [port]

# Check for source
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "Usage: source startup_daq_db.sh <db_name> [port]"
    exit 1
fi

# Check for an argument
if [ -z "$1" ]; then
    echo "Usage: source startup_daq_db.sh <db_name> [port]"
    return 1
fi

# Check for running on jetson (xavier or aleph)
is_jetson() {
    local arch
    arch=$(uname -m)

    if [[ "$arch" == "aarch64" ]]; then
        if [[ -f "/proc/device-tree/model" ]]; then
            if [[ $(cat /proc/device-tree/model | tr -d '\0') == *"Jetson"* || $(cat /proc/device-tree/model | tr -d '\0') == *"Aleph"* ]]; then
                return 0  # True (it's a Jetson)
            fi
        fi
    fi
    return 1  # False (not a Jetson)
}

# Set port from the optional second argument, default to 2240
PORT=${2:-2240}

# Find and kill any elodin-db process running on the target port
echo "Checking for existing elodin-db processes on port $PORT..."
PIDS=$(pgrep -f "elodin-db run.*:$PORT" || true)

if [ -n "$PIDS" ]; then
    echo "Found running elodin-db process(es) on port $PORT. Killing PIDs: $PIDS"
    kill -9 $PIDS
    sleep 1 # Give it a moment to die
    echo "Killed."
else
    echo "No existing elodin-db processes found on port $PORT."
fi

# Now, check if the port is free. If not, another process is using it.
if lsof -t -i:$PORT >/dev/null 2>&1; then
    echo "Port $PORT is still in use by a non-elodin-db process:"
    lsof -i:$PORT
    echo "Aborting. Please free up port $PORT."
    return 1
fi

if is_jetson; then
    sudo systemctl stop 'elodin-db@*'.service 2>/dev/null || true
    if systemctl is-active --quiet 'db@*.service' 2>/dev/null; then
        echo "Aborting. Please manually stop elodin-db@....service"
        return 1
    fi
fi

# Set the DB root path based on the user input
# If only a name is given, then use the default path + this name
# If a path to directory name is given, search for its existence,
#   if it exists, then resolve its path to absolute and use it instead
# Default path if only name is provided
DB_ROOT_PATH="$HOME/.local/share/elodin"
# DB vars
DB_NAME="$1"
DB_NAME="${DB_NAME%/}"

# More Name Checks (can't be . or .. or /)
if [[ "$DB_NAME" == "." || "$DB_NAME" == ".." || "$DB_NAME" == "/" ]]; then
    echo "Error: DB_NAME cannot be '.' or '..' or '/'"
    return 1
fi

# Determine whether DB_NAME is a plain name or a path
if [[ "$DB_NAME" == */* ]]; then
    # Contains slash, treat as path if it exists
    if [ -d "$DB_NAME" ]; then
        TMP_DB_PATH="$(realpath "$DB_NAME")"
    else
        echo "Error: Provided DB_NAME path '$DB_NAME' does not exist."
        return 1
    fi
else
    # Treat as name under default root path
    TMP_DB_PATH="$DB_ROOT_PATH/$DB_NAME"
fi

DB_HOST="[::]:$PORT"
METADATA_SUFFIX="_metadata"
# Where the metadata for the DB lives
TMP_DB_META_PATH="${TMP_DB_PATH}${METADATA_SUFFIX}"

# Search for whether DB_PATH already exists. If it does, prompt user; otherwise, continue
if [ -d "$TMP_DB_PATH" ]; then
    echo "Directory '$TMP_DB_PATH' already exists. Depending on your intention, this can cause issues."
    echo ""
    echo "User options:"
    echo "  Option 1: Delete DB - Enter 1 to delete the old existing DB and create a new DB instance of the same name."
    echo "  Option 2: Read DB   - Enter 2 if you wish to simply read from this existing database."
    echo "                        Reading is safe, but writing without clock synchronization between sessions can cause corruption."
    echo "  Option 3: Quit      - Enter 3 (or any other key) to exit the script."
    echo ""
    echo "If you wish to create a DB with the name '$DB_NAME' *and* keep the existing one,"
    echo "you must first manually move the existing DB elsewhere from:"
    echo "  $TMP_DB_PATH"
    echo ""

    read -p "Enter your choice [1/2/3]: " USER_CHOICE
    case "$USER_CHOICE" in
        1)
            echo "Deleting existing DB at '$TMP_DB_PATH'..."
            if is_jetson; then
                sudo systemctl stop 'elodin-db@*'.service 2>/dev/null || true
                rm -rf /db/$DB_NAME 2>/dev/null || true
            fi
            rm -rf "$TMP_DB_PATH"
            rm -rf "$TMP_DB_META_PATH"
            echo "Old DB deleted. Proceeding to create new DB at '$TMP_DB_PATH'"
            ;;
        2)
            echo "Proceeding in read-only mode. Be cautious about writing to this DB."
            ;;
        *)
            echo "Exiting script to avoid accidental modification. No changes made."
            return 1
            ;;
    esac
else
    echo "Directory '$TMP_DB_PATH' does not exist. Proceeding to create DB of name '$DB_NAME'"
fi

# Make DB_META_PATH if it does not exist (match FSW)
if [ ! -d "$TMP_DB_META_PATH" ]; then
    echo "Creating DB_META_PATH: $TMP_DB_META_PATH"
    mkdir -p "$TMP_DB_META_PATH"
else
    echo "DB_META_PATH already exists: $TMP_DB_META_PATH"
fi

# Ensure db directory exists and restart db service
# Match FSW: commented out mkdir -p "$TMP_DB_PATH" (let elodin-db create it)
#mkdir -p "$TMP_DB_PATH"

# Find elodin-db binary
ELODIN_DB_BIN=""
if [ -f "$HOME/.cargo/bin/elodin-db" ]; then
    ELODIN_DB_BIN="$HOME/.cargo/bin/elodin-db"
elif command -v elodin-db &> /dev/null; then
    ELODIN_DB_BIN="elodin-db"
else
    echo "Error: elodin-db not found. Please install Elodin."
    return 1
fi

# Start the database
if is_jetson; then
    ln -sf /db/$DB_NAME "$TMP_DB_PATH" 2>/dev/null || true
    sudo systemctl start elodin-db@$DB_NAME.service
    DB_PID=""
else
    # Match FSW exactly: don't create DB directory - let elodin-db create it
    # elodin-db will create the db_state file when it starts
    # Start database in background - output shows in terminal (like FSW)
    # CRITICAL: Use RUST_LOG=debug (not info) and don't redirect output (like FSW)

    # Resolve the sensor-system panel config (if it exists)
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
    CONFIG_LUA="$REPO_ROOT/panels/config.lua"
    CONFIG_FLAG=""
    if [ -f "$CONFIG_LUA" ]; then
        CONFIG_FLAG="--config $CONFIG_LUA"
        echo "Loading editor panel config: $CONFIG_LUA"
    fi

    RUST_LOG=debug $ELODIN_DB_BIN run "$DB_HOST" "$TMP_DB_PATH" $CONFIG_FLAG &
    # Get the PID of the last background process
    DB_PID=$!
    sleep 1  # Match FSW: sleep 1 (not 2)
    echo "Elodin database ($DB_NAME) started in the background with PID $DB_PID"
fi

# Helper functions to get DB paths (similar to FSW)
dbpath_func() {
    ps aux | grep "elodin-db run" | grep "\[::\]:$PORT" | grep -v grep | \
    awk '{for(i=1;i<=NF;i++) if ($i ~ /^\//) { print $i; exit }}'
}

dbmeta_func() {
    ps aux | grep "elodin-db run" | grep "\[::\]:$PORT" | grep -v grep | \
    awk '{for(i=1;i<=NF;i++) if ($i ~ /^\//) { print $i "_metadata"; exit }}'
}

# Wait for the database to be ready (match FSW exactly)
for i in {1..10}; do
    if is_jetson && systemctl is-active --quiet 'elodin-db@*'; then
        echo "Database is ready!"
        echo "   Database path: $TMP_DB_PATH"
        echo "   Port: $PORT"
        echo ""
        echo "To connect editor: elodin editor $TMP_DB_PATH"
        return 0
    elif lsof -i:$PORT &>/dev/null; then
        echo "Database is ready!"
        echo "   Database path: $TMP_DB_PATH"
        if [ -n "$DB_PID" ]; then
            echo "   Database PID: $DB_PID"
        fi
        echo "   Port: $PORT"
        echo ""
        echo "To connect editor: elodin editor $TMP_DB_PATH"
        return 0
    fi
    sleep 1  # Match FSW: sleep 1 second per iteration
done

echo "Error: Database failed to start on port $PORT"
return 1
