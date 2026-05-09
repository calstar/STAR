import sys
import socket
import struct
import time
from collections import deque
from typing import Dict, List, Tuple, Optional

from PyQt6 import QtCore, QtGui, QtWidgets
import pyqtgraph as pg


# ---------------------- Protocol constants (DAQv2-Comms) ----------------------

DIABLO_COMMS_VERSION = 0
MAX_PACKET_SIZE = 512


class PacketType:
    BOARD_HEARTBEAT = 1
    SERVER_HEARTBEAT = 2
    SENSOR_DATA = 3
    ACTUATOR_COMMAND = 4
    ACTUATOR_CONFIG = 6


PACKET_HEADER_FORMAT = "<BBI"
PACKET_HEADER_SIZE = 6

BOARD_HEARTBEAT_BODY_FORMAT = "<32sBBB"  # firmware_hash[32], board_id, engine_state, board_state
BOARD_HEARTBEAT_BODY_SIZE = 35

SENSOR_DATA_PACKET_FORMAT = "<BB"
SENSOR_DATA_PACKET_SIZE = 2
SENSOR_DATA_CHUNK_FORMAT = "<I"
SENSOR_DATA_CHUNK_SIZE = 4
SENSOR_DATAPOINT_FORMAT = "<BI"
SENSOR_DATAPOINT_SIZE = 5

ACTUATOR_COMMAND_PACKET_FORMAT = "<B"
ACTUATOR_COMMAND_PACKET_SIZE = 1
ACTUATOR_COMMAND_FORMAT = "<BB"
ACTUATOR_COMMAND_SIZE = 2

NUM_ACTUATORS = 10

DEFAULT_ACTUATOR_IP = "192.168.2.11"
ACTUATOR_COMMAND_PORT = 5005          # Board listens here for commands
SENSOR_RECEIVE_PORT = 5006            # Board sends current-sense packets here

WINDOW_SECONDS = 10.0
UPDATE_INTERVAL_MS = 100
MAX_POINTS = 50000

HEARTBEAT_TIMEOUT_SEC = 2.5
HEARTBEAT_RATE_WINDOW = 20
SERVER_HEARTBEAT_INTERVAL_MS = 500

# Match sense_testing_gui BoardState
class BoardState:
    SETUP = 1
    ACTIVE = 2
    CONNECTION_LOSS_DETECTED = 3
    NO_CONNECTION_ABORT = 4
    NO_CONN_ABORT_FOLLOWER = 5
    PT_ABORT = 6
    NO_PT_ABORT = 7
    ABORT_FINISHED = 8
    STANDALONE_ABORT = 9
    SELF_TEST = 10


def board_state_name(state: int) -> str:
    names = {
        BoardState.SETUP: "Setup",
        BoardState.ACTIVE: "Active",
        BoardState.CONNECTION_LOSS_DETECTED: "Conn Loss",
        BoardState.NO_CONNECTION_ABORT: "No Conn Abort",
        BoardState.NO_CONN_ABORT_FOLLOWER: "No Conn Follower",
        BoardState.PT_ABORT: "PT Abort",
        BoardState.NO_PT_ABORT: "No PT Abort",
        BoardState.ABORT_FINISHED: "Abort Finished",
        BoardState.STANDALONE_ABORT: "Standalone Abort",
        BoardState.SELF_TEST: "Self Test",
    }
    return names.get(state, f"Unknown ({state})")


SENSOR_COLORS = [
    (255, 80, 80),
    (80, 255, 80),
    (80, 150, 255),
    (255, 200, 80),
    (200, 80, 255),
    (80, 255, 255),
    (255, 150, 150),
    (150, 255, 150),
    (150, 200, 255),
    (255, 255, 80),
]


# ---------------------- Packet helpers ----------------------

def parse_packet_header(data: bytes) -> Optional[Tuple[int, int, int]]:
    if len(data) < PACKET_HEADER_SIZE:
        return None
    try:
        return struct.unpack(PACKET_HEADER_FORMAT, data[:PACKET_HEADER_SIZE])
    except struct.error:
        return None


