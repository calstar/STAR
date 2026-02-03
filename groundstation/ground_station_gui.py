#!/usr/bin/env python3
"""
Diablo FSW Ground Station GUI
Bidirectional communication with flight software:
- Send commands downstream (actuation, state machine transitions)
- Receive telemetry upstream (sensor data, status, health)
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
from typing import Optional, Dict, List, Callable
from collections import deque
from datetime import datetime

from PyQt6 import QtCore, QtGui, QtWidgets
import pyqtgraph as pg
import numpy as np

# Configure pyqtgraph
pg.setConfigOptions(antialias=True)


# ============================================================================
# Protocol Definitions (matching C++ FSW)
# ============================================================================

class MessageType(Enum):
    """Message types for communication protocol"""
    # Commands (downstream)
    ENGINE_COMMAND = 0
    VALVE_COMMAND = 1
    THRUST_COMMAND = 2
    ABORT_COMMAND = 3
    STATE_TRANSITION = 4
    CONFIG_UPDATE = 5
    PARAMETER_SET = 6
    CALIBRATION_DATA = 7
    
    # Telemetry (upstream)
    ENGINE_STATUS = 100
    SENSOR_DATA = 101
    SYSTEM_HEALTH = 102
    CALIBRATION_STATUS = 103
    NAVIGATION_STATE = 104
    HEARTBEAT = 105
    SAFETY_ALERT = 106
    FAULT_REPORT = 107


class EngineState(Enum):
    """Engine state machine states (matches C++ StateMachine.hpp)"""
    INITIALIZATION = 0
    STANDBY = 1
    MAINTENANCE = 2
    PRE_IGNITION_CHECKS = 3
    PURGE_SEQUENCE = 4
    IGNITION_PREP = 5
    IGNITION_SEQUENCE = 6
    IGNITION_CONFIRM = 7
    IGNITION_FAILURE = 8
    STARTUP = 9
    STEADY_STATE = 10
    THROTTLE_UP = 11
    THROTTLE_DOWN = 12
    SHUTDOWN_SEQUENCE = 13
    POST_SHUTDOWN = 14
    ABORT = 15
    EMERGENCY_SHUTDOWN = 16
    FAULT = 17
    SAFE_MODE = 18


class CommandType(Enum):
    """Command types for control interface"""
    ENGINE_START = 0
    ENGINE_STOP = 1
    ENGINE_ABORT = 2
    SET_THRUST = 3
    SET_MIXTURE_RATIO = 4
    VALVE_CONTROL = 5
    CALIBRATION_START = 6
    CALIBRATION_STOP = 7
    CONFIG_UPDATE = 8
    SYSTEM_RESET = 9


class Priority(Enum):
    """Message priority levels"""
    CRITICAL = 0
    HIGH = 1
    NORMAL = 2
    LOW = 3


@dataclass
class Command:
    """Command structure for sending to FSW"""
    command_type: CommandType
    parameters: Dict[str, float]
    timestamp: float
    command_id: int
    requires_confirmation: bool = True


@dataclass
class TelemetryData:
    """Telemetry data received from FSW"""
    message_type: MessageType
    data: Dict[str, float]
    timestamp: float
    sequence_number: int


# ============================================================================
# Communication Protocol Handler
# ============================================================================

class FSWCommunicationProtocol:
    """Handles bidirectional TCP communication with FSW"""
    
    def __init__(self, fsw_host: str = "127.0.0.1", command_port: int = 2241, telemetry_port: int = 2242):
        self.fsw_host = fsw_host
        self.command_port = command_port
        self.telemetry_port = telemetry_port
        
        self.command_socket: Optional[socket.socket] = None
        self.telemetry_socket: Optional[socket.socket] = None
        
        self.connected = False
        self.running = False
        
        self.command_id_counter = 0
        self.sequence_number = 0
        
        # Queues for thread-safe communication
        self.outgoing_commands = queue.Queue()
        self.incoming_telemetry = queue.Queue()
        
        # Threads
        self.command_thread: Optional[threading.Thread] = None
        self.telemetry_thread: Optional[threading.Thread] = None
        
        # Callbacks
        self.telemetry_callbacks: Dict[MessageType, List[Callable]] = {}
        
        # Statistics
        self.commands_sent = 0
        self.telemetry_received = 0
        self.connection_errors = 0
        
    def connect(self) -> bool:
        """Connect to FSW command and telemetry ports"""
        try:
            # Connect command socket (TCP for reliability)
            self.command_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.command_socket.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            self.command_socket.connect((self.fsw_host, self.command_port))
            print(f"✅ Connected to FSW command port: {self.fsw_host}:{self.command_port}")
            
            # Connect telemetry socket (TCP for now, could use UDP for high-rate telemetry)
            self.telemetry_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.telemetry_socket.connect((self.fsw_host, self.telemetry_port))
            print(f"✅ Connected to FSW telemetry port: {self.fsw_host}:{self.telemetry_port}")
            
            self.connected = True
            return True
            
        except Exception as e:
            print(f"❌ Connection failed: {e}")
            self.connection_errors += 1
            self.connected = False
            return False
    
    def disconnect(self):
        """Disconnect from FSW"""
        self.connected = False
        self.running = False
        
        if self.command_socket:
            self.command_socket.close()
            self.command_socket = None
        
        if self.telemetry_socket:
            self.telemetry_socket.close()
            self.telemetry_socket = None
        
        print("🔌 Disconnected from FSW")
    
    def start(self):
        """Start communication threads"""
        if not self.connected:
            print("❌ Cannot start - not connected to FSW")
            return False
        
        self.running = True
        
        # Start command sending thread
        self.command_thread = threading.Thread(target=self._command_loop, daemon=True)
        self.command_thread.start()
        
        # Start telemetry receiving thread
        self.telemetry_thread = threading.Thread(target=self._telemetry_loop, daemon=True)
        self.telemetry_thread.start()
        
        print("🚀 Communication threads started")
        return True
    
    def stop(self):
        """Stop communication threads"""
        self.running = False
        
        if self.command_thread:
            self.command_thread.join(timeout=2.0)
        
        if self.telemetry_thread:
            self.telemetry_thread.join(timeout=2.0)
        
        print("🛑 Communication threads stopped")
    
    def send_command(self, command: Command):
        """Queue a command to be sent to FSW"""
        command.command_id = self._get_next_command_id()
        command.timestamp = time.time()
        self.outgoing_commands.put(command)
    
    def register_telemetry_callback(self, message_type: MessageType, callback: Callable):
        """Register a callback for specific telemetry message type"""
        if message_type not in self.telemetry_callbacks:
            self.telemetry_callbacks[message_type] = []
        self.telemetry_callbacks[message_type].append(callback)
    
    def _get_next_command_id(self) -> int:
        """Get next command ID"""
        self.command_id_counter += 1
        return self.command_id_counter
    
    def _command_loop(self):
        """Command sending loop"""
        while self.running:
            try:
                # Get command from queue (with timeout)
                try:
                    command = self.outgoing_commands.get(timeout=0.1)
                except queue.Empty:
                    continue
                
                # Serialize and send command
                packet = self._serialize_command(command)
                self.command_socket.sendall(packet)
                self.commands_sent += 1
                
                print(f"📤 Sent command: {command.command_type.name} (ID: {command.command_id})")
                
            except Exception as e:
                print(f"❌ Command sending error: {e}")
                self.connection_errors += 1
                time.sleep(0.5)
    
    def _telemetry_loop(self):
        """Telemetry receiving loop"""
        buffer = b""
        
        while self.running:
            try:
                # Receive data
                data = self.telemetry_socket.recv(4096)
                if not data:
                    print("⚠️  Telemetry connection closed")
                    break
                
                buffer += data
                
                # Parse complete packets from buffer
                while len(buffer) >= 8:  # Minimum packet size (header)
                    # Parse packet header
                    header = struct.unpack('<IBBH', buffer[:8])
                    packet_length = header[0]
                    message_type_val = header[1]
                    priority_val = header[2]
                    sequence_num = header[3]
                    
                    # Check if we have complete packet
                    if len(buffer) < packet_length:
                        break  # Wait for more data
                    
                    # Extract packet payload
                    payload = buffer[8:packet_length]
                    buffer = buffer[packet_length:]
                    
                    # Parse telemetry data
                    try:
                        message_type = MessageType(message_type_val)
                        telemetry = self._parse_telemetry(message_type, payload, sequence_num)
                        
                        # Call registered callbacks
                        if message_type in self.telemetry_callbacks:
                            for callback in self.telemetry_callbacks[message_type]:
                                callback(telemetry)
                        
                        self.telemetry_received += 1
                        
                    except ValueError:
                        print(f"⚠️  Unknown message type: {message_type_val}")
                
            except Exception as e:
                print(f"❌ Telemetry receiving error: {e}")
                self.connection_errors += 1
                time.sleep(0.5)
    
    def _serialize_command(self, command: Command) -> bytes:
        """Serialize command to binary packet"""
        # Create JSON payload
        payload_dict = {
            'command_type': command.command_type.value,
            'parameters': command.parameters,
            'timestamp': command.timestamp,
            'command_id': command.command_id,
            'requires_confirmation': command.requires_confirmation
        }
        payload_json = json.dumps(payload_dict).encode('utf-8')
        
        # Build packet: [length(4) | msg_type(1) | priority(1) | reserved(2) | payload]
        packet_length = 8 + len(payload_json)
        header = struct.pack('<IBBH', 
                           packet_length,
                           MessageType.ENGINE_COMMAND.value,
                           Priority.HIGH.value,
                           0)  # reserved
        
        return header + payload_json
    
    def _parse_telemetry(self, message_type: MessageType, payload: bytes, sequence_num: int) -> TelemetryData:
        """Parse telemetry data from binary packet"""
        # Parse JSON payload
        payload_dict = json.loads(payload.decode('utf-8'))
        
        telemetry = TelemetryData(
            message_type=message_type,
            data=payload_dict.get('data', {}),
            timestamp=payload_dict.get('timestamp', time.time()),
            sequence_number=sequence_num
        )
        
        return telemetry


# ============================================================================
# Ground Station GUI
# ============================================================================

class GroundStationGUI(QtWidgets.QMainWindow):
    """Main Ground Station GUI window"""
    
    # Qt signals for thread-safe GUI updates
    telemetry_received = QtCore.pyqtSignal(TelemetryData)
    connection_status_changed = QtCore.pyqtSignal(bool)
    
    def __init__(self):
        super().__init__()
        
        # Communication protocol
        self.protocol = FSWCommunicationProtocol()
        
        # Register telemetry callbacks
        self.protocol.register_telemetry_callback(MessageType.SENSOR_DATA, self._handle_sensor_data)
        self.protocol.register_telemetry_callback(MessageType.ENGINE_STATUS, self._handle_engine_status)
        self.protocol.register_telemetry_callback(MessageType.SYSTEM_HEALTH, self._handle_system_health)
        
        # Data buffers for plotting
        self.sensor_data_buffers: Dict[str, deque] = {}
        self.time_buffers: Dict[str, deque] = {}
        self.max_buffer_size = 1000
        
        # Current state
        self.current_engine_state = EngineState.INITIALIZATION
        self.current_thrust = 0.0
        self.current_mixture_ratio = 0.0
        
        # Setup GUI
        self.setWindowTitle("Diablo FSW - Ground Station Control")
        self.setGeometry(100, 100, 1800, 1000)
        
        self._setup_ui()
        self._setup_connections()
        
        # Update timer
        self.update_timer = QtCore.QTimer()
        self.update_timer.timeout.connect(self._update_displays)
        self.update_timer.start(100)  # 10 Hz GUI update
    
    def _setup_ui(self):
        """Setup user interface"""
        central_widget = QtWidgets.QWidget()
        self.setCentralWidget(central_widget)
        
        main_layout = QtWidgets.QHBoxLayout(central_widget)
        
        # Left panel: Command and Control
        left_panel = self._create_command_panel()
        main_layout.addWidget(left_panel, stretch=1)
        
        # Right panel: Telemetry and Status
        right_panel = self._create_telemetry_panel()
        main_layout.addWidget(right_panel, stretch=2)
    
    def _create_command_panel(self) -> QtWidgets.QWidget:
        """Create command and control panel"""
        panel = QtWidgets.QWidget()
        layout = QtWidgets.QVBoxLayout(panel)
        
        # Connection controls
        conn_group = QtWidgets.QGroupBox("🔌 Connection")
        conn_layout = QtWidgets.QVBoxLayout(conn_group)
        
        self.host_input = QtWidgets.QLineEdit("127.0.0.1")
        self.port_input = QtWidgets.QSpinBox()
        self.port_input.setRange(1024, 65535)
        self.port_input.setValue(2241)
        
        conn_form = QtWidgets.QFormLayout()
        conn_form.addRow("Host:", self.host_input)
        conn_form.addRow("Port:", self.port_input)
        conn_layout.addLayout(conn_form)
        
        self.connect_btn = QtWidgets.QPushButton("Connect to FSW")
        self.connect_btn.clicked.connect(self._toggle_connection)
        conn_layout.addWidget(self.connect_btn)
        
        self.status_label = QtWidgets.QLabel("Status: Disconnected")
        self.status_label.setStyleSheet("color: red; font-weight: bold;")
        conn_layout.addWidget(self.status_label)
        
        layout.addWidget(conn_group)
        
        # State machine controls
        state_group = QtWidgets.QGroupBox("🎯 State Machine")
        state_layout = QtWidgets.QVBoxLayout(state_group)
        
        self.current_state_label = QtWidgets.QLabel("Current: INITIALIZATION")
        self.current_state_label.setStyleSheet("font-size: 14px; font-weight: bold;")
        state_layout.addWidget(self.current_state_label)
        
        # State transition buttons
        state_btn_layout = QtWidgets.QGridLayout()
        
        self.state_buttons = {}
        state_transitions = [
            ("STANDBY", EngineState.STANDBY, 0, 0),
            ("PRE-IGN CHECKS", EngineState.PRE_IGNITION_CHECKS, 0, 1),
            ("IGNITION PREP", EngineState.IGNITION_PREP, 1, 0),
            ("START IGNITION", EngineState.IGNITION_SEQUENCE, 1, 1),
            ("STEADY STATE", EngineState.STEADY_STATE, 2, 0),
            ("SHUTDOWN", EngineState.SHUTDOWN_SEQUENCE, 2, 1),
        ]
        
        for label, state, row, col in state_transitions:
            btn = QtWidgets.QPushButton(label)
            btn.clicked.connect(lambda checked, s=state: self._send_state_transition(s))
            state_btn_layout.addWidget(btn, row, col)
            self.state_buttons[state] = btn
        
        state_layout.addLayout(state_btn_layout)
        
        # Emergency controls
        emergency_layout = QtWidgets.QHBoxLayout()
        self.abort_btn = QtWidgets.QPushButton("⚠️ ABORT")
        self.abort_btn.setStyleSheet("background-color: red; color: white; font-weight: bold; font-size: 14px;")
        self.abort_btn.clicked.connect(self._send_abort_command)
        emergency_layout.addWidget(self.abort_btn)
        
        self.estop_btn = QtWidgets.QPushButton("🛑 E-STOP")
        self.estop_btn.setStyleSheet("background-color: darkred; color: white; font-weight: bold; font-size: 14px;")
        self.estop_btn.clicked.connect(self._send_emergency_shutdown)
        emergency_layout.addWidget(self.estop_btn)
        
        state_layout.addLayout(emergency_layout)
        
        layout.addWidget(state_group)
        
        # Engine controls
        engine_group = QtWidgets.QGroupBox("🚀 Engine Control")
        engine_layout = QtWidgets.QVBoxLayout(engine_group)
        
        # Thrust control
        thrust_layout = QtWidgets.QFormLayout()
        self.thrust_slider = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.thrust_slider.setRange(0, 100)
        self.thrust_slider.setValue(0)
        self.thrust_slider.valueChanged.connect(self._update_thrust_display)
        
        self.thrust_value_label = QtWidgets.QLabel("0 %")
        thrust_layout.addRow("Thrust:", self.thrust_slider)
        thrust_layout.addRow("", self.thrust_value_label)
        
        # Mixture ratio control
        self.mixture_ratio_slider = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.mixture_ratio_slider.setRange(10, 40)  # 1.0 to 4.0 O/F ratio
        self.mixture_ratio_slider.setValue(25)
        self.mixture_ratio_slider.valueChanged.connect(self._update_mixture_ratio_display)
        
        self.mixture_ratio_value_label = QtWidgets.QLabel("2.5")
        thrust_layout.addRow("Mixture Ratio:", self.mixture_ratio_slider)
        thrust_layout.addRow("", self.mixture_ratio_value_label)
        
        engine_layout.addLayout(thrust_layout)
        
        # Engine command buttons
        engine_btn_layout = QtWidgets.QHBoxLayout()
        
        self.engine_start_btn = QtWidgets.QPushButton("Start Engine")
        self.engine_start_btn.clicked.connect(self._send_engine_start)
        engine_btn_layout.addWidget(self.engine_start_btn)
        
        self.engine_stop_btn = QtWidgets.QPushButton("Stop Engine")
        self.engine_stop_btn.clicked.connect(self._send_engine_stop)
        engine_btn_layout.addWidget(self.engine_stop_btn)
        
        engine_layout.addLayout(engine_btn_layout)
        
        layout.addWidget(engine_group)
        
        # Valve controls
        valve_group = QtWidgets.QGroupBox("🔧 Valve Control")
        valve_layout = QtWidgets.QVBoxLayout(valve_group)
        
        self.valve_controls = {}
        for i, valve_name in enumerate(["LOX Main", "Fuel Main", "LOX Purge", "Fuel Purge"]):
            valve_control_layout = QtWidgets.QHBoxLayout()
            
            label = QtWidgets.QLabel(f"{valve_name}:")
            valve_control_layout.addWidget(label)
            
            slider = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
            slider.setRange(0, 100)
            slider.setValue(0)
            valve_control_layout.addWidget(slider)
            
            value_label = QtWidgets.QLabel("0%")
            valve_control_layout.addWidget(value_label)
            
            send_btn = QtWidgets.QPushButton("Set")
            send_btn.clicked.connect(lambda checked, vid=i, s=slider: self._send_valve_command(vid, s.value()))
            valve_control_layout.addWidget(send_btn)
            
            valve_layout.addLayout(valve_control_layout)
            
            self.valve_controls[i] = {'slider': slider, 'label': value_label}
            slider.valueChanged.connect(lambda val, lbl=value_label: lbl.setText(f"{val}%"))
        
        layout.addWidget(valve_group)
        
        # Statistics
        stats_group = QtWidgets.QGroupBox("📊 Statistics")
        stats_layout = QtWidgets.QVBoxLayout(stats_group)
        
        self.stats_label = QtWidgets.QLabel("Commands sent: 0\nTelemetry received: 0\nErrors: 0")
        stats_layout.addWidget(self.stats_label)
        
        layout.addWidget(stats_group)
        
        layout.addStretch()
        
        return panel
    
    def _create_telemetry_panel(self) -> QtWidgets.QWidget:
        """Create telemetry display panel"""
        panel = QtWidgets.QWidget()
        layout = QtWidgets.QVBoxLayout(panel)
        
        # Status display
        status_group = QtWidgets.QGroupBox("📡 System Status")
        status_layout = QtWidgets.QGridLayout(status_group)
        
        self.engine_state_display = QtWidgets.QLabel("Engine: INIT")
        self.thrust_display = QtWidgets.QLabel("Thrust: 0.0 N")
        self.pressure_display = QtWidgets.QLabel("Chamber: 0.0 PSI")
        self.temperature_display = QtWidgets.QLabel("Chamber Temp: 0.0 °C")
        
        status_layout.addWidget(self.engine_state_display, 0, 0)
        status_layout.addWidget(self.thrust_display, 0, 1)
        status_layout.addWidget(self.pressure_display, 1, 0)
        status_layout.addWidget(self.temperature_display, 1, 1)
        
        layout.addWidget(status_group)
        
        # Sensor plots
        plot_tabs = QtWidgets.QTabWidget()
        
        # Pressure plot
        self.pressure_plot = pg.PlotWidget(title="Pressure Sensors")
        self.pressure_plot.setLabel('left', 'Pressure', units='PSI')
        self.pressure_plot.setLabel('bottom', 'Time', units='s')
        self.pressure_plot.addLegend()
        plot_tabs.addTab(self.pressure_plot, "Pressure")
        
        # Temperature plot
        self.temperature_plot = pg.PlotWidget(title="Temperature Sensors")
        self.temperature_plot.setLabel('left', 'Temperature', units='°C')
        self.temperature_plot.setLabel('bottom', 'Time', units='s')
        self.temperature_plot.addLegend()
        plot_tabs.addTab(self.temperature_plot, "Temperature")
        
        # Thrust/Performance plot
        self.thrust_plot = pg.PlotWidget(title="Engine Performance")
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
        self.event_log.setMaximumHeight(200)
        log_layout.addWidget(self.event_log)
        
        layout.addWidget(log_group)
        
        return panel
    
    def _setup_connections(self):
        """Setup Qt signal connections"""
        self.telemetry_received.connect(self._update_telemetry_display)
        self.connection_status_changed.connect(self._update_connection_display)
    
    def _toggle_connection(self):
        """Toggle connection to FSW"""
        if not self.protocol.connected:
            host = self.host_input.text()
            port = self.port_input.value()
            
            self.protocol.fsw_host = host
            self.protocol.command_port = port
            self.protocol.telemetry_port = port + 1
            
            if self.protocol.connect():
                self.protocol.start()
                self.connection_status_changed.emit(True)
                self._log_event("✅ Connected to FSW")
        else:
            self.protocol.stop()
            self.protocol.disconnect()
            self.connection_status_changed.emit(False)
            self._log_event("🔌 Disconnected from FSW")
    
    def _update_connection_display(self, connected: bool):
        """Update connection status display"""
        if connected:
            self.status_label.setText("Status: Connected")
            self.status_label.setStyleSheet("color: green; font-weight: bold;")
            self.connect_btn.setText("Disconnect")
        else:
            self.status_label.setText("Status: Disconnected")
            self.status_label.setStyleSheet("color: red; font-weight: bold;")
            self.connect_btn.setText("Connect to FSW")
    
    def _send_state_transition(self, target_state: EngineState):
        """Send state machine transition command"""
        command = Command(
            command_type=CommandType.ENGINE_START,  # Will be mapped based on state
            parameters={'target_state': target_state.value},
            timestamp=time.time(),
            command_id=0,
            requires_confirmation=True
        )
        
        self.protocol.send_command(command)
        self._log_event(f"📤 Commanded state transition: {target_state.name}")
    
    def _send_abort_command(self):
        """Send abort command"""
        command = Command(
            command_type=CommandType.ENGINE_ABORT,
            parameters={'abort_reason': 'manual'},
            timestamp=time.time(),
            command_id=0,
            requires_confirmation=False  # Immediate execution
        )
        
        self.protocol.send_command(command)
        self._log_event("⚠️ ABORT COMMAND SENT")
    
    def _send_emergency_shutdown(self):
        """Send emergency shutdown command"""
        command = Command(
            command_type=CommandType.ENGINE_STOP,
            parameters={'emergency': 1.0},
            timestamp=time.time(),
            command_id=0,
            requires_confirmation=False
        )
        
        self.protocol.send_command(command)
        self._log_event("🛑 EMERGENCY SHUTDOWN SENT")
    
    def _send_engine_start(self):
        """Send engine start command"""
        command = Command(
            command_type=CommandType.ENGINE_START,
            parameters={},
            timestamp=time.time(),
            command_id=0
        )
        
        self.protocol.send_command(command)
        self._log_event("🚀 Engine start commanded")
    
    def _send_engine_stop(self):
        """Send engine stop command"""
        command = Command(
            command_type=CommandType.ENGINE_STOP,
            parameters={},
            timestamp=time.time(),
            command_id=0
        )
        
        self.protocol.send_command(command)
        self._log_event("🛑 Engine stop commanded")
    
    def _send_valve_command(self, valve_id: int, position: int):
        """Send valve control command"""
        command = Command(
            command_type=CommandType.VALVE_CONTROL,
            parameters={
                'valve_id': float(valve_id),
                'position': position / 100.0,  # Convert to 0.0-1.0
                'rate_limit': 0.1  # 10% per second
            },
            timestamp=time.time(),
            command_id=0
        )
        
        self.protocol.send_command(command)
        self._log_event(f"🔧 Valve {valve_id} commanded to {position}%")
    
    def _update_thrust_display(self, value: int):
        """Update thrust display"""
        self.thrust_value_label.setText(f"{value} %")
        self.current_thrust = value
    
    def _update_mixture_ratio_display(self, value: int):
        """Update mixture ratio display"""
        ratio = value / 10.0
        self.mixture_ratio_value_label.setText(f"{ratio:.1f}")
        self.current_mixture_ratio = ratio
    
    def _handle_sensor_data(self, telemetry: TelemetryData):
        """Handle incoming sensor data telemetry"""
        self.telemetry_received.emit(telemetry)
    
    def _handle_engine_status(self, telemetry: TelemetryData):
        """Handle incoming engine status telemetry"""
        self.telemetry_received.emit(telemetry)
    
    def _handle_system_health(self, telemetry: TelemetryData):
        """Handle incoming system health telemetry"""
        self.telemetry_received.emit(telemetry)
    
    def _update_telemetry_display(self, telemetry: TelemetryData):
        """Update telemetry displays (runs in GUI thread)"""
        # Update sensor data buffers
        for key, value in telemetry.data.items():
            if key not in self.sensor_data_buffers:
                self.sensor_data_buffers[key] = deque(maxlen=self.max_buffer_size)
                self.time_buffers[key] = deque(maxlen=self.max_buffer_size)
            
            self.sensor_data_buffers[key].append(value)
            self.time_buffers[key].append(telemetry.timestamp)
    
    def _update_displays(self):
        """Update all displays (called by timer)"""
        # Update statistics
        stats_text = (
            f"Commands sent: {self.protocol.commands_sent}\n"
            f"Telemetry received: {self.protocol.telemetry_received}\n"
            f"Errors: {self.protocol.connection_errors}"
        )
        self.stats_label.setText(stats_text)
        
        # Update plots (TODO: implement plot updates based on sensor data buffers)
    
    def _log_event(self, message: str):
        """Log event to event log"""
        timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        log_entry = f"[{timestamp}] {message}"
        self.event_log.append(log_entry)
    
    def closeEvent(self, event):
        """Handle window close event"""
        if self.protocol.connected:
            self.protocol.stop()
            self.protocol.disconnect()
        event.accept()


# ============================================================================
# Main Entry Point
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
    palette.setColor(QtGui.QPalette.ColorRole.ToolTipBase, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorRole.ToolTipText, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorRole.Text, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorRole.Button, QtGui.QColor(53, 53, 53))
    palette.setColor(QtGui.QPalette.ColorRole.ButtonText, QtCore.Qt.GlobalColor.white)
    palette.setColor(QtGui.QPalette.ColorRole.BrightText, QtCore.Qt.GlobalColor.red)
    palette.setColor(QtGui.QPalette.ColorRole.Link, QtGui.QColor(42, 130, 218))
    palette.setColor(QtGui.QPalette.ColorRole.Highlight, QtGui.QColor(42, 130, 218))
    palette.setColor(QtGui.QPalette.ColorRole.HighlightedText, QtCore.Qt.GlobalColor.black)
    app.setPalette(palette)
    
    window = GroundStationGUI()
    window.show()
    
    sys.exit(app.exec())


if __name__ == "__main__":
    main()

