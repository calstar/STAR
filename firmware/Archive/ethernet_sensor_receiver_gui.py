#!/usr/bin/env python3
"""
Ethernet Sensor Data Receiver with GUI
Receives UDP packets from ethernet link, decodes sensor data packets using DAQv2-Comms protocol,
and displays real-time plots for each sensor with statistics.

Requirements: pip install pyqt6 pyqtgraph numpy
"""

import socket
import struct
import sys
import time
from typing import Optional, Tuple, List, Dict
from collections import deque

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

# Default UDP port and device IP
DEFAULT_PORT = 5006
DEFAULT_DEVICE_IP = '192.168.2.101'  # Sensor board IP address

# Struct format strings (little-endian, matching C++ packed structs)
PACKET_HEADER_FORMAT = '<BBI'  # 6 bytes total
PACKET_HEADER_SIZE = 6

SENSOR_DATA_PACKET_FORMAT = '<BB'  # 2 bytes
SENSOR_DATA_PACKET_SIZE = 2

SENSOR_DATA_CHUNK_FORMAT = '<I'  # 4 bytes
SENSOR_DATA_CHUNK_SIZE = 4

# SensorDatapoint: sensor_id (uint8_t), data (float - sent as uint32_t but interpreted as float)
SENSOR_DATAPOINT_FORMAT = '<BI'  # 5 bytes: uint8_t sensor_id + uint32_t data
SENSOR_DATAPOINT_SIZE = 5

# Plotting constants
DEFAULT_WINDOW_SECONDS = 10.0
MAX_POINTS = 10000
UPDATE_INTERVAL_MS = 50  # Update plots every 50ms
NUM_CONNECTORS = 10  # Number of connectors being cycled (1-10)

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

pg.setConfigOptions(antialias=False)


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


# ---------------------- UDP Receiver Thread ----------------------
class UDPReceiver(QtCore.QThread):
    """Thread that receives UDP packets and emits decoded sensor data"""
    sensor_data_received = QtCore.pyqtSignal(dict, list)  # header, chunks
    status_update = QtCore.pyqtSignal(str)
    packet_received = QtCore.pyqtSignal(int, int)  # packet_size, packet_type
    
    def __init__(self, port: int = DEFAULT_PORT, bind_address: str = '0.0.0.0'):
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
                        self.sensor_data_received.emit(header_dict, chunks)
                        
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


