# DAQ Bridge Startup Scripts

Scripts for starting and managing the DAQ bridge system, inspired by FSW's startup scripts.

## Scripts

### `startup_daq_db.sh`
Starts the Elodin database for the DAQ bridge system.

**Usage:**
```bash
source scripts/startup_daq_db.sh <db_name> [port]
```

**Example:**
```bash
source scripts/startup_daq_db.sh daq_test
# Uses default port 2240

source scripts/startup_daq_db.sh daq_test 2241
# Uses custom port 2241
```

**Features:**
- Kills existing processes on the port
- Handles existing databases (prompts to delete or reuse)
- Creates database in `~/.local/share/elodin/<db_name>`
- Waits for database to be ready
- Sets `DB_PID` variable with database process ID

### `startup_daq_bridge.sh`
Starts both the Elodin database and DAQ bridge.

**Usage:**
```bash
source scripts/startup_daq_bridge.sh <db_name> [udp_port] [elodin_port]
```

**Example:**
```bash
source scripts/startup_daq_bridge.sh daq_test
# Uses defaults: UDP 8888, Elodin 2240

source scripts/startup_daq_bridge.sh daq_test 9999 2241
# Custom ports: UDP 9999, Elodin 2241
```

**Features:**
- Starts database using `startup_daq_db.sh`
- Starts DAQ bridge with proper configuration
- Checks for required executables and config files
- Provides helpful output with PIDs and connection info

### `stop_daq.sh`
Stops all DAQ bridge processes and frees ports.

**Usage:**
```bash
./scripts/stop_daq.sh
```

**Features:**
- Stops DAQ bridge
- Stops fake packet generator
- Stops Elodin database
- Frees UDP port 8888 and Elodin port 2240

## Quick Start

```bash
# Terminal 1: Start database and bridge
cd /path/to/Diablo-FSW
source scripts/startup_daq_bridge.sh daq_test

# Terminal 2: Send test packets
./build/daq_comms/fake_packet_generator 127.0.0.1 8888 10

# Terminal 3: Open editor
elodin editor ~/.local/share/elodin/daq_test

# When done: Stop everything
./scripts/stop_daq.sh
```

## Database Location

Databases are stored in `~/.local/share/elodin/<db_name>`, matching FSW's convention.

## Notes

- Scripts must be sourced (not executed) to set environment variables
- Database will prompt if existing database is found
- Ports default to 8888 (UDP) and 2240 (Elodin)
- Scripts check for required executables before starting
