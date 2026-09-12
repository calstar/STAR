"""
Generic board monitor window.

``BoardMonitorWindow`` is built entirely from a :class:`BoardProfile`, so the
same UI serves every board — LC, PT, TC, RTD, and the actuator board (profile
``kind="actuator"`` swaps SENSOR_CONFIG for ACTUATOR_CONFIG and adds
per-actuator ON/OFF toggles + a PWM row). It shows, in one place, everything
the board does:

  * top-left connection panel: listen port, board IP:port, and a Connected light
  * board status  : state-machine state, engine state, firmware hash, heartbeat rate
  * ethernet/packets: totals, rates, per-type tallies, malformed count (proves
                      the Ethernet path end-to-end)
  * self-test     : ADC + per-connector continuity results
  * live readings : per-connector raw ADC code + voltage, with a rolling plot
  * controls      : send SERVER_HEARTBEAT (auto/manual), the board's CONFIG
                    packet (activate), ABORT / CLEAR_ABORT / NO_CONNECTION_ABORT,
                    and for actuator boards ACTUATOR_COMMAND / PWM commands
  * log console   : mirrored to a rotating file (see logsetup)
"""

from __future__ import annotations

import logging
import sys
import time
from collections import deque
from bisect import bisect_left
from typing import Deque, Dict, List, Optional, Tuple

import pyqtgraph as pg

from . import protocol
from . import filters as filt
from .clocksync import BoardClockSync, TimeSyncConfig
from .network import UdpLink
from .profile import REFERENCE_VOLTAGE_LABELS, BoardProfile
from .serial_link import SerialLink, list_ports, pyserial_error
from .serial_parse import SerialParser
from .qt import (ALIGN_CENTER, ALIGN_RIGHT, ALIGN_VCENTER, FONT_BOLD,
                 FRAME_NOFRAME, FRAME_PANEL, ORIENT_HORIZONTAL, QtCore,
                 QtGui, QtWidgets, QTimer, TEXTCURSOR_END, pyqtSignal)

DEFAULT_LEFT_WIDTH = 360   # starting width of the status/controls column
MIN_LEFT_WIDTH = 240       # narrowest the splitter will let it get

BAUD_RATES = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600]

UI_REFRESH_MS = 100
# The plot gets its own timer so a heavy repaint can be throttled independently
# of the status labels. With clipping, decimation and antialiasing off, a frame
# costs ~5-10 ms, so 10 Hz is comfortable.
PLOT_REFRESH_MS = 100
MAX_POINTS_PER_CHANNEL = 6000
# Rolling x-window options: (label, seconds). None = show the whole buffer,
# which at the boards' sample rate is roughly MAX_POINTS_PER_CHANNEL samples.
TRIM_SLACK = 2000           # extra room before a batched trim
TIME_WINDOWS = [("1 s", 1.0), ("5 s", 5.0), ("10 s", 10.0), ("30 s", 30.0),
                ("1 min", 60.0), ("5 min", 300.0), ("All", None)]
DEFAULT_WINDOW_LABEL = "30 s"

# distinct plot colours for up to 10 connectors
_COLORS = [
    (232, 78, 78), (78, 200, 96), (72, 132, 232), (240, 180, 64),
    (176, 96, 224), (64, 200, 200), (232, 128, 160), (150, 200, 120),
    (120, 160, 232), (220, 220, 96),
]


# -----------------------------------------------------------------------------
# Small widgets
# -----------------------------------------------------------------------------
class ValueLabel(QtWidgets.QLabel):
    """Status value that wraps instead of being clipped by the column width.

    Values here vary wildly in length ("—" vs "Setup (waiting for server)" vs
    a 64-char hash), and the column is user-resizable, so anything can end up
    too narrow. Wrapping keeps the text visible; the tooltip always carries the
    untruncated value for the cases the caller shortens on purpose.
    """

    def __init__(self, text: str = "") -> None:
        super().__init__(text)
        self.setWordWrap(True)
        self.setToolTip(text)

    def setText(self, text: str) -> None:  # noqa: N802 - Qt naming
        super().setText(text)
        self.setToolTip(text)


class StatusLight(QtWidgets.QWidget):
    """A coloured dot + text label used for the Connected indicator."""

    def __init__(self, diameter: int = 14):
        super().__init__()
        self._d = diameter
        self._color = QtGui.QColor(120, 120, 120)
        layout = QtWidgets.QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)
        self._dot = QtWidgets.QLabel()
        self._dot.setFixedSize(diameter, diameter)
        self._text = QtWidgets.QLabel("Not listening")
        f = self._text.font()
        f.setWeight(FONT_BOLD)
        self._text.setFont(f)
        layout.addWidget(self._dot)
        layout.addWidget(self._text)
        layout.addStretch(1)
        self._repaint_dot()

    def _repaint_dot(self) -> None:
        c = self._color
        self._dot.setStyleSheet(
            f"background-color: rgb({c.red()},{c.green()},{c.blue()});"
            f"border-radius: {self._d // 2}px; border: 1px solid rgba(0,0,0,80);"
        )

    def set_state(self, color: Tuple[int, int, int], text: str) -> None:
        self._color = QtGui.QColor(*color)
        self._text.setText(text)
        self._repaint_dot()


class QtLogHandler(QtCore.QObject, logging.Handler):
    """Logging handler that forwards formatted records to the GUI via a signal."""
    record = pyqtSignal(str)

    def __init__(self):
        QtCore.QObject.__init__(self)
        logging.Handler.__init__(self)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.record.emit(self.format(record))
        except Exception:  # pragma: no cover - never let logging crash the app
            pass