# ---------------------- Main Application Window ----------------------
class SensorPlotWindow(QtWidgets.QMainWindow):
    def __init__(self, port: int = DEFAULT_PORT, bind_address: str = '0.0.0.0'):
        super().__init__()
        self.port = port
        self.bind_address = bind_address
        self.window_seconds = DEFAULT_WINDOW_SECONDS
        self.display_moving_avg_samples = 10  # Moving average for displayed values
        self.graph_moving_avg_samples = 1  # Moving average for graphed lines (1 = no smoothing)
        
        # ADC conversion settings
        self.adc_bits = 32  # ADC bit count (default: 32-bit)
        self.reference_voltage = 2.5  # Reference voltage in Volts (default: 2.5V)
        
        # Data storage: sensor_id -> deque of (timestamp_ms, value)
        self.sensor_data: Dict[int, deque] = {}
        self.sensor_plots: Dict[int, pg.PlotDataItem] = {}
        
        # Statistics
        self.stats_start_time = time.time()
        
        # UDP receiver thread
        self.receiver = None
        
        self.init_ui()
        self.start_receiver()
        
        # Timer for updating plots and statistics
        self.update_timer = QtCore.QTimer()
        self.update_timer.timeout.connect(self.update_plots)
        self.update_timer.start(UPDATE_INTERVAL_MS)
        
        # Timer for updating statistics display
        self.stats_timer = QtCore.QTimer()
        self.stats_timer.timeout.connect(self.update_statistics)
        self.stats_timer.start(500)  # Update stats every 500ms
    
    def init_ui(self):
        """Initialize the user interface"""
        self.setWindowTitle(f"Ethernet Sensor Data Receiver - Port {self.port}")
        self.setGeometry(100, 100, 1200, 800)
        
        # Central widget
        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        layout = QtWidgets.QVBoxLayout(central)
        
        # Top panel with controls (no statistics here anymore)
        top_panel = QtWidgets.QHBoxLayout()
        
        # Connection info
        self.status_label = QtWidgets.QLabel("Starting...")
        self.status_label.setStyleSheet("font-weight: bold; padding: 5px;")
        top_panel.addWidget(self.status_label)
        
        top_panel.addStretch()
        
        # Settings button
        settings_btn = QtWidgets.QPushButton("Settings")
        settings_btn.clicked.connect(self.show_settings)
        top_panel.addWidget(settings_btn)
        
        layout.addLayout(top_panel)
        
        # Horizontal layout for plot and statistics
        plot_stats_layout = QtWidgets.QHBoxLayout()
        
        # Plot widget
        self.plot_widget = pg.GraphicsLayoutWidget()
        self.plot_widget.setBackground('k')  # Black background
        plot_stats_layout.addWidget(self.plot_widget, 1)  # Takes most of the space
        
        # Statistics panel on the right
        stats_widget = QtWidgets.QWidget()
        stats_main_layout = QtWidgets.QVBoxLayout(stats_widget)
        stats_main_layout.setContentsMargins(0, 0, 0, 0)
        
        # Network statistics group
        network_stats_group = QtWidgets.QGroupBox("Network")
        network_stats_layout = QtWidgets.QVBoxLayout()
        
        self.packets_label = QtWidgets.QLabel("Packets: 0")
        self.pps_label = QtWidgets.QLabel("Packets/sec: 0.0")
        self.bytes_label = QtWidgets.QLabel("Bytes: 0")
        self.bps_label = QtWidgets.QLabel("Bytes/sec: 0.0")
        
        # Increase font size for statistics
        font = QtGui.QFont()
        font.setPointSize(10)
        self.packets_label.setFont(font)
        self.pps_label.setFont(font)
        self.bytes_label.setFont(font)
        self.bps_label.setFont(font)
        
        network_stats_layout.addWidget(self.packets_label)
        network_stats_layout.addWidget(self.pps_label)
        network_stats_layout.addWidget(self.bytes_label)
        network_stats_layout.addWidget(self.bps_label)
        network_stats_group.setLayout(network_stats_layout)
        stats_main_layout.addWidget(network_stats_group)
        
        # Connector statistics group with scrollable area
        connector_stats_group = QtWidgets.QGroupBox("Sensors")
        connector_stats_group_layout = QtWidgets.QVBoxLayout()
        
        # Moving average controls
        ma_group = QtWidgets.QGroupBox("Moving Average")
        ma_group_layout = QtWidgets.QVBoxLayout()
        
        # Graph moving average
        graph_ma_layout = QtWidgets.QHBoxLayout()
        graph_ma_layout.addWidget(QtWidgets.QLabel("Graph:"))
        self.graph_ma_spinbox = QtWidgets.QSpinBox()
        self.graph_ma_spinbox.setMinimum(1)
        self.graph_ma_spinbox.setMaximum(100)
        self.graph_ma_spinbox.setValue(self.graph_moving_avg_samples)
        self.graph_ma_spinbox.setSuffix(" samples")
        self.graph_ma_spinbox.valueChanged.connect(self.on_graph_moving_avg_changed)
        graph_ma_layout.addWidget(self.graph_ma_spinbox)
        ma_group_layout.addLayout(graph_ma_layout)
        
        # Display moving average
        display_ma_layout = QtWidgets.QHBoxLayout()
        display_ma_layout.addWidget(QtWidgets.QLabel("Display:"))
        self.display_ma_spinbox = QtWidgets.QSpinBox()
        self.display_ma_spinbox.setMinimum(1)
        self.display_ma_spinbox.setMaximum(100)
        self.display_ma_spinbox.setValue(self.display_moving_avg_samples)
        self.display_ma_spinbox.setSuffix(" samples")
        self.display_ma_spinbox.valueChanged.connect(self.on_display_moving_avg_changed)
        display_ma_layout.addWidget(self.display_ma_spinbox)
        ma_group_layout.addLayout(display_ma_layout)
        
        ma_group.setLayout(ma_group_layout)
        connector_stats_group_layout.addWidget(ma_group)
        
        # Scrollable area for connector values
        connector_scroll = QtWidgets.QScrollArea()
        connector_scroll.setWidgetResizable(True)
        connector_scroll.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        
        connector_stats_content = QtWidgets.QWidget()
        connector_stats_layout = QtWidgets.QVBoxLayout(connector_stats_content)
        connector_stats_layout.setSpacing(5)
        
        # Create labels for each connector
        self.connector_labels = {}
        small_font = QtGui.QFont()
        small_font.setPointSize(9)
        
        for i in range(1, NUM_CONNECTORS + 1):
            label = QtWidgets.QLabel(f"C{i}: --- V")
            label.setFont(small_font)
            color_idx = i % len(SENSOR_COLORS)
            color = SENSOR_COLORS[color_idx]
            label.setStyleSheet(f"color: rgb{color}; padding: 2px;")
            connector_stats_layout.addWidget(label)
            self.connector_labels[i] = label
        
        connector_stats_layout.addStretch()  # Push connectors to top
        connector_scroll.setWidget(connector_stats_content)
        connector_stats_group_layout.addWidget(connector_scroll)
        connector_stats_group.setLayout(connector_stats_group_layout)
        stats_main_layout.addWidget(connector_stats_group, 1)
        
        stats_widget.setFixedWidth(250)  # Fixed width for stats panel
        plot_stats_layout.addWidget(stats_widget)
        
        layout.addLayout(plot_stats_layout, 1)
        
        # Create initial plot (will be updated when sensors are discovered)
        self.plot_item = self.plot_widget.addPlot(title="Sensor Data Over Time (Sensors 1-10)")
        
        # Set title color and size to white for visibility on black background
        self.plot_item.setTitle("Sensor Data Over Time (Sensors 1-10)", color='w', size='14pt')
        
        # Set axis labels to white
        self.plot_item.setLabel('left', 'Voltage (V)', color='w')
        self.plot_item.setLabel('bottom', 'Time (seconds)', color='w')
        
        self.plot_item.addLegend()
        # Show grid with white/gray lines for visibility on black background
        self.plot_item.showGrid(x=True, y=True, alpha=0.5)
        # Set grid color to light gray/white
        self.plot_item.getViewBox().setBackgroundColor('k')  # Ensure black background
        
        # Increase font size for axis labels and ticks
        font = QtGui.QFont()
        font.setPointSize(12)
        
        # Set all axis text to white
        left_axis = self.plot_item.getAxis('left')
        bottom_axis = self.plot_item.getAxis('bottom')
        
        # Set font size for ticks (labelFont is not a valid parameter in setStyle)
        left_axis.setStyle(tickFont=font)
        bottom_axis.setStyle(tickFont=font)
        
        # Set label font size by accessing the label item directly
        try:
            left_axis.label.setFont(font)
            bottom_axis.label.setFont(font)
        except AttributeError:
            # If label doesn't have setFont, labels will use default size
            pass
        
        # Set axis line and text colors to white
        left_axis.setPen('w')
        bottom_axis.setPen('w')
        left_axis.setTextPen('w')  # This sets tick text color to white
        bottom_axis.setTextPen('w')  # This sets tick text color to white
        
        # Legend - make it visible on black background with white text
        self.legend = self.plot_item.legend
        if self.legend:
            self.legend.setBrush(pg.mkBrush('k'))  # Black background for legend
            self.legend.setPen(pg.mkPen('w'))  # White border
            # Set legend label text color to white
            # The legend items will be updated when sensors are added
        
        # Pre-initialize plots for all 10 connectors
        self.init_connector_plots()
        
    def init_connector_plots(self):
        """Pre-initialize plots for all 10 connectors"""
        for connector_id in range(1, NUM_CONNECTORS + 1):
            self.sensor_data[connector_id] = deque(maxlen=MAX_POINTS)
            self.add_sensor_plot(connector_id)
    
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
    
    def start_receiver(self):
        """Start the UDP receiver thread"""
        self.receiver = UDPReceiver(port=self.port, bind_address=self.bind_address)
        self.receiver.sensor_data_received.connect(self.on_sensor_data)
        self.receiver.status_update.connect(self.on_status_update)
        self.receiver.packet_received.connect(self.on_packet_received)
        self.receiver.start()
    
    def on_status_update(self, message: str):
        """Handle status updates from receiver thread"""
        self.status_label.setText(message)
    
    def on_packet_received(self, packet_size: int, packet_type: int):
        """Handle packet received notification"""
        pass  # Statistics are updated separately
    
    def on_sensor_data(self, header: dict, chunks: List[dict]):
        """Handle received sensor data"""
        current_time = time.time()
        
        for chunk in chunks:
            chunk_timestamp_ms = chunk['timestamp']
            # Convert packet timestamp to relative time in seconds
            # Use current time as reference since we don't have absolute time sync
            relative_time = (current_time - self.stats_start_time)
            
            for dp in chunk['datapoints']:
                sensor_id = dp['sensor_id']
                code_uint32 = dp['data']  # Received as uint32_t from protocol
                
                # Convert code to voltage
                voltage = self.code_to_voltage(code_uint32)
                
                # Initialize sensor data storage if needed (for sensors outside 1-10 range)
                if sensor_id not in self.sensor_data:
                    self.sensor_data[sensor_id] = deque(maxlen=MAX_POINTS)
                    self.add_sensor_plot(sensor_id)
                
                # Add data point (use relative time from start)
                self.sensor_data[sensor_id].append((relative_time, voltage))
    
    def add_sensor_plot(self, sensor_id: int):
        """Add a new sensor plot"""
        color_idx = sensor_id % len(SENSOR_COLORS)
        color = SENSOR_COLORS[color_idx]
        
        pen = pg.mkPen(color=color, width=2)
        plot = self.plot_item.plot([], [], pen=pen, name=f"Sensor {sensor_id}")
        
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
        """Update all sensor plots"""
        if not self.sensor_data:
            return
        
        current_time = time.time() - self.stats_start_time
        time_window = self.window_seconds
        
        for sensor_id, data_deque in self.sensor_data.items():
            if sensor_id not in self.sensor_plots:
                continue
            
            if len(data_deque) == 0:
                continue
            
            # Extract time and value arrays
            times = []
            values = []
            
            for t, v in data_deque:
                # Only show data within the time window
                if current_time - t <= time_window:
                    times.append(t)
                    values.append(v)
            
            if len(times) > 0:
                # Convert to numpy arrays
                times_array = np.array(times)
                values_array = np.array(values)
                
                # Apply moving average smoothing to graph if window > 1
                if self.graph_moving_avg_samples > 1 and len(values_array) >= self.graph_moving_avg_samples:
                    # Use convolution for efficient moving average
                    kernel = np.ones(self.graph_moving_avg_samples) / self.graph_moving_avg_samples
                    smoothed_values = np.convolve(values_array, kernel, mode='valid')
                    # Adjust times array to match smoothed data length
                    smoothed_times = times_array[self.graph_moving_avg_samples - 1:]
                    
                    # Update plot with smoothed data
                    self.sensor_plots[sensor_id].setData(smoothed_times, smoothed_values)
                else:
                    # Update plot with raw data
                    self.sensor_plots[sensor_id].setData(times_array, values_array)
        
        # Update x-axis range
        if current_time > time_window:
            self.plot_item.setXRange(current_time - time_window, current_time, padding=0)
        else:
            self.plot_item.setXRange(0, time_window, padding=0)
    
    def update_statistics(self):
        """Update statistics display"""
        if self.receiver is None:
            return
        
        stats = self.receiver.get_stats()
        
        self.packets_label.setText(f"Packets: {stats['packets']}")
        self.pps_label.setText(f"Packets/sec: {stats['packets_per_sec']:.2f}")
        
        # Format bytes
        bytes_val = stats['bytes']
        if bytes_val < 1024:
            bytes_str = f"{bytes_val} B"
        elif bytes_val < 1024 * 1024:
            bytes_str = f"{bytes_val / 1024:.2f} KB"
        else:
            bytes_str = f"{bytes_val / (1024 * 1024):.2f} MB"
        self.bytes_label.setText(f"Bytes: {bytes_str}")
        
        # Format bytes per second
        bps = stats['bytes_per_sec']
        if bps < 1024:
            bps_str = f"{bps:.2f} B/s"
        elif bps < 1024 * 1024:
            bps_str = f"{bps / 1024:.2f} KB/s"
        else:
            bps_str = f"{bps / (1024 * 1024):.2f} MB/s"
        self.bps_label.setText(f"Bytes/sec: {bps_str}")
        
        # Update per-connector statistics
        for connector_id in range(1, NUM_CONNECTORS + 1):
            if connector_id in self.sensor_data and len(self.sensor_data[connector_id]) > 0:
                # Get latest values
                values = [v for t, v in self.sensor_data[connector_id]]
                if values:
                    current = values[-1]
                    
                    # Calculate moving average over last N samples for display
                    n_samples = min(self.display_moving_avg_samples, len(values))
                    moving_avg = sum(values[-n_samples:]) / n_samples
                    
                    self.connector_labels[connector_id].setText(
                        f"C{connector_id}: {current:.4f} V\n"
                        f"  MA: {moving_avg:.4f} V"
                    )
                else:
                    self.connector_labels[connector_id].setText(f"C{connector_id}: --- V")
            else:
                self.connector_labels[connector_id].setText(f"C{connector_id}: --- V")
    
    def show_settings(self):
        """Show settings dialog"""
        dialog = SettingsDialog(self)
        if dialog.exec():
            self.window_seconds = dialog.window_seconds
            self.adc_bits = dialog.adc_bits
            self.reference_voltage = dialog.reference_voltage
    
    def closeEvent(self, event):
        """Handle window close event"""
        if self.receiver:
            self.receiver.stop()
            self.receiver.wait(2000)
        event.accept()


