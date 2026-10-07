"""Per-user data for feed-twin: stands (and the runs made on them).

A thin binding of :mod:`stardesign.userdata` to this app's ``<app>`` segment,
the same as pid-designer's and EngineDesign's: identity from ``X-Auth-Email``,
``"local"`` without it, everything under ``USERDATA_DIR/<user>/stand``.

The segment is ``stand``, not ``library``: the shared volume also holds
``feed-twin/library`` (the global artifact store, ``FEEDTWIN_LIBRARY``), and
``stardesign`` reads any ``<root>/<x>/<app>`` folder as a user called ``x``.
"""

from __future__ import annotations

from pathlib import Path

from stardesign.userdata import UserData

#: The ``<app>`` path segment for this backend. Distinct per app.
APP = "stand"

# backend/userdata.py -> backend -> feed-twin. Used only when USERDATA_DIR is
# unset (dev): a gitignored dir next to the app, created on demand.
_DEFAULT_ROOT = Path(__file__).resolve().parents[1] / ".userdata"

store = UserData(APP, default_root=_DEFAULT_ROOT)
