#!/usr/bin/env python3
"""
Simple ADC Plotter GUI
- Reads packets from serial (83 samples × 3 channels × READINGS_PER_MUX readings)
- Plots voltage values for connectors 1, 2, 3
- Requirements: pip install pyqt6 pyqtgraph pyserial numpy
"""

import sys
import struct
import time
import csv
import os
from collections import deque
from datetime import datetime

from PyQt6 import QtCore, QtGui, QtWidgets
import pyqtgraph as pg
import numpy as np
import serial
import serial.tools.list_ports

# Import shared config - ensure this matches adc_config.h in the firmware
# Get the directory where this script is located
_script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _script_dir)
from adc_config import READINGS_PER_MUX

pg.setConfigOptions(antialias=False)

# ---------------------- Protocol constants ----------------------
# NOTE: READINGS_PER_MUX is imported from adc_config.py - must match adc_config.h in firmware
MAGIC = b"AD26"
MAGIC_SIZE = 4
SAMPLES_PER_BUFFER = 20  # Reduced from 83 to make packets smaller and less bursty
NUM_CHANNELS = 3
# READINGS_PER_MUX is imported from adc_config.py above

# Data structure sizes
BYTES_PER_TIMESTAMP = 4  # uint32_t in microseconds
BYTES_PER_READING_VALUE = 4  # int32_t ADC reading
BYTES_PER_READING = BYTES_PER_TIMESTAMP + BYTES_PER_READING_VALUE  # 8 bytes total per reading

# Buffer size calculation
DATA_SIZE = SAMPLES_PER_BUFFER * NUM_CHANNELS * READINGS_PER_MUX * BYTES_PER_READING
BUFFER_SIZE = MAGIC_SIZE + DATA_SIZE

# ADC conversion constants
ADC_SCALE = 2147483648.0  # 2^31
DEFAULT_V_REF = 5.0  # Default full-scale voltage (V)

BAUD = 115200
DEFAULT_WINDOW_SECONDS = 10.0
MAX_POINTS = 10000

# Colors for the 3 channels
CHANNEL_COLORS = [
    (255, 80, 80),    # Red - Connector 1
    (80, 255, 80),    # Green - Connector 2
    (80, 150, 255),   # Blue - Connector 3
]

CHANNEL_NAMES = ["Conn 1", "Conn 2", "Conn 3"]


def list_ports():
    return [p.device for p in serial.tools.list_ports.comports()]


# ---------------------- Serial reader thread ----------------------
class Reader(QtCore.QThread):
    samples_ready = QtCore.pyqtSignal(list)  # Emits list of (ch, timestamp_us, volts) tuples for a packet
    status = QtCore.pyqtSignal(str)
    raw_bytes = QtCore.pyqtSignal(bytes)

    def __init__(self, port: str, baud: int, v_ref: float = DEFAULT_V_REF):
        super().__init__()
        self.port = port
        self.baud = baud
        self.v_ref = v_ref  # Full-scale voltage for ADC conversion
        self._stop = False
        self.buf = bytearray()
        self.ser = None
        self.packets_received = 0
        self.total_samples = 0

    def stop(self):
        self._stop = True
        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass

    def _find_and_parse_packets(self):
        """Find magic bytes and parse complete packets"""
        parsed_samples = []
        
        while True:
            # Find magic header
            idx = self.buf.find(MAGIC)
            if idx == -1:
                # Keep last 3 bytes in case magic is split across reads
                if len(self.buf) > 3:
                    del self.buf[:-3]
                break
            
            # Discard bytes before magic
            if idx > 0:
                del self.buf[:idx]
            
            # Check if we have a complete packet
            if len(self.buf) < BUFFER_SIZE:
                break
            
            # Extract packet data (skip magic)
            data = bytes(self.buf[MAGIC_SIZE:BUFFER_SIZE])
            
            # Parse all samples from this packet
            # Each sample has NUM_CHANNELS channels, each channel has READINGS_PER_MUX readings
            # Each reading has: BYTES_PER_TIMESTAMP (timestamp) + BYTES_PER_READING_VALUE (reading)
            for sample_idx in range(SAMPLES_PER_BUFFER):
                # Base offset for this sample
                sample_base = sample_idx * NUM_CHANNELS * READINGS_PER_MUX * BYTES_PER_READING
                for ch in range(NUM_CHANNELS):
                    # Base offset for this channel
                    channel_base = sample_base + ch * READINGS_PER_MUX * BYTES_PER_READING
                    # Read all readings for this channel
                    for reading_idx in range(READINGS_PER_MUX):
                        offset = channel_base + reading_idx * BYTES_PER_READING
                        # Extract timestamp (uint32_t, microseconds)
                        timestamp_us = struct.unpack_from("<I", data, offset)[0]
                        # Extract reading (int32_t)
                        raw = struct.unpack_from("<i", data, offset + BYTES_PER_TIMESTAMP)[0]
                        volts = raw * self.v_ref / ADC_SCALE
                        parsed_samples.append((ch, timestamp_us, volts))
            
            self.packets_received += 1
            self.total_samples += len(parsed_samples)
            
            # Remove processed packet
            del self.buf[:BUFFER_SIZE]
        
        return parsed_samples

    def run(self):
        try:
            self.ser = serial.Serial(self.port, self.baud, timeout=0.05)
            self.status.emit(f"Connected {self.port} @ {self.baud}")
        except Exception as e:
            self.status.emit(f"Open failed: {e}")
            return

        last_status_time = time.monotonic()
        
        while not self._stop:
            try:
                data = self.ser.read(self.ser.in_waiting or 1)
                if data:
                    self.raw_bytes.emit(data)
                    self.buf.extend(data)
                    
                    parsed = self._find_and_parse_packets()
                    if parsed:
                        self.samples_ready.emit(parsed)
                    
                    # Periodic status update
                    now = time.monotonic()
                    if now - last_status_time >= 0.5:
                        self.status.emit(f"Reader: {self.packets_received} pkts, {self.total_samples} samples, buf={len(self.buf)}B")
                        last_status_time = now
                        
            except serial.SerialException as e:
                self.status.emit(f"Serial error: {e}")
                break
            except Exception as e:
                self.status.emit(f"Unexpected: {e}")
                break

        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass
        self.status.emit("Disconnected")


