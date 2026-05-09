#!/usr/bin/env python3
"""
Combined Sensor & Actuator Control GUI
Opens one full-screen window with:
- Left (66%): Sensor/PT data receiver and real-time plotting
- Right (33%): Actuator control and voltage monitoring

Requirements: pip install pyqt6 pyqtgraph numpy
"""

import csv
import json
import os
import re
import socket
import struct
import sys
import time
from pathlib import Path
from typing import Optional, Tuple, List, Dict
from collections import deque

# PT calibration CSV (relative to this file); used to show psi for PT connectors present in CSV
PT_CALIBRATION_CSV = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),  # Go up to project root
    "PT_Board", "Calibration", "PT Calibration Attempt 2026-02-04_test2.csv"
)

# Fix Qt "cocoa" platform plugin on macOS when Homebrew Qt plugins path lacks platforms/
if sys.platform == 'darwin':
    _qt_plugins = os.environ.get('QT_QPA_PLATFORM_PLUGIN_PATH')
    if not _qt_plugins or not os.path.isdir(_qt_plugins):
        _candidates = [
            '/opt/homebrew/share/qt/plugins/platforms',
            '/opt/homebrew/Cellar/qtbase/6.10.1/share/qt/plugins/platforms',
        ]
        if os.path.isdir('/opt/homebrew/Cellar/qtbase'):
            for _name in sorted(os.listdir('/opt/homebrew/Cellar/qtbase'), reverse=True):
                _p = os.path.join('/opt/homebrew/Cellar/qtbase', _name, 'share', 'qt', 'plugins', 'platforms')
                if os.path.isdir(_p):
                    _candidates.insert(1, _p)
                    break
        for _p in _candidates:
            if os.path.isdir(_p) and any(_f.startswith('libqcocoa') for _f in os.listdir(_p)):
                os.environ['QT_QPA_PLATFORM_PLUGIN_PATH'] = _p
                break

from PyQt6 import QtCore, QtGui, QtWidgets
import pyqtgraph as pg
# Performance optimization: Use OpenGL and disable anti-aliasing
pg.setConfigOptions(useOpenGL=True, antialias=False)
import numpy as np

# Protocol constants from DAQv2-Comms.h
DIABLO_COMMS_VERSION = 0
MAX_PACKET_SIZE = 512

# PacketType enum from DiabloEnums.h
class PacketType:
    BOARD_HEARTBEAT = 1
    SERVER_HEARTBEAT = 2
    SENSOR_DATA = 3
    ACTUATOR_COMMAND = 4
    SENSOR_CONFIG = 5
    ACTUATOR_CONFIG = 6
    ABORT = 7
    ABORT_DONE = 8
    CLEAR_ABORT = 9
    PWM_ACTUATOR_COMMAND = 10

# Default configuration
DEFAULT_SENSOR_IP = '192.168.2.101'  # Sensor board IP address
DEFAULT_ACTUATOR_IP = '192.168.2.201'  # Actuator board IP address
DEFAULT_DEVICE_PORT = 5005  # Port device listens on for actuator commands
DEFAULT_RECEIVE_PORT = 5006  # Port device sends sensor data to

# Struct format strings (little-endian, matching C++ packed structs)
PACKET_HEADER_FORMAT = '<BBI'  # 6 bytes total
PACKET_HEADER_SIZE = 6

ACTUATOR_COMMAND_PACKET_FORMAT = '<B'  # 1 byte
ACTUATOR_COMMAND_PACKET_SIZE = 1

ACTUATOR_COMMAND_FORMAT = '<BB'  # 2 bytes
ACTUATOR_COMMAND_SIZE = 2

PWM_ACTUATOR_COMMAND_PACKET_FORMAT = '<B'
PWM_ACTUATOR_COMMAND_PACKET_SIZE = 1
# PWM Command: actuator_id (u8), duration_ms (u32), duty_cycle (float), frequency (float)
PWM_ACTUATOR_COMMAND_FORMAT = '<BIff'
PWM_ACTUATOR_COMMAND_SIZE = 13

SENSOR_DATA_PACKET_FORMAT = '<BB'  # 2 bytes
SENSOR_DATA_PACKET_SIZE = 2

SENSOR_DATA_CHUNK_FORMAT = '<I'  # 4 bytes
SENSOR_DATA_CHUNK_SIZE = 4

SENSOR_DATAPOINT_FORMAT = '<BI'  # 5 bytes: uint8_t sensor_id + uint32_t data
SENSOR_DATAPOINT_SIZE = 5

# Plotting constants
DEFAULT_WINDOW_SECONDS = 10.0
MAX_POINTS = 200000
UPDATE_INTERVAL_MS = 100  # Update plots every 100ms
NUM_CONNECTORS = 10  # Number of connectors being cycled (1-10)
NUM_ACTUATORS = 10
# Default role names (used only when config is missing); actual names come from config
DEFAULT_ACTUATOR_ROLE_NAMES = ["LOX Main", "Fuel Main", "Fuel Vent", "Fuel Press", "LOX Vent", "LOX Press"]
DEFAULT_SENSOR_ROLE_NAMES = ["LOX Upstream", "LOX Downstream", "Low Press PT", "Fuel Downstream"]
DEFAULT_ACTUATOR_ABBREV_TO_ROLE = {
    "FV": "Fuel Vent",
    "OV": "LOX Vent",
    "FP": "Fuel Press",
    "OP": "LOX Press",
    "FM": "Fuel Main",
    "OM": "LOX Main",
}
# When "only show actuators with roles" is true: display order in grid (row1 vents, row2 press, row3 mains; col1 fuel, col2 lox)
ACTUATOR_DISPLAY_ORDER_WHEN_ROLES = ["Fuel Vent", "LOX Vent", "Fuel Press", "LOX Press", "Fuel Main", "LOX Main", "Fuel Fill"]
ACTUATOR_LABELS_FILE = Path(__file__).parent / "actuator_labels.json"
SENSOR_LABELS_FILE = Path(__file__).parent / "sensor_labels.json"

# Colors for sensors (cycle through if more than this)
SENSOR_COLORS = [
    (255, 80, 80),    # Red
    (80, 255, 80),    # Green
    (80, 150, 255),   # Blue
    (255, 200, 80),   # Orange
    (200, 80, 255),   # Purple
    (80, 255, 255),   # Cyan
    (255, 150, 150),  # Light Red
    (150, 255, 150),  # Light Green
    (150, 200, 255),  # Light Blue
    (255, 255, 80),   # Yellow
]



CONFIG_FILE = Path(__file__).parent / "config.json"
_DEFAULT_STATE_MACHINE_CSV = Path(__file__).parent / "state_machine_actuators.csv"
_DEFAULT_STATE_TRANSITIONS_CSV = Path(__file__).parent / "state_transitions.csv"

class ConfigManager:
    """Manages loading and saving of application configuration.
    Actuator/PT names and mapping are stored in config (actuator_role_names, actuator_roles,
    sensor_roles, actuator_abbrev_to_role). Sensor role names and labels come from sensor_roles keys.
    All settings read from and save to config.
    """
    def __init__(self):
        self.config = {
            "actuator_role_names": list(DEFAULT_ACTUATOR_ROLE_NAMES),
            "actuator_roles": {name: 0 for name in DEFAULT_ACTUATOR_ROLE_NAMES},
            "sensor_roles": {name: 0 for name in DEFAULT_SENSOR_ROLE_NAMES},
            "actuator_abbrev_to_role": dict(DEFAULT_ACTUATOR_ABBREV_TO_ROLE),
            "network": {
                "actuator_ip": DEFAULT_ACTUATOR_IP,
                "actuator_port": DEFAULT_DEVICE_PORT,
                "sensor_ip_filter": DEFAULT_SENSOR_IP,
                "receive_port": DEFAULT_RECEIVE_PORT
            },
            "display": {
                "adc_bits": 32,
                "ref_voltage": 2.5,
                "window_seconds": DEFAULT_WINDOW_SECONDS,
                "y_axis_min": 0.0,
                "y_axis_max": 700.0,
                "y_axis_autoscale": True,
                "only_show_actuators_with_roles": False,
                "only_show_pt_with_roles": False,
                "graph_ma_samples": 1,
                "display_ma_samples": 1,
            },
            "mappings": {
                "GN2": 0,
                "ETH": 0,
                "LOX": 0
            },
            "pressure_limits": {
                "GN2": {"THRESH": 550, "NOP": 900, "MEOP": 950, "POP": 1000},
                "ETH": {"THRESH": 550, "NOP": 600, "MEOP": 650, "POP": 750},
                "LOX": {"THRESH": 550, "NOP": 600, "MEOP": 650, "POP": 750},
            },
            "num_connectors": 10,
            "num_actuators": 10,
            "paths": {
                "pt_calibration_csv": [],  # List of CSV paths (empty = use default)
                "state_machine_csv": "",
                "state_transitions_csv": "",
            },
            "simulate_chamber_pressure": False
        }
        self.load()

    def load(self):
        if CONFIG_FILE.exists():
            try:
                with open(CONFIG_FILE, 'r') as f:
                    loaded = json.load(f)
                    self._update_dict(self.config, loaded)
                    # sensor_roles: use only what's in the file (no merge with defaults)
                    if "sensor_roles" in loaded and isinstance(loaded["sensor_roles"], dict):
                        self.config["sensor_roles"] = dict(loaded["sensor_roles"])
                self._backfill_role_names()
            except Exception as e:
                print(f"Error loading config: {e}")
        else:
            self.save()

    def _backfill_role_names(self):
        """Ensure actuator_role_names/actuator_roles exist; sensor_roles is single source for sensor names and mappings."""
        roles = self.config.setdefault("actuator_roles", {})
        names = self.config.get("actuator_role_names")
        if not names:
            names = list(roles.keys()) if roles else list(DEFAULT_ACTUATOR_ROLE_NAMES)
            self.config["actuator_role_names"] = names
        # Ensure any role in actuator_roles is also in actuator_role_names
        for name in roles:
            if name not in names:
                names.append(name)
        for name in names:
            if name not in roles:
                roles[name] = 0
        # Sensor roles: merge legacy sensor_role_names into sensor_roles, then remove sensor_role_names
        roles = self.config.setdefault("sensor_roles", {})
        legacy_names = self.config.pop("sensor_role_names", None)
        if legacy_names:
            # Preserve order: first legacy names, then any existing keys not in legacy
            ordered = []
            for name in legacy_names:
                if name not in roles:
                    roles[name] = 0
                ordered.append(name)
            for k in roles:
                if k not in ordered:
                    ordered.append(k)
            self.config["sensor_roles"] = {k: roles[k] for k in ordered}
        # Do not add default sensor role names; GUI shows only what is in config sensor_roles
        if "actuator_abbrev_to_role" not in self.config:
            self.config["actuator_abbrev_to_role"] = dict(DEFAULT_ACTUATOR_ABBREV_TO_ROLE)
        if "num_connectors" not in self.config:
            self.config["num_connectors"] = 10
        if "num_actuators" not in self.config:
            self.config["num_actuators"] = 10
        if "paths" not in self.config:
            self.config["paths"] = {"pt_calibration_csv": [], "state_machine_csv": "", "state_transitions_csv": ""}
        # Migrate old string format to list format for pt_calibration_csv
        if isinstance(self.config.get("paths", {}).get("pt_calibration_csv"), str):
            old_val = self.config["paths"]["pt_calibration_csv"]
            self.config["paths"]["pt_calibration_csv"] = [old_val] if old_val.strip() else []

    def save(self):
        try:
            with open(CONFIG_FILE, 'w') as f:
                json.dump(self.config, f, indent=4)
            print(f"Saved config to {CONFIG_FILE}")
        except Exception as e:
            print(f"Error saving config: {e}")

    def _update_dict(self, target, source):
        for k, v in source.items():
            if isinstance(v, dict) and k in target and isinstance(target[k], dict):
                self._update_dict(target[k], v)
            else:
                target[k] = v

    def get_actuator_role_names(self):
        """Ordered list of actuator role names (from config)."""
        return self.config.get("actuator_role_names") or list(self.config.get("actuator_roles", {}).keys()) or list(DEFAULT_ACTUATOR_ROLE_NAMES)

    def get_sensor_role_names(self):
        """Ordered list of PT/sensor role names (keys of sensor_roles in config). Only what's in config, no hardcoded defaults."""
        return list(self.config.get("sensor_roles", {}).keys())

    def get_actuator_abbrev_to_role(self):
        """Map state-machine abbreviation -> actuator role name (from config)."""
        return self.config.get("actuator_abbrev_to_role") or dict(DEFAULT_ACTUATOR_ABBREV_TO_ROLE)

    def get_num_connectors(self):
        return int(self.config.get("num_connectors", 10))

    def get_num_actuators(self):
        return int(self.config.get("num_actuators", 10))

    def get_pt_calibration_csv_paths(self):
        """Get list of PT calibration CSV paths from config.
        Returns list of paths (empty list means use default).
        Supports both old format (single string) and new format (list)."""
        p = (self.config.get("paths") or {}).get("pt_calibration_csv", "")
        if isinstance(p, list):
            return [path.strip() for path in p if path and path.strip()]
        elif isinstance(p, str):
            return [p.strip()] if p.strip() else []
        else:
            return []

    def get_state_machine_csv_path(self):
        p = (self.config.get("paths") or {}).get("state_machine_csv", "").strip()
        return Path(p) if p else _DEFAULT_STATE_MACHINE_CSV

    def get_state_transitions_csv_path(self):
        p = (self.config.get("paths") or {}).get("state_transitions_csv", "").strip()
        return Path(p) if p else _DEFAULT_STATE_TRANSITIONS_CSV

    # Helpers: config stores role → id; these derive label for a slot/connector for display
    def get_actuator_label(self, idx):
        roles = self.config.get("actuator_roles", {})
        for role, aid in roles.items():
            # Handle both old format (int) and new format ([NC/NO, id])
            actuator_id = aid[1] if isinstance(aid, list) and len(aid) == 2 else aid
            if actuator_id == idx:
                return role
        return ""

    def set_actuator_role(self, role_name, actuator_id):
        if role_name not in self.get_actuator_role_names():
            return
        role_names = self.get_actuator_role_names()
        roles = self.config.setdefault("actuator_roles", {name: 0 for name in role_names})
        # Clear any existing assignment of this actuator_id to other roles
        for r, aid in list(roles.items()):
            # Handle both old format (int) and new format ([NC/NO, id])
            existing_id = aid[1] if isinstance(aid, list) and len(aid) == 2 else aid
            if existing_id == actuator_id and r != role_name:
                roles[r] = 0
        # Preserve NC/NO type if it exists, otherwise default to NC
        existing_value = roles.get(role_name, 0)
        if isinstance(existing_value, list) and len(existing_value) == 2:
            # Preserve the NC/NO type, update the ID
            roles[role_name] = [existing_value[0], int(actuator_id) if actuator_id else 0]
        else:
            # New assignment or old format - default to NC
            if actuator_id:
                roles[role_name] = ['NC', int(actuator_id)]
            else:
                roles[role_name] = 0
        self.save()

    def get_sensor_label(self, idx):
        roles = self.config.get("sensor_roles", {})
        for role, cid in roles.items():
            if cid == idx:
                return role
        return ""

    def set_sensor_role(self, role_name, connector_id):
        roles = self.config.setdefault("sensor_roles", {})
        if role_name not in roles:
            roles[role_name] = 0  # allow new role from settings (e.g. after migration)
        for r, cid in list(roles.items()):
            if cid == connector_id and r != role_name:
                roles[r] = 0
        roles[role_name] = int(connector_id) if connector_id else 0
        self.save()

    def get_actuator_role(self, role_name):
        """Get actuator ID for a role. Returns 0 if not found or unassigned."""
        aid = self.config.get("actuator_roles", {}).get(role_name, 0)
        # Handle both old format (int) and new format ([NC/NO, id])
        if isinstance(aid, list) and len(aid) == 2:
            return aid[1]  # Return the ID (second element)
        return aid
    
    def get_actuator_type(self, role_name):
        """Get NC/NO type for an actuator role. Returns 'NC' if not found or unassigned."""
        aid = self.config.get("actuator_roles", {}).get(role_name, 0)
        # Handle both old format (int) and new format ([NC/NO, id])
        if isinstance(aid, list) and len(aid) == 2:
            return aid[0]  # Return NC or NO (first element)
        return 'NC'  # Default to NC for backward compatibility
    
    def get_actuator_type_by_id(self, actuator_id):
        """Get NC/NO type for an actuator by its ID. Returns 'NC' if not found."""
        roles = self.config.get("actuator_roles", {})
        for role, aid in roles.items():
            # Handle both old format (int) and new format ([NC/NO, id])
            if isinstance(aid, list) and len(aid) == 2:
                if aid[1] == actuator_id:
                    return aid[0]  # Return NC or NO
            elif aid == actuator_id:
                return 'NC'  # Default to NC for old format
        return 'NC'  # Default to NC if not found

    def get_sensor_role(self, role_name):
        return self.config.get("sensor_roles", {}).get(role_name, 0)

CONFIG = ConfigManager()
# Apply config-driven counts so rest of code can use NUM_CONNECTORS / NUM_ACTUATORS
NUM_CONNECTORS = CONFIG.get_num_connectors()
NUM_ACTUATORS = CONFIG.get_num_actuators()

pg.setConfigOptions(antialias=False)


# ---------------------- State Machine CSV Loading ----------------------
def load_state_machine_csv(csv_path: Path) -> Dict[str, Dict[str, str]]:
    """
    Load state machine CSV file.
    Returns dict: state_name -> {actuator_abbrev -> OPEN/CLOSE}
    CSV format: first row is header with state names (first column empty), first column of data rows is actuator abbreviations
    """
    state_machine = {}
    if not csv_path.exists():
        print(f"Warning: State machine CSV not found at {csv_path}")
        return state_machine
    
    try:
        with open(csv_path, 'r', newline='', encoding='utf-8') as f:
            reader = csv.reader(f)
            rows = list(reader)
            
            if len(rows) < 2:
                print(f"Warning: State machine CSV has insufficient rows")
                return state_machine
            
            # First row is header: empty first cell, then state names
            header = rows[0]
            states = [col.strip() for col in header[1:] if col.strip()]  # Skip first empty column
            
            # Remaining rows: first column is actuator abbrev, rest are state values
            for row in rows[1:]:
                if len(row) < 2:
                    continue
                actuator_abbrev = row[0].strip()
                if not actuator_abbrev:
                    continue
                
                # For each state, store the OPEN/CLOSE value
                for i, state in enumerate(states):
                    if i + 1 < len(row):
                        value = row[i + 1].strip().upper()
                        # Skip Debug state column if present
                        if state.strip().lower() == "debug":
                            continue
                        if state not in state_machine:
                            state_machine[state] = {}
                        # Skip "NO CHANGE" values
                        if value in ['OPEN', 'CLOSE', 'CLOSED']:
                            state_machine[state][actuator_abbrev] = 'OPEN' if value == 'OPEN' else 'CLOSE'
                        # For "NO CHANGE", we don't store anything
    except Exception as e:
        print(f"Error loading state machine CSV: {e}")
        import traceback
        traceback.print_exc()
    
    return state_machine


def load_state_transitions_csv(csv_path: Path) -> Dict[str, Dict[str, bool]]:
    """
    Load state transitions CSV file.
    Returns dict: current_state -> {next_state -> allowed (True/False)}
    CSV format: first row is header with next states, first column is current states
    """
    transitions = {}
    if not csv_path.exists():
        print(f"Warning: State transitions CSV not found at {csv_path}")
        return transitions
    
    try:
        with open(csv_path, 'r', newline='', encoding='utf-8') as f:
            reader = csv.reader(f)
            rows = list(reader)
            
            if len(rows) < 2:
                print(f"Warning: State transitions CSV has insufficient rows")
                return transitions
            
            # First row is header: empty first cell, then next state names
            header = rows[0]
            next_states = [col.strip() for col in header[1:] if col.strip()]  # Skip first empty column
            
            # Remaining rows: first column is current state, rest are transition values (1/0)
            for row in rows[1:]:
                if len(row) < 2:
                    continue
                current_state = row[0].strip()
                if not current_state:
                    continue
                
                transitions[current_state] = {}
                # For each next state, store whether transition is allowed
                for i, next_state in enumerate(next_states):
                    if i + 1 < len(row):
                        value = row[i + 1].strip()
                        # 1 = allowed, 0 = not allowed
                        transitions[current_state][next_state] = (value == '1')
    except Exception as e:
        print(f"Error loading state transitions CSV: {e}")
        import traceback
        traceback.print_exc()
    
    return transitions


def get_actuator_id_from_role(role_name: str) -> int:
    """Get actuator ID from role name. Returns 0 if not found."""
    return CONFIG.get_actuator_role(role_name)


def apply_state_from_csv(actuator_widget, state_name: str, state_machine: Dict[str, Dict[str, str]]):
    """
    Apply actuator states from CSV for the given state name.
    
    Mapping:
    - FV = Fuel Vent
    - OV = LOX Vent  
    - FP = Fuel Press
    - OP = LOX Press
    - FM = Fuel Main
    - OM = LOX Main
    """
    if state_name not in state_machine:
        print(f"Warning: State '{state_name}' not found in CSV")
        return
    
    # Map CSV abbreviations to role names
    abbrev_to_role = CONFIG.get_actuator_abbrev_to_role()
    state_config = state_machine[state_name]

    # Build desired GUI state for all actuators (1..NUM_ACTUATORS).
    # Default anything not specified by the CSV mapping to CLOSED (0) so the right-side
    # actuator display always reflects the full state when a mode is pressed.
    desired_by_actuator_id: Dict[int, int] = {aid: 0 for aid in range(1, NUM_ACTUATORS + 1)}

    # Fill desired states from CSV for the mapped actuators
    for abbrev, action in state_config.items():
        if abbrev not in abbrev_to_role:
            print(f"Warning: Unknown actuator abbreviation '{abbrev}' in CSV")
            continue
        
        role_name = abbrev_to_role[abbrev]
        actuator_id = get_actuator_id_from_role(role_name)
        
        if actuator_id == 0:
            print(f"Warning: Actuator role '{role_name}' ({abbrev}) not assigned to any actuator")
            continue
        
        # Convert OPEN/CLOSE to GUI state (1 = OPEN, 0 = CLOSED)
        gui_state = 1 if action == 'OPEN' else 0
        # Only write if actuator_id is in our expected range
        if 1 <= actuator_id <= NUM_ACTUATORS:
            desired_by_actuator_id[actuator_id] = gui_state

    # Apply to widget: update UI + send commands for any actuators that change.
    # Use force=True to bypass manual control lock
    for actuator_id in range(1, NUM_ACTUATORS + 1):
        desired = desired_by_actuator_id.get(actuator_id, 0)
        array_idx = actuator_id - 1
        current = actuator_widget.actuator_states[array_idx] if 0 <= array_idx < len(actuator_widget.actuator_states) else None
        if current is None or current != desired:
            actuator_widget.set_actuator_state(actuator_id, desired, force=True)


