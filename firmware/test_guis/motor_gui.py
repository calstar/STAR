"""
Motor Testing GUI — switch the Motor_Testing board's motor on/off over Ethernet.

Sends DAQv2 packets to firmware/Motor_Testing on UDP 5005:
  - SERVER_HEARTBEAT every 500 ms while "Heartbeats" is running. The board
    ignores ON without a current heartbeat and turns the motor OFF 5 s after
    they stop, so stopping heartbeats (or closing this window) is a stop.
  - ACTUATOR_COMMAND (actuator_id 1, state 1/0) for ON/OFF.

Listens on UDP 5006 for the board's BOARD_HEARTBEAT, which says whether it is
alive and whether it is hearing our heartbeats (board state ACTIVE).

Your computer needs an address on the board's subnet, e.g. 192.168.2.20/24.

    python motor_gui.py [--ip 192.168.2.71]
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
ACTUATOR_COMMAND = 4

BOARD_HEARTBEAT_BODY_FORMAT = "<32sBBB"  # hash, board_id, engine, board state
BOARD_HEARTBEAT_BODY_SIZE = 35
BOARD_STATES = {1: "SETUP", 2: "ACTIVE"}

MOTOR_BOARD_ID = 71  # -DBOARD_ID in firmware/Motor_Testing/platformio.ini
MOTOR_ACTUATOR_ID = 1
DEFAULT_BOARD_IP = "192.168.2.71"  # the board's static fallback address
COMMAND_PORT = 5005  # board listens here
LISTEN_PORT = 5006  # board sends BOARD_HEARTBEAT here

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


class MotorGui(QtWidgets.QWidget):
    def __init__(self, board_ip: str):
        super().__init__()
        self.setWindowTitle("Motor Testing — Ethernet")
        self.sock: socket.socket | None = None
        self.heartbeats_on = False
        self.commanded: str | None = None
        self.board_last_seen = 0.0
        self.board_state = 0

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

        # --- board + motor state ---
        self.board_label = QtWidgets.QLabel()
        self.state_label = QtWidgets.QLabel()
        self.state_label.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
        self.state_label.setMinimumHeight(64)
        font = self.state_label.font()
        font.setPointSize(22)
        font.setBold(True)
        self.state_label.setFont(font)

        self.on_btn = QtWidgets.QPushButton("ON")
        self.off_btn = QtWidgets.QPushButton("OFF")
        for btn in (self.on_btn, self.off_btn):
            btn.setMinimumHeight(48)
        self.on_btn.clicked.connect(lambda: self.command(1))
        self.off_btn.clicked.connect(lambda: self.command(0))
        btn_row = QtWidgets.QHBoxLayout()
        btn_row.addWidget(self.on_btn)
        btn_row.addWidget(self.off_btn)

        note = QtWidgets.QLabel(
            "The board turns the motor OFF 5 s after heartbeats stop — "
            "Stop heartbeats or close this window to stop it."
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
        layout.addLayout(btn_row)
        layout.addWidget(note)
        layout.addWidget(self.log, 1)
        self.resize(600, 520)

        self.hb_timer = QtCore.QTimer(self)
        self.hb_timer.timeout.connect(self.send_server_heartbeat)
        self.rx_timer = QtCore.QTimer(self)
        self.rx_timer.timeout.connect(self.poll_socket)
        self.ui_timer = QtCore.QTimer(self)
        self.ui_timer.timeout.connect(self.refresh_board_label)
        self.ui_timer.start(250)

        self.open_socket()
        self.set_motor_label()
        self.refresh_board_label()
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
                "unavailable; commands still work."
            )
        sock.setblocking(False)
        self.sock = sock
        self.rx_timer.start(POLL_MS)
        self.append(f"Listening for board heartbeats on UDP {LISTEN_PORT}.")

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
            except BlockingIOError:
                return
            except OSError:
                return
            hb = parse_board_heartbeat(data)
            if hb is None:
                continue
            board_id, board_state, fw_hash = hb
            if board_id != MOTOR_BOARD_ID:
                continue
            first = self.board_last_seen == 0.0
            prev_state = self.board_state
            self.board_last_seen = time.time()
            self.board_state = board_state
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
            self.append("Heartbeats stopped — board turns the motor OFF within 5 s.")
            self.commanded = None
        else:
            self.heartbeats_on = True
            self.send_server_heartbeat()
            self.hb_timer.start(SERVER_HEARTBEAT_INTERVAL_MS)
            self.append(
                f"Sending SERVER_HEARTBEAT to {self.ip_edit.text().strip()} "
                f"every {SERVER_HEARTBEAT_INTERVAL_MS} ms."
            )
        self.set_motor_label()
        self.update_controls()

    def send_server_heartbeat(self):
        self.send(build_server_heartbeat())

    # ------------------------------------------------------------- commands
    def command(self, state: int):
        # OFF always goes out; ON is pointless without heartbeats (ignored).
        if state and not self.heartbeats_on:
            return
        # A heartbeat first, so the board's "heartbeat current" check passes
        # even if ON is pressed the instant heartbeats start.
        if self.heartbeats_on:
            self.send_server_heartbeat()
        if self.send(build_actuator_command(MOTOR_ACTUATOR_ID, state)):
            self.commanded = "ON" if state else "OFF"
            self.append(
                f"> ACTUATOR_COMMAND id={MOTOR_ACTUATOR_ID} state={state} "
                f"to {self.ip_edit.text().strip()}:{COMMAND_PORT}"
            )
            if state and not self.board_active():
                self.append(
                    "  warning: board is not reporting ACTIVE, so it may not "
                    "be hearing our heartbeats and will ignore ON."
                )
        self.set_motor_label()

    # ------------------------------------------------------------------ UI
    def board_active(self) -> bool:
        return (
            self.board_last_seen > 0
            and time.time() - self.board_last_seen < BOARD_SILENT_SEC
            and self.board_state == 2
        )

    def refresh_board_label(self):
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

    def set_motor_label(self):
        if not self.heartbeats_on:
            label, fg, bg = "HEARTBEATS STOPPED", "#757575", "#fafafa"
        elif self.commanded == "ON":
            label, fg, bg = "COMMANDED ON", "#1b5e20", "#c8e6c9"
        elif self.commanded == "OFF":
            label, fg, bg = "COMMANDED OFF", "#424242", "#eeeeee"
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
        self.on_btn.setEnabled(self.heartbeats_on)
        self.off_btn.setEnabled(True)

    def append(self, text: str):
        self.log.appendPlainText(f"{time.strftime('%H:%M:%S')}  {text}")

    def closeEvent(self, event):
        # Turn it off now rather than waiting out the 5 s heartbeat timeout.
        if self.sock:
            self.send(build_actuator_command(MOTOR_ACTUATOR_ID, 0))
            self.sock.close()
        super().closeEvent(event)


def main():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument(
        "--ip", default=DEFAULT_BOARD_IP, help="board IP (default: %(default)s)"
    )
    args = parser.parse_args()

    app = QtWidgets.QApplication(sys.argv)
    gui = MotorGui(args.ip)
    gui.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
