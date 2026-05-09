#!/usr/bin/env python3
"""
PT_BOARD_multi_gui – Live plots for PT_BOARD_Multi_Send

Receives DAQv2-Comms SENSOR_DATA packets over UDP from PT_BOARD_Multi_Send,
decodes them, and displays real-time voltage plots for each PT (1–10).

Ensure the firmware's receiverIP matches this machine's IP (or use 192.168.2.20)
and that the GUI listens on port 5007 (PT board). Actuator_Testing uses 5006 so
both can run together.

  pip install -r requirements.txt
  python pt_multi_gui.py [-p 5007] [-a 0.0.0.0]

  On macOS, if you get a segfault: use PyQt5 instead of PyQt6
  (pip install PyQt5; this script will try PyQt5 if PyQt6 is unavailable).
"""

import csv
import os
import socket
import struct
import sys
import time
from typing import Optional, Tuple, List, Dict
from collections import deque

# On macOS, PyQt6.5+ can segfault with pyqtgraph; prefer PyQt5 when available.
if sys.platform == "darwin":
    os.environ.setdefault("QT_MAC_WANTS_LAYER", "1")
    try:
        from PyQt5 import QtCore, QtGui, QtWidgets
        _QT_HORIZ = QtCore.Qt.Horizontal
    except ImportError:
        from PyQt6 import QtCore, QtGui, QtWidgets
        _QT_HORIZ = QtCore.Qt.Orientation.Horizontal
else:
    try:
        from PyQt6 import QtCore, QtGui, QtWidgets
        _QT_HORIZ = QtCore.Qt.Orientation.Horizontal
    except ImportError:
        from PyQt5 import QtCore, QtGui, QtWidgets
        _QT_HORIZ = QtCore.Qt.Horizontal

import pyqtgraph as pg
import numpy as np

# Reduce chance of pyqtgraph/Qt segfaults on macOS (OpenGL + Qt on Mac can crash)
pg.setConfigOptions(antialias=False, useOpenGL=False)

# DAQv2-Comms protocol (match firmware)
MAX_PACKET_SIZE = 512
PacketType = type("PacketType", (), {"SENSOR_DATA": 3})
PACKET_HEADER_FORMAT = "<BBI"
PACKET_HEADER_SIZE = 6
SENSOR_DATA_PACKET_FORMAT = "<BB"
SENSOR_DATA_PACKET_SIZE = 2
SENSOR_DATA_CHUNK_FORMAT = "<I"
SENSOR_DATA_CHUNK_SIZE = 4
SENSOR_DATAPOINT_FORMAT = "<Bf"  # sensor_id uint8, data float (sent as uint32 bits)
SENSOR_DATAPOINT_SIZE = 5

DEFAULT_PORT = 5007   # PT board; Actuator_Testing uses 5006 so both can run together
DEFAULT_WINDOW_SECONDS = 30.0
MAX_POINTS = 8000
UPDATE_INTERVAL_MS = 50
NUM_PTS = 10

PT_COLORS = [
    (255, 80, 80), (80, 255, 80), (80, 150, 255), (255, 200, 80),
    (200, 80, 255), (80, 255, 255), (255, 150, 150), (150, 255, 150),
    (150, 200, 255), (255, 255, 80),
]