# ---------------------- PT pressure from calibration ----------------------
def calculate_pressure(adc_code: float, PT_A: float, PT_B: float, PT_C: float, PT_D: float) -> float:
    """Compute pressure (psi) from ADC code using cubic polynomial."""
    return (PT_A * (adc_code ** 3)) + (PT_B * (adc_code ** 2)) + (PT_C * adc_code) + PT_D


def load_pt_calibration(csv_paths) -> Tuple[Dict[int, Tuple[float, float, float, float]], Optional[str]]:
    """
    Load PT calibration coefficients from one or more CSV files.
    Args:
        csv_paths: Single CSV path (str) or list of CSV paths. Empty string/list uses default.
    Returns:
        Tuple of (result_dict, error_message):
        - result_dict: connector_id -> (PT_A, PT_B, PT_C, PT_D) for each PT present in CSVs
        - error_message: None if successful, error string if duplicates or other errors found
    The number in the CSV (PT1, PT2, ...) is the board connector number; this same ID is used
    everywhere: config.json sensor_roles, mappings, and packet sensor_id.
    CSV columns per PT: ADC Code, Pressure, Coefficient 0 (A), 1 (B), 2 (C), 3 (D).
    Uses the last data row as the calibration coefficients.
    Works with any number of PTs; PT numbers are discovered from column names "PT{N} Coefficient 0".
    If multiple CSVs contain the same PT number, returns error message listing duplicates.
    """
    result = {}
    duplicates = {}  # pt_num -> list of CSV files that contain it
    
    # Normalize input: convert single string to list, handle empty/default
    if isinstance(csv_paths, str):
        csv_paths = [csv_paths] if csv_paths.strip() else []
    elif not isinstance(csv_paths, list):
        csv_paths = []
    
    # If empty list, use default
    if not csv_paths:
        csv_paths = [PT_CALIBRATION_CSV]
    
    # Track which CSV file contains which PT numbers (for duplicate reporting)
    csv_pt_map = {}  # csv_path -> set of pt_nums
    
    # Load each CSV and merge results
    for csv_path in csv_paths:
        if not csv_path or not csv_path.strip():
            continue
        csv_path = csv_path.strip()
        if not os.path.isfile(csv_path):
            continue
        
        try:
            with open(csv_path, newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                rows = list(reader)
                fieldnames = reader.fieldnames or []
            if not rows:
                continue
            
            # Discover PT numbers from column names (e.g. "PT1 Coefficient 0" -> pt_num 1)
            pt_nums = set()
            for col in fieldnames:
                m = re.match(r"PT(\d+)\s+Coefficient\s+0", col, re.IGNORECASE)
                if m:
                    pt_nums.add(int(m.group(1)))
            
            csv_pt_map[csv_path] = pt_nums
            
            # Use last row for coefficients (final calibration state)
            last = rows[-1]
            for pt_num in sorted(pt_nums):
                # Check for duplicates
                if pt_num in result:
                    if pt_num not in duplicates:
                        duplicates[pt_num] = []
                        # Find which CSV(s) already had this PT
                        for prev_path, prev_pt_nums in csv_pt_map.items():
                            if prev_path == csv_path:
                                continue  # Skip current CSV
                            if pt_num in prev_pt_nums:
                                duplicates[pt_num].append(os.path.basename(prev_path))
                    duplicates[pt_num].append(os.path.basename(csv_path))
                    continue  # Skip this duplicate
                
                a = float(last.get(f"PT{pt_num} Coefficient 0", 0))
                b = float(last.get(f"PT{pt_num} Coefficient 1", 0))
                c = float(last.get(f"PT{pt_num} Coefficient 2", 0))
                d = float(last.get(f"PT{pt_num} Coefficient 3", 0))
                result[pt_num] = (a, b, c, d)
        except Exception as e:
            return result, f"Error loading {os.path.basename(csv_path)}: {str(e)}"
    
    # Build error message if duplicates found
    if duplicates:
        error_parts = ["Duplicate PT numbers found:"]
        for pt_num, files in sorted(duplicates.items()):
            error_parts.append(f"  PT{pt_num} appears in: {', '.join(files)}")
        return result, "\n".join(error_parts)
    
    return result, None


# Demo mode: fake UDP packets from separate module
from demo_sensor_sender import build_demo_packet


# ---------------------- Protocol Functions ----------------------
def parse_packet_header(data: bytes) -> Optional[Tuple[int, int, int]]:
    """Parse the packet header. Returns: (packet_type, version, timestamp) or None"""
    if len(data) < PACKET_HEADER_SIZE:
        return None
    try:
        packet_type, version, timestamp = struct.unpack(PACKET_HEADER_FORMAT, data[:PACKET_HEADER_SIZE])
        return (packet_type, version, timestamp)
    except struct.error:
        return None


def parse_sensor_data_packet(data: bytes) -> Optional[Tuple[dict, List[dict]]]:
    """Parse a sensor data packet. Returns: (header_dict, chunks_list) or None"""
    if len(data) < PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE:
        return None
    
    header = parse_packet_header(data)
    if header is None or header[0] != PacketType.SENSOR_DATA:
        return None
    
    packet_type, version, timestamp = header
    
    offset = PACKET_HEADER_SIZE
    try:
        num_chunks, num_sensors = struct.unpack(
            SENSOR_DATA_PACKET_FORMAT,
            data[offset:offset + SENSOR_DATA_PACKET_SIZE]
        )
    except struct.error:
        return None
    
    offset += SENSOR_DATA_PACKET_SIZE
    
    per_chunk_size = SENSOR_DATA_CHUNK_SIZE + (num_sensors * SENSOR_DATAPOINT_SIZE)
    expected_size = PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE + (num_chunks * per_chunk_size)
    
    if len(data) < expected_size:
        return None
    
    chunks = []
    for chunk_idx in range(num_chunks):
        try:
            chunk_timestamp, = struct.unpack(
                SENSOR_DATA_CHUNK_FORMAT,
                data[offset:offset + SENSOR_DATA_CHUNK_SIZE]
            )
        except struct.error:
            return None
        
        offset += SENSOR_DATA_CHUNK_SIZE
        
        datapoints = []
        for sensor_idx in range(num_sensors):
            try:
                sensor_id, sensor_data = struct.unpack(
                    SENSOR_DATAPOINT_FORMAT,
                    data[offset:offset + SENSOR_DATAPOINT_SIZE]
                )
                datapoints.append({
                    'sensor_id': sensor_id,
                    'data': sensor_data
                })
                offset += SENSOR_DATAPOINT_SIZE
            except struct.error:
                return None
        
        chunks.append({
            'timestamp': chunk_timestamp,
            'datapoints': datapoints
        })
    
    header_dict = {
        'packet_type': packet_type,
        'version': version,
        'timestamp': timestamp
    }
    
    return (header_dict, chunks)


def create_actuator_command_packet(commands: List[Tuple[int, int]]) -> bytes:
    """
    Create an actuator command packet.
    commands: List of (actuator_id, actuator_state) tuples
    actuator_id: 1-10 (1-indexed)
    actuator_state: 0 = OFF, non-zero = ON
    """
    if len(commands) == 0 or len(commands) > 255:
        return b''
    
    # Calculate packet size
    header_size = PACKET_HEADER_SIZE
    body_size = ACTUATOR_COMMAND_PACKET_SIZE
    commands_size = len(commands) * ACTUATOR_COMMAND_SIZE
    total_size = header_size + body_size + commands_size
    
    if total_size > MAX_PACKET_SIZE:
        return b''
    
    # Create packet buffer
    packet = bytearray(total_size)
    offset = 0
    
    # Packet header
    packet_type = PacketType.ACTUATOR_COMMAND
    version = DIABLO_COMMS_VERSION
    timestamp = int(time.time() * 1000) & 0xFFFFFFFF  # 32-bit timestamp in milliseconds
    
    struct.pack_into(PACKET_HEADER_FORMAT, packet, offset, packet_type, version, timestamp)
    offset += PACKET_HEADER_SIZE
    
    # Actuator command packet body
    num_commands = len(commands)
    struct.pack_into(ACTUATOR_COMMAND_PACKET_FORMAT, packet, offset, num_commands)
    offset += ACTUATOR_COMMAND_PACKET_SIZE
    
    # Actuator commands
    for actuator_id, actuator_state in commands:
        struct.pack_into(ACTUATOR_COMMAND_FORMAT, packet, offset, actuator_id, actuator_state)
        offset += ACTUATOR_COMMAND_SIZE
    
    return bytes(packet)


def create_pwm_actuator_command_packet(commands: List[Tuple[int, int, float, float]]) -> bytes:
    """
    Creates a PWM Actuator Command packet.
    Packet layout: PacketHeader + PWMActuatorCommandPacket + N PWMActuatorCommand.
    
    commands: List of tuples (actuator_id, duration_ms, duty_cycle, frequency)
              Note: duration is in ms (uint32), duty_cycle is float (0.0-1.0), frequency is float (Hz)
    """
    if len(commands) == 0 or len(commands) > 255:
        return b''
        
    header_size = PACKET_HEADER_SIZE
    body_size = PWM_ACTUATOR_COMMAND_PACKET_SIZE
    commands_size = len(commands) * PWM_ACTUATOR_COMMAND_SIZE
    total_size = header_size + body_size + commands_size
    
    if total_size > MAX_PACKET_SIZE:
        return b''
        
    packet = bytearray(total_size)
    offset = 0
    
    # Header
    struct.pack_into(PACKET_HEADER_FORMAT, packet, offset, PacketType.PWM_ACTUATOR_COMMAND, DIABLO_COMMS_VERSION, int(time.time() * 1000) & 0xFFFFFFFF)
    offset += PACKET_HEADER_SIZE
    
    # Body (num_commands)
    struct.pack_into(PWM_ACTUATOR_COMMAND_PACKET_FORMAT, packet, offset, len(commands))
    offset += PWM_ACTUATOR_COMMAND_PACKET_SIZE
    
    # Commands
    for actuator_id, duration_ms, duty_cycle, frequency in commands:
        struct.pack_into(PWM_ACTUATOR_COMMAND_FORMAT, packet, offset, actuator_id, duration_ms, duty_cycle, frequency)
        offset += PWM_ACTUATOR_COMMAND_SIZE
        
    return bytes(packet)


# ---------------------- UDP Receiver Thread ----------------------
class UDPReceiver(QtCore.QThread):
    """Thread that receives UDP packets and emits decoded sensor data"""
    sensor_data_received = QtCore.pyqtSignal(dict, list, str)  # header, chunks, source_ip
    status_update = QtCore.pyqtSignal(str)
    packet_received = QtCore.pyqtSignal(int, int)  # packet_size, packet_type
    
    def __init__(self, port: int = DEFAULT_RECEIVE_PORT, bind_address: str = '0.0.0.0'):
        super().__init__()
        self.port = port
        self.bind_address = bind_address
        self._stop = False
        self.sock = None
        self.total_packets = 0
        self.total_bytes = 0
        self.start_time = None
        
    def stop(self):
        """Stop the receiver thread"""
        self._stop = True
        if self.sock:
            try:
                self.sock.close()
            except:
                pass
    
    def get_stats(self) -> Dict:
        """Get current statistics"""
        if self.start_time is None:
            return {'packets': 0, 'bytes': 0, 'packets_per_sec': 0.0, 'bytes_per_sec': 0.0}
        
        elapsed = time.time() - self.start_time
        if elapsed > 0:
            pps = self.total_packets / elapsed
            bps = self.total_bytes / elapsed
        else:
            pps = 0.0
            bps = 0.0
        
        return {
            'packets': self.total_packets,
            'bytes': self.total_bytes,
            'packets_per_sec': pps,
            'bytes_per_sec': bps,
            'elapsed': elapsed
        }
    
    def run(self):
        """Main receiver loop"""
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.settimeout(0.1)  # Non-blocking with timeout
        
        try:
            self.sock.bind((self.bind_address, self.port))
            self.status_update.emit(f"Listening on {self.bind_address}:{self.port}")
            self.start_time = time.time()
        except OSError as e:
            self.status_update.emit(f"Error binding: {e}")
            return
        
        while not self._stop:
            try:
                data, addr = self.sock.recvfrom(MAX_PACKET_SIZE)
                self.total_packets += 1
                self.total_bytes += len(data)
                
                header = parse_packet_header(data)
                if header is None:
                    continue
                
                packet_type, version, timestamp = header
                self.packet_received.emit(len(data), packet_type)
                
                if packet_type == PacketType.SENSOR_DATA:
                    result = parse_sensor_data_packet(data)
                    if result:
                        header_dict, chunks = result
                        source_ip = addr[0]  # Extract IP address from (ip, port) tuple
                        self.sensor_data_received.emit(header_dict, chunks, source_ip)
                        
            except socket.timeout:
                continue
            except Exception as e:
                if not self._stop:
                    self.status_update.emit(f"Error: {e}")
                continue
        
        if self.sock:
            try:
                self.sock.close()
            except:
                pass
        self.status_update.emit("Stopped")


# ---------------------- Debug dialog (C1, MA, raw values, network) ----------------------
class SensorDebugDialog(QtWidgets.QDialog):
    """Popup showing network stats, C1, MA, and psi for each connector."""
    def __init__(self, parent: "SensorPlotWidget"):
        super().__init__(parent)
        self.plot_widget = parent
        self.setWindowTitle("Sensor debug")
        self.setMinimumWidth(320)
        layout = QtWidgets.QVBoxLayout(self)
        # Network statistics at top
        net_group = QtWidgets.QGroupBox("Network")
        net_layout = QtWidgets.QVBoxLayout()
        self.packets_lbl = QtWidgets.QLabel("Packets: 0")
        self.pps_lbl = QtWidgets.QLabel("Packets/sec: 0.0")
        self.bytes_lbl = QtWidgets.QLabel("Bytes: 0 B")
        self.bps_lbl = QtWidgets.QLabel("Bytes/sec: 0.0 B/s")
        for w in (self.packets_lbl, self.pps_lbl, self.bytes_lbl, self.bps_lbl):
            net_layout.addWidget(w)
        net_group.setLayout(net_layout)
        layout.addWidget(net_group)
        # Sensor table
        self.table = QtWidgets.QTableWidget()
        self.table.setColumnCount(4)
        self.table.setHorizontalHeaderLabels(["Connector", "C (V)", "MA (V)", "psi"])
        self.table.horizontalHeader().setStretchLastSection(True)
        layout.addWidget(self.table)
        close_btn = QtWidgets.QPushButton("Close")
        close_btn.clicked.connect(self.accept)
        layout.addWidget(close_btn)
        self.refresh_timer = QtCore.QTimer(self)
        self.refresh_timer.timeout.connect(self.refresh)
        self.refresh_timer.start(300)

    def showEvent(self, event):
        super().showEvent(event)
        self.refresh()

    def refresh(self):
        ns = self.plot_widget.network_stats
        self.packets_lbl.setText(f"Packets: {ns['packets']}")
        self.pps_lbl.setText(f"Packets/sec: {ns['pps']}")
        self.bytes_lbl.setText(f"Bytes: {ns['bytes']}")
        self.bps_lbl.setText(f"Bytes/sec: {ns['bps']}")

        self.table.setRowCount(NUM_CONNECTORS)
        for i in range(1, NUM_CONNECTORS + 1):
            row = i - 1
            if self.table.item(row, 0) is None:
                self.table.setItem(row, 0, QtWidgets.QTableWidgetItem(f"PT {i}"))
            self.table.item(row, 0).setText(f"PT {i}")
            dv = self.plot_widget.debug_values.get(i, {})
            c = dv.get("current")
            ma = dv.get("moving_avg")
            psi = dv.get("psi")
            self._set_cell(row, 1, f"{c:.4f}" if c is not None else "---")
            self._set_cell(row, 2, f"{ma:.4f}" if ma is not None else "---")
            self._set_cell(row, 3, f"{psi:.2f}" if psi is not None else "---")

    def _set_cell(self, row: int, col: int, text: str):
        item = self.table.item(row, col)
        if item is None:
            item = QtWidgets.QTableWidgetItem(text)
            self.table.setItem(row, col, item)
        else:
            item.setText(text)

    def closeEvent(self, event):
        self.refresh_timer.stop()
        super().closeEvent(event)


# ---------------------- Sensor Plot Widget (reusable panel) ----------------------
class SensorPlotWidget(QtWidgets.QWidget):
    """Reusable sensor/PT plotting panel. Used in SensorPlotWindow and CombinedMainWindow."""
    def __init__(self, receiver, bind_address: str = '0.0.0.0', parent=None):
        super().__init__(parent)
        self.receiver = receiver
        self.bind_address = bind_address
        self.window_seconds = DEFAULT_WINDOW_SECONDS
        self.display_moving_avg_samples = 10  # Moving average for displayed values
        self.graph_moving_avg_samples = 1  # Moving average for graphed lines (1 = no smoothing)
        
        # ADC conversion settings
        self.adc_bits = 32  # ADC bit count (default: 32-bit)
        self.reference_voltage = 2.5  # Reference voltage in Volts (default: 2.5V)
        
        # IP filter for sensor data (default to sensor board IP)
        self.filter_source_ip = DEFAULT_SENSOR_IP  # Only accept data from this IP
        
        # Y-axis settings
        self.y_axis_auto_scale = True  # Auto-scale Y-axis by default
        self.y_axis_min = 0.0  # Minimum Y-axis value (psi)
        self.y_axis_max = 700.0  # Maximum Y-axis value (psi)
        
        # Data storage: sensor_id -> deque of (timestamp_ms, value)
        self.sensor_data: Dict[int, deque] = {}  # Voltage data for statistics display
        self.sensor_adc_codes: Dict[int, deque] = {}  # Store ADC codes for pressure calculation
        # Plot buffers: separate time and psi arrays for fast numpy access (no tuple unpacking)
        self.sensor_psi_plot_t: Dict[int, deque] = {}  # time values for plotting
        self.sensor_psi_plot_v: Dict[int, deque] = {}  # psi values for plotting
        self.sensor_psi_history: Dict[int, list] = {}  # PSI data for CSV saving (full history)
        self.sensor_plots: Dict[int, pg.PlotDataItem] = {}
        self.plot_enabled: Dict[int, bool] = {i: True for i in range(1, NUM_CONNECTORS + 1)}
        
        # Statistics
        self.stats_start_time = time.time()
        
        self.pt_calibration, self.pt_calibration_error = load_pt_calibration(CONFIG.get_pt_calibration_csv_paths())
        if self.pt_calibration_error:
            print(f"PT Calibration Error: {self.pt_calibration_error}")
        
        # Reference to main window for event tracking (set by main window)
        self.main_window_ref = None
        
        # Sensor labels (connector_id -> label string); all from config sensor_roles (role name = label)
        self.sensor_labels = {i: CONFIG.get_sensor_label(i) for i in range(1, NUM_CONNECTORS + 1)}
        # Debug values for popup: connector_id -> {'current': float, 'moving_avg': float, 'psi': float|None}
        self.debug_values: Dict[int, Dict] = {}
        # Network stats for debug popup
        self.network_stats = {"packets": "0", "pps": "0.0", "bytes": "0 B", "bps": "0.0 B/s"}
        
        # SPS Calculation
        self.total_samples_received = 0
        self.last_sps_sample_count = 0
        self.last_sps_time = time.time()
        
        # Load display settings from Config
        disp = CONFIG.config["display"]
        self.window_seconds = disp["window_seconds"]
        # Dynamic buffer size: window_seconds * 1000 samples/sec (approx) + safety margin
        self.plot_buffer_size = int(self.window_seconds * 1200) + 1000
        if self.plot_buffer_size < 1000: self.plot_buffer_size = 1000
        
        self.adc_bits = disp["adc_bits"]
        self.reference_voltage = disp["ref_voltage"]
        self.y_axis_min = disp["y_axis_min"]
        self.y_axis_max = disp["y_axis_max"]
        self.y_axis_auto_scale = disp["y_axis_autoscale"]
        self.graph_moving_avg_samples = disp.get("graph_ma_samples", self.graph_moving_avg_samples)
        self.display_moving_avg_samples = disp.get("display_ma_samples", self.display_moving_avg_samples)
        self.only_show_pt_with_roles = disp.get("only_show_pt_with_roles", False)
        self.filter_source_ip = CONFIG.config["network"]["sensor_ip_filter"]
        
        # Demo mode: synthetic PT data via UDP to localhost (same decode path as real hardware)
        self.demo_mode = False
        self.demo_start_time: Optional[float] = None
        self.demo_send_socket: Optional[socket.socket] = None
        self.demo_send_timer: Optional[QtCore.QTimer] = None
        
        self.init_ui()
        
        # Connect to receiver signals
        self.receiver.sensor_data_received.connect(self.on_sensor_data)
        self.receiver.status_update.connect(self.on_status_update)
        self.receiver.packet_received.connect(self.on_packet_received)
        
        # Timer for updating plots and statistics
        self.update_timer = QtCore.QTimer(self)
        self.update_timer.timeout.connect(self.update_plots)
        self.update_timer.start(UPDATE_INTERVAL_MS)
        
        # Timer for updating statistics display
        self.stats_timer = QtCore.QTimer(self)
        self.stats_timer.timeout.connect(self.update_statistics)
        self.stats_timer.start(500)  # Update stats every 500ms
    
    def format_label_two_rows(self, text: str) -> str:
        """Format label text to always be two words, one per row.
        Splits text into words and ensures exactly two words on separate lines."""
        if not text:
            return ""
        words = text.strip().split()
        if len(words) == 0:
            return ""
        elif len(words) == 1:
            # If only one word, try to split it (e.g., "PT1" -> "PT" and "1")
            word = words[0]
            # Try to split on number boundary (e.g., "PT1" -> ["PT", "1"])
            parts = re.split(r'(\d+)', word)
            parts = [p for p in parts if p]  # Remove empty strings
            if len(parts) >= 2:
                return f"{parts[0]}\n{''.join(parts[1:])}"
            else:
                # Can't split, just put it on first row with empty second row
                return f"{word}\n "
        elif len(words) >= 2:
            # Take first two words, one per row
            return f"{words[0]}\n{words[1]}"
        return text
    
    def on_sensor_label_changed(self, connector_id: int, text: str):
        """Update local sensor label and plot legend (config is written via set_sensor_role in settings)."""
        self.sensor_labels[connector_id] = text
        
        # Update the under-graph name label
        if connector_id in self.under_graph_name_labels:
            display_name = text if text else f"PT {connector_id}"
            formatted_name = self.format_label_two_rows(display_name)
            self.under_graph_name_labels[connector_id].setText(formatted_name)
        
        # Update the plot legend if this sensor has a plot
        if connector_id in self.sensor_plots:
            self.update_plot_legend(connector_id)
        
        # If "only show PTs with roles" is enabled, update visibility immediately
        if self.only_show_pt_with_roles:
            self.update_plots()
            self.update_statistics()
    
    def update_plot_legend(self, connector_id: int):
        """Update the legend for a specific sensor plot"""
        if connector_id not in self.sensor_plots:
            return
        
        plot = self.sensor_plots[connector_id]
        label = self.sensor_labels.get(connector_id, "")
        if label:
            new_name = f"PT {connector_id}: {label} (psi)"
        else:
            new_name = f"PT {connector_id} (psi)"
        
        # Update legend by finding and modifying the legend item
        if self.legend:
            for item in self.legend.items:
                if len(item) >= 2 and item[0] == plot:
                    label_item = item[1]
                    label_item.setText(new_name)
                    break
    
    def init_ui(self):
        """Initialize the user interface"""
        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        
        # Top panel with controls
        top_panel = QtWidgets.QHBoxLayout()
        
        # Connection info
        self.status_label = QtWidgets.QLabel("Starting...")
        self.status_label.setStyleSheet("font-weight: bold; padding: 5px;")
        self.status_label.setFixedWidth(400)  # Fixed width to prevent layout resize on text change
        top_panel.addWidget(self.status_label)
        
        top_panel.addStretch()
        
        # Y-axis auto-scale toggle
        self.auto_scale_checkbox = QtWidgets.QCheckBox("Auto-scale Y-axis")
        self.auto_scale_checkbox.setChecked(self.y_axis_auto_scale)
        self.auto_scale_checkbox.stateChanged.connect(self.on_auto_scale_toggled)
        self.auto_scale_checkbox.setStyleSheet("padding: 5px;")
        top_panel.addWidget(self.auto_scale_checkbox)
        
        # CSV export buttons
        btn_save_pressures = QtWidgets.QPushButton("Save Pressures CSV")
        btn_save_pressures.clicked.connect(self.save_pressures_csv)
        btn_save_pressures.setStyleSheet("padding: 5px;")
        top_panel.addWidget(btn_save_pressures)
        
        btn_save_events = QtWidgets.QPushButton("Save Events CSV")
        btn_save_events.clicked.connect(self.save_events_csv)
        btn_save_events.setStyleSheet("padding: 5px;")
        top_panel.addWidget(btn_save_events)
        
        layout.addLayout(top_panel)
        
        # Horizontal layout: left = plot + under-graph values, right = stats
        plot_stats_layout = QtWidgets.QHBoxLayout()
        
        left_column = QtWidgets.QWidget()
        left_column_layout = QtWidgets.QVBoxLayout(left_column)
        left_column_layout.setContentsMargins(0, 0, 0, 0)
        
        # Plot widget
        self.plot_widget = pg.GraphicsLayoutWidget()
        self.plot_widget.setBackground('k')  # Black background
        left_column_layout.addWidget(self.plot_widget, 1)
        
        # Under-graph strip: label on top, value below (large and easy to read)
        under_graph_widget = QtWidgets.QWidget()
        under_graph_layout = QtWidgets.QHBoxLayout(under_graph_widget)
        under_graph_layout.setContentsMargins(8, 8, 8, 8)
        under_graph_layout.setSpacing(16)
        label_font = QtGui.QFont()
        label_font.setPointSize(10)
        value_font = QtGui.QFont()
        value_font.setPointSize(16)
        value_font.setWeight(QtGui.QFont.Weight.DemiBold)
        self.under_graph_labels: Dict[int, QtWidgets.QLabel] = {}  # value label only
        self.under_graph_name_labels: Dict[int, QtWidgets.QLabel] = {}  # name label (PT role)
        self.under_graph_containers: Dict[int, QtWidgets.QWidget] = {}  # cell to show/hide
        for i in range(1, NUM_CONNECTORS + 1):
            cell = QtWidgets.QWidget()
            cell_layout = QtWidgets.QVBoxLayout(cell)
            cell_layout.setContentsMargins(6, 4, 6, 4)
            cell_layout.setSpacing(2)
            label_text = self.sensor_labels.get(i, f"PT {i}")
            formatted_label = self.format_label_two_rows(label_text)
            name_lbl = QtWidgets.QLabel(formatted_label)
            name_lbl.setFont(label_font)
            name_lbl.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
            name_lbl.setWordWrap(False)
            color_idx = i % len(SENSOR_COLORS)
            color_style = f"color: rgb{SENSOR_COLORS[color_idx]};"
            name_lbl.setStyleSheet(color_style)
            name_lbl.setMinimumWidth(72)
            cell_layout.addWidget(name_lbl)
            value_lbl = QtWidgets.QLabel("---")
            value_lbl.setFont(value_font)
            value_lbl.setTextFormat(QtCore.Qt.TextFormat.RichText)
            value_lbl.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
            value_lbl.setStyleSheet(color_style)
            value_lbl.setMinimumWidth(72)
            cell_layout.addWidget(value_lbl)
            under_graph_layout.addWidget(cell)
            self.under_graph_containers[i] = cell
            self.under_graph_name_labels[i] = name_lbl
            self.under_graph_labels[i] = value_lbl
        under_graph_layout.addStretch()
        left_column_layout.addWidget(under_graph_widget)
        
        plot_stats_layout.addWidget(left_column, 1)
        layout.addLayout(plot_stats_layout, 1)
        
        # Create initial plot
        self.plot_item = self.plot_widget.addPlot(title="Pressure Data Over Time (Calibrated Sensors)")
        
        # Set title color and size to white for visibility on black background
        self.plot_item.setTitle("Pressure Data Over Time (Calibrated Sensors)", color='w', size='14pt')
        
        # Set axis labels to white
        self.plot_item.setLabel('left', 'Pressure (psi)', color='w')
        self.plot_item.setLabel('bottom', 'Time (seconds)', color='w')
        
        # Legend removed from pressure display graph
        self.legend = None
        # Show grid with white/gray lines for visibility on black background
        self.plot_item.showGrid(x=True, y=True, alpha=0.5)
        self.plot_item.setClipToView(True)  # Optimize rendering by clipping to view
        # Set grid color to light gray/white
        self.plot_item.getViewBox().setBackgroundColor('k')  # Ensure black background
        
        # Increase font size for axis labels and ticks
        font = QtGui.QFont()
        font.setPointSize(12)
        
        # Set all axis text to white
        left_axis = self.plot_item.getAxis('left')
        bottom_axis = self.plot_item.getAxis('bottom')
        
        # Set font size for ticks
        left_axis.setStyle(tickFont=font)
        bottom_axis.setStyle(tickFont=font)
        
        # Set label font size by accessing the label item directly
        try:
            left_axis.label.setFont(font)
            bottom_axis.label.setFont(font)
        except AttributeError:
            pass
        
        # Set axis line and text colors to white; thin pen so gridlines (e.g. every 2s) are thinner
        thin_white = pg.mkPen('w', width=1.0)
        left_axis.setPen(thin_white)
        bottom_axis.setPen(thin_white)
        left_axis.setTextPen('w')
        bottom_axis.setTextPen('w')
        
        # Pre-initialize plots for all 10 connectors
        self.init_connector_plots()
        
        # Add SPS label to plot (bottom-left anchor)
        self.sps_text_item = pg.TextItem(text="SPS: 0", color=(200, 200, 200), anchor=(0, 1))
        self.sps_text_item.setPos(0, 0)  # Initial position, will be updated in update_plots/resize
        self.plot_item.addItem(self.sps_text_item)
    
    def init_connector_plots(self):
        """Pre-initialize plots for all 10 connectors"""
        for connector_id in range(1, NUM_CONNECTORS + 1):
            self.sensor_data[connector_id] = deque(maxlen=MAX_POINTS)
            self.sensor_adc_codes[connector_id] = deque(maxlen=MAX_POINTS)
            # Only initialize PSI data and plots for calibrated sensors
            if connector_id in self.pt_calibration:
                self.sensor_psi_plot_t[connector_id] = deque(maxlen=self.plot_buffer_size)
                self.sensor_psi_plot_v[connector_id] = deque(maxlen=self.plot_buffer_size)
                self.sensor_psi_history[connector_id] = []
                self.add_sensor_plot(connector_id)
    
    def reload_pt_calibration(self):
        """Reload PT calibration from config paths (e.g. after user changes CSV in settings)."""
        self.pt_calibration, self.pt_calibration_error = load_pt_calibration(CONFIG.get_pt_calibration_csv_paths())
        if self.pt_calibration_error:
            print(f"PT Calibration Error: {self.pt_calibration_error}")
            # Show error in GUI if we have a reference to main window
            if self.main_window_ref:
                QtWidgets.QMessageBox.warning(
                    self.main_window_ref,
                    "PT Calibration Error",
                    self.pt_calibration_error
                )
        for connector_id in range(1, NUM_CONNECTORS + 1):
            if connector_id in self.pt_calibration and connector_id not in self.sensor_psi_plot_t:
                self.sensor_psi_plot_t[connector_id] = deque(maxlen=self.plot_buffer_size)
                self.sensor_psi_plot_v[connector_id] = deque(maxlen=self.plot_buffer_size)
                self.sensor_psi_history[connector_id] = []
                self.add_sensor_plot(connector_id)
        self.update_plots()
        self.update_statistics()
    
    def _on_plot_toggle(self, connector_id: int, state):
        self.plot_enabled[connector_id] = bool(state)
        if connector_id in self.under_graph_containers:
            self.under_graph_containers[connector_id].setVisible(bool(state))

    def open_debug_menu(self):
        """Open the debug popup showing C1, MA, psi per connector."""
        dlg = SensorDebugDialog(self)
        dlg.exec()

    def on_auto_scale_toggled(self, state):
        """Handle auto-scale Y-axis toggle"""
        self.y_axis_auto_scale = bool(state)
        CONFIG.config["display"]["y_axis_autoscale"] = self.y_axis_auto_scale
        CONFIG.save()
        # Update settings checkbox if it exists
        if hasattr(self, 'settings_widget_ref') and self.settings_widget_ref:
             # This is a bit circular, but we can emit a signal or just let the settings
             # tab refresh next time it is shown.
             pass
    
    def _clear_all_sensor_deques(self):
        """Clear all sensor data deques so plot/stats show only new data."""
        for k in list(self.sensor_data.keys()):
            self.sensor_data[k] = deque(maxlen=MAX_POINTS)
            self.sensor_adc_codes[k] = deque(maxlen=MAX_POINTS)
            if k in self.sensor_psi_plot_t:
                self.sensor_psi_plot_t[k] = deque(maxlen=self.plot_buffer_size)
                self.sensor_psi_plot_v[k] = deque(maxlen=self.plot_buffer_size)
            if k in self.sensor_psi_history:
                self.sensor_psi_history[k] = []
    
    def on_demo_mode_toggled(self, state):
        """Handle Demo mode checkbox: toggle demo_mode, start/stop UDP sender, clear deques.
        
        Uses QTimer.singleShot to defer state changes to avoid Wayland buffer size mismatch
        crashes when the window is maximized (xdg_surface buffer error).
        """
        # Defer the actual state change to avoid Wayland crash when maximized
        QtCore.QTimer.singleShot(0, lambda: self._apply_demo_mode(bool(state)))
    
    def _apply_demo_mode(self, enabled: bool):
        """Apply demo mode state change (called via QTimer to avoid Wayland crashes)."""
        self.demo_mode = enabled
        if self.demo_mode:
            self.demo_start_time = time.time()
            self._clear_all_sensor_deques()
            self.status_label.setText("Demo mode – synthetic data (UDP)")
            try:
                self.demo_send_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                self.demo_send_timer = QtCore.QTimer(self)
                self.demo_send_timer.timeout.connect(self._send_demo_packet)
                self.demo_send_timer.start(UPDATE_INTERVAL_MS)
            except OSError:
                self.demo_send_socket = None
                self.demo_send_timer = None
        else:
            self.demo_start_time = None
            if self.demo_send_timer is not None:
                self.demo_send_timer.stop()
                self.demo_send_timer = None
            if self.demo_send_socket is not None:
                try:
                    self.demo_send_socket.close()
                except OSError:
                    pass
                self.demo_send_socket = None
            self._clear_all_sensor_deques()
            self.status_label.setText("Listening")
    
    def update_buffer_size(self):
        """Update plot buffer size based on current window_seconds."""
        new_size = int(self.window_seconds * 1200) + 1000
        if new_size < 1000: new_size = 1000
        
        if new_size != self.plot_buffer_size:
            self.plot_buffer_size = new_size
            # Resize existing deques by creating new ones and copying data
            # This is expensive but only happens on config change
            for k in list(self.sensor_psi_plot_t.keys()):
                self.sensor_psi_plot_t[k] = deque(self.sensor_psi_plot_t[k], maxlen=self.plot_buffer_size)
                self.sensor_psi_plot_v[k] = deque(self.sensor_psi_plot_v[k], maxlen=self.plot_buffer_size)
    
    def on_graph_moving_avg_changed(self, value):
        """Handle graph moving average window size change"""
        self.graph_moving_avg_samples = value
    
    def on_display_moving_avg_changed(self, value):
        """Handle display moving average window size change"""
        self.display_moving_avg_samples = value
    
    def code_to_voltage(self, code_uint32: int) -> float:
        """
        Convert raw ADC code to voltage.
        code_uint32: uint32_t representation of the ADC code
        Returns: voltage in Volts
        """
        # Reinterpret uint32_t as int32_t (signed)
        if code_uint32 >= 0x80000000:
            code_int32 = code_uint32 - 0x100000000
        else:
            code_int32 = code_uint32
        
        # Convert to voltage using user-specified settings
        # For signed ADC: voltage = (code * ref_voltage) / (2^(bits-1))
        max_code = 2 ** (self.adc_bits - 1)
        voltage = (code_int32 * self.reference_voltage) / max_code
        return voltage
    
    def on_navigation_requested(self, target: str):
        """Handle navigation requests from TopBarWidget"""
        if target == "settings":
            self.open_settings()
        elif target == "dashboard":
            self.open_dashboard()
        elif target == "pwm":
            self.open_pwm_control()

    def on_status_update(self, message: str):
        """Handle status updates from receiver thread"""
        if not self.demo_mode:
            self.status_label.setText(message)
    
    def on_packet_received(self, packet_size: int, packet_type: int):
        """Handle packet received notification"""
        pass  # Statistics are updated separately
    
    def on_sensor_data(self, header: dict, chunks: List[dict], source_ip: str):
        """Handle received sensor data"""
        if self.demo_mode:
            if source_ip != "127.0.0.1":
                return  # In demo mode only accept packets from local demo sender
        else:
            if source_ip != self.filter_source_ip:
                return  # Ignore data from other sources
        
        current_time = time.time()
        self.total_samples_received += len(chunks)
        
        for chunk in chunks:
            chunk_timestamp_ms = chunk['timestamp']
            # Convert packet timestamp to relative time in seconds
            relative_time = (current_time - self.stats_start_time)
            
            for dp in chunk['datapoints']:
                sensor_id = dp['sensor_id']
                code_uint32 = dp['data']  # Received as uint32_t from protocol
                
                # Convert code to voltage
                voltage = self.code_to_voltage(code_uint32)
                
                # Initialize sensor data storage if needed (for sensors outside 1-10 range)
                if sensor_id not in self.sensor_data:
                    self.sensor_data[sensor_id] = deque(maxlen=MAX_POINTS)
                    self.sensor_adc_codes[sensor_id] = deque(maxlen=MAX_POINTS)
                    # Only create PSI storage and plot for calibrated sensors
                    if sensor_id in self.pt_calibration:
                        self.sensor_psi_plot_t[sensor_id] = deque(maxlen=self.plot_buffer_size)
                        self.sensor_psi_plot_v[sensor_id] = deque(maxlen=self.plot_buffer_size)
                        self.sensor_psi_history[sensor_id] = []
                        self.add_sensor_plot(sensor_id)
                
                # Add data point (use relative time from start)
                self.sensor_data[sensor_id].append((relative_time, voltage))
                self.sensor_adc_codes[sensor_id].append((relative_time, code_uint32))
                
                # Calculate and store PSI if calibration exists
                if sensor_id in self.pt_calibration:
                    a, b, c, d = self.pt_calibration[sensor_id]
                    psi = calculate_pressure(code_uint32, a, b, c, d)
                    self.sensor_psi_plot_t[sensor_id].append(relative_time)
                    self.sensor_psi_plot_v[sensor_id].append(psi)
                    self.sensor_psi_history[sensor_id].append((relative_time, psi))
    
    def _send_demo_packet(self):
        """Build and send one demo UDP packet to localhost (called by demo timer)."""
        if not self.demo_mode or self.demo_start_time is None or not self.pt_calibration:
            return
        packet = build_demo_packet(
            self.pt_calibration,
            self.demo_start_time,
            self.stats_start_time,
            packet_type=PacketType.SENSOR_DATA,
            version=DIABLO_COMMS_VERSION,
            max_packet_size=MAX_PACKET_SIZE,
            psi_min=0.0,
            psi_max=700.0,
        )
        if packet and self.demo_send_socket is not None:
            try:
                self.demo_send_socket.sendto(
                    packet, ("127.0.0.1", self.receiver.port)
                )
            except OSError:
                pass
    
    def add_sensor_plot(self, sensor_id: int):
        """Add a new sensor plot (for calibrated sensors only)"""
        if sensor_id not in self.plot_enabled:
            self.plot_enabled[sensor_id] = True
        color_idx = sensor_id % len(SENSOR_COLORS)
        color = SENSOR_COLORS[color_idx]
        
        # Get label for this sensor
        label = self.sensor_labels.get(sensor_id, "")
        if label:
            plot_name = f"PT {sensor_id}: {label} (psi)"
        else:
            plot_name = f"PT {sensor_id} (psi)"
        
        pen = pg.mkPen(color=color, width=2)
        plot = self.plot_item.plot([], [], pen=pen, name=plot_name)
        
        # Update legend text color to white for this new item
        if self.legend:
            # Find the legend item for this plot and set text color to white
            for item in self.legend.items:
                if len(item) >= 2 and item[0] == plot:
                    label_item = item[1]
                    # Set text color to white
                    label_item.setColor('w')
        
        self.sensor_plots[sensor_id] = plot
    
    def update_plots(self):
        """Update all sensor plots (PSI data for calibrated sensors only)"""
        if not self.sensor_psi_plot_t:
            return
        
        current_time = time.time() - self.stats_start_time
        time_window = self.window_seconds
        
        # Only plot calibrated sensors that have PSI data
        for sensor_id in self.sensor_psi_plot_t:
            if sensor_id not in self.sensor_plots:
                continue
            enabled = self.plot_enabled.get(sensor_id, True)
            # If "only show PTs with roles" is enabled, hide PTs without names
            if enabled and self.only_show_pt_with_roles:
                pt_label = self.sensor_labels.get(sensor_id, "")
                if not pt_label or pt_label.strip() == "":
                    enabled = False
            self.sensor_plots[sensor_id].setVisible(enabled)
            if not enabled:
                continue
            
            t_deque = self.sensor_psi_plot_t[sensor_id]
            v_deque = self.sensor_psi_plot_v[sensor_id]
            n = len(t_deque)
            if n == 0:
                continue
            
            try:
                # Fast conversion: deques of floats -> numpy arrays (no tuple unpacking)
                times_all = np.array(t_deque)
                psi_all = np.array(v_deque)
                
                # Filter by time window using searchsorted (time is sorted)
                start_time = current_time - time_window
                start_idx = np.searchsorted(times_all, start_time)
                
                times_array = times_all[start_idx:]
                psi_array = psi_all[start_idx:]
                
                if len(times_array) == 0:
                    self.sensor_plots[sensor_id].setData([], [])
                    continue
                
                # Stable downsampling: use linspace indices so the same
                # points are selected even as the array grows by 1 each frame
                MAX_PLOT_POINTS = 2000
                if len(times_array) > MAX_PLOT_POINTS:
                    indices = np.linspace(0, len(times_array) - 1, MAX_PLOT_POINTS, dtype=int)
                    times_array = times_array[indices]
                    psi_array = psi_array[indices]

                # Apply moving average smoothing to graph if window > 1
                if self.graph_moving_avg_samples > 1 and len(psi_array) >= self.graph_moving_avg_samples:
                    kernel = np.ones(self.graph_moving_avg_samples) / self.graph_moving_avg_samples
                    smoothed_psi = np.convolve(psi_array, kernel, mode='valid')
                    smoothed_times = times_array[self.graph_moving_avg_samples - 1:]
                    self.sensor_plots[sensor_id].setData(smoothed_times, smoothed_psi)
                else:
                    self.sensor_plots[sensor_id].setData(times_array, psi_array)
            except Exception as e:
                print(f"Error updating plot for sensor {sensor_id}: {e}")
                continue
        
        # Update x-axis range
        if current_time > time_window:
            self.plot_item.setXRange(current_time - time_window, current_time, padding=0)
        else:
            self.plot_item.setXRange(0, time_window, padding=0)
        
        # Update y-axis range based on auto-scale setting
        if self.y_axis_auto_scale:
            # Disable pyqtgraph's built-in auto-range and compute our own with smoothing
            self.plot_item.disableAutoRange(axis='y')
            # Compute actual min/max from all visible enabled plot data
            y_lo, y_hi = float('inf'), float('-inf')
            for sid in self.sensor_psi_plot_t:
                if sid not in self.sensor_plots or not self.sensor_plots[sid].isVisible():
                    continue
                vd = self.sensor_psi_plot_v[sid]
                td = self.sensor_psi_plot_t[sid]
                if len(vd) == 0:
                    continue
                # Quick scan: only check last plot_buffer worth of data (already bounded)
                t_arr = np.array(td)
                v_arr = np.array(vd)
                mask = t_arr >= (current_time - time_window)
                visible = v_arr[mask]
                if len(visible) > 0:
                    y_lo = min(y_lo, float(visible.min()))
                    y_hi = max(y_hi, float(visible.max()))
            if y_lo < y_hi:
                pad = max((y_hi - y_lo) * 0.05, 1.0)  # 5% padding, minimum 1 psi
                target_lo = y_lo - pad
                target_hi = y_hi + pad
                # Smooth transition: blend toward target (prevents frame-to-frame jitter)
                alpha = 0.15  # smoothing factor (0=no change, 1=instant snap)
                prev = self.plot_item.viewRange()[1]  # [y_min, y_max]
                new_lo = prev[0] + alpha * (target_lo - prev[0])
                new_hi = prev[1] + alpha * (target_hi - prev[1])
                self.plot_item.setYRange(new_lo, new_hi, padding=0)
        else:
            self.plot_item.setYRange(self.y_axis_min, self.y_axis_max, padding=0)
            self.plot_item.disableAutoRange(axis='y')
            
        # Update SPS label position to stay in bottom-left of view
        view_box = self.plot_item.getViewBox()
        view_range = view_box.viewRange()
        x_min = view_range[0][0]
        y_min = view_range[1][0]
        # Add small offset from corner
        x_range = view_range[0][1] - view_range[0][0]
        y_range = view_range[1][1] - view_range[1][0]
        self.sps_text_item.setPos(x_min + (x_range * 0.02), y_min + (y_range * 0.1))
    
    def update_statistics(self):
        """Update statistics display"""
        if self.receiver is None:
            return
        
        stats = self.receiver.get_stats()
        self.network_stats["packets"] = str(stats["packets"])
        self.network_stats["pps"] = f"{stats['packets_per_sec']:.2f}"
        bytes_val = stats["bytes"]
        if bytes_val < 1024:
            self.network_stats["bytes"] = f"{bytes_val} B"
        elif bytes_val < 1024 * 1024:
            self.network_stats["bytes"] = f"{bytes_val / 1024:.2f} KB"
        else:
            self.network_stats["bytes"] = f"{bytes_val / (1024 * 1024):.2f} MB"
        bps = stats["bytes_per_sec"]
        if bps < 1024:
            self.network_stats["bps"] = f"{bps:.2f} B/s"
        elif bps < 1024 * 1024:
            self.network_stats["bps"] = f"{bps / 1024:.2f} KB/s"
        else:
            self.network_stats["bps"] = f"{bps / (1024 * 1024):.2f} MB/s"

        # Update SPS display
        current_time = time.time()
        time_diff = current_time - self.last_sps_time
        sps = 0.0
        if time_diff >= 0.5:  # Update every 500ms or so (matches stats timer)
            sample_diff = self.total_samples_received - self.last_sps_sample_count
            sps = sample_diff / time_diff
            self.last_sps_sample_count = self.total_samples_received
            self.last_sps_time = current_time
            
            # If we haven't updated in a while, use the calculated value
            self.current_sps_display = sps
        else:
            # maintain previous display value if called too fast
            sps = getattr(self, 'current_sps_display', 0.0)

        self.sps_text_item.setText(f"SPS: {int(sps)} / PT")

        # Update per-connector: under-graph display value and debug_values for popup
        for connector_id in range(1, NUM_CONNECTORS + 1):
            display_text = "---"
            self.debug_values[connector_id] = {"current": None, "moving_avg": None, "psi": None}
            d = self.sensor_data.get(connector_id)
            if d and len(d) > 0:
                # Only access last N elements — NOT the whole 200k deque
                n_samples = min(self.display_moving_avg_samples, len(d))
                # Iterate only the tail of the deque (O(n_samples) not O(len(d)))
                tail_values = [d[-1 - j][1] for j in range(n_samples)]
                current = d[-1][1]
                moving_avg = sum(tail_values) / n_samples
                self.debug_values[connector_id]["current"] = current
                self.debug_values[connector_id]["moving_avg"] = moving_avg
                psi_val = None
                adc_d = self.sensor_adc_codes.get(connector_id)
                if connector_id in self.pt_calibration and adc_d and len(adc_d) > 0:
                    n_adc = min(self.display_moving_avg_samples, len(adc_d))
                    adc_tail = [adc_d[-1 - j][1] for j in range(n_adc)]
                    moving_avg_adc = sum(adc_tail) / n_adc
                    a, b, c, dd = self.pt_calibration[connector_id]
                    psi_val = calculate_pressure(moving_avg_adc, a, b, c, dd)
                    self.debug_values[connector_id]["psi"] = psi_val
                    display_text = f"<span style='font-size:16pt; font-weight:600'>{psi_val:.2f}</span> <span style='font-size:8pt'>psi</span>"
                else:
                    display_text = f"<span style='font-size:16pt; font-weight:600'>{moving_avg:.4f}</span> <span style='font-size:8pt'>V</span>"
            if connector_id in self.under_graph_labels:
                enabled = self.plot_enabled.get(connector_id, True)
                # If "only show PTs with roles" is enabled, hide PTs without names
                if enabled and self.only_show_pt_with_roles:
                    pt_label = self.sensor_labels.get(connector_id, "")
                    if not pt_label or pt_label.strip() == "":
                        enabled = False
                if connector_id in self.under_graph_containers:
                    self.under_graph_containers[connector_id].setVisible(enabled)
                if enabled:
                    self.under_graph_labels[connector_id].setText(display_text)
    
    def save_pressures_csv(self):
        """Save pressure data to CSV file, respecting only_show_pt_with_roles setting."""
        # Check if we have any pressure data
        if not self.sensor_psi_history:
            QtWidgets.QMessageBox.warning(self, "No Data", "No pressure data available to export.")
            return
        
        # Filter sensors based on settings
        sensors_to_save = []
        for sensor_id in sorted(self.sensor_psi_history.keys()):
            if self.only_show_pt_with_roles:
                # Only include sensors with roles (non-empty labels)
                label = self.sensor_labels.get(sensor_id, "")
                if label and label.strip():
                    sensors_to_save.append(sensor_id)
            else:
                # Include all sensors with pressure data
                sensors_to_save.append(sensor_id)
        
        if not sensors_to_save:
            QtWidgets.QMessageBox.warning(self, "No Data", "No sensors with roles available to export.")
            return
        
        # Generate default filename with timestamp
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        default_filename = f"pressures_{timestamp}.csv"
        
        # Open file dialog
        filename, _ = QtWidgets.QFileDialog.getSaveFileName(
            self,
            "Save Pressures CSV File",
            default_filename,
            "CSV Files (*.csv);;All Files (*)"
        )
        
        if not filename:
            return  # User cancelled
        
        try:
            with open(filename, 'w', newline='', encoding='utf-8') as csvfile:
                writer = csv.writer(csvfile)
                
                # Write header: Time (s), then sensor labels
                header = ["Time (s)"]
                for sensor_id in sensors_to_save:
                    label = self.sensor_labels.get(sensor_id, "")
                    if label:
                        header.append(f"PT{sensor_id}: {label} (psi)")
                    else:
                        header.append(f"PT{sensor_id} (psi)")
                writer.writerow(header)
                
                # Collect all data into a dictionary for O(1) lookup:
                # data_map[timestamp][sensor_id] = psi_value
                data_map = {}
                all_times = set()
                
                for sensor_id in sensors_to_save:
                    for t, psi in self.sensor_psi_history[sensor_id]:
                        if t not in data_map:
                            data_map[t] = {}
                        data_map[t][sensor_id] = psi
                        all_times.add(t)
                
                if not all_times:
                    QtWidgets.QMessageBox.warning(self, "No Data", "No timestamp data available.")
                    return
                
                # Write data row by row
                for t in sorted(all_times):
                    row = [f"{t:.6f}"]
                    row_data = data_map[t]
                    for sensor_id in sensors_to_save:
                        # Direct lookup instead of loop
                        val = row_data.get(sensor_id, "")
                        if val != "":
                            row.append(f"{val:.6f}")
                        else:
                            row.append("")
                    writer.writerow(row)
            
            QtWidgets.QMessageBox.information(self, "Success", f"Saved pressures CSV to {filename}")
        except Exception as e:
            QtWidgets.QMessageBox.critical(self, "Error", f"CSV save error: {e}")
    
    def save_events_csv(self):
        """Save events (mode button clicks and actuator state changes) to CSV file."""
        if not self.main_window_ref:
            QtWidgets.QMessageBox.warning(self, "Error", "Main window reference not available.")
            return
        
        events = self.main_window_ref.get_event_log()
        if not events:
            QtWidgets.QMessageBox.warning(self, "No Data", "No events available to export.")
            return
        
        # Generate default filename with timestamp
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        default_filename = f"events_{timestamp}.csv"
        
        # Open file dialog
        filename, _ = QtWidgets.QFileDialog.getSaveFileName(
            self,
            "Save Events CSV File",
            default_filename,
            "CSV Files (*.csv);;All Files (*)"
        )
        
        if not filename:
            return  # User cancelled
        
        try:
            with open(filename, 'w', newline='', encoding='utf-8') as csvfile:
                writer = csv.writer(csvfile)
                
                # Write header
                writer.writerow(["Time (s)", "Event Type", "Details"])
                
                # Write events
                for event_time, event_type, details in events:
                    writer.writerow([f"{event_time:.6f}", event_type, details])
            
            QtWidgets.QMessageBox.information(self, "Success", f"Saved events CSV to {filename}")
        except Exception as e:
            QtWidgets.QMessageBox.critical(self, "Error", f"CSV save error: {e}")


# ---------------------- Sensor Plot Window (standalone) ----------------------
class SensorPlotWindow(QtWidgets.QMainWindow):
    """Standalone window that embeds SensorPlotWidget."""
    def __init__(self, receiver, bind_address: str = '0.0.0.0'):
        super().__init__()
        self.setWindowTitle(f"Sensor Data Receiver - Port {receiver.port}")
        self.setGeometry(100, 100, 1200, 800)
        self.setCentralWidget(SensorPlotWidget(receiver, bind_address, self))
    
    def closeEvent(self, event):
        """Handle window close event"""
        w = self.centralWidget()
        if w and hasattr(w, 'save_sensor_labels'):
            w.save_sensor_labels()
        event.accept()


# ---------------------- Actuator Control Widget (reusable panel) ----------------------
class ActuatorControlWidget(QtWidgets.QWidget):
    """Reusable actuator control panel. Used in ActuatorControlWindow and CombinedMainWindow."""
    def __init__(self, receiver, device_ip: str = None, device_port: int = None, parent=None):
        super().__init__(parent)
        self.receiver = receiver
        # Load from CONFIG (ignoring args if None, effectively preferring config)
        self.device_ip = CONFIG.config["network"]["actuator_ip"]
        self.device_port = CONFIG.config["network"]["actuator_port"]
        
        # Actuator state tracking (1-indexed: 1-10)
        # GUI state: 0 = CLOSED, 1 = OPEN
        self.actuator_states = [0] * NUM_ACTUATORS
        
        # Actuator NC/NO type mapping (1-indexed: 1-10)
        # Maps actuator ID to 'NC' or 'NO'
        self.actuator_types = {i: CONFIG.get_actuator_type_by_id(i) for i in range(1, NUM_ACTUATORS + 1)}
        
        # Reference to main window for event tracking (set by main window)
        self.main_window_ref = None
        
        # PWM control window instance (lazily created)
        self.pwm_window = None
        
        # Manual control lock: True = manual control enabled (DEBUG button), False = locked
        self.manual_control_enabled = False  # Default to False (locked) on startup
        
        # Voltage readings (0-indexed: 0-9, maps to actuator 1-10)
        # Store as voltage in Volts
        self.voltage_readings = [0.0] * NUM_ACTUATORS
        
        # Actuator labels (1-indexed: 1-10)
        self.actuator_labels = {i: CONFIG.get_actuator_label(i) for i in range(1, NUM_ACTUATORS + 1)}
        
        # Load display settings from Config
        disp = CONFIG.config["display"]
        self.only_show_actuators_with_roles = disp.get("only_show_actuators_with_roles", False)
        
        # UDP socket for sending commands
        self.command_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        
        self.init_ui()
        
        # Connect to receiver signals
        self.receiver.sensor_data_received.connect(self.on_sensor_data)
        self.receiver.status_update.connect(self.on_status_update)
        
        # Timer for updating current display
        self.update_timer = QtCore.QTimer(self)
        self.update_timer.timeout.connect(self.update_current_display)
        self.update_timer.start(100)  # Update every 100ms
    
    def init_ui(self):
        """Initialize the user interface"""
        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        
        # Top panel removed - no status label needed
        
        # Main content area with actuators in a grid: 2 columns x 5 rows
        self.grid_container = QtWidgets.QWidget()
        self.grid_layout = QtWidgets.QGridLayout(self.grid_container)
        self.grid_layout.setSpacing(5)
        
        # Create actuator controls in a 2x5 grid
        self.actuator_widgets = []
        for i in range(NUM_ACTUATORS):
            actuator_id = i + 1  # 1-indexed
            
            # Calculate grid position: 2 columns, 5 rows
            row = i // 2  # 0-4
            col = i % 2   # 0 or 1
            
            # Create widget for each actuator
            actuator_frame = QtWidgets.QFrame()
            actuator_frame.setFrameShape(QtWidgets.QFrame.Shape.Box)
            actuator_frame.setFrameShadow(QtWidgets.QFrame.Shadow.Raised)
            actuator_frame.setStyleSheet("padding: 2px 4px 4px 4px; margin: 1px; background-color: #353535;")
            
            actuator_layout = QtWidgets.QVBoxLayout(actuator_frame)
            actuator_layout.setContentsMargins(0, 0, 0, 0)
            actuator_layout.setSpacing(1)
            
            # Actuator ID label
            # If label exists, show label. Else show "Actuator {id}"
            label_text = self.actuator_labels.get(actuator_id, "") or f"Actuator {actuator_id}"
            id_label = QtWidgets.QLabel(label_text)
            id_label.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
            id_label.setMinimumHeight(20)
            id_label.setStyleSheet("font-weight: bold; font-size: 10pt; padding: 1px 2px; color: white; background-color: transparent;")
            actuator_layout.addWidget(id_label)
            
            # Button container
            button_container = QtWidgets.QHBoxLayout()
            button_container.setSpacing(3)
            
            # OPEN button
            on_btn = QtWidgets.QPushButton("OPEN")
            on_btn.setMinimumHeight(30)
            bg_color = self.palette().color(QtGui.QPalette.ColorRole.Window).name()
            on_btn.setStyleSheet(f"""
                QPushButton {{
                    font-size: 10pt;
                    font-weight: bold;
                    background-color: {bg_color};
                    color: #FFFFFF;
                    border: 2px solid {bg_color};
                    border-radius: 4px;
                    padding: 2px;
                }}
            """)
            on_btn.clicked.connect(lambda checked=False, aid=actuator_id: self.set_actuator_state(aid, 1))
            
            # CLOSED button
            off_btn = QtWidgets.QPushButton("CLOSED")
            off_btn.setMinimumHeight(30)
            off_btn.setStyleSheet(f"""
                QPushButton {{
                    font-size: 10pt;
                    font-weight: bold;
                    background-color: {bg_color};
                    color: #FFFFFF;
                    border: 2px solid {bg_color};
                    border-radius: 4px;
                    padding: 2px;
                }}
            """)
            off_btn.clicked.connect(lambda checked=False, aid=actuator_id: self.set_actuator_state(aid, 0))
            
            button_container.addWidget(on_btn)
            button_container.addWidget(off_btn)
            actuator_layout.addLayout(button_container)
            
            # Voltage reading label
            voltage_label = QtWidgets.QLabel("0.000 V")
            voltage_label.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
            voltage_label.setWordWrap(True)
            voltage_label.setMinimumHeight(12)
            voltage_label.setStyleSheet("font-size: 7pt; padding: 0px 2px; color: white; background-color: transparent;")
            actuator_layout.addWidget(voltage_label)
            
            # Add to grid
            self.grid_layout.addWidget(actuator_frame, row, col)
            
            # Store widget references
            self.actuator_widgets.append({
                'frame': actuator_frame,
                'on_btn': on_btn,
                'off_btn': off_btn,
                'voltage_label': voltage_label,
                'id_label': id_label
            })
        
        layout.addWidget(self.grid_container, 1)
        
        # PWM Control Button
        self.pwm_btn = QtWidgets.QPushButton("PWM CONTROL")
        self.pwm_btn.setMinimumHeight(40)
        self.pwm_btn.setStyleSheet("""
            QPushButton {
                font-size: 10pt;
                font-weight: bold;
                background-color: #505050;
                color: #ffffff;
                border: 2px solid #404040;
                border-radius: 4px;
                padding: 4px 8px;
                margin-top: 5px;
            }
            QPushButton:hover {
                background-color: #606060;
                border-color: #505050;
            }
            QPushButton:pressed {
                background-color: #404040;
                border-color: #303030;
            }
        """)
        self.pwm_btn.clicked.connect(self.open_pwm_control)
        layout.addWidget(self.pwm_btn)

        # Initialize actuators based on NC/NO type
        # NO actuators start OPEN (GUI state 1, hardware command 0)
        # NC actuators start CLOSED (GUI state 0, hardware command 0)
        # Note: We only set UI state during initialization, no hardware commands are sent
        for actuator_id in range(1, NUM_ACTUATORS + 1):
            actuator_type = self.actuator_types.get(actuator_id, 'NC')
            array_idx = actuator_id - 1
            if actuator_type == 'NO':
                # NO actuators start OPEN (GUI state 1, hardware command 0)
                self.actuator_states[array_idx] = 1
                self.update_button_highlight(array_idx, 1)
                # Don't send hardware command during initialization
            else:
                # NC actuators start CLOSED (GUI state 0, hardware command 0)
                self.actuator_states[array_idx] = 0
                self.update_button_highlight(array_idx, 0)
                # Hardware command already 0, no need to send
        
        # Apply initial visibility based on setting
        self.update_actuator_visibility()

    def open_pwm_control(self):
        """Open the PWM control window, creating it lazily."""
        # Use main window's PWM window if available, otherwise create our own
        if self.main_window_ref and hasattr(self.main_window_ref, 'open_pwm_control'):
            self.main_window_ref.open_pwm_control()
            return

        # Fallback: create/show our own PWM window
        if self.pwm_window is None:
            self.pwm_window = PWMControlWindow(self.main_window_ref or self)
        self.pwm_window.show()
        self.pwm_window.raise_()
        self.pwm_window.activateWindow()

    def update_label_display(self, actuator_id, text):
        """External method to update label display when changed in settings"""
        idx = actuator_id - 1
        if 0 <= idx < len(self.actuator_widgets):
             new_text = text or f"Actuator {actuator_id}"
             self.actuator_widgets[idx]['id_label'].setText(new_text)

    def on_label_changed(self, actuator_id: int, text: str):
        """Update local actuator label and display (config is written via set_actuator_role in settings)."""
        self.actuator_labels[actuator_id] = text
        self.update_label_display(actuator_id, text)
        # Update visibility if filtering is enabled
        if self.only_show_actuators_with_roles:
            self.update_actuator_visibility()
    
    def update_actuator_visibility(self):
        """Update visibility of actuator widgets based on whether they have roles.
        When filtering is enabled, reflow visible actuators in order: row1 vents, row2 press, row3 mains; col1 fuel, col2 lox."""
        if self.only_show_actuators_with_roles:
            # Remove all widgets from grid
            for i in range(NUM_ACTUATORS):
                widget = self.actuator_widgets[i]
                self.grid_layout.removeWidget(widget['frame'])
            
            # Collect visible actuators from all assigned roles in config
            visible_widgets = []
            for role_name in CONFIG.get_actuator_role_names():
                actuator_id = CONFIG.get_actuator_role(role_name)
                if actuator_id and actuator_id > 0:
                    array_idx = actuator_id - 1
                    if 0 <= array_idx < len(self.actuator_widgets):
                        widget = self.actuator_widgets[array_idx]
                        visible_widgets.append(widget)
                        widget['frame'].setVisible(True)
            # Hide any actuator not in the ordered list
            for i in range(NUM_ACTUATORS):
                widget = self.actuator_widgets[i]
                if widget not in visible_widgets:
                    widget['frame'].setVisible(False)
            
            # Re-add visible widgets in 2-column layout (col 0 = fuel, col 1 = lox)
            for idx, widget in enumerate(visible_widgets):
                row = idx // 2
                col = idx % 2
                self.grid_layout.addWidget(widget['frame'], row, col)
        else:
            # Show all actuators in their original positions
            for i in range(NUM_ACTUATORS):
                actuator_id = i + 1
                widget = self.actuator_widgets[i]
                widget['frame'].setVisible(True)
            
            # Restore original grid positions
            for i in range(NUM_ACTUATORS):
                widget = self.actuator_widgets[i]
                self.grid_layout.removeWidget(widget['frame'])
                row = i // 2
                col = i % 2
                self.grid_layout.addWidget(widget['frame'], row, col)
    
    def on_status_update(self, message: str):
        """Handle status updates from receiver thread"""
        pass
    
    def on_sensor_data(self, header: dict, chunks: List[dict], source_ip: str):
        """Handle received sensor data (voltage readings)"""
        if chunks:
            latest_chunk = chunks[-1]
            for dp in latest_chunk['datapoints']:
                sensor_id = dp['sensor_id']  # 1-indexed (1-10)
                code_uint32 = dp['data']  # Received as uint32_t from protocol
                
                if code_uint32 >= 0x80000000:
                    code_int32 = code_uint32 - 0x100000000
                else:
                    code_int32 = code_uint32
                
                voltage = (code_int32 * 2.5) / 2147483648.0
                array_idx = sensor_id - 1
                if 0 <= array_idx < NUM_ACTUATORS:
                    self.voltage_readings[array_idx] = voltage
    
    def update_button_highlight(self, array_idx: int, actuator_state: int):
        """Update button highlighting based on actuator state. Selected OPEN = saturated green, selected CLOSED = saturated red."""
        widget = self.actuator_widgets[array_idx]
        bg_color = widget['frame'].palette().color(QtGui.QPalette.ColorRole.Window).name()
        # Same 2px border as active state so text doesn't shift when toggling
        inactive_style = f"""
            QPushButton {{
                font-size: 10pt;
                font-weight: bold;
                background-color: {bg_color};
                color: #FFFFFF;
                border: 2px solid {bg_color};
                border-radius: 4px;
                padding: 2px;
            }}
        """
        # Saturated green box for selected OPEN, saturated red box for selected CLOSED (only when selected)
        active_open_style = """
            QPushButton {
                font-size: 10pt;
                font-weight: bold;
                background-color: #008800;
                color: #ffffff;
                border: 2px solid #008800;
                border-radius: 4px;
                padding: 2px;
            }
        """
        active_closed_style = """
            QPushButton {
                font-size: 10pt;
                font-weight: bold;
                background-color: #dc143c;
                color: #ffffff;
                border: 2px solid #dc143c;
                border-radius: 4px;
                padding: 2px;
            }
        """
        if actuator_state == 1:
            widget['on_btn'].setStyleSheet(active_open_style)
            widget['off_btn'].setStyleSheet(inactive_style)
        else:
            widget['on_btn'].setStyleSheet(inactive_style)
            widget['off_btn'].setStyleSheet(active_closed_style)
    
    def set_actuator_state(self, actuator_id: int, gui_state: int, force: bool = False):
        """
        Set actuator state and send command packet.
        gui_state: 0 = CLOSED, 1 = OPEN (from GUI button)
        force: If True, bypass manual control lock (used by state machine)
        Converts to hardware command based on NC/NO type:
        - NC: OPEN (1) -> hardware ON (1), CLOSED (0) -> hardware OFF (0)
        - NO: OPEN (1) -> hardware OFF (0), CLOSED (0) -> hardware ON (1)
        """
        # If manual control is locked and this is a manual click (not forced), do nothing
        if not self.manual_control_enabled and not force:
            return
        
        array_idx = actuator_id - 1
        old_state = self.actuator_states[array_idx]
        self.actuator_states[array_idx] = gui_state
        
        # Convert GUI state to hardware command based on NC/NO type
        actuator_type = self.actuator_types.get(actuator_id, 'NC')
        if actuator_type == 'NO':
            # NO: OPEN (1) -> hardware OFF (0), CLOSED (0) -> hardware ON (1)
            hardware_command = 0 if gui_state == 1 else 1
        else:
            # NC: OPEN (1) -> hardware ON (1), CLOSED (0) -> hardware OFF (0)
            hardware_command = gui_state
        
        self.update_button_highlight(array_idx, gui_state)
        self.send_actuator_command(actuator_id, hardware_command)
        
        # Log actuator state change event
        if self.main_window_ref and old_state != gui_state:
            label = self.actuator_labels.get(actuator_id, "")
            if label:
                details = f"Actuator {actuator_id} ({label}): {'OPEN' if gui_state else 'CLOSED'}"
            else:
                details = f"Actuator {actuator_id}: {'OPEN' if gui_state else 'CLOSED'}"
            self.main_window_ref.log_event("Actuator State Change", details)
    
    def send_actuator_command(self, actuator_id: int, hardware_command: int):
        """
        Send an actuator command packet to the device.
        hardware_command: 0 = OFF, 1 = ON (hardware level)
        """
        try:
            commands = [(actuator_id, hardware_command)]
            packet = create_actuator_command_packet(commands)
            if len(packet) > 0:
                self.command_sock.sendto(packet, (self.device_ip, self.device_port))
                # Get GUI state for logging
                array_idx = actuator_id - 1
                gui_state = self.actuator_states[array_idx]
                print(f"Sent command: Actuator {actuator_id} -> {'OPEN' if gui_state else 'CLOSED'} (hardware: {'ON' if hardware_command else 'OFF'})")
            else:
                print(f"Error: Failed to create packet for actuator {actuator_id}")
        except OSError as e:
            err = e.errno
            if err == 65:
                msg = f"No route to host — check device IP ({self.device_ip})"
            elif err == 64:
                msg = f"Network unreachable — check WiFi/Ethernet"
            else:
                msg = f"Network error: [{err}] {e}"
            print(f"Error sending command: {e}")
        except Exception as e:
            print(f"Error sending command: {e}")
    
    def update_current_display(self):
        """Update the voltage reading display for all actuators"""
        for i in range(NUM_ACTUATORS):
            voltage = self.voltage_readings[i]
            widget = self.actuator_widgets[i]
            widget['voltage_label'].setText(f"{voltage:.3f} V")
    
    def close_socket(self):
        """Close the command socket"""
        if self.command_sock:
            try:
                self.command_sock.close()
            except:
                pass
    



# ---------------------- PWM Control Window ----------------------
class PWMControlWindow(QtWidgets.QWidget):
    """
    Dedicated window for detailed actuator control (PWM).
    Allows setting frequency, duty cycle, duration, and arming commands for the next state transition.
    """
    def __init__(self, parent_window):
        super().__init__()
        self.setWindowTitle("Actuator PWM Control")
        self.resize(900, 700)
        self.parent_window = parent_window  # Reference to CombinedMainWindow
        
        # Track armed commands: actuator_id -> (duration_ms, duty, freq)
        self.active_arms = {} 
        
        self.init_ui()
        
    def init_ui(self):
        main_layout = QtWidgets.QVBoxLayout(self)
        
        # Header
        header = QtWidgets.QLabel("Actuator PWM Configuration")
        header.setStyleSheet("font-size: 16pt; font-weight: bold; margin-bottom: 10px;")
        main_layout.addWidget(header)
        
        # Scroll area for actuator list
        scroll = QtWidgets.QScrollArea()
        scroll.setWidgetResizable(True)
        scroll_content = QtWidgets.QWidget()
        self.scroll_layout = QtWidgets.QVBoxLayout(scroll_content)
        
        self.actuator_rows = {}  # id -> widgets dict
        
        # Create a row for each actuator
        for i in range(NUM_ACTUATORS):
            actuator_id = i + 1
            row_widget = QtWidgets.QGroupBox(f"Actuator {actuator_id}")
            row_layout = QtWidgets.QHBoxLayout(row_widget)
            
            # Label (Role)
            role = CONFIG.get_actuator_label(actuator_id)
            label = QtWidgets.QLabel(f"{role}" if role else "Unassigned")
            label.setMinimumWidth(120)
            label.setStyleSheet("font-weight: bold;")
            row_layout.addWidget(label)
            
            # Parameters
            # Duty Cycle
            row_layout.addWidget(QtWidgets.QLabel("Duty %:"))
            duty_spin = QtWidgets.QDoubleSpinBox()
            duty_spin.setRange(0, 100)
            duty_spin.setValue(50.0)
            duty_spin.setSuffix("%")
            row_layout.addWidget(duty_spin)
            
            # Rate/Freq
            row_layout.addWidget(QtWidgets.QLabel("Freq (Hz):"))
            freq_spin = QtWidgets.QDoubleSpinBox()
            freq_spin.setRange(0.1, 1000000.0) # Match extended range from previous task
            freq_spin.setValue(10.0)
            freq_spin.setDecimals(1)
            row_layout.addWidget(freq_spin)
            
            # Duration
            row_layout.addWidget(QtWidgets.QLabel("Dur (s):"))
            dur_spin = QtWidgets.QDoubleSpinBox()
            dur_spin.setRange(0.0, 3600.0)
            dur_spin.setValue(1.0)
            dur_spin.setDecimals(2)
            row_layout.addWidget(dur_spin)
            
            # Actions
            btn_exec = QtWidgets.QPushButton("Execute Now")
            btn_exec.setStyleSheet("background-color: #2ecc71; color: white; font-weight: bold;")
            btn_exec.clicked.connect(lambda checked=False, aid=actuator_id: self.execute_now(aid))
            row_layout.addWidget(btn_exec)
            
            # Arm Checkbox
            chk_arm = QtWidgets.QCheckBox("Arm for Next State")
            chk_arm.setStyleSheet("margin-left: 10px;")
            chk_arm.toggled.connect(lambda checked, aid=actuator_id: self.update_arm_status(aid, checked))
            row_layout.addWidget(chk_arm)
            
            self.scroll_layout.addWidget(row_widget)
            
            self.actuator_rows[actuator_id] = {
                'duty': duty_spin,
                'freq': freq_spin,
                'dur': dur_spin,
                'arm_chk': chk_arm
            }
            
        self.scroll_layout.addStretch()
        scroll.setWidget(scroll_content)
        main_layout.addWidget(scroll)
        
        # Global Controls
        bottom_bar = QtWidgets.QHBoxLayout()
        
        self.lbl_status = QtWidgets.QLabel("Ready")
        bottom_bar.addWidget(self.lbl_status)
        
        bottom_bar.addStretch()
        
        btn_disarm_all = QtWidgets.QPushButton("Disarm All")
        btn_disarm_all.setStyleSheet("background-color: #e74c3c; color: white; padding: 5px 15px;")
        btn_disarm_all.clicked.connect(self.disarm_all)
        bottom_bar.addWidget(btn_disarm_all)
        
        btn_close = QtWidgets.QPushButton("Close")
        btn_close.clicked.connect(self.hide)
        bottom_bar.addWidget(btn_close)
        
        main_layout.addLayout(bottom_bar)

    def execute_now(self, actuator_id):
        """Send PWM command immediately."""
        widgets = self.actuator_rows[actuator_id]
        duty = widgets['duty'].value() / 100.0
        freq = widgets['freq'].value()
        dur_s = widgets['dur'].value()
        dur_ms = int(dur_s * 1000)
        
        # Commands: list of (id, dur_ms, duty, freq)
        commands = [(actuator_id, dur_ms, duty, freq)]
        packet = create_pwm_actuator_command_packet(commands)
        
        if self.parent_window and self.parent_window.actuator_widget:
            try:
                sock = self.parent_window.actuator_widget.command_sock
                if sock:
                    ip = self.parent_window.actuator_widget.device_ip
                    port = self.parent_window.actuator_widget.device_port
                    sock.sendto(packet, (ip, port))
                    self.lbl_status.setText(f"Executed PWM on Actuator {actuator_id}")
                    print(f"Manual PWM: ID={actuator_id} F={freq}Hz D={duty*100}% T={dur_s}s")
            except Exception as e:
                self.lbl_status.setText(f"Error: {e}")
                
    def update_arm_status(self, actuator_id, checked):
        """Update the armed status dict based on checkbox."""
        if checked:
            widgets = self.actuator_rows[actuator_id]
            duty = widgets['duty'].value() / 100.0
            freq = widgets['freq'].value()
            dur_s = widgets['dur'].value()
            dur_ms = int(dur_s * 1000)
            
            self.active_arms[actuator_id] = (dur_ms, duty, freq)
            self.lbl_status.setText(f"Armed Actuator {actuator_id} for next state")
        else:
            if actuator_id in self.active_arms:
                del self.active_arms[actuator_id]
                self.lbl_status.setText(f"Disarmed Actuator {actuator_id}")
                
    def disarm_all(self):
        """Uncheck all arm checkboxes."""
        for aid, widgets in self.actuator_rows.items():
            widgets['arm_chk'].setChecked(False) # This triggers update_arm_status via signal
        self.active_arms.clear()
        self.lbl_status.setText("All actuators disarmed")

    def get_armed_commands(self) -> List[Tuple[int, int, float, float]]:
        """Return list of armed commands to be sent on state transition.
        Also clears the arms (consumes them) if that's the desired behavior. 
        Re-reading user requirement: 'wait till the next state begins'. 
        Usually one-shot. Let's consume them (uncheck boxes) after retrieving."""
        commands = []
        for aid, (dur, duty, freq) in self.active_arms.items():
            commands.append((aid, dur, duty, freq))
        return commands
        
    def consume_arms(self):
        """Clear all arms after execution (update UI)."""
        # Block signals to prevent recursion loops or unnecessary updates if we want to keep them checks?
        # Usually 'arm for next state' implies one-shot. Let's uncheck them.
        for aid in list(self.active_arms.keys()):
            # We used list(keys) because toggling checkbox modifies the dict
            self.actuator_rows[aid]['arm_chk'].setChecked(False) 

class PressureBarWidget(QtWidgets.QWidget):
    """
    Vertical bar gauge: four dashed lines at 20%, 40%, 60%, 80% of bar height (global Y from parent).
    Labels:
    y80=POP, y60=MEOP, y40=NOP, y20=THRESH. Bar outline and fill are full height; fill is linear in pressure.
    """
    TOP_MARGIN = 20
    BOTTOM_GAP = 8       # space between bar and value box
    VALUE_BOX_HEIGHT = 26
    BOTTOM_CLEARANCE = 4
    BOTTOM_MARGIN = BOTTOM_GAP + VALUE_BOX_HEIGHT + BOTTOM_CLEARANCE  # total bottom region (parent uses for bar extent)

    def __init__(self, title: str, nop: float = 500.0, meop: float = 700.0, pop: float = 1000.0, thresh: float = None, fixed_color: QtGui.QColor = None, parent=None):
        super().__init__(parent)
        self.title = title
        self.nop = nop
        self.meop = meop
        self.pop = pop
        self.thresh = thresh if thresh is not None else (nop * 0.5)
        self.scale_max = 1.25 * pop  # shared across bars
        self.fixed_color = fixed_color
        self.current_value = 0.0
        # Global line Y positions in parent coordinates (set by TopBarWidget); None until set
        self._line_y20_parent = None
        self._line_y40_parent = None
        self._line_y60_parent = None
        self._line_y80_parent = None
        self.setMinimumWidth(79)
        self.setMaximumWidth(83)
        self.setMinimumHeight(100)
        self.setSizePolicy(QtWidgets.QSizePolicy.Policy.Fixed, QtWidgets.QSizePolicy.Policy.Expanding)

    def set_global_line_ys(self, y20: float, y40: float, y60: float, y80: float):
        """Set the four dashed-line Y positions in parent coordinates (same for all three bars)."""
        self._line_y20_parent = y20
        self._line_y40_parent = y40
        self._line_y60_parent = y60
        self._line_y80_parent = y80
        self.update()

    def set_limits(self, nop: float, meop: float, pop: float, thresh: float = None, scale_max: float = None):
        """Update NOP, MEOP, POP, THRESH and optional shared scale_max; repaint."""
        self.nop = nop
        self.meop = meop
        self.pop = pop
        if thresh is not None:
            self.thresh = thresh
        if scale_max is not None:
            self.scale_max = scale_max
        self.update()
        
    def set_value(self, value: float):
        self.current_value = value
        self.update()  # Trigger repaint

    def paintEvent(self, event):
        painter = QtGui.QPainter(self)
        painter.setRenderHint(QtGui.QPainter.RenderHint.Antialiasing)
        
        # Geometry: bar on the left, label column on the right
        w = self.width()
        h = self.height()
        top_margin = self.TOP_MARGIN
        bottom_margin = self.BOTTOM_MARGIN
        left_margin = 5
        label_width = 32
        gap = 2
        bar_w = w - left_margin - gap - label_width
        bar_w = max(40, bar_w)
        draw_w = max(28, int(bar_w * 0.85))  # bar width (slightly thinner than full slot)
        bar_x = left_margin + (bar_w - draw_w) // 2  # center the bar
        bar_h = h - top_margin - bottom_margin
        bar_y = top_margin
        bar_bottom_y = bar_y + bar_h
        label_x = bar_x + draw_w + 4  # just to the right of the bar

        # Draw Title centered above the bar
        painter.setPen(QtCore.Qt.GlobalColor.white)
        painter.drawText(QtCore.QRect(bar_x, 0, draw_w, top_margin), QtCore.Qt.AlignmentFlag.AlignCenter, self.title)

        # Bar outline: full height
        scale_max = max(self.scale_max, 1.0)
        painter.setPen(QtCore.Qt.GlobalColor.gray)
        painter.setBrush(QtGui.QColor(50, 50, 50))
        painter.drawRect(bar_x, bar_y, draw_w, bar_h)

        # Fill height: piecewise mapping so fill aligns with reference lines (y20=THRESH, y40=NOP, y60=MEOP, y80=POP)
        # 0..THRESH -> 0..20%, THRESH..NOP -> 20..40%, NOP..MEOP -> 40..60%, MEOP..POP -> 60..80%, >=POP -> 80%
        v = max(0.0, self.current_value)
        thresh, nop, meop, pop = self.thresh, self.nop, self.meop, self.pop
        if v <= thresh:
            segment = (v / thresh) * 0.20 if thresh > 0 else 0.0
        elif v <= nop:
            segment = 0.20 + (v - thresh) / (nop - thresh) * 0.20 if nop > thresh else 0.20
        elif v <= meop:
            segment = 0.40 + (v - nop) / (meop - nop) * 0.20 if meop > nop else 0.40
        elif v <= pop:
            segment = 0.60 + (v - meop) / (pop - meop) * 0.20 if pop > meop else 0.60
        else:
            segment = 0.80  # cap at 80% (top reference line)
        fill_ratio = min(max(segment, 0.0), 1.0)
        fill_h = int(fill_ratio * bar_h)
        fill_y = bar_bottom_y - fill_h

        # Color based on value (vibrant pastels when no fixed_color)
        if self.fixed_color:
            painter.setBrush(self.fixed_color)
        else:
            if self.current_value > self.meop:
                painter.setBrush(QtGui.QColor("#ff7675"))   # vibrant pastel red
            elif self.current_value > self.nop:
                painter.setBrush(QtGui.QColor("#fdcb6e"))   # vibrant pastel amber
            else:
                painter.setBrush(QtGui.QColor("#27ae60"))   # jungle green (darker for white text)

        painter.setPen(QtCore.Qt.PenStyle.NoPen)
        painter.drawRect(bar_x, fill_y, draw_w, fill_h)

        # Global line Y positions: convert from parent coords to local
        my_y_in_parent = self.geometry().y()
        def to_local(parent_y):
            return int(parent_y - my_y_in_parent) if parent_y is not None else None
        ly20 = to_local(self._line_y20_parent)
        ly40 = to_local(self._line_y40_parent)
        ly60 = to_local(self._line_y60_parent)
        ly80 = to_local(self._line_y80_parent)

        # Fallback if parent has not set global lines yet: compute from this bar's rect
        if ly20 is None:
            bar_height = bar_bottom_y - bar_y
            ly20 = bar_bottom_y - int(0.20 * bar_height)
            ly40 = bar_bottom_y - int(0.40 * bar_height)
            ly60 = bar_bottom_y - int(0.60 * bar_height)
            ly80 = bar_bottom_y - int(0.80 * bar_height)

        # Draw four dashed lines at 20%, 40%, 60%, 80% (same pixel y). THRESH/NOP white, MEOP orange, POP red.
        white_dash = QtGui.QPen(QtCore.Qt.GlobalColor.white, 1, QtCore.Qt.PenStyle.DashLine)
        orange_dash = QtGui.QPen(QtGui.QColor("#ff9f43"), 1, QtCore.Qt.PenStyle.DashLine)
        red_dash = QtGui.QPen(QtGui.QColor("#ff4444"), 1, QtCore.Qt.PenStyle.DashLine)
        for ly in (ly20, ly40):
            painter.setPen(white_dash)
            painter.drawLine(bar_x, ly, bar_x + draw_w, ly)
        painter.setPen(orange_dash)
        painter.drawLine(bar_x, ly60, bar_x + draw_w, ly60)
        painter.setPen(red_dash)
        painter.drawLine(bar_x, ly80, bar_x + draw_w, ly80)

        # Labels: y80=POP, y60=MEOP, y40=NOP, y20=THRESH (PSI values, positions fixed by line)
        label_font = painter.font()
        label_font.setPointSize(7)
        painter.setFont(label_font)
        painter.setPen(QtCore.Qt.GlobalColor.white)
        line_height = 12
        for ly, limit_val in [
            (ly80, self.pop),
            (ly60, self.meop),
            (ly40, self.nop),
            (ly20, self.thresh),
        ]:
            label_y = ly - line_height // 2
            label_rect = QtCore.QRect(label_x, label_y, label_width, line_height)
            painter.drawText(label_rect, QtCore.Qt.AlignmentFlag.AlignLeft | QtCore.Qt.AlignmentFlag.AlignVCenter, f"{int(limit_val)}")

        # Value box under the bar (with gap above): filled rounded rect in bar color, then text
        value_box_y = bar_bottom_y + self.BOTTOM_GAP
        val_rect = QtCore.QRect(bar_x, value_box_y, draw_w, self.VALUE_BOX_HEIGHT)
        box_color = self.fixed_color if self.fixed_color else (
            QtGui.QColor("#ff7675") if self.current_value > self.meop else
            QtGui.QColor("#fdcb6e") if self.current_value > self.nop else
            QtGui.QColor("#27ae60")
        )
        painter.setPen(QtGui.QPen(box_color, 2))
        painter.setBrush(box_color)
        radius = 4
        painter.drawRoundedRect(val_rect, radius, radius)
        # Draw value text on top (larger, bold, white)
        val_font = painter.font()
        val_font.setPointSize(val_font.pointSize() + 2)
        val_font.setWeight(QtGui.QFont.Weight.Bold)
        painter.setFont(val_font)
        painter.setPen(QtCore.Qt.GlobalColor.white)
        val_str = f"{self.current_value:.0f}"
        painter.drawText(val_rect, QtCore.Qt.AlignmentFlag.AlignCenter, val_str)


class TopBarWidget(QtWidgets.QWidget):
    navigation_requested = QtCore.pyqtSignal(str)  # "dashboard" or "settings"
    mode_changed = QtCore.pyqtSignal(str)  # Mode name string
    debug_toggled = QtCore.pyqtSignal(bool)  # DEBUG mode enabled/disabled

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedHeight(150)
        layout = QtWidgets.QHBoxLayout(self)
        layout.setContentsMargins(10, 5, 10, 5)
        layout.setSpacing(0)
        
        # Pressure Bars: bottom=0, shared scale_max so THRESH/NOP/MEOP/POP align across bars
        pl = CONFIG.config.get("pressure_limits", {})
        def limits(fluid: str):
            d = pl.get(fluid, {})
            return (float(d.get("NOP", 600)), float(d.get("MEOP", 650)), float(d.get("POP", 750)), float(d.get("THRESH", 400)))
        nop_gn2, meop_gn2, pop_gn2, thresh_gn2 = limits("GN2")
        nop_eth, meop_eth, pop_eth, thresh_eth = limits("ETH")
        nop_lox, meop_lox, pop_lox, thresh_lox = limits("LOX")
        scale_max = max(1.25 * pop_gn2, 1.25 * pop_eth, 1.25 * pop_lox, 1.0)
        # Vibrant pastel bar colors (match app's stylized pastel palette)
        self.bar_gn2 = PressureBarWidget("GN2", nop_gn2, meop_gn2, pop_gn2, thresh=thresh_gn2, fixed_color=QtGui.QColor("#27ae60"))   # jungle green (darker for white text)
        self.bar_eth = PressureBarWidget("ETH", nop_eth, meop_eth, pop_eth, thresh=thresh_eth, fixed_color=QtGui.QColor("#ff9f43"))   # vibrant pastel orange (fuel)
        self.bar_lox = PressureBarWidget("LOX", nop_lox, meop_lox, pop_lox, thresh=thresh_lox, fixed_color=QtGui.QColor("#74b9ff"))   # vibrant pastel blue
        for bar in (self.bar_gn2, self.bar_eth, self.bar_lox):
            bar.scale_max = scale_max

        layout.addWidget(self.bar_gn2, 0)
        layout.addWidget(self.bar_eth, 0)
        layout.addWidget(self.bar_lox, 0)

        # Compute global dashed-line Y positions once from first bar's rect (same pixel y for all three)
        self._update_global_line_ys()
        
        # Add stretch before mode buttons to center them
        layout.addStretch()
        
        # Mode Selection Buttons (radio button group) - 2 rows
        mode_button_container = QtWidgets.QVBoxLayout()
        mode_button_container.setSpacing(5)
        
        # Create two horizontal rows
        row1_layout = QtWidgets.QHBoxLayout()
        row1_layout.setSpacing(5)
        row2_layout = QtWidgets.QHBoxLayout()
        row2_layout.setSpacing(5)
        
        # Button group to ensure only one button is selected at a time
        self.mode_button_group = QtWidgets.QButtonGroup(self)
        self.mode_button_group.setExclusive(True)
        
        # List of button labels (same order as CSV header, minus Abort and Debug)
        # CSV: Idle, Armed, Fuel Fill, Ox Fill, Quick Fire, GN2 Press, Fuel Press, Fuel Vent, Ox Press, Ox Vent, High Press, GN2 Vent, Fire, Vent, Abort
        # Abort is handled by the dedicated yellow ABORT button on the right.
        # Debug is handled by the DEBUG button (unlocks states and manual control)
        mode_labels = ["Idle", "Armed", "Fuel Fill", "Ox Fill", "Quick Fire", "GN2 Press", "Fuel Press", "Fuel Vent", "Ox Press", "Ox Vent", "High Press", "GN2 Vent", "Fire", "Vent"]
        self.mode_buttons = []
        
        # Load state transitions
        self.state_transitions = load_state_transitions_csv(CONFIG.get_state_transitions_csv_path())
        self.current_state = None  # Track current state for transition validation (None = no state selected)
        self.unlock_states = False  # Track whether state transitions are unlocked (via DEBUG button)
        
        # Quick Fire → GN2 Press: after 3s in Quick Fire, auto-transition to GN2 Press
        self.quick_fire_to_gn2_timer = QtCore.QTimer(self)
        self.quick_fire_to_gn2_timer.setSingleShot(True)
        self.quick_fire_to_gn2_timer.timeout.connect(self._on_quick_fire_3s_elapsed)
        # Abort → Vent, then after 5s auto-transition to Abort
        self.abort_vent_to_abort_timer = QtCore.QTimer(self)
        self.abort_vent_to_abort_timer.setSingleShot(True)
        self.abort_vent_to_abort_timer.timeout.connect(self._on_abort_vent_5s_elapsed)
        
        # Helper function to get button color based on state name
        def get_state_color(state_name: str) -> str:
            """Return pastel background color for state button"""
            state_lower = state_name.lower()
            if "vent" in state_lower:
                return "#c5b0d8"  # Pastel purple
            elif "fire" in state_lower or state_lower == "quick fire":
                return "#ffc0c5"  # Pastel red
            elif "fill" in state_lower:
                return "#ffe5cc"  # Pastel orange
            elif "press" in state_lower:
                return "#c5e0ff"  # Pastel blue
            elif state_lower == "armed":
                return "#ffffcc"  # Pastel yellow
            else:  # Idle - keep default gray
                return "#e0e0e0"  # Light gray
        
        self.get_state_color = get_state_color
        
        # Vivid/saturated colors for SELECTED state (super obvious which is current)
        def get_state_selected_color(state_name: str) -> str:
            """Return vivid, saturated color for selected state button."""
            state_lower = state_name.lower()
            if "vent" in state_lower:
                return "#9932cc"  # Vivid purple
            elif "fire" in state_lower or state_lower == "quick fire":
                return "#dc143c"  # Vivid red (crimson)
            elif "fill" in state_lower:
                return "#ff8c00"  # Vivid orange
            elif "press" in state_lower:
                return "#0066cc"  # Vivid blue
            elif state_lower == "armed":
                return "#ffd700"  # Vivid yellow/gold
            else:  # Idle
                return "#708090"  # Vivid gray (slate)
        
        self.get_state_selected_color = get_state_selected_color
        
        def text_color_for_bg(hex_bg: str) -> str:
            """Return #000000 or #ffffff for readable text on the given background."""
            hex_bg = hex_bg.lstrip('#')
            r = int(hex_bg[0:2], 16)
            g = int(hex_bg[2:4], 16)
            b = int(hex_bg[4:6], 16)
            # Relative luminance (perceived brightness)
            lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
            return "#ffffff" if lum < 0.6 else "#000000"
        
        self.text_color_for_bg = text_color_for_bg
        
        # Create buttons and distribute them across 2 rows
        # Note: Initial styling will be set by update_button_states() after buttons are created
        for i, label in enumerate(mode_labels):
            btn = QtWidgets.QPushButton(label)
            btn.setCheckable(True)
            # Use a lambda with default argument to capture the correct index
            btn.clicked.connect(lambda checked=False, idx=i: self.on_mode_button_clicked(idx))
            self.mode_button_group.addButton(btn, i)
            
            # Distribute buttons across 2 rows (7 in first row, 7 in second row for 14 buttons)
            if i < 7:
                row1_layout.addWidget(btn)
            else:
                row2_layout.addWidget(btn)
            
            self.mode_buttons.append(btn)
        
        # Add rows to container
        mode_button_container.addLayout(row1_layout)
        mode_button_container.addLayout(row2_layout)
        
        # On startup: no state selected, only Idle is enabled
        # Update button states for no state (None) - only Idle will be enabled
        self.update_button_states(None)
        
        layout.addLayout(mode_button_container)
        layout.addStretch()
        
        # Buttons Layout
        btn_layout = QtWidgets.QVBoxLayout()
        
        # Abort Buttons Row — solid colors, no gradients; match state-button look
        abort_row = QtWidgets.QHBoxLayout()
        self.btn_abort = QtWidgets.QPushButton("ABORT")
        self.btn_abort.setMinimumSize(100, 32)
        self.btn_abort.setStyleSheet("""
            QPushButton {
                font-size: 9pt;
                font-weight: bold;
                background-color: #e67e22;
                color: #ffffff;
                border: 2px solid #b85c0e;
                border-radius: 4px;
                padding: 4px 8px;
            }
            QPushButton:hover {
                background-color: #eb9842;
                border-color: #d35400;
            }
            QPushButton:pressed {
                background-color: #d35400;
                border-color: #b85c0e;
            }
        """)
        self.btn_abort.clicked.connect(lambda: self.abort("ABORT"))
        
        self.btn_emergency = QtWidgets.QPushButton("EMERGENCY ABORT")
        self.btn_emergency.setMinimumSize(100, 32)
        self.btn_emergency.setStyleSheet("""
            QPushButton {
                font-size: 9pt;
                font-weight: bold;
                background-color: #c0392b;
                color: #ffffff;
                border: 2px solid #922b21;
                border-radius: 4px;
                padding: 4px 8px;
            }
            QPushButton:hover {
                background-color: #e74c3c;
                border-color: #c0392b;
            }
            QPushButton:pressed {
                background-color: #a93226;
                border-color: #922b21;
            }
        """)
        self.btn_emergency.clicked.connect(lambda: self.abort("EMERGENCY ABORT"))
        
        abort_row.addWidget(self.btn_abort)
        abort_row.addWidget(self.btn_emergency)
        btn_layout.addLayout(abort_row)
        
        # SETTINGS — solid neutral button, same shape as other controls
        self.nav_btn = QtWidgets.QPushButton("SETTINGS")
        self.nav_btn.setMinimumHeight(26)
        self.nav_btn.setStyleSheet("""
            QPushButton {
                font-size: 8pt;
                font-weight: normal;
                background-color: #505050;
                color: #ffffff;
                border: 2px solid #404040;
                border-radius: 4px;
                padding: 4px 8px;
            }
            QPushButton:hover {
                background-color: #606060;
                border-color: #505050;
            }
            QPushButton:pressed {
                background-color: #404040;
                border-color: #303030;
            }
        """)
        self.nav_btn.clicked.connect(self.toggle_view)
        
        # Add buttons to layout
        bottom_row = QtWidgets.QHBoxLayout()
        bottom_row.addWidget(self.nav_btn)
        
        btn_layout.addLayout(bottom_row)
        
        # DEBUG — toggle; unchecked = neutral, checked = solid green (no gradients)
        self.debug_btn = QtWidgets.QPushButton("DEBUG")
        self.debug_btn.setMinimumHeight(26)
        self.debug_btn.setCheckable(True)
        self.debug_btn.setChecked(False)
        self.debug_btn.clicked.connect(self.on_debug_clicked)
        self.debug_btn.setStyleSheet("""
            QPushButton {
                font-size: 8pt;
                font-weight: normal;
                background-color: #505050;
                color: #ffffff;
                border: 2px solid #404040;
                border-radius: 4px;
                padding: 4px 8px;
            }
            QPushButton:hover {
                background-color: #606060;
                border-color: #505050;
            }
            QPushButton:pressed {
                background-color: #404040;
                border-color: #353535;
            }
            QPushButton:checked {
                background-color: #27ae60;
                color: #000000;
                border: 2px solid #1e8449;
            }
            QPushButton:checked:hover {
                background-color: #2ecc71;
                border-color: #27ae60;
            }
            QPushButton:checked:pressed {
                background-color: #1e8449;
                border-color: #196f3d;
            }
        """)
        btn_layout.addWidget(self.debug_btn)
        
        # Current state display (under Settings/Debug)
        self.current_state_label = QtWidgets.QLabel("CURRENT STATE: —")
        self.current_state_label.setStyleSheet("font-weight: bold; font-size: 10pt;")
        btn_layout.addWidget(self.current_state_label)
        self._update_current_state_display()
        
        layout.addLayout(btn_layout)

    def _update_global_line_ys(self):
        """Compute bar rect once from first bar; set same y20,y40,y60,y80 (parent coords) on all three bars."""
        ref = self.bar_gn2
        top_margin = PressureBarWidget.TOP_MARGIN
        bottom_margin = PressureBarWidget.BOTTOM_MARGIN
        bar_top_y = ref.geometry().y() + top_margin
        bar_bottom_y = ref.geometry().y() + ref.geometry().height() - bottom_margin
        bar_height = bar_bottom_y - bar_top_y
        y20 = bar_bottom_y - 0.20 * bar_height
        y40 = bar_bottom_y - 0.40 * bar_height
        y60 = bar_bottom_y - 0.60 * bar_height
        y80 = bar_bottom_y - 0.80 * bar_height
        for bar in (self.bar_gn2, self.bar_eth, self.bar_lox):
            bar.set_global_line_ys(y20, y40, y60, y80)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._update_global_line_ys()

    def showEvent(self, event):
        super().showEvent(event)
        self._update_global_line_ys()

    def _update_current_state_display(self):
        """Update the CURRENT STATE label to reflect self.current_state."""
        state_text = self.current_state if self.current_state is not None else "—"
        self.current_state_label.setText(f"CURRENT STATE: {state_text}")
    
    def on_debug_clicked(self):
        """Handle DEBUG button click (toggle) - unlocks states and manual actuator control"""
        checked = self.debug_btn.isChecked()
        self.unlock_states = checked
        
        # Emit signal to notify main window to update actuator control
        self.debug_toggled.emit(checked)
        
        # Update button states when debug state changes
        self.update_button_states(self.current_state)
    
    def update_button_states(self, current_state: str):
        """Update button enabled/disabled states and styles based on allowed transitions"""
        mode_labels = ["Idle", "Armed", "Fuel Fill", "Ox Fill", "Quick Fire", "GN2 Press", "Fuel Press", "Fuel Vent", "Ox Press", "Ox Vent", "High Press", "GN2 Vent", "Fire", "Vent"]
        
        # Get allowed transitions for current state
        if current_state is None:
            # No state selected: only Idle is allowed
            allowed_transitions = {"Idle": True}
            for state in mode_labels:
                if state != "Idle":
                    allowed_transitions[state] = False
        else:
            allowed_transitions = self.state_transitions.get(current_state, {})
        
        # If DEBUG/unlock is enabled, allow all transitions
        if self.unlock_states:
            allowed_transitions = {state: True for state in mode_labels}
        
        # Update each button based on whether transition is allowed
        for i, btn in enumerate(self.mode_buttons):
            if i < len(mode_labels):
                next_state = mode_labels[i]
                is_allowed = allowed_transitions.get(next_state, False)
                
                # Get color for this state
                bg_color = self.get_state_color(next_state)
                
                # Calculate hover color (slightly lighter)
                hover_color = self._lighten_color(bg_color, 20)
                
                # Enable/disable button
                btn.setEnabled(is_allowed)
                
                # Create style based on button state
                if btn.isChecked():
                    # Selected: vivid, saturated color so current state is super obvious
                    selected_bg = self.get_state_selected_color(next_state)
                    selected_text = self.text_color_for_bg(selected_bg)
                    style = f"""
                        QPushButton {{
                            font-size: 9pt;
                            font-weight: bold;
                            background-color: {selected_bg};
                            color: {selected_text};
                            border: 3px solid #000000;
                            border-radius: 5px;
                            padding: 6px 8px;
                            min-width: 80px;
                        }}
                    """
                elif is_allowed:
                    # Unselected: colored background with dark text for readability on pastel colors
                    style = f"""
                        QPushButton {{
                            font-size: 9pt;
                            font-weight: bold;
                            background-color: {bg_color};
                            color: #000000;
                            border: 2px solid #888888;
                            border-radius: 5px;
                            padding: 6px 8px;
                            min-width: 80px;
                        }}
                        QPushButton:hover {{
                            background-color: {hover_color};
                            border-color: #666666;
                        }}
                    """
                else:
                    # Disabled: actual grey color
                    style = """
                        QPushButton {
                            font-size: 9pt;
                            font-weight: bold;
                            background-color: #808080;
                            color: #666666;
                            border: 2px solid #666666;
                            border-radius: 5px;
                            padding: 6px 8px;
                            min-width: 80px;
                        }
                        QPushButton:hover {
                            background-color: #808080;
                            border-color: #666666;
                        }
                    """
                
                btn.setStyleSheet(style)
    
    def _lighten_color(self, hex_color: str, amount: int) -> str:
        """Lighten a hex color by the given amount"""
        hex_color = hex_color.lstrip('#')
        r = min(255, int(hex_color[0:2], 16) + amount)
        g = min(255, int(hex_color[2:4], 16) + amount)
        b = min(255, int(hex_color[4:6], 16) + amount)
        return f"#{r:02x}{g:02x}{b:02x}"
    
    def _darken_color(self, hex_color: str, amount: int) -> str:
        """Darken a hex color by the given amount"""
        hex_color = hex_color.lstrip('#')
        r = max(0, int(hex_color[0:2], 16) - amount)
        g = max(0, int(hex_color[2:4], 16) - amount)
        b = max(0, int(hex_color[4:6], 16) - amount)
        return f"#{r:02x}{g:02x}{b:02x}"
    
    def on_mode_button_clicked(self, idx):
        """Handle mode button click - update highlighting"""
        # Ensure the clicked button stays checked (exclusive group handles this, but be explicit)
        if 0 <= idx < len(self.mode_buttons):
            # Check if button is enabled (transition allowed) - unless DEBUG/unlock is enabled
            if not self.unlock_states and not self.mode_buttons[idx].isEnabled():
                return  # Don't allow clicking disabled buttons unless DEBUG is enabled
            
            self.mode_buttons[idx].setChecked(True)
            # Emit signal with mode name (keep in sync with mode_labels above)
            mode_labels = ["Idle", "Armed", "Fuel Fill", "Ox Fill", "Quick Fire", "GN2 Press", "Fuel Press", "Fuel Vent", "Ox Press", "Ox Vent", "High Press", "GN2 Vent", "Fire", "Vent"]
            new_state = mode_labels[idx]

            # Stop any active timers if state is changing
            if self.current_state == "Quick Fire":
                self.quick_fire_to_gn2_timer.stop()
            elif self.current_state == "Abort" and new_state == "Vent":
                # Starting release sequence from abort
                self.abort_vent_to_abort_timer.start(5000)

            self.current_state = new_state
            self._update_current_state_display()
            self.update_button_states(new_state)
            self.mode_changed.emit(new_state)
            
            # Quick Fire: start 3s timer to auto-transition to GN2 Press; otherwise cancel timer
            if new_state == "Quick Fire":
                self.quick_fire_to_gn2_timer.start(3000)
            else:
                self.quick_fire_to_gn2_timer.stop()
            self.abort_vent_to_abort_timer.stop()
        
        # Button styles are now handled by update_button_states, which is called above

    def _on_quick_fire_3s_elapsed(self):
        """After 3s in Quick Fire, auto-transition to GN2 Press."""
        if self.current_state == "Quick Fire":
            self.request_state("GN2 Press")

    def _on_abort_vent_5s_elapsed(self):
        """After 5s in Vent (from ABORT button), auto-transition to Abort."""
        self._apply_abort_state()

    def _clear_mode_button_selection(self):
        """Clear selection of all mode buttons so none appear selected (e.g. for Abort/Vent-from-abort)."""
        self.mode_button_group.setExclusive(False)
        for btn in self.mode_buttons:
            btn.setChecked(False)
        self.mode_button_group.setExclusive(True)

    def _apply_abort_state(self):
        """Set GUI and emitted state to Abort (used by EMERGENCY ABORT and by 5s Vent→Abort timer)."""
        self.quick_fire_to_gn2_timer.stop()
        self.abort_vent_to_abort_timer.stop()
        self.current_state = "Abort"
        self._update_current_state_display()
        self._clear_mode_button_selection()
        self.update_button_states("Abort")
        self.mode_changed.emit("Abort")

    def request_state(self, mode_name: str):
        """Programmatically switch to a state (e.g. for automatic pressure-based transitions). Bypasses transition check."""
        mode_labels = ["Idle", "Armed", "Fuel Fill", "Ox Fill", "Quick Fire", "GN2 Press", "Fuel Press", "Fuel Vent", "Ox Press", "Ox Vent", "High Press", "GN2 Vent", "Fire", "Vent"]
        if mode_name not in mode_labels:
            return
        idx = mode_labels.index(mode_name)
        self.mode_buttons[idx].setChecked(True)
        self.current_state = mode_name
        self._update_current_state_display()
        self.update_button_states(mode_name)
        self.mode_changed.emit(mode_name)
        # Quick Fire: start 3s timer to auto-transition to GN2 Press; otherwise cancel timer
        if mode_name == "Quick Fire":
            self.quick_fire_to_gn2_timer.stop()
            self.quick_fire_to_gn2_timer.start(3000)
        else:
            self.quick_fire_to_gn2_timer.stop()
        self.abort_vent_to_abort_timer.stop()
        
    def abort(self, abort_type: str = "ABORT"):
        """Trigger Abort state (CSV) and log the event.
        ABORT: go to Vent first, then after 5s automatically go to Abort.
        EMERGENCY ABORT: go to Abort immediately, no matter what state or mode (including DEBUG).
        """
        print(f"{abort_type} TRIGGERED")
        parent = self.parent()
        if abort_type == "EMERGENCY ABORT":
            # Always go to Abort immediately, regardless of state/mode/DEBUG
            self._apply_abort_state()
            if parent and hasattr(parent, 'log_event'):
                parent.log_event("Abort", f"{abort_type} button pressed")
            return
        if abort_type == "ABORT":
            # Go to Vent first; after 5s _on_abort_vent_5s_elapsed will transition to Abort
            self.quick_fire_to_gn2_timer.stop()
            self.abort_vent_to_abort_timer.stop()
            self.current_state = "Vent"
            self._update_current_state_display()
            self._clear_mode_button_selection()
            self.update_button_states("Vent")
            self.mode_changed.emit("Vent")
            self.abort_vent_to_abort_timer.start(5000)
        if parent and hasattr(parent, 'log_event'):
            parent.log_event("Abort", f"{abort_type} button pressed")

    def toggle_view(self):
        text = self.nav_btn.text()
        if text == "SETTINGS":
            self.navigation_requested.emit("settings")
            self.nav_btn.setText("DASHBOARD")
        else:
            self.navigation_requested.emit("dashboard")
            self.nav_btn.setText("SETTINGS")


# ---------------------- Settings Widget ----------------------
class SettingsWidget(QtWidgets.QWidget):
    """
    Centralized settings configuration widget.
    """
    mapping_changed = QtCore.pyqtSignal(str, int)  # gauge_name (GN2/ETH/LOX), pt_id
    
    def __init__(self, sensor_widget, actuator_widget, parent=None):
        super().__init__(parent)
        self.sensor_widget = sensor_widget
        self.actuator_widget = actuator_widget
        
        # Default mappings
        self.gauge_mappings = {
            "GN2": 0,
            "ETH": 0,
            "LOX": 0
        }
        
        self.init_ui()
        self.load_values()

    def init_ui(self):
        main_layout = QtWidgets.QHBoxLayout(self)
        
        # Left Column: Sensor & General Settings
        left_col_widget = QtWidgets.QWidget()
        left_col = QtWidgets.QVBoxLayout(left_col_widget)
        
        # ... Sensor Settings ...
        sensor_group = QtWidgets.QGroupBox("Sensor & General View Settings")
        sensor_layout = QtWidgets.QFormLayout()
        
        self.demo_chk = QtWidgets.QCheckBox("Demo Mode")
        self.demo_chk.toggled.connect(self.sensor_widget.on_demo_mode_toggled)
        sensor_layout.addRow(self.demo_chk)

        self.sim_pressure_chk = QtWidgets.QCheckBox("Simulate Chamber Pressure")
        self.sim_pressure_chk.setToolTip("If enabled: In FIRE state, transitions to ARMED if LOX or Fuel Upstream < 350 psi")
        self.sim_pressure_chk.toggled.connect(self.on_sim_pressure_toggled)
        sensor_layout.addRow(self.sim_pressure_chk)
        
        self.time_slider = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.time_slider.setRange(1, 60)
        self.time_lbl = QtWidgets.QLabel("10s")
        self.time_slider.valueChanged.connect(self.on_time_changed)
        sensor_layout.addRow("Time Window:", self.time_slider)
        sensor_layout.addRow("", self.time_lbl)
        
        self.y_min_spin = QtWidgets.QDoubleSpinBox()
        self.y_min_spin.setRange(-1000, 10000)
        self.y_min_spin.valueChanged.connect(self.on_y_min_changed)
        sensor_layout.addRow("Y Min:", self.y_min_spin)
        
        self.y_max_spin = QtWidgets.QDoubleSpinBox()
        self.y_max_spin.setRange(-1000, 10000)
        self.y_max_spin.valueChanged.connect(self.on_y_max_changed)
        sensor_layout.addRow("Y Max:", self.y_max_spin)

        self.ip_filter = QtWidgets.QLineEdit()
        self.ip_filter.textChanged.connect(self.on_ip_filter_changed)
        sensor_layout.addRow("Sensor IP Filter:", self.ip_filter)
        
        sensor_group.setLayout(sensor_layout)
        left_col.addWidget(sensor_group)
        
        # Moving average (graph and display)
        ma_group = QtWidgets.QGroupBox("Moving Average")
        ma_layout = QtWidgets.QFormLayout()
        self.graph_ma_spin = QtWidgets.QSpinBox()
        self.graph_ma_spin.setRange(1, 100)
        self.graph_ma_spin.setSuffix(" samples")
        self.graph_ma_spin.valueChanged.connect(self.on_graph_ma_changed)
        ma_layout.addRow("Graph:", self.graph_ma_spin)
        self.display_ma_spin = QtWidgets.QSpinBox()
        self.display_ma_spin.setRange(1, 100)
        self.display_ma_spin.setSuffix(" samples")
        self.display_ma_spin.valueChanged.connect(self.on_display_ma_changed)
        ma_layout.addRow("Display:", self.display_ma_spin)
        ma_group.setLayout(ma_layout)
        left_col.addWidget(ma_group)
        
        # Plot visibility: which sensors to show on the graph (horizontal row) + Debug button
        visibility_group = QtWidgets.QGroupBox("Plot visibility & Debug")
        visibility_layout = QtWidgets.QVBoxLayout()
        title_lbl = QtWidgets.QLabel("Sensors to show on plot")
        title_lbl.setStyleSheet("font-weight: bold;")
        visibility_layout.addWidget(title_lbl)
        # Row of number labels, then row of checkboxes (horizontal)
        numbers_row = QtWidgets.QHBoxLayout()
        numbers_row.setSpacing(4)
        checkboxes_row = QtWidgets.QHBoxLayout()
        checkboxes_row.setSpacing(4)
        small_font = QtGui.QFont()
        small_font.setPointSize(8)
        self.plot_visibility_cbs: Dict[int, QtWidgets.QCheckBox] = {}
        for i in range(1, NUM_CONNECTORS + 1):
            num_lbl = QtWidgets.QLabel(str(i))
            num_lbl.setFont(small_font)
            num_lbl.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
            num_lbl.setFixedWidth(24)
            numbers_row.addWidget(num_lbl)
            cb = QtWidgets.QCheckBox()
            cb.setChecked(True)
            cb.stateChanged.connect(lambda s, cid=i: self.sensor_widget._on_plot_toggle(cid, s))
            cb.setFixedWidth(24)
            checkboxes_row.addWidget(cb)
            self.plot_visibility_cbs[i] = cb
        visibility_layout.addLayout(numbers_row)
        visibility_layout.addLayout(checkboxes_row)
        self.only_show_pt_with_roles_chk = QtWidgets.QCheckBox("Only show PTs with roles")
        self.only_show_pt_with_roles_chk.toggled.connect(self.on_only_show_pt_with_roles_changed)
        visibility_layout.addWidget(self.only_show_pt_with_roles_chk)
        self.debug_btn = QtWidgets.QPushButton("Open debug panel…")
        self.debug_btn.clicked.connect(self.sensor_widget.open_debug_menu)
        visibility_layout.addWidget(self.debug_btn)
        visibility_group.setLayout(visibility_layout)
        left_col.addWidget(visibility_group)
        
        # ADC Settings
        adc_group = QtWidgets.QGroupBox("ADC Configuration")
        adc_layout = QtWidgets.QFormLayout()
        self.adc_bits_spin = QtWidgets.QSpinBox()
        self.adc_bits_spin.setRange(8, 32)
        self.adc_bits_spin.valueChanged.connect(self.on_adc_bits_changed)
        adc_layout.addRow("ADC Bits:", self.adc_bits_spin)
        
        self.ref_volt_spin = QtWidgets.QDoubleSpinBox()
        self.ref_volt_spin.setRange(0.1, 10.0)
        self.ref_volt_spin.setValue(2.5)
        self.ref_volt_spin.valueChanged.connect(self.on_ref_volt_changed)
        adc_layout.addRow("Ref Voltage (V):", self.ref_volt_spin)
        adc_group.setLayout(adc_layout)
        left_col.addWidget(adc_group)
        
        # Reset button — clears all stored sensor data, history, and event log
        reset_btn = QtWidgets.QPushButton("⟳  Reset All Data")
        reset_btn.setStyleSheet(
            "QPushButton { background-color: #8B0000; color: white; font-weight: bold; padding: 8px; border-radius: 4px; }"
            "QPushButton:hover { background-color: #A00000; }"
        )
        reset_btn.setToolTip("Clear all plot data, history (CSV buffer), and event log")
        reset_btn.clicked.connect(self._on_reset_all_data)
        left_col.addWidget(reset_btn)
        
        left_col.addStretch()
        
        # Wrap left column in scroll area
        left_scroll = QtWidgets.QScrollArea()
        left_scroll.setWidget(left_col_widget)
        left_scroll.setWidgetResizable(True)
        main_layout.addWidget(left_scroll, 1)
        
        # Middle Column: Actuator Configuration
        mid_col_widget = QtWidgets.QWidget()
        mid_col = QtWidgets.QVBoxLayout(mid_col_widget)
        act_group = QtWidgets.QGroupBox("Actuator Configuration")
        act_layout = QtWidgets.QVBoxLayout()
        
        form = QtWidgets.QFormLayout()
        self.act_ip = QtWidgets.QLineEdit()
        self.act_ip.textChanged.connect(self.on_act_ip_changed)
        form.addRow("Device IP:", self.act_ip)
        
        self.act_port = QtWidgets.QSpinBox()
        self.act_port.setRange(1, 65535)
        self.act_port.valueChanged.connect(self.on_act_port_changed)
        form.addRow("Device Port:", self.act_port)
        act_layout.addLayout(form)
        
        self.only_show_actuators_with_roles_chk = QtWidgets.QCheckBox("Only show actuators with roles")
        self.only_show_actuators_with_roles_chk.toggled.connect(self.on_only_show_actuators_with_roles_changed)
        act_layout.addWidget(self.only_show_actuators_with_roles_chk)
        
        act_layout.addWidget(QtWidgets.QLabel("Actuator role → slot:"))
        self.act_scroll = QtWidgets.QScrollArea()
        self.act_scroll_widget = QtWidgets.QWidget()
        self.act_form = QtWidgets.QFormLayout(self.act_scroll_widget)
        self.act_inputs = {}  # role_name -> QComboBox (actuator number 0=None, 1-10)
        for role_name in CONFIG.get_actuator_role_names():
            combo = QtWidgets.QComboBox()
            combo.addItem("—", 0)
            for act_num in range(1, NUM_ACTUATORS + 1):
                combo.addItem(str(act_num), act_num)
            combo.currentIndexChanged.connect(lambda idx, rn=role_name, c=combo: self.on_actuator_role_changed(rn, c))
            self.act_form.addRow(role_name + ":", combo)
            self.act_inputs[role_name] = combo
        self.act_scroll.setWidget(self.act_scroll_widget)
        self.act_scroll.setWidgetResizable(True)
        act_layout.addWidget(self.act_scroll)
        
        act_group.setLayout(act_layout)
        mid_col.addWidget(act_group)
        mid_col.addStretch()
        
        # Wrap middle column in scroll area
        mid_scroll = QtWidgets.QScrollArea()
        mid_scroll.setWidget(mid_col_widget)
        mid_scroll.setWidgetResizable(True)
        main_layout.addWidget(mid_scroll, 1)
        
        # Right Column: PT Configuration & Gauge Mapping
        right_col_widget = QtWidgets.QWidget()
        right_col = QtWidgets.QVBoxLayout(right_col_widget)
        pt_group = QtWidgets.QGroupBox("Pressure Transducers (PT) & Mapping")
        pt_layout = QtWidgets.QVBoxLayout()
        
        # PT calibration CSV paths (from config; empty = use built-in default)
        pt_csv_group = QtWidgets.QGroupBox("PT Calibration CSVs")
        pt_csv_layout = QtWidgets.QVBoxLayout()
        
        self.pt_calibration_csv_list = QtWidgets.QListWidget()
        self.pt_calibration_csv_list.setMaximumHeight(120)
        pt_csv_layout.addWidget(self.pt_calibration_csv_list)
        
        pt_csv_buttons = QtWidgets.QHBoxLayout()
        pt_csv_add = QtWidgets.QPushButton("Add CSV…")
        pt_csv_add.clicked.connect(self.on_pt_calibration_csv_add)
        pt_csv_remove = QtWidgets.QPushButton("Remove Selected")
        pt_csv_remove.clicked.connect(self.on_pt_calibration_csv_remove)
        pt_csv_buttons.addWidget(pt_csv_add)
        pt_csv_buttons.addWidget(pt_csv_remove)
        pt_csv_buttons.addStretch()
        pt_csv_layout.addLayout(pt_csv_buttons)
        
        self.pt_calibration_error_label = QtWidgets.QLabel()
        self.pt_calibration_error_label.setStyleSheet("color: red;")
        self.pt_calibration_error_label.setWordWrap(True)
        self.pt_calibration_error_label.setVisible(False)
        pt_csv_layout.addWidget(self.pt_calibration_error_label)
        
        pt_csv_group.setLayout(pt_csv_layout)
        pt_layout.addWidget(pt_csv_group)
        
        # Gauge Mapping (Moved to top as requested)
        mapping_group = QtWidgets.QGroupBox("Top Bar Gauge Mapping")
        mapping_form = QtWidgets.QFormLayout()
        
        self.combo_gn2 = QtWidgets.QComboBox()
        self.combo_eth = QtWidgets.QComboBox()
        self.combo_lox = QtWidgets.QComboBox()
        
        self.combos = {
            "GN2": self.combo_gn2,
            "ETH": self.combo_eth,
            "LOX": self.combo_lox
        }
        
        for name, combo in self.combos.items():
            combo.addItem("None", 0)
            for pt_id in sorted(self.sensor_widget.pt_calibration.keys()):
                combo.addItem(f"PT {pt_id}", pt_id)
            # Reverted to currentIndexChanged now that we block signals in load_values
            combo.currentIndexChanged.connect(lambda idx, n=name, c=combo: self.on_mapping_changed(n, c))
            mapping_form.addRow(f"{name} Source:", combo)
            
        mapping_group.setLayout(mapping_form)
        pt_layout.addWidget(mapping_group)
        
        # State transition thresholds (auto transitions: POP = over → vent, THRESH = under → press)
        thresh_group = QtWidgets.QGroupBox("State Transition Thresholds (psi)")
        thresh_form = QtWidgets.QFormLayout()
        self.gn2_pop_spin = QtWidgets.QDoubleSpinBox()
        self.gn2_pop_spin.setRange(0, 10000)
        self.gn2_pop_spin.setDecimals(1)
        self.gn2_pop_spin.setSuffix(" psi")
        self.gn2_pop_spin.valueChanged.connect(lambda v: self._on_threshold_changed("gn2_pop_psi", v))
        thresh_form.addRow("GN2 POP (→ GN2 Vent):", self.gn2_pop_spin)
        self.fuel_pop_spin = QtWidgets.QDoubleSpinBox()
        self.fuel_pop_spin.setRange(0, 10000)
        self.fuel_pop_spin.setDecimals(1)
        self.fuel_pop_spin.setSuffix(" psi")
        self.fuel_pop_spin.valueChanged.connect(lambda v: self._on_threshold_changed("fuel_pop_psi", v))
        thresh_form.addRow("Fuel POP (→ Fuel Vent):", self.fuel_pop_spin)
        self.ox_pop_spin = QtWidgets.QDoubleSpinBox()
        self.ox_pop_spin.setRange(0, 10000)
        self.ox_pop_spin.setDecimals(1)
        self.ox_pop_spin.setSuffix(" psi")
        self.ox_pop_spin.valueChanged.connect(lambda v: self._on_threshold_changed("ox_pop_psi", v))
        thresh_form.addRow("Ox POP (→ Ox Vent):", self.ox_pop_spin)
        self.gn2_thresh_spin = QtWidgets.QDoubleSpinBox()
        self.gn2_thresh_spin.setRange(0, 10000)
        self.gn2_thresh_spin.setDecimals(1)
        self.gn2_thresh_spin.setSuffix(" psi")
        self.gn2_thresh_spin.valueChanged.connect(lambda v: self._on_threshold_changed("gn2_thresh_psi", v))
        thresh_form.addRow("GN2 THRESH (→ GN2 Press):", self.gn2_thresh_spin)
        self.fuel_thresh_spin = QtWidgets.QDoubleSpinBox()
        self.fuel_thresh_spin.setRange(0, 10000)
        self.fuel_thresh_spin.setDecimals(1)
        self.fuel_thresh_spin.setSuffix(" psi")
        self.fuel_thresh_spin.valueChanged.connect(lambda v: self._on_threshold_changed("fuel_thresh_psi", v))
        thresh_form.addRow("Fuel THRESH (→ Fuel Press):", self.fuel_thresh_spin)
        self.ox_thresh_spin = QtWidgets.QDoubleSpinBox()
        self.ox_thresh_spin.setRange(0, 10000)
        self.ox_thresh_spin.setDecimals(1)
        self.ox_thresh_spin.setSuffix(" psi")
        self.ox_thresh_spin.valueChanged.connect(lambda v: self._on_threshold_changed("ox_thresh_psi", v))
        thresh_form.addRow("Ox THRESH (→ Ox Press):", self.ox_thresh_spin)
        thresh_group.setLayout(thresh_form)
        pt_layout.addWidget(thresh_group)
        
        # PT role → connector (same pattern as actuators)
        pt_layout.addWidget(QtWidgets.QLabel("PT role → connector:"))
        self.pt_form_widget = QtWidgets.QWidget()
        self.pt_form = QtWidgets.QFormLayout(self.pt_form_widget)
        self.pt_inputs = {}  # role_name -> QComboBox (pt_id 0=None, else PT 1-10)
        for role_name in CONFIG.get_sensor_role_names():
            combo = QtWidgets.QComboBox()
            combo.addItem("—", 0)
            for pt_id in range(1, NUM_CONNECTORS + 1):
                combo.addItem(f"PT {pt_id}", pt_id)
            combo.currentIndexChanged.connect(lambda idx, rn=role_name, c=combo: self.on_pt_role_changed(rn, c))
            self.pt_form.addRow(role_name + ":", combo)
            self.pt_inputs[role_name] = combo
        pt_layout.addWidget(self.pt_form_widget)
        
        pt_group.setLayout(pt_layout)
        right_col.addWidget(pt_group)
        right_col.addStretch()
        
        # Wrap right column in scroll area
        right_scroll = QtWidgets.QScrollArea()
        right_scroll.setWidget(right_col_widget)
        right_scroll.setWidgetResizable(True)
        main_layout.addWidget(right_scroll, 1)

    def load_values(self):
        # Sensor
        with QtCore.QSignalBlocker(self.demo_chk):
            self.demo_chk.setChecked(self.sensor_widget.demo_mode)

        with QtCore.QSignalBlocker(self.sim_pressure_chk):
            self.sim_pressure_chk.setChecked(CONFIG.config.get("simulate_chamber_pressure", False))
        
        with QtCore.QSignalBlocker(self.time_slider):
            self.time_slider.setValue(int(self.sensor_widget.window_seconds))
            
        with QtCore.QSignalBlocker(self.y_min_spin):
            self.y_min_spin.setValue(self.sensor_widget.y_axis_min)
            
        with QtCore.QSignalBlocker(self.y_max_spin):
            self.y_max_spin.setValue(self.sensor_widget.y_axis_max)
            
        with QtCore.QSignalBlocker(self.ip_filter):
            self.ip_filter.setText(self.sensor_widget.filter_source_ip)
        
        # Load PT calibration CSV paths (support both list and single string for backward compatibility)
        p = (CONFIG.config.get("paths") or {}).get("pt_calibration_csv", "")
        csv_paths = []
        if isinstance(p, list):
            csv_paths = [str(path).strip() for path in p if path and str(path).strip()]
        elif isinstance(p, str) and p.strip():
            csv_paths = [p.strip()]
        
        with QtCore.QSignalBlocker(self.pt_calibration_csv_list):
            self.pt_calibration_csv_list.clear()
            for path in csv_paths:
                self.pt_calibration_csv_list.addItem(path)
        
        # Update error label if there's an error
        if hasattr(self.sensor_widget, 'pt_calibration_error') and self.sensor_widget.pt_calibration_error:
            self.pt_calibration_error_label.setText(self.sensor_widget.pt_calibration_error)
            self.pt_calibration_error_label.setVisible(True)
        else:
            self.pt_calibration_error_label.setVisible(False)
        
        with QtCore.QSignalBlocker(self.only_show_pt_with_roles_chk):
            self.only_show_pt_with_roles_chk.setChecked(self.sensor_widget.only_show_pt_with_roles)
            
        with QtCore.QSignalBlocker(self.adc_bits_spin):
            self.adc_bits_spin.setValue(self.sensor_widget.adc_bits)
            
        with QtCore.QSignalBlocker(self.ref_volt_spin):
            self.ref_volt_spin.setValue(self.sensor_widget.reference_voltage)
        
        with QtCore.QSignalBlocker(self.graph_ma_spin):
            self.graph_ma_spin.setValue(self.sensor_widget.graph_moving_avg_samples)
        with QtCore.QSignalBlocker(self.display_ma_spin):
            self.display_ma_spin.setValue(self.sensor_widget.display_moving_avg_samples)
        
        for i in range(1, NUM_CONNECTORS + 1):
            if i in self.plot_visibility_cbs:
                with QtCore.QSignalBlocker(self.plot_visibility_cbs[i]):
                    self.plot_visibility_cbs[i].setChecked(self.sensor_widget.plot_enabled.get(i, True))
        
        # Actuator
        with QtCore.QSignalBlocker(self.act_ip):
            self.act_ip.setText(self.actuator_widget.device_ip)
            
        with QtCore.QSignalBlocker(self.act_port):
            self.act_port.setValue(self.actuator_widget.device_port)
        
        with QtCore.QSignalBlocker(self.only_show_actuators_with_roles_chk):
            self.only_show_actuators_with_roles_chk.setChecked(self.actuator_widget.only_show_actuators_with_roles)
            
        # Actuator roles: load from config (role → actuator id)
        for role_name, combo in self.act_inputs.items():
            with QtCore.QSignalBlocker(combo):
                actuator_id = CONFIG.get_actuator_role(role_name)
                idx = combo.findData(actuator_id)
                if idx >= 0:
                    combo.setCurrentIndex(idx)
                else:
                    combo.setCurrentIndex(0)
            
        # PT roles: load from config (role → connector id)
        for role_name, combo in self.pt_inputs.items():
            with QtCore.QSignalBlocker(combo):
                pt_id = CONFIG.get_sensor_role(role_name)
                idx = combo.findData(pt_id)
                if idx >= 0:
                    combo.setCurrentIndex(idx)
                else:
                    combo.setCurrentIndex(0)
        
        # Mappings (refresh list from current pt_calibration then restore selection)
        self._refresh_pt_mapping_combos()
        
        # Pressure limits (THRESH and POP from pressure_limits)
        pl = CONFIG.config.get("pressure_limits", {})
        key_to_fluid_limit = [
            ("gn2_pop_psi", "GN2", "POP"),
            ("fuel_pop_psi", "ETH", "POP"),
            ("ox_pop_psi", "LOX", "POP"),
            ("gn2_thresh_psi", "GN2", "THRESH"),
            ("fuel_thresh_psi", "ETH", "THRESH"),
            ("ox_thresh_psi", "LOX", "THRESH"),
        ]
        for key, fluid, limit in key_to_fluid_limit:
            spin = getattr(self, key.replace("_psi", "_spin"))
            default = 100.0 if limit == "POP" else 10.0
            val = pl.get(fluid, {}).get(limit, default)
            with QtCore.QSignalBlocker(spin):
                spin.setValue(float(val))
            
    def _refresh_pt_mapping_combos(self):
        """Repopulate GN2/ETH/LOX source combos from current pt_calibration and restore selection from config."""
        for name, combo in self.combos.items():
            with QtCore.QSignalBlocker(combo):
                combo.clear()
                combo.addItem("None", 0)
                for pt_id in sorted(self.sensor_widget.pt_calibration.keys()):
                    combo.addItem(f"PT {pt_id}", pt_id)
                pt_id = CONFIG.config["mappings"].get(name, 0)
                idx = combo.findData(pt_id)
                combo.setCurrentIndex(idx if idx >= 0 else 0)
    
    def _update_pt_calibration_csv_config(self):
        """Update config with current list of CSV paths."""
        paths = []
        for i in range(self.pt_calibration_csv_list.count()):
            item = self.pt_calibration_csv_list.item(i)
            if item and item.text().strip():
                paths.append(item.text().strip())
        CONFIG.config.setdefault("paths", {})["pt_calibration_csv"] = paths if paths else []
        CONFIG.save()
        self.sensor_widget.reload_pt_calibration()
        self._refresh_pt_mapping_combos()
        
        # Update error label
        if hasattr(self.sensor_widget, 'pt_calibration_error') and self.sensor_widget.pt_calibration_error:
            self.pt_calibration_error_label.setText(self.sensor_widget.pt_calibration_error)
            self.pt_calibration_error_label.setVisible(True)
        else:
            self.pt_calibration_error_label.setVisible(False)
    
    def on_pt_calibration_csv_add(self):
        """Add a new CSV file to the list."""
        # Get last directory from list or use home directory
        last_path = ""
        if self.pt_calibration_csv_list.count() > 0:
            last_item = self.pt_calibration_csv_list.item(self.pt_calibration_csv_list.count() - 1)
            if last_item:
                last_path = os.path.dirname(last_item.text()) if os.path.dirname(last_item.text()) else os.path.expanduser("~")
        else:
            last_path = os.path.expanduser("~")
        
        path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self,
            "Select PT calibration CSV",
            last_path,
            "CSV files (*.csv);;All files (*)",
        )
        if path:
            self.pt_calibration_csv_list.addItem(path)
            self._update_pt_calibration_csv_config()
    
    def on_pt_calibration_csv_remove(self):
        """Remove selected CSV file from the list."""
        current_item = self.pt_calibration_csv_list.currentItem()
        if current_item:
            row = self.pt_calibration_csv_list.row(current_item)
            self.pt_calibration_csv_list.takeItem(row)
            self._update_pt_calibration_csv_config()
    
    def _on_threshold_changed(self, key: str, value: float):
        key_to_fluid_limit = {
            "gn2_pop_psi": ("GN2", "POP"),
            "fuel_pop_psi": ("ETH", "POP"),
            "ox_pop_psi": ("LOX", "POP"),
            "gn2_thresh_psi": ("GN2", "THRESH"),
            "fuel_thresh_psi": ("ETH", "THRESH"),
            "ox_thresh_psi": ("LOX", "THRESH"),
        }
        fluid, limit = key_to_fluid_limit.get(key, (None, None))
        if fluid is not None:
            CONFIG.config.setdefault("pressure_limits", {}).setdefault(fluid, {})[limit] = value
            CONFIG.save()

    def on_sim_pressure_toggled(self, checked):
        CONFIG.config["simulate_chamber_pressure"] = checked
        CONFIG.save()
        # Direct update to main window state (via parent linkage or signal)
        if hasattr(self.parent(), "parent") and hasattr(self.parent().parent(), "update_sim_pressure_state"):
             # stack -> central_widget -> CombinedMainWindow
             # But self.parent() is the QStackedWidget. self.parent().parent() is usually central widget or window.
             # Easier: SettingsWidget constructed with main_window ref? No.
             # We can use the fact that CombinedMainWindow holds a ref to settings_widget.
             # Better pattern: SettingsWidget emits signal, connected in MainWindow.
             pass
        # Actually, let's just use CONFIG in main window loop or add a specific update method call if we can resolve main window.
        # CombinedMainWindow passes 'self' to settings widget constructor?
        # __init__(self, sensor_widget, actuator_widget, parent=None) -> parent is stack.
        # Let's rely on config being source of truth for the loop check, or add a callback.
        # For immediate update, we can assume the loop checks CONFIG or a member variable updated by timer/loop.
        # The loop _check_auto_state_transitions runs on timer, so reading CONFIG.config there is fine/safe enough
        # or we update a variable in CombinedMainWindow if we really want to.
        # Let's update the Config object which is shared.
        pass

    def _on_reset_all_data(self):
        """Clear all stored sensor data, plot buffers, CSV history, and event log."""
        reply = QtWidgets.QMessageBox.question(
            self, "Reset All Data",
            "This will clear all plot data, CSV history, and the event log.\n\nAre you sure?",
            QtWidgets.QMessageBox.StandardButton.Yes | QtWidgets.QMessageBox.StandardButton.No,
            QtWidgets.QMessageBox.StandardButton.No,
        )
        if reply != QtWidgets.QMessageBox.StandardButton.Yes:
            return
        
        # Clear sensor data
        sw = self.sensor_widget
        for k in list(sw.sensor_data.keys()):
            sw.sensor_data[k] = deque(maxlen=MAX_POINTS)
            sw.sensor_adc_codes[k] = deque(maxlen=MAX_POINTS)
        for k in list(sw.sensor_psi_plot_t.keys()):
            sw.sensor_psi_plot_t[k] = deque(maxlen=sw.plot_buffer_size)
            sw.sensor_psi_plot_v[k] = deque(maxlen=sw.plot_buffer_size)
        for k in list(sw.sensor_psi_history.keys()):
            sw.sensor_psi_history[k] = []
        
        # Reset sample counters and timing
        sw.total_samples_received = 0
        sw.last_sps_sample_count = 0
        sw.last_sps_time = time.time()
        sw.stats_start_time = time.time()
        
        # Clear event log on the main window
        main_win = sw.main_window_ref if hasattr(sw, 'main_window_ref') and sw.main_window_ref else None
        if main_win and hasattr(main_win, 'event_log'):
            main_win.event_log.clear()
        
        # Clear plots visually
        for plot in sw.sensor_plots.values():
            plot.setData([], [])
        
        sw.update_statistics()
        print("All data reset.")

    def on_time_changed(self, val):
        self.time_lbl.setText(f"{val}s")
        self.sensor_widget.window_seconds = float(val)
        self.sensor_widget.update_buffer_size()  # Update buffer size dynamically
        CONFIG.config["display"]["window_seconds"] = float(val)
        CONFIG.save()

    def on_y_min_changed(self, val):
        self.sensor_widget.y_axis_min = val
        CONFIG.config["display"]["y_axis_min"] = val
        CONFIG.save()

    def on_y_max_changed(self, val):
        self.sensor_widget.y_axis_max = val
        CONFIG.config["display"]["y_axis_max"] = val
        CONFIG.save()

    def on_ip_filter_changed(self, text):
        self.sensor_widget.filter_source_ip = text
        CONFIG.config["network"]["sensor_ip_filter"] = text
        CONFIG.save()

    def on_only_show_pt_with_roles_changed(self, checked):
        self.sensor_widget.only_show_pt_with_roles = checked
        CONFIG.config["display"]["only_show_pt_with_roles"] = checked
        CONFIG.save()
        # Trigger immediate update of plots and under-graph display
        self.sensor_widget.update_plots()
        self.sensor_widget.update_statistics()

    def on_adc_bits_changed(self, val):
        self.sensor_widget.adc_bits = val
        CONFIG.config["display"]["adc_bits"] = val
        CONFIG.save()

    def on_ref_volt_changed(self, val):
        self.sensor_widget.reference_voltage = val
        CONFIG.config["display"]["ref_voltage"] = val
        CONFIG.save()

    def on_graph_ma_changed(self, val):
        self.sensor_widget.on_graph_moving_avg_changed(val)
        CONFIG.config["display"]["graph_ma_samples"] = val
        CONFIG.save()

    def on_display_ma_changed(self, val):
        self.sensor_widget.on_display_moving_avg_changed(val)
        CONFIG.config["display"]["display_ma_samples"] = val
        CONFIG.save()

    def on_act_ip_changed(self, text):
        self.actuator_widget.device_ip = text
        CONFIG.config["network"]["actuator_ip"] = text
        CONFIG.save()

    def on_act_port_changed(self, val):
        self.actuator_widget.device_port = val
        CONFIG.config["network"]["actuator_port"] = val
        CONFIG.save()

    def on_only_show_actuators_with_roles_changed(self, checked):
        self.actuator_widget.only_show_actuators_with_roles = checked
        CONFIG.config["display"]["only_show_actuators_with_roles"] = checked
        CONFIG.save()
        # Trigger immediate update of actuator visibility
        self.actuator_widget.update_actuator_visibility()

    def on_actuator_role_changed(self, role_name, combo):
        actuator_id = combo.currentData()
        if actuator_id is None:
            actuator_id = 0
        CONFIG.set_actuator_role(role_name, actuator_id)
        # Refresh widget labels from config
        for aid in range(1, NUM_ACTUATORS + 1):
            label = CONFIG.get_actuator_label(aid)
            self.actuator_widget.actuator_labels[aid] = label
            self.actuator_widget.update_label_display(aid, label)
        # Update visibility if filtering is enabled
        if self.actuator_widget.only_show_actuators_with_roles:
            self.actuator_widget.update_actuator_visibility()
        
    def on_pt_role_changed(self, role_name, combo):
        pt_id = combo.currentData()
        if pt_id is None:
            pt_id = 0
        CONFIG.set_sensor_role(role_name, pt_id)
        # Refresh widget labels from config
        for cid in range(1, NUM_CONNECTORS + 1):
            label = CONFIG.get_sensor_label(cid)
            self.sensor_widget.sensor_labels[cid] = label
            if cid in self.sensor_widget.sensor_plots:
                self.sensor_widget.update_plot_legend(cid)

    def on_mapping_changed(self, gauge_name, combo):
        pt_id = combo.currentData()
        self.mapping_changed.emit(gauge_name, pt_id)
        CONFIG.config["mappings"][gauge_name] = pt_id
        CONFIG.save()


