"""
Logging setup shared by every board GUI.

Produces a logger that writes to:
  * a rotating file under ``Test-GUI/logs/<board>_gui.log`` (5 x 2 MB), and
  * stderr,
and can additionally feed an in-GUI console (see gui.QtLogHandler).

Stdlib only — safe to import without a display.
"""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional, Tuple

LOG_FORMAT = "%(asctime)s.%(msecs)03d  %(levelname)-7s  %(message)s"
DATE_FORMAT = "%H:%M:%S"


def configure_logging(board_type: str,
                      log_dir: Optional[Path] = None,
                      level: int = logging.INFO) -> Tuple[logging.Logger, Path]:
    """Create/return the ``boardgui.<board_type>`` logger and its log-file path."""
    if log_dir is None:
        # Test-GUI/logs  (one level above the boardgui package)
        log_dir = Path(__file__).resolve().parent.parent / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{board_type.lower()}_gui.log"

    logger = logging.getLogger(f"boardgui.{board_type.lower()}")
    logger.setLevel(level)
    logger.propagate = False

    # Reconfiguring (e.g. relaunch in same process) shouldn't stack handlers.
    if logger.handlers:
        return logger, log_path

    fmt = logging.Formatter(LOG_FORMAT, DATE_FORMAT)

    file_handler = RotatingFileHandler(log_path, maxBytes=2 * 1024 * 1024,
                                       backupCount=5, encoding="utf-8")
    file_handler.setFormatter(fmt)
    logger.addHandler(file_handler)

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(fmt)
    logger.addHandler(stream_handler)

    return logger, log_path
