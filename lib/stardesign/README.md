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
| `documents` | The design CRUD, sharing and checkout router, as a factory. This is where `_resolve_doc` lives — the single place cross-user access is granted — and the checkout compare-and-set. |

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

## Checkouts

Concurrent editing is not resolved, it is **prevented**: at most one person
holds a design's write token, and only the holder may save.

- Opening a design never takes it — viewing must not block a colleague.
- `POST /{id}/checkout` takes it, `DELETE` gives it back, `GET` reports it.
  `POST /{id}/checkout/release` exists only because `sendBeacon` cannot issue a
  DELETE on tab close.
- **423**, not 409 — `create_release` already uses 409 for "that label exists".
- Content writes (`autosave`, `flush`, `release`) require it. Rename, share,
  leave and copy deliberately do not: they are not concurrent editing, and
  blocking them would let a stale checkout freeze a design nobody can tidy.
- A successful save refreshes the heartbeat, so "inactivity" means *not
  editing*. After `lock_ttl` (default 15 min) the checkout lapses; expiry is
  evaluated lazily, at take time, so there is no reaper and no window where the
  record and the answer disagree.
- The client gives it back on `pagehide` — a real tab close or navigation — and
  deliberately **not** on `visibilitychange`. That fires when the tab merely
  stops being visible (another tab, a minimised window, a closed laptop lid),
  and releasing on it meant a glance elsewhere cost you the checkout.

The compare-and-set runs inside `_index_lock` — the same `flock` that already
serialises index writes — so two simultaneous takes cannot both win.

> **`flock` is per-machine.** All three design tools run on the one apps machine
> sharing the `userdata` volume, so this holds today. Running a design tool on a
> second machine against the same volume would break the guarantee *silently*.

### Testing it

The obvious race test — N processes taking at once, assert one wins — **passes
with the locking deleted**. The critical section is sub-millisecond, so
contenders mostly serialise on their own; neither a barrier nor 48 contenders
fixed it. `test_take_cannot_proceed_while_the_index_lock_is_held` is the real
guard: it holds the same `flock` and asserts a take *blocks*. That fails every
run, in every app, the moment the lock goes.
