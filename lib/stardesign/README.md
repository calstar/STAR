# stardesign

The server-side core shared by the STAR design tools — EngineDesign,
pid-designer and recovery-calculator.

Each app used to carry its own copy of `userdata.py`, `storage.py`,
`directory.py` and a ~600-line documents router. Several were byte-identical.
That was survivable while the code only decided *whose folder* your own data
lived in — a bug meant one app misbehaved. Design sharing changed the stakes:
the check that decides whether you may edit **someone else's** design lives in
here now, and three copies of a permission check is three chances to fix a bug
in only two places.

## What's in it

| Module | What it owns |
|---|---|
| `userdata` | The on-disk layout: `<root>/<user>/<app>/…`, identity from `X-Auth-Email`, and the path sanitising that keeps `?owner=` from escaping the root. |
| `storage` | Version history — microversions and immutable releases — on the local volume or in a versioned S3 bucket. |
| `directory` | The team roster the share picker offers: the auth service's login records unioned with whoever already has data on the volume. |
| `documents` | The design CRUD + sharing router, as a factory. This is where `_resolve_doc` lives — the single place cross-user access is granted. |

## Using it

Each app binds the shared code to its own vocabulary and keeps its existing
module paths, so nothing else in the app changes:

```python
# backend/userdata.py
from stardesign.userdata import UserData
_ud = UserData("engine")
current_user, user_dir, slugify = _ud.current_user, _ud.user_dir, _ud.slugify
```

```python
# backend/routers/documents.py
from stardesign.documents import DesignStore, make_router
store = DesignStore(app="engine", noun="design", ...)
router = make_router(store, prefix="/api/engine/documents")
```

The apps differ in only four things: the `<app>` path segment, the route prefix,
the payload shape (`{"config": …}` vs `{"nodes": …, "edges": …}`), and the noun
in user-facing strings. Everything else is here.

## Installing

Path-installed, not published — it is versioned with the repo:

```
-e ../lib/stardesign        # in each app's requirements.txt
```

Its consumers' images build from the **repo root** so this directory is inside
the build context; see each `Dockerfile.api` and the `.dockerignore`.