# Per-PT pressure calibration: pressure = A*V^3 + B*V^2 + C*V + D
# (A, B, C, D) for each PT 1..10. PT 6–10 use PT 1 cal until you add values.
PT_CALIBRATION = [
    (-1.14351422603069e-09, 6.07260454422966e-06, 0.0926898002815586, -45.4811452217083),   # PT 1
    (-8.46148513e-09, 3.85591637e-05, 1.50430101e-01, -8.31516318e+01),                     # PT 2
    (-1.12886040e-08, 5.37687043e-05, 1.24582809e-01, -7.92816379e+01),                     # PT 3
    (-2.92357884e-09, 1.60928197e-05, 1.73172679e-01, -8.41620248e+01),                     # PT 4
    (-2.07890243e-09, 7.98159784e-06, 1.92631458e-01, -7.84202084e+01),                     # PT 5
    (-1.14351422603069e-09, 6.07260454422966e-06, 0.0926898002815586, -45.4811452217083),   # PT 6 (placeholder)
    (-1.14351422603069e-09, 6.07260454422966e-06, 0.0926898002815586, -45.4811452217083),   # PT 7 (placeholder)
    (-1.14351422603069e-09, 6.07260454422966e-06, 0.0926898002815586, -45.4811452217083),   # PT 8 (placeholder)
    (-1.14351422603069e-09, 6.07260454422966e-06, 0.0926898002815586, -45.4811452217083),   # PT 9 (placeholder)
    (-1.14351422603069e-09, 6.07260454422966e-06, 0.0926898002815586, -45.4811452217083),   # PT 10 (placeholder)
]

PRESSURE_UNIT = "psi"


def calculate_pressure(raw_value: float, a: float, b: float, c: float, d: float) -> float:
    """Convert raw voltage to pressure using polynomial calibration."""
    v = float(raw_value)
    return (a * (v ** 3)) + (b * (v ** 2)) + (c * v) + d


def parse_packet_header(data: bytes) -> Optional[Tuple[int, int, int]]:
    if len(data) < PACKET_HEADER_SIZE:
        return None
    try:
        return struct.unpack(PACKET_HEADER_FORMAT, data[:PACKET_HEADER_SIZE])
    except struct.error:
        return None


def parse_sensor_data_packet(data: bytes) -> Optional[Tuple[dict, List[dict]]]:
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
            data[offset : offset + SENSOR_DATA_PACKET_SIZE],
        )
    except struct.error:
        return None
    offset += SENSOR_DATA_PACKET_SIZE
    per_chunk = SENSOR_DATA_CHUNK_SIZE + num_sensors * SENSOR_DATAPOINT_SIZE
    if len(data) < PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE + num_chunks * per_chunk:
        return None
    chunks = []
    for _ in range(num_chunks):
        chunk_ts, = struct.unpack(SENSOR_DATA_CHUNK_FORMAT, data[offset : offset + SENSOR_DATA_CHUNK_SIZE])
        offset += SENSOR_DATA_CHUNK_SIZE
        datapoints = []
        for _ in range(num_sensors):
            sid, val = struct.unpack(SENSOR_DATAPOINT_FORMAT, data[offset : offset + SENSOR_DATAPOINT_SIZE])
            datapoints.append({"sensor_id": sid, "data": val})
            offset += SENSOR_DATAPOINT_SIZE
        chunks.append({"timestamp": chunk_ts, "datapoints": datapoints})
    return ({"packet_type": packet_type, "version": version, "timestamp": timestamp}, chunks)


