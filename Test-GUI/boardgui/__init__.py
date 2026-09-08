"""
boardgui — a small, standardized framework for building a per-board test GUI
for the STAR Diablo avionics boards (LC, PT, TC, RTD).

A board GUI is just a :class:`~boardgui.profile.BoardProfile` handed to
:func:`~boardgui.launch.launch`. See ``LC-GUI/lc_gui.py`` for the reference
example, and ``Test-GUI/README.md`` for how to add a new board.

The protocol layer (``boardgui.protocol``) is pure stdlib and can be imported /
unit-tested without a display or Qt.
"""

from .profile import BoardProfile

__all__ = ["BoardProfile"]
__version__ = "0.1.0"
