#!/usr/bin/env python3
"""
FSW Combined Sensor & Actuator Control GUI
Similar to DiabloAvionics combined_gui.py but integrated with FSW stack

Features:
- Real-time sensor data visualization (pressure plots)
- Actuator control (ON/OFF buttons)
- State machine control (Idle, Armed, Fire, Vent, etc.)
- Top bar with pressure gauges and abort buttons
- Integration with Elodin database
"""

import json
import socket
import struct
import sys
import time
import csv
import re
import os
from collections import deque
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from PyQt6 import QtCore, QtGui, QtWidgets
import pyqtgraph as pg
import numpy as np

# Elodin client is implemented in this file
# No external import needed

# Configuration
MAX_PACKET_SIZE = 512
# NUM_ACTUATORS is now dynamic - use get_num_actuators() function
NUM_SENSORS = 10
UPDATE_INTERVAL_MS = 50
DEFAULT_WINDOW_SECONDS = 40.0
MAX_POINTS = 10000

# Default network configuration
DEFAULT_ACTUATOR_IP = "192.168.2.201"
DEFAULT_SENSOR_IP = "192.168.2.101"  # PT board IP
DEFAULT_ACTUATOR_PORT = 5005
DEFAULT_RECEIVE_PORT = 5006
DEFAULT_BIND_ADDRESS = "0.0.0.0"

# PT Calibration paths
PT_CALIBRATION_CSV = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "external",
    "DiabloAvionics",
    "PT_Board",
    "Calibration",
    "PT Calibration Attempt 2026-02-04_test2.csv",
)
CALIBRATION_JSON_DIR = Path(__file__).parent.parent / "calibration" / "calibrations"

# Packet format (DiabloAvionics)
PACKET_HEADER_FORMAT = "<BBI"  # packet_type, version, timestamp
PACKET_HEADER_SIZE = 6
SENSOR_DATA_PACKET_FORMAT = "<BB"  # num_chunks, num_sensors
SENSOR_DATA_PACKET_SIZE = 2
SENSOR_DATA_CHUNK_FORMAT = "<I"  # chunk_timestamp
SENSOR_DATA_CHUNK_SIZE = 4
SENSOR_DATAPOINT_FORMAT = "<BI"  # sensor_id, data
SENSOR_DATAPOINT_SIZE = 5


# Packet types
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


# Sensor colors
SENSOR_COLORS = [
    (255, 80, 80),  # Red
    (80, 255, 80),  # Green
    (80, 150, 255),  # Blue
    (255, 200, 80),  # Orange
    (200, 80, 255),  # Purple
    (80, 255, 255),  # Cyan
    (255, 150, 150),  # Light Red
    (150, 255, 150),  # Light Green
    (150, 200, 255),  # Light Blue
    (255, 255, 80),  # Yellow
]


# State machine states (matching FSW PressureStateMachine)
class SystemState:
    IDLE = "Idle"
    ARMED = "Armed"
    FUEL_FILL = "Fuel Fill"
    OX_FILL = "Ox Fill"
    GN2_LOW_PRESS = "GN2 Low Press"
    GN2_VENT = "GN2 Vent"
    FUEL_PRESS = "Fuel Press"
    FUEL_VENT = "Fuel Vent"
    OX_PRESS = "Ox Press"
    OX_VENT = "Ox Vent"
    GN2_HIGH_PRESS = "GN2 High Press"
    GN2_HIGH_VENT = "GN2 High Vent"
    VENT = "Vent"
    CALIBRATE = "Calibrate"
    READY = "Ready"
    FIRE = "Fire"
    ABORT = "Abort"
    QUICK_FIRE = "Quick Fire"
    HIGH_PRESS = "High Press"


CONFIG_FILE = Path(__file__).parent / "fsw_gui_config.json"

# State machine CSV path
_STATE_MACHINE_CSV = (
    Path(__file__).parent.parent.parent
    / "external"
    / "DiabloAvionics"
    / "test_guis"
    / "state_machine_actuators.csv"
)


def get_num_actuators():
    """Get number of actuators dynamically from CSV."""
    if _STATE_MACHINE_CSV.exists():
        try:
            with open(_STATE_MACHINE_CSV, "r") as f:
                reader = csv.reader(f)
                rows = list(reader)
                if len(rows) >= 2:
                    # Count non-empty actuator rows (skip header)
                    count = sum(
                        1 for row in rows[1:] if len(row) > 0 and row[0].strip()
                    )
                    if count > 0:
                        return count
        except Exception as e:
            print(f"Warning: Could not determine actuator count from CSV: {e}")
    # Fallback to default
    return 10


class ConfigManager:
    """Manages GUI configuration"""

    def __init__(self):
        num_actuators = get_num_actuators()
        self.config = {
            "actuators": {str(i): "" for i in range(1, num_actuators + 1)},
            "sensors": {str(i): "" for i in range(1, NUM_SENSORS + 1)},
            "network": {
                "actuator_ip": DEFAULT_ACTUATOR_IP,
                "sensor_ip_filter": DEFAULT_SENSOR_IP,  # PT board IP for filtering
                "actuator_port": DEFAULT_ACTUATOR_PORT,
                "receive_port": DEFAULT_RECEIVE_PORT,
                "bind_address": DEFAULT_BIND_ADDRESS,
            },
            "display": {
                "window_seconds": DEFAULT_WINDOW_SECONDS,
                "y_axis_min": 0.0,
                "y_axis_max": 200.0,
                "y_axis_autoscale": True,
            },
            "mappings": {"GN2": 0, "ETH": 0, "LOX": 0},
        }
        self.load()

    def load(self):
        if CONFIG_FILE.exists():
            try:
                with open(CONFIG_FILE, "r") as f:
                    loaded = json.load(f)
                    self._update_dict(self.config, loaded)
            except Exception as e:
                print(f"Error loading config: {e}")
        else:
            self.save()

    def save(self):
        try:
            with open(CONFIG_FILE, "w") as f:
                json.dump(self.config, f, indent=4)
        except Exception as e:
            print(f"Error saving config: {e}")

    def _update_dict(self, target, source):
        for k, v in source.items():
            if isinstance(v, dict) and k in target:
                self._update_dict(target[k], v)
            else:
                target[k] = v

    def get_actuator_label(self, actuator_id: int) -> str:
        return self.config["actuators"].get(str(actuator_id), f"Actuator {actuator_id}")

    def set_actuator_label(self, actuator_id: int, label: str):
        self.config["actuators"][str(actuator_id)] = label
        self.save()

    def get_sensor_label(self, sensor_id: int) -> str:
        return self.config["sensors"].get(str(sensor_id), f"Sensor {sensor_id}")

    def set_sensor_label(self, sensor_id: int, label: str):
        self.config["sensors"][str(sensor_id)] = label
        self.save()


CONFIG = ConfigManager()

# ============================================================================
# PT Calibration Functions
# ============================================================================


def calculate_pressure(
    adc_code: float, PT_A: float, PT_B: float, PT_C: float, PT_D: float
) -> float:
    """Compute pressure (psi) from ADC code using cubic polynomial."""
    return (PT_A * (adc_code**3)) + (PT_B * (adc_code**2)) + (PT_C * adc_code) + PT_D


