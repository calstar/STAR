"""Per-user data storage for STAR OpenRocket.

A thin binding of :mod:`stardesign.userdata` to this app's ``<app>`` segment.
The names below are re-exported deliberately: every call site in this backend
says ``userdata.current_user(request)``, and keeping that shape is what let the
shared package land without touching any of them.

See stardesign/userdata.py for the layout, the identity rules, and why the path
sanitising matters now that ``?owner=`` can name another user's folder.
"""

from pathlib import Path

from stardesign.userdata import UserData, slug_user, slugify  # noqa: F401

#: The ``<app>`` path segment for this backend. Distinct per app, so the viewer's
#: designs and the other design tools' keep separate trees under one user.
APP = "openrocket"

# backend/userdata.py -> backend -> <subproject>. Used only when USERDATA_DIR is
# unset (dev): a gitignored dir next to the app, created on demand.
_DEFAULT_ROOT = Path(__file__).resolve().parents[1] / ".userdata"

store = UserData(APP, default_root=_DEFAULT_ROOT)

current_user = store.current_user
user_dir = store.user_dir
all_users = store.all_users
list_configs = store.list_configs
read_config = store.read_config
write_config = store.write_config
delete_config = store.delete_config
