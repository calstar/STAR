"""Version storage for designs: microversions + immutable releases.

Payload-agnostic: it stores and returns whatever JSON dict it is given, which is
why one module serves an engine design (``{"config": ...}``), a recovery config
and a P&ID (``{"nodes": ..., "edges": ...}``) alike. The *working copy*
(``current.json`` on the volume) is owned by the router
(:mod:`stardesign.documents`); here we only keep version history.

Two backends, chosen by :func:`make_backend` from the environment:

* **S3Backend** when the app's bucket variable is set. Microversions ride on S3
  object *versioning* of a per-document HEAD key
  (``<prefix>/<user>/<id>/current.json``): every snapshot is a plain
  ``put_object`` that S3 keeps as a new version, and a lifecycle rule prunes old
  ones. Releases are separate immutable keys under ``.../releases/<label>.json``.
  Credentials come from the standard ``AWS_*`` env vars.

  This is also why designs are *not* stored in a flat, ownerless tree: the
  microversion history of a design IS the S3 version history of one key, so
  re-keying a design to a new owner-less path would flatten it.

* **LocalBackend** otherwise (dev, and prod with no bucket set). Microversions
  and releases are files on disk under the ``USERDATA_DIR`` tree, so history
  works with no AWS.
"""

from __future__ import annotations

import json
import os
import secrets
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from stardesign.userdata import UserData, slugify

Snapshot = dict[str, Any]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Local (dev) backend ──────────────────────────────────────────────────────

def _atomic_write(path: Path, data: Snapshot) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _read_json(path: Path) -> Snapshot | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None


class LocalBackend:
    """Filesystem version history under ``<root>/<user>/<app>/<id>/``."""

    def __init__(self, ud: UserData) -> None:
        self._ud = ud

    def _doc_dir(self, user: str, doc_id: str) -> Path:
        return self._ud.user_dir(user) / doc_id

    def _sub(self, user: str, doc_id: str, name: str) -> Path:
        d = self._doc_dir(user, doc_id) / name
        d.mkdir(parents=True, exist_ok=True)
        return d

    def snapshot_micro(self, user: str, doc_id: str, data: Snapshot) -> dict:
        # Opaque, lowercase-hex id so it survives userdata.slugify on read-back.
        vid = secrets.token_hex(8)
        _atomic_write(self._sub(user, doc_id, "versions") / f"{vid}.json", data)
        return {"versionId": vid, "savedAt": _now_iso()}

    def list_micro(self, user: str, doc_id: str, limit: int = 50) -> list[dict]:
        """Snapshots newest first.

        Sorted on ``st_mtime_ns`` with the id as a tie-break, not on the
        formatted ``savedAt``: two snapshots written in the same filesystem
        timestamp tick otherwise come back in whatever order ``glob`` happened
        to yield, so "restore the previous version" could restore the wrong one.
        Rare in production (snapshots are minutes apart) but not never, and it
        is a total order for free.
        """
        rows: list[tuple[int, str, dict]] = []
        for p in self._sub(user, doc_id, "versions").glob("*.json"):
            if p.name.startswith("."):
                continue
            st = p.stat()
            rows.append((st.st_mtime_ns, p.stem, {
                "versionId": p.stem,
                "savedAt": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
                "size": st.st_size,
            }))
        rows.sort(key=lambda r: (r[0], r[1]), reverse=True)
        return [r[2] for r in rows[:limit]]

    def get_micro(self, user: str, doc_id: str, version_id: str) -> Snapshot | None:
        safe = slugify(version_id)
        if not safe:
            return None
        return _read_json(self._sub(user, doc_id, "versions") / f"{safe}.json")

    def latest_micro(self, user: str, doc_id: str) -> Snapshot | None:
        recent = self.list_micro(user, doc_id, limit=1)
        return self.get_micro(user, doc_id, recent[0]["versionId"]) if recent else None

    def create_release(self, user: str, doc_id: str, label: str, data: Snapshot) -> dict:
        p = self._sub(user, doc_id, "releases") / f"{label}.json"
        if p.exists():
            raise FileExistsError(label)
        _atomic_write(p, data)
        return {"label": label, "savedAt": _now_iso()}

    def list_releases(self, user: str, doc_id: str) -> list[dict]:
        out: list[dict] = []
        for p in self._sub(user, doc_id, "releases").glob("*.json"):
            if p.name.startswith("."):
                continue
            st = p.stat()
            out.append({
                "label": p.stem,
                "savedAt": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
                "size": st.st_size,
            })
        out.sort(key=lambda r: r["savedAt"], reverse=True)
        return out

    def get_release(self, user: str, doc_id: str, label: str) -> Snapshot | None:
        safe = slugify(label)
        if not safe:
            return None
        return _read_json(self._sub(user, doc_id, "releases") / f"{safe}.json")


