"""
Ball Valve GUI — open/close the BallValve_Hotfire board's valve over Ethernet
and watch its position.

Sends DAQv2 packets to firmware/Hotfire_Code/BallValve_Hotfire on UDP 5005:
  - SERVER_HEARTBEAT every 500 ms while "Heartbeats" is running. The board
    only leaves the open state with a current heartbeat, and OPENS the valve
    5 s after they stop (its safe state: 20 mA), so stopping heartbeats or
    closing this window opens the valve.
  - ACTUATOR_COMMAND (actuator_id 1): state 1 = open (20 mA), 0 = closed.

Listens on UDP 5006 for the board's BOARD_HEARTBEAT (alive, and ACTIVE when it
hears our heartbeats) and SENSOR_DATA (sensor_id 1: raw 12-bit ADC counts of
the 100 ohm position shunt; V = counts / 4095 * 3.3, 4-20 mA = 0.4-2.0 V).

Your computer needs an address on the board's subnet, e.g. 192.168.2.20/24.

    python ball_valve_gui.py [--ip 192.168.2.71]
"""

import argparse
import socket
import struct
import sys
import time

from PyQt6 import QtCore, QtGui, QtWidgets

# ---------------------- Protocol constants (DAQv2-Comms) ----------------------

DIABLO_COMMS_VERSION = 0
PACKET_HEADER_FORMAT = "<BBI"  # packet_type, version, timestamp_ms
PACKET_HEADER_SIZE = 6

BOARD_HEARTBEAT = 1
SERVER_HEARTBEAT = 2
SENSOR_DATA = 3
ACTUATOR_COMMAND = 4

BOARD_HEARTBEAT_BODY_FORMAT = "<32sBBB"  # hash, board_id, engine, board state
BOARD_HEARTBEAT_BODY_SIZE = 35
BOARD_STATES = {1: "SETUP", 2: "ACTIVE"}

SENSOR_DATAPOINT_FORMAT = "<BI"  # sensor_id, data
SENSOR_DATAPOINT_SIZE = 5

VALVE_BOARD_ID = 71  # -DBOARD_ID in BallValve_Hotfire/platformio.ini
VALVE_ACTUATOR_ID = 1
VALVE_POSITION_SENSOR_ID = 1
POSITION_SHUNT_OHMS = 100.0
ADC_MAX = 4095.0  # 12-bit
ADC_VREF = 3.3
DEFAULT_BOARD_IP = "192.168.2.71"  # the board's static fallback address
COMMAND_PORT = 5005  # board listens here
LISTEN_PORT = 5006  # board sends BOARD_HEARTBEAT and SENSOR_DATA here

SERVER_HEARTBEAT_INTERVAL_MS = 500
BOARD_SILENT_SEC = 2.5  # board heartbeats are 1 s apart
POLL_MS = 50


def _header(packet_type: int) -> bytes:
    ts = int(time.time() * 1000) & 0xFFFFFFFF
    return struct.pack(PACKET_HEADER_FORMAT, packet_type, DIABLO_COMMS_VERSION, ts)


def build_server_heartbeat() -> bytes:
    return _header(SERVER_HEARTBEAT) + struct.pack("<B", 0)  # engine SAFE


def build_actuator_command(actuator_id: int, state: int) -> bytes:
    body = struct.pack("<B", 1) + struct.pack("<BB", actuator_id, state)
    return _header(ACTUATOR_COMMAND) + body


def parse_board_heartbeat(data: bytes):
    """Return (board_id, board_state, firmware_hash) or None."""
    if len(data) < PACKET_HEADER_SIZE + BOARD_HEARTBEAT_BODY_SIZE:
        return None
    if data[0] != BOARD_HEARTBEAT:
        return None
    fw_hash, board_id, _engine, board_state = struct.unpack_from(
        BOARD_HEARTBEAT_BODY_FORMAT, data, PACKET_HEADER_SIZE
    )
    return board_id, board_state, fw_hash


