"""Per-user data storage for the merged-in recovery calculator.

A thin binding of :mod:`stardesign.userdata`, separate from
:mod:`backend.userdata` only in its ``<app>`` segment: the recovery tab's unit
preferences and its named-config library (``/api/settings``, ``/api/configs``)
predate the merge and still live under ``<user>/recovery/``, while the unified
design bar saves under ``<user>/openrocket/``.

See stardesign/userdata.py for the layout and the identity rules.
"""

from pathlib import Path

from stardesign.userdata import UserData, slug_user, slugify  # noqa: F401

#: The ``<app>`` path segment for the recovery calculator's own state.
APP = "recovery"

# backend/recovery/userdata.py -> backend -> <subproject>. Used only when
# USERDATA_DIR is unset (dev): a gitignored dir next to the app.
_DEFAULT_ROOT = Path(__file__).resolve().parents[2] / ".userdata"

store = UserData(APP, default_root=_DEFAULT_ROOT)

current_user = store.current_user
user_dir = store.user_dir
all_users = store.all_users
list_configs = store.list_configs
read_config = store.read_config
write_config = store.write_config
delete_config = store.delete_config
