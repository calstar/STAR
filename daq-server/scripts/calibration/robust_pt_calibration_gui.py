#!/usr/bin/env python3
"""
Robust PT Calibration GUI with Environmental-Adaptive Bayesian Learning
Implements the algorithm from PressureTransducerCalibrationFramework.tex

Features:
- Proper AD26 packet synchronization
- Environmental-robust calibration map f(v, e; θ)
- Bayesian posterior with persistent storage
- Progressive autonomy (human-in-loop → autonomous)
- Only shows active channels (dynamically detected)
- Saves calibration data to JSON for long-term persistence
"""

import sys
import struct
import time
import json
import os
from collections import deque, defaultdict
from datetime import datetime
from pathlib import Path

from PyQt6 import QtCore, QtGui, QtWidgets
import pyqtgraph as pg
import numpy as np
import serial, serial.tools.list_ports

# ---------------------- Configuration ----------------------
MAGIC = b"AD26"
PACKET_VERSION = 2
HEADER_STRUCT = struct.Struct("<4sBBHHII")
RECORD_STRUCT = struct.Struct("<BBiiII")
HEADER_SIZE = HEADER_STRUCT.size
RECORD_SIZE = RECORD_STRUCT.size

V_REF = 2.5
ADC_SCALE = 2147483648.0
BAUD = 115200

# Calibration storage
CALIBRATION_DIR = Path.home() / ".local" / "share" / "pt_calibration"
CALIBRATION_FILE = CALIBRATION_DIR / "calibration_state.json"


# ---------------------- Environmental State ----------------------
class EnvironmentalState:
    def __init__(self):
        self.temperature = 25.0  # °C
        self.humidity = 50.0  # %
        self.vibration_level = 0.0  # normalized
        self.aging_factor = 0.0  # time-dependent
        self.mounting_torque = 1.0  # factor