def parse_board_heartbeat_packet(data: bytes) -> Optional[Tuple[tuple, bytes, int, int, int]]:
    if len(data) < PACKET_HEADER_SIZE + BOARD_HEARTBEAT_BODY_SIZE:
        return None
    header = parse_packet_header(data)
    if header is None or header[0] != PacketType.BOARD_HEARTBEAT:
        return None
    try:
        body = struct.unpack(
            BOARD_HEARTBEAT_BODY_FORMAT,
            data[PACKET_HEADER_SIZE : PACKET_HEADER_SIZE + BOARD_HEARTBEAT_BODY_SIZE],
        )
    except struct.error:
        return None
    return (header, body[0], body[1], body[2], body[3])


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
    per_chunk_size = SENSOR_DATA_CHUNK_SIZE + (num_sensors * SENSOR_DATAPOINT_SIZE)
    expected_size = PACKET_HEADER_SIZE + SENSOR_DATA_PACKET_SIZE + (num_chunks * per_chunk_size)
    if len(data) < expected_size:
        return None

    chunks: List[dict] = []
    for _ in range(num_chunks):
        try:
            (chunk_ts,) = struct.unpack(
                SENSOR_DATA_CHUNK_FORMAT,
                data[offset : offset + SENSOR_DATA_CHUNK_SIZE],
            )
        except struct.error:
            return None
        offset += SENSOR_DATA_CHUNK_SIZE

        dps: List[dict] = []
        for _ in range(num_sensors):
            try:
                sensor_id, sensor_data = struct.unpack(
                    SENSOR_DATAPOINT_FORMAT,
                    data[offset : offset + SENSOR_DATAPOINT_SIZE],
                )
            except struct.error:
                return None
            offset += SENSOR_DATAPOINT_SIZE
            dps.append({"sensor_id": sensor_id, "data": sensor_data})

        chunks.append({"timestamp": chunk_ts, "datapoints": dps})

    header_dict = {
        "packet_type": packet_type,
        "version": version,
        "timestamp": timestamp,
    }
    return header_dict, chunks


def _make_header(packet_type: int) -> bytes:
    ts = int(time.time() * 1000) & 0xFFFFFFFF
    return struct.pack(PACKET_HEADER_FORMAT, packet_type, DIABLO_COMMS_VERSION, ts)


def build_server_heartbeat_packet() -> bytes:
    """Server heartbeat: header + 1 byte engine_state (0 = SAFE)."""
    return _make_header(PacketType.SERVER_HEARTBEAT) + struct.pack("<B", 0)


def build_minimal_actuator_config_packet() -> bytes:
    """DAQv2-Comms ACTUATOR_CONFIG: not abort controller, no actuators/PTs, serial printing on."""
    header = _make_header(PacketType.ACTUATOR_CONFIG)
    # ActuatorConfigPacket: is_abort_controller, num_abort_actuators
    # AbortPTSectionHeader: num_abort_pts
    # enable_serial_printing
    body = struct.pack("<BB", 0, 0) + struct.pack("<B", 0) + struct.pack("<B", 1)
    return header + body


def create_actuator_command_packet(commands: List[Tuple[int, int]]) -> bytes:
    """
    commands: list of (actuator_id, state) where id is 1-10, state 0/1.
    """
    if not commands or len(commands) > 255:
        return b""

    header_size = PACKET_HEADER_SIZE
    body_size = ACTUATOR_COMMAND_PACKET_SIZE
    commands_size = len(commands) * ACTUATOR_COMMAND_SIZE
    total_size = header_size + body_size + commands_size
    if total_size > MAX_PACKET_SIZE:
        return b""

    pkt = bytearray(total_size)
    offset = 0

    packet_type = PacketType.ACTUATOR_COMMAND
    version = DIABLO_COMMS_VERSION
    timestamp = int(time.time() * 1000) & 0xFFFFFFFF
    struct.pack_into(PACKET_HEADER_FORMAT, pkt, offset, packet_type, version, timestamp)
    offset += PACKET_HEADER_SIZE

    struct.pack_into(ACTUATOR_COMMAND_PACKET_FORMAT, pkt, offset, len(commands))
    offset += ACTUATOR_COMMAND_PACKET_SIZE

    for actuator_id, state in commands:
        struct.pack_into(ACTUATOR_COMMAND_FORMAT, pkt, offset, actuator_id, state)
        offset += ACTUATOR_COMMAND_SIZE

    return bytes(pkt)


# ---------------------- Receiver thread ----------------------

