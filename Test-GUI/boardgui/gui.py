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
import time
from collections import deque
from typing import Deque, Dict, Optional, Tuple

import pyqtgraph as pg

from . import protocol
from .network import UdpLink
from .profile import BoardProfile
from .serial_link import SerialLink, list_ports
from .serial_parse import SerialParser
from .qt import (ALIGN_CENTER, ALIGN_RIGHT, ALIGN_VCENTER, FONT_BOLD, QtCore,
                 QtGui, QtWidgets, QTimer, TEXTCURSOR_END, pyqtSignal)

BAUD_RATES = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600]

UI_REFRESH_MS = 100
PLOT_WINDOW_SEC = 30.0
MAX_POINTS_PER_CHANNEL = 6000

# distinct plot colours for up to 10 connectors
_COLORS = [
    (232, 78, 78), (78, 200, 96), (72, 132, 232), (240, 180, 64),
    (176, 96, 224), (64, 200, 200), (232, 128, 160), (150, 200, 120),
    (120, 160, 232), (220, 220, 96),
]


# -----------------------------------------------------------------------------
# Small widgets
# -----------------------------------------------------------------------------
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
        self.conn_checkboxes: Dict[int, QtWidgets.QCheckBox] = {}
        self.plot_curves: Dict[int, pg.PlotDataItem] = {}

        self._build_ui()
        self._wire_logging()

        # timer
        self.ui_timer = QTimer(self)
        self.ui_timer.timeout.connect(self._refresh)
        self.ui_timer.start(UI_REFRESH_MS)

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
        left_container = QtWidgets.QWidget()
        left_container.setLayout(left)
        left_container.setFixedWidth(340)
        body.addWidget(left_container)

        body.addWidget(self._build_readings_group(), stretch=1)
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
        v = QtWidgets.QLabel(initial)
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

        # SERVER_HEARTBEAT: auto at the production cadence, or one-shot
        hb_row = QtWidgets.QHBoxLayout()
        hb_row.setSpacing(6)
        self.auto_hb_cb = QtWidgets.QCheckBox("Auto SERVER_HEARTBEAT")
        self.auto_hb_cb.setToolTip(
            f"Send SERVER_HEARTBEAT every {self.profile.server_heartbeat_interval_ms} ms "
            "(what the production DAQ server does)")
        hb_row.addWidget(self.auto_hb_cb)
        self.engine_combo = QtWidgets.QComboBox()
        for val in sorted(protocol.ENGINE_STATE_NAMES):
            self.engine_combo.addItem(protocol.ENGINE_STATE_NAMES[val], val)
        self.engine_combo.setToolTip("Engine state carried in the heartbeat")
        hb_row.addWidget(self.engine_combo)
        hb_btn = QtWidgets.QPushButton("Send")
        hb_btn.setFixedWidth(52)
        hb_btn.clicked.connect(self._send_heartbeat_now)
        hb_row.addWidget(hb_btn)
        hb_row.addStretch(1)
        lay.addLayout(hb_row)

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
            lay.addWidget(self.config_btn)
            lay.addWidget(self.abort_controller_cb)
        else:
            self.config_btn = QtWidgets.QPushButton("Send SENSOR_CONFIG (activate)")
            self.config_btn.setToolTip(
                "WaitingForServer -> SelfTest -> Active; sensor ids = the "
                "displayed connectors")
            lay.addWidget(self.config_btn)
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
                enable_serial_printing=self.profile.enable_serial_printing)
            if ok:
                self.log.info(
                    "Sent ACTUATOR_CONFIG (controller=%d, %d actuators @ %s) -> %s:%d",
                    self.abort_controller_cb.isChecked(), len(locations), board_ip,
                    link.target_ip, self.profile.control_port)
        else:
            ok = link.send_sensor_config(
                sensor_ids=ids,
                reference_voltage=self.profile.reference_voltage,
                necessary_for_abort=self.profile.necessary_for_abort,
                controller_ip="0.0.0.0" if self.profile.necessary_for_abort else None,
                enable_serial_printing=self.profile.enable_serial_printing)
            if ok:
                self.log.info("Sent SENSOR_CONFIG (ids=%s, ref=%d) -> %s:%d",
                              ids, self.profile.reference_voltage,
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

    def _build_readings_group(self) -> QtWidgets.QGroupBox:
        g = QtWidgets.QGroupBox(f"Live {self.profile.reading_name} — per connector")
        lay = QtWidgets.QVBoxLayout(g)

        pg.setConfigOptions(antialias=True)
        self.plot = pg.PlotWidget()
        self.plot.setBackground("#101216")
        self.plot.showGrid(x=True, y=True, alpha=0.25)
        self.plot.setLabel("bottom", "time", units="s")
        self.plot.setLabel("left", self.profile.reading_name, units=self.profile.value_unit)
        self.plot.addLegend(offset=(10, 10))
        lay.addWidget(self.plot, stretch=1)

        # per-connector current-value table + toggle
        table = QtWidgets.QGridLayout()
        table.addWidget(self._muted("Connector"), 0, 0)
        table.addWidget(self._muted("Raw ADC code"), 0, 1)
        table.addWidget(self._muted(f"{self.profile.reading_name} ({self.profile.value_unit})"), 0, 2)
        table.addWidget(self._muted("Plot"), 0, 3)
        row = 1
        for cid in self.profile.display_connectors():
            color = _COLORS[(cid - 1) % len(_COLORS)]
            self.readings[cid] = (deque(maxlen=MAX_POINTS_PER_CHANNEL),
                                  deque(maxlen=MAX_POINTS_PER_CHANNEL))
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
            cb = QtWidgets.QCheckBox()
            cb.setChecked(True)
            self.conn_value_labels[cid] = val_lbl
            self.value_labels[f"raw_{cid}"] = raw_lbl
            self.conn_checkboxes[cid] = cb
            table.addWidget(name_lbl, row, 0)
            table.addWidget(raw_lbl, row, 1)
            table.addWidget(val_lbl, row, 2)
            table.addWidget(cb, row, 3, alignment=ALIGN_CENTER)

            curve = self.plot.plot([], [], pen=pg.mkPen(color=color, width=2), name=name)
            self.plot_curves[cid] = curve
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
            self.port_combo.lineEdit().setPlaceholderText("no serial ports found — plug in the board")

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
            base_t = now - self.start_time
            for cid, raw in e["values"].items():
                if cid not in self.readings:
                    continue
                ts, vs = self.readings[cid]
                ts.append(base_t)
                vs.append(self.profile.decode_value(raw))
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
        self.last_sensor_data_time = time.time()
        self.sensor_packet_count += 1
        # Use the newest chunk for the "current value"; push every chunk to plot.
        base_t = self.last_sensor_data_time - self.start_time
        for chunk in sd.chunks:
            for dp in chunk.datapoints:
                if dp.sensor_id not in self.readings:
                    continue
                volt = self.profile.decode_value(dp.raw)
                ts, vs = self.readings[dp.sensor_id]
                ts.append(base_t)
                vs.append(volt)
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
        self._refresh_connection_light()
        self._refresh_status()
        self._refresh_packets()
        self._refresh_plot()

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

    def _refresh_plot(self) -> None:
        now_rel = time.time() - self.start_time
        for cid, (ts, vs) in self.readings.items():
            visible = self.conn_checkboxes[cid].isChecked()
            curve = self.plot_curves[cid]
            if not visible:
                curve.setData([], [])
            elif ts:
                curve.setData(list(ts), list(vs))
            # current-value labels
            if cid in self.last_raw:
                raw = self.last_raw[cid]
                self.value_labels[f"raw_{cid}"].setText(str(protocol.raw_to_signed(raw)))
                if vs:
                    self.conn_value_labels[cid].setText(f"{vs[-1]:+.5f}")
        # scroll x window
        if now_rel > PLOT_WINDOW_SEC:
            self.plot.setXRange(now_rel - PLOT_WINDOW_SEC, now_rel, padding=0)

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