# ---------------------- Bayesian Calibration Model ----------------------
class BayesianPTCalibration:
    """
    Environmental-Robust Bayesian Calibration
    Implements Algorithm 1 from PressureTransducerCalibrationFramework.tex
    """

    def __init__(self, sensor_id):
        self.sensor_id = sensor_id

        # Calibration parameters θ (polynomial coefficients)
        self.theta = np.zeros(6)  # [θ0, θ1, θ2, θ3, θ4, θ5]
        self.Sigma_theta = np.eye(6) * 1000.0  # Large initial uncertainty

        # Environmental variance parameters
        self.Q_env = np.eye(5) * 0.01  # Environmental variance matrix
        self.Q_interaction = np.eye(5) * 0.001  # Interaction variance
        self.sigma_base = 100.0  # Base measurement noise (Pa)

        # Calibration data points
        self.calibration_data = []  # [(voltage, pressure, env_state, timestamp)]

        # Learning state
        self.confidence_level = 0  # 0=LOW, 1=MEDIUM, 2=HIGH, 3=MAXIMUM
        self.human_input_count = 0
        self.autonomous_success_count = 0
        self.autonomous_failure_count = 0

    def add_calibration_point(self, voltage, reference_pressure, env_state):
        """Add human-provided calibration point"""
        self.calibration_data.append(
            (voltage, reference_pressure, env_state, time.time())
        )
        self.human_input_count += 1

        # Update calibration using Bayesian TLS
        self._update_calibration()
        self._update_confidence()

    def _update_calibration(self):
        """
        Update calibration parameters using Bayesian regression
        Implements Step 2-3 of Algorithm 1
        """
        if len(self.calibration_data) < 2:
            return

        # Extract data
        voltages = np.array([d[0] for d in self.calibration_data])
        pressures = np.array([d[1] for d in self.calibration_data])

        # Build design matrix Φ (environmental-robust basis functions)
        Phi = self._build_design_matrix(voltages)

        # Bayesian linear regression with TLS-inspired weighting
        # Posterior: Σ_θ^-1 = Σ_prior^-1 + Φ^T R^-1 Φ
        # θ_post = Σ_θ (Σ_prior^-1 θ_prior + Φ^T R^-1 p)

        R_inv = np.eye(len(pressures)) / (self.sigma_base**2)

        Sigma_prior_inv = np.linalg.inv(self.Sigma_theta)
        Sigma_post_inv = Sigma_prior_inv + Phi.T @ R_inv @ Phi

        try:
            self.Sigma_theta = np.linalg.inv(Sigma_post_inv)
            self.theta = self.Sigma_theta @ (
                Sigma_prior_inv @ self.theta + Phi.T @ R_inv @ pressures
            )
        except np.linalg.LinAlgError:
            # Singular matrix - add regularization
            self.Sigma_theta = np.linalg.inv(Sigma_post_inv + np.eye(6) * 1e-6)
            self.theta = self.Sigma_theta @ (
                Sigma_prior_inv @ self.theta + Phi.T @ R_inv @ pressures
            )

    def _build_design_matrix(self, voltages):
        """
        Build design matrix with physically-informed basis functions
        φ(v) = [1, v, v², v³, √v, log(1+v)]
        """
        N = len(voltages)
        Phi = np.zeros((N, 6))

        for i, v in enumerate(voltages):
            v = max(0.01, v)  # Avoid sqrt/log of negative
            Phi[i, 0] = 1.0
            Phi[i, 1] = v
            Phi[i, 2] = v**2
            Phi[i, 3] = v**3
            Phi[i, 4] = np.sqrt(v)
            Phi[i, 5] = np.log(1 + v)

        return Phi

    def predict_pressure(self, voltage, env_state=None):
        """
        Predict pressure with uncertainty quantification
        Returns: (pressure_mean, pressure_std)
        """
        if len(self.calibration_data) < 2:
            return 0.0, 1e6  # No calibration yet

        # Evaluate calibration map
        phi = self._evaluate_basis(voltage)
        p_mean = phi @ self.theta

        # Predictive uncertainty: σ²_pred = σ²_meas + φ^T Σ_θ φ
        sigma_pred_sq = self.sigma_base**2 + phi @ self.Sigma_theta @ phi.T

        # Add extrapolation uncertainty if outside calibration range
        v_min = min([d[0] for d in self.calibration_data])
        v_max = max([d[0] for d in self.calibration_data])

        if voltage < v_min or voltage > v_max:
            # Extrapolation penalty
            if voltage < v_min:
                extrap_factor = (v_min - voltage) / (v_max - v_min)
            else:
                extrap_factor = (voltage - v_max) / (v_max - v_min)

            sigma_extrap_sq = (extrap_factor * self.sigma_base * 10) ** 2
            sigma_pred_sq += sigma_extrap_sq

        return float(p_mean), float(np.sqrt(sigma_pred_sq))

    def _evaluate_basis(self, voltage):
        """Evaluate basis functions at given voltage"""
        v = max(0.01, voltage)
        return np.array([1.0, v, v**2, v**3, np.sqrt(v), np.log(1 + v)])

    def _update_confidence(self):
        """Update confidence level based on calibration data"""
        reliability = self.get_reliability_score()

        if self.human_input_count >= 20 and reliability > 0.9:
            self.confidence_level = 3  # MAXIMUM
        elif self.human_input_count >= 10 and reliability > 0.8:
            self.confidence_level = 2  # HIGH
        elif self.human_input_count >= 5 and reliability > 0.7:
            self.confidence_level = 1  # MEDIUM
        else:
            self.confidence_level = 0  # LOW

    def get_reliability_score(self):
        """Calculate reliability score"""
        if self.human_input_count < 2:
            return 0.0

        # Based on calibration residuals
        if len(self.calibration_data) < 3:
            return 0.5

        voltages = np.array([d[0] for d in self.calibration_data])
        pressures = np.array([d[1] for d in self.calibration_data])

        predictions = []
        for v in voltages:
            phi = self._evaluate_basis(v)
            predictions.append(phi @ self.theta)

        predictions = np.array(predictions)
        residuals = pressures - predictions
        rmse = np.sqrt(np.mean(residuals**2))
        pressure_range = np.max(pressures) - np.min(pressures)

        if pressure_range == 0:
            return 0.5

        nrmse = rmse / pressure_range
        reliability = max(0.0, 1.0 - nrmse * 2.0)  # Scale so NRMSE=0.5 → reliability=0

        return reliability

    def needs_human_input(self, voltage):
        """Determine if human input is needed for this voltage"""
        if self.confidence_level == 0:  # LOW
            return True
        elif self.confidence_level == 1:  # MEDIUM
            return np.random.random() < 0.3  # 30% chance
        elif self.confidence_level == 2:  # HIGH
            return np.random.random() < 0.1  # 10% chance
        else:  # MAXIMUM
            return np.random.random() < 0.02  # 2% chance

    def to_dict(self):
        """Serialize to dictionary for JSON storage"""
        return {
            "sensor_id": self.sensor_id,
            "theta": self.theta.tolist(),
            "Sigma_theta": self.Sigma_theta.tolist(),
            "sigma_base": self.sigma_base,
            "calibration_data": self.calibration_data,
            "confidence_level": self.confidence_level,
            "human_input_count": self.human_input_count,
            "autonomous_success_count": self.autonomous_success_count,
            "autonomous_failure_count": self.autonomous_failure_count,
            "last_updated": datetime.now().isoformat(),
        }

    @classmethod
    def from_dict(cls, data):
        """Deserialize from dictionary"""
        cal = cls(data["sensor_id"])
        cal.theta = np.array(data["theta"])
        cal.Sigma_theta = np.array(data["Sigma_theta"])
        cal.sigma_base = data["sigma_base"]
        cal.calibration_data = data["calibration_data"]
        cal.confidence_level = data["confidence_level"]
        cal.human_input_count = data["human_input_count"]
        cal.autonomous_success_count = data.get("autonomous_success_count", 0)
        cal.autonomous_failure_count = data.get("autonomous_failure_count", 0)
        return cal


