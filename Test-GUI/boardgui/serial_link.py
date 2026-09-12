"""
Serial (USB) link to a board — a reader thread over pyserial.

Opens the chosen serial port, reads the board's debug lines, and emits them one
at a time. Port enumeration (for the top-left dropdown) and connection are both
here. pyserial is imported lazily so the rest of the GUI still loads if it isn't
installed yet (Connect then reports a friendly error).
"""

from __future__ import annotations

import time
from typing import List, Optional, Tuple

from .qt import QThread, pyqtSignal


PYSERIAL_MISSING = "pyserial not installed — run: pip install pyserial"


def pyserial_error() -> Optional[str]:
    """Return a message if pyserial can't be imported, else ``None``.

    Lets callers tell "pyserial is missing" apart from "nothing is plugged in";
    :func:`list_ports` returns an empty list for both.
    """
    try:
        from serial.tools import list_ports as lp  # noqa: F401
    except ImportError:
        return PYSERIAL_MISSING
    return None


def list_ports() -> List[Tuple[str, str]]:
    """Return [(device, description)], best-guess board ports first.

    Returns an empty list if pyserial isn't installed — see :func:`pyserial_error`.
    """
    try:
        from serial.tools import list_ports as lp
    except ImportError:
        return []

    def score(dev: str, desc: str, hwid: str) -> int:
        blob = " ".join((dev, desc, hwid)).lower()
        # Windows exposes paired Bluetooth devices as COM ports; they are never
        # the board and would otherwise sort first (COM8/COM9 before COM6).
        if "bthenum" in blob or "bluetooth" in blob:
            return 9
        # ESP32-S3 native USB-CDC: Espressif VID 303A. This IS our board.
        if "303a" in blob:
            return 0
        # Common USB-UART bridges: CP210x, FTDI, CH340/CH341, PL2303.
        for vid in ("10c4", "0403", "1a86", "067b"):
            if "vid:pid=" + vid in blob or "vid_" + vid in blob:
                return 1
        # macOS/Linux device-name hints (usbmodem = CDC, usbserial = bridge).
        for i, hint in enumerate(("usbmodem", "usbserial", "ttyacm", "ttyusb"), start=2):
            if hint in blob:
                return i
        return 8

    ports = []
    for p in lp.comports():
        desc = p.description or ""
        ports.append((score(p.device, desc, p.hwid or ""), p.device, desc))
    ports.sort(key=lambda t: t[0])
    return [(dev, desc) for _, dev, desc in ports]


class SerialLink(QThread):
    line_received = pyqtSignal(str)
    opened = pyqtSignal(str)          # port name
    closed = pyqtSignal()
    error = pyqtSignal(str)

    def __init__(self, port: str, baud: int = 115200):
        super().__init__()
        self.port = port
        self.baud = baud
        self._stop = False
        self._serial = None
        self.total_lines = 0
        self.total_bytes = 0
        self.last_line_time: Optional[float] = None
        self.opened_time: Optional[float] = None

    def run(self) -> None:
        try:
            import serial  # pyserial
        except ImportError:
            self.error.emit("pyserial not installed — run: pip install pyserial")
            return
        try:
            self._serial = serial.Serial(self.port, self.baud, timeout=0.2)
        except Exception as exc:  # serial.SerialException, OSError, ...
            self.error.emit(f"Could not open {self.port}: {exc}")
            return

        self.opened_time = time.time()
        self.opened.emit(self.port)
        buf = bytearray()
        while not self._stop:
            try:
                chunk = self._serial.read(256)
            except Exception as exc:
                self.error.emit(f"Serial read error: {exc}")
                break
            if not chunk:
                continue
            self.total_bytes += len(chunk)
            buf.extend(chunk)
            # split complete lines out of the buffer
            while b"\n" in buf:
                raw, _, rest = buf.partition(b"\n")
                buf = bytearray(rest)
                line = raw.decode("utf-8", errors="replace").rstrip("\r")
                self.total_lines += 1
                self.last_line_time = time.time()
                self.line_received.emit(line)

        try:
            if self._serial:
                self._serial.close()
        except Exception:
            pass
        self._serial = None
        self.closed.emit()

    def stop(self) -> None:
        self._stop = True

    def seconds_since_last_line(self) -> Optional[float]:
        if self.last_line_time is None:
            return None
        return time.time() - self.last_line_time