# ---------------------- Settings window ----------------------
class SettingsWindow(QtWidgets.QDialog):
    def __init__(self, parent):
        super().__init__(parent)
        self.parent_app = parent
        self.setWindowTitle("Settings")
        self.resize(360, 200)

        layout = QtWidgets.QVBoxLayout(self)
        
        # Window seconds
        layout.addWidget(QtWidgets.QLabel("Viewing window (seconds)"))
        row = QtWidgets.QHBoxLayout()
        self.slider = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.slider.setMinimum(1)
        self.slider.setMaximum(60)
        self.slider.setValue(int(self.parent_app.window_seconds))
        self.slider.valueChanged.connect(self._on_change)
        self.lbl = QtWidgets.QLabel(f"{self.parent_app.window_seconds:.1f}s")
        row.addWidget(self.slider, 1)
        row.addWidget(self.lbl)
        layout.addLayout(row)

        # Max voltage (Y-axis range)
        layout.addWidget(QtWidgets.QLabel("Max voltage (V) - Y-axis range"))
        row2 = QtWidgets.QHBoxLayout()
        self.slider_maxv = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.slider_maxv.setMinimum(5)
        self.slider_maxv.setMaximum(100)
        self.slider_maxv.setValue(int(self.parent_app.max_v * 10))
        self.slider_maxv.valueChanged.connect(self._on_change_maxv)
        self.lbl_maxv = QtWidgets.QLabel(f"{self.parent_app.max_v:.1f} V")
        row2.addWidget(self.slider_maxv, 1)
        row2.addWidget(self.lbl_maxv)
        layout.addLayout(row2)

        # ADC Full-scale voltage
        layout.addWidget(QtWidgets.QLabel("ADC Full-scale voltage (V)"))
        row3 = QtWidgets.QHBoxLayout()
        self.slider_vref = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.slider_vref.setMinimum(10)  # 1.0V (in 0.1V steps)
        self.slider_vref.setMaximum(100)  # 10.0V
        self.slider_vref.setValue(int(self.parent_app.v_ref * 10))
        self.slider_vref.valueChanged.connect(self._on_change_vref)
        self.lbl_vref = QtWidgets.QLabel(f"{self.parent_app.v_ref:.1f} V")
        row3.addWidget(self.slider_vref, 1)
        row3.addWidget(self.lbl_vref)
        layout.addLayout(row3)

        btn = QtWidgets.QPushButton("Close")
        btn.clicked.connect(self.accept)
        layout.addWidget(btn)

    def _on_change(self, val):
        self.parent_app.window_seconds = float(val)
        self.lbl.setText(f"{float(val):.1f}s")

    def _on_change_maxv(self, val):
        self.parent_app.max_v = float(val) / 10.0
        self.lbl_maxv.setText(f"{self.parent_app.max_v:.1f} V")

    def _on_change_vref(self, val):
        self.parent_app.v_ref = float(val) / 10.0
        self.lbl_vref.setText(f"{self.parent_app.v_ref:.1f} V")
        # Update reader's v_ref if it exists
        if self.parent_app.reader is not None:
            self.parent_app.reader.v_ref = self.parent_app.v_ref

    def _on_change_vref(self, val):
        self.parent_app.v_ref = float(val) / 10.0
        self.lbl_vref.setText(f"{self.parent_app.v_ref:.1f} V")
        # Update reader's v_ref if it exists
        if self.parent_app.reader is not None:
            self.parent_app.reader.v_ref = self.parent_app.v_ref