class SensorReceiver(QtCore.QThread):
    sensor_data_received = QtCore.pyqtSignal(dict, list, str)
    board_heartbeat_received = QtCore.pyqtSignal(float, int, int, int, str, bytes)
    status_update = QtCore.pyqtSignal(str)

    def __init__(
        self,
        port: int,
        bind_address: str = "0.0.0.0",
        sock: Optional[socket.socket] = None,
    ):
        super().__init__()
        self.port = port
        self.bind_address = bind_address
        self._external_sock = sock
        self._owned_socket = sock is None
        self._stop = False
        self.sock: Optional[socket.socket] = None

    def stop(self):
        self._stop = True
        if self._owned_socket and self.sock:
            try:
                self.sock.close()
            except Exception:
                pass

    def run(self):
        if self._external_sock is not None:
            self.sock = self._external_sock
            self.sock.settimeout(0.1)
            self.status_update.emit(f"Listening on {self.bind_address}:{self.port}")
        else:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.sock.settimeout(0.1)
            try:
                self.sock.bind((self.bind_address, self.port))
                self.status_update.emit(f"Listening on {self.bind_address}:{self.port}")
            except OSError as e:
                self.status_update.emit(f"Error binding: {e}")
                return

        while not self._stop:
            try:
                data, addr = self.sock.recvfrom(MAX_PACKET_SIZE)
            except socket.timeout:
                continue
            except Exception as e:
                if not self._stop:
                    self.status_update.emit(f"Error: {e}")
                continue

            src_ip = addr[0]
            header = parse_packet_header(data)
            if not header:
                continue

            if header[0] == PacketType.BOARD_HEARTBEAT:
                result = parse_board_heartbeat_packet(data)
                if result:
                    _h, firmware_hash, board_id, engine_state, board_state = result
                    self.board_heartbeat_received.emit(
                        time.time(),
                        board_id,
                        board_state,
                        engine_state,
                        src_ip,
                        firmware_hash,
                    )
                continue

            if header[0] != PacketType.SENSOR_DATA:
                continue

            result = parse_sensor_data_packet(data)
            if not result:
                continue
            header_dict, chunks = result
            self.sensor_data_received.emit(header_dict, chunks, src_ip)

        if self._owned_socket and self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
        self.sock = None
        self.status_update.emit("Stopped")


# ---------------------- Main GUI ----------------------

