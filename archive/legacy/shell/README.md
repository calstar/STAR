# Diablo-FSW Sensor System - Shell Scripts

This directory contains all the management scripts for the Diablo-FSW sensor telemetry system.

## 🚀 **Main Scripts**

### **`quick_start.sh`** - Recommended Launch Script
**Usage:**
```bash
./quick_start.sh [database_name]
```

**Features:**
- 3-pane tmux layout (Database | Sensors | Visualizer)
- Automatic database startup and readiness detection
- GPS disabled (prevents BufferUnderflow errors)
- Cross-platform compatible (Linux/macOS)

**Tmux Layout:**
```
┌─────────────┬─────────────┐
│  Database   │   Sensors   │
│             ├─────────────┤
│             │ Visualizer  │
└─────────────┴─────────────┘
```

### **`shutdown_system.sh`** - Clean Shutdown
**Usage:**
```bash
./shutdown_system.sh
```

**Features:**
- Graceful SIGINT termination of all processes
- Multiple tmux session cleanup
- Port 2240 cleanup and validation
- Comprehensive process killing with proper signals

### **`start_complete_system.sh`** - Full-Featured Launcher
**Usage:**
```bash
./start_complete_system.sh
```

**Features:**
- Interactive configuration prompts
- Database conflict resolution (overwrite/append/quit)
- Local vs Remote mode selection
- Automatic environment setup

## 🔧 **Legacy Scripts**

### **`tmux_start_sensors.sh`** - Original Sensor Launcher
**Usage:**
```bash
./tmux_start_sensors.sh <config_path> <db_name>
```

### **`tmux_start_jetson_sensors.sh`** - Jetson Remote Sensors
**Usage:**
```bash
./tmux_start_jetson_sensors.sh <config_path> <groundstation_ip>
```

### **`startup_db.sh`** - Database Startup Helper
**Usage:**
```bash
source startup_db.sh <db_name>
```

## 📊 **Workflow Examples**

### **Development Workflow**
```bash
# 1. Start system
cd shell
./quick_start.sh dev_db

# 2. Work with system (Ctrl+B + arrows to switch panes)

# 3. Clean shutdown
./shutdown_system.sh
```

### **Production Workflow**
```bash
# 1. Generate production configs
cd config
python3 generate_configs.py --force

# 2. Start with production settings
cd shell
./start_complete_system.sh
# Select: production_db, config_prod.toml, local mode

# 3. Monitor and operate

# 4. Clean shutdown
./shutdown_system.sh
```

### **Remote Deployment Workflow**
```bash
# On Ground Station:
cd shell
./start_complete_system.sh
# Select: groundstation_db, config_groundstation.toml, local mode

# On Flight Computer:
cd shell
./start_complete_system.sh  
# Select: remote_sensors, config_jetson.toml, remote mode, <groundstation_ip>
```

## 🎮 **Tmux Controls**

- **Switch panes**: `Ctrl+B` then arrow keys
- **Attach to session**: `tmux attach -t sensor_system`
- **Detach from session**: `Ctrl+B` then `d`
- **Kill session**: `tmux kill-session -t sensor_system`

## 🔍 **Troubleshooting**

### **BufferUnderflow Errors**
- GPS is temporarily disabled in development
- Use `config_dev.toml` which has GPS disabled
- Check database logs for packet errors

### **Cross-Platform Issues**
- Use quoted IPv6 addresses on macOS: `'[::]:2240'`
- Scripts automatically handle platform differences

### **Permission Issues**
- All scripts should be executable: `chmod +x *.sh`
- Database directory permissions: `~/.local/share/elodin/`

## 📁 **File Organization**

```
shell/
├── quick_start.sh              # ← Main launcher (recommended)
├── shutdown_system.sh          # ← Clean shutdown
├── start_complete_system.sh    # ← Full-featured launcher
├── tmux_start_sensors.sh       # Legacy sensor launcher
├── tmux_start_jetson_sensors.sh # Jetson remote launcher
├── startup_db.sh               # Database startup helper
└── README.md                   # This file
```
