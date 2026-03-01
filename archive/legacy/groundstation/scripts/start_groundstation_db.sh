#!/usr/bin/env bash

# Groundstation Database Startup Script
# This script starts the Elodin database on the groundstation

# Check for source
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    # Script is being executed directly
    echo "Usage: source start_groundstation_db.sh <db_name>"
    exit 1
fi

# check for an argument
if [ -z "$1" ]; then
    echo "Usage: source start_groundstation_db.sh <db_name>"
    return 1
fi

# Initially set these
PORT=2240

# Find all PIDs using the port
PIDS=$(lsof -t -i:$PORT)

if [ -n "$PIDS" ]; then
    echo "Process(es) found using port $PORT:"
    for PID in $PIDS; do
        echo "-------------------------------------------"
        ps -p "$PID" -o user,pid,pcpu,pmem,vsz,rss,tty,stat,start,time,args
        echo "-------------------------------------------"
    done
    read -p "Do you want to kill these process(es)? [y/n]: " RESP
    if [[ "$RESP" =~ ^[Yy]$ ]]; then
        echo "Killing process(es)..."
        kill -9 $PIDS
    else
        echo "Aborting. No processes killed."
        return 1  # use exit 1 if not sourced
    fi
else
    echo "No process found using port $PORT."
fi

# Set the DB root path based on the user input
DB_ROOT_PATH="$HOME/.local/share/elodin"
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

DB_HOST="0.0.0.0:$PORT"  # Listen on all interfaces for remote connections
METADATA_SUFFIX="_metadata"
TMP_DB_META_PATH="${TMP_DB_PATH}${METADATA_SUFFIX}"

# Search for whether DB_PATH already exists. If it does, prompt user; otherwise, continue
if [ -d "$TMP_DB_PATH" ]; then
    echo "Directory '$TMP_DB_PATH' already exists. Depending on your intention, this can cause issues."
    echo ""
    echo "User options:"
    echo "  Option 1: Delete DB - Enter 1 to delete the old existing DB and create a new DB instance of the same name."
    echo "  Option 2: Read DB   - Enter 2 if you wish to simply read from this existing database."
    echo "  Option 3: Quit      - Enter 3 (or any other key) to exit the script."
    echo ""

    read -p "Enter your choice [1/2/3]: " USER_CHOICE
    case "$USER_CHOICE" in
        1)
            echo "Deleting existing DB at '$TMP_DB_PATH'..."
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

# Export the DB Path
export DB_PATH="$TMP_DB_PATH"
export DB_META_PATH="$TMP_DB_META_PATH"

# Make DB_META_PATH if it does not exist
if [ ! -d "$TMP_DB_META_PATH" ]; then
    echo "Creating DB_META_PATH: $TMP_DB_META_PATH"
    mkdir -p "$TMP_DB_META_PATH"
else
    echo "DB_META_PATH already exists: $TMP_DB_META_PATH"
fi

# Ensure directory exists
mkdir -p "$TMP_DB_PATH"

# Get local IP address for display
LOCAL_IP=$(hostname -I | awk '{print $1}')

echo "🌐 Starting Elodin database for groundstation..."
echo "   Database: $DB_NAME"
echo "   Path: $TMP_DB_PATH"
echo "   Host: $DB_HOST"
echo "   Local IP: $LOCAL_IP"
echo "   Remote sensors can connect to: $LOCAL_IP:$PORT"

# Resolve the sensor-system panel config (if it exists)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_LUA="$REPO_ROOT/panels/config.lua"
CONFIG_FLAG=""
if [ -f "$CONFIG_LUA" ]; then
    CONFIG_FLAG="--config $CONFIG_LUA"
    echo "Loading editor panel config: $CONFIG_LUA"
fi

# Start the database in the background
RUST_LOG=info elodin-db run "$DB_HOST" "$TMP_DB_PATH" $CONFIG_FLAG &
# Get the PID of the last background process
DB_PID=$!
sleep 1
echo "Elodin database ($DB_NAME) started in the background with PID $DB_PID"

# Wait for the database to be ready
for i in {1..10}; do
    if lsof -i:$PORT &>/dev/null; then
        echo "✅ Database is ready and listening on $LOCAL_IP:$PORT"
        echo "   Remote sensors can now connect to this database"
        return 0
    fi
    sleep 1
done

echo "❌ Error: Database failed to start on port $PORT"
return 1
