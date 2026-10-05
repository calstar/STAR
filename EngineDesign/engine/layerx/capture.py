"""Capture what one thread prints, without touching any other thread's output.

``contextlib.redirect_stdout`` swaps ``sys.stdout`` for the whole process. In the API, burns run on
daemon threads two at a time: two overlapping flights restored each other's buffers, and the
server went on printing into a StringIO for ever while other requests' prints landed in a run's
notes. Here ``sys.stdout`` is replaced once by a router that sends a thread's writes to that
thread's buffer while it is capturing, and everything else to the real stream.
"""

from __future__ import annotations

import contextlib
import io
import sys
import threading
from typing import Iterator

_local = threading.local()
_install_lock = threading.Lock()


class _ThreadRouter(io.TextIOBase):
    def __init__(self, real: object) -> None:
        self.real = real

    def _target(self) -> object:
        return getattr(_local, "buffer", None) or self.real

    def write(self, s: str) -> int:  # type: ignore[override]
        return self._target().write(s)  # type: ignore[attr-defined]

    def flush(self) -> None:
        target = self._target()
        if hasattr(target, "flush"):
            target.flush()  # type: ignore[attr-defined]

    def isatty(self) -> bool:
        return bool(getattr(self.real, "isatty", lambda: False)())

    @property
    def encoding(self) -> str:  # type: ignore[override]
        return getattr(self.real, "encoding", "utf-8")


def _install() -> None:
    with _install_lock:
        if not isinstance(sys.stdout, _ThreadRouter):
            sys.stdout = _ThreadRouter(sys.stdout)


@contextlib.contextmanager
def thread_stdout() -> Iterator[io.StringIO]:
    """Everything this thread prints inside the block, and nothing any other thread prints."""
    _install()
    previous = getattr(_local, "buffer", None)
    buffer = io.StringIO()
    _local.buffer = buffer
    try:
        yield buffer
    finally:
        _local.buffer = previous
