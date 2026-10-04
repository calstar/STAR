"""
Qt wrapper around ``dhcp`` — runs the address server off the UI thread.

The protocol and the reservation policy live in ``dhcp`` (pure stdlib,
self-tested); this is just the thread and the signals, the same split as
``discovery`` / ``network`` and ``ota`` / ``ota_task``.
"""

from __future__ import annotations

from typing import Optional

from .dhcp import DhcpServer, Reservations, ServerConfig
from .qt import QThread, pyqtSignal


class DhcpWorker(QThread):
    """Serves addresses from the reservation table until stopped."""

    # human-readable log line
    event = pyqtSignal(str)
    # mac, ip — a board just took the address we assigned it
    leased = pyqtSignal(str, str)
    # mac — a board asked and we had no reservation for it
    unknown_board = pyqtSignal(str)
    # message — could not start (almost always: needs sudo for port 67)
    failed = pyqtSignal(str)
    started_ok = pyqtSignal()

    def __init__(self, reservations: Reservations,
                 config: Optional[ServerConfig] = None) -> None:
        super().__init__()
        self.reservations = reservations
        self.config = config or ServerConfig()
        self.server: Optional[DhcpServer] = None

    def run(self) -> None:
        self.server = DhcpServer(
            self.reservations, self.config,
            on_event=self.event.emit,
            on_lease=lambda mac, ip: self.leased.emit(mac, ip),
            on_unknown=self.unknown_board.emit,
        )
        try:
            self.server.bind()
        except (PermissionError, OSError) as exc:
            self.failed.emit(str(exc))
            self.server = None
            return
        self.started_ok.emit()
        self.server.serve_forever()

    def stop(self) -> None:
        if self.server is not None:
            self.server.stop()
