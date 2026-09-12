"""
Tiny Qt-binding compatibility shim.

The team uses PyQt6 in some tools and PyQt5 in others (PyQt5 is preferred on
macOS where PyQt6 + pyqtgraph can be flaky). This module imports whichever is
installed — PyQt6 first, then PyQt5 — and re-exports ``QtCore/QtGui/QtWidgets``
plus the handful of enum values we use, flattened so the rest of the codebase
is binding-agnostic.

Import this BEFORE pyqtgraph so pyqtgraph binds to the same Qt.
"""

from __future__ import annotations

QT_BINDING = None

try:  # Prefer PyQt6 (matches the existing sense/actuator test GUIs).
    from PyQt6 import QtCore, QtGui, QtWidgets  # type: ignore
    QT_BINDING = "PyQt6"
except ImportError:
    try:
        from PyQt5 import QtCore, QtGui, QtWidgets  # type: ignore
        QT_BINDING = "PyQt5"
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise ImportError(
            "No Qt binding found. Install one of:\n"
            "    pip install PyQt6 pyqtgraph numpy\n"
            "  or (preferred on macOS):\n"
            "    pip install PyQt5 pyqtgraph numpy"
        ) from exc

pyqtSignal = QtCore.pyqtSignal
pyqtSlot = QtCore.pyqtSlot
QThread = QtCore.QThread
QTimer = QtCore.QTimer
Qt = QtCore.Qt


def _enum(root, *path):
    """Resolve an enum member across PyQt6 (scoped) and PyQt5 (flat).

    e.g. _enum(Qt, "AlignmentFlag", "AlignCenter") returns
    Qt.AlignmentFlag.AlignCenter on PyQt6 and Qt.AlignCenter on PyQt5.
    """
    # PyQt6: root.Scope.Member
    obj = root
    try:
        for part in path:
            obj = getattr(obj, part)
        return obj
    except AttributeError:
        pass
    # PyQt5: root.Member (skip the scope name)
    return getattr(root, path[-1])


# Alignment flags
ALIGN_CENTER = _enum(Qt, "AlignmentFlag", "AlignCenter")
ALIGN_LEFT = _enum(Qt, "AlignmentFlag", "AlignLeft")
ALIGN_RIGHT = _enum(Qt, "AlignmentFlag", "AlignRight")
ALIGN_VCENTER = _enum(Qt, "AlignmentFlag", "AlignVCenter")
ALIGN_HCENTER = _enum(Qt, "AlignmentFlag", "AlignHCenter")
ALIGN_TOP = _enum(Qt, "AlignmentFlag", "AlignTop")

# Fonts
FONT_BOLD = _enum(QtGui.QFont, "Weight", "Bold")

# Orientation (splitters)
ORIENT_HORIZONTAL = _enum(Qt, "Orientation", "Horizontal")

# Frame shapes
FRAME_NOFRAME = _enum(QtWidgets.QFrame, "Shape", "NoFrame")
FRAME_PANEL = _enum(QtWidgets.QFrame, "Shape", "StyledPanel")

# Text cursor (log console auto-scroll)
TEXTCURSOR_END = _enum(QtGui.QTextCursor, "MoveOperation", "End")


def run_app(app) -> int:
    """app.exec() on PyQt6, app.exec_() on PyQt5."""
    if hasattr(app, "exec"):
        return app.exec()
    return app.exec_()  # pragma: no cover
