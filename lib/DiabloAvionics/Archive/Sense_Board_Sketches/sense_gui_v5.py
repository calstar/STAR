#!/usr/bin/env python3
# Channel Plotter GUI (Qt + PyQtGraph)
# - Serial port selector with connect/refresh
# - Plot channels with toggles
# - Simple Metrics: windowed means of conv_us and sps, per-channel mean V over last 100 ms
# - Settings window to adjust viewing window seconds
# - Raw Serial Console window
#
# Requirements:
#   pip install pyqt5 pyqtgraph pyserial
#
# This is a Qt port of the original Tkinter + Matplotlib app. The streaming
# protocol and computations are unchanged.

import sys
import struct
import time
from collections import deque, defaultdict

from PyQt6 import QtCore, QtGui, QtWidgets
import pyqtgraph as pg
import numpy as np
import serial, serial.tools.list_ports
pg.setConfigOptions(antialias=False)

# ---------------------- Protocol and constants ----------------------
MAGIC = b"AD26"
PACKET_VERSION = 2
HEADER_STRUCT = struct.Struct("<4sBBHHII")
RECORD_STRUCT = struct.Struct("<BBiiII")
CRC_SIZE_OPTIONAL = 4  # bytes, optional trailing CRC ignored by parser
HEADER_SIZE = HEADER_STRUCT.size
RECORD_SIZE = RECORD_STRUCT.size

PACKET_RECORDS = 10
FLAG_TIMING = 0x01
INT32_MIN = -2147483648
UINT32_MAX = 0xFFFFFFFF

V_REF = 2.5
ADC_SCALE = 2147483648.0

BAUD = 115200
DEFAULT_WINDOW_SECONDS = 10.0
MAX_POINTS = 2000
NUM_CHANNELS_MAX = 16
MAX_PACKET_BYTES = HEADER_SIZE + PACKET_RECORDS * RECORD_SIZE + CRC_SIZE_OPTIONAL
RAW_MIN, RAW_MAX = -2147483648, 2147483648
TOGGLE_CHANNELS = list(range(1, 11))

VOLT_MEAN_WINDOW_S = 0.100  # 100 ms
RAW_Q_MAX = 2000

# Predefined colors for channels
CHANNEL_COLORS = [
(255, 0, 0), # red
(0, 255, 0), # green
(0, 0, 255), # blue
(255, 165, 0), # orange
(128, 0, 128), # purple
(0, 255, 255), # cyan
(255, 192, 203), # pink
(128, 128, 0), # olive
(0, 128, 128), # teal
(255, 255, 0), # yellow
]

# ---------------------- Helpers ----------------------

def plausible(rec):
    t_us, ch, raw, volts, read_us, conv_us, sps, sent_us = rec
    if not (0 <= ch < NUM_CHANNELS_MAX):
        return False
    if not (RAW_MIN <= raw <= RAW_MAX):
        return False
    if not (-10.0 <= volts <= 10.0):
        return False
    if not (0 <= read_us <= 2_000_000):
        return False
    if not (0 <= conv_us <= 2_000_000):
        return False
    if not (0.0 <= sps <= 2_000_000.0):
        return False
    if not (0 <= sent_us <= 0xFFFFFFFF):
        return False
    return True


def list_ports():
    return [p.device for p in serial.tools.list_ports.comports()]

# ---------------------- Serial reader thread ----------------------