# ---------------------- Settings Dialog ----------------------
class SettingsDialog(QtWidgets.QDialog):
    def __init__(self, parent):
        super().__init__(parent)
        self.setWindowTitle("Settings")
        self.window_seconds = parent.window_seconds
        self.adc_bits = parent.adc_bits
        self.reference_voltage = parent.reference_voltage
        
        layout = QtWidgets.QVBoxLayout(self)
        
        # Time window
        layout.addWidget(QtWidgets.QLabel("Time Window (seconds)"))
        row = QtWidgets.QHBoxLayout()
        self.slider = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.slider.setMinimum(1)
        self.slider.setMaximum(60)
        self.slider.setValue(int(self.window_seconds))
        self.slider.valueChanged.connect(self._on_time_window_change)
        self.lbl = QtWidgets.QLabel(f"{self.window_seconds:.1f}s")
        row.addWidget(self.slider, 1)
        row.addWidget(self.lbl)
        layout.addLayout(row)
        
        # ADC Settings group
        adc_group = QtWidgets.QGroupBox("ADC Conversion Settings")
        adc_layout = QtWidgets.QVBoxLayout()
        
        # ADC bit count
        adc_layout.addWidget(QtWidgets.QLabel("ADC Bit Count:"))
        self.adc_bits_spinbox = QtWidgets.QSpinBox()
        self.adc_bits_spinbox.setRange(8, 32)
        self.adc_bits_spinbox.setValue(self.adc_bits)
        self.adc_bits_spinbox.setSuffix(" bits")
        adc_layout.addWidget(self.adc_bits_spinbox)
        
        # Reference voltage
        adc_layout.addWidget(QtWidgets.QLabel("Reference Voltage (V):"))
        self.ref_voltage_spinbox = QtWidgets.QDoubleSpinBox()
        self.ref_voltage_spinbox.setRange(0.1, 10.0)
        self.ref_voltage_spinbox.setSingleStep(0.1)
        self.ref_voltage_spinbox.setDecimals(3)
        self.ref_voltage_spinbox.setValue(self.reference_voltage)
        self.ref_voltage_spinbox.setSuffix(" V")
        adc_layout.addWidget(self.ref_voltage_spinbox)
        
        adc_group.setLayout(adc_layout)
        layout.addWidget(adc_group)
        
        # Close button
        btn = QtWidgets.QPushButton("Close")
        btn.clicked.connect(self.accept)
        layout.addWidget(btn)
    
    def _on_time_window_change(self, val):
        self.window_seconds = float(val)
        self.lbl.setText(f"{float(val):.1f}s")
    
    def accept(self):
        """Update values when dialog is accepted"""
        self.adc_bits = self.adc_bits_spinbox.value()
        self.reference_voltage = self.ref_voltage_spinbox.value()
        super().accept()


def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Ethernet Sensor Data Receiver with GUI',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                    # Listen on default port 5006
  %(prog)s -p 5007            # Listen on port 5007
  %(prog)s -a 192.168.2.100   # Bind to specific IP address
        """
    )
    parser.add_argument(
        '-p', '--port',
        type=int,
        default=DEFAULT_PORT,
        help=f'UDP port to listen on (default: {DEFAULT_PORT})'
    )
    parser.add_argument(
        '-a', '--address',
        type=str,
        default='0.0.0.0',
        help='IP address to bind to (default: 0.0.0.0 for all interfaces)'
    )
    
    args = parser.parse_args()
    
    app = QtWidgets.QApplication(sys.argv)
    window = SensorPlotWindow(port=args.port, bind_address=args.address)
    window.show()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()

