#!/usr/bin/env python3
"""
Smart Calibration GUI with Progressive Autonomy
Human-in-the-loop system that becomes autonomous over time
"""

import sys
import os
import time
import threading
import queue
import json
import numpy as np
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure

# import serial
import struct
from collections import deque
from datetime import datetime
import logging
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
from enum import Enum
import subprocess

# Import the robust calibration framework
from robust_calibration import (
    RobustCalibrationFramework,
    CalibrationPoint,
    EnvironmentalState,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


class ConfidenceLevel(Enum):
    LOW = 0
    MEDIUM = 1
    HIGH = 2
    MAXIMUM = 3


@dataclass
class HumanInputRequest:
    sensor_id: int
    current_voltage: float
    predicted_pressure: float
    confidence_interval_lower: float
    confidence_interval_upper: float
    reason: str
    timestamp: float
    request_id: int


@dataclass
class SensorLearningState:
    confidence_level: ConfidenceLevel
    human_input_count: int
    autonomous_success_count: int
    autonomous_failure_count: int
    reliability_score: float
    last_human_input: float
    calibration_data_points: int


class SmartCalibrationGUI:
    """Smart calibration GUI with progressive autonomy"""

    def __init__(self):
        self.root = tk.Tk()
        self.root.title("Smart PT Calibration System - Diablo FSW")
        self.root.geometry("1800x1200")
        self.root.configure(bg="#2b2b2b")

        # Data structures
        self.sensor_states: Dict[int, SensorLearningState] = {}
        self.pending_requests: List[HumanInputRequest] = []
        self.latest_measurements: Dict[int, Dict] = {}
        # Robust calibration frameworks for each sensor
        self.calibration_frameworks: Dict[int, RobustCalibrationFramework] = {
            i: RobustCalibrationFramework(i) for i in range(9)
        }

        # Legacy calibration data (for backward compatibility)
        self.calibration_data: Dict[int, List] = {i: [] for i in range(9)}

        # Packet parsing structures - EXACT copy from channel_plotter.py
        self.HEADER_STRUCT = struct.Struct("<4sBBHHII")
        self.RECORD_STRUCT = struct.Struct("<BBiiII")

        # Constants from channel_plotter.py
        self.MAGIC = b"AD26"
        self.PACKET_VERSION = 2
        self.CRC_SIZE_OPTIONAL = 4
        self.HEADER_SIZE = self.HEADER_STRUCT.size
        self.RECORD_SIZE = self.RECORD_STRUCT.size
        self.PACKET_RECORDS = 10
        self.FLAG_TIMING = 0x01
        self.MAX_PACKET_BYTES = (
            self.HEADER_SIZE
            + self.PACKET_RECORDS * self.RECORD_SIZE
            + self.CRC_SIZE_OPTIONAL
        )
        self.INT32_MIN = -2147483648
        self.UINT32_MAX = 0xFFFFFFFF
        self.V_REF = 2.5
        self.ADC_SCALE = 2147483648.0

        # Real-time data
        self.data_queue = queue.Queue(maxsize=1000)
        self.recording_data = False
        self.autonomous_mode = False
        self.recent_data: Dict[int, List] = {i: [] for i in range(9)}
        self.last_update_time: Dict[int, float] = {i: 0.0 for i in range(9)}

        # Serial connection
        self.serial_connection: Optional[serial.Serial] = None
        self.serial_thread: Optional[threading.Thread] = None
        self.stop_serial = threading.Event()
        self.synced = False

        # Performance tracking
        self.performance_stats = {
            "data_rate_hz": 0.0,
            "latency_ms": 0.0,
            "autonomous_accuracy": 0.0,
            "human_input_requests": 0,
            "last_update": time.time(),
        }

        # Initialize GUI
        self.setup_gui()
        self.setup_serial()
        self.start_data_processing()

    def setup_gui(self):
        """Setup the GUI layout"""
        # Main container
        main_frame = ttk.Frame(self.root)
        main_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        # Control panel
        self.setup_control_panel(main_frame)

        # Data display area
        self.setup_data_display(main_frame)

        # Human input panel
        self.setup_human_input_panel(main_frame)

        # Real-time plots
        self.setup_realtime_plots(main_frame)

        # Status and statistics
        self.setup_status_panel(main_frame)

    def setup_control_panel(self, parent):
        """Setup control panel"""
        control_frame = ttk.LabelFrame(
            parent, text="Smart Calibration Controls", padding=10
        )
        control_frame.grid(row=0, column=0, columnspan=3, sticky="ew", pady=(0, 10))

        # Connection controls
        conn_frame = ttk.Frame(control_frame)
        conn_frame.pack(fill=tk.X, pady=(0, 10))

        ttk.Label(conn_frame, text="Serial Port:").pack(side=tk.LEFT)
        self.port_var = tk.StringVar(value="/dev/ttyACM0")
        port_combo = ttk.Combobox(conn_frame, textvariable=self.port_var, width=15)
        port_combo["values"] = self.get_available_ports()
        port_combo.pack(side=tk.LEFT, padx=(5, 10))

        self.connect_btn = ttk.Button(
            conn_frame, text="Connect", command=self.toggle_connection
        )
        self.connect_btn.pack(side=tk.LEFT, padx=(0, 10))

        # Smart calibration controls
        smart_frame = ttk.Frame(control_frame)
        smart_frame.pack(fill=tk.X, pady=(0, 10))

        self.autonomous_btn = ttk.Button(
            smart_frame,
            text="Enable Autonomous Mode",
            command=self.toggle_autonomous_mode,
            state="disabled",
        )
        self.autonomous_btn.pack(side=tk.LEFT, padx=(0, 10))

        self.learn_btn = ttk.Button(
            smart_frame,
            text="Start Learning",
            command=self.start_learning,
            state="disabled",
        )
        self.learn_btn.pack(side=tk.LEFT, padx=(0, 10))

        self.validate_btn = ttk.Button(
            smart_frame,
            text="Validate Prediction",
            command=self.validate_prediction,
            state="disabled",
        )
        self.validate_btn.pack(side=tk.LEFT, padx=(0, 10))

        self.save_btn = ttk.Button(
            smart_frame,
            text="Save Learning State",
            command=self.save_learning_state,
            state="disabled",
        )
        self.save_btn.pack(side=tk.LEFT)

    def setup_data_display(self, parent):
        """Setup real-time data display"""
        data_frame = ttk.LabelFrame(parent, text="Real-Time Sensor Data", padding=10)
        data_frame.grid(row=1, column=0, sticky="nsew", padx=(0, 5), pady=(0, 5))

        # Create data display tree
        columns = (
            "Sensor",
            "Location",
            "Voltage (V)",
            "Predicted (kPa)",
            "Confidence",
            "Status",
        )
        self.data_tree = ttk.Treeview(
            data_frame, columns=columns, show="headings", height=12
        )

        for col in columns:
            self.data_tree.heading(col, text=col)
            self.data_tree.column(col, width=120, anchor="center")

        # Add scrollbar
        scrollbar = ttk.Scrollbar(
            data_frame, orient=tk.VERTICAL, command=self.data_tree.yview
        )
        self.data_tree.configure(yscrollcommand=scrollbar.set)

        self.data_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # Initialize sensor rows
        pt_locations = [
            "Pressurant Tank",
            "Kero Inlet",
            "Kero Outlet",
            "Lox Inlet",
            "Lox Outlet",
            "Injector",
            "Chamber Wall #1",
            "Chamber Wall #2",
            "Nozzle Exit",
        ]

        for i, location in enumerate(pt_locations):
            self.data_tree.insert(
                "",
                "end",
                values=(f"PT {i}", location, "0.000", "0.000", "LOW", "Offline"),
            )

    def setup_human_input_panel(self, parent):
        """Setup human input panel"""
        input_frame = ttk.LabelFrame(parent, text="Human Input Interface", padding=10)
        input_frame.grid(row=1, column=1, sticky="nsew", padx=(5, 5), pady=(0, 5))

        # Pending requests display
        ttk.Label(input_frame, text="Pending Human Input Requests:").pack(anchor="w")

        self.requests_listbox = tk.Listbox(
            input_frame, height=8, bg="#3b3b3b", fg="white"
        )
        self.requests_listbox.pack(fill=tk.X, pady=(5, 10))

        # Input controls
        input_controls_frame = ttk.Frame(input_frame)
        input_controls_frame.pack(fill=tk.X)

        ttk.Label(input_controls_frame, text="Selected Sensor:").pack(anchor="w")
        self.selected_sensor_var = tk.StringVar()
        sensor_combo = ttk.Combobox(
            input_controls_frame, textvariable=self.selected_sensor_var, width=15
        )
        sensor_combo["values"] = [f"PT {i}" for i in range(9)]
        sensor_combo.pack(fill=tk.X, pady=(0, 5))

        ttk.Label(input_controls_frame, text="Reference Pressure (kPa):").pack(
            anchor="w"
        )
        self.ref_pressure_var = tk.StringVar()
        ref_entry = ttk.Entry(input_controls_frame, textvariable=self.ref_pressure_var)
        ref_entry.pack(fill=tk.X, pady=(0, 5))

        self.confirm_btn = ttk.Button(
            input_controls_frame,
            text="Confirm Input",
            command=self.confirm_human_input,
            state="disabled",
        )
        self.confirm_btn.pack(fill=tk.X, pady=(0, 5))

        self.skip_btn = ttk.Button(
            input_controls_frame,
            text="Skip Request",
            command=self.skip_human_input,
            state="disabled",
        )
        self.skip_btn.pack(fill=tk.X)

        # Learning progress
        progress_frame = ttk.Frame(input_frame)
        progress_frame.pack(fill=tk.X, pady=(10, 0))

        ttk.Label(progress_frame, text="Learning Progress:").pack(anchor="w")

        # Progress bars for each sensor
        self.progress_vars = {}
        self.progress_bars = {}

        for i in range(9):
            progress_frame_sensor = ttk.Frame(progress_frame)
            progress_frame_sensor.pack(fill=tk.X, pady=2)

            ttk.Label(progress_frame_sensor, text=f"PT {i}:", width=8).pack(
                side=tk.LEFT
            )

            self.progress_vars[i] = tk.DoubleVar()
            progress_bar = ttk.Progressbar(
                progress_frame_sensor,
                variable=self.progress_vars[i],
                maximum=100,
                length=100,
            )
            progress_bar.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(5, 5))

            self.progress_bars[i] = ttk.Label(progress_frame_sensor, text="0%", width=6)
            self.progress_bars[i].pack(side=tk.RIGHT)

    def setup_realtime_plots(self, parent):
        """Setup real-time plotting area"""
        plot_frame = ttk.LabelFrame(parent, text="Real-Time Monitoring", padding=10)
        plot_frame.grid(row=1, column=2, sticky="nsew", padx=(5, 0), pady=(0, 5))

        # Create matplotlib figure
        self.fig = Figure(figsize=(10, 8), dpi=100)
        self.fig.patch.set_facecolor("#2b2b2b")

        # Create subplots
        self.ax_voltage = self.fig.add_subplot(3, 1, 1)
        self.ax_pressure = self.fig.add_subplot(3, 1, 2)
        self.ax_confidence = self.fig.add_subplot(3, 1, 3)

        # Configure plots
        self.ax_voltage.set_title("Real-Time Voltage Readings", color="white")
        self.ax_voltage.set_ylabel("Voltage (V)", color="white")
        self.ax_voltage.tick_params(colors="white")
        self.ax_voltage.set_facecolor("#3b3b3b")

        self.ax_pressure.set_title("Real-Time Pressure Readings", color="white")
        self.ax_pressure.set_ylabel("Pressure (kPa)", color="white")
        self.ax_pressure.tick_params(colors="white")
        self.ax_pressure.set_facecolor("#3b3b3b")

        self.ax_confidence.set_title("Confidence Levels", color="white")
        self.ax_confidence.set_xlabel("Time (s)", color="white")
        self.ax_confidence.set_ylabel("Confidence", color="white")
        self.ax_confidence.tick_params(colors="white")
        self.ax_confidence.set_facecolor("#3b3b3b")

        # Embed in tkinter
        self.canvas = FigureCanvasTkAgg(self.fig, plot_frame)
        self.canvas.get_tk_widget().pack(fill=tk.BOTH, expand=True)

        # Initialize plot data
        self.plot_data = {
            "time": deque(maxlen=1000),
            "voltages": {i: deque(maxlen=1000) for i in range(9)},
            "pressures": {i: deque(maxlen=1000) for i in range(9)},
            "confidence": {i: deque(maxlen=1000) for i in range(9)},
        }

    def setup_status_panel(self, parent):
        """Setup status and statistics panel"""
        status_frame = ttk.LabelFrame(
            parent, text="System Status & Statistics", padding=10
        )
        status_frame.grid(row=2, column=0, columnspan=3, sticky="ew", pady=(5, 0))

        # Status indicators
        status_indicators_frame = ttk.Frame(status_frame)
        status_indicators_frame.pack(fill=tk.X, pady=(0, 10))

        self.status_var = tk.StringVar(value="Ready")
        ttk.Label(status_indicators_frame, textvariable=self.status_var).pack(
            side=tk.LEFT
        )

        # Performance indicators
        perf_frame = ttk.Frame(status_indicators_frame)
        perf_frame.pack(side=tk.RIGHT)

        self.data_rate_var = tk.StringVar(value="Data Rate: 0 Hz")
        self.latency_var = tk.StringVar(value="Latency: 0 ms")
        self.accuracy_var = tk.StringVar(value="Accuracy: 0%")
        self.autonomy_var = tk.StringVar(value="Autonomy: 0%")

        ttk.Label(perf_frame, textvariable=self.data_rate_var).pack(
            side=tk.LEFT, padx=(10, 0)
        )
        ttk.Label(perf_frame, textvariable=self.latency_var).pack(
            side=tk.LEFT, padx=(10, 0)
        )
        ttk.Label(perf_frame, textvariable=self.accuracy_var).pack(
            side=tk.LEFT, padx=(10, 0)
        )
        ttk.Label(perf_frame, textvariable=self.autonomy_var).pack(
            side=tk.LEFT, padx=(10, 0)
        )

        # Statistics table
        stats_frame = ttk.Frame(status_frame)
        stats_frame.pack(fill=tk.X)

        ttk.Label(stats_frame, text="Sensor Statistics:").pack(anchor="w")

        # Create statistics tree
        stats_columns = (
            "Sensor",
            "Confidence",
            "Human Inputs",
            "Success Rate",
            "Reliability",
        )
        self.stats_tree = ttk.Treeview(
            stats_frame, columns=stats_columns, show="headings", height=4
        )

        for col in stats_columns:
            self.stats_tree.heading(col, text=col)
            self.stats_tree.column(col, width=120, anchor="center")

        self.stats_tree.pack(fill=tk.X)

        # Initialize statistics rows
        for i in range(9):
            self.stats_tree.insert(
                "", "end", values=(f"PT {i}", "LOW", "0", "0%", "0%")
            )

        # Configure grid weights
        parent.grid_rowconfigure(1, weight=1)
        parent.grid_columnconfigure(0, weight=1)
        parent.grid_columnconfigure(1, weight=1)
        parent.grid_columnconfigure(2, weight=1)

    def get_available_ports(self):
        """Get list of available serial ports"""
        ports = []
        try:
            import serial.tools.list_ports

            for port in serial.tools.list_ports.comports():
                ports.append(port.device)
        except:
            # Fallback
            ports = ["/tmp/fake_esp32_pipe"]
            for i in range(10):
                ports.extend([f"/dev/ttyUSB{i}", f"/dev/ttyACM{i}", f"COM{i}"])
        return ports

    def setup_serial(self):
        """Setup serial connection with robust error handling"""
        try:
            # Close existing connection if any
            if (
                hasattr(self, "serial_connection")
                and self.serial_connection
                and self.serial_connection.is_open
            ):
                self.serial_connection.close()
                time.sleep(0.1)  # Give it time to close

            # Clear any existing data
            self.recent_data.clear()
            self.last_update_time.clear()

            self.serial_connection = serial.Serial(
                port=self.port_var.get(),
                baudrate=115200,
                timeout=0.05,  # Longer timeout for stability
                write_timeout=0.1,
                inter_byte_timeout=0.1,
                rtscts=False,  # Disable hardware flow control
                dsrdtr=False,  # Disable hardware flow control
                xonxoff=False,  # Disable software flow control
            )

            # Reset buffers and flush
            self.serial_connection.reset_input_buffer()
            self.serial_connection.reset_output_buffer()
            self.serial_connection.flushInput()
            self.serial_connection.flushOutput()

            # Reset packet sync state
            self.synced = False

            logger.info(f"Serial connection established on {self.port_var.get()}")
            return True

        except serial.SerialException as e:
            logger.error(f"Serial port error: {e}")
            messagebox.showerror("Serial Error", f"Serial port error: {e}")
            return False
        except Exception as e:
            logger.error(f"Failed to connect to serial port: {e}")
            messagebox.showerror(
                "Connection Error", f"Failed to connect to {self.port_var.get()}: {e}"
            )
            return False

    def start_data_processing(self):
        """Start the data processing thread"""
        self.data_thread = threading.Thread(target=self.data_processor, daemon=True)
        self.data_thread.start()

        # Start GUI update timer
        self.update_gui()

    def _resync(self, buffer):
        """EXACT copy from working channel_plotter.py"""
        keep = len(self.MAGIC) - 1
        while True:
            idx = buffer.find(self.MAGIC)
            if idx == -1:
                if keep > 0 and len(buffer) > keep:
                    del buffer[:-keep]
                return False
            if idx:
                del buffer[:idx]
            if len(buffer) < self.HEADER_SIZE:
                return False
            try:
                (
                    magic,
                    version,
                    flags,
                    count,
                    _failures,
                    _total_time_us,
                    _packet_time_us,
                ) = self.HEADER_STRUCT.unpack_from(buffer, 0)
            except struct.error:
                return False
            if (
                magic != self.MAGIC
                or version != self.PACKET_VERSION
                or not (flags & self.FLAG_TIMING)
            ):
                del buffer[0]
                continue
            count = int(count)
            if count > self.PACKET_RECORDS:
                del buffer[0]
                continue
            payload_len = self.HEADER_SIZE + count * self.RECORD_SIZE
            if payload_len <= self.HEADER_SIZE or payload_len > self.MAX_PACKET_BYTES:
                del buffer[0]
                continue
            if len(buffer) < payload_len:
                return False
            if payload_len < len(buffer) < payload_len + self.CRC_SIZE_OPTIONAL:
                return False
            crc_present = False
            if len(buffer) >= payload_len + self.CRC_SIZE_OPTIONAL:
                next_bytes = buffer[payload_len : payload_len + len(self.MAGIC)]
                if next_bytes != self.MAGIC:
                    crc_present = True
            packet_len = payload_len + (self.CRC_SIZE_OPTIONAL if crc_present else 0)
            if len(buffer) < packet_len:
                return False
            return True

    def _drain_synced(self, buffer):
        """EXACT copy from working channel_plotter.py"""
        measurements = []
        while True:
            if len(buffer) < self.HEADER_SIZE:
                break
            if buffer[: len(self.MAGIC)] != self.MAGIC:
                self.synced = False
                del buffer[0]
                break
            try:
                (
                    magic,
                    version,
                    flags,
                    count,
                    failures,
                    total_time_us,
                    packet_time_us,
                ) = self.HEADER_STRUCT.unpack_from(buffer, 0)
            except struct.error:
                self.synced = False
                del buffer[0]
                break
            count = int(count)
            payload_len = self.HEADER_SIZE + count * self.RECORD_SIZE
            if payload_len > self.MAX_PACKET_BYTES:
                self.synced = False
                del buffer[0]
                break
            if len(buffer) < payload_len:
                break
            if payload_len < len(buffer) < payload_len + self.CRC_SIZE_OPTIONAL:
                break
            crc_present = False
            if len(buffer) >= payload_len + self.CRC_SIZE_OPTIONAL:
                next_bytes = buffer[payload_len : payload_len + len(self.MAGIC)]
                if next_bytes != self.MAGIC:
                    crc_present = True
            packet_len = payload_len + (self.CRC_SIZE_OPTIONAL if crc_present else 0)
            if len(buffer) < packet_len:
                break
            if (
                magic != self.MAGIC
                or version != self.PACKET_VERSION
                or not (flags & self.FLAG_TIMING)
            ):
                self.synced = False
                del buffer[0]
                break

            total_time_us = int(total_time_us)
            failures = int(failures)
            packet_time_us = int(packet_time_us) & self.UINT32_MAX
            count_success = max(1, count - min(count, failures))
            per_sample_default = (
                max(1, total_time_us // count_success) if total_time_us > 0 else 1
            )

            for i in range(count):
                base = self.HEADER_SIZE + i * self.RECORD_SIZE
                ch, ok, raw, sample_time, read_dur, conv_dur = (
                    self.RECORD_STRUCT.unpack_from(buffer, base)
                )
                ch = int(ch)
                ok = int(ok)
                raw = int(raw)
                sample_time = int(sample_time)

                # Skip padding records (ch=0xFF) and invalid records
                if ch == 0xFF:
                    continue
                if (
                    not ok
                    or raw == self.INT32_MIN
                    or sample_time in (-1, self.INT32_MIN)
                ):
                    continue
                sample_us = sample_time & self.UINT32_MAX
                read_us = 0 if read_dur == self.UINT32_MAX else int(read_dur)
                conv_us = 0 if conv_dur == self.UINT32_MAX else int(conv_dur)
                per_sample = read_us + conv_us
                if per_sample <= 0:
                    per_sample = per_sample_default
                per_sample = max(1, int(per_sample))
                volts = raw * self.V_REF / self.ADC_SCALE

                # Create measurement
                measurement = {
                    "sensor_id": ch,
                    "voltage": volts,
                    "raw_adc": raw,
                    "sample_time": sample_time,
                    "read_time_dur": read_us,
                    "conv_time_dur": conv_us,
                    "timestamp": time.time(),
                    "filtered_voltage": self.apply_kalman_filter(volts, ch),
                    "predicted_pressure": 0.0,
                    "confidence_level": "LOW",
                    "needs_human_input": True,
                }

                # Check if sensor has calibration data OR if we can use covariance mapping from other PTs
                framework = self.calibration_frameworks[ch]

                if len(framework.calibration_points) > 2:
                    # Use robust calibration framework for prediction
                    env_state = EnvironmentalState()  # Default environmental state
                    predicted_pressure, uncertainty = (
                        framework.predict_pressure_with_uncertainty(
                            measurement["filtered_voltage"], env_state
                        )
                    )
                    measurement["predicted_pressure"] = predicted_pressure
                    measurement["uncertainty"] = uncertainty
                    measurement["needs_human_input"] = (
                        self.should_request_human_input_robust(ch, measurement)
                    )
                    measurement["confidence_level"] = framework.get_confidence_level()
                elif self.can_use_covariance_mapping(ch):
                    # Use covariance mapping from other calibrated PTs
                    measurement["predicted_pressure"] = (
                        self.predict_pressure_covariance(
                            ch, measurement["filtered_voltage"]
                        )
                    )
                    measurement["needs_human_input"] = False  # Autonomous prediction
                    measurement["confidence_level"] = (
                        "MEDIUM"  # Medium confidence from covariance
                    )
                else:
                    measurement["needs_human_input"] = True
                    measurement["confidence_level"] = "LOW"

                measurements.append(measurement)

            del buffer[:packet_len]
        return measurements

    def data_processor(self):
        """High-performance data processing thread with robust error handling"""
        buffer = bytearray()
        synced = False

        while not self.stop_serial.is_set():
            if self.serial_connection and self.serial_connection.is_open:
                try:
                    # Read available data
                    data = self.serial_connection.read(
                        self.serial_connection.in_waiting or 1
                    )
                    if data:
                        buffer.extend(data)

                        if not synced:
                            synced = self._resync(buffer)

                        if synced:
                            measurements = self._drain_synced(buffer)
                            for measurement in measurements:
                                # Update latest measurements
                                self.latest_measurements[measurement["sensor_id"]] = (
                                    measurement
                                )

                                # Add to data queue for GUI updates
                                if not self.data_queue.full():
                                    self.data_queue.put(measurement)

                                # Update performance stats
                                self.update_performance_stats()

                except serial.SerialException as e:
                    logger.error(f"Serial error in data processor: {e}")
                    self.status_var.set("Serial Error - Reconnecting...")
                    time.sleep(1.0)  # Wait before retrying
                except Exception as e:
                    logger.error(f"Unexpected error in data processor: {e}")
                    time.sleep(0.1)  # Wait before retrying
            else:
                time.sleep(0.1)

    def apply_kalman_filter(self, voltage: float, sensor_id: int) -> float:
        """Apply Kalman filter for high-performance voltage filtering"""
        if not hasattr(self, "kalman_states"):
            self.kalman_states = {}

        if sensor_id not in self.kalman_states:
            self.kalman_states[sensor_id] = {
                "x": voltage,
                "P": 1.0,
                "Q": 0.01,
                "R": 0.1,
            }

        state = self.kalman_states[sensor_id]

        # Predict step
        state["P"] += state["Q"]

        # Update step
        K = state["P"] / (state["P"] + state["R"])
        state["x"] += K * (voltage - state["x"])
        state["P"] *= 1 - K

        return state["x"]

    def predict_pressure(self, sensor_id: int, voltage: float) -> float:
        """Predict pressure from voltage using calibration data"""
        if (
            sensor_id not in self.calibration_data
            or len(self.calibration_data[sensor_id]) < 3
        ):
            return 0.0

        # Simple polynomial fit (degree 2)
        data_points = self.calibration_data[sensor_id]
        voltages = [point["voltage"] for point in data_points]
        pressures = [point["pressure"] for point in data_points]

        try:
            poly_coeffs = np.polyfit(voltages, pressures, min(2, len(voltages) - 1))
            return np.polyval(poly_coeffs, voltage)
        except:
            return 0.0

    def can_use_covariance_mapping(self, sensor_id: int) -> bool:
        """Check if we can use covariance mapping from other calibrated PTs"""
        # Need at least one other PT with good calibration
        calibrated_pts = []
        for pt_id, framework in self.calibration_frameworks.items():
            if pt_id != sensor_id and len(framework.calibration_points) >= 3:
                calibrated_pts.append(pt_id)

        return len(calibrated_pts) >= 1

    def predict_pressure_covariance(self, sensor_id: int, voltage: float) -> float:
        """Predict pressure using covariance mapping from other calibrated PTs"""
        # Find the best reference PT (most calibrated)
        best_ref_pt = None
        max_cal_points = 0

        for pt_id, framework in self.calibration_frameworks.items():
            if (
                pt_id != sensor_id
                and len(framework.calibration_points) > max_cal_points
            ):
                best_ref_pt = pt_id
                max_cal_points = len(framework.calibration_points)

        if best_ref_pt is None:
            return 0.0

        # Use robust framework for prediction
        framework = self.calibration_frameworks[best_ref_pt]
        env_state = EnvironmentalState()  # Default environmental state
        predicted_pressure, uncertainty = framework.predict_pressure_with_uncertainty(
            voltage, env_state
        )

        # Apply covariance scaling based on PT relationships
        covariance_factor = self.get_pt_covariance_factor(sensor_id, best_ref_pt)

        return predicted_pressure * covariance_factor

    def get_pt_covariance_factor(self, target_pt: int, reference_pt: int) -> float:
        """Get covariance scaling factor between PTs"""
        # Simplified covariance model based on PT locations
        # In practice, this would be learned from historical data

        pt_relationships = {
            # Pressurant Tank relationships
            0: {1: 0.95, 2: 0.90, 3: 0.85, 4: 0.80, 5: 0.75, 6: 0.70, 7: 0.65, 8: 0.60},
            # Kero Inlet relationships
            1: {0: 0.95, 2: 0.98, 3: 0.85, 4: 0.80, 5: 0.75, 6: 0.70, 7: 0.65, 8: 0.60},
            # Kero Outlet relationships
            2: {0: 0.90, 1: 0.98, 3: 0.85, 4: 0.80, 5: 0.75, 6: 0.70, 7: 0.65, 8: 0.60},
            # Lox Inlet relationships
            3: {0: 0.85, 1: 0.85, 2: 0.85, 4: 0.95, 5: 0.80, 6: 0.75, 7: 0.70, 8: 0.65},
            # Lox Outlet relationships
            4: {0: 0.80, 1: 0.80, 2: 0.80, 3: 0.95, 5: 0.85, 6: 0.80, 7: 0.75, 8: 0.70},
            # Injector relationships
            5: {0: 0.75, 1: 0.75, 2: 0.75, 3: 0.80, 4: 0.85, 6: 0.90, 7: 0.85, 8: 0.80},
            # Chamber Wall #1 relationships
            6: {0: 0.70, 1: 0.70, 2: 0.70, 3: 0.75, 4: 0.80, 5: 0.90, 7: 0.95, 8: 0.85},
            # Chamber Wall #2 relationships
            7: {0: 0.65, 1: 0.65, 2: 0.65, 3: 0.70, 4: 0.75, 5: 0.85, 6: 0.95, 8: 0.90},
            # Nozzle Exit relationships
            8: {0: 0.60, 1: 0.60, 2: 0.60, 3: 0.65, 4: 0.70, 5: 0.80, 6: 0.85, 7: 0.90},
        }

        if (
            target_pt in pt_relationships
            and reference_pt in pt_relationships[target_pt]
        ):
            return pt_relationships[target_pt][reference_pt]

        # Default covariance factor
        return 0.8

    def should_request_human_input_robust(
        self, sensor_id: int, measurement: Dict
    ) -> bool:
        """
        Robust human input decision using uncertainty quantification
        """
        framework = self.calibration_frameworks[sensor_id]

        if len(framework.calibration_points) < 3:
            return True  # Need more calibration data

        # Get uncertainty from robust framework
        uncertainty = measurement.get("uncertainty", 0.1)
        predicted_pressure = measurement.get("predicted_pressure", 0.0)

        # Request human input if uncertainty is too high
        uncertainty_threshold = 0.05  # 5% uncertainty threshold

        if uncertainty > uncertainty_threshold:
            return True

        # Request human input if prediction is outside reasonable range
        if (
            predicted_pressure < 0 or predicted_pressure > 1000
        ):  # Reasonable pressure range
            return True

        # Request human input based on confidence level
        confidence_level = framework.get_confidence_level()
        if confidence_level == "LOW":
            return True
        elif confidence_level == "MEDIUM" and uncertainty > 0.02:
            return True

        return False

    def should_request_human_input(self, sensor_id: int, measurement: Dict) -> bool:
        """Determine if human input is needed"""
        if sensor_id not in self.sensor_states:
            return True

        state = self.sensor_states[sensor_id]

        # Always request human input if confidence is low
        if state.confidence_level == ConfidenceLevel.LOW:
            return True

        # Check if we haven't had human input recently
        if state.confidence_level == ConfidenceLevel.MEDIUM:
            time_since_input = time.time() - state.last_human_input
            if time_since_input > 1800:  # 30 minutes
                return True

        # Check for extrapolation
        if self.is_extrapolation(sensor_id, measurement["voltage"]):
            return True

        return False

    def is_extrapolation(self, sensor_id: int, voltage: float) -> bool:
        """Check if voltage is outside calibration range"""
        if (
            sensor_id not in self.calibration_data
            or len(self.calibration_data[sensor_id]) < 2
        ):
            return True

        voltages = [point["voltage"] for point in self.calibration_data[sensor_id]]
        min_voltage = min(voltages)
        max_voltage = max(voltages)

        voltage_range = max_voltage - min_voltage
        margin = 0.1 * voltage_range  # 10% margin

        return voltage < (min_voltage - margin) or voltage > (max_voltage + margin)

    def get_confidence_level(self, sensor_id: int) -> str:
        """Get confidence level string"""
        if sensor_id not in self.sensor_states:
            return "LOW"

        state = self.sensor_states[sensor_id]
        return state.confidence_level.name

    def update_performance_stats(self):
        """Update performance statistics"""
        current_time = time.time()
        time_diff = current_time - self.performance_stats["last_update"]

        if time_diff > 0.1:  # Update every 100ms
            self.performance_stats["data_rate_hz"] = (
                1.0 / time_diff if time_diff > 0 else 0
            )
            self.performance_stats["latency_ms"] = time_diff * 1000
            self.performance_stats["last_update"] = current_time

    def update_gui(self):
        """Update GUI elements"""
        # Process data queue
        while not self.data_queue.empty():
            try:
                measurement = self.data_queue.get_nowait()
                self.process_measurement(measurement)
            except queue.Empty:
                break

        # Update data tree
        self.update_data_tree()

        # Update plots
        self.update_plots()

        # Update statistics
        self.update_statistics()

        # Update performance indicators
        self.update_performance_indicators()

        # Schedule next update
        self.root.after(50, self.update_gui)  # 20 FPS

    def process_measurement(self, measurement: Dict):
        """Process a new measurement"""
        sensor_id = measurement["sensor_id"]

        # Initialize sensor state if needed
        if sensor_id not in self.sensor_states:
            self.sensor_states[sensor_id] = SensorLearningState(
                confidence_level=ConfidenceLevel.LOW,
                human_input_count=0,
                autonomous_success_count=0,
                autonomous_failure_count=0,
                reliability_score=0.0,
                last_human_input=0.0,
                calibration_data_points=0,
            )

        # Check if human input is needed
        if measurement["needs_human_input"] and not self.autonomous_mode:
            self.create_human_input_request(sensor_id, measurement)

    def create_human_input_request(self, sensor_id: int, measurement: Dict):
        """Create human input request"""
        request = HumanInputRequest(
            sensor_id=sensor_id,
            current_voltage=measurement["voltage"],
            predicted_pressure=measurement["predicted_pressure"],
            confidence_interval_lower=measurement["predicted_pressure"] - 50.0,
            confidence_interval_upper=measurement["predicted_pressure"] + 50.0,
            reason=(
                "Calibration data insufficient"
                if len(self.calibration_data.get(sensor_id, [])) < 3
                else "High uncertainty"
            ),
            timestamp=time.time(),
            request_id=len(self.pending_requests) + 1,
        )

        self.pending_requests.append(request)
        self.update_requests_listbox()

        # Enable input buttons when there are pending requests
        self.confirm_btn.config(state="normal")
        self.skip_btn.config(state="normal")

    def update_data_tree(self):
        """Update data display tree"""
        for item in self.data_tree.get_children():
            values = list(self.data_tree.item(item)["values"])
            sensor_id = int(values[0].split()[1])

            if sensor_id in self.latest_measurements:
                measurement = self.latest_measurements[sensor_id]
                values[2] = f"{measurement['voltage']:.3f}"
                values[3] = f"{measurement['predicted_pressure']:.1f}"
                values[4] = measurement["confidence_level"]
                values[5] = (
                    "Needs Input" if measurement["needs_human_input"] else "Autonomous"
                )
            else:
                values[2] = "0.000"
                values[3] = "0.000"
                values[4] = "LOW"
                values[5] = "Offline"

            self.data_tree.item(item, values=values)

    def update_requests_listbox(self):
        """Update pending requests listbox"""
        self.requests_listbox.delete(0, tk.END)
        for request in self.pending_requests[-5:]:  # Show last 5 requests
            self.requests_listbox.insert(
                tk.END,
                f"PT {request.sensor_id}: {request.current_voltage:.3f}V -> {request.predicted_pressure:.1f}kPa ({request.reason})",
            )

    def update_plots(self):
        """Update real-time plots"""
        current_time = time.time()

        # Clear and redraw voltage plot
        self.ax_voltage.clear()
        self.ax_voltage.set_title("Real-Time Voltage Readings", color="white")
        self.ax_voltage.set_ylabel("Voltage (V)", color="white")
        self.ax_voltage.tick_params(colors="white")
        self.ax_voltage.set_facecolor("#3b3b3b")

        # Plot voltage data for active sensors
        for sensor_id, measurement in self.latest_measurements.items():
            if len(self.plot_data["voltages"][sensor_id]) > 1:
                times = list(self.plot_data["time"])
                voltages = list(self.plot_data["voltages"][sensor_id])
                self.ax_voltage.plot(
                    times[-len(voltages) :],
                    voltages,
                    label=f"PT {sensor_id}",
                    linewidth=1,
                )

        self.ax_voltage.legend()

        # Clear and redraw pressure plot
        self.ax_pressure.clear()
        self.ax_pressure.set_title("Real-Time Pressure Readings", color="white")
        self.ax_pressure.set_ylabel("Pressure (kPa)", color="white")
        self.ax_pressure.tick_params(colors="white")
        self.ax_pressure.set_facecolor("#3b3b3b")

        # Plot pressure data for calibrated sensors
        for sensor_id, measurement in self.latest_measurements.items():
            if len(self.plot_data["pressures"][sensor_id]) > 1:
                times = list(self.plot_data["time"])
                pressures = list(self.plot_data["pressures"][sensor_id])
                self.ax_pressure.plot(
                    times[-len(pressures) :],
                    pressures,
                    label=f"PT {sensor_id}",
                    linewidth=1,
                )

        self.ax_pressure.legend()

        # Clear and redraw confidence plot
        self.ax_confidence.clear()
        self.ax_confidence.set_title("Confidence Levels", color="white")
        self.ax_confidence.set_xlabel("Time (s)", color="white")
        self.ax_confidence.set_ylabel("Confidence", color="white")
        self.ax_confidence.tick_params(colors="white")
        self.ax_confidence.set_facecolor("#3b3b3b")

        # Plot confidence data
        for sensor_id in range(9):
            if len(self.plot_data["confidence"][sensor_id]) > 1:
                times = list(self.plot_data["time"])
                confidence = list(self.plot_data["confidence"][sensor_id])
                self.ax_confidence.plot(
                    times[-len(confidence) :],
                    confidence,
                    label=f"PT {sensor_id}",
                    linewidth=1,
                )

        self.ax_confidence.legend()

        self.canvas.draw_idle()

    def update_statistics(self):
        """Update statistics display"""
        for item in self.stats_tree.get_children():
            values = list(self.stats_tree.item(item)["values"])
            sensor_id = int(values[0].split()[1])

            if sensor_id in self.sensor_states:
                state = self.sensor_states[sensor_id]
                success_rate = 0.0
                if state.autonomous_success_count + state.autonomous_failure_count > 0:
                    success_rate = state.autonomous_success_count / (
                        state.autonomous_success_count + state.autonomous_failure_count
                    )

                values[1] = state.confidence_level.name
                values[2] = str(state.human_input_count)
                values[3] = f"{success_rate*100:.1f}%"
                values[4] = f"{state.reliability_score*100:.1f}%"
            else:
                values[1] = "LOW"
                values[2] = "0"
                values[3] = "0%"
                values[4] = "0%"

            self.stats_tree.item(item, values=values)

    def update_performance_indicators(self):
        """Update performance indicators"""
        self.data_rate_var.set(
            f"Data Rate: {self.performance_stats['data_rate_hz']:.1f} Hz"
        )
        self.latency_var.set(f"Latency: {self.performance_stats['latency_ms']:.1f} ms")

        # Calculate overall accuracy
        total_success = sum(
            state.autonomous_success_count for state in self.sensor_states.values()
        )
        total_attempts = sum(
            state.autonomous_success_count + state.autonomous_failure_count
            for state in self.sensor_states.values()
        )
        accuracy = (total_success / total_attempts * 100) if total_attempts > 0 else 0.0
        self.accuracy_var.set(f"Accuracy: {accuracy:.1f}%")

        # Calculate autonomy percentage
        total_requests = len(self.pending_requests)
        autonomy = max(0, (100 - total_requests * 10)) if total_requests > 0 else 100.0
        self.autonomy_var.set(f"Autonomy: {autonomy:.1f}%")

    def toggle_connection(self):
        """Toggle serial connection"""
        if self.serial_connection and self.serial_connection.is_open:
            self.disconnect()
        else:
            self.connect()

    def connect(self):
        """Connect to serial port with retry mechanism"""
        max_retries = 3
        for attempt in range(max_retries):
            if self.setup_serial():
                self.connect_btn.config(text="Disconnect")
                self.learn_btn.config(state="normal")
                self.status_var.set("Connected")
                logger.info("Connected to serial port")

                # Start data processing
                self.stop_serial.clear()
                self.start_data_processing()
                return
            else:
                if attempt < max_retries - 1:
                    logger.warning(
                        f"Connection attempt {attempt + 1} failed, retrying..."
                    )
                    time.sleep(0.5)

        self.status_var.set("Connection Failed - Check Port")
        logger.error("Failed to connect after all retries")

    def disconnect(self):
        """Disconnect from serial port with proper cleanup"""
        # Signal data thread to stop
        self.stop_serial.set()

        # Wait for data thread to finish
        if hasattr(self, "data_thread") and self.data_thread.is_alive():
            self.data_thread.join(timeout=1.0)

        # Close serial connection
        if self.serial_connection and self.serial_connection.is_open:
            try:
                self.serial_connection.close()
                time.sleep(0.1)  # Give it time to close
            except Exception as e:
                logger.warning(f"Error closing serial connection: {e}")

        # Reset UI state
        self.connect_btn.config(text="Connect")
        self.learn_btn.config(state="disabled")
        self.autonomous_btn.config(state="disabled")
        self.validate_btn.config(state="disabled")
        self.status_var.set("Disconnected")

        # Clear data
        self.latest_measurements.clear()
        self.recent_data.clear()
        self.last_update_time.clear()

        logger.info("Disconnected from serial port")

    def start_learning(self):
        """Start learning mode"""
        self.recording_data = True
        self.learn_btn.config(text="Stop Learning", command=self.stop_learning)
        self.autonomous_btn.config(state="normal")
        self.validate_btn.config(state="normal")
        self.status_var.set("Learning Mode Active")

    def stop_learning(self):
        """Stop learning mode"""
        self.recording_data = False
        self.learn_btn.config(text="Start Learning", command=self.start_learning)
        self.status_var.set("Learning Stopped")

    def toggle_autonomous_mode(self):
        """Toggle autonomous mode"""
        self.autonomous_mode = not self.autonomous_mode
        if self.autonomous_mode:
            self.autonomous_btn.config(text="Disable Autonomous Mode")
            self.status_var.set("Autonomous Mode Active")
        else:
            self.autonomous_btn.config(text="Enable Autonomous Mode")
            self.status_var.set("Learning Mode Active")

    def confirm_human_input(self):
        """Confirm human input"""
        try:
            sensor_id = int(self.selected_sensor_var.get().split()[1])
            reference_pressure = float(self.ref_pressure_var.get())

            # Add calibration data point
            if sensor_id in self.latest_measurements:
                measurement = self.latest_measurements[sensor_id]

                # Add to robust calibration framework
                framework = self.calibration_frameworks[sensor_id]
                env_state = EnvironmentalState()  # Default environmental state
                robust_calibration_point = CalibrationPoint(
                    voltage=measurement["filtered_voltage"],
                    pressure=reference_pressure,
                    timestamp=time.time(),
                    environmental_state=env_state,
                    uncertainty=0.01,  # 1% uncertainty
                )

                # Add to framework and get results
                result = framework.add_calibration_point(robust_calibration_point)

                # Also add to legacy system for backward compatibility
                calibration_point = {
                    "voltage": measurement["filtered_voltage"],
                    "pressure": reference_pressure,
                    "timestamp": time.time(),
                }
                self.calibration_data[sensor_id].append(calibration_point)

                # Update sensor state
                if sensor_id in self.sensor_states:
                    state = self.sensor_states[sensor_id]
                    state.human_input_count += 1
                    state.last_human_input = time.time()
                    state.calibration_data_points = len(
                        self.calibration_data[sensor_id]
                    )

                    # Update confidence level
                    if state.human_input_count >= 20:
                        state.confidence_level = ConfidenceLevel.MAXIMUM
                    elif state.human_input_count >= 10:
                        state.confidence_level = ConfidenceLevel.HIGH
                    elif state.human_input_count >= 5:
                        state.confidence_level = ConfidenceLevel.MEDIUM

                # Remove pending requests for this sensor
                self.pending_requests = [
                    req for req in self.pending_requests if req.sensor_id != sensor_id
                ]
                self.update_requests_listbox()

                # Disable buttons if no more pending requests
                if not self.pending_requests:
                    self.confirm_btn.config(state="disabled")
                    self.skip_btn.config(state="disabled")

                # Clear input fields
                self.ref_pressure_var.set("")

                messagebox.showinfo(
                    "Input Confirmed", f"Calibration data added for PT {sensor_id}"
                )

        except ValueError:
            messagebox.showerror(
                "Invalid Input", "Please enter valid sensor and pressure values"
            )

    def skip_human_input(self):
        """Skip human input request"""
        if self.pending_requests:
            self.pending_requests.pop(0)
            self.update_requests_listbox()

            # Disable buttons if no more pending requests
            if not self.pending_requests:
                self.confirm_btn.config(state="disabled")
                self.skip_btn.config(state="disabled")

    def validate_prediction(self):
        """Validate system prediction"""
        # This would typically involve comparing with a reference measurement
        messagebox.showinfo(
            "Validation", "Validation feature - compare with reference measurement"
        )

    def save_learning_state(self):
        """Save learning state to file"""
        filename = filedialog.asksaveasfilename(
            defaultextension=".json",
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")],
            title="Save Learning State",
        )

        if filename:
            learning_data = {
                "timestamp": datetime.now().isoformat(),
                "sensor_states": {
                    str(sensor_id): {
                        "confidence_level": state.confidence_level.name,
                        "human_input_count": state.human_input_count,
                        "autonomous_success_count": state.autonomous_success_count,
                        "autonomous_failure_count": state.autonomous_failure_count,
                        "reliability_score": state.reliability_score,
                        "calibration_data_points": state.calibration_data_points,
                    }
                    for sensor_id, state in self.sensor_states.items()
                },
                "calibration_data": {
                    str(sensor_id): data_points
                    for sensor_id, data_points in self.calibration_data.items()
                },
            }

            with open(filename, "w") as f:
                json.dump(learning_data, f, indent=2)

            messagebox.showinfo("Saved", f"Learning state saved to {filename}")

    def run(self):
        """Run the GUI"""
        try:
            self.root.mainloop()
        except KeyboardInterrupt:
            logger.info("GUI interrupted by user")
        finally:
            self.cleanup()

    def cleanup(self):
        """Cleanup resources"""
        self.stop_serial.set()
        if self.serial_connection and self.serial_connection.is_open:
            self.serial_connection.close()
        logger.info("GUI cleanup complete")


def main():
    """Main entry point"""
    try:
        app = SmartCalibrationGUI()
        app.run()
    except Exception as e:
        logger.error(f"GUI failed to start: {e}")
        messagebox.showerror(
            "Startup Error", f"Failed to start smart calibration GUI: {e}"
        )


if __name__ == "__main__":
    main()