# ---------------------- Actuator Control Window ----------------------
class ActuatorControlWindow(QtWidgets.QDialog):
    actuator_status = QtCore.pyqtSignal(int, str)  # index, state
    actuator_list = QtCore.pyqtSignal(list)  # list of actuator names
    
    def __init__(self, parent):
        super().__init__(parent)
        self.parent_app = parent
        self.setWindowTitle("Actuator Control")
        self.resize(600, 500)
        
        self.actuator_names = []
        self.actuator_states = {}  # index -> state
        self.actuator_sensors = {}  # index -> sensor_value
        self.serial_port = None
        self.serial_reader = None
        
        layout = QtWidgets.QVBoxLayout(self)
        
        # Connection section
        conn_group = QtWidgets.QGroupBox("Connection")
        conn_layout = QtWidgets.QHBoxLayout()
        conn_layout.addWidget(QtWidgets.QLabel("Port:"))
        self.cmb_actuator_port = QtWidgets.QComboBox()
        self._refresh_ports()
        conn_layout.addWidget(self.cmb_actuator_port)
        
        self.btn_actuator_connect = QtWidgets.QPushButton("Connect")
        self.btn_actuator_connect.clicked.connect(self._toggle_actuator_connection)
        conn_layout.addWidget(self.btn_actuator_connect)
        
        btn_refresh = QtWidgets.QPushButton("Refresh")
        btn_refresh.clicked.connect(self._refresh_ports)
        conn_layout.addWidget(btn_refresh)
        conn_group.setLayout(conn_layout)
        layout.addWidget(conn_group)
        
        # Status label
        self.lbl_actuator_status = QtWidgets.QLabel("Not connected")
        self.lbl_actuator_status.setWordWrap(True)
        layout.addWidget(self.lbl_actuator_status)
        
        # Actuator controls (will be populated when connected)
        self.actuator_scroll = QtWidgets.QScrollArea()
        self.actuator_scroll.setWidgetResizable(True)
        self.actuator_widget = QtWidgets.QWidget()
        self.actuator_layout = QtWidgets.QVBoxLayout(self.actuator_widget)
        self.actuator_scroll.setWidget(self.actuator_widget)
        layout.addWidget(self.actuator_scroll, 1)
        
        # Actuator control widgets storage
        self.actuator_controls = {}  # index -> {name_label, state_label, btn_off, btn_low, btn_high}
        
        # Connect signals - actuator_list is a signal that will be emitted when we receive the list
        # Use QueuedConnection to ensure thread safety
        self.actuator_list.connect(self._on_actuator_list_received, QtCore.Qt.ConnectionType.QueuedConnection)
        self.actuator_status.connect(self._on_status_update, QtCore.Qt.ConnectionType.QueuedConnection)
        
    def _refresh_ports(self):
        ports = list_ports()
        self.cmb_actuator_port.clear()
        self.cmb_actuator_port.addItems(ports)
        if ports:
            self.cmb_actuator_port.setCurrentIndex(0)
    
    def _toggle_actuator_connection(self):
        if self.serial_port is None:
            port = self.cmb_actuator_port.currentText().strip()
            if not port:
                self.lbl_actuator_status.setText("Please select a port")
                return
            self._connect_actuator(port)
        else:
            self._disconnect_actuator()
    
    def _connect_actuator(self, port):
        try:
            # Open serial port with short timeout for responsive reading
            self.serial_port = serial.Serial(port, 115200, timeout=0.1)
            time.sleep(2)  # Wait for ESP32 to boot
            
            # Clear any startup messages
            if self.serial_port.in_waiting > 0:
                self.serial_port.reset_input_buffer()
            
            # Start reader thread - passes the open port
            self.serial_reader = ActuatorSerialReader(self.serial_port, self)
            self.serial_reader.line_received.connect(self._on_line_received, QtCore.Qt.ConnectionType.QueuedConnection)
            self.serial_reader.start()
            
            print("[DEBUG] Serial reader thread started")
            time.sleep(0.5)
            
            # Request actuator list
            QtCore.QTimer.singleShot(500, self._request_actuator_list)
            
            self.btn_actuator_connect.setText("Disconnect")
            self.lbl_actuator_status.setText(f"Connected to {port}. Requesting actuator list...")
        except Exception as e:
            error_msg = f"Connection failed: {e}"
            print(f"[ERROR] {error_msg}")
            self.lbl_actuator_status.setText(error_msg)
            if self.serial_port:
                try:
                    self.serial_port.close()
                except:
                    pass
            self.serial_port = None
    
    def _disconnect_actuator(self):
        if self.serial_reader:
            self.serial_reader.stop()
            self.serial_reader.wait(2000)
            self.serial_reader = None
        
        if self.serial_port:
            try:
                self.serial_port.close()
            except:
                pass
            self.serial_port = None
        
        self.btn_actuator_connect.setText("Connect")
        self.lbl_actuator_status.setText("Disconnected")
        self._clear_actuator_controls()
    
    def _request_actuator_list(self):
        """Request actuator list"""
        try:
            if self.serial_port is None or not self.serial_port.is_open:
                print("[ERROR] Serial port not available")
                return
            
            cmd = b"REQ:ACTUATORS\n"
            print(f"[DEBUG] Sending: {cmd}")
            
            bytes_written = self.serial_port.write(cmd)
            print(f"[DEBUG] Sent {bytes_written} bytes")
                
        except Exception as e:
            print(f"[ERROR] Error requesting actuator list: {e}")
            import traceback
            traceback.print_exc()
    
    def _on_actuator_list_received(self, names):
        print(f"[DEBUG] _on_actuator_list_received called with: {names}")  # Debug output
        self.actuator_names = names
        self._create_actuator_controls()
        self.lbl_actuator_status.setText(f"Found {len(names)} actuator(s). Requesting status...")
        
        # Request initial status with delay to avoid sending too fast
        QtCore.QTimer.singleShot(300, self._request_status)
    
    def _request_status(self):
        """Request status"""
        try:
            if self.serial_port is None or not self.serial_port.is_open:
                print("[ERROR] Serial port not available")
                return
                
            cmd = b"REQ:STATUS\n"
            bytes_written = self.serial_port.write(cmd)
            print(f"[DEBUG] Sent: {cmd.decode().strip()} ({bytes_written} bytes)")
            
        except Exception as e:
            print(f"[ERROR] Error requesting status: {e}")
            import traceback
            traceback.print_exc()
    
    def _create_actuator_controls(self):
        self._clear_actuator_controls()
        
        for i, name in enumerate(self.actuator_names):
            group = QtWidgets.QGroupBox(f"Actuator {i}: {name}")
            group_layout = QtWidgets.QVBoxLayout()
            
            # Status label
            state_label = QtWidgets.QLabel("Status: Unknown")
            state_label.setStyleSheet("font-weight: bold; font-size: 12pt;")
            group_layout.addWidget(state_label)
            
            # Sensor reading label
            sensor_label = QtWidgets.QLabel("Sensor: -- V")
            sensor_label.setStyleSheet("font-size: 10pt; color: #0066cc;")
            group_layout.addWidget(sensor_label)
            
            # Control buttons
            btn_layout = QtWidgets.QHBoxLayout()
            btn_off = QtWidgets.QPushButton("OFF")
            btn_off.setStyleSheet("background-color: #cccccc;")
            btn_off.clicked.connect(lambda checked, idx=i: self._send_command(idx, "OFF"))
            
            btn_low = QtWidgets.QPushButton("LOW")
            btn_low.setStyleSheet("background-color: #ffaa00;")
            btn_low.clicked.connect(lambda checked, idx=i: self._send_command(idx, "LOW"))
            
            btn_high = QtWidgets.QPushButton("HIGH")
            btn_high.setStyleSheet("background-color: #ff0000;")
            btn_high.clicked.connect(lambda checked, idx=i: self._send_command(idx, "HIGH"))
            
            btn_layout.addWidget(btn_off)
            btn_layout.addWidget(btn_low)
            btn_layout.addWidget(btn_high)
            group_layout.addLayout(btn_layout)
            
            group.setLayout(group_layout)
            self.actuator_layout.addWidget(group)
            
            self.actuator_controls[i] = {
                'name_label': None,
                'state_label': state_label,
                'sensor_label': sensor_label,
                'btn_off': btn_off,
                'btn_low': btn_low,
                'btn_high': btn_high
            }
        
        self.actuator_layout.addStretch()
    
    def _clear_actuator_controls(self):
        for i in reversed(range(self.actuator_layout.count())):
            item = self.actuator_layout.itemAt(i)
            if item.widget():
                item.widget().deleteLater()
        self.actuator_controls.clear()
        self.actuator_states.clear()
        self.actuator_sensors.clear()
    
    def _send_command(self, index, state):
        try:
            if self.serial_port is None or not self.serial_port.is_open:
                error_msg = "Serial port not available"
                print(f"[ERROR] {error_msg}")
                self.lbl_actuator_status.setText(error_msg)
                return
            
            cmd = f"ACTUATE:{index}:{state}\n"
            bytes_written = self.serial_port.write(cmd.encode())
            self.lbl_actuator_status.setText(f"Sent: {cmd.strip()}")
            print(f"[DEBUG] Sent command: {cmd.strip()} ({bytes_written} bytes)")
            
        except Exception as e:
            error_msg = f"Error sending command: {e}"
            print(f"[ERROR] {error_msg}")
            import traceback
            traceback.print_exc()
            self.lbl_actuator_status.setText(error_msg)
    
    def _on_status_received(self, status_dict):
        # status_dict is {index: (state, sensor_value)} or {index: state} for backward compatibility
        for index, value in status_dict.items():
            if isinstance(value, tuple):
                state, sensor_value = value
                self.actuator_states[index] = state
                self.actuator_sensors[index] = sensor_value
            else:
                # Backward compatibility: just state
                self.actuator_states[index] = value
                if index not in self.actuator_sensors:
                    self.actuator_sensors[index] = 0.0
            self._update_actuator_display(index, self.actuator_states.get(index, "UNKNOWN"))
    
    def _on_status_update(self, index, state):
        self.actuator_states[index] = state
        self._update_actuator_display(index, state)
    
    def _update_actuator_display(self, index, state):
        if index not in self.actuator_controls:
            return
        
        controls = self.actuator_controls[index]
        controls['state_label'].setText(f"Status: {state}")
        
        # Update sensor reading if available
        sensor_value = self.actuator_sensors.get(index, 0.0)
        controls['sensor_label'].setText(f"Sensor: {sensor_value:.3f} V")
        
        # Update button styles to show active state
        color_map = {
            'OFF': '#cccccc',
            'LOW': '#ffaa00',
            'HIGH': '#ff0000'
        }
        
        for btn_name in ['btn_off', 'btn_low', 'btn_high']:
            btn = controls[btn_name]
            if btn_name == f'btn_{state.lower()}':
                btn.setStyleSheet(f"background-color: {color_map[state]}; font-weight: bold;")
            else:
                btn.setStyleSheet(f"background-color: {color_map[btn_name.split('_')[1].upper()]};")
    
    def _on_line_received(self, line):
        # Parse protocol responses
        if not isinstance(line, str):
            line = str(line)
        line = line.strip()
        # Remove any carriage returns
        line = line.replace('\r', '').strip()
        
        print(f"[DEBUG] _on_line_received: '{line}' (len={len(line)})")  # Debug output
        
        # Check for actuator list response
        if line.startswith("RESP:ACTUATORS:"):
            # Parse actuator list: RESP:ACTUATORS:name1,name2,name3
            names_str = line.replace("RESP:ACTUATORS:", "", 1)  # Only replace first occurrence
            names = [n.strip() for n in names_str.split(",") if n.strip()]
            print(f"[DEBUG] Parsed actuator names: {names}")  # Debug output
            if names:
                # Emit signal which will trigger _on_actuator_list_received
                print(f"[DEBUG] Emitting actuator_list signal with {len(names)} names: {names}")
                self.actuator_list.emit(names)
            else:
                print(f"[DEBUG] WARNING: No actuator names parsed! names_str='{names_str}'")
        # Also check for debug messages that might interfere
        elif line.startswith("[CMD]") or line.startswith("[DEBUG]") or line.startswith("[SENSOR]"):
            # Just log debug messages, don't process them
            print(f"[ESP32 DEBUG] {line}")
        # Check for other responses
        elif line.startswith("STATUS:RESP:"):
            # Parse status: STATUS:RESP:0:OFF:1.234,1:LOW:2.345,2:HIGH:3.456
            # Format: index:state:sensor_value
            status_str = line.replace("STATUS:RESP:", "")
            status_dict = {}
            for pair in status_str.split(","):
                parts = pair.split(":")
                if len(parts) >= 2:
                    try:
                        idx = int(parts[0])
                        state = parts[1].strip()
                        sensor_value = float(parts[2]) if len(parts) >= 3 else 0.0
                        status_dict[idx] = (state, sensor_value)
                    except (ValueError, IndexError):
                        # Try backward compatibility: just index:state
                        try:
                            idx = int(parts[0])
                            state = parts[1].strip()
                            status_dict[idx] = (state, 0.0)
                        except (ValueError, IndexError):
                            pass
            if status_dict:
                self._on_status_received(status_dict)
    
    def closeEvent(self, event):
        self._disconnect_actuator()
        super().closeEvent(event)


