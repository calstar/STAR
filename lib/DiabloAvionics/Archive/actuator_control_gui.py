#!/usr/bin/env python3
"""
Actuator Control GUI
Sends actuator command packets to the actuator board and receives sensor data
(current readings) to display real-time current draw for each actuator.

Requirements: pip install pyqt6 pyqtgraph numpy
"""

import os
import socket
import struct
import sys
import time
from typing import Optional, Tuple, List, Dict
from collections import deque

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

# Default configuration
DEFAULT_DEVICE_IP = '192.168.2.201'  # Actuator board IP address
DEFAULT_DEVICE_PORT = 5005  # Port device listens on for actuator commands
DEFAULT_RECEIVE_PORT = 5006  # Port device sends sensor data to

# Number of actuators
NUM_ACTUATORS = 10

# Struct format strings (little-endian, matching C++ packed structs)
PACKET_HEADER_FORMAT = '<BBI'  # 6 bytes total: packet_type (1), version (1), timestamp (4)
PACKET_HEADER_SIZE = 6

ACTUATOR_COMMAND_PACKET_FORMAT = '<B'  # 1 byte: num_commands
ACTUATOR_COMMAND_PACKET_SIZE = 1

ACTUATOR_COMMAND_FORMAT = '<BB'  # 2 bytes: actuator_id (1), actuator_state (1)
ACTUATOR_COMMAND_SIZE = 2

# Sensor data packet formats (same as receiver GUI)
SENSOR_DATA_PACKET_FORMAT = '<BB'  # 2 bytes: num_chunks, num_sensors
SENSOR_DATA_PACKET_SIZE = 2

SENSOR_DATA_CHUNK_FORMAT = '<I'  # 4 bytes: timestamp
SENSOR_DATA_CHUNK_SIZE = 4

SENSOR_DATAPOINT_FORMAT = '<BI'  # 5 bytes: uint8_t sensor_id + uint32_t data
SENSOR_DATAPOINT_SIZE = 5

# Update interval for current display
UPDATE_INTERVAL_MS = 100  # Update current display every 100ms

pg.setConfigOptions(antialias=False)


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
                    'data': sensor_data  # Voltage in Volts (float)
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


# ---------------------- UDP Receiver Thread ----------------------
class UDPReceiver(QtCore.QThread):
    """Thread that receives UDP packets with sensor data (current readings)"""
    sensor_data_received = QtCore.pyqtSignal(dict, list)  # header, chunks
    status_update = QtCore.pyqtSignal(str)
    
    def __init__(self, port: int = DEFAULT_RECEIVE_PORT, bind_address: str = '0.0.0.0'):
        super().__init__()
        self.port = port
        self.bind_address = bind_address
        self._stop = False
        self.sock = None
        
    def stop(self):
        """Stop the receiver thread"""
        self._stop = True
        if self.sock:
            try:
                self.sock.close()
            except:
                pass
    
    def run(self):
        """Main receiver loop"""
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.settimeout(0.1)  # Non-blocking with timeout
        
        try:
            self.sock.bind((self.bind_address, self.port))
            self.status_update.emit(f"Receiving sensor data on {self.bind_address}:{self.port}")
        except OSError as e:
            self.status_update.emit(f"Error binding receiver: {e}")
            return
        
        while not self._stop:
            try:
                data, addr = self.sock.recvfrom(MAX_PACKET_SIZE)
                
                header = parse_packet_header(data)
                if header is None:
                    continue
                
                packet_type, version, timestamp = header
                
                if packet_type == PacketType.SENSOR_DATA:
                    result = parse_sensor_data_packet(data)
                    if result:
                        header_dict, chunks = result
                        self.sensor_data_received.emit(header_dict, chunks)
                        
            except socket.timeout:
                continue
            except Exception as e:
                if not self._stop:
                    self.status_update.emit(f"Receiver error: {e}")
                continue
        
        if self.sock:
            try:
                self.sock.close()
            except:
                pass
        self.status_update.emit("Receiver stopped")