class UDPReceiver(QtCore.QThread):
    sensor_data_received = QtCore.pyqtSignal(dict, list)
    status_update = QtCore.pyqtSignal(str)

    def __init__(self, port: int, bind_address: str):
        super().__init__()
        self.port = port
        self.bind_address = bind_address
        self._stop = False
        self.sock = None
        self.total_packets = 0
        self.total_bytes = 0
        self.start_time = None

    def stop(self):
        self._stop = True
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass

    def get_stats(self) -> Dict:
        if self.start_time is None:
            return {"packets": 0, "bytes": 0, "packets_per_sec": 0.0, "bytes_per_sec": 0.0}
        elapsed = time.time() - self.start_time
        pps = self.total_packets / elapsed if elapsed > 0 else 0.0
        bps = self.total_bytes / elapsed if elapsed > 0 else 0.0
        return {"packets": self.total_packets, "bytes": self.total_bytes, "packets_per_sec": pps, "bytes_per_sec": bps}

    def run(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.settimeout(0.1)
        try:
            self.sock.bind((self.bind_address, self.port))
            msg = f"Listening {self.bind_address}:{self.port} — Set ESP RECEIVER_IP to this PC. If Packets stay 0: Mac: allow Python in Firewall."
            self.status_update.emit(msg)
            self.start_time = time.time()
        except OSError as e:
            self.status_update.emit(f"Bind error: {e}")
            return
        while not self._stop:
            try:
                data, _ = self.sock.recvfrom(MAX_PACKET_SIZE)
                self.total_packets += 1
                self.total_bytes += len(data)
                header = parse_packet_header(data)
                if header is not None and header[0] == PacketType.SENSOR_DATA:
                    result = parse_sensor_data_packet(data)
                    if result:
                        self.sensor_data_received.emit(result[0], result[1])
            except socket.timeout:
                continue
            except Exception as e:
                if not self._stop:
                    self.status_update.emit(f"Error: {e}")
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
        self.status_update.emit("Stopped")


class PTPlotWindow(QtWidgets.QMainWindow):
    def __init__(self, port: int = DEFAULT_PORT, bind_address: str = "0.0.0.0"):
        super().__init__()
        self.port = port
        self.bind_address = bind_address
        self.window_seconds = DEFAULT_WINDOW_SECONDS
        self.sensor_data: Dict[int, deque] = {}
        self.sensor_plots: Dict[int, pg.PlotDataItem] = {}
        self.plot_enabled: Dict[int, bool] = {i: True for i in range(NUM_PTS)}
        self.stats_start_time = time.time()
        self.receiver = None
        self.init_ui()
        self.start_receiver()
        self.update_timer = QtCore.QTimer()
        self.update_timer.timeout.connect(self.update_plots)
        self.update_timer.start(UPDATE_INTERVAL_MS)
        self.stats_timer = QtCore.QTimer()
        self.stats_timer.timeout.connect(self.update_statistics)
        self.stats_timer.start(500)

    def pt_label(self, sensor_id: int) -> str:
        return f"PT {sensor_id + 1}"

    def init_ui(self):
        self.setWindowTitle(f"PT Board Multi – Live Plots (port {self.port})")
        self.setGeometry(100, 100, 1200, 700)
        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        layout = QtWidgets.QVBoxLayout(central)
        top = QtWidgets.QHBoxLayout()
        self.status_label = QtWidgets.QLabel("Starting...")
        self.status_label.setStyleSheet("font-weight: bold; padding: 5px;")
        top.addWidget(self.status_label)
        top.addStretch()
        settings_btn = QtWidgets.QPushButton("Settings")
        settings_btn.clicked.connect(self.show_settings)
        top.addWidget(settings_btn)
        csv_btn = QtWidgets.QPushButton("Download CSV")
        csv_btn.clicked.connect(self.save_csv)
        top.addWidget(csv_btn)
        layout.addLayout(top)
        plot_stats = QtWidgets.QHBoxLayout()
        self.plot_widget = pg.GraphicsLayoutWidget()
        self.plot_widget.setBackground("k")
        plot_stats.addWidget(self.plot_widget, 1)
        stats_group = QtWidgets.QGroupBox("Statistics")
        sl = QtWidgets.QVBoxLayout()
        self.packets_label = QtWidgets.QLabel("Packets: 0")
        self.pps_label = QtWidgets.QLabel("Packets/sec: 0.0")
        self.bytes_label = QtWidgets.QLabel("Bytes: 0")
        self.bps_label = QtWidgets.QLabel("Bytes/sec: 0.0")
        for w in (self.packets_label, self.pps_label, self.bytes_label, self.bps_label):
            w.setFont(QtGui.QFont("", 11))
        sl.addWidget(self.packets_label)
        sl.addWidget(self.pps_label)
        sl.addWidget(self.bytes_label)
        sl.addWidget(self.bps_label)
        sl.addStretch()
        stats_group.setLayout(sl)
        stats_group.setFixedWidth(180)
        plot_stats.addWidget(stats_group)
        # PT toggles and voltage displays
        pt_group = QtWidgets.QGroupBox("Channels")
        pt_layout = QtWidgets.QVBoxLayout()
        self.pt_toggles: Dict[int, QtWidgets.QCheckBox] = {}
        self.pt_voltage_labels: Dict[int, QtWidgets.QLabel] = {}
        for i in range(NUM_PTS):
            row = QtWidgets.QHBoxLayout()
            cb = QtWidgets.QCheckBox(self.pt_label(i))
            cb.setChecked(True)
            cb.stateChanged.connect(lambda s, idx=i: self._on_plot_toggle(idx, s))
            self.pt_toggles[i] = cb
            row.addWidget(cb)
            vl = QtWidgets.QLabel(f"-- {PRESSURE_UNIT}")
            vl.setStyleSheet(f"color: rgb{PT_COLORS[i % len(PT_COLORS)]}; font-weight: bold; min-width: 60px;")
            self.pt_voltage_labels[i] = vl
            row.addWidget(vl)
            pt_layout.addLayout(row)
        pt_group.setLayout(pt_layout)
        pt_group.setFixedWidth(140)
        plot_stats.addWidget(pt_group)
        layout.addLayout(plot_stats, 1)
        self.plot_item = self.plot_widget.addPlot(title="PT Voltages")
        self.plot_item.setTitle("PT Voltages", color="w", size="14pt")
        self.plot_item.setLabel("left", "Voltage (V)", color="w")
        self.plot_item.setLabel("bottom", "Time (s)", color="w")
        self.plot_item.addLegend()
        self.plot_item.showGrid(x=True, y=True, alpha=0.5)
        self.plot_item.getViewBox().setBackgroundColor("k")
        f = QtGui.QFont("", 12)
        for ax in ("left", "bottom"):
            a = self.plot_item.getAxis(ax)
            a.setStyle(tickFont=f)
            try:
                a.label.setFont(f)
            except Exception:
                pass
            a.setPen("w")
            a.setTextPen("w")
        self.legend = self.plot_item.legend
        if self.legend:
            self.legend.setBrush(pg.mkBrush("k"))
            self.legend.setPen(pg.mkPen("w"))
        # Pre-create plots for PT 1..10
        for i in range(NUM_PTS):
            c = PT_COLORS[i % len(PT_COLORS)]
            pen = pg.mkPen(color=c, width=2)
            plot = self.plot_item.plot([], [], pen=pen, name=self.pt_label(i))
            self.sensor_plots[i] = plot
            self.sensor_data[i] = deque(maxlen=MAX_POINTS)
        for it in (self.legend.items or []):
            if len(it) >= 2:
                try:
                    it[1].setColor("w")
                except Exception:
                    pass

    def _on_plot_toggle(self, idx: int, state):
        self.plot_enabled[idx] = bool(state)

    def start_receiver(self):
        self.receiver = UDPReceiver(port=self.port, bind_address=self.bind_address)
        self.receiver.sensor_data_received.connect(self.on_sensor_data)
        self.receiver.status_update.connect(self.status_label.setText)
        self.receiver.start()

    def on_sensor_data(self, header: dict, chunks: List[dict]):
        t0 = time.time() - self.stats_start_time
        for ch in chunks:
            for dp in ch["datapoints"]:
                sid = int(dp["sensor_id"])
                if 0 <= sid < NUM_PTS:
                    self.sensor_data[sid].append((t0, float(dp["data"])))

    def update_plots(self):
        t = time.time() - self.stats_start_time
        win = self.window_seconds
        for i in range(NUM_PTS):
            d = self.sensor_data[i]
            # Update pressure display (converted from voltage)
            if d:
                pressure = calculate_pressure(d[-1][1], *PT_CALIBRATION[i])
                self.pt_voltage_labels[i].setText(f"{pressure:.4f} {PRESSURE_UNIT}")
            else:
                self.pt_voltage_labels[i].setText(f"-- {PRESSURE_UNIT}")
            # Show/hide plot based on toggle
            self.sensor_plots[i].setVisible(self.plot_enabled[i])
            if not self.plot_enabled[i] or not d:
                continue
            times, vals = [], []
            for ti, v in d:
                if t - ti <= win:
                    times.append(ti)
                    vals.append(v)
            if times:
                self.sensor_plots[i].setData(np.array(times), np.array(vals))
        if t > win:
            self.plot_item.setXRange(t - win, t, padding=0)
        else:
            self.plot_item.setXRange(0, win, padding=0)

    def update_statistics(self):
        if self.receiver is None:
            return
        s = self.receiver.get_stats()
        self.packets_label.setText(f"Packets: {s['packets']}")
        self.pps_label.setText(f"Packets/sec: {s['packets_per_sec']:.2f}")
        b = s["bytes"]
        self.bytes_label.setText(f"Bytes: {b/1024:.2f} KB" if b >= 1024 else f"Bytes: {b} B")
        bp = s["bytes_per_sec"]
        self.bps_label.setText(f"Bytes/sec: {bp/1024:.2f} KB/s" if bp >= 1024 else f"Bytes/sec: {bp:.2f} B/s")

    def save_csv(self):
        """Save all PT timestamp and voltage data to a CSV file."""
        filepath, _ = QtWidgets.QFileDialog.getSaveFileName(
            self, "Save CSV", "", "CSV Files (*.csv);;All Files (*)"
        )
        if not filepath:
            return
        if not filepath.endswith(".csv"):
            filepath += ".csv"
        try:
            with open(filepath, "w", newline="") as f:
                writer = csv.writer(f)
                # Header: timestamp, PT1_voltage, PT2_voltage, ... PT10_voltage
                header = ["timestamp"] + [f"PT{i+1}_voltage" for i in range(NUM_PTS)]
                writer.writerow(header)
                # Collect all unique timestamps across all PTs
                all_times = set()
                for i in range(NUM_PTS):
                    for ti, _ in self.sensor_data[i]:
                        all_times.add(ti)
                # For each timestamp, write the voltage for each PT (or empty if no data)
                for ti in sorted(all_times):
                    row = [f"{ti:.6f}"]
                    for i in range(NUM_PTS):
                        # Find the voltage at this timestamp for this PT
                        val = ""
                        for t, v in self.sensor_data[i]:
                            if t == ti:
                                val = f"{v:.6f}"
                                break
                        row.append(val)
                    writer.writerow(row)
            self.status_label.setText(f"Saved CSV to {filepath}")
        except Exception as e:
            self.status_label.setText(f"CSV save error: {e}")

    def show_settings(self):
        d = QtWidgets.QDialog(self)
        d.setWindowTitle("Settings")
        lo = QtWidgets.QVBoxLayout(d)
        lo.addWidget(QtWidgets.QLabel("Time window (s)"))
        row = QtWidgets.QHBoxLayout()
        sld = QtWidgets.QSlider(_QT_HORIZ)
        sld.setMinimum(5)
        sld.setMaximum(120)
        sld.setValue(int(self.window_seconds))
        lbl = QtWidgets.QLabel(f"{self.window_seconds:.0f}")

        def onv(v):
            self.window_seconds = float(v)
            lbl.setText(f"{v}")

        sld.valueChanged.connect(onv)
        row.addWidget(sld, 1)
        row.addWidget(lbl)
        lo.addLayout(row)
        cb = QtWidgets.QPushButton("Close")
        cb.clicked.connect(d.accept)
        lo.addWidget(cb)
        d.exec()

    def closeEvent(self, e):
        if self.receiver:
            self.receiver.stop()
            self.receiver.wait(2000)
        e.accept()


def main():
    import argparse
    p = argparse.ArgumentParser(description="PT Board Multi – live PT plots from DAQv2-Comms UDP")
    p.add_argument("-p", "--port", type=int, default=DEFAULT_PORT, help=f"UDP port (default {DEFAULT_PORT})")
    p.add_argument("-a", "--address", default="0.0.0.0", help="Bind address")
    a = p.parse_args()
    app = QtWidgets.QApplication(sys.argv)
    w = PTPlotWindow(port=a.port, bind_address=a.address)
    w.show()
    sys.exit(app.exec_() if hasattr(app, 'exec_') else app.exec())


if __name__ == "__main__":
    main()