# ---------------------- Actuator Serial Reader Thread ----------------------
class ActuatorSerialReader(QtCore.QThread):
    """Reader thread for actuator serial port - receives the open serial port"""
    line_received = QtCore.pyqtSignal(str)
    
    def __init__(self, serial_port, parent=None):
        super().__init__(parent)
        self.serial_port = serial_port
        self._stop = False
    
    def stop(self):
        self._stop = True
    
    def run(self):
        buffer = ""
        print("[DEBUG] Actuator reader thread run() started")
        
        while not self._stop:
            try:
                if self.serial_port is None or not self.serial_port.is_open:
                    print("[DEBUG] Serial port closed, exiting reader thread")
                    break
                
                # Read available data - same pattern as ADC reader
                data = self.serial_port.read(self.serial_port.in_waiting or 1)
                if data:
                    buffer += data.decode('utf-8', errors='ignore')
                    
                    # Limit buffer size
                    if len(buffer) > 4096:
                        buffer = buffer[-2048:]
                    
                    # Process complete lines
                    while '\n' in buffer:
                        line, buffer = buffer.split('\n', 1)
                        line = line.strip().replace('\r', '').strip()
                        if line:
                            print(f"[DEBUG] ActuatorReader received: '{line}'")
                            self.line_received.emit(line)
                        
            except serial.SerialException as e:
                print(f"[ERROR] Serial exception in reader: {e}")
                break
            except Exception as e:
                print(f"[ERROR] Actuator reader error: {e}")
                import traceback
                traceback.print_exc()
                break
        
        print("[DEBUG] Actuator reader thread exiting")