# ---------------------- Main Application Window ----------------------
class ActuatorControlWindow(QtWidgets.QMainWindow):
    def __init__(self, device_ip: str = DEFAULT_DEVICE_IP, device_port: int = DEFAULT_DEVICE_PORT,
                 receive_port: int = DEFAULT_RECEIVE_PORT):
        super().__init__()
        self.device_ip = device_ip
        self.device_port = device_port
        self.receive_port = receive_port
        
        # Actuator state tracking (1-indexed: 1-10)
        # 0 = OFF, 1 = ON
        self.actuator_states = [0] * NUM_ACTUATORS
        
        # Voltage readings (0-indexed: 0-9, maps to actuator 1-10)
        # Store as voltage in Volts
        self.voltage_readings = [0.0] * NUM_ACTUATORS
        
        # UDP socket for sending commands
        self.command_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        
        # UDP receiver thread for sensor data
        self.receiver = None
        
        self.init_ui()
        self.start_receiver()
        
        # Timer for updating current display
        self.update_timer = QtCore.QTimer()
        self.update_timer.timeout.connect(self.update_current_display)
        self.update_timer.start(UPDATE_INTERVAL_MS)
    
    def init_ui(self):
        """Initialize the user interface"""
        self.setWindowTitle(f"Actuator Control - {self.device_ip}:{self.device_port}")
        self.setGeometry(100, 100, 1000, 500)
        
        # Central widget
        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        layout = QtWidgets.QVBoxLayout(central)
        
        # Top panel with status and settings
        top_panel = QtWidgets.QHBoxLayout()
        
        self.status_label = QtWidgets.QLabel("Starting...")
        self.status_label.setStyleSheet("font-weight: bold; padding: 5px;")
        top_panel.addWidget(self.status_label)
        
        top_panel.addStretch()
        
        # Settings button
        settings_btn = QtWidgets.QPushButton("Settings")
        settings_btn.clicked.connect(self.show_settings)
        top_panel.addWidget(settings_btn)
        
        layout.addLayout(top_panel)
        
        # Main content area with actuators in a grid
        grid_container = QtWidgets.QWidget()
        grid_layout = QtWidgets.QGridLayout(grid_container)
        grid_layout.setSpacing(10)
        
        # Create actuator controls in a 5x2 grid
        self.actuator_widgets = []
        for i in range(NUM_ACTUATORS):
            actuator_id = i + 1  # 1-indexed
            
            # Calculate grid position: 5 columns, 2 rows
            row = i // 5  # 0 or 1
            col = i % 5   # 0-4
            
            # Create widget for each actuator
            actuator_frame = QtWidgets.QFrame()
            actuator_frame.setFrameShape(QtWidgets.QFrame.Shape.Box)
            actuator_frame.setFrameShadow(QtWidgets.QFrame.Shadow.Raised)
            actuator_frame.setStyleSheet("padding: 10px; margin: 5px;")
            
            actuator_layout = QtWidgets.QVBoxLayout(actuator_frame)
            
            # Actuator ID label
            id_label = QtWidgets.QLabel(f"Actuator {actuator_id}")
            id_label.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
            id_label.setStyleSheet("font-weight: bold; font-size: 12pt; padding: 5px;")
            actuator_layout.addWidget(id_label)
            
            # Button container
            button_container = QtWidgets.QHBoxLayout()
            button_container.setSpacing(5)
            
            # ON button
            on_btn = QtWidgets.QPushButton("ON")
            on_btn.setMinimumHeight(40)
            # Get the window background color to match buttons
            bg_color = self.palette().color(QtGui.QPalette.ColorRole.Window).name()
            on_btn.setStyleSheet(f"""
                QPushButton {{
                    font-size: 11pt;
                    font-weight: bold;
                    background-color: {bg_color};
                    color: #FFFFFF;
                    border: none;
                    border-radius: 5px;
                    padding: 5px;
                }}
                QPushButton:hover {{
                    background-color: {bg_color};
                }}
                QPushButton:pressed {{
                    background-color: {bg_color};
                }}
            """)
            on_btn.clicked.connect(lambda checked=False, aid=actuator_id: self.set_actuator_state(aid, 1))
            
            # OFF button
            off_btn = QtWidgets.QPushButton("OFF")
            off_btn.setMinimumHeight(40)
            off_btn.setStyleSheet(f"""
                QPushButton {{
                    font-size: 11pt;
                    font-weight: bold;
                    background-color: {bg_color};
                    color: #FFFFFF;
                    border: none;
                    border-radius: 5px;
                    padding: 5px;
                }}
                QPushButton:hover {{
                    background-color: {bg_color};
                }}
                QPushButton:pressed {{
                    background-color: {bg_color};
                }}
            """)
            off_btn.clicked.connect(lambda checked=False, aid=actuator_id: self.set_actuator_state(aid, 0))
            
            button_container.addWidget(on_btn)
            button_container.addWidget(off_btn)
            actuator_layout.addLayout(button_container)
            
            # Voltage reading label
            voltage_label = QtWidgets.QLabel("Voltage: 0.000 V")
            voltage_label.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
            voltage_label.setStyleSheet("font-size: 10pt; padding: 5px;")
            actuator_layout.addWidget(voltage_label)
            
            # Add to grid
            grid_layout.addWidget(actuator_frame, row, col)
            
            # Store widget references
            self.actuator_widgets.append({
                'frame': actuator_frame,
                'on_btn': on_btn,
                'off_btn': off_btn,
                'voltage_label': voltage_label
            })
        
        layout.addWidget(grid_container, 1)
        
        # Initialize all actuators to OFF state (highlight OFF buttons)
        for i in range(NUM_ACTUATORS):
            self.update_button_highlight(i, 0)
    
    def start_receiver(self):
        """Start the UDP receiver thread"""
        self.receiver = UDPReceiver(port=self.receive_port)
        self.receiver.sensor_data_received.connect(self.on_sensor_data)
        self.receiver.status_update.connect(self.on_status_update)
        self.receiver.start()
    
    def on_status_update(self, message: str):
        """Handle status updates from receiver thread"""
        self.status_label.setText(message)
    
    def on_sensor_data(self, header: dict, chunks: List[dict]):
        """Handle received sensor data (voltage readings)"""
        # Process the latest chunk
        if chunks:
            latest_chunk = chunks[-1]
            for dp in latest_chunk['datapoints']:
                sensor_id = dp['sensor_id']  # 1-indexed (1-10)
                code_uint32 = dp['data']  # Received as uint32_t from protocol
                
                # Convert code to voltage (using default settings: 32-bit, 2.5V reference)
                # Reinterpret uint32_t as int32_t (signed)
                if code_uint32 >= 0x80000000:
                    code_int32 = code_uint32 - 0x100000000
                else:
                    code_int32 = code_uint32
                
                # Convert to voltage (32-bit ADC, 2.5V reference)
                voltage = (code_int32 * 2.5) / 2147483648.0
                
                # Convert to 0-indexed for array
                array_idx = sensor_id - 1
                if 0 <= array_idx < NUM_ACTUATORS:
                    self.voltage_readings[array_idx] = voltage
    
    def update_button_highlight(self, array_idx: int, actuator_state: int):
        """
        Update button highlighting based on actuator state.
        array_idx: 0-9 (0-indexed)
        actuator_state: 0 = OFF, 1 = ON
        """
        widget = self.actuator_widgets[array_idx]
        
        # Inactive button style (matches background)
        bg_color = widget['frame'].palette().color(QtGui.QPalette.ColorRole.Window).name()
        inactive_style = f"""
            QPushButton {{
                font-size: 11pt;
                font-weight: bold;
                background-color: {bg_color};
                color: #FFFFFF;
                border: none;
                border-radius: 5px;
                padding: 5px;
            }}
            QPushButton:hover {{
                background-color: {bg_color};
            }}
            QPushButton:pressed {{
                background-color: {bg_color};
            }}
        """
        
        # Active button style (white background, black text)
        active_style = """
            QPushButton {
                font-size: 11pt;
                font-weight: bold;
                background-color: #FFFFFF;
                color: #000000;
                border: 2px solid #000000;
                border-radius: 5px;
                padding: 5px;
            }
            QPushButton:hover {
                background-color: #F5F5F5;
            }
            QPushButton:pressed {
                background-color: #E5E5E5;
            }
        """
        
        # Highlight ON button if state is ON, otherwise highlight OFF button
        if actuator_state == 1:
            # ON is active - white ON button, inactive OFF button
            widget['on_btn'].setStyleSheet(active_style)
            widget['off_btn'].setStyleSheet(inactive_style)
        else:
            # OFF is active - white OFF button, inactive ON button
            widget['on_btn'].setStyleSheet(inactive_style)
            widget['off_btn'].setStyleSheet(active_style)
    
    def set_actuator_state(self, actuator_id: int, actuator_state: int):
        """
        Set actuator state and send command packet.
        actuator_id: 1-10 (1-indexed)
        actuator_state: 0 = OFF, 1 = ON
        """
        # Convert to 0-indexed for array
        array_idx = actuator_id - 1
        
        # Update local state
        self.actuator_states[array_idx] = actuator_state
        
        # Update UI - highlight the active button
        self.update_button_highlight(array_idx, actuator_state)
        
        # Send command packet
        self.send_actuator_command(actuator_id, actuator_state)
    
    def send_actuator_command(self, actuator_id: int, actuator_state: int):
        """
        Send an actuator command packet to the device.
        actuator_id: 1-10 (1-indexed)
        actuator_state: 0 = OFF, non-zero = ON
        """
        try:
            commands = [(actuator_id, actuator_state)]
            packet = create_actuator_command_packet(commands)
            
            if len(packet) > 0:
                self.command_sock.sendto(packet, (self.device_ip, self.device_port))
                print(f"Sent command: Actuator {actuator_id} -> {'ON' if actuator_state else 'OFF'}")
            else:
                print(f"Error: Failed to create packet for actuator {actuator_id}")
        except OSError as e:
            err = e.errno
            if err == 65:  # EHOSTUNREACH on macOS: No route to host
                msg = f"No route to host — check device IP ({self.device_ip}) and that this computer is on the same network (e.g. 192.168.2.x)"
            elif err == 64:  # ENETUNREACH: Network unreachable
                msg = f"Network unreachable — check WiFi/Ethernet and that device IP {self.device_ip} is on the same subnet"
            else:
                msg = f"Network error sending command: [{err}] {e}"
            print(f"Error sending command: {e}")
            self.status_label.setText(msg)
        except Exception as e:
            print(f"Error sending command: {e}")
            self.status_label.setText(f"Error sending command: {e}")
    
    def update_current_display(self):
        """Update the voltage reading display for all actuators"""
        for i in range(NUM_ACTUATORS):
            voltage = self.voltage_readings[i]
            widget = self.actuator_widgets[i]
            
            # Display voltage directly
            widget['voltage_label'].setText(f"Voltage: {voltage:.3f} V")
    
    def show_settings(self):
        """Show settings dialog"""
        dialog = SettingsDialog(self)
        if dialog.exec():
            self.device_ip = dialog.device_ip
            self.device_port = dialog.device_port
            self.receive_port = dialog.receive_port
            self.setWindowTitle(f"Actuator Control - {self.device_ip}:{self.device_port}")
            
            # Restart receiver with new port
            if self.receiver:
                self.receiver.stop()
                self.receiver.wait(2000)
            self.start_receiver()
    
    def closeEvent(self, event):
        """Handle window close event"""
        if self.receiver:
            self.receiver.stop()
            self.receiver.wait(2000)
        if self.command_sock:
            try:
                self.command_sock.close()
            except:
                pass
        event.accept()


