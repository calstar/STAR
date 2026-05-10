#!/usr/bin/env python3
# Channel Plotter GUI (Qt + PyQtGraph)
# - Serial port selector with connect/refresh
# - Plot channels with toggles
# - Simple Metrics: windowed means of read_us and sps, per-channel mean V over last 100 ms
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
PACK_FMT = "<IBifIfI"
PACK_SIZE = struct.calcsize(PACK_FMT)

BAUD = 115200
DEFAULT_WINDOW_SECONDS = 10.0
MAX_POINTS = 2000
NUM_CHANNELS_MAX = 16
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
    t_us, ch, raw, volts, read_us, sps, sent_us = rec
    if not (0 <= ch < NUM_CHANNELS_MAX):
        return False
    if not (RAW_MIN <= raw <= RAW_MAX):
        return False
    if not (-10.0 <= volts <= 10.0):
        return False
    if not (1 <= read_us <= 2_000_000):
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

    def stop(self):
        self._stop = True
        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass

    def _resync(self):
        n = len(self.buf)
        for start in range(max(0, n - 4 * PACK_SIZE + 1)):
            try:
                r1 = struct.unpack_from(PACK_FMT, self.buf, start)
                if not plausible(r1):
                    continue
                off2 = start + PACK_SIZE
                if n - off2 < PACK_SIZE:
                    break
                r2 = struct.unpack_from(PACK_FMT, self.buf, off2)
                if not plausible(r2):
                    continue
                if start:
                    del self.buf[:start]
                self.synced = True
                return True
            except struct.error:
                continue
        return False

    def _drain_synced(self):
        out = []
        while len(self.buf) >= PACK_SIZE:
            try:
                rec = struct.unpack_from(PACK_FMT, self.buf, 0)
            except struct.error:
                self.synced = False
                del self.buf[0]
                break
            if plausible(rec):
                t_wall = time.monotonic()
                out.append((t_wall, rec))
                del self.buf[:PACK_SIZE]
            else:
                self.synced = False
                del self.buf[0]
                break
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
        self.setWindowTitle("Aggregated Metrics (read_us & sps)")
        self.resize(900, 500)

        self.get_window_seconds = get_window_seconds
        self.t = deque()
        self.reads = deque()
        self.sps = deque()

        # connect signal with queued delivery to GUI thread
        self.sig_ingest.connect(self._enqueue, QtCore.Qt.ConnectionType.QueuedConnection)

        # throttle UI updates ~30 FPS
        self._timer = QtCore.QTimer(self)
        self._timer.setInterval(33)
        self._timer.timeout.connect(self._flush)
        self._timer.start()

        layout = QtWidgets.QVBoxLayout(self)

        self.plot_read = pg.PlotWidget()
        self.plot_sps = pg.PlotWidget()
        self.plot_read.setLabel("left", "read_us")
        self.plot_sps.setLabel("left", "sps")
        self.plot_sps.setLabel("bottom", "Time", units="s")
        self.curve_read = self.plot_read.plot([], [])
        self.curve_sps = self.plot_sps.plot([], [])
        for pw in (self.plot_read, self.plot_sps):
            pw.showGrid(x=True, y=True, alpha=0.3)

        layout.addWidget(self.plot_read)
        layout.addWidget(self.plot_sps)

        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self._refresh_axes)
        self.timer.start(100)

    def ingest(self, t_rel, read_us, sps):
        # can be called from any thread
        self.sig_ingest.emit(float(t_rel), float(read_us), float(sps))

    def _enqueue(self, t_rel, read_us, sps):
        # runs on GUI thread due to QueuedConnection
        self.t.append(t_rel)
        self.reads.append(read_us)
        self.sps.append(sps)

    def _flush(self):
        # runs on GUI thread at timer tick
        n = min(len(self.t), len(self.reads), len(self.sps))
        if not n:
            return
        # make NumPy arrays for pyqtgraph
        x = np.fromiter(self.t, dtype=np.float32, count=n)
        y1 = np.fromiter(self.reads, dtype=np.float32, count=n)
        y2 = np.fromiter(self.sps, dtype=np.float32, count=n)

        self.curve_read.setData(x, y1, skipFiniteCheck=True)
        self.curve_sps.setData(x, y2, skipFiniteCheck=True)

    def _refresh_axes(self):
        if not self.t:
            return
        window = self.get_window_seconds()
        latest = self.t[-1]
        xmin = max(0.0, latest - window)
        for pw, data in ((self.plot_read, self.reads), (self.plot_sps, self.sps)):
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
        self.lbl_status = QtWidgets.QLabel("Idle")
        top.addWidget(self.lbl_status)
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
        self.lbl_read_mean = QtWidgets.QLabel("read_us mean: n/a")
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
        right.addStretch(1)

        # Data storage
        self.t0 = None
        self.send_start_raw = None
        self.send_prev_raw = None
        self.send_rollover = 0
        self.t = defaultdict(deque)  # per-ch time
        self.v = defaultdict(deque)  # per-ch volts
        self.reads = deque(maxlen=MAX_POINTS)  # (t_rel, read_us)
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
        t_us, ch, raw, volts, read_us, sps, sent_us = rec
        if self.t0 is None:
            self.t0 = t_wall
        t_rel = t_wall - self.t0
        if ch == 0:
            ch = 10
        self.t[ch].append(t_rel)
        self.v[ch].append(volts)
        self.reads.append((t_rel, read_us))
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
            while self.sps and self.sps[0][0] < cutoff:
                self.sps.popleft()
            while self.latencies and self.latencies[0][0] < cutoff:
                self.latencies.popleft()

        # Feed metrics window too
        if self.metrics_win is not None:
            self.metrics_win.ingest(t_rel, read_us, sps)

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
        recent_reads = [val for t, val in self.reads if t >= now - self.window_seconds]
        recent_sps = [val for t, val in self.sps if t >= now - self.window_seconds]
        recent_latency_diffs = [val for t, val in self.latencies if t >= now - self.window_seconds]
        if recent_reads:
            mean_read = sum(recent_reads) / len(recent_reads)
            self.lbl_read_mean.setText(f"read_us mean (last {self.window_seconds:.0f}s): {mean_read:.2f}")
        if recent_sps:
            mean_sps = sum(recent_sps) / len(recent_sps)
            self.lbl_sps_mean.setText(f"sps mean (last {self.window_seconds:.0f}s): {mean_sps:.2f}")
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
