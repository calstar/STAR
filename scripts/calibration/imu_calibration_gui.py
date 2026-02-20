#!/usr/bin/env python3
"""
IMU Calibration GUI

Interactive GUI for calibrating IMU sensors (accelerometer, gyroscope, magnetometer).
Similar to PT calibration GUI from external FSW.

Usage:
    python imu_calibration_gui.py [--port PORT] [--sensor-type TYPE]
"""

import sys
import socket
import struct
import threading
import time
import json
from typing import Optional, Dict, List
from collections import deque
from dataclasses import dataclass

try:
    from PyQt6 import QtCore, QtGui, QtWidgets
    from PyQt6.QtCore import Qt
except ImportError:
    from PyQt5 import QtCore, QtGui, QtWidgets
    from PyQt5.QtCore import Qt

import pyqtgraph as pg
import numpy as np

from imu_calibration import (
    IMUCalibrationSystem,
    SensorType,
    CalibrationPoint,
    AccelerometerCalibrator,
    GyroscopeCalibrator,
    MagnetometerCalibrator,
)

# DAQv2-Comms protocol constants
MAX_PACKET_SIZE = 512
PACKET_TYPE_SENSOR_DATA = 3
PACKET_HEADER_FORMAT = "<BBI"
PACKET_HEADER_SIZE = 6
SENSOR_DATA_PACKET_FORMAT = "<BB"
SENSOR_DATA_PACKET_SIZE = 2
SENSOR_DATA_CHUNK_FORMAT = "<I"
SENSOR_DATA_CHUNK_SIZE = 4
SENSOR_DATAPOINT_FORMAT = "<BI"  # sensor_id uint8, data uint32
SENSOR_DATAPOINT_SIZE = 5

DEFAULT_PORT = 5008
UPDATE_INTERVAL_MS = 50
MAX_POINTS = 1000


@dataclass
class IMUReading:
    """IMU sensor reading"""

    accel: np.ndarray
    gyro: np.ndarray
    mag: np.ndarray
    temperature: float
    timestamp: float


class UDPReceiver(QtCore.QThread):
    """UDP receiver thread for sensor data"""

    data_received = QtCore.pyqtSignal(object)

    def __init__(self, port: int):
        super().__init__()
        self.port = port
        self.running = False
        self.sock: Optional[socket.socket] = None

    def run(self):
        """Receive UDP packets"""
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("0.0.0.0", self.port))
        self.sock.settimeout(1.0)
        self.running = True

        while self.running:
            try:
                data, addr = self.sock.recvfrom(MAX_PACKET_SIZE)
                # Parse packet and emit signal
                # This is simplified - would need full packet parsing
                reading = self.parse_packet(data)
                if reading:
                    self.data_received.emit(reading)
            except socket.timeout:
                continue
            except Exception as e:
                print(f"Error receiving data: {e}")

    def parse_packet(self, data: bytes) -> Optional[IMUReading]:
        """Parse sensor data packet"""
        # Simplified parsing - would need full DAQv2-Comms protocol
        # For now, return None
        return None

    def stop(self):
        """Stop receiver"""
        self.running = False
        if self.sock:
            self.sock.close()