# ---------------------- Settings Dialog ----------------------
class SettingsDialog(QtWidgets.QDialog):
    def __init__(self, parent):
        super().__init__(parent)
        self.setWindowTitle("Settings")
        self.device_ip = parent.device_ip
        self.device_port = parent.device_port
        self.receive_port = parent.receive_port
        
        layout = QtWidgets.QVBoxLayout(self)
        
        # Device IP
        layout.addWidget(QtWidgets.QLabel("Device IP Address:"))
        self.ip_edit = QtWidgets.QLineEdit(self.device_ip)
        layout.addWidget(self.ip_edit)
        
        # Device port
        layout.addWidget(QtWidgets.QLabel("Device Port (for commands):"))
        self.device_port_edit = QtWidgets.QSpinBox()
        self.device_port_edit.setRange(1, 65535)
        self.device_port_edit.setValue(self.device_port)
        layout.addWidget(self.device_port_edit)
        
        # Receive port
        layout.addWidget(QtWidgets.QLabel("Receive Port (for sensor data):"))
        self.receive_port_edit = QtWidgets.QSpinBox()
        self.receive_port_edit.setRange(1, 65535)
        self.receive_port_edit.setValue(self.receive_port)
        layout.addWidget(self.receive_port_edit)
        
        # Buttons
        btn_layout = QtWidgets.QHBoxLayout()
        ok_btn = QtWidgets.QPushButton("OK")
        ok_btn.clicked.connect(self.accept)
        cancel_btn = QtWidgets.QPushButton("Cancel")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(ok_btn)
        btn_layout.addWidget(cancel_btn)
        layout.addLayout(btn_layout)
    
    def accept(self):
        """Validate and accept settings"""
        self.device_ip = self.ip_edit.text()
        self.device_port = self.device_port_edit.value()
        self.receive_port = self.receive_port_edit.value()
        super().accept()


def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Actuator Control GUI',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                              # Use default IP and ports
  %(prog)s -i 192.168.2.100             # Specify device IP
  %(prog)s -i 192.168.2.100 -p 5005     # Specify device IP and port
  %(prog)s -i 192.168.2.100 -p 5005 -r 5006  # Specify all ports
        """
    )
    parser.add_argument(
        '-i', '--ip',
        type=str,
        default=DEFAULT_DEVICE_IP,
        help=f'Actuator board IP address (default: {DEFAULT_DEVICE_IP})'
    )
    parser.add_argument(
        '-p', '--port',
        type=int,
        default=DEFAULT_DEVICE_PORT,
        help=f'Device UDP port for commands (default: {DEFAULT_DEVICE_PORT})'
    )
    parser.add_argument(
        '-r', '--receive-port',
        type=int,
        default=DEFAULT_RECEIVE_PORT,
        help=f'UDP port to receive sensor data on (default: {DEFAULT_RECEIVE_PORT})'
    )
    
    args = parser.parse_args()
    
    app = QtWidgets.QApplication(sys.argv)
    window = ActuatorControlWindow(
        device_ip=args.ip,
        device_port=args.port,
        receive_port=args.receive_port
    )
    window.show()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()

