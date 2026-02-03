# DiabloAvionics Ground Station GUI

A PyQt6-based GUI for managing the DiabloAvionics flight software system.

## Quick Launch

```bash
cd /home/kush-mahajan/sensor_system
./shell/launch_gui.sh
```

Or directly:
```bash
python3 gui/diablo_groundstation.py
```

## Features

### Quick Start Tab
- **START ALL** - Starts database, FSW, and packet generator in one click
- **STOP ALL** - Stops everything cleanly
- **Open Visualizer** - Launches Elodin visualizer
- Database path and port configuration

### Individual Control Tab
- Start/Stop Database independently
- Start/Stop FSW independently  
- Start/Stop Packet Generator with custom host/port
- Full control over each component

### Status Tab
- Real-time status of all components
- Active tmux session list
- Quick refresh button

## What It Does

The GUI manages tmux sessions behind the scenes:
- `diablo_system` - Main system session (quadrant layout)
- `diablo_fsw` - FSW-only session
- `diablo_packet_gen` - Packet generator session

All components run in separate tmux windows/panes, so you can:
- Attach to tmux to see live output: `tmux attach -t diablo_system`
- Detach without stopping: `Ctrl+B, then D`
- View logs in real-time

## Keyboard Shortcuts

- **Ctrl+C** in any tmux pane stops that component
- **Ctrl+B, D** detaches from tmux (keeps running)
- **tmux ls** shows all active sessions