# -----------------------------------------------------------------------------
# Main window
# -----------------------------------------------------------------------------
class BoardMonitorWindow(QtWidgets.QMainWindow):
    def __init__(self, profile: BoardProfile, logger: logging.Logger,
                 log_path, bind_ip: str = "0.0.0.0"):
        super().__init__()
        self.profile = profile
        self.log = logger
        self.log_path = log_path
        self.bind_ip = bind_ip

        self.setWindowTitle(f"{profile.title}  —  STAR Board Test GUI")
        self.resize(1180, 760)

        # runtime state
        self.link: Optional[UdpLink] = None
        self.serial: Optional[SerialLink] = None
        self._warned_no_pyserial = False
        # Per-board clock sync, ported from the DAQ server's bridge so the GUI
        # timeline matches what the server records (see clocksync.py).
        self.clock_sync = BoardClockSync(TimeSyncConfig())
        # One physical board = one millis() clock, so it gets ONE sync key.
        # Keying on the source path instead (src_ip, or "serial") splits the
        # timeline: each key anchors its own offset, and when the paths differ
        # in latency by more than the packet interval — serial buffering vs
        # UDP, say — their samples interleave and x goes backwards.
        self._clock_key = f"{profile.board_type}#{profile.board_id}"
        self.parser = SerialParser()
        self.serial_state_text: Optional[str] = None
        self.last_heartbeat: Optional[protocol.BoardHeartbeat] = None
        self.last_heartbeat_time: Optional[float] = None
        self.heartbeat_times: Deque[float] = deque(maxlen=30)
        self.heartbeat_count = 0
        self.last_sensor_data_time: Optional[float] = None
        self.sensor_packet_count = 0
        self.start_time = time.time()
        self._last_eth_data_log = 0.0  # throttle for echoing sensor-data packets
        self.actuator_buttons: Dict[int, QtWidgets.QPushButton] = {}

        # per-connector rolling data: connector_id -> (deque[t], deque[volt], last_raw)
        self.readings: Dict[int, Tuple[Deque[float], Deque[float]]] = {}
        self.last_raw: Dict[int, int] = {}
        self.value_labels: Dict[str, QtWidgets.QLabel] = {}
        self.conn_value_labels: Dict[int, QtWidgets.QLabel] = {}
        self.conn_fs_labels: Dict[int, QtWidgets.QLabel] = {}
        # Filtered copy of each connector's series, kept in step with the raw
        # one so switching filters never loses data (see _rebuild_filters).
        self.filtered: Dict[int, List[float]] = {}
        self._filter_objs: Dict[int, filt.Filter] = {}
        self._filter_factory = None
        self._bank_fs = None
        self.raw_curves: Dict[int, object] = {}
        self.conn_checkboxes: Dict[int, QtWidgets.QCheckBox] = {}
        self.plot_curves: Dict[int, pg.PlotDataItem] = {}

        self._build_ui()
        self._wire_logging()

        # timer
        self.ui_timer = QTimer(self)
        self.ui_timer.timeout.connect(self._refresh)
        self.ui_timer.start(UI_REFRESH_MS)
        self.plot_timer = QTimer(self)
        self.plot_timer.timeout.connect(self._refresh_plot)
        self.plot_timer.start(PLOT_REFRESH_MS)

        # auto SERVER_HEARTBEAT (matches the production server's cadence)
        self.hb_timer = QTimer(self)
        self.hb_timer.timeout.connect(self._auto_heartbeat_tick)
        self.hb_timer.start(profile.server_heartbeat_interval_ms)

        self.log.info("GUI started for %s (board id %d, %s). Log file: %s",
                      profile.board_type, profile.board_id, profile.board_ip, self.log_path)
        self.log.info("Pick the board's USB serial port above and click Connect. "
                      "Use 'Start Ethernet UDP' to watch the network path.")

    # -- UI construction -----------------------------------------------------
    def _build_ui(self) -> None:
        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        root = QtWidgets.QVBoxLayout(central)
        root.setContentsMargins(10, 10, 10, 10)
        root.setSpacing(8)

        root.addWidget(self._build_top_bar())

        tabs = QtWidgets.QTabWidget()
        tabs.addTab(self._build_monitor_tab(), "Monitor")
        tabs.addTab(self._build_logs_tab(), "Logs")
        root.addWidget(tabs, stretch=1)

    def _build_monitor_tab(self) -> QtWidgets.QWidget:
        tab = QtWidgets.QWidget()
        body = QtWidgets.QHBoxLayout(tab)
        body.setContentsMargins(0, 6, 0, 0)
        body.setSpacing(8)

        left = QtWidgets.QVBoxLayout()
        left.setSpacing(8)
        left.addWidget(self._build_status_group())
        left.addWidget(self._build_packets_group())
        left.addWidget(self._build_controls_group())
        left.addStretch(1)
        left.addWidget(self._build_heartbeat_group())
        left_container = QtWidgets.QWidget()
        left_container.setLayout(left)

        # The status/controls column scrolls vertically (it is taller than a
        # laptop screen once the config fields are open) and its width is
        # drag-resizable against the plot — widen it to read long values, or
        # narrow it to give the graph more room.
        left_scroll = QtWidgets.QScrollArea()
        left_scroll.setWidget(left_container)
        left_scroll.setWidgetResizable(True)
        left_scroll.setFrameShape(FRAME_NOFRAME)
        left_scroll.setMinimumWidth(MIN_LEFT_WIDTH)

        readings = self._build_readings_group()
        readings.setMinimumWidth(320)

        self.monitor_splitter = QtWidgets.QSplitter(ORIENT_HORIZONTAL)
        self.monitor_splitter.addWidget(left_scroll)
        self.monitor_splitter.addWidget(readings)
        self.monitor_splitter.setChildrenCollapsible(False)
        self.monitor_splitter.setStretchFactor(0, 0)   # left keeps its width…
        self.monitor_splitter.setStretchFactor(1, 1)   # …the plot absorbs resizes
        self.monitor_splitter.setHandleWidth(8)
        self.monitor_splitter.setSizes([DEFAULT_LEFT_WIDTH, 900])
        body.addWidget(self.monitor_splitter)
        return tab

    def _build_top_bar(self) -> QtWidgets.QWidget:
        box = QtWidgets.QFrame()
        box.setFrameShape(QtWidgets.QFrame.Shape.StyledPanel if hasattr(QtWidgets.QFrame, "Shape")
                          else QtWidgets.QFrame.StyledPanel)
        lay = QtWidgets.QHBoxLayout(box)
        lay.setContentsMargins(12, 8, 12, 8)

        # top-LEFT: serial (USB) connection picker + the Connected light
        left = QtWidgets.QVBoxLayout()
        left.setSpacing(4)
        title = QtWidgets.QLabel(f"{self.profile.board_type} — Board #{self.profile.board_id}")
        tf = title.font()
        tf.setPointSize(tf.pointSize() + 3)
        tf.setWeight(FONT_BOLD)
        title.setFont(tf)
        left.addWidget(title)

        # the dropdown row: Serial port | refresh | baud | Connect
        picker = QtWidgets.QHBoxLayout()
        picker.setSpacing(6)
        picker.addWidget(QtWidgets.QLabel("Serial port:"))
        self.port_combo = QtWidgets.QComboBox()
        self.port_combo.setEditable(True)
        self.port_combo.setMinimumWidth(230)
        self.port_combo.setToolTip("USB serial port the board is plugged into")
        picker.addWidget(self.port_combo)
        self.refresh_btn = QtWidgets.QPushButton("⟳")
        self.refresh_btn.setFixedWidth(32)
        self.refresh_btn.setToolTip("Refresh serial port list")
        self.refresh_btn.clicked.connect(self._refresh_ports)
        picker.addWidget(self.refresh_btn)
        picker.addWidget(QtWidgets.QLabel("Baud:"))
        self.baud_combo = QtWidgets.QComboBox()
        for b in BAUD_RATES:
            self.baud_combo.addItem(str(b), b)
        self.baud_combo.setCurrentText(str(self.profile.serial_baud))
        picker.addWidget(self.baud_combo)
        self.serial_btn = QtWidgets.QPushButton("Connect")
        self.serial_btn.setMinimumWidth(96)
        self.serial_btn.clicked.connect(self._toggle_serial)
        picker.addWidget(self.serial_btn)
        picker.addStretch(1)
        left.addLayout(picker)

        # the light + serial activity
        light_row = QtWidgets.QHBoxLayout()
        light_row.setSpacing(12)
        self.status_light = StatusLight()
        light_row.addWidget(self.status_light)
        self.serial_activity = QtWidgets.QLabel("")
        self.serial_activity.setStyleSheet("color: #888;")
        light_row.addWidget(self.serial_activity)
        light_row.addStretch(1)
        left.addLayout(light_row)
        lay.addLayout(left)

        lay.addStretch(1)

        # top-RIGHT: the Ethernet/UDP path (packet testing) + raw-serial toggle
        right = QtWidgets.QVBoxLayout()
        right.setAlignment(ALIGN_RIGHT)

        # editable Board IP (where control packets are sent over Ethernet)
        ip_row = QtWidgets.QHBoxLayout()
        ip_row.setSpacing(6)
        ip_row.addStretch(1)
        ip_row.addWidget(QtWidgets.QLabel("Board IP:"))
        self.board_ip_edit = QtWidgets.QLineEdit(self.profile.board_ip)
        self.board_ip_edit.setFixedWidth(130)
        self.board_ip_edit.setToolTip(
            "IP the GUI sends control packets to. Auto-updates to the board's "
            "real address once its packets arrive; edit to override.")
        self.board_ip_edit.editingFinished.connect(self._apply_board_ip)
        ip_row.addWidget(self.board_ip_edit)
        set_ip_btn = QtWidgets.QPushButton("Set")
        set_ip_btn.setFixedWidth(48)
        set_ip_btn.clicked.connect(self._apply_board_ip)
        ip_row.addWidget(set_ip_btn)
        right.addLayout(ip_row)

        eth_lbl = QtWidgets.QLabel(
            f"control :{self.profile.control_port}  ·  listen UDP :{self.profile.listen_port}")
        eth_lbl.setStyleSheet("color: #888;")
        eth_lbl.setAlignment(ALIGN_RIGHT)
        self.conn_detail_label = eth_lbl
        self.listen_btn = QtWidgets.QPushButton("Start Ethernet UDP")
        self.listen_btn.clicked.connect(self._toggle_link)
        self.listen_btn.setMinimumWidth(160)
        self.listen_btn.setToolTip(
            "Listen for the board's UDP telemetry on the network")
        right.addWidget(eth_lbl)
        right.addWidget(self.listen_btn, alignment=ALIGN_RIGHT)
        lay.addLayout(right)

        self._refresh_ports()
        return box

    def _kv_row(self, grid: QtWidgets.QGridLayout, row: int, key: str, value_key: str,
                initial: str = "—") -> None:
        k = QtWidgets.QLabel(key)
        k.setStyleSheet("color: #999;")
        k.setWordWrap(True)
        v = ValueLabel(initial)
        vf = v.font()
        vf.setWeight(FONT_BOLD)
        v.setFont(vf)
        v.setTextInteractionFlags(QtCore.Qt.TextInteractionFlag.TextSelectableByMouse
                                  if hasattr(QtCore.Qt, "TextInteractionFlag")
                                  else QtCore.Qt.TextSelectableByMouse)
        grid.addWidget(k, row, 0)
        grid.addWidget(v, row, 1)
        self.value_labels[value_key] = v

    def _build_status_group(self) -> QtWidgets.QGroupBox:
        g = QtWidgets.QGroupBox("Board Status")
        grid = QtWidgets.QGridLayout(g)
        grid.setColumnStretch(1, 1)
        self._kv_row(grid, 0, "Board state", "board_state")
        self._kv_row(grid, 1, "Board ID (reported)", "reported_id")
        self._kv_row(grid, 2, "Firmware hash", "fw_hash")
        self._kv_row(grid, 3, "Last heartbeat", "hb_age")
        self._kv_row(grid, 4, "Heartbeat rate", "hb_rate")
        self._kv_row(grid, 5, "Heartbeats", "hb_count")
        return g

    def _build_packets_group(self) -> QtWidgets.QGroupBox:
        g = QtWidgets.QGroupBox("Ethernet / Packets")
        grid = QtWidgets.QGridLayout(g)
        grid.setColumnStretch(1, 1)
        self._kv_row(grid, 0, "Listener", "listener", "off (Start Ethernet UDP)")
        self._kv_row(grid, 1, "Last source IP", "src_ip")
        self._kv_row(grid, 2, "Packets received", "pkt_total")
        self._kv_row(grid, 3, "Packet rate", "pkt_rate")
        self._kv_row(grid, 4, "Data received", "bytes_total")
        self._kv_row(grid, 5, "Throughput", "bytes_rate")
        self._kv_row(grid, 6, "Heartbeat pkts", "cnt_hb")
        return g

    def _build_controls_group(self) -> QtWidgets.QGroupBox:
        """Send-side controls: every packet the board understands.

        Sending needs the Ethernet path — start it with 'Start Ethernet UDP'.
        The set of controls adapts to the profile kind (sensor vs actuator).
        """
        g = QtWidgets.QGroupBox("Controls  (needs Ethernet UDP)")
        lay = QtWidgets.QVBoxLayout(g)
        lay.setSpacing(6)

        # CONFIG (activates the board's state machine) — full-width row so the
        # label never truncates in the fixed-width left column
        if self.profile.kind == "actuator":
            self.config_btn = QtWidgets.QPushButton("Send ACTUATOR_CONFIG (activate)")
            self.config_btn.setToolTip(
                "WaitingForServer -> Active; locations = the displayed actuators "
                "on this board, vent/abort states from the profile")
            self.abort_controller_cb = QtWidgets.QCheckBox("abort controller")
            self.abort_controller_cb.setChecked(self.profile.is_abort_controller)
            self.abort_controller_cb.setToolTip(
                "Mark this board as the designated survivor / abort controller")
            self.cfg_serial_print_cb = QtWidgets.QCheckBox("enable serial printing")
            self.cfg_serial_print_cb.setChecked(self.profile.enable_serial_printing)
            self.cfg_serial_print_cb.setToolTip(
                "enable_serial_printing byte: whether the board keeps printing "
                "its debug stream over USB once configured")
            self.config_btn.setToolTip(
                "WaitingForServer -> Active. Sends the fields above")
            # Same shape as the sensor side: fields first, Send underneath them.
            act_box = QtWidgets.QGroupBox("ACTUATOR_CONFIG fields")
            act_lay = QtWidgets.QVBoxLayout(act_box)
            act_lay.setSpacing(4)
            act_lay.addWidget(self.abort_controller_cb)
            act_lay.addWidget(self.cfg_serial_print_cb)
            act_lay.addWidget(self.config_btn)
            lay.addWidget(act_box)
        else:
            self.config_btn = QtWidgets.QPushButton("Send SENSOR_CONFIG (activate)")
            self.config_btn.setToolTip(
                "WaitingForServer -> SelfTest -> Active. Sends the fields above")
            lay.addWidget(self._build_sensor_config_fields())
        self.config_btn.clicked.connect(self._send_config)

        # Abort path
        abort_row = QtWidgets.QHBoxLayout()
        abort_row.setSpacing(6)
        abort_btn = QtWidgets.QPushButton("ABORT")
        abort_btn.setStyleSheet("color: #d33;")
        abort_btn.clicked.connect(self._send_abort)
        clear_btn = QtWidgets.QPushButton("Clear Abort")
        clear_btn.clicked.connect(self._send_clear_abort)
        noconn_btn = QtWidgets.QPushButton("No-Conn Abort")
        noconn_btn.clicked.connect(self._send_no_conn_abort)
        abort_row.addWidget(abort_btn)
        abort_row.addWidget(clear_btn)
        abort_row.addWidget(noconn_btn)
        abort_row.addStretch(1)
        lay.addLayout(abort_row)

        if self.profile.kind == "actuator":
            lay.addWidget(self._muted("Actuators — toggle sends ACTUATOR_COMMAND:"))
            act_grid = QtWidgets.QGridLayout()
            act_grid.setSpacing(4)
            ids = self.profile.display_connectors()
            for i, cid in enumerate(ids):
                btn = QtWidgets.QPushButton(str(cid))
                btn.setCheckable(True)
                btn.setFixedWidth(48)
                btn.setToolTip(self.profile.connector_label(cid))
                btn.setStyleSheet(
                    "QPushButton:checked { background-color: #2e7d32; color: white; }")
                btn.toggled.connect(lambda on, c=cid: self._on_actuator_toggle(c, on))
                self.actuator_buttons[cid] = btn
                act_grid.addWidget(btn, i // 5, i % 5)
            lay.addLayout(act_grid)

            off_row = QtWidgets.QHBoxLayout()
            all_off_btn = QtWidgets.QPushButton("All OFF")
            all_off_btn.clicked.connect(self._all_actuators_off)
            off_row.addWidget(all_off_btn)
            off_row.addStretch(1)
            lay.addLayout(off_row)

            # PWM command row
            lay.addWidget(self._muted("PWM — id / duration ms / duty / Hz:"))
            pwm_row = QtWidgets.QHBoxLayout()
            pwm_row.setSpacing(4)
            self.pwm_id_combo = QtWidgets.QComboBox()
            for cid in ids:
                self.pwm_id_combo.addItem(str(cid), cid)
            self.pwm_duration_spin = QtWidgets.QSpinBox()
            self.pwm_duration_spin.setRange(1, 600000)
            self.pwm_duration_spin.setValue(self.profile.pwm_duration_ms)
            self.pwm_duty_spin = QtWidgets.QDoubleSpinBox()
            self.pwm_duty_spin.setRange(0.0, 1.0)
            self.pwm_duty_spin.setSingleStep(0.05)
            self.pwm_duty_spin.setDecimals(2)
            self.pwm_duty_spin.setValue(self.profile.pwm_duty_cycle)
            self.pwm_freq_spin = QtWidgets.QDoubleSpinBox()
            self.pwm_freq_spin.setRange(0.1, 1000.0)
            self.pwm_freq_spin.setDecimals(1)
            self.pwm_freq_spin.setValue(self.profile.pwm_frequency_hz)
            pwm_btn = QtWidgets.QPushButton("Send PWM")
            pwm_btn.clicked.connect(self._send_pwm)
            for w in (self.pwm_id_combo, self.pwm_duration_spin,
                      self.pwm_duty_spin, self.pwm_freq_spin, pwm_btn):
                pwm_row.addWidget(w)
            pwm_row.addStretch(1)
            lay.addLayout(pwm_row)

        return g

    def _build_sensor_config_fields(self) -> QtWidgets.QGroupBox:
        """Editable copy of every field that goes into SENSOR_CONFIG.

        The wire layout is (see protocol.build_sensor_config and
        lib/DAQv2-Comms/src/DiabloPackets.h ``SensorConfigData``):
            num_sensors, sensor_ids[N], reference_voltage, necessary_for_abort,
            [controller_ip if necessary_for_abort], enable_serial_printing
        Defaults come from the BoardProfile; change them here to send something
        other than the profile's values without editing the profile.
        """
        g = QtWidgets.QGroupBox("SENSOR_CONFIG fields")
        grid = QtWidgets.QGridLayout(g)
        grid.setColumnStretch(1, 1)
        grid.setSpacing(4)

        def key(text: str, row: int) -> None:
            lbl = QtWidgets.QLabel(text)
            lbl.setStyleSheet("color: #999;")
            lbl.setWordWrap(True)
            grid.addWidget(lbl, row, 0)

        key("Sensor ids", 0)
        self.cfg_ids_edit = QtWidgets.QLineEdit(
            ", ".join(str(c) for c in self.profile.display_connectors()))
        self.cfg_ids_edit.setToolTip(
            "Connector ids the board should sample, comma separated. "
            "Defaults to this profile's active connectors.")
        grid.addWidget(self.cfg_ids_edit, 0, 1)

        key("Reference voltage", 1)
        self.cfg_ref_combo = QtWidgets.QComboBox()
        for val in sorted(REFERENCE_VOLTAGE_LABELS):
            self.cfg_ref_combo.addItem(f"{val} — {REFERENCE_VOLTAGE_LABELS[val]}", val)
        idx = self.cfg_ref_combo.findData(self.profile.reference_voltage)
        if idx >= 0:
            self.cfg_ref_combo.setCurrentIndex(idx)
        self.cfg_ref_combo.setToolTip("ADC full-scale reference the board uses")
        grid.addWidget(self.cfg_ref_combo, 1, 1)

        self.cfg_abort_cb = QtWidgets.QCheckBox("necessary for abort")
        self.cfg_abort_cb.setChecked(self.profile.necessary_for_abort)
        self.cfg_abort_cb.setToolTip(
            "If set, the board is abort-critical and the controller IP below "
            "is included in the packet")
        grid.addWidget(self.cfg_abort_cb, 2, 0, 1, 2)

        key("Controller IP", 3)
        self.cfg_controller_ip = QtWidgets.QLineEdit("0.0.0.0")
        self.cfg_controller_ip.setToolTip(
            "Abort controller the board reports to. Only sent when "
            "'necessary for abort' is checked.")
        grid.addWidget(self.cfg_controller_ip, 3, 1)

        self.cfg_serial_print_cb = QtWidgets.QCheckBox("enable serial printing")
        self.cfg_serial_print_cb.setChecked(self.profile.enable_serial_printing)
        self.cfg_serial_print_cb.setToolTip(
            "Whether the board keeps printing its debug stream over USB once "
            "configured — uncheck and the serial pane goes quiet")
        grid.addWidget(self.cfg_serial_print_cb, 4, 0, 1, 2)

        # The Send button belongs with the fields it sends, at the bottom of
        # the box — not floating above them.
        grid.addWidget(self.config_btn, 5, 0, 1, 2)

        self.cfg_abort_cb.toggled.connect(self.cfg_controller_ip.setEnabled)
        self.cfg_controller_ip.setEnabled(self.cfg_abort_cb.isChecked())
        return g

    def _config_sensor_ids(self) -> List[int]:
        """Parse the sensor-id field; fall back to the profile if it is unusable."""
        text = self.cfg_ids_edit.text().replace(",", " ")
        try:
            ids = [int(tok) for tok in text.split()]
        except ValueError:
            ids = []
        if not ids:
            ids = self.profile.display_connectors()
            self.log.warning("Sensor ids field unreadable — falling back to %s", ids)
        return ids

    # -- send-side control handlers ------------------------------------------
    def _link_or_warn(self) -> Optional[UdpLink]:
        if self.link is None:
            self.log.warning("Cannot send — start the Ethernet UDP listener first")
            return None
        return self.link

    def _auto_heartbeat_tick(self) -> None:
        # silent (200 ms cadence would swamp the log); errors surface via status
        if self.link is not None and self.auto_hb_cb.isChecked():
            self.link.send_server_heartbeat(self.engine_combo.currentData())

    def _send_heartbeat_now(self) -> None:
        link = self._link_or_warn()
        if link and link.send_server_heartbeat(self.engine_combo.currentData()):
            self.log.info("Sent SERVER_HEARTBEAT (engine=%s) -> %s:%d",
                          self.engine_combo.currentText(), link.target_ip,
                          self.profile.control_port)

    def _send_config(self) -> None:
        link = self._link_or_warn()
        if link is None:
            return
        ids = self.profile.display_connectors()
        if self.profile.kind == "actuator":
            board_ip = link.target_ip
            locations = [
                protocol.AbortActuatorLocation(
                    board_ip, cid,
                    self.profile.abort_vent_states.get(cid, 0),
                    self.profile.abort_abort_states.get(cid, 0))
                for cid in ids
            ]
            ok = link.send_actuator_config(
                is_abort_controller=self.abort_controller_cb.isChecked(),
                abort_actuators=locations,
                abort_pts=[],
                enable_serial_printing=self.cfg_serial_print_cb.isChecked())
            if ok:
                self.log.info(
                    "Sent ACTUATOR_CONFIG (controller=%d, %d actuators @ %s) -> %s:%d",
                    self.abort_controller_cb.isChecked(), len(locations), board_ip,
                    link.target_ip, self.profile.control_port)
        else:
            ids = self._config_sensor_ids()
            ref = self.cfg_ref_combo.currentData()
            for_abort = self.cfg_abort_cb.isChecked()
            ok = link.send_sensor_config(
                sensor_ids=ids,
                reference_voltage=ref,
                necessary_for_abort=for_abort,
                controller_ip=self.cfg_controller_ip.text().strip() if for_abort else None,
                enable_serial_printing=self.cfg_serial_print_cb.isChecked())
            if ok:
                self.log.info(
                    "Sent SENSOR_CONFIG (ids=%s, ref=%d, abort=%d, controller=%s, "
                    "serial_print=%d) -> %s:%d",
                    ids, ref, for_abort,
                    self.cfg_controller_ip.text().strip() if for_abort else "-",
                    self.cfg_serial_print_cb.isChecked(),
                    link.target_ip, self.profile.control_port)

    def _send_abort(self) -> None:
        link = self._link_or_warn()
        if link and link.send_abort():
            self.log.info("Sent ABORT -> %s:%d", link.target_ip, self.profile.control_port)

    def _send_clear_abort(self) -> None:
        link = self._link_or_warn()
        if link and link.send_clear_abort():
            self.log.info("Sent CLEAR_ABORT -> %s:%d", link.target_ip, self.profile.control_port)

    def _send_no_conn_abort(self) -> None:
        link = self._link_or_warn()
        if link and link.send_no_connection_abort():
            self.log.info("Sent NO_CONNECTION_ABORT -> %s:%d",
                          link.target_ip, self.profile.control_port)

    def _on_actuator_toggle(self, cid: int, on: bool) -> None:
        if self.link is None:
            self.log.warning("Cannot send — start the Ethernet UDP listener first")
            btn = self.actuator_buttons[cid]
            btn.blockSignals(True)
            btn.setChecked(not on)
            btn.blockSignals(False)
            return
        if self.link.send_actuator_command(
                [protocol.ActuatorCommand(cid, 1 if on else 0)]):
            self.log.info("Sent ACTUATOR_COMMAND: actuator %d -> %s", cid,
                          "ON" if on else "OFF")

    def _all_actuators_off(self) -> None:
        link = self._link_or_warn()
        if link is None:
            return
        ids = self.profile.display_connectors()
        if link.send_actuator_command(
                [protocol.ActuatorCommand(cid, 0) for cid in ids]):
            self.log.info("Sent ACTUATOR_COMMAND: all OFF (%s)", ids)
        for btn in self.actuator_buttons.values():
            btn.blockSignals(True)
            btn.setChecked(False)
            btn.blockSignals(False)

    def _send_pwm(self) -> None:
        link = self._link_or_warn()
        if link is None:
            return
        cmd = protocol.PWMActuatorCommand(
            actuator_id=self.pwm_id_combo.currentData(),
            duration_ms=self.pwm_duration_spin.value(),
            duty_cycle=self.pwm_duty_spin.value(),
            frequency_hz=self.pwm_freq_spin.value())
        if link.send_pwm_actuator_command([cmd]):
            self.log.info("Sent PWM_ACTUATOR_COMMAND: id=%d %dms duty=%.2f %.1fHz",
                          cmd.actuator_id, cmd.duration_ms, cmd.duty_cycle,
                          cmd.frequency_hz)

    def _build_heartbeat_group(self) -> QtWidgets.QGroupBox:
        """SERVER_HEARTBEAT — the keep-alive, kept apart from the config controls.

        This is the one control you leave running for a whole session rather
        than click once, so it sits at the bottom of the column, out of the way
        of the config/abort buttons.
        """
        g = QtWidgets.QGroupBox("Server heartbeat")
        lay = QtWidgets.QVBoxLayout(g)
        lay.setSpacing(4)

        self.auto_hb_cb = QtWidgets.QCheckBox("Auto SERVER_HEARTBEAT")
        self.auto_hb_cb.setToolTip(
            f"Send SERVER_HEARTBEAT every {self.profile.server_heartbeat_interval_ms} ms "
            "(what the production DAQ server does)")
        lay.addWidget(self.auto_hb_cb)

        row = QtWidgets.QHBoxLayout()
        row.setSpacing(6)
        eng_lbl = QtWidgets.QLabel("Engine state")
        eng_lbl.setStyleSheet("color: #999;")
        row.addWidget(eng_lbl)
        self.engine_combo = QtWidgets.QComboBox()
        for val in sorted(protocol.ENGINE_STATE_NAMES):
            self.engine_combo.addItem(protocol.ENGINE_STATE_NAMES[val], val)
        self.engine_combo.setToolTip("Engine state carried in the heartbeat")
        row.addWidget(self.engine_combo, 1)
        lay.addLayout(row)

        hb_btn = QtWidgets.QPushButton("Send one SERVER_HEARTBEAT")
        hb_btn.setToolTip("Send a single heartbeat now, without the auto cadence")
        hb_btn.clicked.connect(self._send_heartbeat_now)
        lay.addWidget(hb_btn)
        return g

    def _build_readings_group(self) -> QtWidgets.QGroupBox:
        g = QtWidgets.QGroupBox(f"Live {self.profile.reading_name} — per connector")
        lay = QtWidgets.QVBoxLayout(g)

        # rolling time window for the x axis
        win_row = QtWidgets.QHBoxLayout()
        win_row.setSpacing(6)
        win_lbl = QtWidgets.QLabel("Time window")
        win_lbl.setStyleSheet("color: #999;")
        win_row.addWidget(win_lbl)
        self.window_combo = QtWidgets.QComboBox()
        for label, seconds in TIME_WINDOWS:
            self.window_combo.addItem(label, seconds)
        self.window_combo.setCurrentText(DEFAULT_WINDOW_LABEL)
        self.window_combo.setToolTip(
            "How much history the plot shows. The y axis rescales to whatever "
            "is inside this window, not the whole buffer.")
        self.window_combo.currentIndexChanged.connect(self._apply_time_window)
        win_row.addWidget(self.window_combo)

        filt_lbl = QtWidgets.QLabel("Filter")
        filt_lbl.setStyleSheet("color: #999;")
        win_row.addWidget(filt_lbl)
        self.filter_combo = QtWidgets.QComboBox()
        self.filter_combo.setMinimumWidth(180)
        self.filter_combo.setToolTip(
            "Noise filter applied to the displayed trace and the value column. "
            "The raw ADC code and % of full scale stay unfiltered.")
        self.filter_combo.currentIndexChanged.connect(self._rebuild_filters)
        win_row.addWidget(self.filter_combo)
        self.show_raw_cb = QtWidgets.QCheckBox("show raw")
        self.show_raw_cb.setToolTip("Overlay the unfiltered trace faintly behind the filtered one")
        win_row.addWidget(self.show_raw_cb)
        self.compare_btn = QtWidgets.QPushButton("Compare filters")
        self.compare_btn.setToolTip(
            "Run every candidate filter over the buffered data and rank them by "
            "noise reduction, with each one's lag priced as a reading error")
        self.compare_btn.clicked.connect(self._compare_filters)
        self.drift_btn = QtWidgets.QPushButton("Drift analysis")
        self.drift_btn.setToolTip(
            "Allan deviation: how the reading's spread changes with averaging "
            "time. Finds the best averaging time and says whether drift or "
            "white noise is limiting you.")
        self.drift_btn.clicked.connect(self._drift_analysis)
        win_row.addWidget(self.drift_btn)
        self._populate_filter_combo()
        win_row.addWidget(self.compare_btn)
        win_row.addStretch(1)
        lay.addLayout(win_row)

        # Antialiasing is the single most expensive option for a dense live
        # trace — Qt rasterises every segment with coverage blending. At one
        # sample per pixel column it buys almost nothing visually, so it is off
        # here (it stays on for text/axes, which are drawn once).
        pg.setConfigOptions(antialias=False)
        self.plot = pg.PlotWidget()
        self.plot.setBackground("#101216")
        self.plot.showGrid(x=True, y=True, alpha=0.25)
        self.plot.setLabel("bottom", "time", units="s")
        self.plot.setLabel("left", self.profile.reading_name, units=self.profile.value_unit)
        self.plot.addLegend(offset=(10, 10))
        # Autoscale y to the data actually on screen. Without setAutoVisible the
        # view fits every point in the buffer, so one old spike flattens the
        # live trace even after it has scrolled out of the window.
        vb = self.plot.getViewBox()
        vb.setAutoVisible(y=True)
        vb.enableAutoRange(axis="y")
        # Draw only what is on screen, and thin it to roughly one sample per
        # pixel column. Without these, a full buffer is re-rasterised every
        # frame — ~125 ms at 6000 pts x 3 curves, against a 100 ms timer.
        # "peak" keeps spikes visible while thinning, which matters for a
        # sensor trace.
        self.plot.setClipToView(True)
        self.plot.setDownsampling(auto=True, mode="peak")
        # auto downsampling still leaves ~3 points per pixel column; _refresh_plot
        # tightens this to the widget width each frame (see _bound_draw_cost).
        self._last_ds = 1
        lay.addWidget(self.plot, stretch=1)

        # per-connector current-value table + toggle
        table = QtWidgets.QGridLayout()
        table.addWidget(self._muted("Connector"), 0, 0)
        table.addWidget(self._muted("Raw ADC code"), 0, 1)
        # No fixed unit in the header — the value is SI-scaled per reading.
        table.addWidget(self._muted(self.profile.reading_name), 0, 2)
        table.addWidget(self._muted("% of full scale"), 0, 3)
        table.addWidget(self._muted("Plot"), 0, 4)
        row = 1
        for cid in self.profile.display_connectors():
            color = _COLORS[(cid - 1) % len(_COLORS)]
            # Plain lists, not deques: _refresh_plot bisects for the visible
            # window and slices it out, so only on-screen points reach
            # pyqtgraph. Trimming is batched in _append_reading.
            self.readings[cid] = ([], [])
            name = self.profile.connector_label(cid)
            name_lbl = QtWidgets.QLabel(f"● {name}")
            name_lbl.setStyleSheet(f"color: rgb{color};")
            raw_lbl = QtWidgets.QLabel("—")
            raw_lbl.setAlignment(ALIGN_RIGHT)
            val_lbl = QtWidgets.QLabel("—")
            val_lbl.setAlignment(ALIGN_RIGHT)
            vf = val_lbl.font()
            vf.setWeight(FONT_BOLD)
            val_lbl.setFont(vf)
            fs_lbl = QtWidgets.QLabel("—")
            fs_lbl.setAlignment(ALIGN_RIGHT)
            fs_lbl.setToolTip(
                "Signed ADC code as a percentage of the converter's full-scale "
                "range (±2³¹). Independent of the reference "
                "voltage and the PGA setting.")
            cb = QtWidgets.QCheckBox()
            cb.setChecked(True)
            self.conn_value_labels[cid] = val_lbl
            self.conn_fs_labels[cid] = fs_lbl
            self.value_labels[f"raw_{cid}"] = raw_lbl
            self.conn_checkboxes[cid] = cb
            table.addWidget(name_lbl, row, 0)
            table.addWidget(raw_lbl, row, 1)
            table.addWidget(val_lbl, row, 2)
            table.addWidget(fs_lbl, row, 3, alignment=ALIGN_RIGHT)
            table.addWidget(cb, row, 4, alignment=ALIGN_CENTER)

            # faint unfiltered ghost, drawn under the filtered trace
            ghost = self.plot.plot([], [], pen=pg.mkPen(color=color + (70,), width=1))
            self.raw_curves[cid] = ghost
            curve = self.plot.plot([], [], pen=pg.mkPen(color=color, width=1), name=name)
            self.plot_curves[cid] = curve
            self.filtered[cid] = []
            row += 1
        lay.addLayout(table)
        return g

    def _build_logs_tab(self) -> QtWidgets.QWidget:
        tab = QtWidgets.QWidget()
        lay = QtWidgets.QVBoxLayout(tab)
        lay.setContentsMargins(0, 6, 0, 0)
        lay.setSpacing(6)

        # options row: what to echo into the log
        opts = QtWidgets.QHBoxLayout()
        self.log_eth_cb = QtWidgets.QCheckBox("echo Ethernet packets")
        self.log_eth_cb.setChecked(True)
        self.log_eth_cb.setToolTip("Log every UDP packet received from the board over Ethernet")
        self.raw_serial_cb = QtWidgets.QCheckBox("echo raw serial")
        self.raw_serial_cb.setToolTip("Log every line the board prints over USB serial")
        opts.addWidget(self.log_eth_cb)
        opts.addWidget(self.raw_serial_cb)
        opts.addStretch(1)
        clear_btn = QtWidgets.QPushButton("Clear")
        clear_btn.clicked.connect(lambda: self.log_view.clear())
        opts.addWidget(clear_btn)
        lay.addLayout(opts)

        self.log_view = QtWidgets.QPlainTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setMaximumBlockCount(5000)
        mono = QtGui.QFont("Menlo")
        mono.setStyleHint(QtGui.QFont.StyleHint.Monospace if hasattr(QtGui.QFont, "StyleHint")
                          else QtGui.QFont.Monospace)
        self.log_view.setFont(mono)
        lay.addWidget(self.log_view, stretch=1)

        path_lbl = QtWidgets.QLabel(f"Also writing to {self.log_path}")
        path_lbl.setStyleSheet("color: #777;")
        lay.addWidget(path_lbl)
        return tab

    def _muted(self, text: str) -> QtWidgets.QLabel:
        lbl = QtWidgets.QLabel(text)
        lbl.setStyleSheet("color: #999;")
        return lbl

    # -- logging -> console --------------------------------------------------
    def _wire_logging(self) -> None:
        self._qt_log = QtLogHandler()
        self._qt_log.setFormatter(logging.Formatter("%(asctime)s.%(msecs)03d  %(message)s", "%H:%M:%S"))
        self._qt_log.record.connect(self._append_log)
        self.log.addHandler(self._qt_log)

    def _append_log(self, line: str) -> None:
        self.log_view.appendPlainText(line)
        self.log_view.moveCursor(TEXTCURSOR_END)

    # -- link control --------------------------------------------------------
    def _toggle_link(self) -> None:
        if self.link is not None:
            self._stop_link()
        else:
            self._start_link()

    def _start_link(self) -> None:
        if self.link is not None:
            return
        self.link = UdpLink(self.profile, bind_ip=self.bind_ip)
        self.link.heartbeat_received.connect(self._on_heartbeat)
        self.link.sensor_data_received.connect(self._on_sensor_data)
        self.link.self_test_received.connect(self._on_self_test)
        self.link.malformed_received.connect(self._on_malformed)
        self.link.packet_received.connect(self._on_eth_packet)
        self.link.status.connect(self._on_link_status)
        self.link.board_discovered.connect(self._on_board_discovered)
        self.link.start()
        self.listen_btn.setText("Stop Ethernet UDP")

    def _stop_link(self) -> None:
        if self.link is None:
            return
        self.link.stop()
        self.link.wait(1500)
        self.link = None
        self.listen_btn.setText("Start Ethernet UDP")
        self.value_labels["listener"].setText("stopped")
        self.log.info("Stopped Ethernet UDP listener")

    # -- serial (USB) control ------------------------------------------------
    def _refresh_ports(self) -> None:
        current = self.port_combo.currentText()
        ports = list_ports()
        self.port_combo.clear()
        for dev, desc in ports:
            label = f"{dev}   ({desc})" if desc else dev
            self.port_combo.addItem(label, dev)
        if current:
            self.port_combo.setEditText(current)
        elif ports:
            self.port_combo.setCurrentIndex(0)  # best-guess board port first
        if not ports:
            self.port_combo.setEditText("")
            missing = pyserial_error()
            if missing:
                # Don't report a missing dependency as "no board plugged in".
                self.port_combo.lineEdit().setPlaceholderText(missing)
                if not self._warned_no_pyserial:
                    self._warned_no_pyserial = True
                    self.log.warning("%s (using %s)", missing, sys.executable)
            else:
                self.port_combo.lineEdit().setPlaceholderText(
                    "no serial ports found — plug in the board")

    def _selected_port(self) -> str:
        # itemData holds the bare device path; editable text may include the desc.
        idx = self.port_combo.currentIndex()
        data = self.port_combo.itemData(idx) if idx >= 0 else None
        text = self.port_combo.currentText().strip()
        # if the user typed/kept the "dev (desc)" label, take the part before "  ("
        if data and text.startswith(str(data)):
            return str(data)
        return text.split("  (")[0].strip()

    def _toggle_serial(self) -> None:
        if self.serial is not None:
            self._stop_serial()
        else:
            self._start_serial()

    def _start_serial(self) -> None:
        if self.serial is not None:
            return
        port = self._selected_port()
        if not port:
            self.log.warning("No serial port selected")
            return
        baud = self.baud_combo.currentData() or int(self.baud_combo.currentText())
        self.serial = SerialLink(port, baud)
        self.serial.line_received.connect(self._on_serial_line)
        self.serial.opened.connect(self._on_serial_opened)
        self.serial.closed.connect(self._on_serial_closed)
        self.serial.error.connect(self._on_serial_error)
        self.serial.start()
        self.serial_btn.setText("Disconnect")
        self.port_combo.setEnabled(False)
        self.baud_combo.setEnabled(False)
        self.refresh_btn.setEnabled(False)
        self.log.info("Opening serial %s @ %d baud…", port, baud)

    def _stop_serial(self) -> None:
        if self.serial is None:
            return
        self.serial.stop()
        self.serial.wait(1500)
        self.serial = None
        self.serial_btn.setText("Connect")
        self.port_combo.setEnabled(True)
        self.baud_combo.setEnabled(True)
        self.refresh_btn.setEnabled(True)
        self.serial_state_text = None
        self.log.info("Disconnected serial")

    def _on_serial_opened(self, port: str) -> None:
        self.log.info("Serial connected: %s", port)

    def _on_serial_closed(self) -> None:
        self.log.info("Serial closed")

    def _on_serial_error(self, msg: str) -> None:
        self.log.warning("Serial: %s", msg)
        # roll the button back so the user can retry
        self.serial = None
        self.serial_btn.setText("Connect")
        self.port_combo.setEnabled(True)
        self.baud_combo.setEnabled(True)
        self.refresh_btn.setEnabled(True)

    def _on_serial_line(self, line: str) -> None:
        if self.raw_serial_cb.isChecked():
            self.log.info("[serial] %s", line)
        event = self.parser.feed(line)
        if event:
            self._apply_serial_event(event)

    def _apply_serial_event(self, e: dict) -> None:
        kind = e["kind"]
        now = time.time()
        if kind == "state":
            if e["value"] != self.serial_state_text:
                self.log.info("Board state -> %s", e["value"])
            self.serial_state_text = e["value"]
            self.value_labels["board_state"].setText(e["value"])
        elif kind == "fw_hash":
            self.value_labels["fw_hash"].setText(e["value"][:16] + "…")
            self.value_labels["fw_hash"].setToolTip("SHA-256: " + e["value"])
        elif kind == "identity":
            self.value_labels["reported_id"].setText(str(e["board_id"]))
        elif kind == "eth":
            if e["field"] == "link":
                self.value_labels["src_ip"].setText(f"link {e['value']}")
            elif e["field"] == "ip":
                self._update_conn_detail(e["value"], discovered=True)
        elif kind == "heartbeat_sent":
            self.last_heartbeat_time = now
            self.heartbeat_times.append(now)
            self.heartbeat_count += 1
        elif kind == "sensor_sent":
            self.last_sensor_data_time = now
            self.sensor_packet_count += 1
        elif kind == "packet_rx":
            self.log.info("Board received %s from %s", e["name"], e["src"])
        elif kind == "readings":
            ts_ms = e.get("timestamp_ms")
            base_t = (now - self.start_time if ts_ms is None
                      else self._plot_times(self._clock_key, time.time_ns(), [ts_ms])[0])
            for cid, raw in e["values"].items():
                if cid not in self.readings:
                    continue
                self._append_reading(cid, base_t, self.profile.decode_value(raw))
                self.last_raw[cid] = raw
            self.last_sensor_data_time = now

    # -- receive slots -------------------------------------------------------
    def _on_heartbeat(self, hb: protocol.BoardHeartbeat, src_ip: str) -> None:
        now = time.time()
        first = self.last_heartbeat_time is None
        self.last_heartbeat = hb
        self.last_heartbeat_time = now
        self.heartbeat_times.append(now)
        self.heartbeat_count += 1
        self.value_labels["board_state"].setText(protocol.board_state_name(hb.board_state))
        if first:
            self.log.info("Board online: id=%d state=%s engine=%s fw=%s… from %s",
                          hb.board_id, protocol.board_state_name(hb.board_state),
                          protocol.engine_state_name(hb.engine_state),
                          hb.firmware_hash_hex[:8], src_ip)

    def _on_sensor_data(self, sd: protocol.SensorData, src_ip: str) -> None:
        arrival_ns = time.time_ns()
        self.last_sensor_data_time = arrival_ns / 1e9
        self.sensor_packet_count += 1
        # Collect the distinct chunk timestamps in send order and stamp the
        # packet in one call — the same shape as the bridge's clock-sync block
        # (daq_bridge_main.cpp, "Clock sync: per-chunk corrected timestamps").
        chunk_ms: List[int] = []
        for chunk in sd.chunks:
            if not chunk_ms or chunk_ms[-1] != chunk.timestamp_ms:
                chunk_ms.append(chunk.timestamp_ms)
        x_by_ts = dict(zip(chunk_ms,
                           self._plot_times(self._clock_key, arrival_ns, chunk_ms)))
        default_x = arrival_ns / 1e9 - self.start_time
        for chunk in sd.chunks:
            chunk_t = x_by_ts.get(chunk.timestamp_ms, default_x)
            for dp in chunk.datapoints:
                if dp.sensor_id not in self.readings:
                    continue
                self._append_reading(dp.sensor_id, chunk_t,
                                     self.profile.decode_value(dp.raw))
                self.last_raw[dp.sensor_id] = dp.raw

    def _on_self_test(self, st: protocol.SelfTest, src_ip: str) -> None:
        passed = sum(1 for r in st.results if r.passed)
        self.log.info("SELF_TEST: ADC %s, connectors %d/%d passed",
                      "OK" if st.adc_good else "FAIL", passed, len(st.results))

    def _on_malformed(self, size: int, src_ip: str) -> None:
        self.log.warning("Malformed packet (%d bytes) from %s", size, src_ip)

    def _on_eth_packet(self, ptype: int, size: int, src_ip: str) -> None:
        """Echo each Ethernet packet to the log (throttle high-rate sensor data)."""
        if not self.log_eth_cb.isChecked():
            return
        if ptype == protocol.PacketType.SENSOR_DATA:
            now = time.time()
            if now - self._last_eth_data_log < 1.0:
                return
            self._last_eth_data_log = now
        self.log.info("[eth] %-16s %4dB  from %s",
                      protocol.packet_type_name(ptype), size, src_ip)

    def _on_link_status(self, text: str) -> None:
        self.value_labels["listener"].setText(text)
        self.log.info("Link: %s", text)

    def _on_board_discovered(self, ip: str) -> None:
        """Board announced itself; retarget commands at its real IP."""
        prev = self.board_ip_edit.text().strip()
        if ip != prev:
            self.log.info("Board discovered at %s (was targeting %s) — retargeting there",
                          ip, prev)
        else:
            self.log.info("Board discovered at %s", ip)
        self._update_conn_detail(ip, discovered=True)

    def _apply_board_ip(self) -> None:
        """User typed/confirmed a Board IP: send control packets there."""
        ip = self.board_ip_edit.text().strip()
        if not self._looks_like_ip(ip):
            self.log.warning("Board IP '%s' is not a valid IPv4 address", ip)
            self.board_ip_edit.setText(self.profile.board_ip)  # revert
            return
        if ip == self.profile.board_ip and (self.link is None or self.link.discovered_ip is None):
            return  # no change
        self.profile.board_ip = ip
        if self.link is not None:
            # honor the manual override until the board is re-discovered
            self.link.discovered_ip = None
        self.log.info("Board IP set to %s — control packets -> %s:%d",
                      ip, ip, self.profile.control_port)
        self._update_conn_detail(ip, discovered=False)

    @staticmethod
    def _looks_like_ip(ip: str) -> bool:
        parts = ip.split(".")
        if len(parts) != 4:
            return False
        try:
            return all(0 <= int(p) <= 255 for p in parts)
        except ValueError:
            return False

    def _update_conn_detail(self, effective_ip: str, discovered: bool = False) -> None:
        # keep the editable field in sync without re-triggering editingFinished
        if self.board_ip_edit.text().strip() != effective_ip:
            self.board_ip_edit.blockSignals(True)
            self.board_ip_edit.setText(effective_ip)
            self.board_ip_edit.blockSignals(False)
        self.profile.board_ip = effective_ip
        note = "  (discovered)" if discovered else ""
        self.conn_detail_label.setText(
            f"control {effective_ip}:{self.profile.control_port}{note}"
            f"  ·  listen UDP :{self.profile.listen_port}")

    # -- periodic refresh ----------------------------------------------------
    def _refresh(self) -> None:
        # Filter windows are specified in seconds, so if the measured sample
        # rate moves materially the candidate list has to be resized.
        fs = self._estimate_fs()
        if self._bank_fs is None or abs(fs - self._bank_fs) / self._bank_fs > 0.2:
            self._bank_fs = fs
            self._populate_filter_combo()
            self._rebuild_filters()
        self._refresh_connection_light()
        self._refresh_status()
        self._refresh_packets()

    def _refresh_connection_light(self) -> None:
        # The top-left light reflects the SERIAL (USB) link the user chose.
        if self.serial is not None:
            silence = self.serial.seconds_since_last_line()
            self.serial_activity.setText(
                f"{self.serial.total_lines} lines · {self._fmt_bytes(self.serial.total_bytes)}")
            if silence is None:
                self.status_light.set_state((220, 170, 60), "Opening… (waiting for data)")
            elif silence <= self.profile.serial_silence_sec:
                self.status_light.set_state((60, 200, 90), "Connected")
            else:
                self.status_light.set_state((220, 170, 60),
                                            f"Connected, no data ({silence:.0f}s)")
            return
        # No serial connection: fall back to reflecting the Ethernet/UDP path.
        self.serial_activity.setText("")
        if (self.link is not None and self.last_heartbeat_time is not None
                and time.time() - self.last_heartbeat_time <= self.profile.heartbeat_timeout_sec):
            self.status_light.set_state((60, 200, 90), "Connected (Ethernet)")
        else:
            self.status_light.set_state((120, 120, 120), "Not connected")

    def _refresh_status(self) -> None:
        hb = self.last_heartbeat
        if hb is not None:
            # live Ethernet heartbeat carries board id + firmware hash
            self.value_labels["reported_id"].setText(str(hb.board_id))
            self.value_labels["fw_hash"].setText(hb.firmware_hash_hex[:16] + "…")
            self.value_labels["fw_hash"].setToolTip("SHA-256: " + hb.firmware_hash_hex)
        # heartbeat timing works for either source (serial 'Sent: heartbeat' or UDP)
        if self.last_heartbeat_time is not None:
            self.value_labels["hb_age"].setText(f"{time.time() - self.last_heartbeat_time:.1f} s ago")
            self.value_labels["hb_rate"].setText(f"{self._hb_rate():.2f} Hz")
            self.value_labels["hb_count"].setText(str(self.heartbeat_count))

    def _hb_rate(self) -> float:
        if len(self.heartbeat_times) < 2:
            return 0.0
        span = self.heartbeat_times[-1] - self.heartbeat_times[0]
        return (len(self.heartbeat_times) - 1) / span if span > 0 else 0.0

    def _refresh_packets(self) -> None:
        if self.link is None:
            return
        s = self.link.get_stats()
        self.value_labels["src_ip"].setText(s.last_src_ip)
        self.value_labels["pkt_total"].setText(str(s.total_packets))
        self.value_labels["pkt_rate"].setText(f"{s.rate_pps():.1f} /s")
        self.value_labels["bytes_total"].setText(self._fmt_bytes(s.total_bytes))
        self.value_labels["bytes_rate"].setText(f"{self._fmt_bytes(s.bytes_per_sec())}/s")
        self.value_labels["cnt_hb"].setText(str(s.by_type.get(protocol.PacketType.BOARD_HEARTBEAT, 0)))

    def _append_reading(self, cid: int, t: float, value: float) -> None:
        """Append one sample, trimming the buffer in batches.

        Trimming every append would be O(n) per sample; doing it once per
        overflow block keeps it amortised O(1).
        """
        ts, vs = self.readings[cid]
        # Belt-and-braces: _refresh_plot bisects this list, and pyqtgraph draws
        # points in array order, so a single out-of-order x would draw a line
        # running backwards. The clock sync already guarantees monotonicity per
        # key; this holds the line if a sample ever arrives by another route.
        if ts and t < ts[-1]:
            t = ts[-1]
        ts.append(t)
        vs.append(value)
        f = self._filter_objs.get(cid)
        self.filtered.setdefault(cid, []).append(f.update(value) if f else value)
        if len(ts) > MAX_POINTS_PER_CHANNEL + TRIM_SLACK:
            cut = len(ts) - MAX_POINTS_PER_CHANNEL
            del ts[:cut]
            del vs[:cut]
            del self.filtered[cid][:cut]

    def _plot_times(self, board_key: str, arrival_ns: int,
                    chunk_ms: List[int]) -> List[float]:
        """Chunk board-millis -> x positions (seconds since the GUI started).

        Delegates to the same BoardClockSync the DAQ bridge uses, so a chunk
        lands at the same instant here as it does in the server's recording:
        the board's millis() spacing is preserved and network jitter is
        filtered out, instead of every chunk in a packet collapsing onto the
        arrival time.
        """
        stamped = self.clock_sync.stamp_packet(board_key, arrival_ns, chunk_ms)
        return [ns / 1e9 - self.start_time for ns in stamped]

    @staticmethod
    def _fmt_si(value: float, unit: str) -> str:
        """Format a value with an SI prefix, so a load cell reading in the
        microvolts doesn't display as 0.00001 V.

        Steps down V -> mV -> uV -> nV on magnitude, keeping ~4 significant
        figures at every scale.
        """
        a = abs(value)
        if a == 0:
            return f"0 {unit}"
        if a >= 1:
            return f"{value:+.4f} {unit}"
        if a >= 1e-3:
            return f"{value * 1e3:+.4f} m{unit}"
        if a >= 1e-6:
            return f"{value * 1e6:+.3f} µ{unit}"
        return f"{value * 1e9:+.1f} n{unit}"

    # -- noise filtering ------------------------------------------------------
    def _estimate_fs(self) -> float:
        """Samples per second, measured from the buffered timestamps.

        The filters are sized in seconds, so they need the real rate rather than
        the nominal one — chunk cadence varies with the board's config.
        """
        for ts, _ in self.readings.values():
            if len(ts) > 20 and ts[-1] > ts[0]:
                return (len(ts) - 1) / (ts[-1] - ts[0])
        return 100.0

    def _populate_filter_combo(self) -> None:
        """Fill the picker with candidates sized for the measured rate."""
        fs = self._estimate_fs()
        self._filter_bank = filt.default_bank(fs)
        keep = self.filter_combo.currentIndex()
        self.filter_combo.blockSignals(True)
        self.filter_combo.clear()
        for make in self._filter_bank:
            self.filter_combo.addItem(make().label, make)
        if 0 <= keep < self.filter_combo.count():
            self.filter_combo.setCurrentIndex(keep)
        self.filter_combo.blockSignals(False)

    def _rebuild_filters(self) -> None:
        """Re-run the chosen filter over everything already buffered.

        Filtering happens once per sample on arrival (cheap), so changing the
        filter has to replay the buffer to keep the displayed history
        consistent with the new setting.
        """
        make = self.filter_combo.currentData()
        self._filter_factory = make
        for cid, (ts, vs) in self.readings.items():
            f = make() if make else filt.NoFilter()
            self._filter_objs[cid] = f
            self.filtered[cid] = [f.update(v) for v in vs]
        if make:
            self.log.info("Filter: %s (fs ~ %.0f Hz)", make().label, self._estimate_fs())

    def _compare_filters(self) -> None:
        """Rank every candidate over the buffered data and log the table."""
        cid = next((c for c in self.profile.display_connectors()
                    if self.conn_checkboxes[c].isChecked()
                    and len(self.readings[c][0]) >= 64), None)
        if cid is None:
            self.log.warning("Compare filters: need at least 64 samples on a "
                             "plotted connector — start the stream first")
            return
        ts, vs = self.readings[cid]
        fs = self._estimate_fs()
        dt = 1.0 / fs
        # Slope of the current data, so each filter's lag is priced as the
        # reading error it would cause at the rate the load is actually moving.
        span = max(1e-9, ts[-1] - ts[0])
        ramp = (vs[-1] - vs[0]) / span
        reports = filt.compare(vs, dt, filt.default_bank(fs), ramp_rate=ramp)
        if not reports:
            self.log.warning("Compare filters: not enough data")
            return
        unit = self.profile.value_unit
        self.log.info("Filter comparison on %s — %d samples @ %.0f Hz, "
                      "signal slope %s/s",
                      self.profile.connector_label(cid), len(vs), fs,
                      self._fmt_si(ramp, unit))
        self.log.info("  %-26s %12s %8s %9s %12s",
                      "filter", "noise", "vs raw", "lag", "ramp error")
        for r in reports:
            self.log.info("  %-26s %12s %7.1fx %8.0f ms %12s",
                          r.label, self._fmt_si(r.noise, unit),
                          r.noise_reduction, r.lag_s * 1000,
                          self._fmt_si(r.ramp_error, unit))
        best = reports[0]
        pick = filt.suggest(reports)
        self.log.info("  quietest: %s (%.1fx, %.0f ms lag)",
                      best.label, best.noise_reduction, best.lag_s * 1000)
        if pick is not None:
            self.log.info("  suggested: %s — %.1fx noise reduction for only "
                          "%.0f ms lag (%s error while the load is moving)",
                          pick.label, pick.noise_reduction, pick.lag_s * 1000,
                          self._fmt_si(pick.ramp_error, unit))

    def _drift_analysis(self) -> None:
        """Allan deviation of the buffered data — where averaging stops helping."""
        cid = next((c for c in self.profile.display_connectors()
                    if self.conn_checkboxes[c].isChecked()
                    and len(self.readings[c][0]) >= 256), None)
        if cid is None:
            self.log.warning("Drift analysis: need at least 256 samples on a "
                             "plotted connector")
            return
        ts, vs = self.readings[cid]
        fs = self._estimate_fs()
        curve = filt.allan_deviation(vs, 1.0 / fs)
        if not curve:
            self.log.warning("Drift analysis: not enough data")
            return
        unit = self.profile.value_unit
        slope = filt.drift_slope(curve)
        best = filt.optimal_averaging(curve)
        self.log.info("Allan deviation on %s — %d samples @ %.0f Hz (%.1f s)",
                      self.profile.connector_label(cid), len(vs), fs,
                      ts[-1] - ts[0])
        self.log.info("  %10s  %14s", "avg time", "sigma")
        for tau, sigma in curve:
            mark = "  <- best" if best and tau == best[0] else ""
            self.log.info("  %8.3f s  %14s%s", tau, self._fmt_si(sigma, unit), mark)
        if best:
            self.log.info("  best averaging time: %.2f s (sigma %s) "
                          "≈ moving average n=%d",
                          best[0], self._fmt_si(best[1], unit),
                          max(1, int(round(best[0] * fs))))
        if slope is not None:
            if slope < -0.35:
                verdict = ("white-noise limited — averaging longer still "
                           "helps; the buffer may be too short to see drift")
            elif slope < 0.15:
                verdict = ("flicker/1-f limited — averaging longer buys "
                           "almost nothing beyond this point")
            else:
                verdict = ("RANDOM WALK — averaging longer makes the reading "
                           "WORSE. No causal filter fixes this; it has to be "
                           "attacked at the sensor (ratiometric reference, ADC "
                           "chop, thermal settling, cabling)")
            self.log.info("  long-tau slope %+.2f: %s", slope, verdict)

    def _bound_draw_cost(self, points_in_view: int) -> None:
        """Keep painted points near one peak-pair per pixel column.

        pyqtgraph's auto downsampling leaves roughly three points per column,
        which at three curves is ~9000 segments a frame. Pinning the decimation
        to the widget's actual width makes repaint cost flat no matter how wide
        the time window or how full the buffer is.
        """
        # "peak" emits a min/max PAIR per bin, so bins = width gives two points
        # per pixel column and ds = points / width (not / 2*width).
        width_px = max(1, self.plot.width())
        ds = max(1, points_in_view // width_px)
        if ds != self._last_ds:
            self._last_ds = ds
            self.plot.setDownsampling(ds=ds, auto=False, mode="peak")

    def _apply_time_window(self) -> None:
        """Re-range x immediately when the picker changes (don't wait for data)."""
        self._refresh_plot()

    def _refresh_plot(self) -> None:
        now_rel = time.time() - self.start_time
        window = self.window_combo.currentData()
        vb = self.plot.getViewBox()
        if window is None:
            vb.enableAutoRange(axis="x")
        else:
            # Anchor the window to the newest sample when data is flowing, so a
            # stalled stream leaves the last trace on screen instead of
            # scrolling off into empty space.
            newest = max((ts[-1] for ts, _ in self.readings.values() if ts),
                         default=now_rel)
            right = max(newest, now_rel - window)
            vb.setXRange(right - window, right, padding=0)
        vb.enableAutoRange(axis="y")
        x_left = None if window is None else vb.viewRange()[0][0]
        widest = 0
        for cid, (ts, vs) in self.readings.items():
            visible = self.conn_checkboxes[cid].isChecked()
            curve = self.plot_curves[cid]
            ghost = self.raw_curves[cid]
            if not visible:
                curve.setData([], [])
                ghost.setData([], [])
            elif ts:
                # Timestamps are non-decreasing (BoardClockSync guarantees it),
                # so bisect finds the window start without scanning.
                lo = 0 if x_left is None else max(0, bisect_left(ts, x_left) - 1)
                widest = max(widest, len(ts) - lo)
                series = self.filtered.get(cid) or vs
                if len(series) != len(ts):          # mid-rebuild; fall back
                    series = vs
                curve.setData(ts[lo:], series[lo:])
                if self.show_raw_cb.isChecked() and self._filter_factory is not None:
                    ghost.setData(ts[lo:], vs[lo:])
                else:
                    ghost.setData([], [])
            # current-value labels
            if cid in self.last_raw:
                raw = self.last_raw[cid]
                signed = protocol.raw_to_signed(raw)
                self.value_labels[f"raw_{cid}"].setText(str(signed))
                # Signed 32-bit code against the converter's full scale.
                self.conn_fs_labels[cid].setText(f"{signed / 2147483648.0 * 100:+.3f} %")
                series = self.filtered.get(cid) or vs
                if series:
                    self.conn_value_labels[cid].setText(
                        self._fmt_si(series[-1], self.profile.value_unit))
        self._bound_draw_cost(widest)

    @staticmethod
    def _fmt_bytes(n: float) -> str:
        for unit in ("B", "KB", "MB", "GB"):
            if n < 1024:
                return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
            n /= 1024
        return f"{n:.1f} TB"

    # -- shutdown ------------------------------------------------------------
    def closeEvent(self, event) -> None:  # noqa: N802 (Qt override)
        self.log.info("Closing GUI")
        self._stop_serial()
        self._stop_link()
        super().closeEvent(event)