# ---------------------- Actuator Control Window (standalone) ----------------------
class ActuatorControlWindow(QtWidgets.QMainWindow):
    """Standalone window that embeds ActuatorControlWidget."""
    def __init__(self, receiver, device_ip: str = DEFAULT_ACTUATOR_IP, device_port: int = DEFAULT_DEVICE_PORT):
        super().__init__()
        self.setWindowTitle(f"Actuator Control - {device_ip}:{device_port}")
        self.setGeometry(1350, 100, 1000, 500)
        self.setCentralWidget(ActuatorControlWidget(receiver, device_ip, device_port, self))
    
    def closeEvent(self, event):
        """Handle window close event"""
        w = self.centralWidget()
        if w and hasattr(w, 'save_labels'):
            w.save_labels()
        if w and hasattr(w, 'close_socket'):
            w.close_socket()
        event.accept()


# ---------------------- Combined Main Window ----------------------
class CombinedMainWindow(QtWidgets.QMainWindow):
    """Single window with sensor plot (left 66%) and actuator control (right 33%)."""
    def __init__(self, receiver, device_ip: str = DEFAULT_ACTUATOR_IP, device_port: int = DEFAULT_DEVICE_PORT, bind_address: str = '0.0.0.0'):
        super().__init__()
        self.setWindowTitle("Diablo Avionics – Sensor & Actuator")
        # Event log storage: list of (time, type, details)
        self.event_log: List[Tuple[float, str, str]] = []
        
        # Load state machine CSV
        self.state_machine = load_state_machine_csv(CONFIG.get_state_machine_csv_path())
        
        # Map mode button names to CSV state names (keep order in sync with CSV header and TopBarWidget)
        self.mode_to_state_map = {
            "Idle": "Idle",
            "Armed": "Armed",
            "Fuel Fill": "Fuel Fill",
            "Ox Fill": "Ox Fill",
            "Quick Fire": "Quick Fire",
            "GN2 Press": "GN2 Press",
            "Fuel Press": "Fuel Press",
            "Fuel Vent": "Fuel Vent",
            "Ox Press": "Ox Press",
            "Ox Vent": "Ox Vent",
            "High Press": "High Press",
            "GN2 Vent": "GN2 Vent",
            "Fire": "Fire",
            "Vent": "Vent",
            "Abort": "Abort",
        }
        
        # Central widget container
        central_widget = QtWidgets.QWidget()
        self.setCentralWidget(central_widget)
        
        # Main vertical layout
        main_layout = QtWidgets.QVBoxLayout(central_widget)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)
        
        # Top Bar
        self.top_bar_widget = TopBarWidget(self)
        self.top_bar_widget.navigation_requested.connect(self.on_navigation_requested)
        self.top_bar_widget.mode_changed.connect(self.on_mode_changed)
        self.top_bar_widget.debug_toggled.connect(self.on_debug_toggled)
        main_layout.addWidget(self.top_bar_widget)
        
        # Stacked Widget for Dashboard / Settings
        self.stack = QtWidgets.QStackedWidget()
        
        # --- Page 1: Dashboard ---
        dashboard_widget = QtWidgets.QWidget()
        dashboard_layout = QtWidgets.QHBoxLayout(dashboard_widget)
        dashboard_layout.setContentsMargins(0, 0, 0, 0)
        
        self.sensor_widget = SensorPlotWidget(receiver, bind_address, self)
        self.actuator_widget = ActuatorControlWidget(receiver, device_ip, device_port, self)
        self.sensor_widget.main_window_ref = self
        self.actuator_widget.main_window_ref = self

        splitter = QtWidgets.QSplitter(QtCore.Qt.Orientation.Horizontal)
        splitter.addWidget(self.sensor_widget)
        splitter.addWidget(self.actuator_widget)
        splitter.setStretchFactor(0, 2)  # Left 66%
        splitter.setStretchFactor(1, 1)  # Right 33%
        
        dashboard_layout.addWidget(splitter)
        self.stack.addWidget(dashboard_widget)
        
        # --- Page 2: Settings ---
        self.settings_widget = SettingsWidget(self.sensor_widget, self.actuator_widget)
        self.settings_widget.mapping_changed.connect(self.on_mapping_changed)
        self.stack.addWidget(self.settings_widget)
        
        main_layout.addWidget(self.stack, 1)
        
        # Connect sensor data for Top Bar updates
        # leveraging the existing timer update in SensorPlotWidget is tricky without a signal
        # simpler to just shadow the data
        self.gauge_map = CONFIG.config["mappings"]
        
        self.update_timer = QtCore.QTimer(self)
        self.update_timer.timeout.connect(self.update_top_bar)
        self.update_timer.start(100)

        self._apply_bar_limits()
        
        # PWM control window (lazily created)
        self.pwm_window = None
    
    def _apply_bar_limits(self):
        """Apply NOP, MEOP, POP, THRESH and shared scale_max to top bar gauges (bottom=0, same scale)."""
        pl = CONFIG.config.get("pressure_limits", {})
        pops = [float(pl.get(f, {}).get("POP", 750)) for f in ("GN2", "ETH", "LOX")]
        scale_max = max(1.25 * p for p in pops) if pops else 1000.0
        scale_max = max(scale_max, 1.0)
        for fluid, bar in [("GN2", self.top_bar_widget.bar_gn2), ("ETH", self.top_bar_widget.bar_eth), ("LOX", self.top_bar_widget.bar_lox)]:
            d = pl.get(fluid, {})
            nop = float(d.get("NOP", 600))
            meop = float(d.get("MEOP", 650))
            pop = float(d.get("POP", 750))
            thresh = float(d.get("THRESH", 400))
            bar.set_limits(nop, meop, pop, thresh, scale_max=scale_max)

    def on_navigation_requested(self, view_name):
        if view_name == "settings":
            self.settings_widget.load_values() # Refresh values on enter
            self.stack.setCurrentWidget(self.settings_widget)
        else:
            self._apply_bar_limits()
            self.stack.setCurrentIndex(0) # Dashboard
    
    def on_debug_toggled(self, enabled: bool):
        """Handle DEBUG button toggle - enable/disable manual actuator control"""
        if hasattr(self, 'actuator_widget') and self.actuator_widget:
            self.actuator_widget.manual_control_enabled = enabled
            print(f"DEBUG mode: Manual control {'enabled' if enabled else 'disabled'}")
        else:
            print(f"Warning: actuator_widget not available when DEBUG toggled")
    
    def open_pwm_control(self):
        """Open the PWM control window, creating it lazily."""
        if self.pwm_window is None:
            self.pwm_window = PWMControlWindow(self)
        self.pwm_window.show()
        self.pwm_window.raise_()
        self.pwm_window.activateWindow()

    def on_mode_changed(self, mode_name: str):
        """Handle mode button change - apply state from CSV and log event"""
        relative_time = time.time() - self.sensor_widget.stats_start_time
        self.log_event("Mode Changed", mode_name)
        
        # Manual control is now controlled by DEBUG button, not by state selection
        # (DEBUG button handler sets manual_control_enabled)
        
        # Map mode name to CSV state name
        csv_state_name = self.mode_to_state_map.get(mode_name, mode_name)
        
        # Apply actuator states from CSV
        if self.state_machine:
            apply_state_from_csv(self.actuator_widget, csv_state_name, self.state_machine)
        else:
            print(f"Warning: State machine not loaded, cannot apply state for '{mode_name}'")
        
        # Fire any armed PWM commands on state transition
        if self.pwm_window is not None:
            armed = self.pwm_window.get_armed_commands()
            if armed:
                packet = create_pwm_actuator_command_packet(armed)
                try:
                    sock = self.actuator_widget.command_sock
                    ip = self.actuator_widget.device_ip
                    port = self.actuator_widget.device_port
                    sock.sendto(packet, (ip, port))
                    self.log_event("PWM Armed Execute", f"{len(armed)} commands on '{mode_name}'")
                    print(f"Sent {len(armed)} armed PWM commands on state '{mode_name}'")
                except Exception as e:
                    print(f"Error sending armed PWM commands: {e}")
                self.pwm_window.consume_arms()
    
    def log_event(self, event_type: str, details: str):
        """Log an event with current relative time"""
        relative_time = time.time() - self.sensor_widget.stats_start_time
        self.event_log.append((relative_time, event_type, details))
    
    def get_event_log(self):
        """Get the event log, filtered by settings"""
        filtered_events = []
        for event_time, event_type, details in self.event_log:
            # Filter actuator events if only_show_actuators_with_roles is enabled
            if event_type == "Actuator State Change" and self.actuator_widget.only_show_actuators_with_roles:
                # Extract actuator ID from details (format: "Actuator X: ..." or "Actuator X (label): ...")
                import re
                match = re.match(r"Actuator (\d+)", details)
                if match:
                    actuator_id = int(match.group(1))
                    # Check if this actuator has a role (non-empty label)
                    label = self.actuator_widget.actuator_labels.get(actuator_id, "")
                    if not label or label.strip() == "":
                        continue  # Skip this event
            filtered_events.append((event_time, event_type, details))
        return filtered_events
            
    def on_mapping_changed(self, gauge_name, pt_id):
        self.gauge_map[gauge_name] = pt_id # Update local map for internal timer use
        # CONFIG save is handled in settings_widget
        
    def _get_gauge_pressure(self, gauge_name: str) -> float:
        """Return latest pressure (psi) for the given gauge (GN2, ETH, LOX), or 0.0 if no data."""
        pt_id = self.gauge_map.get(gauge_name, 0)
        if pt_id <= 0 or pt_id not in self.sensor_widget.sensor_psi_plot_v:
            return 0.0
        deque_data = self.sensor_widget.sensor_psi_plot_v[pt_id]
        if len(deque_data) == 0:
            return 0.0
        return deque_data[-1]

    def _check_auto_state_transitions(self):
        """If current state and pressures meet threshold rules, automatically transition state."""
        if self.top_bar_widget.unlock_states:
            return  # In DEBUG mode, no automatic transitions
        current = self.top_bar_widget.current_state
        if current is None:
            return
        pl = CONFIG.config.get("pressure_limits", {})
        gn2_psi = self._get_gauge_pressure("GN2")
        fuel_psi = self._get_gauge_pressure("ETH")
        ox_psi = self._get_gauge_pressure("LOX")
        gn2_pop = float(pl.get("GN2", {}).get("POP", 100.0))
        fuel_pop = float(pl.get("ETH", {}).get("POP", 100.0))
        ox_pop = float(pl.get("LOX", {}).get("POP", 100.0))
        gn2_thresh = float(pl.get("GN2", {}).get("THRESH", 10.0))
        fuel_thresh = float(pl.get("ETH", {}).get("THRESH", 10.0))
        ox_thresh = float(pl.get("LOX", {}).get("THRESH", 10.0))
        
        # Simulate Chamber Pressure Logic (Safety/Test)
        # If enabled: In FIRE state, if LOX < 350 or Fuel < 350, go to ARMED
        if current == "Fire" and CONFIG.config.get("simulate_chamber_pressure", False):
            # Using Upstream sensors (from config mapping or hardcoded roles?)
            # User said "LOX upstream OR Fuel Upstream". 
            # We need to get pressure from the sensors assigned to these roles.
            # config.json: "sensor_roles": { "Fuel Upstream": 1, "Data": ..., "Ox Upstream": 5 }
            # Let's resolve the PT IDs for these roles.
            fuel_upstream_pt = CONFIG.get_sensor_role("Fuel Upstream")
            ox_upstream_pt = CONFIG.get_sensor_role("Ox Upstream") # "Ox Upstream" in config vs "LOX Upstream" in code?
            # Looking at config.json provided earlier: 
            # "Fuel Upstream": 1, "Ox Upstream": 5.
            
            # Helper to get PSI
            def get_psi(pt_id):
                if pt_id > 0 and pt_id in self.sensor_widget.sensor_psi_plot_v:
                    d = self.sensor_widget.sensor_psi_plot_v[pt_id]
                    if d: return d[-1]
                return 0.0
            
            p_fuel = get_psi(fuel_upstream_pt)
            p_lox = get_psi(ox_upstream_pt)
            
            # Threshold is 350 psi
            if p_fuel < 350.0 or p_lox < 350.0:
                self.top_bar_widget.request_state("Armed")
                self.log_event("Auto Transition", f"Simulate Chamber Pressure triggered: Fuel={p_fuel:.1f}, LOX={p_lox:.1f} (<350)")
                return

        # Press → Vent when pressure above POP
        if current == "GN2 Press" and gn2_psi >= gn2_pop:
            self.top_bar_widget.request_state("GN2 Vent")
            return
        if current == "Fuel Press" and fuel_psi >= fuel_pop:
            self.top_bar_widget.request_state("Fuel Vent")
            return
        if current == "Ox Press" and ox_psi >= ox_pop:
            self.top_bar_widget.request_state("Ox Vent")
            return
        if current == "High Press" and gn2_psi >= gn2_pop:
            self.top_bar_widget.request_state("GN2 Vent")
            return
        # Vent → Press when pressure below THRESH
        if current == "GN2 Vent" and gn2_psi <= gn2_thresh:
            self.top_bar_widget.request_state("GN2 Press")
            return
        if current == "Fuel Vent" and fuel_psi <= fuel_thresh:
            self.top_bar_widget.request_state("Fuel Press")
            return
        if current == "Ox Vent" and ox_psi <= ox_thresh:
            self.top_bar_widget.request_state("Ox Press")

    def update_top_bar(self):
        # Poll sensor widget for latest PSI values
        # Accessing private data sensor_psi_data directly for simplicity given the code structure
        for gauge, pt_id in self.gauge_map.items():
            val = 0.0
            if pt_id > 0 and pt_id in self.sensor_widget.sensor_psi_plot_v:
                deque_data = self.sensor_widget.sensor_psi_plot_v[pt_id]
                if len(deque_data) > 0:
                    val = deque_data[-1]  # just the psi value (no tuple)
            
            if gauge == "GN2":
                self.top_bar_widget.bar_gn2.set_value(val)
            elif gauge == "ETH":
                self.top_bar_widget.bar_eth.set_value(val)
            elif gauge == "LOX":
                self.top_bar_widget.bar_lox.set_value(val)
        self._check_auto_state_transitions()
    
    def closeEvent(self, event):
        """Handle window close: save labels and close actuator socket."""
        # ConfigManager handles saving on change, so explicit save here might be redundant 
        # but safe to keep close actions for sockets
        if hasattr(self, 'actuator_widget') and self.actuator_widget:
            if hasattr(self.actuator_widget, 'close_socket'):
                self.actuator_widget.close_socket()
        event.accept()