# ---------------------- Raw console window ----------------------
class ConsoleWindow(QtWidgets.QDialog):
    def __init__(self, parent):
        super().__init__(parent)
        self.setWindowTitle("Raw Serial Console")
        self.resize(800, 500)
        self.reader = None  # Will be set by parent

        top = QtWidgets.QHBoxLayout()
        self.chk_pause = QtWidgets.QCheckBox("Pause")
        self.chk_hex = QtWidgets.QCheckBox("Hex View")
        btn_clear = QtWidgets.QPushButton("Clear")
        btn_clear.clicked.connect(self._clear)
        top.addWidget(self.chk_pause)
        top.addWidget(self.chk_hex)
        top.addWidget(btn_clear)
        top.addStretch(1)

        self.text = QtWidgets.QPlainTextEdit()
        self.text.setReadOnly(True)
        font = QtGui.QFontDatabase.systemFont(QtGui.QFontDatabase.SystemFont.FixedFont)
        font.setPointSize(10)
        self.text.setFont(font)

        # Send input section
        send_layout = QtWidgets.QHBoxLayout()
        send_layout.addWidget(QtWidgets.QLabel("Send:"))
        self.input_field = QtWidgets.QLineEdit()
        self.input_field.setPlaceholderText("Enter message to send...")
        self.input_field.returnPressed.connect(self._send_message)
        send_layout.addWidget(self.input_field, 1)
        
        self.chk_send_hex = QtWidgets.QCheckBox("Hex")
        send_layout.addWidget(self.chk_send_hex)
        
        btn_send = QtWidgets.QPushButton("Send")
        btn_send.clicked.connect(self._send_message)
        send_layout.addWidget(btn_send)

        layout = QtWidgets.QVBoxLayout(self)
        layout.addLayout(top)
        layout.addWidget(self.text, 1)
        layout.addLayout(send_layout)

    def set_reader(self, reader):
        """Set the reader object to access serial port"""
        self.reader = reader

    def _clear(self):
        self.text.clear()

    def _send_message(self):
        """Send message over serial"""
        if self.reader is None or self.reader.ser is None or not self.reader.ser.is_open:
            self.text.appendPlainText("[ERROR] Not connected to serial port")
            return
        
        message = self.input_field.text()
        if not message:
            return
        
        try:
            if self.chk_send_hex.isChecked():
                # Try to parse as hex
                try:
                    # Remove spaces and common separators
                    hex_str = message.replace(" ", "").replace("-", "").replace(":", "")
                    # Convert hex string to bytes
                    data = bytes.fromhex(hex_str)
                except ValueError as e:
                    self.text.appendPlainText(f"[ERROR] Invalid hex: {e}")
                    return
            else:
                # Send as text (add newline if not present)
                if not message.endswith('\n'):
                    message += '\n'
                data = message.encode('utf-8')
            
            self.reader.ser.write(data)
            self.reader.ser.flush()
            
            # Display sent message in console
            if self.chk_hex.isChecked():
                display = data.hex(' ')
            else:
                display = data.decode("utf-8", errors="replace").rstrip('\n\r')
            self.text.appendPlainText(f"[SENT] {display}")
            
            # Clear input field
            self.input_field.clear()
        except Exception as e:
            self.text.appendPlainText(f"[ERROR] Send failed: {e}")

    @QtCore.pyqtSlot(bytes)
    def on_bytes(self, data: bytes):
        if self.chk_pause.isChecked():
            return
        try:
            if self.chk_hex.isChecked():
                s = data.hex(' ')
            else:
                s = data.decode("utf-8", errors="replace")
            self.text.appendPlainText(s)
        except Exception:
            pass


