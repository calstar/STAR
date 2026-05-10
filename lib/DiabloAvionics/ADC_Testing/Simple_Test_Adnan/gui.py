#!/usr/bin/env python3
"""
Simple ADC Plotter GUI
- Reads 1000-byte packets from serial (83 samples × 3 channels)
- Plots voltage values for connectors 1, 2, 3
- Requirements: pip install pyqt6 pyqtgraph pyserial numpy
"""

import sys
import struct
import time
import csv
from collections import deque
from datetime import datetime

from PyQt6 import QtCore, QtGui, QtWidgets
import pyqtgraph as pg
import numpy as np
import serial
import serial.tools.list_ports

pg.setConfigOptions(antialias=False)

# ---------------------- Protocol constants ----------------------
MAGIC = b"AD26"
BUFFER_SIZE = 1996  # 4 magic + 83 samples × 3 channels × (4 bytes timestamp + 4 bytes reading)
MAGIC_SIZE = 4
SAMPLES_PER_BUFFER = 83
NUM_CHANNELS = 3
DATA_SIZE = SAMPLES_PER_BUFFER * NUM_CHANNELS * 8  # 1992 bytes (timestamp + reading per channel)

# ADC conversion constants
V_REF = 2.5
ADC_SCALE = 2147483648.0  # 2^31

BAUD = 115200
DEFAULT_WINDOW_SECONDS = 10.0
MAX_POINTS = 10000

# Colors for the 3 channels
CHANNEL_COLORS = [
    (255, 80, 80),    # Red - Connector 1
    (80, 255, 80),    # Green - Connector 2
    (80, 150, 255),   # Blue - Connector 3
]

CHANNEL_NAMES = ["Conn 1", "Conn 2", "Conn 3"]


def list_ports():
    return [p.device for p in serial.tools.list_ports.comports()]


# ---------------------- Serial reader thread ----------------------
class Reader(QtCore.QThread):
    samples_ready = QtCore.pyqtSignal(list)  # Emits list of (ch, timestamp_us, volts) tuples for a packet
    status = QtCore.pyqtSignal(str)
    raw_bytes = QtCore.pyqtSignal(bytes)

    def __init__(self, port: str, baud: int):
        super().__init__()
        self.port = port
        self.baud = baud
        self._stop = False
        self.buf = bytearray()
        self.ser = None
        self.packets_received = 0
        self.total_samples = 0

    def stop(self):
        self._stop = True
        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass

    def _find_and_parse_packets(self):
        """Find magic bytes and parse complete packets"""
        parsed_samples = []
        
        while True:
            # Find magic header
            idx = self.buf.find(MAGIC)
            if idx == -1:
                # Keep last 3 bytes in case magic is split across reads
                if len(self.buf) > 3:
                    del self.buf[:-3]
                break
            
            # Discard bytes before magic
            if idx > 0:
                del self.buf[:idx]
            
            # Check if we have a complete packet
            if len(self.buf) < BUFFER_SIZE:
                break
            
            # Extract packet data (skip magic)
            data = bytes(self.buf[MAGIC_SIZE:BUFFER_SIZE])
            
            # Parse all samples from this packet
            # Each sample has 3 channels, each with: 4 bytes timestamp + 4 bytes reading
            for sample_idx in range(SAMPLES_PER_BUFFER):
                base = sample_idx * NUM_CHANNELS * 8  # 8 bytes per channel (timestamp + reading)
                for ch in range(NUM_CHANNELS):
                    offset = base + ch * 8
                    # Extract timestamp (uint32_t, microseconds)
                    timestamp_us = struct.unpack_from("<I", data, offset)[0]
                    # Extract reading (int32_t)
                    raw = struct.unpack_from("<i", data, offset + 4)[0]
                    volts = raw * V_REF / ADC_SCALE
                    parsed_samples.append((ch, timestamp_us, volts))
            
            self.packets_received += 1
            self.total_samples += len(parsed_samples)
            
            # Remove processed packet
            del self.buf[:BUFFER_SIZE]
        
        return parsed_samples

    def run(self):
        try:
            self.ser = serial.Serial(self.port, self.baud, timeout=0.05)
            self.status.emit(f"Connected {self.port} @ {self.baud}")
        except Exception as e:
            self.status.emit(f"Open failed: {e}")
            return

        last_status_time = time.monotonic()
        
        while not self._stop:
            try:
                data = self.ser.read(self.ser.in_waiting or 1)
                if data:
                    self.raw_bytes.emit(data)
                    self.buf.extend(data)
                    
                    parsed = self._find_and_parse_packets()
                    if parsed:
                        self.samples_ready.emit(parsed)
                    
                    # Periodic status update
                    now = time.monotonic()
                    if now - last_status_time >= 0.5:
                        self.status.emit(f"Reader: {self.packets_received} pkts, {self.total_samples} samples, buf={len(self.buf)}B")
                        last_status_time = now
                        
            except serial.SerialException as e:
                self.status.emit(f"Serial error: {e}")
                break
            except Exception as e:
                self.status.emit(f"Unexpected: {e}")
                break

        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass
        self.status.emit("Disconnected")


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
        self.slider = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.slider.setMinimum(1)
        self.slider.setMaximum(60)
        self.slider.setValue(int(self.parent_app.window_seconds))
        self.slider.valueChanged.connect(self._on_change)
        self.lbl = QtWidgets.QLabel(f"{self.parent_app.window_seconds:.1f}s")
        row.addWidget(self.slider, 1)
        row.addWidget(self.lbl)
        layout.addLayout(row)

        # Max voltage
        layout.addWidget(QtWidgets.QLabel("Max voltage (V)"))
        row2 = QtWidgets.QHBoxLayout()
        self.slider_maxv = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.slider_maxv.setMinimum(5)
        self.slider_maxv.setMaximum(100)
        self.slider_maxv.setValue(int(self.parent_app.max_v * 10))
        self.slider_maxv.valueChanged.connect(self._on_change_maxv)
        self.lbl_maxv = QtWidgets.QLabel(f"{self.parent_app.max_v:.1f} V")
        row2.addWidget(self.slider_maxv, 1)
        row2.addWidget(self.lbl_maxv)
        layout.addLayout(row2)

        btn = QtWidgets.QPushButton("Close")
        btn.clicked.connect(self.accept)
        layout.addWidget(btn)

    def _on_change(self, val):
        self.parent_app.window_seconds = float(val)
        self.lbl.setText(f"{float(val):.1f}s")

    def _on_change_maxv(self, val):
        self.parent_app.max_v = float(val) / 10.0
        self.lbl_maxv.setText(f"{self.parent_app.max_v:.1f} V")