# ---------------------- Settings Dialogs ----------------------






# ---------------------- Main Application ----------------------
def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Combined Sensor & Actuator Control GUI (single full-screen window)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Opens one full-screen window: sensor plot on the left, actuator control on the right.

Examples:
  %(prog)s                              # Use default settings
  %(prog)s -i 192.168.2.100             # Specify actuator device IP
  %(prog)s -p 5006                      # Specify receive port
        """
    )
    parser.add_argument(
        '-i', '--ip',
        type=str,
        default=CONFIG.config["network"]["actuator_ip"],
        help=f'Actuator board IP address (default from config: {CONFIG.config["network"]["actuator_ip"]})'
    )
    parser.add_argument(
        '-p', '--port',
        type=int,
        default=CONFIG.config["network"]["receive_port"],
        help=f'UDP port to receive sensor data on (default from config: {CONFIG.config["network"]["receive_port"]})'
    )
    parser.add_argument(
        '-d', '--device-port',
        type=int,
        default=CONFIG.config["network"]["actuator_port"],
        help=f'Device UDP port for actuator commands (default from config: {CONFIG.config["network"]["actuator_port"]})'
    )
    parser.add_argument(
        '-a', '--address',
        type=str,
        default='0.0.0.0',
        help='IP address to bind receiver to (default: 0.0.0.0 for all interfaces)'
    )
    
    args = parser.parse_args()
    
    app = QtWidgets.QApplication(sys.argv)
    
    # Force Fusion style and dark palette (WSL doesn't always pick up system theme)
    app.setStyle("Fusion")
    palette = QtGui.QPalette()
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.Window, QtGui.QColor(53, 53, 53))
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.WindowText, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.Base, QtGui.QColor(25, 25, 25))
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.AlternateBase, QtGui.QColor(53, 53, 53))
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.ToolTipBase, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.ToolTipText, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.Text, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.Button, QtGui.QColor(53, 53, 53))
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.ButtonText, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.BrightText, QtCore.Qt.GlobalColor.red)
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.Link, QtGui.QColor(42, 130, 218))
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.Highlight, QtGui.QColor(42, 130, 218))
    palette.setColor(QtGui.QPalette.ColorGroup.All, QtGui.QPalette.ColorRole.HighlightedText, QtCore.Qt.GlobalColor.black)
    app.setPalette(palette)
    
    # Create shared UDP receiver
    receiver = UDPReceiver(port=args.port, bind_address=args.address)
    receiver.start()
    
    # Create single combined window (sensor plot left, actuator control right)
    window = CombinedMainWindow(
        receiver,
        device_ip=args.ip,
        device_port=args.device_port,
        bind_address=args.address,
    )
    # Start maximized as requested
    window.showMaximized()
    
    # Handle cleanup when app exits
    def cleanup():
        receiver.stop()
        receiver.wait(2000)
    
    app.aboutToQuit.connect(cleanup)
    
    sys.exit(app.exec())


if __name__ == '__main__':
    main()
