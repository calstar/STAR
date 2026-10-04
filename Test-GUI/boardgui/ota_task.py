"""
Qt wrapper around ``ota`` — runs a build+upload off the UI thread.

The protocol and the build live in ``ota`` (pure stdlib, self-tested); this is
just the thread and the signals, the same split as ``discovery`` / ``network``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from . import ota
from .qt import QThread, pyqtSignal


class OtaWorker(QThread):
    """Optionally build the firmware, then push it to the board."""

    # human-readable step, for the log and the status line
    status = pyqtSignal(str)
    # bytes_sent, bytes_total
    progress = pyqtSignal(int, int)
    # sha256 hex of the image we are sending, emitted once it is known
    image_ready = pyqtSignal(str, int)   # digest, size_bytes
    # ok, message  (message is the failure reason when not ok)
    finished_upload = pyqtSignal(bool, str)

    def __init__(self, ip: str, port: int,
                 bin_path: Optional[Path] = None,
                 project: Optional[Path] = None,
                 env: Optional[str] = None,
                 message: Optional[str] = None) -> None:
        super().__init__()
        self.ip = ip
        self.port = port
        self.bin_path = bin_path
        self.project = project
        self.env = env
        self.message = message
        self.digest: Optional[str] = None
        self._cancel = False

    def cancel(self) -> None:
        self._cancel = True

    def run(self) -> None:
        try:
            path = self.bin_path
            if self.project:
                self.status.emit("Building firmware…")
                path = ota.build(self.project, self.env, self.message,
                                 on_log=self.status.emit)
            if path is None:
                raise ota.OtaError("no firmware selected")

            path = Path(path)
            if not path.exists():
                raise ota.OtaError(f"{path} does not exist")
            data = path.read_bytes()

            # What the board will report, so the GUI can actually match it.
            # Falls back to the file digest only if the image carries no
            # appended hash (then verification simply never confirms).
            self.digest = (ota.board_reported_sha256(data)
                           or ota.firmware_sha256(data))
            self.image_ready.emit(self.digest, len(data))
            self.status.emit(
                f"Uploading {len(data)} bytes to {self.ip}:{self.port}…")

            ota.upload(data, self.ip, self.port,
                       on_progress=lambda s, t: self.progress.emit(s, t),
                       should_cancel=lambda: self._cancel)

            self.finished_upload.emit(
                True, "Board acknowledged the image and is rebooting.")
        except ota.OtaError as exc:
            self.finished_upload.emit(False, str(exc))
        except Exception as exc:  # pragma: no cover - unexpected, still report
            self.finished_upload.emit(False, f"unexpected error: {exc}")
