"""
launch() — turn a BoardProfile into a running GUI.

Keeps each board app (e.g. LC-GUI/lc_gui.py) down to a profile + one call.
Handles: argument parsing (override IP / ports / bind), logging setup, the
QApplication, and a friendly message if the Qt/plotting deps are missing.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

from .logsetup import configure_logging
from .profile import BoardProfile


def _parse_args(profile: BoardProfile, argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=f"STAR {profile.board_type} board test GUI")
    p.add_argument("--board-ip", default=profile.board_ip,
                   help=f"board IP to send control packets to (default {profile.board_ip})")
    p.add_argument("--board-id", type=int, default=profile.board_id,
                   help=f"board id label (default {profile.board_id})")
    p.add_argument("--listen-port", type=int, default=profile.listen_port,
                   help=f"UDP port to receive on (default {profile.listen_port})")
    p.add_argument("--control-port", type=int, default=profile.control_port,
                   help=f"UDP port the board listens on (default {profile.control_port})")
    p.add_argument("--bind-ip", default="0.0.0.0",
                   help="local interface to bind the receiver to (default 0.0.0.0)")
    return p.parse_args(argv)


def launch(profile: BoardProfile, argv=None) -> int:
    """Configure logging, apply CLI overrides, and run the GUI event loop."""
    args = _parse_args(profile, argv)
    profile.board_ip = args.board_ip
    profile.board_id = args.board_id
    profile.listen_port = args.listen_port
    profile.control_port = args.control_port

    logger, log_path = configure_logging(profile.board_type)

    try:
        from .qt import QtWidgets, run_app
        from .gui import BoardMonitorWindow
    except ImportError as exc:
        sys.stderr.write(
            f"\n[!] Missing GUI dependencies: {exc}\n\n"
            "    Install them (a virtualenv on Python 3.11 is recommended):\n"
            "        python3.11 -m venv .venv && source .venv/bin/activate\n"
            "        pip install -r requirements.txt\n\n"
        )
        return 2

    app = QtWidgets.QApplication(sys.argv[:1])
    app.setApplicationName(f"STAR {profile.board_type} Test GUI")
    window = BoardMonitorWindow(profile, logger, log_path, bind_ip=args.bind_ip)
    window.show()
    rc = run_app(app)

    # The event loop has fully returned here (window closed, threads joined).
    # pyqtgraph + Qt can segfault while Python garbage-collects their C++
    # objects during normal interpreter teardown, which would turn a clean quit
    # into a non-zero exit. Flush our own state and hand off to os._exit so that
    # teardown never runs. Nothing important is pending at this point.
    logging.shutdown()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(rc)