class IMUCalibrationGUI(QtWidgets.QMainWindow):
    """Main calibration GUI window"""

    def __init__(self, sensor_type: str = "accel", port: int = DEFAULT_PORT):
        super().__init__()
        self.sensor_type = sensor_type
        self.port = port

        # Calibration system
        self.calib_system = IMUCalibrationSystem()
        if sensor_type == "accel":
            self.calibrator = self.calib_system.create_calibrator(
                SensorType.ACCELEROMETER, "imu_0"
            )
        elif sensor_type == "gyro":
            self.calibrator = self.calib_system.create_calibrator(
                SensorType.GYROSCOPE, "imu_0"
            )
        else:
            self.calibrator = self.calib_system.create_calibrator(
                SensorType.MAGNETOMETER, "imu_0"
            )

        # Data storage
        self.raw_readings: Dict[str, deque] = {
            "x": deque(maxlen=MAX_POINTS),
            "y": deque(maxlen=MAX_POINTS),
            "z": deque(maxlen=MAX_POINTS),
        }
        self.timestamps = deque(maxlen=MAX_POINTS)
        self.calibration_points: List[CalibrationPoint] = []

        # Setup UI
        self.setup_ui()

        # UDP receiver
        self.receiver = UDPReceiver(port)
        self.receiver.data_received.connect(self.on_data_received)
        self.receiver.start()

        # Update timer
        self.update_timer = QtCore.QTimer()
        self.update_timer.timeout.connect(self.update_plots)
        self.update_timer.start(UPDATE_INTERVAL_MS)

    def setup_ui(self):
        """Setup user interface"""
        self.setWindowTitle(f"IMU Calibration - {self.sensor_type.upper()}")
        self.setGeometry(100, 100, 1200, 800)

        # Central widget
        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        layout = QtWidgets.QVBoxLayout(central)

        # Plot widget
        self.plot_widget = pg.GraphicsLayoutWidget()
        layout.addWidget(self.plot_widget)

        # Create plots for X, Y, Z
        self.plots = {}
        for axis in ["x", "y", "z"]:
            plot = self.plot_widget.addPlot(title=f"{axis.upper()} Axis")
            plot.setLabel("left", "Value")
            plot.setLabel("bottom", "Time (s)")
            curve = plot.plot(pen=pg.mkPen(color=axis, width=2))
            self.plots[axis] = {"plot": plot, "curve": curve}

        # Control panel
        control_panel = QtWidgets.QHBoxLayout()

        # Add calibration point button
        self.add_point_btn = QtWidgets.QPushButton("Add Calibration Point")
        self.add_point_btn.clicked.connect(self.add_calibration_point)
        control_panel.addWidget(self.add_point_btn)

        # Calibrate button
        self.calibrate_btn = QtWidgets.QPushButton("Calibrate")
        self.calibrate_btn.clicked.connect(self.perform_calibration)
        control_panel.addWidget(self.calibrate_btn)

        # Save button
        self.save_btn = QtWidgets.QPushButton("Save Calibration")
        self.save_btn.clicked.connect(self.save_calibration)
        control_panel.addWidget(self.save_btn)

        # Status label
        self.status_label = QtWidgets.QLabel("Ready")
        control_panel.addWidget(self.status_label)

        layout.addLayout(control_panel)

    def on_data_received(self, reading: IMUReading):
        """Handle received sensor data"""
        if self.sensor_type == "accel":
            values = reading.accel
        elif self.sensor_type == "gyro":
            values = reading.gyro
        else:
            values = reading.mag

        self.raw_readings["x"].append(values[0])
        self.raw_readings["y"].append(values[1])
        self.raw_readings["z"].append(values[2])
        self.timestamps.append(reading.timestamp)

    def update_plots(self):
        """Update plots with latest data"""
        if not self.timestamps:
            return

        times = np.array(self.timestamps)
        if len(times) > 1:
            times = times - times[0]  # Normalize to start at 0

        for axis in ["x", "y", "z"]:
            if len(self.raw_readings[axis]) > 0:
                values = np.array(self.raw_readings[axis])
                self.plots[axis]["curve"].setData(times, values)

    def add_calibration_point(self):
        """Add current reading as calibration point"""
        if not self.raw_readings["x"]:
            self.status_label.setText("No data available")
            return

        # Get current reading
        raw = np.array(
            [
                self.raw_readings["x"][-1],
                self.raw_readings["y"][-1],
                self.raw_readings["z"][-1],
            ]
        )

        # Get reference value from user
        ref, ok = self.get_reference_value()
        if not ok:
            return

        # Create calibration point
        point = CalibrationPoint(
            raw_value=raw,
            reference_value=ref,
            temperature=25.0,  # Would get from sensor
            timestamp=time.time(),
        )

        self.calibrator.add_calibration_point(point)
        self.calibration_points.append(point)

        self.status_label.setText(
            f"Added calibration point {len(self.calibration_points)}"
        )

    def get_reference_value(self) -> tuple:
        """Get reference value from user input"""
        dialog = QtWidgets.QDialog(self)
        dialog.setWindowTitle("Enter Reference Value")
        layout = QtWidgets.QVBoxLayout(dialog)

        # Input fields for X, Y, Z
        inputs = {}
        for axis in ["X", "Y", "Z"]:
            label = QtWidgets.QLabel(f"{axis}:")
            input_field = QtWidgets.QLineEdit()
            inputs[axis.lower()] = input_field
            row = QtWidgets.QHBoxLayout()
            row.addWidget(label)
            row.addWidget(input_field)
            layout.addLayout(row)

        # Buttons
        buttons = QtWidgets.QDialogButtonBox(
            QtWidgets.QDialogButtonBox.StandardButton.Ok
            | QtWidgets.QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(dialog.accept)
        buttons.rejected.connect(dialog.reject)
        layout.addWidget(buttons)

        if dialog.exec() == QtWidgets.QDialog.DialogCode.Accepted:
            try:
                ref = np.array(
                    [
                        float(inputs["x"].text()),
                        float(inputs["y"].text()),
                        float(inputs["z"].text()),
                    ]
                )
                return ref, True
            except ValueError:
                return np.zeros(3), False

        return np.zeros(3), False

    def perform_calibration(self):
        """Perform calibration"""
        try:
            params = self.calibrator.calibrate()
            self.status_label.setText(
                f"Calibration complete! Quality: {params.calibration_quality:.3f}"
            )
        except Exception as e:
            self.status_label.setText(f"Calibration failed: {e}")

    def save_calibration(self):
        """Save calibration to file"""
        filename, _ = QtWidgets.QFileDialog.getSaveFileName(
            self, "Save Calibration", "", "JSON Files (*.json)"
        )
        if filename:
            self.calibrator.save_calibration(filename)
            self.status_label.setText(f"Saved to {filename}")

    def closeEvent(self, event):
        """Handle window close"""
        self.receiver.stop()
        self.receiver.wait()
        event.accept()


def main():
    import argparse

    parser = argparse.ArgumentParser(description="IMU Calibration GUI")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="UDP port")
    parser.add_argument(
        "--sensor-type",
        choices=["accel", "gyro", "mag"],
        default="accel",
        help="Sensor type to calibrate",
    )

    args = parser.parse_args()

    app = QtWidgets.QApplication(sys.argv)
    window = IMUCalibrationGUI(sensor_type=args.sensor_type, port=args.port)
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()



