#!/usr/bin/env python3
"""
LC Calibration GUI – Live plots for LC_Calibration

Receives DAQv2-Comms SENSOR_DATA packets over UDP from LC_Calibration firmware,
decodes them, and displays real-time voltage plots for each LC connector (1, 2, 3, 6, 7).

Ensure the firmware's receiverIP matches this machine's IP (or use 192.168.2.20)
and that the GUI listens on port 5006.

  pip install -r requirements.txt
  python lc_calibration_gui.py [-p 5006] [-a 0.0.0.0]

  On macOS, if you get a segfault: use PyQt5 instead of PyQt6
  (pip install PyQt5; this script will try PyQt5 if PyQt6 is unavailable).
"""

import os
import socket
import struct
import sys
import time
from typing import Optional, Tuple, List, Dict
from collections import deque
from datetime import datetime

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
import csv

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

DEFAULT_PORT = 5006
DEFAULT_WINDOW_SECONDS = 30.0
MAX_POINTS = 10000
UPDATE_INTERVAL_MS = 100
NUM_LC_CONNECTORS = 10
NUM_LC_SENSORS = 5  # Connectors 1, 2, 3, 6, 7
# Map sensor index (0-4) to connector number (1, 2, 3, 6, 7)
SENSOR_TO_CONNECTOR = [1, 2, 3, 6, 7]

# Colors for the 10 LC connectors
LC_COLORS = [
    (255, 80, 80),    # Red - LC 1
    (80, 255, 80),    # Green - LC 2
    (80, 150, 255),   # Blue - LC 3
    (255, 200, 80),   # Orange - LC 4
    (200, 80, 255),   # Purple - LC 5
    (80, 255, 255),   # Cyan - LC 6
    (255, 150, 150),  # Light Red - LC 7
    (150, 255, 150),  # Light Green - LC 8
    (150, 200, 255),  # Light Blue - LC 9
    (255, 255, 80),   # Yellow - LC 10
]


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
        self.slider = QtWidgets.QSlider(_QT_HORIZ)
        self.slider.setMinimum(5)
        self.slider.setMaximum(120)
        self.slider.setValue(int(self.parent_app.window_seconds))
        self.slider.valueChanged.connect(self._on_change)
        self.lbl = QtWidgets.QLabel(f"{self.parent_app.window_seconds:.1f}s")
        row.addWidget(self.slider, 1)
        row.addWidget(self.lbl)
        layout.addLayout(row)

        btn = QtWidgets.QPushButton("Close")
        btn.clicked.connect(self.accept)
        layout.addWidget(btn)

    def _on_change(self, val):
        self.parent_app.window_seconds = float(val)
        self.lbl.setText(f"{float(val):.1f}s")