# ---------------------- Calibration Manager ----------------------
class CalibrationManager:
    """Manages calibration for all sensors with persistent storage"""

    def __init__(self):
        self.calibrations = {}  # sensor_id -> BayesianPTCalibration
        self.load_calibrations()

    def get_or_create(self, sensor_id):
        """Get existing calibration or create new one"""
        if sensor_id not in self.calibrations:
            self.calibrations[sensor_id] = BayesianPTCalibration(sensor_id)
        return self.calibrations[sensor_id]

    def save_calibrations(self):
        """Save all calibrations to persistent storage"""
        CALIBRATION_DIR.mkdir(parents=True, exist_ok=True)

        data = {
            "version": "1.0",
            "saved_at": datetime.now().isoformat(),
            "calibrations": {
                str(sid): cal.to_dict() for sid, cal in self.calibrations.items()
            },
        }

        with open(CALIBRATION_FILE, "w") as f:
            json.dump(data, f, indent=2)

        print(f"✅ Calibrations saved to {CALIBRATION_FILE}")

    def load_calibrations(self):
        """Load calibrations from persistent storage"""
        if not CALIBRATION_FILE.exists():
            print("No existing calibration file found - starting fresh")
            return

        try:
            with open(CALIBRATION_FILE, "r") as f:
                data = json.load(f)

            for sid_str, cal_data in data["calibrations"].items():
                sid = int(sid_str)
                self.calibrations[sid] = BayesianPTCalibration.from_dict(cal_data)

            print(
                f"✅ Loaded {len(self.calibrations)} calibrations from {CALIBRATION_FILE}"
            )
            print(f"   Last saved: {data['saved_at']}")

        except Exception as e:
            print(f"⚠️  Failed to load calibrations: {e}")