# ---------------------- Raw console window ----------------------
class ConsoleWindow(QtWidgets.QDialog):
    def __init__(self, parent):
        super().__init__(parent)
        self.setWindowTitle("Raw Serial Console")
        self.resize(800, 400)

        top = QtWidgets.QHBoxLayout()
        self.chk_pause = QtWidgets.QCheckBox("Pause")
        self.chk_hex = QtWidgets.QCheckBox("Hex View")
        btn_clear = QtWidgets.QPushButton("Clear")
        btn_clear.clicked.connect(self._clear)
        top.addWidget(self.chk_pause)
        top.addWidget(self.chk_hex)
        top.addWidget(btn_clear)
        top.addStretch(1)

        self.text = QtWidgets.QPlainTextEdit()
        self.text.setReadOnly(True)
        font = QtGui.QFontDatabase.systemFont(QtGui.QFontDatabase.SystemFont.FixedFont)
        font.setPointSize(10)
        self.text.setFont(font)

        layout = QtWidgets.QVBoxLayout(self)
        layout.addLayout(top)
        layout.addWidget(self.text)

    def _clear(self):
        self.text.clear()

    @QtCore.pyqtSlot(bytes)
    def on_bytes(self, data: bytes):
        if self.chk_pause.isChecked():
            return
        try:
            if self.chk_hex.isChecked():
                s = data.hex(' ')
            else:
                s = data.decode("utf-8", errors="replace")
            self.text.appendPlainText(s)
        except Exception:
            pass


