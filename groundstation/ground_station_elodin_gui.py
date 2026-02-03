#!/usr/bin/env python3
"""
Diablo FSW Ground Station GUI - Elodin Integrated Version

Architecture:
- Commands sent to Elodin DB (logged as command messages)
- FSW reads commands from Elodin
- FSW writes all telemetry to Elodin
- GUI reads telemetry from Elodin (real-time and historical)
- Everything tracked in database for validation/replay
"""

import sys
import socket
import struct
import json
import time
import threading
import queue
from enum import Enum
from dataclasses import dataclass
from typing import Optional, Dict, List, Callable, Any
from collections import deque
from datetime import datetime

from PyQt6 import QtCore, QtGui, QtWidgets
import pyqtgraph as pg
import numpy as np

# Configure pyqtgraph
pg.setConfigOptions(antialias=True)


# ============================================================================
# Elodin Protocol (matching your existing implementation)
# ============================================================================

class PacketType(Enum):
    """Elodin packet types"""
    TABLE = 0
    QUERY = 1
    RESPONSE = 2
    COMMAND = 3  # New: for ground station commands


@dataclass
class PacketHeader:
    """Elodin packet header"""
    len: int
    ty: PacketType
    packet_id: List[int]  # [2] array
    request_id: int


class ElodinClient:
    """Client for communicating with Elodin database"""
    
    def __init__(self, host: str = "127.0.0.1", port: int = 2240):
        self.host = host
        self.port = port
        self.socket: Optional[socket.socket] = None
        self.connected = False
        
        # Packet IDs for different message types (matching dbConfig.hpp)
        self.PACKET_IDS = {
            'COMMAND': [0xFF, 0x01],           # Ground station commands
            'PT_DATA': [0x01, 0x00],           # Pressure transducer data
            'TC_DATA': [0x02, 0x00],           # Thermocouple data
            'IMU_DATA': [0x03, 0x00],          # IMU data
            'ENGINE_STATUS': [0x10, 0x00],     # Engine status
            'SYSTEM_HEALTH': [0x11, 0x00],     # System health
            'VALVE_STATUS': [0x12, 0x00],      # Valve positions
        }
    
    def connect(self) -> bool:
        """Connect to Elodin database"""
        try:
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
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
        print("🔌 Disconnected from Elodin")
    
    def send_command(self, command_type: str, parameters: Dict[str, float]):
        """
        Send command to Elodin database
        FSW will read commands from the database
        """
        if not self.connected:
            return False
        
        try:
            # Create command message
            command_data = {
                'type': command_type,
                'parameters': parameters,
                'timestamp': time.time(),
                'source': 'ground_station'
            }
            
            # Serialize to JSON
            payload = json.dumps(command_data).encode('utf-8')
            
            # Create Elodin packet header
            header = self._create_header(
                packet_type=PacketType.COMMAND,
                packet_id=self.PACKET_IDS['COMMAND'],
                payload_length=len(payload)
            )
            
            # Send packet
            self.socket.sendall(header + payload)
            
            print(f"📤 Sent command to Elodin: {command_type}")
            return True
            
        except Exception as e:
            print(f"❌ Failed to send command: {e}")
            return False
    
    def query_telemetry(self, packet_type: str, start_time: Optional[float] = None, 
                       end_time: Optional[float] = None, limit: int = 1000) -> List[Dict]:
        """
        Query telemetry data from Elodin database
        Returns list of telemetry records
        """
        if not self.connected:
            return []
        
        try:
            # Create query message
            query_data = {
                'packet_id': self.PACKET_IDS.get(packet_type, [0, 0]),
                'start_time': start_time or (time.time() - 60),  # Last 60 seconds
                'end_time': end_time or time.time(),
                'limit': limit
            }
            
            # Serialize to JSON
            payload = json.dumps(query_data).encode('utf-8')
            
            # Create Elodin packet header
            header = self._create_header(
                packet_type=PacketType.QUERY,
                packet_id=[0, 0],  # Query packet
                payload_length=len(payload)
            )
            
            # Send query
            self.socket.sendall(header + payload)
            
            # Receive response
            response_header = self.socket.recv(12)
            if len(response_header) < 12:
                return []
            
            # Parse header
            response_len = struct.unpack('<I', response_header[0:4])[0]
            
            # Receive payload
            payload_data = b""
            while len(payload_data) < (response_len - 12):
                chunk = self.socket.recv(min(4096, response_len - 12 - len(payload_data)))
                if not chunk:
                    break
                payload_data += chunk
            
            # Parse response
            response = json.loads(payload_data.decode('utf-8'))
            return response.get('data', [])
            
        except Exception as e:
            print(f"❌ Failed to query telemetry: {e}")
            return []
    
    def subscribe_realtime(self, packet_types: List[str], callback: Callable):
        """
        Subscribe to real-time telemetry updates from Elodin
        Uses streaming/polling approach
        """
        def poll_loop():
            last_timestamps = {pt: time.time() for pt in packet_types}
            
            while self.connected:
                for packet_type in packet_types:
                    # Query for new data since last timestamp
                    data = self.query_telemetry(
                        packet_type=packet_type,
                        start_time=last_timestamps[packet_type],
                        limit=100
                    )
                    
                    if data:
                        callback(packet_type, data)
                        # Update last timestamp
                        if data:
                            last_timestamps[packet_type] = max(
                                d.get('timestamp', last_timestamps[packet_type]) 
                                for d in data
                            )
                
                time.sleep(0.1)  # 10 Hz polling
        
        thread = threading.Thread(target=poll_loop, daemon=True)
        thread.start()
    
    def _create_header(self, packet_type: PacketType, packet_id: List[int], 
                      payload_length: int) -> bytes:
        """Create Elodin packet header"""
        total_length = 12 + payload_length  # Header + payload
        
        header = struct.pack('<I',  # len (4 bytes)
                           total_length)
        header += struct.pack('<B',  # ty (1 byte)
                            packet_type.value)
        header += struct.pack('<BB',  # packet_id (2 bytes)
                            packet_id[0], packet_id[1])
        header += struct.pack('<I',  # reserved/padding (4 bytes)
                            0)
        header += struct.pack('<B',  # request_id (1 byte)
                            0)
        
        return header


