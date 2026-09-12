"""The one thing a reader can fail with.

Its own module so that everything which reads part of a drawing can raise it
without importing the reader that assembles the whole one. :mod:`feedtwin.pid.document`
re-exports it, which is where it used to live and where callers still expect it.
"""

from __future__ import annotations


class DiagramError(ValueError):
    """The document could not be read as a drawing."""
