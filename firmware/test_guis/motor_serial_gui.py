"""
Motor Testing serial GUI — switch the Motor_Testing board on/off over USB.

Talks to firmware/Motor_Testing's serial commands (on, off, status) at 115200
baud, so the motor can be bench-tested with no Ethernet.

Opening the port resets an ESP32 dev board (the USB bridge's DTR/RTS lines
drive EN/IO0), and a reset clears a serial ON. So the GUI holds the port open
while connected, waits for the firmware's "Serial commands:" banner before
enabling the buttons, and treats Disconnect as "motor will turn off".

    python motor_serial_gui.py [--port /dev/cu.usbserial-0001]
"""

import argparse
import re
import sys
import time

import serial
import serial.tools.list_ports
from PyQt6 import QtCore, QtGui, QtWidgets

BAUD = 115200
READY_BANNER = "Serial commands:"
POLL_MS = 50
STATUS_POLL_MS = 2000

# "[MOTOR] ON (serial command)", "[MOTOR] OFF, server heartbeat ...",
# "[MOTOR] already OFF" -- but not "[MOTOR] ON ignored -- ...".
MOTOR_STATE_RE = re.compile(r"\[MOTOR\] (?:already )?(ON|OFF)\b(?! ignored)")


class MotorSerialGui(QtWidgets.QWidget):
    def __init__(self, port: str | None):
        super().__init__()
        self.setWindowTitle("Motor Testing — serial")
        self.ser: serial.Serial | None = None
        self.rx_buf = ""
        self.ready = False

        # --- connection row ---
        self.port_combo = QtWidgets.QComboBox()
        self.port_combo.setMinimumWidth(240)
        refresh_btn = QtWidgets.QPushButton("Refresh")
        refresh_btn.clicked.connect(self.refresh_ports)
        self.connect_btn = QtWidgets.QPushButton("Connect")
        self.connect_btn.clicked.connect(self.toggle_connection)

        conn_row = QtWidgets.QHBoxLayout()
        conn_row.addWidget(QtWidgets.QLabel("Port:"))
        conn_row.addWidget(self.port_combo, 1)
        conn_row.addWidget(refresh_btn)
        conn_row.addWidget(self.connect_btn)

        # --- state + controls ---
        self.state_label = QtWidgets.QLabel()
        self.state_label.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
        self.state_label.setMinimumHeight(64)
        font = self.state_label.font()
        font.setPointSize(22)
        font.setBold(True)
        self.state_label.setFont(font)

        self.on_btn = QtWidgets.QPushButton("ON")
        self.off_btn = QtWidgets.QPushButton("OFF")
        self.status_btn = QtWidgets.QPushButton("Status")
        for btn in (self.on_btn, self.off_btn):
            btn.setMinimumHeight(48)
        self.on_btn.clicked.connect(lambda: self.send("on"))
        self.off_btn.clicked.connect(lambda: self.send("off"))
        self.status_btn.clicked.connect(lambda: self.send("status"))

        btn_row = QtWidgets.QHBoxLayout()
        btn_row.addWidget(self.on_btn)
        btn_row.addWidget(self.off_btn)
        btn_row.addWidget(self.status_btn)

        self.auto_status = QtWidgets.QCheckBox(
            f"Poll status every {STATUS_POLL_MS // 1000} s"
        )

        # --- log ---
        self.log = QtWidgets.QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumBlockCount(2000)
        self.log.setFont(
            QtGui.QFontDatabase.systemFont(QtGui.QFontDatabase.SystemFont.FixedFont)
        )

        layout = QtWidgets.QVBoxLayout(self)
        layout.addLayout(conn_row)
        layout.addWidget(self.state_label)
        layout.addLayout(btn_row)
        layout.addWidget(self.auto_status)
        layout.addWidget(self.log, 1)
        self.resize(560, 520)

        self.read_timer = QtCore.QTimer(self)
        self.read_timer.timeout.connect(self.poll_serial)
        self.status_timer = QtCore.QTimer(self)
        self.status_timer.timeout.connect(self.poll_status)
        self.status_timer.start(STATUS_POLL_MS)

        self.refresh_ports(prefer=port)
        self.set_state("DISCONNECTED")
        self.update_controls()

    # ---------------------------------------------------------------- ports
    def refresh_ports(self, prefer: str | None = None):
        current = prefer or self.port_combo.currentData()
        self.port_combo.clear()
        for p in sorted(serial.tools.list_ports.comports(), key=lambda p: p.device):
            # USB bridges first; skip Bluetooth/debug pseudo-ports on macOS.
            if "usb" not in p.device.lower() and p.device != current:
                continue
            self.port_combo.addItem(f"{p.device} — {p.description}", p.device)
        if current:
            idx = self.port_combo.findData(current)
            if idx < 0:
                self.port_combo.addItem(current, current)
                idx = self.port_combo.count() - 1
            self.port_combo.setCurrentIndex(idx)

    # ----------------------------------------------------------- connection
    def toggle_connection(self):
        if self.ser:
            self.disconnect_port("disconnected by user")
        else:
            self.connect_port()

    def connect_port(self):
        port = self.port_combo.currentData()
        if not port:
            self.append("No port selected.")
            return
        ser = serial.Serial()
        ser.port = port
        ser.baudrate = BAUD
        ser.timeout = 0
        # Leave EN and IO0 released; opening the port still resets the board.
        ser.dtr = False
        ser.rts = False
        try:
            ser.open()
        except serial.SerialException as e:
            self.append(f"Could not open {port}: {e}")
            return
        self.ser = ser
        self.rx_buf = ""
        self.ready = False
        self.append(
            f"Connected to {port}. Board is rebooting — waiting for firmware..."
        )
        self.set_state("BOOTING")
        self.read_timer.start(POLL_MS)
        self.update_controls()

    def disconnect_port(self, reason: str):
        self.read_timer.stop()
        if self.ser:
            try:
                self.ser.close()
            except Exception:
                pass
        self.ser = None
        self.ready = False
        self.append(
            f"Port closed ({reason}). Closing the port resets the board: motor OFF."
        )
        self.set_state("DISCONNECTED")
        self.update_controls()

    # ----------------------------------------------------------------- I/O
    def send(self, cmd: str):
        if not (self.ser and self.ready):
            return
        try:
            self.ser.write((cmd + "\n").encode())
        except serial.SerialException as e:
            self.disconnect_port(f"write failed: {e}")
            return
        if cmd != "status" or not self.auto_status.isChecked():
            self.append(f"> {cmd}")

    def poll_status(self):
        if self.auto_status.isChecked():
            self.send("status")

    def poll_serial(self):
        if not self.ser:
            return
        try:
            data = self.ser.read(4096)
        except serial.SerialException as e:
            # USB unplugged, or the host cut power to the port.
            self.disconnect_port(f"device lost: {e}")
            return
        if not data:
            return
        self.rx_buf += data.decode(errors="replace")
        while "\n" in self.rx_buf:
            line, self.rx_buf = self.rx_buf.split("\n", 1)
            self.handle_line(line.rstrip("\r"))

    def handle_line(self, line: str):
        if not line:
            return
        self.append(line)
        if READY_BANNER in line:
            self.ready = True
            self.set_state("OFF")
            self.update_controls()
        elif "Motor Testing starting" in line and self.ready:
            # Board rebooted under us (reset button, brown-out).
            self.ready = False
            self.append("Board rebooted — motor is OFF, waiting for firmware...")
            self.set_state("BOOTING")
            self.update_controls()
        m = MOTOR_STATE_RE.search(line)
        if m and self.ready:
            self.set_state(m.group(1))

    # ------------------------------------------------------------------ UI
    def append(self, text: str):
        self.log.appendPlainText(f"{time.strftime('%H:%M:%S')}  {text}")

    def set_state(self, state: str):
        colors = {
            "ON": ("#1b5e20", "#c8e6c9"),
            "OFF": ("#424242", "#eeeeee"),
            "BOOTING": ("#8a6d00", "#fff3c4"),
            "DISCONNECTED": ("#757575", "#fafafa"),
        }
        fg, bg = colors.get(state, colors["DISCONNECTED"])
        label = {"ON": "MOTOR ON", "OFF": "MOTOR OFF"}.get(state, state)
        self.state_label.setText(label)
        self.state_label.setStyleSheet(
            f"color: {fg}; background: {bg}; border: 1px solid {fg}; "
            "border-radius: 6px;"
        )

    def update_controls(self):
        connected = self.ser is not None
        self.connect_btn.setText("Disconnect" if connected else "Connect")
        self.port_combo.setEnabled(not connected)
        for btn in (self.on_btn, self.off_btn, self.status_btn):
            btn.setEnabled(connected and self.ready)

    def closeEvent(self, event):
        if self.ser:
            self.disconnect_port("window closed")
        super().closeEvent(event)


def main():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("-p", "--port", help="serial port, e.g. /dev/cu.usbserial-0001")
    args = parser.parse_args()

    app = QtWidgets.QApplication(sys.argv)
    gui = MotorSerialGui(args.port)
    gui.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