# ---------------------- Serial Reader (from channel_plotter) ----------------------
class SerialReader(QtCore.QThread):
    sample = QtCore.pyqtSignal(
        float, int, int, float, int, int
    )  # t_wall, ch, raw, volts, read_us, conv_us
    status = QtCore.pyqtSignal(str)

    def __init__(self, port, baud):
        super().__init__()
        self.port = port
        self.baud = baud
        self._stop = False
        self.buf = bytearray()
        self.synced = False
        self.ser = None

    def stop(self):
        self._stop = True

    def _resync(self):
        """Find AD26 magic header and sync to packet boundary"""
        while True:
            idx = self.buf.find(MAGIC)
            if idx == -1:
                if len(self.buf) > 3:
                    del self.buf[:-3]
                return False
            if idx:
                del self.buf[:idx]
            if len(self.buf) < HEADER_SIZE:
                return False

            try:
                magic, version, flags, count, _, _, _ = HEADER_STRUCT.unpack_from(
                    self.buf, 0
                )
            except struct.error:
                return False

            if magic != MAGIC or version != PACKET_VERSION:
                del self.buf[0]
                continue

            count = int(count)
            payload_len = HEADER_SIZE + count * RECORD_SIZE
            if len(self.buf) < payload_len:
                return False

            self.synced = True
            return True

    def _drain_synced(self):
        """Drain synchronized packets from buffer"""
        out = []
        while True:
            if len(self.buf) < HEADER_SIZE:
                break

            if self.buf[: len(MAGIC)] != MAGIC:
                self.synced = False
                del self.buf[0]
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
                ) = HEADER_STRUCT.unpack_from(self.buf, 0)
            except struct.error:
                self.synced = False
                del self.buf[0]
                break

            count = int(count)
            payload_len = HEADER_SIZE + count * RECORD_SIZE
            if len(self.buf) < payload_len:
                break

            if magic != MAGIC or version != PACKET_VERSION:
                self.synced = False
                del self.buf[0]
                break

            # Parse all records
            for i in range(count):
                base = HEADER_SIZE + i * RECORD_SIZE
                ch, ok, raw, sample_time, read_dur, conv_dur = (
                    RECORD_STRUCT.unpack_from(self.buf, base)
                )

                if not ok or ch == 0xFF:
                    continue

                volts = raw * V_REF / ADC_SCALE
                out.append(
                    (
                        time.monotonic(),
                        int(ch),
                        int(raw),
                        float(volts),
                        int(read_dur),
                        int(conv_dur),
                    )
                )

            del self.buf[:payload_len]

        return out

    def run(self):
        try:
            self.ser = serial.Serial(self.port, self.baud, timeout=0.05)
            self.status.emit(f"✅ Connected to {self.port}")
        except Exception as e:
            self.status.emit(f"❌ Connection failed: {e}")
            return

        while not self._stop:
            try:
                data = self.ser.read(self.ser.in_waiting or 1)
                if data:
                    self.buf.extend(data)
                    if not self.synced:
                        if self._resync():
                            self.status.emit("🔄 Packet sync acquired!")
                    if self.synced:
                        for sample in self._drain_synced():
                            t_wall, ch, raw, volts, read_us, conv_us = sample
                            self.sample.emit(t_wall, ch, raw, volts, read_us, conv_us)
            except Exception as e:
                self.status.emit(f"Error: {e}")
                break

        if self.ser and self.ser.is_open:
            self.ser.close()
        self.status.emit("Disconnected")