# ============================================================================
# Command Types (matching FSW)
# ============================================================================

class CommandType(Enum):
    """Command types for FSW control"""
    ENGINE_START = "ENGINE_START"
    ENGINE_STOP = "ENGINE_STOP"
    ENGINE_ABORT = "ENGINE_ABORT"
    SET_THRUST = "SET_THRUST"
    SET_MIXTURE_RATIO = "SET_MIXTURE_RATIO"
    VALVE_CONTROL = "VALVE_CONTROL"
    STATE_TRANSITION = "STATE_TRANSITION"
    CALIBRATION_START = "CALIBRATION_START"
    CONFIG_UPDATE = "CONFIG_UPDATE"
    SYSTEM_RESET = "SYSTEM_RESET"


class EngineState(Enum):
    """Engine state machine states"""
    INITIALIZATION = 0
    STANDBY = 1
    PRE_IGNITION_CHECKS = 3
    IGNITION_PREP = 5
    IGNITION_SEQUENCE = 6
    STEADY_STATE = 10
    SHUTDOWN_SEQUENCE = 13
    ABORT = 15


# ============================================================================
# Ground Station GUI (Elodin Integrated)
# ============================================================================

class ElodinGroundStationGUI(QtWidgets.QMainWindow):
    """Ground Station GUI with Elodin integration"""
    
    # Qt signals
    telemetry_received = QtCore.pyqtSignal(str, list)
    connection_status_changed = QtCore.pyqtSignal(bool)
    
    def __init__(self):
        super().__init__()
        
        # Elodin client
        self.elodin = ElodinClient()
        
        # Data buffers for plotting
        self.plot_data: Dict[str, Dict[str, deque]] = {}
        self.max_buffer_size = 1000
        
        # Current state
        self.current_engine_state = EngineState.INITIALIZATION
        self.current_thrust = 0.0
        
        # Setup GUI
        self.setWindowTitle("Diablo FSW - Ground Station (Elodin Integrated)")
        self.setGeometry(100, 100, 1800, 1000)
        
        self._setup_ui()
        self._setup_connections()
        
        # Update timer
        self.update_timer = QtCore.QTimer()
        self.update_timer.timeout.connect(self._update_displays)
        self.update_timer.start(100)  # 10 Hz
    
    def _setup_ui(self):
        """Setup user interface"""
        central_widget = QtWidgets.QWidget()
        self.setCentralWidget(central_widget)
        
        main_layout = QtWidgets.QHBoxLayout(central_widget)
        
        # Left panel: Commands
        left_panel = self._create_command_panel()
        main_layout.addWidget(left_panel, stretch=1)
        
        # Right panel: Telemetry from Elodin
        right_panel = self._create_telemetry_panel()
        main_layout.addWidget(right_panel, stretch=2)
    
    def _create_command_panel(self) -> QtWidgets.QWidget:
        """Create command panel"""
        panel = QtWidgets.QWidget()
        layout = QtWidgets.QVBoxLayout(panel)
        
        # Connection controls
        conn_group = QtWidgets.QGroupBox("🔌 Elodin Connection")
        conn_layout = QtWidgets.QVBoxLayout(conn_group)
        
        self.host_input = QtWidgets.QLineEdit("127.0.0.1")
        self.port_input = QtWidgets.QSpinBox()
        self.port_input.setRange(1024, 65535)
        self.port_input.setValue(2240)
        
        conn_form = QtWidgets.QFormLayout()
        conn_form.addRow("Host:", self.host_input)
        conn_form.addRow("Port:", self.port_input)
        conn_layout.addLayout(conn_form)
        
        self.connect_btn = QtWidgets.QPushButton("Connect to Elodin")
        self.connect_btn.clicked.connect(self._toggle_connection)
        conn_layout.addWidget(self.connect_btn)
        
        self.status_label = QtWidgets.QLabel("Status: Disconnected")
        self.status_label.setStyleSheet("color: red; font-weight: bold;")
        conn_layout.addWidget(self.status_label)
        
        layout.addWidget(conn_group)
        
        # Info label
        info_label = QtWidgets.QLabel(
            "📊 Commands → Elodin DB → FSW\n"
            "📡 FSW → Elodin DB → GUI\n"
            "All data logged in database"
        )
        info_label.setStyleSheet("color: #888; font-size: 10px; padding: 10px;")
        layout.addWidget(info_label)
        
        # State machine controls
        state_group = QtWidgets.QGroupBox("🎯 State Machine Commands")
        state_layout = QtWidgets.QVBoxLayout(state_group)
        
        state_buttons = [
            ("STANDBY", EngineState.STANDBY),
            ("PRE-IGN CHECKS", EngineState.PRE_IGNITION_CHECKS),
            ("IGNITION PREP", EngineState.IGNITION_PREP),
            ("START IGNITION", EngineState.IGNITION_SEQUENCE),
            ("STEADY STATE", EngineState.STEADY_STATE),
            ("SHUTDOWN", EngineState.SHUTDOWN_SEQUENCE),
        ]
        
        for label, state in state_buttons:
            btn = QtWidgets.QPushButton(label)
            btn.clicked.connect(lambda checked, s=state: self._send_state_transition(s))
            state_layout.addWidget(btn)
        
        # Emergency controls
        self.abort_btn = QtWidgets.QPushButton("⚠️ ABORT")
        self.abort_btn.setStyleSheet("background-color: red; color: white; font-weight: bold;")
        self.abort_btn.clicked.connect(self._send_abort)
        state_layout.addWidget(self.abort_btn)
        
        layout.addWidget(state_group)
        
        # Engine controls
        engine_group = QtWidgets.QGroupBox("🚀 Engine Control")
        engine_layout = QtWidgets.QVBoxLayout(engine_group)
        
        # Thrust slider
        thrust_layout = QtWidgets.QFormLayout()
        self.thrust_slider = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.thrust_slider.setRange(0, 100)
        self.thrust_slider.setValue(0)
        self.thrust_slider.valueChanged.connect(self._thrust_changed)
        self.thrust_value_label = QtWidgets.QLabel("0%")
        thrust_layout.addRow("Thrust:", self.thrust_slider)
        thrust_layout.addRow("", self.thrust_value_label)
        engine_layout.addLayout(thrust_layout)
        
        # Engine buttons
        engine_btn_layout = QtWidgets.QHBoxLayout()
        self.engine_start_btn = QtWidgets.QPushButton("Start")
        self.engine_start_btn.clicked.connect(self._send_engine_start)
        engine_btn_layout.addWidget(self.engine_start_btn)
        
        self.engine_stop_btn = QtWidgets.QPushButton("Stop")
        self.engine_stop_btn.clicked.connect(self._send_engine_stop)
        engine_btn_layout.addWidget(self.engine_stop_btn)
        
        engine_layout.addLayout(engine_btn_layout)
        
        layout.addWidget(engine_group)
        
        # Valve controls
        valve_group = QtWidgets.QGroupBox("🔧 Valve Control")
        valve_layout = QtWidgets.QVBoxLayout(valve_group)
        
        self.valve_sliders = {}
        for i, name in enumerate(["LOX Main", "Fuel Main", "LOX Purge", "Fuel Purge"]):
            slider_layout = QtWidgets.QHBoxLayout()
            label = QtWidgets.QLabel(f"{name}:")
            slider = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
            slider.setRange(0, 100)
            slider.setValue(0)
            value_label = QtWidgets.QLabel("0%")
            send_btn = QtWidgets.QPushButton("Set")
            send_btn.clicked.connect(lambda checked, vid=i, s=slider: self._send_valve_command(vid, s.value()))
            
            slider.valueChanged.connect(lambda val, lbl=value_label: lbl.setText(f"{val}%"))
            
            slider_layout.addWidget(label)
            slider_layout.addWidget(slider)
            slider_layout.addWidget(value_label)
            slider_layout.addWidget(send_btn)
            
            valve_layout.addLayout(slider_layout)
            self.valve_sliders[i] = slider
        
        layout.addWidget(valve_group)
        
        layout.addStretch()
        
        return panel
    
    def _create_telemetry_panel(self) -> QtWidgets.QWidget:
        """Create telemetry panel (reads from Elodin)"""
        panel = QtWidgets.QWidget()
        layout = QtWidgets.QVBoxLayout(panel)
        
        # Status display
        status_group = QtWidgets.QGroupBox("📡 Live Status (from Elodin DB)")
        status_layout = QtWidgets.QGridLayout(status_group)
        
        self.engine_state_display = QtWidgets.QLabel("Engine: INIT")
        self.thrust_display = QtWidgets.QLabel("Thrust: 0.0 N")
        self.pressure_display = QtWidgets.QLabel("Chamber: 0.0 PSI")
        self.temperature_display = QtWidgets.QLabel("Temp: 0.0 °C")
        
        status_layout.addWidget(self.engine_state_display, 0, 0)
        status_layout.addWidget(self.thrust_display, 0, 1)
        status_layout.addWidget(self.pressure_display, 1, 0)
        status_layout.addWidget(self.temperature_display, 1, 1)
        
        layout.addWidget(status_group)
        
        # Plot tabs
        plot_tabs = QtWidgets.QTabWidget()
        
        # Pressure plot
        self.pressure_plot = pg.PlotWidget(title="Pressure Sensors (Elodin)")
        self.pressure_plot.setLabel('left', 'Pressure', units='PSI')
        self.pressure_plot.setLabel('bottom', 'Time', units='s')
        self.pressure_plot.addLegend()
        self.pressure_curves = {}
        plot_tabs.addTab(self.pressure_plot, "Pressure")
        
        # Temperature plot
        self.temperature_plot = pg.PlotWidget(title="Temperature Sensors (Elodin)")
        self.temperature_plot.setLabel('left', 'Temperature', units='°C')
        self.temperature_plot.setLabel('bottom', 'Time', units='s')
        self.temperature_plot.addLegend()
        self.temperature_curves = {}
        plot_tabs.addTab(self.temperature_plot, "Temperature")
        
        # Thrust plot
        self.thrust_plot = pg.PlotWidget(title="Engine Performance (Elodin)")
        self.thrust_plot.setLabel('left', 'Thrust', units='N')
        self.thrust_plot.setLabel('bottom', 'Time', units='s')
        self.thrust_plot.addLegend()
        plot_tabs.addTab(self.thrust_plot, "Thrust")
        
        layout.addWidget(plot_tabs)
        
        # Event log
        log_group = QtWidgets.QGroupBox("📝 Event Log")
        log_layout = QtWidgets.QVBoxLayout(log_group)
        
        self.event_log = QtWidgets.QTextEdit()
        self.event_log.setReadOnly(True)
        self.event_log.setMaximumHeight(150)
        log_layout.addWidget(self.event_log)
        
        layout.addWidget(log_group)
        
        return panel
    
    def _setup_connections(self):
        """Setup Qt signal connections"""
        self.telemetry_received.connect(self._handle_telemetry_update)
        self.connection_status_changed.connect(self._update_connection_display)
    
    def _toggle_connection(self):
        """Toggle connection to Elodin"""
        if not self.elodin.connected:
            host = self.host_input.text()
            port = self.port_input.value()
            
            self.elodin.host = host
            self.elodin.port = port
            
            if self.elodin.connect():
                # Subscribe to real-time telemetry
                self.elodin.subscribe_realtime(
                    ['PT_DATA', 'TC_DATA', 'ENGINE_STATUS', 'SYSTEM_HEALTH'],
                    self._telemetry_callback
                )
                self.connection_status_changed.emit(True)
                self._log_event("✅ Connected to Elodin DB")
                self._log_event("📡 Subscribed to real-time telemetry")
        else:
            self.elodin.disconnect()
            self.connection_status_changed.emit(False)
            self._log_event("🔌 Disconnected from Elodin")
    
    def _telemetry_callback(self, packet_type: str, data: List[Dict]):
        """Callback for real-time telemetry from Elodin"""
        self.telemetry_received.emit(packet_type, data)
    
    def _handle_telemetry_update(self, packet_type: str, data: List[Dict]):
        """Handle telemetry update (runs in GUI thread)"""
        for record in data:
            timestamp = record.get('timestamp', time.time())
            
            if packet_type == 'PT_DATA':
                # Update pressure data
                for key, value in record.items():
                    if key.startswith('PT') and '_pressure' in key:
                        self._add_plot_data('pressure', key, timestamp, value)
            
            elif packet_type == 'TC_DATA':
                # Update temperature data
                for key, value in record.items():
                    if key.startswith('TC') and '_temperature' in key:
                        self._add_plot_data('temperature', key, timestamp, value)
            
            elif packet_type == 'ENGINE_STATUS':
                # Update engine status display
                state = record.get('state', 0)
                thrust = record.get('thrust_actual_N', 0.0)
                self.engine_state_display.setText(f"Engine: {EngineState(int(state)).name}")
                self.thrust_display.setText(f"Thrust: {thrust:.1f} N")
    
    def _add_plot_data(self, plot_type: str, key: str, timestamp: float, value: float):
        """Add data point to plot buffer"""
        if plot_type not in self.plot_data:
            self.plot_data[plot_type] = {}
        
        if key not in self.plot_data[plot_type]:
            self.plot_data[plot_type][key] = {'time': deque(maxlen=self.max_buffer_size),
                                               'value': deque(maxlen=self.max_buffer_size)}
        
        self.plot_data[plot_type][key]['time'].append(timestamp)
        self.plot_data[plot_type][key]['value'].append(value)
    
    def _send_state_transition(self, target_state: EngineState):
        """Send state transition command via Elodin"""
        self.elodin.send_command(
            CommandType.STATE_TRANSITION.value,
            {'target_state': float(target_state.value)}
        )
        self._log_event(f"📤 Commanded state: {target_state.name}")
    
    def _send_abort(self):
        """Send abort command via Elodin"""
        self.elodin.send_command(
            CommandType.ENGINE_ABORT.value,
            {}
        )
        self._log_event("⚠️ ABORT COMMANDED")
    
    def _send_engine_start(self):
        """Send engine start command"""
        self.elodin.send_command(CommandType.ENGINE_START.value, {})
        self._log_event("🚀 Engine start commanded")
    
    def _send_engine_stop(self):
        """Send engine stop command"""
        self.elodin.send_command(CommandType.ENGINE_STOP.value, {})
        self._log_event("🛑 Engine stop commanded")
    
    def _send_valve_command(self, valve_id: int, position: int):
        """Send valve control command"""
        self.elodin.send_command(
            CommandType.VALVE_CONTROL.value,
            {'valve_id': float(valve_id), 'position': position / 100.0}
        )
        self._log_event(f"🔧 Valve {valve_id} → {position}%")
    
    def _thrust_changed(self, value: int):
        """Thrust slider changed"""
        self.thrust_value_label.setText(f"{value}%")
        self.current_thrust = value
        
        # Send thrust command to Elodin
        self.elodin.send_command(
            CommandType.SET_THRUST.value,
            {'thrust_percent': float(value)}
        )
    
    def _update_displays(self):
        """Update all displays (called by timer)"""
        # Update plots
        self._update_pressure_plot()
        self._update_temperature_plot()
    
    def _update_pressure_plot(self):
        """Update pressure plot from Elodin data"""
        if 'pressure' not in self.plot_data:
            return
        
        for key, data in self.plot_data['pressure'].items():
            if key not in self.pressure_curves:
                self.pressure_curves[key] = self.pressure_plot.plot(pen=pg.mkPen(width=2), name=key)
            
            if len(data['time']) > 0:
                times = np.array(data['time'])
                values = np.array(data['value'])
                # Normalize time to start at 0
                times = times - times[0]
                self.pressure_curves[key].setData(times, values)
    
    def _update_temperature_plot(self):
        """Update temperature plot from Elodin data"""
        if 'temperature' not in self.plot_data:
            return
        
        for key, data in self.plot_data['temperature'].items():
            if key not in self.temperature_curves:
                self.temperature_curves[key] = self.temperature_plot.plot(pen=pg.mkPen(width=2), name=key)
            
            if len(data['time']) > 0:
                times = np.array(data['time'])
                values = np.array(data['value'])
                times = times - times[0]
                self.temperature_curves[key].setData(times, values)
    
    def _update_connection_display(self, connected: bool):
        """Update connection status display"""
        if connected:
            self.status_label.setText("Status: Connected to Elodin")
            self.status_label.setStyleSheet("color: green; font-weight: bold;")
            self.connect_btn.setText("Disconnect")
        else:
            self.status_label.setText("Status: Disconnected")
            self.status_label.setStyleSheet("color: red; font-weight: bold;")
            self.connect_btn.setText("Connect to Elodin")
    
    def _log_event(self, message: str):
        """Log event to event log"""
        timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        self.event_log.append(f"[{timestamp}] {message}")
    
    def closeEvent(self, event):
        """Handle window close"""
        if self.elodin.connected:
            self.elodin.disconnect()
        event.accept()


# ============================================================================
# Main
# ============================================================================

def main():
    app = QtWidgets.QApplication(sys.argv)
    
    # Set dark theme
    app.setStyle("Fusion")
    palette = QtGui.QPalette()
    palette.setColor(QtGui.QPalette.ColorRole.Window, QtGui.QColor(53, 53, 53))
    palette.setColor(QtGui.QPalette.ColorRole.WindowText, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorRole.Base, QtGui.QColor(35, 35, 35))
    palette.setColor(QtGui.QPalette.ColorRole.AlternateBase, QtGui.QColor(53, 53, 53))
    palette.setColor(QtGui.QPalette.ColorRole.Text, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorRole.Button, QtGui.QColor(53, 53, 53))
    palette.setColor(QtGui.QPalette.ColorRole.ButtonText, QtCore.Qt.GlobalColor.white)
    app.setPalette(palette)
    
    window = ElodinGroundStationGUI()
    window.show()
    
    sys.exit(app.exec())


if __name__ == "__main__":
    main()