# ── S3 backend ───────────────────────────────────────────────────────────────

class S3Backend:
    """Version history in a versioned S3 bucket. Microversions == object versions."""

    def __init__(self, ud: UserData, bucket: str, prefix: str) -> None:
        self._ud = ud
        import boto3  # imported lazily so dev never needs the dependency

        self._s3 = boto3.client("s3")
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    def _head_key(self, user: str, doc_id: str) -> str:
        return f"{self.prefix}/{user}/{doc_id}/current.json"

    def _releases_prefix(self, user: str, doc_id: str) -> str:
        return f"{self.prefix}/{user}/{doc_id}/releases/"

    def _put(self, key: str, data: Snapshot) -> None:
        self._s3.put_object(
            Bucket=self.bucket, Key=key,
            Body=json.dumps(data, indent=2).encode("utf-8"),
            ContentType="application/json",
        )

    def _get(self, key: str, **kw) -> Snapshot | None:
        from botocore.exceptions import ClientError
        try:
            obj = self._s3.get_object(Bucket=self.bucket, Key=key, **kw)
        except ClientError:
            return None
        return json.loads(obj["Body"].read())

    def snapshot_micro(self, user: str, doc_id: str, data: Snapshot) -> dict:
        self._put(self._head_key(user, doc_id), data)
        return {"savedAt": _now_iso()}

    def list_micro(self, user: str, doc_id: str, limit: int = 50) -> list[dict]:
        key = self._head_key(user, doc_id)
        resp = self._s3.list_object_versions(Bucket=self.bucket, Prefix=key, MaxKeys=limit)
        out = [
            {"versionId": v["VersionId"],
             "savedAt": v["LastModified"].isoformat(),
             "size": v["Size"]}
            for v in resp.get("Versions", []) if v["Key"] == key
        ]
        out.sort(key=lambda v: v["savedAt"], reverse=True)
        return out[:limit]

    def get_micro(self, user: str, doc_id: str, version_id: str) -> Snapshot | None:
        return self._get(self._head_key(user, doc_id), VersionId=version_id)

    def latest_micro(self, user: str, doc_id: str) -> Snapshot | None:
        return self._get(self._head_key(user, doc_id))

    def create_release(self, user: str, doc_id: str, label: str, data: Snapshot) -> dict:
        from botocore.exceptions import ClientError
        key = f"{self._releases_prefix(user, doc_id)}{label}.json"
        try:
            self._s3.head_object(Bucket=self.bucket, Key=key)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") not in ("404", "NoSuchKey", "NotFound"):
                raise
        else:
            raise FileExistsError(label)  # already exists -> immutable
        self._put(key, data)
        return {"label": label, "savedAt": _now_iso()}

    def list_releases(self, user: str, doc_id: str) -> list[dict]:
        prefix = self._releases_prefix(user, doc_id)
        resp = self._s3.list_objects_v2(Bucket=self.bucket, Prefix=prefix)
        out = []
        for o in resp.get("Contents", []):
            name = o["Key"][len(prefix):]
            if name.endswith(".json"):
                name = name[:-5]
            out.append({"label": name, "savedAt": o["LastModified"].isoformat(), "size": o["Size"]})
        out.sort(key=lambda r: r["savedAt"], reverse=True)
        return out

    def get_release(self, user: str, doc_id: str, label: str) -> Snapshot | None:
        return self._get(f"{self._releases_prefix(user, doc_id)}{label}.json")


# ── selection ────────────────────────────────────────────────────────────────

def make_backend(ud: UserData, bucket_env: str, prefix_env: str, default_prefix: str):
    """The version-history backend for one app, chosen from the environment.

    Called once per app at import time, so a missing bucket means "local files"
    for the life of the process rather than a per-request branch.
    """
    bucket = os.environ.get(bucket_env)
    if bucket:
        return S3Backend(ud, bucket, os.environ.get(prefix_env, default_prefix))
    return LocalBackend(ud)