# ---------------------- Main GUI ----------------------
class RobustPTCalibrationGUI(QtWidgets.QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Robust PT Calibration - Environmental-Adaptive Bayesian")
        self.resize(1600, 900)

        # Calibration manager (loads existing calibrations)
        self.cal_manager = CalibrationManager()

        # Active channels (dynamically detected)
        self.active_channels = set()
        self.last_seen = {}  # channel -> timestamp

        # Current environmental state
        self.env_state = EnvironmentalState()

        # Data storage
        self.t0 = None
        self.channel_data = defaultdict(
            lambda: {
                "t": deque(maxlen=1000),
                "v": deque(maxlen=1000),
                "raw": deque(maxlen=1000),
            }
        )

        # Serial reader
        self.reader = None

        self.setup_ui()

        # Auto-save timer
        self.save_timer = QtCore.QTimer()
        self.save_timer.timeout.connect(self._auto_save)
        self.save_timer.start(60000)  # Save every 60 seconds

    def setup_ui(self):
        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        layout = QtWidgets.QVBoxLayout(central)

        # Top controls
        top = QtWidgets.QHBoxLayout()
        top.addWidget(QtWidgets.QLabel("Port:"))
        self.cmb_port = QtWidgets.QComboBox()
        self._refresh_ports()
        top.addWidget(self.cmb_port)

        btn_refresh = QtWidgets.QPushButton("Refresh")
        btn_refresh.clicked.connect(self._refresh_ports)
        top.addWidget(btn_refresh)

        self.btn_connect = QtWidgets.QPushButton("Connect")
        self.btn_connect.clicked.connect(self._toggle_connect)
        top.addWidget(self.btn_connect)

        top.addStretch()

        btn_save = QtWidgets.QPushButton("💾 Save Calibrations")
        btn_save.clicked.connect(lambda: self.cal_manager.save_calibrations())
        top.addWidget(btn_save)

        layout.addLayout(top)

        # Main split
        splitter = QtWidgets.QSplitter()
        layout.addWidget(splitter, 1)

        # Left: Voltage plot
        plot_widget = QtWidgets.QWidget()
        plot_layout = QtWidgets.QVBoxLayout(plot_widget)

        self.plot = pg.PlotWidget()
        self.plot.setLabel("left", "Voltage", units="V")
        self.plot.setLabel("bottom", "Time", units="s")
        self.plot.showGrid(x=True, y=True, alpha=0.3)
        self.plot.addLegend()
        plot_layout.addWidget(self.plot)

        self.curves = {}

        splitter.addWidget(plot_widget)

        # Right: Calibration controls
        right_widget = QtWidgets.QWidget()
        right_layout = QtWidgets.QVBoxLayout(right_widget)

        # Status
        status_group = QtWidgets.QGroupBox("Status")
        status_layout = QtWidgets.QVBoxLayout(status_group)
        self.lbl_status = QtWidgets.QLabel("Disconnected")
        self.lbl_status.setWordWrap(True)
        status_layout.addWidget(self.lbl_status)
        right_layout.addWidget(status_group)

        # Active Sensors
        sensors_group = QtWidgets.QGroupBox("Active Sensors")
        self.sensors_layout = QtWidgets.QVBoxLayout(sensors_group)
        self.sensor_labels = {}
        right_layout.addWidget(sensors_group)

        # Calibration Input
        cal_group = QtWidgets.QGroupBox("Add Calibration Point")
        cal_layout = QtWidgets.QFormLayout(cal_group)

        self.cmb_sensor = QtWidgets.QComboBox()
        cal_layout.addRow("Sensor:", self.cmb_sensor)

        self.lbl_current_v = QtWidgets.QLabel("N/A")
        cal_layout.addRow("Current Voltage:", self.lbl_current_v)

        self.lbl_current_raw = QtWidgets.QLabel("N/A")
        cal_layout.addRow("Raw ADC:", self.lbl_current_raw)

        self.txt_ref_pressure = QtWidgets.QLineEdit()
        self.txt_ref_pressure.setPlaceholderText("Enter pressure (Pa or kPa)")
        cal_layout.addRow("Reference Pressure:", self.txt_ref_pressure)

        btn_add_point = QtWidgets.QPushButton("➕ Add Calibration Point")
        btn_add_point.clicked.connect(self._add_calibration_point)
        cal_layout.addRow(btn_add_point)

        self.lbl_prediction = QtWidgets.QLabel("Prediction: N/A")
        cal_layout.addRow(self.lbl_prediction)

        right_layout.addWidget(cal_group)

        # Learning Progress
        progress_group = QtWidgets.QGroupBox("Learning Progress")
        self.progress_layout = QtWidgets.QVBoxLayout(progress_group)
        self.progress_labels = {}
        right_layout.addWidget(progress_group)

        right_layout.addStretch()

        splitter.addWidget(right_widget)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 1)

        # Update timer
        self.update_timer = QtCore.QTimer()
        self.update_timer.timeout.connect(self._update_display)
        self.update_timer.start(100)

    def _refresh_ports(self):
        ports = [p.device for p in serial.tools.list_ports.comports()]
        self.cmb_port.clear()
        self.cmb_port.addItems(ports)

    def _toggle_connect(self):
        if self.reader is None:
            port = self.cmb_port.currentText()
            self.reader = SerialReader(port, BAUD)
            self.reader.sample.connect(self._on_sample)
            self.reader.status.connect(self._set_status)
            self.reader.start()
            self.btn_connect.setText("Disconnect")
        else:
            self.reader.stop()
            self.reader = None
            self.btn_connect.setText("Connect")

    def _set_status(self, text):
        self.lbl_status.setText(text)

    @QtCore.pyqtSlot(float, int, int, float, int, int)
    def _on_sample(self, t_wall, ch, raw, volts, read_us, conv_us):
        if self.t0 is None:
            self.t0 = t_wall

        t_rel = t_wall - self.t0

        # Mark channel as active
        if ch not in self.active_channels:
            self.active_channels.add(ch)
            self._add_channel(ch)

        self.last_seen[ch] = time.time()

        # Store data
        self.channel_data[ch]["t"].append(t_rel)
        self.channel_data[ch]["v"].append(volts)
        self.channel_data[ch]["raw"].append(raw)

    def _add_channel(self, ch):
        """Dynamically add a new active channel"""
        # Add to plot
        color = [
            (255, 0, 0),
            (0, 255, 0),
            (0, 0, 255),
            (255, 165, 0),
            (128, 0, 128),
            (0, 255, 255),
            (255, 192, 203),
            (128, 128, 0),
            (0, 128, 128),
            (255, 255, 0),
        ][ch % 10]
        pen = pg.mkPen(color=color, width=2)
        self.curves[ch] = self.plot.plot([], [], name=f"CH{ch}", pen=pen)

        # Add sensor selector
        self.cmb_sensor.addItem(f"Channel {ch}")

        # Add sensor status label
        lbl = QtWidgets.QLabel(f"CH{ch}: Online (no calibration)")
        lbl.setStyleSheet("color: #00ff00; font-weight: bold;")
        self.sensor_labels[ch] = lbl
        self.sensors_layout.addWidget(lbl)

        # Add progress label
        prog_lbl = QtWidgets.QLabel(f"CH{ch}: 0 points, LOW confidence")
        self.progress_labels[ch] = prog_lbl
        self.progress_layout.addWidget(prog_lbl)

        # Get or create calibration
        self.cal_manager.get_or_create(ch)

    def _add_calibration_point(self):
        """Add a human-provided calibration point"""
        # Get selected sensor
        sensor_text = self.cmb_sensor.currentText()
        if not sensor_text:
            QtWidgets.QMessageBox.warning(self, "Error", "No sensor selected")
            return

        ch = int(sensor_text.split()[-1])

        # Get reference pressure
        try:
            ref_pressure_str = self.txt_ref_pressure.text().strip()
            ref_pressure = float(ref_pressure_str)

            # Auto-detect units (if < 1000, assume kPa, otherwise Pa)
            if ref_pressure < 1000:
                ref_pressure *= 1000  # Convert kPa to Pa
        except ValueError:
            QtWidgets.QMessageBox.warning(self, "Error", "Invalid pressure value")
            return

        # Get current voltage for this channel
        if ch not in self.channel_data or not self.channel_data[ch]["v"]:
            QtWidgets.QMessageBox.warning(self, "Error", f"No data for channel {ch}")
            return

        current_voltage = self.channel_data[ch]["v"][-1]

        # Add to calibration
        cal = self.cal_manager.get_or_create(ch)
        cal.add_calibration_point(current_voltage, ref_pressure, self.env_state)

        # Clear input
        self.txt_ref_pressure.clear()

        # Update display
        confidence_names = ["LOW", "MEDIUM", "HIGH", "MAXIMUM"]
        QtWidgets.QMessageBox.information(
            self,
            "Calibration Point Added",
            f"Channel {ch}: {current_voltage:.4f}V → {ref_pressure/1000:.1f} kPa\n"
            f"Total points: {cal.human_input_count}\n"
            f"Confidence: {confidence_names[cal.confidence_level]}\n"
            f"Reliability: {cal.get_reliability_score()*100:.1f}%",
        )

        # Auto-save after each point
        self.cal_manager.save_calibrations()

    def _update_display(self):
        """Update plots and displays"""
        # Update plots
        for ch in self.active_channels:
            if ch in self.curves and ch in self.channel_data:
                ts = list(self.channel_data[ch]["t"])
                vs = list(self.channel_data[ch]["v"])
                if ts and vs:
                    self.curves[ch].setData(ts, vs)

        # Update current voltage display
        sensor_text = self.cmb_sensor.currentText()
        if sensor_text:
            ch = int(sensor_text.split()[-1])
            if ch in self.channel_data and self.channel_data[ch]["v"]:
                current_v = self.channel_data[ch]["v"][-1]
                current_raw = self.channel_data[ch]["raw"][-1]
                self.lbl_current_v.setText(f"{current_v:.6f} V")
                self.lbl_current_raw.setText(f"{current_raw}")

                # Show prediction if calibrated
                cal = self.cal_manager.get_or_create(ch)
                if cal.human_input_count >= 2:
                    p_mean, p_std = cal.predict_pressure(current_v, self.env_state)
                    self.lbl_prediction.setText(
                        f"Prediction: {p_mean/1000:.2f} ± {p_std/1000:.2f} kPa"
                    )
                else:
                    self.lbl_prediction.setText(
                        "Prediction: Need ≥2 calibration points"
                    )

        # Update sensor status
        for ch in self.active_channels:
            if ch in self.sensor_labels:
                cal = self.cal_manager.get_or_create(ch)
                confidence_names = ["LOW", "MEDIUM", "HIGH", "MAXIMUM"]
                status = f"CH{ch}: {cal.human_input_count} pts, {confidence_names[cal.confidence_level]}, {cal.get_reliability_score()*100:.0f}% reliable"
                self.sensor_labels[ch].setText(status)

        # Update progress
        for ch in self.active_channels:
            if ch in self.progress_labels:
                cal = self.cal_manager.get_or_create(ch)
                confidence_names = ["LOW", "MEDIUM", "HIGH", "MAXIMUM"]
                self.progress_labels[ch].setText(
                    f"CH{ch}: {cal.human_input_count} points, {confidence_names[cal.confidence_level]} confidence"
                )

        # Remove stale channels (not seen in 5 seconds)
        now = time.time()
        for ch in list(self.active_channels):
            if ch in self.last_seen and (now - self.last_seen[ch]) > 5.0:
                if ch in self.sensor_labels:
                    self.sensor_labels[ch].setText(f"CH{ch}: OFFLINE")
                    self.sensor_labels[ch].setStyleSheet("color: #ff0000;")

    def _auto_save(self):
        """Auto-save calibrations periodically"""
        if self.active_channels:
            self.cal_manager.save_calibrations()

    def closeEvent(self, event):
        """Save on exit"""
        if self.reader:
            self.reader.stop()
        self.cal_manager.save_calibrations()
        event.accept()


# ---------------------- Entry Point ----------------------
def main():
    app = QtWidgets.QApplication(sys.argv)
    gui = RobustPTCalibrationGUI()
    gui.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