def parse_sensor_data(data: bytes):
    """Return {sensor_id: raw value} from the last chunk of a SENSOR_DATA packet."""
    if len(data) < PACKET_HEADER_SIZE + 2 or data[0] != SENSOR_DATA:
        return None
    num_chunks, num_sensors = data[PACKET_HEADER_SIZE], data[PACKET_HEADER_SIZE + 1]
    chunk_size = 4 + num_sensors * SENSOR_DATAPOINT_SIZE
    if num_chunks == 0 or len(data) < PACKET_HEADER_SIZE + 2 + num_chunks * chunk_size:
        return None
    offset = PACKET_HEADER_SIZE + 2 + (num_chunks - 1) * chunk_size + 4
    values = {}
    for _ in range(num_sensors):
        sensor_id, raw = struct.unpack_from(SENSOR_DATAPOINT_FORMAT, data, offset)
        values[sensor_id] = raw
        offset += SENSOR_DATAPOINT_SIZE
    return values


class BallValveGui(QtWidgets.QWidget):
    def __init__(self, board_ip: str):
        super().__init__()
        self.setWindowTitle("Ball Valve — Ethernet")
        self.sock: socket.socket | None = None
        self.heartbeats_on = False
        self.commanded: str | None = None
        self.board_last_seen = 0.0
        self.board_state = 0
        self.board_src_ip: str | None = None
        self.position_volts: float | None = None
        self.position_last_seen = 0.0

        # --- target row ---
        self.ip_edit = QtWidgets.QLineEdit(board_ip)
        self.follow_ip = QtWidgets.QCheckBox("Follow board's IP")
        self.follow_ip.setChecked(True)
        self.follow_ip.setToolTip(
            "Use the source address of the board's heartbeats (it may get a "
            "DHCP address instead of the fallback)."
        )
        self.hb_btn = QtWidgets.QPushButton("Start heartbeats")
        self.hb_btn.clicked.connect(self.toggle_heartbeats)

        target_row = QtWidgets.QHBoxLayout()
        target_row.addWidget(QtWidgets.QLabel(f"Board IP (UDP {COMMAND_PORT}):"))
        target_row.addWidget(self.ip_edit, 1)
        target_row.addWidget(self.follow_ip)
        target_row.addWidget(self.hb_btn)

        # --- board, command and position ---
        self.board_label = QtWidgets.QLabel()
        self.state_label = QtWidgets.QLabel()
        self.state_label.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
        self.state_label.setMinimumHeight(64)
        font = self.state_label.font()
        font.setPointSize(22)
        font.setBold(True)
        self.state_label.setFont(font)

        self.position_label = QtWidgets.QLabel()
        self.position_label.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
        pos_font = self.position_label.font()
        pos_font.setPointSize(16)
        self.position_label.setFont(pos_font)
        self.position_bar = QtWidgets.QProgressBar()
        self.position_bar.setRange(0, 100)
        self.position_bar.setFormat("%p% open")

        self.open_btn = QtWidgets.QPushButton("OPEN (1)")
        self.close_btn = QtWidgets.QPushButton("CLOSE (0)")
        for btn in (self.open_btn, self.close_btn):
            btn.setMinimumHeight(48)
        self.open_btn.clicked.connect(lambda: self.command(1))
        self.close_btn.clicked.connect(lambda: self.command(0))
        btn_row = QtWidgets.QHBoxLayout()
        btn_row.addWidget(self.open_btn)
        btn_row.addWidget(self.close_btn)

        note = QtWidgets.QLabel(
            "The board OPENS the valve 5 s after heartbeats stop — stopping "
            "heartbeats or closing this window opens it."
        )
        note.setWordWrap(True)

        # --- log ---
        self.log = QtWidgets.QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumBlockCount(2000)
        self.log.setFont(
            QtGui.QFontDatabase.systemFont(QtGui.QFontDatabase.SystemFont.FixedFont)
        )

        layout = QtWidgets.QVBoxLayout(self)
        layout.addLayout(target_row)
        layout.addWidget(self.board_label)
        layout.addWidget(self.state_label)
        layout.addWidget(self.position_label)
        layout.addWidget(self.position_bar)
        layout.addLayout(btn_row)
        layout.addWidget(note)
        layout.addWidget(self.log, 1)
        self.resize(600, 600)

        self.hb_timer = QtCore.QTimer(self)
        self.hb_timer.timeout.connect(self.send_server_heartbeat)
        self.rx_timer = QtCore.QTimer(self)
        self.rx_timer.timeout.connect(self.poll_socket)
        self.ui_timer = QtCore.QTimer(self)
        self.ui_timer.timeout.connect(self.refresh_status)
        self.ui_timer.start(250)

        self.open_socket()
        self.set_command_label()
        self.refresh_status()
        self.update_controls()

    # -------------------------------------------------------------- socket
    def open_socket(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        try:
            sock.bind(("0.0.0.0", LISTEN_PORT))
        except OSError as e:
            self.append(
                f"Could not listen on UDP {LISTEN_PORT} ({e}) — board status "
                "and position unavailable; commands still work."
            )
        sock.setblocking(False)
        self.sock = sock
        self.rx_timer.start(POLL_MS)
        self.append(f"Listening for board packets on UDP {LISTEN_PORT}.")

    def send(self, packet: bytes) -> bool:
        ip = self.ip_edit.text().strip()
        try:
            self.sock.sendto(packet, (ip, COMMAND_PORT))
            return True
        except OSError as e:
            self.append(f"Send to {ip}:{COMMAND_PORT} failed: {e}")
            return False

    def poll_socket(self):
        while True:
            try:
                data, (src_ip, _port) = self.sock.recvfrom(2048)
            except OSError:
                return
            if not data:
                continue
            if data[0] == BOARD_HEARTBEAT:
                self.on_board_heartbeat(data, src_ip)
            elif data[0] == SENSOR_DATA and src_ip == self.board_src_ip:
                # SENSOR_DATA carries no board id: take it from the address
                # our board's heartbeats come from.
                values = parse_sensor_data(data)
                if values and VALVE_POSITION_SENSOR_ID in values:
                    counts = values[VALVE_POSITION_SENSOR_ID]
                    self.position_volts = counts / ADC_MAX * ADC_VREF
                    self.position_last_seen = time.time()

    def on_board_heartbeat(self, data: bytes, src_ip: str):
        hb = parse_board_heartbeat(data)
        if hb is None:
            return
        board_id, board_state, fw_hash = hb
        if board_id != VALVE_BOARD_ID:
            return
        first = self.board_last_seen == 0.0
        prev_state = self.board_state
        self.board_last_seen = time.time()
        self.board_state = board_state
        self.board_src_ip = src_ip
        if first:
            self.append(
                f"Board {board_id} heard from {src_ip} "
                f"(firmware {fw_hash.hex()[:16]}...)."
            )
        if board_state != prev_state and not first:
            self.append(f"Board state -> {BOARD_STATES.get(board_state, '?')}.")
        if self.follow_ip.isChecked() and self.ip_edit.text().strip() != src_ip:
            self.ip_edit.setText(src_ip)
            self.append(f"Target IP set to {src_ip}.")

    # ----------------------------------------------------------- heartbeats
    def toggle_heartbeats(self):
        if self.heartbeats_on:
            self.heartbeats_on = False
            self.hb_timer.stop()
            self.append("Heartbeats stopped — board OPENS the valve within 5 s.")
            self.commanded = None
        else:
            self.heartbeats_on = True
            self.send_server_heartbeat()
            self.hb_timer.start(SERVER_HEARTBEAT_INTERVAL_MS)
            self.append(
                f"Sending SERVER_HEARTBEAT to {self.ip_edit.text().strip()} "
                f"every {SERVER_HEARTBEAT_INTERVAL_MS} ms."
            )
        self.set_command_label()
        self.update_controls()

    def send_server_heartbeat(self):
        self.send(build_server_heartbeat())

    # ------------------------------------------------------------- commands
    def command(self, state: int):
        # OPEN (the safe state) always goes out; CLOSE is ignored without
        # heartbeats.
        if not state and not self.heartbeats_on:
            return
        # A heartbeat first, so the board is ACTIVE even if CLOSE is pressed
        # the instant heartbeats start.
        if self.heartbeats_on:
            self.send_server_heartbeat()
        if self.send(build_actuator_command(VALVE_ACTUATOR_ID, state)):
            self.commanded = "OPEN" if state else "CLOSED"
            self.append(
                f"> ACTUATOR_COMMAND id={VALVE_ACTUATOR_ID} state={state} "
                f"to {self.ip_edit.text().strip()}:{COMMAND_PORT}"
            )
            if not state and not self.board_active():
                self.append(
                    "  warning: board is not reporting ACTIVE, so it may not "
                    "be hearing our heartbeats and will ignore CLOSE."
                )
        self.set_command_label()

    # ------------------------------------------------------------------ UI
    def board_active(self) -> bool:
        return (
            self.board_last_seen > 0
            and time.time() - self.board_last_seen < BOARD_SILENT_SEC
            and self.board_state == 2
        )

    def refresh_status(self):
        if self.board_last_seen == 0.0:
            text, color = "Board: not heard yet", "#757575"
        else:
            age = time.time() - self.board_last_seen
            state = BOARD_STATES.get(self.board_state, f"state {self.board_state}")
            if age >= BOARD_SILENT_SEC:
                text, color = f"Board: SILENT for {age:.0f} s", "#b71c1c"
            elif self.board_state == 2:
                text, color = f"Board: {state} (hearing our heartbeats)", "#1b5e20"
            else:
                text, color = f"Board: {state} (not hearing heartbeats)", "#8a6d00"
        self.board_label.setText(text)
        self.board_label.setStyleSheet(f"color: {color}; font-weight: bold;")

        if (
            self.position_volts is None
            or time.time() - self.position_last_seen >= BOARD_SILENT_SEC
        ):
            self.position_label.setText("Position: no data")
            self.position_bar.setValue(0)
            return
        ma = self.position_volts / POSITION_SHUNT_OHMS * 1000.0
        pct = (ma - 4.0) / 16.0 * 100.0
        text = f"Position: {ma:.2f} mA ({self.position_volts:.3f} V) — {pct:.0f}% open"
        if ma < 3.5:
            text += "  [below 4 mA: open loop / no signal?]"
        self.position_label.setText(text)
        self.position_bar.setValue(int(max(0.0, min(100.0, pct))))

    def set_command_label(self):
        if not self.heartbeats_on:
            label, fg, bg = "HEARTBEATS STOPPED", "#757575", "#fafafa"
        elif self.commanded == "OPEN":
            label, fg, bg = "COMMANDED OPEN", "#1b5e20", "#c8e6c9"
        elif self.commanded == "CLOSED":
            label, fg, bg = "COMMANDED CLOSED", "#424242", "#eeeeee"
        else:
            label, fg, bg = "READY", "#424242", "#eeeeee"
        self.state_label.setText(label)
        self.state_label.setStyleSheet(
            f"color: {fg}; background: {bg}; border: 1px solid {fg}; "
            "border-radius: 6px;"
        )

    def update_controls(self):
        self.hb_btn.setText(
            "Stop heartbeats" if self.heartbeats_on else "Start heartbeats"
        )
        self.open_btn.setEnabled(True)
        self.close_btn.setEnabled(self.heartbeats_on)

    def append(self, text: str):
        self.log.appendPlainText(f"{time.strftime('%H:%M:%S')}  {text}")

    def closeEvent(self, event):
        if self.sock:
            self.sock.close()
        super().closeEvent(event)


def main():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument(
        "--ip", default=DEFAULT_BOARD_IP, help="board IP (default: %(default)s)"
    )
    args = parser.parse_args()

    app = QtWidgets.QApplication(sys.argv)
    gui = BallValveGui(args.ip)
    gui.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