class Reader(QtCore.QThread):
    sample = QtCore.pyqtSignal(float, object)  # t_wall, rec tuple
    status = QtCore.pyqtSignal(str)
    raw_bytes = QtCore.pyqtSignal(bytes)

    def __init__(self, port: str, baud: int):
        super().__init__()
        self.port = port
        self.baud = baud
        self._stop = False
        self.buf = bytearray()
        self.synced = False
        self.ser = None
        self._last_failures = 0
        self._last_valid_count = None
        self._last_pad_count = None
        self._last_summary = None
        self._last_status_emit = 0.0

    def stop(self):
        self._stop = True
        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass

    def _resync(self):
        keep = len(MAGIC) - 1
        while True:
            idx = self.buf.find(MAGIC)
            if idx == -1:
                if keep > 0 and len(self.buf) > keep:
                    del self.buf[:-keep]
                return False
            if idx:
                del self.buf[:idx]
            if len(self.buf) < HEADER_SIZE:
                return False
            try:
                magic, version, flags, count, _failures, _total_time_us, _packet_time_us = HEADER_STRUCT.unpack_from(self.buf, 0)
            except struct.error:
                return False
            if magic != MAGIC or version != PACKET_VERSION or not (flags & FLAG_TIMING):
                del self.buf[0]
                continue
            count = int(count)
            if count > PACKET_RECORDS:
                del self.buf[0]
                continue
            payload_len = HEADER_SIZE + count * RECORD_SIZE
            if payload_len <= HEADER_SIZE or payload_len > MAX_PACKET_BYTES:
                del self.buf[0]
                continue
            if len(self.buf) < payload_len:
                return False
            if payload_len < len(self.buf) < payload_len + CRC_SIZE_OPTIONAL:
                return False
            crc_present = False
            if len(self.buf) >= payload_len + CRC_SIZE_OPTIONAL:
                next_bytes = self.buf[payload_len:payload_len + len(MAGIC)]
                if next_bytes != MAGIC:
                    crc_present = True
            packet_len = payload_len + (CRC_SIZE_OPTIONAL if crc_present else 0)
            if len(self.buf) < packet_len:
                return False
            self.synced = True
            return True


    def _drain_synced(self):
        out = []
        while True:
            if len(self.buf) < HEADER_SIZE:
                break
            if self.buf[:len(MAGIC)] != MAGIC:
                self.synced = False
                del self.buf[0]
                break
            try:
                magic, version, flags, count, failures, total_time_us, packet_time_us = HEADER_STRUCT.unpack_from(self.buf, 0)
            except struct.error:
                self.synced = False
                del self.buf[0]
                break
            count = int(count)
            payload_len = HEADER_SIZE + count * RECORD_SIZE
            if payload_len > MAX_PACKET_BYTES:
                self.synced = False
                del self.buf[0]
                break
            if len(self.buf) < payload_len:
                break
            if payload_len < len(self.buf) < payload_len + CRC_SIZE_OPTIONAL:
                break
            crc_present = False
            if len(self.buf) >= payload_len + CRC_SIZE_OPTIONAL:
                next_bytes = self.buf[payload_len:payload_len + len(MAGIC)]
                if next_bytes != MAGIC:
                    crc_present = True
            packet_len = payload_len + (CRC_SIZE_OPTIONAL if crc_present else 0)
            if len(self.buf) < packet_len:
                break
            if (
                magic != MAGIC
                or version != PACKET_VERSION
                or not (flags & FLAG_TIMING)
            ):
                self.synced = False
                del self.buf[0]
                break
            total_time_us = int(total_time_us)
            failures = int(failures)
            packet_time_us = int(packet_time_us) & UINT32_MAX
            count_success = max(1, count - min(count, failures))
            per_sample_default = max(1, total_time_us // count_success) if total_time_us > 0 else 1

            

            valid_records = 0
            padded_records = 0
            dropped_records = 0
            for i in range(count):
                base = HEADER_SIZE + i * RECORD_SIZE
                ch, ok, raw, sample_time, read_dur, conv_dur = RECORD_STRUCT.unpack_from(self.buf, base)
                ch = int(ch)
                ok = int(ok)
                raw = int(raw)
                sample_time = int(sample_time)
                if ch == 0xFF:
                    padded_records += 1
                    continue
                if not ok or raw == INT32_MIN or sample_time in (-1, INT32_MIN):
                    dropped_records += 1
                    continue
                sample_us = sample_time & UINT32_MAX
                read_us = 0 if read_dur == UINT32_MAX else int(read_dur)
                conv_us = 0 if conv_dur == UINT32_MAX else int(conv_dur)
                per_sample = read_us + conv_us
                if per_sample <= 0:
                    per_sample = per_sample_default
                per_sample = max(1, int(per_sample))
                volts = raw * V_REF / ADC_SCALE
                sps = 1_000_000.0 / per_sample
                sample_tuple = (sample_us, ch, raw, volts, read_us, conv_us, sps, packet_time_us)
                if plausible(sample_tuple):
                    out.append((time.monotonic(), sample_tuple))
                    valid_records += 1
                else:
                    dropped_records += 1
            real_failures = max(0, min(count, failures) - padded_records)
            if real_failures != self._last_failures:
                if real_failures:
                    extra = f" (padded {padded_records})" if padded_records else ""
                    self.status.emit(f"Sweep failures: {real_failures}{extra}")
                else:
                    self.status.emit("Sweep failures cleared")
                self._last_failures = real_failures
            elif self._last_failures and real_failures == 0:
                self._last_failures = 0
            summary = f"Packet: valid={valid_records}, padded={padded_records}, dropped={dropped_records}, failures={real_failures}"
            now = time.monotonic()
            if summary != self._last_summary or (now - self._last_status_emit) >= 0.5:
                if valid_records == 0 and dropped_records:
                    summary += " (no usable samples)"
                self.status.emit(summary)
                self._last_summary = summary
                self._last_status_emit = now
            self._last_valid_count = valid_records
            self._last_pad_count = padded_records
            del self.buf[:packet_len]
        return out



    def run(self):
        try:
            self.ser = serial.Serial(self.port, self.baud, timeout=0.05)
            self.status.emit(f"Connected {self.port} @ {self.baud}")
        except Exception as e:
            self.status.emit(f"Open failed: {e}")
            return

        while not self._stop:
            try:
                data = self.ser.read(self.ser.in_waiting or 1)
                if data:
                    self.raw_bytes.emit(data)
                    self.buf.extend(data)
                    if not self.synced:
                        self._resync()
                    if self.synced:
                        for t_wall, rec in self._drain_synced():
                            self.sample.emit(t_wall, rec)
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

# ---------------------- Metrics window ----------------------

class MetricsWindow(QtWidgets.QDialog):
    sig_ingest = QtCore.pyqtSignal(float, float, float)

    def __init__(self, parent, get_window_seconds):
        super().__init__(parent)
        self.setAttribute(QtCore.Qt.WidgetAttribute.WA_DeleteOnClose, True)
        self.setWindowTitle("Aggregated Metrics (conv_us & sps)")
        self.resize(900, 500)

        self.get_window_seconds = get_window_seconds
        self.t = deque()
        self.convs = deque()
        self.sps = deque()

        # connect signal with queued delivery to GUI thread
        self.sig_ingest.connect(self._enqueue, QtCore.Qt.ConnectionType.QueuedConnection)

        # throttle UI updates ~30 FPS
        self._timer = QtCore.QTimer(self)
        self._timer.setInterval(33)
        self._timer.timeout.connect(self._flush)
        self._timer.start()

        layout = QtWidgets.QVBoxLayout(self)

        self.plot_conv = pg.PlotWidget()
        self.plot_sps = pg.PlotWidget()
        self.plot_conv.setLabel("left", "conv_us")
        self.plot_sps.setLabel("left", "sps")
        self.plot_sps.setLabel("bottom", "Time", units="s")
        self.curve_conv = self.plot_conv.plot([], [])
        self.curve_sps = self.plot_sps.plot([], [])
        for pw in (self.plot_conv, self.plot_sps):
            pw.showGrid(x=True, y=True, alpha=0.3)

        layout.addWidget(self.plot_conv)
        layout.addWidget(self.plot_sps)

        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self._refresh_axes)
        self.timer.start(100)

    def ingest(self, t_rel, conv_us, sps):
        # can be called from any thread
        self.sig_ingest.emit(float(t_rel), float(conv_us), float(sps))

    def _enqueue(self, t_rel, conv_us, sps):
        # runs on GUI thread due to QueuedConnection
        self.t.append(t_rel)
        self.convs.append(conv_us)
        self.sps.append(sps)

    def _flush(self):
        # runs on GUI thread at timer tick
        n = min(len(self.t), len(self.convs), len(self.sps))
        if not n:
            return
        # make NumPy arrays for pyqtgraph
        x = np.fromiter(self.t, dtype=np.float32, count=n)
        y1 = np.fromiter(self.convs, dtype=np.float32, count=n)
        y2 = np.fromiter(self.sps, dtype=np.float32, count=n)

        self.curve_conv.setData(x, y1, skipFiniteCheck=True)
        self.curve_sps.setData(x, y2, skipFiniteCheck=True)

    def _refresh_axes(self):
        if not self.t:
            return
        window = self.get_window_seconds()
        latest = self.t[-1]
        xmin = max(0.0, latest - window)
        for pw, data in ((self.plot_conv, self.convs), (self.plot_sps, self.sps)):
            pw.setXRange(xmin, max(xmin + 1e-3, latest), padding=0)
            if data:
                vmin, vmax = min(data), max(data)
                if vmax == vmin:
                    pad = 0.1 if vmax == 0 else abs(vmax) * 0.1
                    pw.setYRange(vmin - pad, vmax + pad, padding=0)
                else:
                    rng = vmax - vmin
                    pw.setYRange(vmin - 0.1 * rng, vmax + 0.1 * rng, padding=0)