# ---------------------- Main application window ----------------------
class App(QtWidgets.QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("ADC Plotter - Simple Test")
        self.resize(1280, 740)

        self.window_seconds = DEFAULT_WINDOW_SECONDS
        self.console_win = None
        self.autoscale = True
        self.max_v = 2.5

        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        root = QtWidgets.QVBoxLayout(central)

        # Top bar
        top = QtWidgets.QHBoxLayout()
        top.addWidget(QtWidgets.QLabel("Port"))
        self.cmb_port = QtWidgets.QComboBox()
        self._refresh_port_list()
        top.addWidget(self.cmb_port)

        top.addWidget(QtWidgets.QLabel("Baud"))
        self.cmb_baud = QtWidgets.QComboBox()
        self.cmb_baud.addItems([str(b) for b in [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]])
        self.cmb_baud.setCurrentText(str(BAUD))
        top.addWidget(self.cmb_baud)

        btn_refresh = QtWidgets.QPushButton("Refresh")
        btn_refresh.clicked.connect(self._refresh_port_list)
        top.addWidget(btn_refresh)
        
        self.btn_connect = QtWidgets.QPushButton("Connect")
        self.btn_connect.clicked.connect(self._toggle_connect)
        top.addWidget(self.btn_connect)

        btn_settings = QtWidgets.QPushButton("Settings")
        btn_settings.clicked.connect(self._open_settings)
        top.addWidget(btn_settings)
        
        btn_console = QtWidgets.QPushButton("Console")
        btn_console.clicked.connect(self._open_console)
        top.addWidget(btn_console)

        btn_export = QtWidgets.QPushButton("Download as CSV")
        btn_export.clicked.connect(self._export_csv)
        top.addWidget(btn_export)

        self.chk_autoscale = QtWidgets.QCheckBox("Autoscale Y")
        self.chk_autoscale.setChecked(True)
        self.chk_autoscale.stateChanged.connect(self._on_autoscale)
        top.addWidget(self.chk_autoscale)

        top.addStretch(1)
        root.addLayout(top)

        # Main split: plot on left, controls on right
        main = QtWidgets.QHBoxLayout()
        root.addLayout(main, 1)

        # Plot
        self.plot = pg.PlotWidget()
        self.plot.setLabel("bottom", "Time", units="s")
        self.plot.setLabel("left", "Voltage", units="V")
        self.plot.showGrid(x=True, y=True, alpha=0.3)
        self.plot.setTitle("ADC Readings - Connectors 1, 2, 3")
        self.plot.setClipToView(True)
        self.plot.setDownsampling(mode='peak')
        self.plot.setMouseEnabled(x=True, y=True)
        self.legend = self.plot.addLegend(labelTextSize="10pt")
        main.addWidget(self.plot, 1)

        # Right panel
        right = QtWidgets.QVBoxLayout()
        main.addLayout(right)

        # Channel toggles
        right.addWidget(QtWidgets.QLabel("Show channels:"))
        self.chk = {}
        self.curves = {}
        for ch in range(NUM_CHANNELS):
            cb = QtWidgets.QCheckBox(CHANNEL_NAMES[ch])
            cb.setChecked(True)
            cb.stateChanged.connect(self._on_toggle)
            right.addWidget(cb)
            self.chk[ch] = cb
            color = CHANNEL_COLORS[ch]
            pen = pg.mkPen(color=color, width=2)
            self.curves[ch] = self.plot.plot([], [], name=CHANNEL_NAMES[ch], pen=pen)

        # Statistics box
        box = QtWidgets.QGroupBox("Statistics")
        form = QtWidgets.QVBoxLayout(box)
        
        self.lbl_sps = QtWidgets.QLabel("SPS: n/a")
        form.addWidget(self.lbl_sps)
        
        form.addWidget(self._hline())
        form.addWidget(QtWidgets.QLabel("Mean voltage (last 100 ms):"))
        
        self.per_ch = {}
        for ch in range(NUM_CHANNELS):
            lbl = QtWidgets.QLabel(f"{CHANNEL_NAMES[ch]}: n/a")
            form.addWidget(lbl)
            self.per_ch[ch] = lbl
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
        self.t0_us = None  # First timestamp in microseconds (from Arduino)
        self.test_start_time = None  # When the test/connection started (for filename)
        self.sample_count = 0
        self.packets_received = 0
        self.t = {ch: deque(maxlen=MAX_POINTS) for ch in range(NUM_CHANNELS)}
        self.v = {ch: deque(maxlen=MAX_POINTS) for ch in range(NUM_CHANNELS)}
        
        # For SPS calculation
        self.last_sps_time = None
        self.last_sps_count = 0

        # Timer for plot updates - only update when needed
        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self._update_plot)
        self.timer.start(100)  # Reduced frequency from 50ms to 100ms
        self._plot_needs_update = False  # Flag to skip updates when no data

        # Serial reader holder
        self.reader = None

    def _hline(self):
        line = QtWidgets.QFrame()
        line.setFrameShape(QtWidgets.QFrame.Shape.HLine)
        line.setFrameShadow(QtWidgets.QFrame.Shadow.Sunken)
        return line

    def _refresh_port_list(self):
        ports = list_ports()
        self.cmb_port.clear()
        self.cmb_port.addItems(ports)
        if ports:
            self.cmb_port.setCurrentIndex(0)

    def set_status(self, text):
        self.lbl_status.setText(text)

    def _toggle_connect(self):
        if self.reader is None:
            port = self.cmb_port.currentText().strip()
            try:
                baud = int(self.cmb_baud.currentText())
            except Exception:
                self.set_status("Bad baud")
                return
            self._connect(port, baud)
            self.btn_connect.setText("Disconnect")
        else:
            self.reader.stop()
            self.reader = None
            self.set_status("Disconnected")
            self.btn_connect.setText("Connect")

    def _connect(self, port, baud):
        self.t0_us = None
        self.test_start_time = datetime.now()  # Record when test started
        self.sample_count = 0
        self.packets_received = 0
        self.last_sps_time = None
        self.last_sps_count = 0
        for ch in range(NUM_CHANNELS):
            self.t[ch].clear()
            self.v[ch].clear()

        self.reader = Reader(port, baud)
        self.reader.samples_ready.connect(self._on_samples, QtCore.Qt.ConnectionType.QueuedConnection)
        self.reader.status.connect(self.set_status, QtCore.Qt.ConnectionType.QueuedConnection)
        self.reader.raw_bytes.connect(self._on_raw_bytes, QtCore.Qt.ConnectionType.QueuedConnection)
        self.reader.start()

    @QtCore.pyqtSlot(list)
    def _on_samples(self, samples):
        """Handle batch of samples from a packet"""
        if not samples:
            return
        
        self.packets_received += 1
        
        # Initialize timing on first sample
        if self.t0_us is None and samples:
            # Use the first timestamp as reference
            _, first_timestamp_us, _ = samples[0]
            self.t0_us = first_timestamp_us
            self.last_sps_time = time.monotonic()
            self.last_sps_count = 0
        
        # Process each sample with its actual timestamp
        for ch, timestamp_us, volts in samples:
            # Convert microseconds to seconds relative to first timestamp
            t_rel = (timestamp_us - self.t0_us) / 1_000_000.0
            
            self.t[ch].append(t_rel)
            self.v[ch].append(volts)
            self.sample_count += 1
        
        # Mark that plot needs update
        self._plot_needs_update = True

    @QtCore.pyqtSlot(bytes)
    def _on_raw_bytes(self, data: bytes):
        if self.console_win is not None:
            self.console_win.on_bytes(data)

    def _on_toggle(self):
        # Trigger plot update when channel visibility changes
        self._plot_needs_update = True

    def _update_plot(self):
        # Early exit if no data and no update needed
        has_data = any(len(self.t.get(ch, [])) > 0 for ch in range(NUM_CHANNELS))
        if not has_data and not self._plot_needs_update:
            return
        
        self._plot_needs_update = False
        
        # Update curves - only convert to list if we have data
        for ch, cb in self.chk.items():
            if cb.isChecked():
                t_data = self.t.get(ch, [])
                v_data = self.v.get(ch, [])
                if t_data and v_data:
                    # Only convert to list if we have data
                    self.curves[ch].setData(list(t_data), list(v_data))
                else:
                    self.curves[ch].setData([], [])
            else:
                self.curves[ch].setData([], [])

        # Calculate latest time across all channels
        latest = 0.0
        for ch in range(NUM_CHANNELS):
            if self.chk[ch].isChecked() and self.t.get(ch):
                latest = max(latest, self.t[ch][-1])
        
        if has_data:
            xmin = max(0.0, latest - self.window_seconds)
            self.plot.setXRange(xmin, max(xmin + 1e-3, latest), padding=0)

            # Y limits - only calculate if we have data
            if self.autoscale:
                values = []
                for ch in range(NUM_CHANNELS):
                    if self.chk[ch].isChecked():
                        v_data = self.v.get(ch, [])
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
            else:
                self.plot.setYRange(0.0, float(self.max_v) + 0.1, padding=0)

        # SPS calculation
        now = time.monotonic()
        if self.last_sps_time is not None:
            elapsed = now - self.last_sps_time
            if elapsed >= 1.0:
                samples_delta = self.sample_count - self.last_sps_count
                sps = samples_delta / elapsed
                # Show more info including data points per channel
                pts = [len(self.t[ch]) for ch in range(NUM_CHANNELS)]
                self.lbl_sps.setText(f"SPS: {sps:.1f} | Pkts: {self.packets_received} | Pts: {pts}")
                self.last_sps_time = now
                self.last_sps_count = self.sample_count

        # Per-channel mean voltage (last 100ms) - only if we have data
        if has_data:
            for ch in range(NUM_CHANNELS):
                if not self.chk[ch].isChecked():
                    self.per_ch[ch].setText(f"{CHANNEL_NAMES[ch]}: n/a")
                    continue
                
                ts = self.t.get(ch, [])
                vs = self.v.get(ch, [])
                if ts and vs:
                    cutoff = latest - 0.1  # Last 100ms
                    # More efficient: iterate backwards since we want recent data
                    recent = []
                    for i in range(len(ts) - 1, -1, -1):
                        if ts[i] >= cutoff:
                            recent.append(vs[i])
                        else:
                            break
                    if recent:
                        mean_v = sum(recent) / len(recent)
                        self.per_ch[ch].setText(f"{CHANNEL_NAMES[ch]}: {mean_v:.4f} V")
                    else:
                        self.per_ch[ch].setText(f"{CHANNEL_NAMES[ch]}: n/a")
                else:
                    self.per_ch[ch].setText(f"{CHANNEL_NAMES[ch]}: n/a")
        else:
            # No data - just set n/a for all
            for ch in range(NUM_CHANNELS):
                self.per_ch[ch].setText(f"{CHANNEL_NAMES[ch]}: n/a")

    def _open_settings(self):
        dlg = SettingsWindow(self)
        dlg.exec()

    def _open_console(self):
        if self.console_win is None or not self.console_win.isVisible():
            self.console_win = ConsoleWindow(self)
        self.console_win.show()
        self.console_win.raise_()
        self.console_win.activateWindow()

    def _on_autoscale(self):
        self.autoscale = self.chk_autoscale.isChecked()
        self._plot_needs_update = True
        self._update_plot()

    def _export_csv(self):
        """Export current data to CSV file"""
        # Check if we have any data
        total_points = sum(len(self.t[ch]) for ch in range(NUM_CHANNELS))
        if total_points == 0:
            QtWidgets.QMessageBox.warning(self, "No Data", "No data available to export.")
            return
        
        # Generate default filename with test start time, or current time if test hasn't started
        if self.test_start_time:
            timestamp = self.test_start_time.strftime("%Y%m%d_%H%M%S")
        else:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        default_filename = f"adc_data_{timestamp}.csv"
        
        # Open file dialog
        filename, _ = QtWidgets.QFileDialog.getSaveFileName(
            self,
            "Save CSV File",
            default_filename,
            "CSV Files (*.csv);;All Files (*)"
        )
        
        if not filename:
            return  # User cancelled
        
        try:
            with open(filename, 'w', newline='', encoding='utf-8') as csvfile:
                writer = csv.writer(csvfile)
                
                # Write header with single time column and all channels
                header = ["Time (s)"]
                for ch in range(NUM_CHANNELS):
                    header.append(f"{CHANNEL_NAMES[ch]} (V)")
                writer.writerow(header)
                
                # Use first channel's timestamps as the reference time
                # All channels should have the same number of samples since they're sampled together
                time_ref = list(self.t[0]) if len(self.t[0]) > 0 else []
                max_points = max(len(self.t[ch]) for ch in range(NUM_CHANNELS))
                
                # Write data row by row with single time column
                for i in range(max_points):
                    row = []
                    
                    # Use first channel's time, or empty if not available
                    if i < len(time_ref):
                        row.append(f"{time_ref[i]:.6f}")
                    else:
                        row.append("")
                    
                    # Add voltage for each channel
                    for ch in range(NUM_CHANNELS):
                        if i < len(self.v[ch]):
                            row.append(f"{self.v[ch][i]:.6f}")
                        else:
                            row.append("")
                    
                    writer.writerow(row)
            
            # Count actual data points
            points_per_channel = [len(self.t[ch]) for ch in range(NUM_CHANNELS)]
            QtWidgets.QMessageBox.information(
                self,
                "Export Successful",
                f"Data exported successfully to:\n{filename}\n\n"
                f"Points per channel: {points_per_channel}"
            )
        except Exception as e:
            QtWidgets.QMessageBox.critical(
                self,
                "Export Failed",
                f"Failed to export data:\n{str(e)}"
            )

    def closeEvent(self, event: QtGui.QCloseEvent):
        try:
            if self.reader is not None:
                self.reader.stop()
                self.reader.wait(500)
        except Exception:
            pass
        super().closeEvent(event)


# ---------------------- Entry point ----------------------
def main():
    app = QtWidgets.QApplication(sys.argv)
    pg.setConfigOptions(antialias=False)
    w = App()
    w.show()
    try:
        sys.exit(app.exec())
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