# ---------------------- Main application window ----------------------
class LCPlotWindow(QtWidgets.QMainWindow):
    def __init__(self, port: int = DEFAULT_PORT, bind_address: str = "0.0.0.0"):
        super().__init__()
        self.setWindowTitle("LC Calibration - Live Plots")
        self.resize(1400, 800)

        self.port = port
        self.bind_address = bind_address
        self.window_seconds = DEFAULT_WINDOW_SECONDS
        self.test_start_time = None
        self.sample_count = 0
        self.stats_start_time = time.time()

        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        root = QtWidgets.QVBoxLayout(central)

        # Top bar
        top = QtWidgets.QHBoxLayout()
        self.status_label = QtWidgets.QLabel("Starting...")
        self.status_label.setStyleSheet("font-weight: bold; padding: 5px;")
        top.addWidget(self.status_label)
        top.addStretch()
        
        btn_settings = QtWidgets.QPushButton("Settings")
        btn_settings.clicked.connect(self._open_settings)
        top.addWidget(btn_settings)

        btn_export = QtWidgets.QPushButton("Export CSV")
        btn_export.clicked.connect(self._export_csv)
        top.addWidget(btn_export)

        self.chk_autoscale = QtWidgets.QCheckBox("Autoscale Y")
        self.chk_autoscale.setChecked(True)
        self.chk_autoscale.stateChanged.connect(self._on_autoscale)
        top.addWidget(self.chk_autoscale)

        root.addLayout(top)

        # Main split: plot on left, controls on right
        main = QtWidgets.QHBoxLayout()
        root.addLayout(main, 1)

        # Plot
        self.plot = pg.PlotWidget()
        self.plot.setLabel("bottom", "Time", units="s")
        self.plot.setLabel("left", "Voltage", units="V")
        self.plot.showGrid(x=True, y=True, alpha=0.3)
        self.plot.setTitle("LC Calibration - All Connectors")
        self.plot.setClipToView(True)
        self.plot.setDownsampling(mode='peak')
        self.plot.setMouseEnabled(x=True, y=True)
        self.legend = self.plot.addLegend(labelTextSize="10pt")
        main.addWidget(self.plot, 1)

        # Right panel
        right = QtWidgets.QVBoxLayout()
        main.addLayout(right)

        # Channel toggles
        right.addWidget(QtWidgets.QLabel("Show connectors:"))
        self.chk = {}
        self.curves = {}
        for conn in range(1, NUM_LC_CONNECTORS + 1):
            cb = QtWidgets.QCheckBox(f"LC {conn}")
            # Only enable connectors that we're actually reading (1, 2, 3, 6, 7)
            cb.setChecked(conn in SENSOR_TO_CONNECTOR)
            cb.setEnabled(conn in SENSOR_TO_CONNECTOR)
            cb.stateChanged.connect(self._on_toggle)
            right.addWidget(cb)
            self.chk[conn] = cb
            color = LC_COLORS[conn - 1]
            pen = pg.mkPen(color=color, width=2)
            self.curves[conn] = self.plot.plot([], [], name=f"LC {conn}", pen=pen)

        # Statistics box
        box = QtWidgets.QGroupBox("Statistics")
        form = QtWidgets.QVBoxLayout(box)
        
        self.lbl_sps = QtWidgets.QLabel("Packets/sec: n/a")
        form.addWidget(self.lbl_sps)
        
        form.addWidget(self._hline())
        form.addWidget(QtWidgets.QLabel("Current voltage:"))
        
        self.per_lc = {}
        for conn in SENSOR_TO_CONNECTOR:  # Only show connectors we're reading
            lbl = QtWidgets.QLabel(f"LC {conn}: n/a")
            form.addWidget(lbl)
            self.per_lc[conn] = lbl
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
        self.t0 = None  # First timestamp (wall clock time)
        self.t = {conn: deque(maxlen=MAX_POINTS) for conn in SENSOR_TO_CONNECTOR}
        self.v = {conn: deque(maxlen=MAX_POINTS) for conn in SENSOR_TO_CONNECTOR}
        
        # For SPS calculation
        self.last_sps_time = None
        self.last_sps_count = 0
        self.autoscale = True

        # Timer for plot updates
        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self._update_plot)
        self.timer.start(UPDATE_INTERVAL_MS)
        self._plot_needs_update = False

        # UDP receiver
        self.receiver = None
        self.start_receiver()

        # Statistics timer
        self.stats_timer = QtCore.QTimer(self)
        self.stats_timer.timeout.connect(self.update_statistics)
        self.stats_timer.start(500)

    def _hline(self):
        line = QtWidgets.QFrame()
        line.setFrameShape(QtWidgets.QFrame.Shape.HLine)
        line.setFrameShadow(QtWidgets.QFrame.Shadow.Sunken)
        return line

    def start_receiver(self):
        self.receiver = UDPReceiver(port=self.port, bind_address=self.bind_address)
        self.receiver.sensor_data_received.connect(self.on_sensor_data)
        self.receiver.status_update.connect(self.status_label.setText)
        self.receiver.start()

    def on_sensor_data(self, header: dict, chunks: List[dict]):
        t0 = time.time() - self.stats_start_time
        for ch in chunks:
            for dp in ch["datapoints"]:
                sensor_id = int(dp["sensor_id"])
                if 0 <= sensor_id < len(SENSOR_TO_CONNECTOR):
                    connector = SENSOR_TO_CONNECTOR[sensor_id]
                    voltage = float(dp["data"])
                    if connector in self.t:
                        self.t[connector].append(t0)
                        self.v[connector].append(voltage)
                        self.sample_count += 1
                        self._plot_needs_update = True

    def _on_toggle(self):
        self._plot_needs_update = True

    def _update_plot(self):
        has_data = any(len(self.t.get(conn, [])) > 0 for conn in SENSOR_TO_CONNECTOR)
        if not has_data and not self._plot_needs_update:
            return
        
        self._plot_needs_update = False
        
        # Update curves
        for conn in SENSOR_TO_CONNECTOR:
            cb = self.chk.get(conn)
            if cb and cb.isChecked():
                t_data = self.t.get(conn, [])
                v_data = self.v.get(conn, [])
                if t_data and v_data:
                    self.curves[conn].setData(list(t_data), list(v_data))
                else:
                    self.curves[conn].setData([], [])
            else:
                self.curves[conn].setData([], [])

        # Calculate latest time
        latest = 0.0
        for conn in SENSOR_TO_CONNECTOR:
            if self.chk[conn].isChecked() and self.t.get(conn):
                latest = max(latest, self.t[conn][-1] if self.t[conn] else 0.0)
        
        if has_data and latest > 0:
            xmin = max(0.0, latest - self.window_seconds)
            self.plot.setXRange(xmin, max(xmin + 1e-3, latest), padding=0)

            # Y limits
            if self.autoscale:
                values = []
                for conn in SENSOR_TO_CONNECTOR:
                    if self.chk[conn].isChecked():
                        v_data = self.v.get(conn, [])
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

        # Current voltage display
        if has_data:
            for conn in SENSOR_TO_CONNECTOR:
                v_data = self.v.get(conn, [])
                if v_data:
                    current_v = v_data[-1]
                    self.per_lc[conn].setText(f"LC {conn}: {current_v:.6f} V")
                else:
                    self.per_lc[conn].setText(f"LC {conn}: n/a")
        else:
            for conn in SENSOR_TO_CONNECTOR:
                self.per_lc[conn].setText(f"LC {conn}: n/a")

    def update_statistics(self):
        if self.receiver is None:
            return
        s = self.receiver.get_stats()
        self.lbl_sps.setText(f"Packets/sec: {s['packets_per_sec']:.2f} | Total: {s['packets']}")

    def _open_settings(self):
        dlg = SettingsWindow(self)
        dlg.exec()

    def _on_autoscale(self):
        self.autoscale = self.chk_autoscale.isChecked()
        self._plot_needs_update = True
        self._update_plot()

    def _export_csv(self):
        """Export current data to CSV file"""
        total_points = sum(len(self.t[conn]) for conn in SENSOR_TO_CONNECTOR)
        if total_points == 0:
            QtWidgets.QMessageBox.warning(self, "No Data", "No data available to export.")
            return
        
        if self.test_start_time:
            timestamp = self.test_start_time.strftime("%Y%m%d_%H%M%S")
        else:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        default_filename = f"lc_calibration_{timestamp}.csv"
        
        filename, _ = QtWidgets.QFileDialog.getSaveFileName(
            self,
            "Save CSV File",
            default_filename,
            "CSV Files (*.csv);;All Files (*)"
        )
        
        if not filename:
            return
        
        try:
            with open(filename, 'w', newline='', encoding='utf-8') as csvfile:
                writer = csv.writer(csvfile)
                
                # Write header
                header = ["Time (s)"]
                for conn in SENSOR_TO_CONNECTOR:
                    header.append(f"LC {conn} (V)")
                writer.writerow(header)
                
                # Find max points across all connectors
                max_points = max(len(self.t[conn]) for conn in SENSOR_TO_CONNECTOR)
                
                # Write data
                for i in range(max_points):
                    row = []
                    
                    # Use first connector's time as reference
                    if i < len(self.t[SENSOR_TO_CONNECTOR[0]]):
                        row.append(f"{self.t[SENSOR_TO_CONNECTOR[0]][i]:.6f}")
                    else:
                        row.append("")
                    
                    # Add voltage for each connector
                    for conn in SENSOR_TO_CONNECTOR:
                        if i < len(self.v[conn]):
                            row.append(f"{self.v[conn][i]:.6f}")
                        else:
                            row.append("")
                    
                    writer.writerow(row)
            
            points_per_connector = [len(self.t[conn]) for conn in SENSOR_TO_CONNECTOR]
            QtWidgets.QMessageBox.information(
                self,
                "Export Successful",
                f"Data exported successfully to:\n{filename}\n\n"
                f"Points per connector: {points_per_connector}"
            )
        except Exception as e:
            QtWidgets.QMessageBox.critical(
                self,
                "Export Failed",
                f"Failed to export data:\n{str(e)}"
            )

    def closeEvent(self, event: QtGui.QCloseEvent):
        if self.receiver:
            self.receiver.stop()
            self.receiver.wait(2000)
        event.accept()


# ---------------------- Entry point ----------------------
def main():
    import argparse
    parser = argparse.ArgumentParser(description="LC Calibration GUI – live LC plots from DAQv2-Comms UDP")
    parser.add_argument("-p", "--port", type=int, default=DEFAULT_PORT, help=f"UDP port (default {DEFAULT_PORT})")
    parser.add_argument("-a", "--address", default="0.0.0.0", help="Bind address")
    args = parser.parse_args()
    
    app = QtWidgets.QApplication(sys.argv)
    pg.setConfigOptions(antialias=False)
    w = LCPlotWindow(port=args.port, bind_address=args.address)
    w.show()
    try:
        sys.exit(app.exec() if hasattr(app, 'exec') else app.exec_())
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