# ---------------------- Settings window ----------------------

class SettingsWindow(QtWidgets.QDialog):
    def __init__(self, parent):
        super().__init__(parent)
        self.parent = parent
        self.setWindowTitle("Settings")
        self.resize(360, 160)

        layout = QtWidgets.QVBoxLayout(self)
        layout.addWidget(QtWidgets.QLabel("Viewing window (seconds)"))

        row = QtWidgets.QHBoxLayout()
        self.slider = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.slider.setMinimum(1)
        self.slider.setMaximum(60)
        self.slider.setValue(int(self.parent.window_seconds))
        self.slider.valueChanged.connect(self._on_change)
        self.lbl = QtWidgets.QLabel(f"{self.parent.window_seconds:.1f}s")
        row.addWidget(self.slider, 1)
        row.addWidget(self.lbl)
        layout.addLayout(row)

        # MaxV control
        layout.addWidget(QtWidgets.QLabel("Max voltage (V)"))
        row2 = QtWidgets.QHBoxLayout()
        self.slider_maxv = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.slider_maxv.setMinimum(5)    # 0.5 V -> value * 0.1
        self.slider_maxv.setMaximum(100)  # 10.0 V
        self.slider_maxv.setValue(int(self.parent.max_v * 10))
        self.slider_maxv.valueChanged.connect(self._on_change_maxv)
        self.lbl_maxv = QtWidgets.QLabel(f"{self.parent.max_v:.1f} V")
        row2.addWidget(self.slider_maxv, 1)
        row2.addWidget(self.lbl_maxv)
        layout.addLayout(row2)

        btn = QtWidgets.QPushButton("Close")
        btn.clicked.connect(self.accept)
        layout.addWidget(btn)

    def _on_change(self, val):
        self.parent.window_seconds = float(val)
        self.parent._prune_all()
        self.lbl.setText(f"{float(val):.1f}s")

    def _on_change_maxv(self, val):
        self.parent.max_v = float(val) / 10.0
        self.lbl_maxv.setText(f"{self.parent.max_v:.1f} V")