# ---------------------- Main application window ----------------------
class App(QtWidgets.QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("ADC Plotter - Simple Test")
        self.resize(1280, 740)

        self.window_seconds = DEFAULT_WINDOW_SECONDS
        self.console_win = None
        self.actuator_win = None
        self.autoscale = True
        self.max_v = 2.5
        self.v_ref = DEFAULT_V_REF  # Full-scale voltage for ADC conversion

        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        root = QtWidgets.QVBoxLayout(central)

        # Top bar
        top = QtWidgets.QHBoxLayout()
        top.addWidget(QtWidgets.QLabel("Port"))
        self.cmb_port = QtWidgets.QComboBox()
        self._refresh_port_list()
        top.addWidget(self.cmb_port)

        top.addWidget(QtWidgets.QLabel("Baud"))
        self.cmb_baud = QtWidgets.QComboBox()
        self.cmb_baud.addItems([str(b) for b in [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]])
        self.cmb_baud.setCurrentText(str(BAUD))
        top.addWidget(self.cmb_baud)

        btn_refresh = QtWidgets.QPushButton("Refresh")
        btn_refresh.clicked.connect(self._refresh_port_list)
        top.addWidget(btn_refresh)
        
        self.btn_connect = QtWidgets.QPushButton("Connect")
        self.btn_connect.clicked.connect(self._toggle_connect)
        top.addWidget(self.btn_connect)

        btn_settings = QtWidgets.QPushButton("Settings")
        btn_settings.clicked.connect(self._open_settings)
        top.addWidget(btn_settings)
        
        btn_console = QtWidgets.QPushButton("Console")
        btn_console.clicked.connect(self._open_console)
        top.addWidget(btn_console)

        btn_actuator = QtWidgets.QPushButton("Actuator Control")
        btn_actuator.clicked.connect(self._open_actuator_control)
        top.addWidget(btn_actuator)

        btn_export = QtWidgets.QPushButton("Download as CSV")
        btn_export.clicked.connect(self._export_csv)
        top.addWidget(btn_export)

        self.chk_autoscale = QtWidgets.QCheckBox("Autoscale Y")
        self.chk_autoscale.setChecked(True)
        self.chk_autoscale.stateChanged.connect(self._on_autoscale)
        top.addWidget(self.chk_autoscale)

        top.addStretch(1)
        root.addLayout(top)

        # Main split: plot on left, controls on right
        main = QtWidgets.QHBoxLayout()
        root.addLayout(main, 1)

        # Plot
        self.plot = pg.PlotWidget()
        self.plot.setLabel("bottom", "Time", units="s")
        self.plot.setLabel("left", "Voltage", units="V")
        self.plot.showGrid(x=True, y=True, alpha=0.3)
        self.plot.setTitle("ADC Readings - Connectors 1, 2, 3")
        self.plot.setClipToView(True)
        self.plot.setDownsampling(mode='peak')
        self.plot.setMouseEnabled(x=True, y=True)
        self.legend = self.plot.addLegend(labelTextSize="10pt")
        main.addWidget(self.plot, 1)

        # Right panel
        right = QtWidgets.QVBoxLayout()
        main.addLayout(right)

        # Channel toggles
        right.addWidget(QtWidgets.QLabel("Show channels:"))
        self.chk = {}
        self.curves = {}
        for ch in range(NUM_CHANNELS):
            cb = QtWidgets.QCheckBox(CHANNEL_NAMES[ch])
            cb.setChecked(True)
            cb.stateChanged.connect(self._on_toggle)
            right.addWidget(cb)
            self.chk[ch] = cb
            color = CHANNEL_COLORS[ch]
            pen = pg.mkPen(color=color, width=2)
            self.curves[ch] = self.plot.plot([], [], name=CHANNEL_NAMES[ch], pen=pen)

        # Statistics box
        box = QtWidgets.QGroupBox("Statistics")
        form = QtWidgets.QVBoxLayout(box)
        
        self.lbl_sps = QtWidgets.QLabel("SPS: n/a")
        form.addWidget(self.lbl_sps)
        
        form.addWidget(self._hline())
        form.addWidget(QtWidgets.QLabel("Mean voltage (last 100 ms):"))
        
        self.per_ch = {}
        for ch in range(NUM_CHANNELS):
            lbl = QtWidgets.QLabel(f"{CHANNEL_NAMES[ch]}: n/a")
            form.addWidget(lbl)
            self.per_ch[ch] = lbl
        right.addWidget(box)

        # Status box
        status_box = QtWidgets.QGroupBox("Status")
        status_layout = QtWidgets.QVBoxLayout(status_box)
        self.lbl_status = QtWidgets.QLabel("Idle")
        self.lbl_status.setWordWrap(True)
        status_layout.addWidget(self.lbl_status)
        right.addWidget(status_box)
        right.addStretch(1)

        # Data storage
        self.t0_us = None  # First timestamp in microseconds (from Arduino)
        self.test_start_time = None  # When the test/connection started (for filename)
        self.sample_count = 0
        self.packets_received = 0
        self.t = {ch: deque(maxlen=MAX_POINTS) for ch in range(NUM_CHANNELS)}
        self.v = {ch: deque(maxlen=MAX_POINTS) for ch in range(NUM_CHANNELS)}
        
        # For SPS and PPS calculation - use longer window and exponential moving average for stability
        self.last_sps_time = None
        self.last_sps_count = 0
        self.last_pps_count = 0  # Packet count for PPS calculation
        self.sps_window_seconds = 3.0  # Use 3 second window for more stable calculation
        self.sps_ema = None  # Exponential moving average of SPS
        self.pps_ema = None  # Exponential moving average of PPS
        self.sps_ema_alpha = 0.3  # Smoothing factor (0-1, lower = more smoothing)

        # Timer for plot updates - only update when needed
        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self._update_plot)
        self.timer.start(100)  # Reduced frequency from 50ms to 100ms
        self._plot_needs_update = False  # Flag to skip updates when no data

        # Serial reader holder
        self.reader = None

    def _hline(self):
        line = QtWidgets.QFrame()
        line.setFrameShape(QtWidgets.QFrame.Shape.HLine)
        line.setFrameShadow(QtWidgets.QFrame.Shadow.Sunken)
        return line

    def _refresh_port_list(self):
        ports = list_ports()
        self.cmb_port.clear()
        self.cmb_port.addItems(ports)
        if ports:
            self.cmb_port.setCurrentIndex(0)

    def set_status(self, text):
        self.lbl_status.setText(text)

    def _toggle_connect(self):
        if self.reader is None:
            port = self.cmb_port.currentText().strip()
            try:
                baud = int(self.cmb_baud.currentText())
            except Exception:
                self.set_status("Bad baud")
                return
            self._connect(port, baud)
            self.btn_connect.setText("Disconnect")
            # Update console reader reference
            if self.console_win is not None:
                self.console_win.set_reader(self.reader)
        else:
            self.reader.stop()
            self.reader = None
            self.set_status("Disconnected")
            self.btn_connect.setText("Connect")
            # Update console reader reference
            if self.console_win is not None:
                self.console_win.set_reader(None)

    def _connect(self, port, baud):
        self.t0_us = None
        self.test_start_time = datetime.now()  # Record when test started
        self.sample_count = 0
        self.packets_received = 0
        self.last_sps_time = None
        self.last_sps_count = 0
        self.last_pps_count = 0
        self.sps_ema = None  # Reset EMA on reconnect
        self.pps_ema = None  # Reset PPS EMA on reconnect
        for ch in range(NUM_CHANNELS):
            self.t[ch].clear()
            self.v[ch].clear()

        self.reader = Reader(port, baud, self.v_ref)
        self.reader.samples_ready.connect(self._on_samples, QtCore.Qt.ConnectionType.QueuedConnection)
        self.reader.status.connect(self.set_status, QtCore.Qt.ConnectionType.QueuedConnection)
        self.reader.raw_bytes.connect(self._on_raw_bytes, QtCore.Qt.ConnectionType.QueuedConnection)
        self.reader.start()

    @QtCore.pyqtSlot(list)
    def _on_samples(self, samples):
        """Handle batch of samples from a packet"""
        if not samples:
            return
        
        self.packets_received += 1
        
        # Initialize timing on first sample
        if self.t0_us is None and samples:
            # Use the first timestamp as reference
            _, first_timestamp_us, _ = samples[0]
            self.t0_us = first_timestamp_us
            self.last_sps_time = time.monotonic()
            self.last_sps_count = 0
            self.last_pps_count = 0
            self.sps_ema = None  # Reset EMA on first sample
            self.pps_ema = None  # Reset PPS EMA on first sample
            self.sps_ema = None  # Reset EMA on first sample
        
        # Process each sample with its actual timestamp
        for ch, timestamp_us, volts in samples:
            # Convert microseconds to seconds relative to first timestamp
            t_rel = (timestamp_us - self.t0_us) / 1_000_000.0
            
            self.t[ch].append(t_rel)
            self.v[ch].append(volts)
            self.sample_count += 1
        
        # Mark that plot needs update
        self._plot_needs_update = True

    @QtCore.pyqtSlot(bytes)
    def _on_raw_bytes(self, data: bytes):
        if self.console_win is not None:
            self.console_win.on_bytes(data)

    def _on_toggle(self):
        # Trigger plot update when channel visibility changes
        self._plot_needs_update = True

    def _update_plot(self):
        # Early exit if no data and no update needed
        has_data = any(len(self.t.get(ch, [])) > 0 for ch in range(NUM_CHANNELS))
        if not has_data and not self._plot_needs_update:
            return
        
        self._plot_needs_update = False
        
        # Update curves - only convert to list if we have data
        for ch, cb in self.chk.items():
            if cb.isChecked():
                t_data = self.t.get(ch, [])
                v_data = self.v.get(ch, [])
                if t_data and v_data:
                    # Only convert to list if we have data
                    self.curves[ch].setData(list(t_data), list(v_data))
                else:
                    self.curves[ch].setData([], [])
            else:
                self.curves[ch].setData([], [])

        # Calculate latest time across all channels
        latest = 0.0
        for ch in range(NUM_CHANNELS):
            if self.chk[ch].isChecked() and self.t.get(ch):
                latest = max(latest, self.t[ch][-1])
        
        if has_data:
            xmin = max(0.0, latest - self.window_seconds)
            self.plot.setXRange(xmin, max(xmin + 1e-3, latest), padding=0)

            # Y limits - only calculate if we have data
            if self.autoscale:
                values = []
                for ch in range(NUM_CHANNELS):
                    if self.chk[ch].isChecked():
                        v_data = self.v.get(ch, [])
                        if v_data:
                            values.extend(v_data)
                if values:
                    vmin, vmax = min(values), max(values)
                    if vmax == vmin:
                        pad = 0.1 if vmax == 0 else abs(vmax) * 0.1
                        self.plot.setYRange(vmin - pad, vmax + pad, padding=0)
                    else:
                        rng = vmax - vmin
                        self.plot.setYRange(vmin - 0.1 * rng, vmax + 0.1 * rng, padding=0)
            else:
                self.plot.setYRange(0.0, float(self.max_v) + 0.1, padding=0)

        # SPS and PPS calculation - use longer window and exponential moving average for stability
        now = time.monotonic()
        if self.last_sps_time is not None:
            elapsed = now - self.last_sps_time
            # Use longer window (3 seconds) for more stable calculation
            if elapsed >= self.sps_window_seconds:
                # Calculate samples per second
                samples_delta = self.sample_count - self.last_sps_count
                current_sps = samples_delta / elapsed
                
                # Apply exponential moving average for smoother display
                if self.sps_ema is None:
                    self.sps_ema = current_sps
                else:
                    self.sps_ema = self.sps_ema_alpha * current_sps + (1 - self.sps_ema_alpha) * self.sps_ema
                
                # Calculate packets per second
                packets_delta = self.packets_received - self.last_pps_count
                current_pps = packets_delta / elapsed
                
                # Apply exponential moving average for PPS
                if self.pps_ema is None:
                    self.pps_ema = current_pps
                else:
                    self.pps_ema = self.sps_ema_alpha * current_pps + (1 - self.sps_ema_alpha) * self.pps_ema
                
                # Show more info including data points per channel
                pts = [len(self.t[ch]) for ch in range(NUM_CHANNELS)]
                self.lbl_sps.setText(f"SPS: {self.sps_ema:.1f} | PPS: {self.pps_ema:.1f} | Pkts: {self.packets_received} | Pts: {pts}")
                self.last_sps_time = now
                self.last_sps_count = self.sample_count
                self.last_pps_count = self.packets_received

        # Per-channel mean voltage (last 100ms) - only if we have data
        if has_data:
            for ch in range(NUM_CHANNELS):
                if not self.chk[ch].isChecked():
                    self.per_ch[ch].setText(f"{CHANNEL_NAMES[ch]}: n/a")
                    continue
                
                ts = self.t.get(ch, [])
                vs = self.v.get(ch, [])
                if ts and vs:
                    cutoff = latest - 0.1  # Last 100ms
                    # More efficient: iterate backwards since we want recent data
                    recent = []
                    for i in range(len(ts) - 1, -1, -1):
                        if ts[i] >= cutoff:
                            recent.append(vs[i])
                        else:
                            break
                    if recent:
                        mean_v = sum(recent) / len(recent)
                        self.per_ch[ch].setText(f"{CHANNEL_NAMES[ch]}: {mean_v:.4f} V")
                    else:
                        self.per_ch[ch].setText(f"{CHANNEL_NAMES[ch]}: n/a")
                else:
                    self.per_ch[ch].setText(f"{CHANNEL_NAMES[ch]}: n/a")
        else:
            # No data - just set n/a for all
            for ch in range(NUM_CHANNELS):
                self.per_ch[ch].setText(f"{CHANNEL_NAMES[ch]}: n/a")

    def _open_settings(self):
        dlg = SettingsWindow(self)
        dlg.exec()

    def _open_console(self):
        if self.console_win is None or not self.console_win.isVisible():
            self.console_win = ConsoleWindow(self)
        # Update reader reference in case it changed
        self.console_win.set_reader(self.reader)
        self.console_win.show()
        self.console_win.raise_()
        self.console_win.activateWindow()
    
    def _open_actuator_control(self):
        if self.actuator_win is None or not self.actuator_win.isVisible():
            self.actuator_win = ActuatorControlWindow(self)
        self.actuator_win.show()
        self.actuator_win.raise_()
        self.actuator_win.activateWindow()

    def _on_autoscale(self):
        self.autoscale = self.chk_autoscale.isChecked()
        self._plot_needs_update = True
        self._update_plot()

    def _export_csv(self):
        """Export current data to CSV file"""
        # Check if we have any data
        total_points = sum(len(self.t[ch]) for ch in range(NUM_CHANNELS))
        if total_points == 0:
            QtWidgets.QMessageBox.warning(self, "No Data", "No data available to export.")
            return
        
        # Generate default filename with test start time, or current time if test hasn't started
        if self.test_start_time:
            timestamp = self.test_start_time.strftime("%Y%m%d_%H%M%S")
        else:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        default_filename = f"adc_data_{timestamp}.csv"
        
        # Open file dialog
        filename, _ = QtWidgets.QFileDialog.getSaveFileName(
            self,
            "Save CSV File",
            default_filename,
            "CSV Files (*.csv);;All Files (*)"
        )
        
        if not filename:
            return  # User cancelled
        
        try:
            with open(filename, 'w', newline='', encoding='utf-8') as csvfile:
                writer = csv.writer(csvfile)
                
                # Write header with single time column and all channels
                header = ["Time (s)"]
                for ch in range(NUM_CHANNELS):
                    header.append(f"{CHANNEL_NAMES[ch]} (V)")
                writer.writerow(header)
                
                # Use first channel's timestamps as the reference time
                # All channels should have the same number of samples since they're sampled together
                time_ref = list(self.t[0]) if len(self.t[0]) > 0 else []
                max_points = max(len(self.t[ch]) for ch in range(NUM_CHANNELS))
                
                # Write data row by row with single time column
                for i in range(max_points):
                    row = []
                    
                    # Use first channel's time, or empty if not available
                    if i < len(time_ref):
                        row.append(f"{time_ref[i]:.6f}")
                    else:
                        row.append("")
                    
                    # Add voltage for each channel
                    for ch in range(NUM_CHANNELS):
                        if i < len(self.v[ch]):
                            row.append(f"{self.v[ch][i]:.6f}")
                        else:
                            row.append("")
                    
                    writer.writerow(row)
            
            # Count actual data points
            points_per_channel = [len(self.t[ch]) for ch in range(NUM_CHANNELS)]
            QtWidgets.QMessageBox.information(
                self,
                "Export Successful",
                f"Data exported successfully to:\n{filename}\n\n"
                f"Points per channel: {points_per_channel}"
            )
        except Exception as e:
            QtWidgets.QMessageBox.critical(
                self,
                "Export Failed",
                f"Failed to export data:\n{str(e)}"
            )

    def closeEvent(self, event: QtGui.QCloseEvent):
        try:
            if self.reader is not None:
                self.reader.stop()
                self.reader.wait(500)
        except Exception:
            pass
        super().closeEvent(event)


# ---------------------- Entry point ----------------------
def main():
    app = QtWidgets.QApplication(sys.argv)
    pg.setConfigOptions(antialias=False)
    w = App()
    w.show()
    try:
        sys.exit(app.exec())
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