def load_pt_calibration_csv(
    csv_path: str,
) -> Dict[int, Tuple[float, float, float, float]]:
    """
    Load PT calibration coefficients from CSV.
    Returns dict: connector_id -> (PT_A, PT_B, PT_C, PT_D)
    """
    result = {}
    if not os.path.isfile(csv_path):
        return result
    try:
        with open(csv_path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            fieldnames = reader.fieldnames or []
        if not rows:
            return result

        # Discover PT numbers from column names
        pt_nums = set()
        for col in fieldnames:
            m = re.match(r"PT(\d+)\s+Coefficient\s+0", col, re.IGNORECASE)
            if m:
                pt_nums.add(int(m.group(1)))

        # Use last row for coefficients
        last = rows[-1]
        for pt_num in sorted(pt_nums):
            a = float(last.get(f"PT{pt_num} Coefficient 0", 0))
            b = float(last.get(f"PT{pt_num} Coefficient 1", 0))
            c = float(last.get(f"PT{pt_num} Coefficient 2", 0))
            d = float(last.get(f"PT{pt_num} Coefficient 3", 0))
            result[pt_num] = (a, b, c, d)
        return result
    except Exception as e:
        print(f"Error loading PT calibration CSV: {e}")
        return result


def load_pt_calibration_json(
    json_path: str,
) -> Dict[int, Tuple[float, float, float, float]]:
    """
    Load PT calibration coefficients from JSON (from calibration GUI).
    Returns dict: sensor_id -> (A, B, C, D) polynomial coefficients
    """
    result = {}
    if not os.path.isfile(json_path):
        return result
    try:
        with open(json_path, "r") as f:
            data = json.load(f)

        # Check if it's the calibration GUI format
        if "calibration_polynomials" in data:
            for sensor_id_str, coeffs in data["calibration_polynomials"].items():
                sensor_id = int(sensor_id_str)
                if len(coeffs) >= 4:
                    # Polynomial coefficients [a, b, c, d] for ax^3 + bx^2 + cx + d
                    result[sensor_id] = (
                        float(coeffs[0]),
                        float(coeffs[1]),
                        float(coeffs[2]),
                        float(coeffs[3]),
                    )
        return result
    except Exception as e:
        print(f"Error loading PT calibration JSON: {e}")
        return result


def load_pt_calibration() -> Dict[int, Tuple[float, float, float, float]]:
    """Load PT calibration from CSV or JSON, preferring JSON from calibration framework"""
    # Try JSON first (from calibration GUI)
    if CALIBRATION_JSON_DIR.exists():
        json_files = list(CALIBRATION_JSON_DIR.glob("*.json"))
        if json_files:
            # Use most recent calibration file
            latest = max(json_files, key=lambda p: p.stat().st_mtime)
            cal = load_pt_calibration_json(str(latest))
            if cal:
                print(f"✅ Loaded PT calibration from {latest}")
                return cal

    # Fall back to CSV
    cal = load_pt_calibration_csv(PT_CALIBRATION_CSV)
    if cal:
        print(f"✅ Loaded PT calibration from CSV: {len(cal)} sensors")
    else:
        print("⚠️  No PT calibration found - pressures will be uncalibrated")
    return cal


# ============================================================================
# UDP Receiver Thread
# ============================================================================


class UDPReceiver(QtCore.QThread):
    """Thread that receives UDP packets and emits decoded sensor data"""

    sensor_data_received = QtCore.pyqtSignal(
        dict, list, str
    )  # header, chunks, source_ip
    status_update = QtCore.pyqtSignal(str)
    packet_received = QtCore.pyqtSignal(int, int)  # packet_size, packet_type

    def __init__(
        self, port: int = DEFAULT_RECEIVE_PORT, bind_address: str = DEFAULT_BIND_ADDRESS
    ):
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
            return {
                "packets": 0,
                "bytes": 0,
                "packets_per_sec": 0.0,
                "bytes_per_sec": 0.0,
            }

        elapsed = time.time() - self.start_time
        if elapsed > 0:
            pps = self.total_packets / elapsed
            bps = self.total_bytes / elapsed
        else:
            pps = 0.0
            bps = 0.0

        return {
            "packets": self.total_packets,
            "bytes": self.total_bytes,
            "packets_per_sec": pps,
            "bytes_per_sec": bps,
            "elapsed": elapsed,
        }

    def run(self):
        """Main receiver loop"""
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.settimeout(0.1)

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

                header = self.parse_packet_header(data)
                if header is None:
                    continue

                packet_type, version, timestamp = header
                self.packet_received.emit(len(data), packet_type)

                if packet_type == PacketType.SENSOR_DATA:
                    result = self.parse_sensor_data_packet(data)
                    if result:
                        header_dict, chunks = result
                        source_ip = addr[0]
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

    def parse_packet_header(self, data: bytes) -> Optional[Tuple[int, int, int]]:
        """Parse the packet header"""
        if len(data) < PACKET_HEADER_SIZE:
            return None
        try:
            packet_type, version, timestamp = struct.unpack(
                PACKET_HEADER_FORMAT, data[:PACKET_HEADER_SIZE]
            )
            return (packet_type, version, timestamp)
        except struct.error:
            return None

    def parse_sensor_data_packet(
        self, data: bytes
    ) -> Optional[Tuple[dict, List[dict]]]:
        """Parse sensor data packet"""
        if len(data) < PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE:
            return None

        header = self.parse_packet_header(data)
        if header is None or header[0] != PacketType.SENSOR_DATA:
            return None

        packet_type, version, timestamp = header

        offset = PACKET_HEADER_SIZE
        try:
            num_chunks, num_sensors = struct.unpack(
                SENSOR_DATA_PACKET_FORMAT,
                data[offset : offset + SENSOR_DATA_PACKET_SIZE],
            )
        except struct.error:
            return None

        offset += SENSOR_DATA_PACKET_SIZE

        per_chunk_size = SENSOR_DATA_CHUNK_SIZE + (num_sensors * SENSOR_DATAPOINT_SIZE)
        expected_size = (
            PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE + (num_chunks * per_chunk_size)
        )

        if len(data) < expected_size:
            return None

        chunks = []
        for chunk_idx in range(num_chunks):
            try:
                (chunk_timestamp,) = struct.unpack(
                    SENSOR_DATA_CHUNK_FORMAT,
                    data[offset : offset + SENSOR_DATA_CHUNK_SIZE],
                )
            except struct.error:
                return None

            offset += SENSOR_DATA_CHUNK_SIZE

            datapoints = []
            for sensor_idx in range(num_sensors):
                try:
                    sensor_id, sensor_data = struct.unpack(
                        SENSOR_DATAPOINT_FORMAT,
                        data[offset : offset + SENSOR_DATAPOINT_SIZE],
                    )
                    datapoints.append({"sensor_id": sensor_id, "data": sensor_data})
                    offset += SENSOR_DATAPOINT_SIZE
                except struct.error:
                    return None

            chunks.append({"timestamp": chunk_timestamp, "datapoints": datapoints})

        header_dict = {
            "packet_type": packet_type,
            "version": version,
            "timestamp": timestamp,
        }

        return (header_dict, chunks)


# ============================================================================
# Elodin Client (from groundstation implementation)
# ============================================================================

from enum import Enum
from dataclasses import dataclass
import threading


class ElodinPacketType(Enum):
    TABLE = 0
    QUERY = 1
    RESPONSE = 2
    COMMAND = 3


@dataclass
class ElodinPacketHeader:
    len: int
    ty: ElodinPacketType
    packet_id: List[int]
    request_id: int


class ElodinClient:
    """Client for communicating with Elodin database"""

    def __init__(self, host: str = "127.0.0.1", port: int = 2240):
        self.host = host
        self.port = port
        self.socket: Optional[socket.socket] = None
        self.connected = False

        # Packet IDs for different message types
        self.PACKET_IDS = {
            "COMMAND": [0xFF, 0x01],
            "PT_DATA": [0x01, 0x00],
            "TC_DATA": [0x02, 0x00],
            "IMU_DATA": [0x03, 0x00],
            "ENGINE_STATUS": [0x10, 0x00],
            "SYSTEM_HEALTH": [0x11, 0x00],
            "VALVE_STATUS": [0x12, 0x00],
            "STATE_MACHINE": [0x20, 0x00],  # State machine commands
        }

    def connect(self) -> bool:
        """Connect to Elodin database"""
        try:
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.socket.settimeout(1.0)
            self.socket.connect((self.host, self.port))
            self.connected = True
            print(f"✅ Connected to Elodin DB at {self.host}:{self.port}")
            return True
        except Exception as e:
            print(f"❌ Failed to connect to Elodin: {e}")
            self.connected = False
            return False

    def disconnect(self):
        """Disconnect from Elodin"""
        if self.socket:
            self.socket.close()
            self.socket = None
        self.connected = False

    def send_state_transition(self, target_state: str) -> bool:
        """Send state transition command to Elodin"""
        if not self.connected:
            return False

        try:
            command_data = {
                "type": "STATE_TRANSITION",
                "target_state": target_state,
                "timestamp": time.time(),
                "source": "fsw_gui",
            }

            payload = json.dumps(command_data).encode("utf-8")
            header = self._create_header(
                ElodinPacketType.COMMAND, self.PACKET_IDS["STATE_MACHINE"], len(payload)
            )

            self.socket.sendall(header + payload)
            return True
        except Exception as e:
            print(f"❌ Failed to send state transition: {e}")
            return False

    def send_actuator_command(self, actuator_id: int, state: int) -> bool:
        """Send actuator command to Elodin"""
        if not self.connected:
            return False

        try:
            command_data = {
                "type": "ACTUATOR_COMMAND",
                "actuator_id": actuator_id,
                "state": state,
                "timestamp": time.time(),
                "source": "fsw_gui",
            }

            payload = json.dumps(command_data).encode("utf-8")
            header = self._create_header(
                ElodinPacketType.COMMAND, self.PACKET_IDS["COMMAND"], len(payload)
            )

            self.socket.sendall(header + payload)
            return True
        except Exception as e:
            print(f"❌ Failed to send actuator command: {e}")
            return False

    def query_telemetry(
        self,
        packet_type: str,
        start_time: Optional[float] = None,
        end_time: Optional[float] = None,
        limit: int = 100,
    ) -> List[Dict]:
        """Query telemetry data from Elodin"""
        if not self.connected:
            return []

        try:
            query_data = {
                "packet_id": self.PACKET_IDS.get(packet_type, [0, 0]),
                "start_time": start_time or (time.time() - 60),
                "end_time": end_time or time.time(),
                "limit": limit,
            }

            payload = json.dumps(query_data).encode("utf-8")
            header = self._create_header(ElodinPacketType.QUERY, [0, 0], len(payload))

            self.socket.sendall(header + payload)

            # Receive response (non-blocking, simplified)
            return []
        except Exception as e:
            print(f"❌ Failed to query telemetry: {e}")
            return []

    def _create_header(
        self, packet_type: ElodinPacketType, packet_id: List[int], payload_length: int
    ) -> bytes:
        """Create Elodin packet header"""
        total_length = 12 + payload_length
        header = struct.pack("<I", total_length)
        header += struct.pack("<B", packet_type.value)
        header += struct.pack("<BB", packet_id[0], packet_id[1])
        header += struct.pack("<I", 0)  # padding
        header += struct.pack("<B", 0)  # request_id
        return header


# ============================================================================
# Pressure Bar Widget (Top Bar)
# ============================================================================


class PressureBarWidget(QtWidgets.QWidget):
    """Vertical bar gauge showing pressure"""

    def __init__(
        self,
        title: str,
        nop: float = 500.0,
        meop: float = 700.0,
        fixed_color: Optional[QtGui.QColor] = None,
        parent=None,
    ):
        super().__init__(parent)
        self.title = title
        self.nop = nop
        self.meop = meop
        self.fixed_color = fixed_color
        self.current_value = 0.0
        self.setMinimumWidth(60)
        self.setMinimumHeight(100)

    def set_value(self, value: float):
        self.current_value = value
        self.update()

    def paintEvent(self, event):
        painter = QtGui.QPainter(self)
        painter.setRenderHint(QtGui.QPainter.RenderHint.Antialiasing)

        w, h = self.width(), self.height()
        top_margin, bottom_margin = 20, 20
        bar_w, bar_x = w - 20, 10
        bar_h = h - top_margin - bottom_margin
        bar_y = top_margin

        # Draw title
        painter.setPen(QtCore.Qt.GlobalColor.white)
        painter.drawText(
            QtCore.QRect(0, 0, w, top_margin),
            QtCore.Qt.AlignmentFlag.AlignCenter,
            self.title,
        )

        # Draw background
        painter.setPen(QtCore.Qt.GlobalColor.gray)
        painter.setBrush(QtGui.QColor(50, 50, 50))
        painter.drawRect(bar_x, bar_y, bar_w, bar_h)

        # Draw fill
        max_val = 1.2 * self.meop if self.meop > 0 else 1.0
        fill_ratio = min(max(self.current_value / max_val, 0.0), 1.0)
        fill_h = int(fill_ratio * bar_h)
        fill_y = bar_y + bar_h - fill_h

        if self.fixed_color:
            painter.setBrush(self.fixed_color)
        else:
            if self.current_value > self.meop:
                painter.setBrush(QtGui.QColor(255, 0, 0))
            elif self.current_value > self.nop:
                painter.setBrush(QtGui.QColor(255, 165, 0))
            else:
                painter.setBrush(QtGui.QColor(0, 255, 0))

        painter.setPen(QtCore.Qt.PenStyle.NoPen)
        painter.drawRect(bar_x, fill_y, bar_w, fill_h)

        # Draw value
        painter.setPen(QtCore.Qt.GlobalColor.white)
        val_str = f"{self.current_value:.0f}"
        painter.drawText(
            QtCore.QRect(0, h - bottom_margin, w, bottom_margin),
            QtCore.Qt.AlignmentFlag.AlignCenter,
            val_str,
        )


# ============================================================================
# Top Bar Widget
# ============================================================================


class TopBarWidget(QtWidgets.QWidget):
    """Top bar with pressure gauges, abort buttons, and state display"""

    navigation_requested = QtCore.pyqtSignal(str)
    abort_requested = QtCore.pyqtSignal()
    emergency_abort_requested = QtCore.pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedHeight(120)
        layout = QtWidgets.QHBoxLayout(self)
        layout.setContentsMargins(10, 5, 10, 5)

        # Pressure bars
        self.bar_gn2 = PressureBarWidget("GN2", fixed_color=QtGui.QColor(0, 255, 0))
        self.bar_eth = PressureBarWidget("ETH", fixed_color=QtGui.QColor(255, 0, 0))
        self.bar_lox = PressureBarWidget("LOX", fixed_color=QtGui.QColor(0, 0, 255))

        layout.addWidget(self.bar_gn2)
        layout.addWidget(self.bar_eth)
        layout.addWidget(self.bar_lox)

        layout.addStretch()

        # Current state display
        self.state_label = QtWidgets.QLabel("CURRENT STATE: ---")
        self.state_label.setStyleSheet(
            "font-size: 14pt; font-weight: bold; color: white; padding: 10px;"
        )
        layout.addWidget(self.state_label)

        layout.addStretch()

        # Buttons
        btn_layout = QtWidgets.QVBoxLayout()

        # Abort buttons
        abort_row = QtWidgets.QHBoxLayout()
        self.btn_abort = QtWidgets.QPushButton("ABORT")
        self.btn_abort.setMinimumSize(120, 40)
        self.btn_abort.setStyleSheet(
            "background-color: orange; font-weight: bold; color: black;"
        )
        self.btn_abort.clicked.connect(self.abort)

        self.btn_emergency = QtWidgets.QPushButton("EMERGENCY")
        self.btn_emergency.setMinimumSize(120, 40)
        self.btn_emergency.setStyleSheet(
            "background-color: red; font-weight: bold; color: white;"
        )
        self.btn_emergency.clicked.connect(self.emergency_abort)

        abort_row.addWidget(self.btn_abort)
        abort_row.addWidget(self.btn_emergency)
        btn_layout.addLayout(abort_row)

        # Settings button
        self.nav_btn = QtWidgets.QPushButton("SETTINGS")
        self.nav_btn.setMinimumHeight(30)
        self.nav_btn.clicked.connect(self.toggle_view)
        btn_layout.addWidget(self.nav_btn)

        layout.addLayout(btn_layout)

    def set_state(self, state: str):
        """Update current state display"""
        self.state_label.setText(f"CURRENT STATE: {state}")

    def abort(self):
        """Handle abort button"""
        self.abort_requested.emit()

    def emergency_abort(self):
        """Handle emergency abort button"""
        self.emergency_abort_requested.emit()

    def toggle_view(self):
        """Toggle settings view"""
        text = self.nav_btn.text()
        if text == "SETTINGS":
            self.navigation_requested.emit("settings")
            self.nav_btn.setText("DASHBOARD")
        else:
            self.navigation_requested.emit("dashboard")
            self.nav_btn.setText("SETTINGS")


# ============================================================================
# State Machine Control Widget
# ============================================================================


class StateMachineWidget(QtWidgets.QWidget):
    """State machine control buttons"""

    state_transition_requested = QtCore.pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.current_state = SystemState.IDLE
        self.init_ui()

    def init_ui(self):
        """Initialize state machine buttons"""
        layout = QtWidgets.QVBoxLayout(self)

        # Title
        title = QtWidgets.QLabel("State Machine Control")
        title.setStyleSheet("font-size: 12pt; font-weight: bold; padding: 5px;")
        layout.addWidget(title)

        # Button rows
        row1 = QtWidgets.QHBoxLayout()
        row2 = QtWidgets.QHBoxLayout()

        # Row 1 buttons
        states_row1 = [
            SystemState.IDLE,
            SystemState.ARMED,
            SystemState.FUEL_FILL,
            SystemState.OX_FILL,
            SystemState.QUICK_FIRE,
            SystemState.GN2_LOW_PRESS,
            SystemState.FUEL_PRESS,
        ]

        # Row 2 buttons
        states_row2 = [
            SystemState.FUEL_VENT,
            SystemState.OX_PRESS,
            SystemState.OX_VENT,
            SystemState.HIGH_PRESS,
            SystemState.GN2_HIGH_VENT,
            SystemState.FIRE,
            SystemState.VENT,
        ]

        self.state_buttons = {}

        for state in states_row1:
            btn = QtWidgets.QPushButton(state)
            btn.setMinimumHeight(35)
            btn.clicked.connect(lambda checked, s=state: self.request_transition(s))
            row1.addWidget(btn)
            self.state_buttons[state] = btn

        for state in states_row2:
            btn = QtWidgets.QPushButton(state)
            btn.setMinimumHeight(35)
            btn.clicked.connect(lambda checked, s=state: self.request_transition(s))
            row2.addWidget(btn)
            self.state_buttons[state] = btn

        layout.addLayout(row1)
        layout.addLayout(row2)
        layout.addStretch()

    def request_transition(self, target_state: str):
        """Request state transition"""
        self.state_transition_requested.emit(target_state)

    def set_current_state(self, state: str):
        """Update current state and highlight button"""
        self.current_state = state
        for state_name, btn in self.state_buttons.items():
            if state_name == state:
                btn.setStyleSheet("background-color: #4CAF50; font-weight: bold;")
            else:
                btn.setStyleSheet("")


# ============================================================================
# Sensor Plot Widget
# ============================================================================


class SensorPlotWidget(QtWidgets.QWidget):
    """Real-time sensor data visualization"""

    def __init__(
        self,
        receiver,
        elodin_client: Optional[ElodinClient] = None,
        bind_address: str = "0.0.0.0",
        parent=None,
    ):
        super().__init__(parent)
        self.receiver = receiver
        self.elodin_client = elodin_client
        self.bind_address = bind_address

        # Data storage
        self.sensor_data: Dict[int, deque] = {}
        self.sensor_adc_codes: Dict[int, deque] = (
            {}
        )  # Store raw ADC codes for calibration
        self.sensor_psi_data: Dict[int, deque] = {}
        self.sensor_plots: Dict[int, pg.PlotDataItem] = {}
        self.sensor_labels: Dict[int, str] = {
            i: CONFIG.get_sensor_label(i) for i in range(1, NUM_SENSORS + 1)
        }

        # PT Calibration
        self.pt_calibration = load_pt_calibration()

        # Filter by source IP (only accept PT board data, not actuator board)
        self.filter_source_ip = CONFIG.config["network"].get(
            "sensor_ip_filter", DEFAULT_SENSOR_IP
        )

        # ADC conversion settings
        self.adc_bits = 32
        self.reference_voltage = 2.5

        # Settings
        self.window_seconds = CONFIG.config["display"]["window_seconds"]
        self.y_axis_auto_scale = CONFIG.config["display"]["y_axis_autoscale"]
        self.y_axis_min = CONFIG.config["display"]["y_axis_min"]
        self.y_axis_max = CONFIG.config["display"]["y_axis_max"]

        self.stats_start_time = time.time()

        self.init_ui()

        # Connect signals
        if receiver:
            self.receiver.sensor_data_received.connect(self.on_sensor_data)
            self.receiver.status_update.connect(self.on_status_update)

        # Timer for updates
        self.update_timer = QtCore.QTimer(self)
        self.update_timer.timeout.connect(self.update_plots)
        self.update_timer.start(UPDATE_INTERVAL_MS)

        # Elodin polling if available
        if self.elodin_client and self.elodin_client.connected:
            self.elodin_timer = QtCore.QTimer(self)
            self.elodin_timer.timeout.connect(self.poll_elodin_data)
            self.elodin_timer.start(100)  # 10 Hz

    def code_to_voltage(self, code_uint32: int) -> float:
        """Convert ADC code to voltage"""
        if code_uint32 >= 0x80000000:
            code_int32 = code_uint32 - 0x100000000
        else:
            code_int32 = code_uint32
        return (code_int32 * self.reference_voltage) / (2 ** (self.adc_bits - 1))

    def init_ui(self):
        """Initialize UI"""
        layout = QtWidgets.QVBoxLayout(self)

        # Top panel
        top_panel = QtWidgets.QHBoxLayout()
        self.status_label = QtWidgets.QLabel("Starting...")
        self.status_label.setStyleSheet("font-weight: bold; padding: 5px;")
        top_panel.addWidget(self.status_label)
        top_panel.addStretch()

        self.auto_scale_checkbox = QtWidgets.QCheckBox("Auto-scale Y-axis")
        self.auto_scale_checkbox.setChecked(self.y_axis_auto_scale)
        self.auto_scale_checkbox.stateChanged.connect(self.on_auto_scale_toggled)
        top_panel.addWidget(self.auto_scale_checkbox)

        layout.addLayout(top_panel)

        # Plot and stats
        plot_stats_layout = QtWidgets.QHBoxLayout()

        # Plot widget
        self.plot_widget = pg.GraphicsLayoutWidget()
        self.plot_widget.setBackground("k")
        plot_stats_layout.addWidget(self.plot_widget, 1)

        # Statistics panel
        stats_widget = QtWidgets.QWidget()
        stats_layout = QtWidgets.QVBoxLayout(stats_widget)

        # Network stats
        network_group = QtWidgets.QGroupBox("Network")
        network_layout = QtWidgets.QVBoxLayout()
        self.packets_label = QtWidgets.QLabel("Packets: 0")
        self.pps_label = QtWidgets.QLabel("Packets/sec: 0.0")
        network_layout.addWidget(self.packets_label)
        network_layout.addWidget(self.pps_label)
        network_group.setLayout(network_layout)
        stats_layout.addWidget(network_group)

        # Sensor stats
        sensor_group = QtWidgets.QGroupBox("Sensors")
        sensor_layout = QtWidgets.QVBoxLayout()
        self.connector_labels = {}
        for i in range(1, NUM_SENSORS + 1):
            label = QtWidgets.QLabel(f"C{i}: --- V")
            color_idx = i % len(SENSOR_COLORS)
            color = SENSOR_COLORS[color_idx]
            label.setStyleSheet(f"color: rgb{color}; padding: 2px;")
            sensor_layout.addWidget(label)
            self.connector_labels[i] = label
        sensor_group.setLayout(sensor_layout)
        stats_layout.addWidget(sensor_group, 1)

        stats_widget.setFixedWidth(200)
        plot_stats_layout.addWidget(stats_widget)
        layout.addLayout(plot_stats_layout, 1)

        # Create plot
        self.plot_item = self.plot_widget.addPlot(title="Pressure Data Over Time")
        self.plot_item.setTitle("Pressure Data Over Time", color="w", size="14pt")
        self.plot_item.setLabel("left", "Pressure (psi)", color="w")
        self.plot_item.setLabel("bottom", "Time (seconds)", color="w")
        self.plot_item.addLegend()
        self.plot_item.showGrid(x=True, y=True, alpha=0.5)
        self.plot_item.getViewBox().setBackgroundColor("k")

        # Style axes
        font = QtGui.QFont()
        font.setPointSize(12)
        left_axis = self.plot_item.getAxis("left")
        bottom_axis = self.plot_item.getAxis("bottom")
        left_axis.setStyle(tickFont=font)
        bottom_axis.setStyle(tickFont=font)
        left_axis.setPen("w")
        bottom_axis.setPen("w")
        left_axis.setTextPen("w")
        bottom_axis.setTextPen("w")

    def on_sensor_data(self, header: dict, chunks: List[dict], source_ip: str):
        """Handle sensor data from UDP or Elodin - ONLY from PT board, not actuator board"""
        # Filter by source IP - only accept PT board data
        if source_ip != self.filter_source_ip:
            return  # Ignore actuator board data (handled separately)

        current_time = time.time()

        for chunk in chunks:
            chunk_timestamp_ms = chunk["timestamp"]
            relative_time = current_time - self.stats_start_time

            for dp in chunk["datapoints"]:
                sensor_id = dp["sensor_id"]
                code_uint32 = dp["data"]

                # Convert to voltage
                voltage = self.code_to_voltage(code_uint32)

                # Initialize if needed
                if sensor_id not in self.sensor_data:
                    self.sensor_data[sensor_id] = deque(maxlen=MAX_POINTS)
                    self.sensor_adc_codes[sensor_id] = deque(maxlen=MAX_POINTS)
                    # Only create PSI storage and plot for calibrated sensors
                    if sensor_id in self.pt_calibration:
                        self.sensor_psi_data[sensor_id] = deque(maxlen=MAX_POINTS)
                        self.add_sensor_plot(sensor_id)

                # Store data
                self.sensor_data[sensor_id].append((relative_time, voltage))
                self.sensor_adc_codes[sensor_id].append((relative_time, code_uint32))

                # Calculate and store PSI if calibration exists
                if sensor_id in self.pt_calibration:
                    a, b, c, d = self.pt_calibration[sensor_id]
                    psi = calculate_pressure(code_uint32, a, b, c, d)
                    self.sensor_psi_data[sensor_id].append((relative_time, psi))

    def add_sensor_plot(self, sensor_id: int):
        """Add plot line for sensor"""
        color_idx = sensor_id % len(SENSOR_COLORS)
        color = SENSOR_COLORS[color_idx]
        pen = pg.mkPen(color=color, width=2)

        label = self.sensor_labels.get(sensor_id, f"Sensor {sensor_id}")
        plot = self.plot_item.plot([], [], pen=pen, name=f"PT {sensor_id}: {label}")
        self.sensor_plots[sensor_id] = plot

    def update_plots(self):
        """Update plot data"""
        current_time = time.time()
        relative_time = current_time - self.stats_start_time

        # Update each sensor plot
        for sensor_id, plot in self.sensor_plots.items():
            if sensor_id in self.sensor_psi_data:
                data = self.sensor_psi_data[sensor_id]
                if len(data) > 0:
                    # Filter to window
                    cutoff_time = relative_time - self.window_seconds
                    filtered_data = [(t, v) for t, v in data if t >= cutoff_time]

                    if filtered_data:
                        times = [t for t, v in filtered_data]
                        values = [v for t, v in filtered_data]
                        plot.setData(times, values)

        # Update Y-axis
        if self.y_axis_auto_scale:
            self.plot_item.enableAutoRange(axis="y")
        else:
            self.plot_item.setYRange(self.y_axis_min, self.y_axis_max)

        # Update statistics
        if self.receiver:
            stats = self.receiver.get_stats()
            self.packets_label.setText(f"Packets: {stats['packets']}")
            self.pps_label.setText(f"Packets/sec: {stats['packets_per_sec']:.1f}")

        # Update sensor labels
        for sensor_id, label_widget in self.connector_labels.items():
            if sensor_id in self.sensor_data and len(self.sensor_data[sensor_id]) > 0:
                voltage = self.sensor_data[sensor_id][-1][1]
                if (
                    sensor_id in self.sensor_psi_data
                    and len(self.sensor_psi_data[sensor_id]) > 0
                ):
                    psi = self.sensor_psi_data[sensor_id][-1][1]
                    label_text = self.sensor_labels.get(sensor_id, "")
                    if label_text:
                        label_widget.setText(
                            f"C{sensor_id}: {label_text}<br/>{voltage:.3f} V<br/>{psi:.2f} psi"
                        )
                    else:
                        label_widget.setText(
                            f"C{sensor_id}: {voltage:.3f} V<br/>{psi:.2f} psi"
                        )
                else:
                    label_widget.setText(f"C{sensor_id}: {voltage:.3f} V")

    def poll_elodin_data(self):
        """Poll Elodin for sensor data"""
        if not self.elodin_client or not self.elodin_client.connected:
            return

        # Query PT data from Elodin
        data = self.elodin_client.query_telemetry("PT_DATA", limit=10)
        for record in data:
            # Parse Elodin record and convert to sensor data format
            # This would need to match your Elodin message format
            pass

    def on_status_update(self, status: str):
        """Handle status updates"""
        self.status_label.setText(status)

    def on_auto_scale_toggled(self, state):
        """Handle auto-scale toggle"""
        self.y_axis_auto_scale = state == QtCore.Qt.CheckState.Checked.value


# ============================================================================
# Actuator Control Widget
# ============================================================================


class ActuatorControlWidget(QtWidgets.QWidget):
    """Actuator control with ON/OFF buttons"""

    actuator_command_sent = QtCore.pyqtSignal(int, int)  # actuator_id, state

    def __init__(
        self,
        receiver,
        elodin_client: Optional[ElodinClient] = None,
        device_ip: str = None,
        device_port: int = None,
        parent=None,
    ):
        super().__init__(parent)
        self.receiver = receiver
        self.elodin_client = elodin_client
        self.device_ip = device_ip or CONFIG.config["network"]["actuator_ip"]
        self.device_port = device_port or CONFIG.config["network"]["actuator_port"]

        # Actuator state tracking
        num_actuators = get_num_actuators()
        self.actuator_states = [0] * num_actuators
        self.voltage_readings = [0.0] * num_actuators
        self.actuator_labels = {
            i: CONFIG.get_actuator_label(i) for i in range(1, num_actuators + 1)
        }

        # UDP socket for direct commands
        self.command_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

        self.init_ui()

        # Connect signals
        if receiver:
            self.receiver.sensor_data_received.connect(self.on_sensor_data)

        # Update timer
        self.update_timer = QtCore.QTimer(self)
        self.update_timer.timeout.connect(self.update_display)
        self.update_timer.start(100)

    def init_ui(self):
        """Initialize UI"""
        layout = QtWidgets.QVBoxLayout(self)

        # Title
        title = QtWidgets.QLabel("Actuator Control")
        title.setStyleSheet("font-size: 12pt; font-weight: bold; padding: 5px;")
        layout.addWidget(title)

        # Grid for actuators - dynamic layout based on count
        grid = QtWidgets.QGridLayout()
        grid.setSpacing(10)

        # Calculate optimal grid layout: use 2-4 columns based on number of actuators
        num_actuators = get_num_actuators()
        if num_actuators <= 8:
            cols = 2
        elif num_actuators <= 16:
            cols = 4
        else:
            cols = 4  # Default to 4 columns for larger numbers

        self.actuator_widgets = []
        for i in range(num_actuators):
            actuator_id = i + 1
            row, col = i // cols, i % cols

            # Frame for each actuator
            frame = QtWidgets.QFrame()
            frame.setFrameShape(QtWidgets.QFrame.Shape.Box)
            frame_layout = QtWidgets.QVBoxLayout(frame)

            # Label
            label_text = self.actuator_labels.get(
                actuator_id, f"Actuator {actuator_id}"
            )
            label = QtWidgets.QLabel(label_text)
            label.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
            label.setStyleSheet("font-weight: bold; font-size: 11pt; padding: 5px;")
            frame_layout.addWidget(label)

            # Buttons
            btn_layout = QtWidgets.QHBoxLayout()

            on_btn = QtWidgets.QPushButton("OPEN")
            on_btn.setMinimumHeight(40)
            on_btn.clicked.connect(
                lambda checked, aid=actuator_id: self.set_actuator_state(aid, 1)
            )

            off_btn = QtWidgets.QPushButton("CLOSED")
            off_btn.setMinimumHeight(40)
            off_btn.clicked.connect(
                lambda checked, aid=actuator_id: self.set_actuator_state(aid, 0)
            )

            btn_layout.addWidget(on_btn)
            btn_layout.addWidget(off_btn)
            frame_layout.addLayout(btn_layout)

            # Voltage display
            voltage_label = QtWidgets.QLabel("1.234 V")
            voltage_label.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
            voltage_label.setStyleSheet("font-size: 10pt; padding: 2px;")
            frame_layout.addWidget(voltage_label)

            self.actuator_widgets.append(
                {
                    "frame": frame,
                    "label": label,
                    "on_btn": on_btn,
                    "off_btn": off_btn,
                    "voltage_label": voltage_label,
                }
            )

            grid.addWidget(frame, row, col)

        layout.addLayout(grid)
        layout.addStretch()

    def set_actuator_state(self, actuator_id: int, state: int):
        """Set actuator state and send command"""
        array_idx = actuator_id - 1
        self.actuator_states[array_idx] = state
        self.update_button_highlight(array_idx, state)

        # Send command via Elodin or UDP
        if self.elodin_client and self.elodin_client.connected:
            self.elodin_client.send_actuator_command(actuator_id, state)
        else:
            # Send UDP command directly
            self.send_udp_command(actuator_id, state)

        self.actuator_command_sent.emit(actuator_id, state)

    def send_actuator_commands_batch(self, commands: List[Tuple[int, int]]):
        """Send multiple actuator commands in a single packet"""
        if not commands:
            return

        # Send via UDP (batch packet)
        try:
            packet = self.create_actuator_command_packet(commands)
            if len(packet) > 0:
                self.command_sock.sendto(packet, (self.device_ip, self.device_port))
                print(f"📤 Sent batch: {len(commands)} actuator commands")
            else:
                print(f"❌ Failed to create batch packet")
        except Exception as e:
            print(f"Failed to send batch commands: {e}")

        # Also send via Elodin if connected
        if self.elodin_client and self.elodin_client.connected:
            for actuator_id, state in commands:
                self.elodin_client.send_actuator_command(actuator_id, state)

        # Emit signals for each command
        for actuator_id, state in commands:
            self.actuator_command_sent.emit(actuator_id, state)

    def send_udp_command(self, actuator_id: int, state: int):
        """Send UDP command to actuator board (exact DiabloAvionics format)"""
        try:
            # Use exact format from combined_gui.py
            commands = [(actuator_id, state)]
            packet = self.create_actuator_command_packet(commands)
            if len(packet) > 0:
                self.command_sock.sendto(packet, (self.device_ip, self.device_port))
            else:
                print(f"Failed to create packet for actuator {actuator_id}")
        except Exception as e:
            print(f"Failed to send UDP command: {e}")

    def create_actuator_command_packet(self, commands: List[Tuple[int, int]]) -> bytes:
        """
        Create an actuator command packet (exact format from DiabloAvionics combined_gui.py).
        commands: List of (actuator_id, actuator_state) tuples
        actuator_id: 1-10 (1-indexed)
        actuator_state: 0 = OFF, non-zero = ON
        """
        if len(commands) == 0 or len(commands) > 255:
            return b""

        # Calculate packet size
        header_size = PACKET_HEADER_SIZE
        body_size = 1  # ACTUATOR_COMMAND_PACKET_SIZE (num_commands byte)
        commands_size = len(commands) * 2  # ACTUATOR_COMMAND_SIZE (2 bytes each)
        total_size = header_size + body_size + commands_size

        if total_size > MAX_PACKET_SIZE:
            return b""

        # Create packet buffer
        packet = bytearray(total_size)
        offset = 0

        # Packet header: <BBI> = packet_type, version, timestamp
        packet_type = PacketType.ACTUATOR_COMMAND
        version = 0
        timestamp = (
            int(time.time() * 1000) & 0xFFFFFFFF
        )  # 32-bit timestamp in milliseconds

        struct.pack_into(
            PACKET_HEADER_FORMAT, packet, offset, packet_type, version, timestamp
        )
        offset += PACKET_HEADER_SIZE

        # Actuator command packet body: num_commands (1 byte)
        num_commands = len(commands)
        struct.pack_into("<B", packet, offset, num_commands)
        offset += 1

        # Actuator commands: <BB> = actuator_id, actuator_state (2 bytes each)
        for actuator_id, actuator_state in commands:
            struct.pack_into("<BB", packet, offset, actuator_id, actuator_state)
            offset += 2

        return bytes(packet)

    def update_button_highlight(self, array_idx: int, state: int):
        """Update button highlighting"""
        widget = self.actuator_widgets[array_idx]
        bg_color = self.palette().color(QtGui.QPalette.ColorRole.Window).name()

        inactive_style = f"QPushButton {{ background-color: {bg_color}; color: #FFFFFF; border: none; border-radius: 5px; padding: 5px; }}"
        active_style = "QPushButton { background-color: #FFFFFF; color: #000000; border: 2px solid #000000; border-radius: 5px; padding: 5px; }"

        if state == 1:
            widget["on_btn"].setStyleSheet(active_style)
            widget["off_btn"].setStyleSheet(inactive_style)
        else:
            widget["on_btn"].setStyleSheet(inactive_style)
            widget["off_btn"].setStyleSheet(active_style)

    def on_sensor_data(self, header: dict, chunks: List[dict], source_ip: str):
        """Update voltage readings from actuator board current sense data"""
        # ONLY process data from actuator board (192.168.2.201)
        if source_ip != self.device_ip:
            return  # Ignore PT board data

        for chunk in chunks:
            for dp in chunk["datapoints"]:
                sensor_id = dp["sensor_id"]  # 0-indexed (0-9) from actuator board
                code_uint32 = dp["data"]

                # Convert to voltage (32-bit ADC, 2.5V reference)
                if code_uint32 >= 0x80000000:
                    code_int32 = code_uint32 - 0x100000000
                else:
                    code_int32 = code_uint32
                voltage = (code_int32 * 2.5) / 2147483648.0

                # Map sensor_id (0-9) to actuator (1-10)
                if 0 <= sensor_id < get_num_actuators():
                    array_idx = sensor_id  # Already 0-indexed
                    self.voltage_readings[array_idx] = voltage

    def update_display(self):
        """Update voltage displays"""
        for i, widget in enumerate(self.actuator_widgets):
            voltage = self.voltage_readings[i]
            widget["voltage_label"].setText(f"{voltage:.3f} V")


# ============================================================================
# Main Window
# ============================================================================


class CombinedFSWMainWindow(QtWidgets.QMainWindow):
    """Main window combining all widgets"""

    def __init__(
        self,
        elodin_host: str = "127.0.0.1",
        elodin_port: int = 2240,
        actuator_ip: str = None,
        actuator_port: int = None,
        receive_port: int = None,
        bind_address: str = None,
    ):
        super().__init__()

        # Elodin client
        self.elodin_client = ElodinClient(elodin_host, elodin_port)
        self.elodin_connected = self.elodin_client.connect()

        # UDP receiver (fallback if Elodin not available)
        receive_port = receive_port or CONFIG.config["network"]["receive_port"]
        bind_address = bind_address or CONFIG.config["network"]["bind_address"]
        self.receiver = UDPReceiver(receive_port, bind_address)

        # Current state
        self.current_state = SystemState.IDLE

        self.init_ui(actuator_ip, actuator_port)

        # Start receiver
        self.receiver.start()

        # State update timer
        self.state_timer = QtCore.QTimer(self)
        self.state_timer.timeout.connect(self.update_state_from_elodin)
        self.state_timer.start(500)  # 0.5 Hz

    def init_ui(self, actuator_ip: str = None, actuator_port: int = None):
        """Initialize UI"""
        self.setWindowTitle("FSW - Sensor & Actuator Control")
        self.setGeometry(100, 100, 1800, 1000)

        # Central widget
        central_widget = QtWidgets.QWidget()
        self.setCentralWidget(central_widget)
        main_layout = QtWidgets.QVBoxLayout(central_widget)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)

        # Top bar
        self.top_bar = TopBarWidget(self)
        self.top_bar.navigation_requested.connect(self.on_navigation)
        self.top_bar.abort_requested.connect(self.on_abort)
        self.top_bar.emergency_abort_requested.connect(self.on_emergency_abort)
        main_layout.addWidget(self.top_bar)

        # Stacked widget for dashboard/settings
        self.stack = QtWidgets.QStackedWidget()

        # Dashboard page
        dashboard_widget = QtWidgets.QWidget()
        dashboard_layout = QtWidgets.QVBoxLayout(dashboard_widget)

        # State machine widget
        self.state_machine_widget = StateMachineWidget(self)
        self.state_machine_widget.state_transition_requested.connect(
            self.on_state_transition
        )
        dashboard_layout.addWidget(self.state_machine_widget)

        # Splitter for sensor plot and actuator control
        splitter = QtWidgets.QSplitter(QtCore.Qt.Orientation.Horizontal)

        # Sensor plot widget
        self.sensor_widget = SensorPlotWidget(
            self.receiver,
            self.elodin_client,
            CONFIG.config["network"]["bind_address"],
            self,
        )

        # Actuator control widget
        self.actuator_widget = ActuatorControlWidget(
            self.receiver, self.elodin_client, actuator_ip, actuator_port, self
        )

        splitter.addWidget(self.sensor_widget)
        splitter.addWidget(self.actuator_widget)
        splitter.setStretchFactor(0, 2)  # Left 66%
        splitter.setStretchFactor(1, 1)  # Right 33%

        dashboard_layout.addWidget(splitter)
        self.stack.addWidget(dashboard_widget)

        main_layout.addWidget(self.stack, 1)

        # Top bar update timer
        self.top_bar_timer = QtCore.QTimer(self)
        self.top_bar_timer.timeout.connect(self.update_top_bar)
        self.top_bar_timer.start(100)

    def on_state_transition(self, target_state: str):
        """Handle state transition request and set actuators accordingly"""
        if self.elodin_client and self.elodin_client.connected:
            self.elodin_client.send_state_transition(target_state)

        # Set actuators based on state machine CSV
        self._set_actuators_for_state(target_state)

        self.current_state = target_state
        self.top_bar.set_state(target_state)
        self.state_machine_widget.set_current_state(target_state)

    def _set_actuators_for_state(self, state: str):
        """Set actuator states based on state machine CSV"""
        if not hasattr(self, "_state_actuator_map"):
            self._load_state_actuator_map()

        # Get actuator commands for this state
        actuator_commands = self._state_actuator_map.get(state, {})

        # Send commands for all actuators
        commands_to_send = []
        for abbrev, gui_state in actuator_commands.items():
            actuator_id = self._abbrev_to_actuator_id(abbrev)
            if actuator_id is None:
                continue

            # Convert GUI state (OPEN/CLOSED) to hardware state (0/1)
            # Account for NC/NO actuator types
            hardware_state = self._gui_state_to_hardware(abbrev, gui_state)

            # Update GUI button state
            if self.actuator_widget:
                array_idx = actuator_id - 1
                if 0 <= array_idx < len(self.actuator_widget.actuator_states):
                    self.actuator_widget.actuator_states[array_idx] = (
                        1 if gui_state == "OPEN" else 0
                    )
                    self.actuator_widget.update_button_highlight(
                        array_idx, self.actuator_widget.actuator_states[array_idx]
                    )

            commands_to_send.append((actuator_id, hardware_state))

        # Send all commands in batch
        if commands_to_send and self.actuator_widget:
            self.actuator_widget.send_actuator_commands_batch(commands_to_send)

    def _load_state_actuator_map(self):
        """Load state machine actuator mapping from CSV"""
        csv_path = (
            Path(__file__).parent.parent.parent
            / "external"
            / "DiabloAvionics"
            / "test_guis"
            / "state_machine_actuators.csv"
        )
        self._state_actuator_map = {}

        if not csv_path.exists():
            print(f"⚠️  State machine CSV not found: {csv_path}")
            return

        try:
            with open(csv_path, "r") as f:
                reader = csv.reader(f)
                header = next(reader)  # Skip header row
                state_names = [
                    s.strip() for s in header[1:] if s.strip()
                ]  # Skip first column

                # Normalize state names to match SystemState enum
                state_name_map = {
                    "Debug": "Debug",
                    "Idle": "Idle",
                    "Armed": "Armed",
                    "Fuel Fill": "Fuel Fill",
                    "Ox Fill": "Ox Fill",
                    "Quick Fire": "Quick Fire",
                    "GN2 Press": "GN2 Low Press",  # Map to SystemState name
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

                # Create normalized state names list
                normalized_state_names = [
                    state_name_map.get(name, name) for name in state_names
                ]

                for row in reader:
                    if not row or row[0].strip() == "":
                        continue
                    abbrev = row[0].strip()
                    for i, state_name in enumerate(normalized_state_names):
                        if i + 1 >= len(row):
                            break
                        gui_state = row[i + 1].strip().upper()
                        if gui_state in ("OPEN", "CLOSE", "CLOSED"):
                            if state_name not in self._state_actuator_map:
                                self._state_actuator_map[state_name] = {}
                            # Normalize: "CLOSE" or "CLOSED" -> "CLOSED"
                            normalized_state = (
                                "OPEN" if gui_state == "OPEN" else "CLOSED"
                            )
                            self._state_actuator_map[state_name][
                                abbrev
                            ] = normalized_state
        except Exception as e:
            print(f"Error loading state machine CSV: {e}")
            self._state_actuator_map = {}

    def _abbrev_to_actuator_id(self, abbrev: str) -> Optional[int]:
        """Map actuator abbreviation to actuator ID from config.toml"""
        # Map from config.toml actuator_abbrev and actuator_roles
        abbrev_map = {
            "FV": "Fuel Vent",  # NC, actuator_id = 2
            "OV": "LOX Vent",  # NC, actuator_id = 6
            "FP": "Fuel Press",  # NC, actuator_id = 3
            "OP": "LOX Press",  # NO, actuator_id = 8
            "FM": "Fuel Main",  # NO, actuator_id = 7
            "OM": "LOX Main",  # NO, actuator_id = 1
        }

        role_name = abbrev_map.get(abbrev)
        if not role_name:
            return None

        # Map role name to actuator ID (from config.toml actuator_roles)
        role_to_id = {
            "LOX Main": 1,
            "Fuel Vent": 2,
            "Fuel Press": 3,
            "GSE Low Vent": 5,
            "LOX Vent": 6,
            "Fuel Main": 7,
            "LOX Press": 8,
            "Fuel Fill Vent": 9,
            "Fuel Fill Press": 10,
        }

        return role_to_id.get(role_name)

    def _gui_state_to_hardware(self, abbrev: str, gui_state: str) -> int:
        """Convert GUI state (OPEN/CLOSED) to hardware state (0/1) accounting for NC/NO"""
        # Map actuator type (NC/NO) from config.toml
        abbrev_to_type = {
            "FV": "NC",  # Fuel Vent - NC
            "OV": "NC",  # LOX Vent - NC
            "FP": "NC",  # Fuel Press - NC
            "OP": "NO",  # LOX Press - NO
            "FM": "NO",  # Fuel Main - NO
            "OM": "NO",  # LOX Main - NO
        }

        actuator_type = abbrev_to_type.get(abbrev, "NC")
        is_open = gui_state == "OPEN"

        if actuator_type == "NO":
            # NO: OPEN (1) -> hardware OFF (0), CLOSED (0) -> hardware ON (1)
            return 0 if is_open else 1
        else:
            # NC: OPEN (1) -> hardware ON (1), CLOSED (0) -> hardware OFF (0)
            return 1 if is_open else 0

    def on_abort(self):
        """Handle abort"""
        self.on_state_transition(SystemState.ABORT)

    def on_emergency_abort(self):
        """Handle emergency abort"""
        self.on_state_transition(SystemState.ABORT)
        # Could add additional emergency actions here

    def on_navigation(self, view_name: str):
        """Handle navigation"""
        if view_name == "settings":
            # TODO: Add settings widget
            pass
        else:
            self.stack.setCurrentIndex(0)

    def update_state_from_elodin(self):
        """Query current state from Elodin"""
        if self.elodin_client and self.elodin_client.connected:
            # Query state machine status from Elodin
            # This would need to match your Elodin message format
            pass

    def update_top_bar(self):
        """Update top bar pressure gauges"""
        gauge_map = CONFIG.config["mappings"]
        for gauge, sensor_id in gauge_map.items():
            if sensor_id > 0 and sensor_id in self.sensor_widget.sensor_psi_data:
                data = self.sensor_widget.sensor_psi_data[sensor_id]
                if len(data) > 0:
                    val = data[-1][1]  # Latest PSI value
                    if gauge == "GN2":
                        self.top_bar.bar_gn2.set_value(val)
                    elif gauge == "ETH":
                        self.top_bar.bar_eth.set_value(val)
                    elif gauge == "LOX":
                        self.top_bar.bar_lox.set_value(val)

    def closeEvent(self, event):
        """Handle window close"""
        self.receiver.stop()
        if self.elodin_client:
            self.elodin_client.disconnect()
        event.accept()


# ============================================================================
# Main Entry Point
# ============================================================================


def main():
    """Main entry point"""
    app = QtWidgets.QApplication(sys.argv)

    # Force Fusion style and dark palette
    app.setStyle("Fusion")
    palette = QtGui.QPalette()
    palette.setColor(
        QtGui.QPalette.ColorGroup.All,
        QtGui.QPalette.ColorRole.Window,
        QtGui.QColor(53, 53, 53),
    )
    palette.setColor(
        QtGui.QPalette.ColorGroup.All,
        QtGui.QPalette.ColorRole.WindowText,
        QtCore.Qt.GlobalColor.white,
    )
    palette.setColor(
        QtGui.QPalette.ColorGroup.All,
        QtGui.QPalette.ColorRole.Base,
        QtGui.QColor(25, 25, 25),
    )
    palette.setColor(
        QtGui.QPalette.ColorGroup.All,
        QtGui.QPalette.ColorRole.Text,
        QtCore.Qt.GlobalColor.white,
    )
    palette.setColor(
        QtGui.QPalette.ColorGroup.All,
        QtGui.QPalette.ColorRole.Button,
        QtGui.QColor(53, 53, 53),
    )
    palette.setColor(
        QtGui.QPalette.ColorGroup.All,
        QtGui.QPalette.ColorRole.ButtonText,
        QtCore.Qt.GlobalColor.white,
    )
    app.setPalette(palette)

    # Create main window
    window = CombinedFSWMainWindow()
    window.showMaximized()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