# ---------------------- Raw console window ----------------------

class ConsoleWindow(QtWidgets.QDialog):
    def __init__(self, parent):
        super().__init__(parent)
        self.setWindowTitle("Raw Serial Console")
        self.resize(800, 400)

        top = QtWidgets.QHBoxLayout()
        self.chk_pause = QtWidgets.QCheckBox("Pause")
        btn_clear = QtWidgets.QPushButton("Clear")
        btn_clear.clicked.connect(self._clear)
        top.addWidget(self.chk_pause)
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
            s = data.decode("utf-8", errors="replace")
            self.text.appendPlainText(s)
        except Exception:
            pass

# ---------------------- Main application window ----------------------

class App(QtWidgets.QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Channels")
        self.resize(1280, 740)

        self.window_seconds = DEFAULT_WINDOW_SECONDS
        self.console_win = None
        self.metrics_win = None
        
        # Y-axis control
        self.autoscale = True   # default ON (current behavior)
        self.max_v = 2.5        # default VMAX when autoscale is OFF

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

        btn_metrics = QtWidgets.QPushButton("Open Metrics")
        btn_metrics.clicked.connect(self._open_metrics)
        top.addWidget(btn_metrics)
        btn_settings = QtWidgets.QPushButton("Open Settings")
        btn_settings.clicked.connect(self._open_settings)
        top.addWidget(btn_settings)
        btn_console = QtWidgets.QPushButton("Open Console")
        btn_console.clicked.connect(self._open_console)
        top.addWidget(btn_console)
        # Autoscale checkbox
        self.chk_autoscale = QtWidgets.QCheckBox("Autoscale Y")
        self.chk_autoscale.setChecked(True)
        self.chk_autoscale.stateChanged.connect(self._on_autoscale)
        top.addWidget(self.chk_autoscale)

        top.addStretch(1)
        root.addLayout(top)

        # Main split: plot on left, toggles + metrics on right
        main = QtWidgets.QHBoxLayout()
        root.addLayout(main, 1)

        # Plot
        self.plot = pg.PlotWidget()
        self.plot.setLabel("bottom", "Time", units="s")
        self.plot.setLabel("left", "Voltage", units="V")
        self.plot.showGrid(x=True, y=True, alpha=0.3)
        self.plot.setTitle("Channels")
        self.plot.setClipToView(True)
        self.plot.setDownsampling(mode='peak')
        self.plot.setMouseEnabled(x=True, y=True)
        self.legend = self.plot.addLegend(labelTextSize="9pt")
        

        main.addWidget(self.plot, 1)

        # Right panel
        right = QtWidgets.QVBoxLayout()
        main.addLayout(right)

        # Toggle group
        right.addWidget(QtWidgets.QLabel("Show channels:"))
        self.chk = {}
        self.curves = {}
        for idx, ch in enumerate(TOGGLE_CHANNELS):
            cb = QtWidgets.QCheckBox(f"CH{ch}") 
            cb.setChecked(True)
            cb.stateChanged.connect(self._on_toggle)
            right.addWidget(cb)
            self.chk[ch] = cb
            # prepare curve with color
            color = CHANNEL_COLORS[idx % len(CHANNEL_COLORS)]
            pen = pg.mkPen(color=color, width=1)
            self.curves[ch] = self.plot.plot([], [], name=f"CH{ch}", pen=pen)

        # Simple metrics
        box = QtWidgets.QGroupBox("Simple Metrics")
        form = QtWidgets.QVBoxLayout(box)
        self.lbl_read_mean = QtWidgets.QLabel("conv_us mean: n/a")
        self.lbl_sps_mean = QtWidgets.QLabel("sps mean: n/a")
        self.lbl_latency = QtWidgets.QLabel("latency jitter mean/max: n/a")
        form.addWidget(self.lbl_read_mean)
        form.addWidget(self.lbl_sps_mean)
        form.addWidget(self.lbl_latency)
        form.addWidget(self._hline())
        form.addWidget(QtWidgets.QLabel(f"Per-channel mean V (last {int(VOLT_MEAN_WINDOW_S*1000)} ms)"))
        self.per_ch = {}
        for ch in TOGGLE_CHANNELS:
            lbl = QtWidgets.QLabel(f"CH{ch}: n/a")
            form.addWidget(lbl)
            self.per_ch[ch] = lbl
        right.addWidget(box)

        status_box = QtWidgets.QGroupBox("Status")
        status_layout = QtWidgets.QVBoxLayout(status_box)
        self.lbl_status = QtWidgets.QLabel("Idle")
        self.lbl_status.setWordWrap(True)
        status_layout.addWidget(self.lbl_status)
        right.addWidget(status_box)
        right.addStretch(1)

        # Data storage
        self.t0 = None
        self.send_start_raw = None
        self.send_prev_raw = None
        self.send_rollover = 0
        self.t = defaultdict(deque)  # per-ch time
        self.v = defaultdict(deque)  # per-ch volts
        self.reads = deque(maxlen=MAX_POINTS)  # (t_rel, read_us)
        self.convs = deque(maxlen=MAX_POINTS)  # (t_rel, conv_us)
        self.sps = deque(maxlen=MAX_POINTS)    # (t_rel, sps)
        self.latencies = deque(maxlen=MAX_POINTS)  # (t_rel, latency_s)

        # Timer for plot updates
        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self._update_plot)
        self.timer.start(50)

        # Serial reader holder
        self.reader = None

    # --------- UI helpers ---------
    def _hline(self):
        line = QtWidgets.QFrame()
        line.setFrameShape(QtWidgets.QFrame.Shape.HLine)
        line.setFrameShadow(QtWidgets.QFrame.Shadow.Sunken)
        return line

    def _prune_all(self):
        if not self.t:
            return
        latest = 0.0
        for ts in self.t.values():
            if ts:
                latest = max(latest, ts[-1])
        cutoff = latest - self.window_seconds
        if cutoff <= 0.0:
            return
        for ch in list(self.t.keys()):
            ts = self.t[ch]
            vs = self.v[ch]
            while ts and ts[0] < cutoff:
                ts.popleft()
                vs.popleft()
        while self.reads and self.reads[0][0] < cutoff:
            self.reads.popleft()
        while self.sps and self.sps[0][0] < cutoff:
            self.sps.popleft()
        while self.latencies and self.latencies[0][0] < cutoff:
            self.latencies.popleft()

    def _refresh_port_list(self):
        ports = list_ports()
        self.cmb_port.clear()
        self.cmb_port.addItems(ports)
        if ports:
            self.cmb_port.setCurrentIndex(0)

    def set_status(self, text):
        self.lbl_status.setText(text)

    # --------- Connect logic ---------
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
        self.t0 = None
        self.send_start_raw = None
        self.send_prev_raw = None
        self.send_rollover = 0
        self.t.clear()
        self.v.clear()
        self.reads.clear()
        self.convs.clear()
        self.sps.clear()
        self.latencies.clear()

        self.reader = Reader(port, baud)
        self.reader.sample.connect(self._on_sample)
        self.reader.status.connect(self.set_status)
        self.reader.raw_bytes.connect(self._on_raw_bytes)
        self.reader.start()

    # --------- Data ingestion ---------
    @QtCore.pyqtSlot(float, object)
    def _on_sample(self, t_wall, rec):
        t_us, ch, raw, volts, read_us, conv_us, sps, sent_us = rec
        if self.t0 is None:
            self.t0 = t_wall
        t_rel = t_wall - self.t0
        if ch == 0:
            ch = 10
        self.t[ch].append(t_rel)
        self.v[ch].append(volts)
        self.reads.append((t_rel, read_us))
        self.convs.append((t_rel, conv_us))
        self.sps.append((t_rel, sps))

        send_raw = int(sent_us) & 0xFFFFFFFF
        if self.send_start_raw is None:
            self.send_start_raw = send_raw
            self.send_prev_raw = send_raw
            self.send_rollover = 0
        else:
            if self.send_prev_raw is not None and send_raw < self.send_prev_raw:
                self.send_rollover += 1
            self.send_prev_raw = send_raw
        send_elapsed = ((self.send_rollover << 32) + send_raw - self.send_start_raw) / 1_000_000.0
        diff = t_rel - send_elapsed
        self.latencies.append((t_rel, diff))

        cutoff = t_rel - self.window_seconds
        if cutoff > 0.0:
            ts = self.t[ch]
            vs = self.v[ch]
            while ts and ts[0] < cutoff:
                ts.popleft()
                vs.popleft()
            while self.reads and self.reads[0][0] < cutoff:
                self.reads.popleft()
            while self.convs and self.convs[0][0] < cutoff:
                self.convs.popleft()
            while self.sps and self.sps[0][0] < cutoff:
                self.sps.popleft()
            while self.latencies and self.latencies[0][0] < cutoff:
                self.latencies.popleft()

        # Feed metrics window too
        if self.metrics_win is not None:
            self.metrics_win.ingest(t_rel, conv_us, sps)

    @QtCore.pyqtSlot(bytes)
    def _on_raw_bytes(self, data: bytes):
        if self.console_win is not None:
            self.console_win.on_bytes(data)

    # --------- Plot refresh ---------
    def _on_toggle(self):
        for ch, cb in self.chk.items():
            if cb.isChecked():
                if ch not in self.curves:
                    idx = TOGGLE_CHANNELS.index(ch)
                    color = CHANNEL_COLORS[idx % len(CHANNEL_COLORS)]
                    pen = pg.mkPen(color=color, width=1)
                    self.curves[ch] = self.plot.plot([], [], name=f"CH{ch}", pen=pen)
                else:
                    if ch in self.curves:
                        self.curves[ch].setData([], [])



    def _update_plot(self):
        for ch, cb in self.chk.items():
            if cb.isChecked():
                ts = self.t.get(ch, [])
                vs = self.v.get(ch, [])
                if ts and vs:
                    self.curves[ch].setData(ts, vs)
                else:
                    if ch in self.curves:
                        self.curves[ch].setData([], [])

        # X window aligns to latest visible sample
        latest = 0.0
        for ch, cb in self.chk.items():
            if cb.isChecked() and self.t.get(ch):
                latest = max(latest, self.t[ch][-1])
        xmin = max(0.0, latest - self.window_seconds)
        self.plot.setXRange(xmin, max(xmin + 1e-3, latest), padding=0)

        # Trim histories to last window
        now = latest
        keep = self.window_seconds
        for ch in TOGGLE_CHANNELS:
            ts = self.t.get(ch)
            vs = self.v.get(ch)
            if ts and vs:
                while ts and ts[0] < now - keep:
                    ts.popleft()
                    vs.popleft()
        while self.reads and self.reads[0][0] < now - keep:
            self.reads.popleft()
        while self.convs and self.convs[0][0] < now - keep:
            self.convs.popleft()
        while self.sps and self.sps[0][0] < now - keep:
            self.sps.popleft()
        while self.latencies and self.latencies[0][0] < now - keep:
            self.latencies.popleft()

        # Y limits
        if self.autoscale:
            # Fit visible channels (original behavior)
            values = []
            for ch, cb in self.chk.items():
                if cb.isChecked():
                    values.extend(self.v.get(ch, []))
            if values:
                vmin, vmax = min(values), max(values)
                if vmax == vmin:
                    pad = 0.1 if vmax == 0 else abs(vmax) * 0.1
                    self.plot.setYRange(vmin - pad, vmax + pad, padding=0)
                else:
                    rng = vmax - vmin
                    self.plot.setYRange(vmin - 0.1 * rng, vmax + 0.1 * rng, padding=0)
        else:
            # Fixed range: 0V .. max_v + 100 mV
            y_min = 0.0
            y_max = float(self.max_v) + 0.1
            if y_max <= y_min + 0.01:
                y_max = y_min + 0.5  # small guard to avoid zero-height range
            self.plot.setYRange(y_min, y_max, padding=0)

        # Overall means over last window
        recent_conv = [val for t, val in self.convs if t >= now - self.window_seconds]
        recent_sps = [val for t, val in self.sps if t >= now - self.window_seconds]
        recent_latency_diffs = [val for t, val in self.latencies if t >= now - self.window_seconds]
        if recent_conv:
            mean_conv = sum(recent_conv) / len(recent_conv)
            self.lbl_read_mean.setText(f"conv_us mean (last {self.window_seconds:.0f}s): {mean_conv:.2f}")
        if recent_sps:
            # Instead of arithmetic mean of sps, compute true rate = count / elapsed time
            recent_times = [t for t, _ in self.sps if t >= now - self.window_seconds]
            if len(recent_times) >= 2:
                duration = recent_times[-1] - recent_times[0]
                if duration > 0:
                    agg_sps = (len(recent_times) - 1) / duration
                    self.lbl_sps_mean.setText(
                        f"sps mean (last {self.window_seconds:.0f}s): {agg_sps:.2f}"
                    )
        if recent_latency_diffs:
            baseline = min(recent_latency_diffs)
            latencies = [max(0.0, diff - baseline) for diff in recent_latency_diffs]
            mean_latency = sum(latencies) / len(latencies)
            max_latency = max(latencies)
            self.lbl_latency.setText(
                f"latency jitter mean/max (last {self.window_seconds:.0f}s): {mean_latency * 1000:.2f} ms / {max_latency * 1000:.2f} ms"
            )
        else:
            self.lbl_latency.setText("latency jitter mean/max: n/a")

        # Per-channel mean V over last 100 ms
        for ch in TOGGLE_CHANNELS:
            if not self.chk[ch].isChecked():
                self.per_ch[ch].setText(f"CH{ch}: n/a")
                continue
            ts = self.t.get(ch, [])
            vs = self.v.get(ch, [])
            if ts and vs:
                recent = [vv for tt, vv in zip(ts, vs) if tt >= now - VOLT_MEAN_WINDOW_S]
                if recent:
                    mean_v = sum(recent) / len(recent)
                    self.per_ch[ch].setText(f"CH{ch}: {mean_v:.4f} V")
                else:
                    self.per_ch[ch].setText(f"CH{ch}: n/a")
            else:
                self.per_ch[ch].setText(f"CH{ch}: n/a")

    # --------- Secondary windows ---------
    def _open_metrics(self):
        if self.metrics_win is None or not self.metrics_win.isVisible():
            self.metrics_win = MetricsWindow(self, get_window_seconds=lambda: self.window_seconds)
        self.metrics_win.show()
        self.metrics_win.raise_()
        self.metrics_win.activateWindow()
        self.metrics_win.finished.connect(lambda _: setattr(self, "metrics_win", None))

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
        # Force a refresh of the plot limits right away
        self._update_plot()

    # --------- Close handling ---------
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
    # Make PyQtGraph look nice
    pg.setConfigOptions(antialias=False)
    w = App()
    w.show()
    try:
        sys.exit(app.exec())
    except KeyboardInterrupt:
        sys.exit(0)

if __name__ == "__main__":
    main()


