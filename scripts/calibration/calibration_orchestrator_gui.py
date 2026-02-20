#!/usr/bin/env python3
"""
Calibration Orchestrator GUI
PyQt6 GUI for the calibration orchestrator with live sensor data,
calibration controls, and status display.
"""

import sys
import time
import threading
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from collections import deque, defaultdict

from PyQt6 import QtCore, QtGui, QtWidgets
import pyqtgraph as pg
import numpy as np

# Import orchestrator
from calibration_orchestrator import (
    CalibrationOrchestrator,
    SENSOR_TYPES,
    SensorTypeInfo,
)

# Import config loader for sensor roles
try:
    from config_loader import load_config

    _cfg_loaded = True
except ImportError:
    _cfg_loaded = False

# Color scheme
COLORS = {
    "bg": "#1e1e1e",
    "fg": "#ffffff",
    "accent": "#0078d4",
    "success": "#00ff00",
    "warning": "#ffaa00",
    "error": "#ff0000",
    "grid": "#333333",
}


class CalibrationOrchestratorGUI(QtWidgets.QMainWindow):
    """Main GUI window for calibration orchestrator"""

    def __init__(self, sensor_names: Optional[List[str]] = None):
        super().__init__()
        self.orchestrator = CalibrationOrchestrator(sensor_names)
        self.running = False
        self.phase = "INIT"

        # Data buffers for plotting
        self.plot_data: Dict[Tuple[str, int], deque] = {}
        self.plot_times: Dict[Tuple[str, int], deque] = {}

        # Channel number mapping (for simple "Channel 1", "Channel 2" labels)
        self.channel_numbers: Dict[Tuple[str, int], int] = {}

        # Reference input fields
        self.ref_inputs: Dict[Tuple[str, int], QtWidgets.QLineEdit] = {}

        self.init_ui()
        self.setup_timers()

    def init_ui(self):
        """Initialize UI"""
        self.setWindowTitle("Calibration Orchestrator")
        self.setGeometry(100, 100, 1600, 1000)

        # Central widget
        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        layout = QtWidgets.QHBoxLayout(central)

        # Left panel: Controls
        left_panel = self.create_control_panel()
        layout.addWidget(left_panel, 1)

        # Right panel: Plots and status
        right_panel = self.create_plot_panel()
        layout.addWidget(right_panel, 2)

        # Apply dark theme
        self.setStyleSheet(
            f"""
            QMainWindow {{
                background-color: {COLORS["bg"]};
                color: {COLORS["fg"]};
            }}
            QPushButton {{
                background-color: {COLORS["accent"]};
                color: white;
                border: none;
                padding: 8px;
                border-radius: 4px;
                font-weight: bold;
            }}
            QPushButton:hover {{
                background-color: #005a9e;
            }}
            QPushButton:pressed {{
                background-color: #004578;
            }}
            QLineEdit {{
                background-color: #2d2d2d;
                color: {COLORS["fg"]};
                border: 1px solid #555;
                padding: 4px;
                border-radius: 2px;
            }}
            QLabel {{
                color: {COLORS["fg"]};
            }}
            QGroupBox {{
                color: {COLORS["fg"]};
                border: 1px solid #555;
                border-radius: 4px;
                margin-top: 10px;
                padding-top: 10px;
            }}
            QGroupBox::title {{
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 5px;
            }}
        """
        )

    def create_control_panel(self) -> QtWidgets.QWidget:
        """Create left control panel"""
        panel = QtWidgets.QWidget()
        layout = QtWidgets.QVBoxLayout(panel)

        # Title
        title = QtWidgets.QLabel("Calibration Orchestrator")
        title.setStyleSheet("font-size: 18pt; font-weight: bold; padding: 10px;")
        layout.addWidget(title)

        # Phase indicator
        self.phase_label = QtWidgets.QLabel("Phase: INIT")
        self.phase_label.setStyleSheet("font-size: 14pt; padding: 5px;")
        layout.addWidget(self.phase_label)

        # Status
        status_group = QtWidgets.QGroupBox("Status")
        status_layout = QtWidgets.QVBoxLayout()

        self.status_text = QtWidgets.QTextEdit()
        self.status_text.setReadOnly(True)
        self.status_text.setMaximumHeight(150)
        status_layout.addWidget(self.status_text)
        status_group.setLayout(status_layout)
        layout.addWidget(status_group)

        # Phase 1 Controls
        phase1_group = QtWidgets.QGroupBox("Phase 1: Calibration")
        phase1_layout = QtWidgets.QVBoxLayout()

        # Reference input section
        ref_group = QtWidgets.QGroupBox("Set Reference Values")
        ref_group.setToolTip(
            "Enter the known reference value (e.g., pressure in PSI, temperature in °C) "
            "for each sensor channel. This is the true value you're calibrating against. "
            "After setting references, click 'Collect' to gather calibration data points."
        )
        ref_layout = QtWidgets.QVBoxLayout()

        # Per-sensor-type reference inputs (only for active connectors)
        for stype, info in self.orchestrator.sensor_types.items():
            active_connectors = self.orchestrator.active_connectors.get(stype, [])
            if not active_connectors:
                continue

            # Get sensor role names if available
            role_map = {}
            if _cfg_loaded:
                try:
                    from config_loader import load_config

                    cfg = load_config()
                    roles = cfg.get("sensor_roles", {})
                    for role, role_ch in roles.items():
                        if role_ch in active_connectors and stype == "PT":
                            role_map[role_ch] = role
                except:
                    pass

            type_group = QtWidgets.QGroupBox(f"{stype} ({info.unit})")
            type_layout = QtWidgets.QGridLayout()

            row = 0
            for board_ip, ch in connectors:
                key = (stype, ch)

                # Create label with role name if available
                label_text = f"CH{ch}"
                if ch in role_map:
                    label_text = f"{role_map[ch]} (CH{ch})"

                label = QtWidgets.QLabel(f"{label_text}:")
                ref_input = QtWidgets.QLineEdit()
                ref_input.setPlaceholderText(f"Reference {info.unit}")
                ref_input.setToolTip(
                    f"Enter the known reference value in {info.unit}.\n"
                    f"For example, if calibrating a pressure sensor at 14.7 PSI, enter '14.7'.\n"
                    f"This value will be used as the ground truth for calibration."
                )
                ref_input.returnPressed.connect(
                    lambda checked, k=key, inp=ref_input: self.set_reference(
                        k, inp.text()
                    )
                )

                set_btn = QtWidgets.QPushButton("Set")
                set_btn.setToolTip("Set this reference value for calibration")
                set_btn.clicked.connect(
                    lambda checked, k=key, inp=ref_input: self.set_reference(
                        k, inp.text()
                    )
                )

                self.ref_inputs[key] = ref_input
                type_layout.addWidget(label, row, 0)
                type_layout.addWidget(ref_input, row, 1)
                type_layout.addWidget(set_btn, row, 2)
                row += 1

            type_group.setLayout(type_layout)
            ref_layout.addWidget(type_group)

        ref_group.setLayout(ref_layout)
        phase1_layout.addWidget(ref_group)

        # Batch reference
        batch_group = QtWidgets.QGroupBox("Batch Reference")
        batch_layout = QtWidgets.QHBoxLayout()

        self.batch_type_combo = QtWidgets.QComboBox()
        self.batch_type_combo.addItems(list(self.orchestrator.sensor_types.keys()))
        batch_layout.addWidget(QtWidgets.QLabel("Type:"))
        batch_layout.addWidget(self.batch_type_combo)

        self.batch_value_input = QtWidgets.QLineEdit()
        self.batch_value_input.setPlaceholderText("Value")
        batch_layout.addWidget(self.batch_value_input)

        batch_set_btn = QtWidgets.QPushButton("Set All")
        batch_set_btn.clicked.connect(self.set_batch_reference)
        batch_layout.addWidget(batch_set_btn)

        batch_group.setLayout(batch_layout)
        phase1_layout.addWidget(batch_group)

        # Collection controls
        collect_group = QtWidgets.QGroupBox("Collection")
        collect_layout = QtWidgets.QHBoxLayout()

        self.collect_duration_input = QtWidgets.QLineEdit("5.0")
        self.collect_duration_input.setPlaceholderText("Duration (sec)")
        collect_layout.addWidget(QtWidgets.QLabel("Duration:"))
        collect_layout.addWidget(self.collect_duration_input)

        self.collect_btn = QtWidgets.QPushButton("Collect")
        self.collect_btn.clicked.connect(self.start_collection)
        collect_layout.addWidget(self.collect_btn)

        collect_group.setLayout(collect_layout)
        phase1_layout.addWidget(collect_group)

        # Fit and save
        action_layout = QtWidgets.QHBoxLayout()

        self.fit_btn = QtWidgets.QPushButton("Fit (TLS+Bayesian)")
        self.fit_btn.clicked.connect(self.fit_calibrations)
        action_layout.addWidget(self.fit_btn)

        self.save_btn = QtWidgets.QPushButton("Save")
        self.save_btn.clicked.connect(self.save_calibrations)
        action_layout.addWidget(self.save_btn)

        phase1_layout.addLayout(action_layout)

        # Phase transition
        self.done_btn = QtWidgets.QPushButton("Done → Phase 2")
        self.done_btn.clicked.connect(self.transition_to_phase2)
        phase1_layout.addWidget(self.done_btn)

        phase1_group.setLayout(phase1_layout)
        layout.addWidget(phase1_group)

        # Phase 2 Controls
        phase2_group = QtWidgets.QGroupBox("Phase 2: Monitoring")
        phase2_layout = QtWidgets.QVBoxLayout()

        self.monitor_status_label = QtWidgets.QLabel("Not started")
        phase2_layout.addWidget(self.monitor_status_label)

        phase2_group.setLayout(phase2_layout)
        layout.addWidget(phase2_group)

        # Actuator controls (if available)
        if (
            hasattr(self.orchestrator, "actuator_comm")
            and self.orchestrator.actuator_comm
        ):
            actuator_group = QtWidgets.QGroupBox("Actuator Control")
            actuator_layout = QtWidgets.QGridLayout()

            # Get number of actuators dynamically from config/CSV
            try:
                import sys
                from pathlib import Path
                # Try to import from combined_gui if available
                sys.path.insert(0, str(Path(__file__).parent.parent.parent / "external" / "DiabloAvionics" / "test_guis"))
                try:
                    from combined_gui import get_num_actuators
                    num_actuators = get_num_actuators()
                except ImportError:
                    # Fallback: try to count from CSV
                    csv_path = Path(__file__).parent.parent.parent / "external" / "DiabloAvionics" / "test_guis" / "state_machine_actuators.csv"
                    if csv_path.exists():
                        import csv
                        with open(csv_path, 'r') as f:
                            reader = csv.reader(f)
                            rows = list(reader)
                            num_actuators = sum(1 for row in rows[1:] if len(row) > 0 and row[0].strip()) if len(rows) > 1 else 10
                    else:
                        num_actuators = 10
            except Exception:
                num_actuators = 10
            
            # Calculate optimal grid layout
            if num_actuators <= 8:
                cols = 2
            elif num_actuators <= 16:
                cols = 4
            else:
                cols = 4
            
            for i in range(1, num_actuators + 1):
                on_btn = QtWidgets.QPushButton(f"ON {i}")
                off_btn = QtWidgets.QPushButton(f"OFF {i}")
                on_btn.clicked.connect(
                    lambda checked, aid=i: self.send_actuator_command(aid, 1)
                )
                off_btn.clicked.connect(
                    lambda checked, aid=i: self.send_actuator_command(aid, 0)
                )

                row = (i - 1) // cols
                col = (i - 1) % cols
                actuator_layout.addWidget(
                    QtWidgets.QLabel(f"Act {i}:"), row * 2, col * 2
                )
                actuator_layout.addWidget(on_btn, row * 2, col * 2 + 1)
                actuator_layout.addWidget(off_btn, row * 2 + 1, col * 2 + 1)

            actuator_group.setLayout(actuator_layout)
            layout.addWidget(actuator_group)

        layout.addStretch()

        return panel

    def create_plot_panel(self) -> QtWidgets.QWidget:
        """Create right plot panel"""
        panel = QtWidgets.QWidget()
        layout = QtWidgets.QVBoxLayout(panel)

        # Tab widget for different views
        tabs = QtWidgets.QTabWidget()

        # Live data tab - grouped by sensor type
        live_tab = QtWidgets.QWidget()
        live_layout = QtWidgets.QVBoxLayout(live_tab)

        # Scroll area for plots
        scroll = QtWidgets.QScrollArea()
        scroll.setWidgetResizable(True)
        scroll_widget = QtWidgets.QWidget()
        scroll_layout = QtWidgets.QVBoxLayout(scroll_widget)

        # Group sensors by type
        self.plot_widgets: Dict[str, pg.GraphicsLayoutWidget] = {}
        self.plot_curves: Dict[Tuple[str, int], pg.PlotDataItem] = {}

        # Collect sensors grouped by type
        sensors_by_type: Dict[str, List[Tuple[str, int]]] = defaultdict(list)

        for (
            stype,
            board_ip,
        ), active_conns in self.orchestrator.active_connectors.items():
            for ch in active_conns:
                key = (stype, ch)
                sensors_by_type[stype].append(key)

        # Create a plot widget for each sensor type
        for stype in sorted(sensors_by_type.keys()):
            sensors = sorted(
                sensors_by_type[stype], key=lambda x: x[1]
            )  # Sort by channel

            # Create plot widget for this sensor type
            plot_widget = pg.GraphicsLayoutWidget()
            plot_widget.setBackground(COLORS["bg"])
            plot = plot_widget.addPlot(title=f"{stype} Sensors")
            plot.setLabel("left", "ADC Code")
            plot.setLabel("bottom", "Time (s)")
            plot.showGrid(x=True, y=True, alpha=0.3)
            plot.addLegend()

            self.plot_widgets[stype] = plot_widget

            # Create curves for each sensor in this type
            for idx, key in enumerate(sensors):
                stype_key, ch = key

                # Initialize data buffers
                self.plot_data[key] = deque(maxlen=1000)
                self.plot_times[key] = deque(maxlen=1000)

                # Create curve with channel label
                color = pg.intColor(idx, len(sensors))  # Cycle through colors
                curve = plot.plot([], [], pen=color, name=f"CH{ch}")
                self.plot_curves[key] = curve

            scroll_layout.addWidget(plot_widget)

        scroll.setWidget(scroll_widget)
        live_layout.addWidget(scroll)

        tabs.addTab(live_tab, "Live Data")

        # Calibration status tab
        status_tab = QtWidgets.QWidget()
        status_layout = QtWidgets.QVBoxLayout(status_tab)

        self.status_table = QtWidgets.QTableWidget()
        self.status_table.setColumnCount(7)
        self.status_table.setHorizontalHeaderLabels(
            ["Type", "Channel", "Points", "RMSE", "R²", "Confidence", "Status"]
        )
        status_layout.addWidget(self.status_table)

        tabs.addTab(status_tab, "Calibration Status")

        layout.addWidget(tabs)

        return panel

    def setup_timers(self):
        """Setup update timers"""
        # Data update timer (100ms)
        self.data_timer = QtCore.QTimer(self)
        self.data_timer.timeout.connect(self.update_data)
        self.data_timer.start(100)

        # Status update timer (1s)
        self.status_timer = QtCore.QTimer(self)
        self.status_timer.timeout.connect(self.update_status)
        self.status_timer.start(1000)

    def set_reference(self, key: Tuple[str, int], value_str: str):
        """Set reference value for a channel"""
        try:
            value = float(value_str)
            self.orchestrator.references[key] = value
            stype, ch = key
            info = self.orchestrator.sensor_types[stype]
            self.status_text.append(f"✅ {stype} CH{ch} → {value} {info.unit}")
        except ValueError:
            self.status_text.append(f"❌ Invalid value: {value_str}")

    def set_batch_reference(self):
        """Set reference for all channels of a type"""
        stype = self.batch_type_combo.currentText()
        try:
            value = float(self.batch_value_input.text())
            info = self.orchestrator.sensor_types[stype]
            for ch in range(1, info.num_sensors + 1):
                key = (stype, ch)
                self.orchestrator.references[key] = value
                if key in self.ref_inputs:
                    self.ref_inputs[key].setText(str(value))
            self.status_text.append(f"✅ {stype} all → {value} {info.unit}")
        except ValueError:
            self.status_text.append(f"❌ Invalid value")

    def start_collection(self):
        """Start collecting calibration points"""
        try:
            duration = float(self.collect_duration_input.text())
        except ValueError:
            duration = 5.0

        if not self.orchestrator.references:
            self.status_text.append("⚠️  No references set")
            return

        self.status_text.append(f"📊 Collecting for {duration:.1f}s...")
        self.collect_btn.setEnabled(False)

        # Set collecting flag and run collection in thread
        def collect_thread():
            self.orchestrator.collecting = True
            try:
                self.orchestrator._collect(duration)
            finally:
                self.orchestrator.collecting = False
            QtCore.QTimer.singleShot(0, lambda: self.collect_btn.setEnabled(True))
            QtCore.QTimer.singleShot(
                0, lambda: self.status_text.append("✅ Collection complete")
            )

        threading.Thread(target=collect_thread, daemon=True).start()

    def fit_calibrations(self):
        """Run TLS + Bayesian fit"""
        self.status_text.append("🔧 Running TLS + Bayesian fit...")
        self.fit_btn.setEnabled(False)

        def fit_thread():
            self.orchestrator._tls_bayesian_fit_all()
            QtCore.QTimer.singleShot(0, lambda: self.fit_btn.setEnabled(True))
            QtCore.QTimer.singleShot(
                0, lambda: self.status_text.append("✅ Fit complete")
            )

        threading.Thread(target=fit_thread, daemon=True).start()

    def save_calibrations(self):
        """Save calibrations"""
        self.status_text.append("💾 Saving calibrations...")
        self.orchestrator._save_all()
        self.status_text.append("✅ Saved")

    def transition_to_phase2(self):
        """Transition to Phase 2"""
        self.orchestrator._tls_bayesian_fit_all()
        self.orchestrator._save_all()
        self.status_text.append("➡️  Transitioning to Phase 2...")

        def phase2_thread():
            self.orchestrator.run_phase2()

        threading.Thread(target=phase2_thread, daemon=True).start()
        self.phase = "MONITORING"
        self.phase_label.setText("Phase: MONITORING")

    def send_actuator_command(self, actuator_id: int, state: int):
        """Send actuator command"""
        if (
            hasattr(self.orchestrator, "actuator_comm")
            and self.orchestrator.actuator_comm
        ):
            self.orchestrator.actuator_comm.send_command(actuator_id, state)
            self.status_text.append(
                f"📤 Actuator {actuator_id} → {'ON' if state else 'OFF'}"
            )
        else:
            self.status_text.append(f"⚠️  Actuator communication not available")

    def update_data(self):
        """Update live data plots"""
        if not self.running:
            return

        # Drain queue continuously (no timeout)
        self.orchestrator._drain_queue()

        # Update plots
        now = time.time()
        for key, curve in self.plot_curves.items():
            # Access live_adc directly (it's a defaultdict, so key always exists)
            # But we need to check if it has data
            if key not in self.orchestrator.live_adc:
                continue

            buf = self.orchestrator.live_adc[key]

            # Get new samples since last update
            if len(buf) > 0:
                # Get all samples from buffer (copy to avoid issues)
                new_samples = list(buf)
                # Add to plot data
                self.plot_data[key].extend(new_samples)
                self.plot_times[key].extend([now] * len(new_samples))

                # Update curve
                if len(self.plot_data[key]) > 0:
                    times = np.array(self.plot_times[key])
                    data = np.array(self.plot_data[key])
                    # Show last 30 seconds
                    cutoff = now - 30.0
                    mask = times >= cutoff
                    if np.any(mask):
                        curve.setData(times[mask] - cutoff, data[mask])

    def update_status(self):
        """Update status display"""
        # Update phase
        if self.orchestrator.phase != self.phase:
            self.phase = self.orchestrator.phase
            self.phase_label.setText(f"Phase: {self.phase}")

        # Update status table
        self.status_table.setRowCount(0)
        for key, rcf in self.orchestrator.robust.items():
            stype, ch = key
            summary = rcf.get_calibration_summary()

            row = self.status_table.rowCount()
            self.status_table.insertRow(row)

            self.status_table.setItem(row, 0, QtWidgets.QTableWidgetItem(stype))
            self.status_table.setItem(row, 1, QtWidgets.QTableWidgetItem(str(ch)))
            self.status_table.setItem(
                row, 2, QtWidgets.QTableWidgetItem(str(len(rcf.calibration_points)))
            )
            self.status_table.setItem(
                row, 3, QtWidgets.QTableWidgetItem(f"{summary.get('rmse', 0.0):.4f}")
            )
            self.status_table.setItem(
                row,
                4,
                QtWidgets.QTableWidgetItem(f"{summary.get('r_squared', 0.0):.4f}"),
            )
            self.status_table.setItem(
                row, 5, QtWidgets.QTableWidgetItem(rcf.get_confidence_level())
            )
            self.status_table.setItem(
                row,
                6,
                QtWidgets.QTableWidgetItem(
                    "CALIBRATED"
                    if len(rcf.calibration_points) >= self.orchestrator.min_points
                    else "PENDING"
                ),
            )

    def start(self):
        """Start the orchestrator"""
        if not self.orchestrator.start_receiver():
            QtWidgets.QMessageBox.critical(
                self, "Error", "Failed to start UDP receiver"
            )
            return

        self.running = True
        self.phase = "CALIBRATION"
        self.phase_label.setText("Phase: CALIBRATION")
        self.status_text.append("✅ Orchestrator started")
        self.status_text.append(f"📡 Listening on UDP port {self.orchestrator.port}")
        self.status_text.append(
            f"📊 Monitoring {len(self.plot_curves)} sensor channels"
        )

        # Log receiver stats periodically
        def log_stats():
            if self.running and hasattr(self.orchestrator, "receiver"):
                stats = self.orchestrator.receiver.stats
                queue_size = len(self.orchestrator.receiver.sample_queue)
                if stats.get("packets", 0) > 0 or queue_size > 0:
                    self.status_text.append(
                        f"📈 Stats: {stats.get('packets', 0)} packets, "
                        f"{stats.get('samples', 0)} samples, queue: {queue_size}"
                    )

        # Log stats every 5 seconds
        self.stats_timer = QtCore.QTimer(self)
        self.stats_timer.timeout.connect(log_stats)
        self.stats_timer.start(5000)

        # Don't run the command loop - GUI handles it directly
        self.orchestrator.phase = "CALIBRATION"

    def closeEvent(self, event):
        """Handle window close"""
        self.running = False
        self.orchestrator.stop()
        event.accept()


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Calibration Orchestrator GUI")
    parser.add_argument("--sensors", nargs="+", help="Sensor types (PT, TC, RTD, LC)")
    args = parser.parse_args()

    sensor_names = [s.upper() for s in args.sensors] if args.sensors else None

    app = QtWidgets.QApplication(sys.argv)
    app.setStyle("Fusion")

    window = CalibrationOrchestratorGUI(sensor_names)
    window.show()
    window.start()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