class ActuatorTestingWindow(QtWidgets.QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Actuator Testing – Current Sense + Control")
        self.resize(1100, 750)

        self.device_ip = DEFAULT_ACTUATOR_IP
        self.device_port = ACTUATOR_COMMAND_PORT

        self.window_seconds = WINDOW_SECONDS
        self.show_current = False

        self.voltage_history: Dict[int, deque] = {
            i: deque(maxlen=MAX_POINTS) for i in range(1, NUM_ACTUATORS + 1)
        }
        self.plot_enabled: Dict[int, bool] = {i: True for i in range(1, NUM_ACTUATORS + 1)}

        self.heartbeat_timestamps: deque = deque(maxlen=HEARTBEAT_RATE_WINDOW)
        self.last_heartbeat_time: Optional[float] = None
        self.board_id: Optional[int] = None
        self.board_state: Optional[int] = None
        self.board_source_ip: Optional[str] = None
        self.firmware_hash: Optional[bytes] = None

        self._send_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._send_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._send_sock.settimeout(0.5)
        self._shared_sock: Optional[socket.socket] = None
        try:
            self._send_sock.bind(("", SENSOR_RECEIVE_PORT))
            self._shared_sock = self._send_sock
        except OSError:
            self._send_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

        self._server_heartbeat_timer = QtCore.QTimer(self)
        self._server_heartbeat_timer.timeout.connect(self._send_server_heartbeat_once)

        self._build_ui()

        self.receiver = SensorReceiver(SENSOR_RECEIVE_PORT, sock=self._shared_sock)
        self.receiver.sensor_data_received.connect(self.on_sensor_data)
        self.receiver.board_heartbeat_received.connect(self._on_board_heartbeat)
        self.receiver.status_update.connect(self.status_label.setText)
        self.receiver.start()

        self.update_timer = QtCore.QTimer(self)
        self.update_timer.timeout.connect(self.update_plots)
        self.update_timer.start(UPDATE_INTERVAL_MS)

    # ----- UI -----

    def _build_ui(self):
        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        layout = QtWidgets.QHBoxLayout(central)

        # Left: actuator controls
        left = QtWidgets.QWidget()
        left_layout = QtWidgets.QVBoxLayout(left)

        net_row = QtWidgets.QHBoxLayout()
        net_row.addWidget(QtWidgets.QLabel("Actuator IP:"))
        self.ip_edit = QtWidgets.QLineEdit(self.device_ip)
        self.ip_edit.setToolTip(
            "Target for commands, server heartbeat, and actuator config. "
            "Auto-filled from BOARD_HEARTBEAT source; last heartbeat wins if multiple boards."
        )
        net_row.addWidget(self.ip_edit)
        net_row.addWidget(QtWidgets.QLabel("Cmd port:"))
        self.port_spin = QtWidgets.QSpinBox()
        self.port_spin.setRange(1, 65535)
        self.port_spin.setValue(self.device_port)
        net_row.addWidget(self.port_spin)
        left_layout.addLayout(net_row)

        hb_grp = QtWidgets.QGroupBox("Board (heartbeats)")
        hb_layout = QtWidgets.QVBoxLayout(hb_grp)
        self.connection_label = QtWidgets.QLabel("Connection: —")
        self.connection_label.setStyleSheet("font-weight: bold;")
        hb_layout.addWidget(self.connection_label)
        self.heartbeat_rate_label = QtWidgets.QLabel("Heartbeat rate: — Hz")
        self.heartbeat_rate_label.setStyleSheet("font-weight: bold;")
        hb_layout.addWidget(self.heartbeat_rate_label)
        self.board_state_label = QtWidgets.QLabel("Board state: —")
        hb_layout.addWidget(self.board_state_label)
        self.board_id_label = QtWidgets.QLabel("Board ID: —")
        hb_layout.addWidget(self.board_id_label)
        self.board_ip_label = QtWidgets.QLabel("Source: —")
        hb_layout.addWidget(self.board_ip_label)
        self.firmware_hash_label = QtWidgets.QLabel("Firmware hash: —")
        hb_layout.addWidget(self.firmware_hash_label)

        self.send_heartbeat_cb = QtWidgets.QCheckBox("Send server heartbeat")
        self.send_heartbeat_cb.stateChanged.connect(self._on_send_heartbeat_changed)
        hb_layout.addWidget(self.send_heartbeat_cb)

        self.send_actuator_config_btn = QtWidgets.QPushButton("Send actuator config (minimal)")
        self.send_actuator_config_btn.setToolTip(
            "Sends DAQv2-Comms ACTUATOR_CONFIG: not abort controller, serial printing on, no abort tables."
        )
        self.send_actuator_config_btn.clicked.connect(self._send_minimal_actuator_config)
        hb_layout.addWidget(self.send_actuator_config_btn)

        left_layout.addWidget(hb_grp)

        # Graph channel toggles (similar to sense_testing_gui)
        chan_row = QtWidgets.QHBoxLayout()
        chan_row.addWidget(QtWidgets.QLabel("Graph actuators:"))
        self.channel_checkboxes: Dict[int, QtWidgets.QCheckBox] = {}
        for aid in range(1, NUM_ACTUATORS + 1):
            cb = QtWidgets.QCheckBox(f"A{aid}")
            cb.setChecked(True)
            r, g, b = SENSOR_COLORS[(aid - 1) % len(SENSOR_COLORS)]
            cb.setStyleSheet(
                f"QCheckBox {{ color: rgb({r},{g},{b}); font-weight: bold; }}"
            )
            cb.stateChanged.connect(
                lambda state, a=aid: self.on_channel_toggled(a, state)
            )
            self.channel_checkboxes[aid] = cb
            chan_row.addWidget(cb)
        chan_row.addStretch()
        left_layout.addLayout(chan_row)

        # Voltage / current toggle
        mode_row = QtWidgets.QHBoxLayout()
        self.show_current_cb = QtWidgets.QCheckBox("Show current (A)")
        self.show_current_cb.setToolTip("When checked, convert sense voltage to current using V/20/0.05.")
        self.show_current_cb.stateChanged.connect(self.on_show_current_toggled)
        mode_row.addWidget(self.show_current_cb)
        mode_row.addStretch()
        left_layout.addLayout(mode_row)

        grid = QtWidgets.QGridLayout()
        self.button_map: Dict[int, QtWidgets.QPushButton] = {}
        self.voltage_labels: Dict[int, QtWidgets.QLabel] = {}

        for i in range(NUM_ACTUATORS):
            actuator_id = i + 1
            row = i // 2
            col = (i % 2) * 2

            btn = QtWidgets.QPushButton(f"Actuator {actuator_id}")
            btn.setCheckable(True)
            btn.clicked.connect(lambda checked, aid=actuator_id: self.on_actuator_toggled(aid, checked))

            vlabel = QtWidgets.QLabel("0.000 V")
            vlabel.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
            vlabel.setStyleSheet(
                "font-size: 9pt; padding: 0 2px; color: white; background-color: transparent;"
            )

            self.button_map[actuator_id] = btn
            self.voltage_labels[actuator_id] = vlabel

            grid.addWidget(btn, row, col)
            grid.addWidget(vlabel, row, col + 1)

        left_layout.addLayout(grid)
        left_layout.addStretch()

        self.status_label = QtWidgets.QLabel("Ready")
        self.status_label.setStyleSheet("color: #8ab; font-size: 11px;")
        left_layout.addWidget(self.status_label)

        # Right: plot
        right = QtWidgets.QWidget()
        right_layout = QtWidgets.QVBoxLayout(right)

        self.plot_widget = pg.PlotWidget(background="#1e1e1e")
        axis_style = {"color": "#FFFFFF", "font-size": "11pt"}
        self.plot_widget.setLabel("left", "Current sense (V)", **axis_style)
        self.plot_widget.setLabel("bottom", "Time (s)", **axis_style)
        self.plot_widget.showGrid(x=True, y=True, alpha=0.3)
        self.plot_widget.enableAutoRange(axis="y")
        self.plot_widget.addLegend(offset=(10, 10))

        for axis_name in ("left", "bottom"):
            ax = self.plot_widget.getPlotItem().getAxis(axis_name)
            try:
                if hasattr(ax, "setStyle"):
                    ax.setStyle(tickTextColor="#FFFFFF", tickFont=QtGui.QFont(None, 10))
            except Exception:
                pass

        self.curves: Dict[int, pg.PlotDataItem] = {}
        for actuator_id in range(1, NUM_ACTUATORS + 1):
            r, g, b = SENSOR_COLORS[(actuator_id - 1) % len(SENSOR_COLORS)]
            pen = pg.mkPen(color=(r, g, b), width=2)
            curve = self.plot_widget.plot([], [], pen=pen, name=f"A{actuator_id}")
            self.curves[actuator_id] = curve

        right_layout.addWidget(self.plot_widget)

        layout.addWidget(left, stretch=0)
        layout.addWidget(right, stretch=1)

    # ----- Networking helpers -----

    def _on_board_heartbeat(
        self,
        timestamp: float,
        board_id: int,
        board_state: int,
        engine_state: int,
        source_ip: str,
        firmware_hash: bytes,
    ):
        self.heartbeat_timestamps.append(timestamp)
        self.last_heartbeat_time = timestamp
        self.board_id = board_id
        self.board_state = board_state
        self.board_source_ip = source_ip
        self.firmware_hash = firmware_hash
        full_hex = firmware_hash.hex()
        short_hex = full_hex[:16] + "..."
        self.firmware_hash_label.setText(f"Firmware hash: {short_hex}")
        self.firmware_hash_label.setToolTip(f"SHA-256: {full_hex}")
        self.ip_edit.setText(source_ip)

    def _on_send_heartbeat_changed(self, state: int):
        if state == QtCore.Qt.CheckState.Checked.value:
            self._server_heartbeat_timer.start(SERVER_HEARTBEAT_INTERVAL_MS)
        else:
            self._server_heartbeat_timer.stop()

    def _send_server_heartbeat_once(self):
        ip = self.ip_edit.text().strip()
        if not ip:
            self.status_label.setText("Send status: No target IP")
            return
        try:
            port = int(self.port_spin.value())
            pkt = build_server_heartbeat_packet()
            self._send_sock.sendto(pkt, (ip, port))
            self.status_label.setText(f"Send status: Server HB to {ip}:{port}")
        except Exception as e:
            self.status_label.setText(f"Send status: Error — {e}")

    def _send_minimal_actuator_config(self):
        ip = self.ip_edit.text().strip()
        if not ip:
            self.status_label.setText("Send status: No target IP")
            return
        try:
            port = int(self.port_spin.value())
            pkt = build_minimal_actuator_config_packet()
            self._send_sock.sendto(pkt, (ip, port))
            self.status_label.setText(f"Send status: Actuator config to {ip}:{port}")
        except Exception as e:
            self.status_label.setText(f"Send status: Error — {e}")

    def on_actuator_toggled(self, actuator_id: int, checked: bool):
        state = 1 if checked else 0
        pkt = create_actuator_command_packet([(actuator_id, state)])
        if not pkt:
            return
        ip = self.ip_edit.text().strip() or self.device_ip
        port = int(self.port_spin.value())
        try:
            self._send_sock.sendto(pkt, (ip, port))
            self.status_label.setText(f"Sent command: actuator {actuator_id} -> {state}")
        except OSError as e:
            self.status_label.setText(f"Send error: {e}")

    def on_sensor_data(self, header: dict, chunks: List[dict], source_ip: str):
        if not chunks:
            return

        latest = chunks[-1]
        now = time.time()
        t0 = getattr(self, "_t0", None)
        if t0 is None:
            t0 = now
            self._t0 = t0
        t_rel = now - t0

        for dp in latest["datapoints"]:
            sid = int(dp.get("sensor_id", -1))
            data_u32 = int(dp.get("data", 0))

            if 1 <= sid <= NUM_ACTUATORS:
                actuator_id = sid
            elif 0 <= sid < NUM_ACTUATORS:
                actuator_id = sid + 1
            else:
                continue

            try:
                voltage = struct.unpack("<f", struct.pack("<I", data_u32 & 0xFFFFFFFF))[0]
            except struct.error:
                continue

            hist = self.voltage_history[actuator_id]
            hist.append((t_rel, float(voltage)))

            if self.show_current:
                v_shunt = voltage / 20.0
                current = v_shunt / 0.05
                self.voltage_labels[actuator_id].setText(f"{current:.3f} A")
            else:
                self.voltage_labels[actuator_id].setText(f"{voltage:.3f} V")

    def on_channel_toggled(self, actuator_id: int, state: int):
        enabled = state == QtCore.Qt.CheckState.Checked.value
        self.plot_enabled[actuator_id] = enabled
        curve = self.curves.get(actuator_id)
        if curve is not None:
            curve.setVisible(enabled)

    def on_show_current_toggled(self, state: int):
        self.show_current = state == QtCore.Qt.CheckState.Checked.value
        axis_style = {"color": "#FFFFFF", "font-size": "11pt"}
        if self.show_current:
            self.plot_widget.setLabel("left", "Current (A)", **axis_style)
        else:
            self.plot_widget.setLabel("left", "Current sense (V)", **axis_style)
        self.update_plots()

    def _update_board_status_labels(self):
        now = time.time()
        if len(self.heartbeat_timestamps) >= 2:
            span = self.heartbeat_timestamps[-1] - self.heartbeat_timestamps[0]
            rate = (len(self.heartbeat_timestamps) - 1) / span if span > 0 else 0
            self.heartbeat_rate_label.setText(f"Heartbeat rate: {rate:.2f} Hz")
        else:
            self.heartbeat_rate_label.setText("Heartbeat rate: — Hz")

        if self.board_state is not None:
            self.board_state_label.setText(f"Board state: {board_state_name(self.board_state)}")
        else:
            self.board_state_label.setText("Board state: —")

        self.board_id_label.setText(f"Board ID: {self.board_id if self.board_id is not None else '—'}")
        self.board_ip_label.setText(f"Source: {self.board_source_ip or '—'}")

        if self.last_heartbeat_time is not None:
            if now - self.last_heartbeat_time > HEARTBEAT_TIMEOUT_SEC:
                self.connection_label.setText("Connection: Lost")
                self.connection_label.setStyleSheet("font-weight: bold; color: #e74c3c;")
            else:
                self.connection_label.setText("Connection: Connected")
                self.connection_label.setStyleSheet("font-weight: bold; color: #2ecc71;")
        else:
            self.connection_label.setText("Connection: —")
            self.connection_label.setStyleSheet("font-weight: bold;")

    def update_plots(self):
        self._update_board_status_labels()
        for actuator_id, curve in self.curves.items():
            if not self.plot_enabled.get(actuator_id, True):
                continue
            hist = self.voltage_history[actuator_id]
            if not hist:
                continue
            xs, ys = zip(*hist)
            t_max = xs[-1]
            t_min = max(0.0, t_max - self.window_seconds)
            xs_plot = []
            ys_plot = []
            for x, v in hist:
                if x < t_min:
                    continue
                if self.show_current:
                    v_shunt = v / 20.0
                    value = v_shunt / 0.05
                else:
                    value = v
                xs_plot.append(x)
                ys_plot.append(value)
            curve.setData(xs_plot, ys_plot)

    def closeEvent(self, event: QtGui.QCloseEvent):
        self._server_heartbeat_timer.stop()
        if self.receiver:
            self.receiver.stop()
            self.receiver.wait(2000)
        try:
            self._send_sock.close()
        except Exception:
            pass
        self.update_timer.stop()
        event.accept()


def main():
    app = QtWidgets.QApplication(sys.argv)
    win = ActuatorTestingWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
